using System;
using static Lapis.Core.LapisMath;

namespace Lapis.Core;

/// <summary>
/// Engine-agnostic player logic: walking, jumping, wading, boarding and rowing.
/// A faithful port of src/game/player.ts: same constants, same order of operations, same maths,
/// so a fixed input sequence produces the same trace (see sbox/Lapis.Parity).
/// </summary>
public sealed class PlayerController
{
    public const double BodyRadius = 0.35;
    public const double WalkSpeed = 3.2;
    public const double SprintSpeed = 6.5;
    public const double WadeDepth = -0.85;
    public const double MaxClimb = 1.05; // rise per metre travelled
    public const double StepUp = 0.5; // a ledge you can step onto without jumping
    public const double JumpVelocity = 5.4;
    public const double Head = 1.75;
    public const double Gravity = 14;
    public const double BoatDraft = -0.4;
    public const double StrokePeriod = 1.7;
    public const double BoatMax = 9;

    private readonly IWorldQuery _world;
    private bool _interactLatch;
    private bool _jumpLatch;
    private double _holdE;
    private double _t;
    private Vec3 _safe;
    private double _safeTimer;
    private double _strokeUsed = -1;
    private Vec2? _boatCall;
    private bool _hasBoarded;

    public PlayerController(IWorldQuery world) => _world = world;

    public double X { get; private set; }
    public double Y { get; private set; }
    public double Z { get; private set; }
    public double Heading { get; private set; }
    public double Speed { get; private set; }
    public double VerticalVelocity { get; private set; }
    public bool Airborne { get; private set; }
    public PlayerMode Mode { get; private set; } = PlayerMode.Walk;
    public PlayerAnim Anim { get; private set; } = PlayerAnim.Idle;
    public double AnimRate { get; private set; } = 1;
    public string Prompt { get; private set; } = "";
    public BoatState Boat { get; } = new();
    public IColliders? Colliders { get; set; }
    public IPlatforms? Platforms { get; set; }

    /// <summary>Moth wings found: hold jump while falling to glide.</summary>
    public bool CanGlide { get; set; }

    /// <summary>How fast a glide sinks (m/s): moth wings spread wide sink slower.</summary>
    public double GlideSink { get; set; } = 1.6;

    /// <summary>&gt;0 while sinking after a missed jump; the view fades and you return to safe ground.</summary>
    public double Falling { get; private set; }

    public Vec3 Position => new(X, Y, Z);

    public event Action<PlayerEvent>? Event;

    private double Ground(double x, double z) => Ground(x, z, Y);

    private double Ground(double x, double z, double yRef) =>
        Math.Max(_world.Height(x, z), Platforms?.Top(x, z, yRef) ?? double.NegativeInfinity);

    private void PushOutOfWalls()
    {
        if (Platforms?.Push(X, Z, Y, BodyRadius) is { } p)
        {
            X = p.X;
            Z = p.Z;
        }
    }

    /// <summary>Push the walker out of walls, trunks and the boat hull, sliding along them rather than stopping.</summary>
    private void Resolve()
    {
        PushOutOfWalls();
        Colliders?.Near(X, Z, 3, (cx, cz, r) =>
        {
            var dx = X - cx;
            var dz = Z - cz;
            var min = r + BodyRadius;
            var d2 = dx * dx + dz * dz;
            if (d2 >= min * min || d2 < 1e-8) return;
            var d = Math.Sqrt(d2);
            X = cx + dx / d * min;
            Z = cz + dz / d * min;
        });
        // The hull is a capsule along the boat's heading.
        var b = Boat;
        var ax = Math.Sin(b.Heading);
        var az = Math.Cos(b.Heading);
        var t = Math.Max(-1.5, Math.Min(1.5, (X - b.X) * ax + (Z - b.Z) * az));
        var px = b.X + ax * t;
        var pz = b.Z + az * t;
        var hx = X - px;
        var hz = Z - pz;
        var hullMin = 0.62 + BodyRadius;
        var hd = Hypot(hx, hz);
        if (hd < hullMin && hd > 1e-4 && Y < 1.2)
        {
            X = px + hx / hd * hullMin;
            Z = pz + hz / hd * hullMin;
        }
    }

    /// <summary>y picks the level on stacked surfaces (a stair): the default is the highest.</summary>
    public void Place(double x, double z, double heading, double y = double.PositiveInfinity)
    {
        X = x;
        Z = z;
        Y = Math.Max(Ground(x, z, y), WadeDepth);
        Heading = heading;
        Airborne = false;
        VerticalVelocity = 0;
        _safe = new Vec3(x, Y, z);
    }

    public void PlaceBoat(double x, double z, double heading)
    {
        Boat.X = x;
        Boat.Z = z;
        Boat.Heading = heading;
        Boat.Speed = 0;
        Boat.Stroke = 0;
    }

    public void Update(double dt, in PlayerInput input)
    {
        _t += dt;
        var pressed = input.Interact && !_interactLatch;
        _interactLatch = input.Interact;
        var jumped = input.Jump && !_jumpLatch;
        _jumpLatch = input.Jump;
        _holdE = input.Interact ? _holdE + dt : 0;
        if (Mode == PlayerMode.Walk) Walk(dt, input, pressed, jumped);
        else Row(dt, input, pressed, jumped);
        Boat.Bob = Math.Sin(_t * 1.3) * 0.04 + Math.Sin(_t * 0.7 + 1) * 0.03;
        GlideCalledBoat(dt);
    }

    private void Walk(double dt, in PlayerInput input, bool pressed, bool jumped)
    {
        if (Falling > 0)
        {
            // Sinking: drift down, then wake back on the last solid ground.
            Falling -= dt;
            Y -= dt * 0.9;
            Speed = 0;
            if (Falling <= 0)
            {
                Place(_safe.X, _safe.Z, Heading, _safe.Y);
                Event?.Invoke(PlayerEvent.Respawn);
            }
            Prompt = "";
            return;
        }
        var len = Hypot(input.MoveX, input.MoveY);
        var target = len > 0.1 ? (input.Sprint ? SprintSpeed : WalkSpeed) * Math.Min(1, len) : 0;
        // You can steer a little in the air, but momentum mostly carries you.
        Speed += (target - Speed) * Math.Min(1, dt * (Airborne ? 1.5 : 8));
        if (len > 0.1)
        {
            var fx = -Math.Sin(input.CameraYaw);
            var fz = -Math.Cos(input.CameraYaw);
            var dx = fx * input.MoveY - fz * input.MoveX;
            var dz = fz * input.MoveY + fx * input.MoveX;
            var diff = WrapAngle(Math.Atan2(dx, dz) - Heading);
            Heading += diff * Math.Min(1, dt * (Airborne ? 3 : 10));
        }

        var step = Speed * dt;
        var mx = Math.Sin(Heading) * step;
        var mz = Math.Cos(Heading) * step;
        if (CanMoveTo(X + mx, Z + mz, step))
        {
            X += mx;
            Z += mz;
        }
        else if (CanMoveTo(X + mx, Z, Math.Abs(mx)))
        {
            X += mx;
        }
        else if (CanMoveTo(X, Z + mz, Math.Abs(mz)))
        {
            Z += mz;
        }
        else if (!Airborne)
        {
            Speed *= 0.5;
        }
        Resolve();

        var g = Ground(X, Z);
        if (!Airborne)
        {
            if (jumped)
            {
                Airborne = true;
                VerticalVelocity = JumpVelocity;
                // Jumping commits you: an instant push the way you're steering, so a standing hop
                // off a small stone still carries. Running jumps go further.
                if (len > 0.1)
                {
                    Speed = Math.Max(Speed, input.Sprint ? 5.0 : 3.6);
                    var fx = -Math.Sin(input.CameraYaw);
                    var fz = -Math.Cos(input.CameraYaw);
                    Heading = Math.Atan2(fx * input.MoveY - fz * input.MoveX, fz * input.MoveY + fx * input.MoveX);
                }
                Event?.Invoke(PlayerEvent.Jump);
            }
            else if (g < Y - 0.6)
            {
                Airborne = true; // stepped off an edge
                VerticalVelocity = 0;
            }
        }
        if (Airborne)
        {
            VerticalVelocity -= Gravity * dt;
            // Moth wings: holding jump on the way down turns the fall into a long glide.
            if (CanGlide && input.Jump && VerticalVelocity < -GlideSink)
            {
                VerticalVelocity = -GlideSink;
                Speed = Math.Max(Speed, 5.5);
            }
            var ceiling = VerticalVelocity > 0 ? Platforms?.Ceiling(X, Z, Y) ?? double.PositiveInfinity : double.PositiveInfinity;
            Y += VerticalVelocity * dt;
            if (Y + Head > ceiling)
            {
                Y = Math.Max(ceiling - Head, Y - VerticalVelocity * dt);
                VerticalVelocity = 0;
            }
            if (Y <= g && VerticalVelocity <= 0)
            {
                if (g < WadeDepth)
                {
                    Falling = 1.3;
                    Airborne = false;
                    Event?.Invoke(PlayerEvent.Fall);
                    return;
                }
                Y = g;
                Airborne = false;
                VerticalVelocity = 0;
                Event?.Invoke(PlayerEvent.Land);
            }
            PushOutOfWalls();
        }
        else
        {
            Y += (Math.Max(g, WadeDepth) - Y) * Math.Min(1, dt * 18);
            // Remember solid footing so a missed jump puts you back somewhere sensible.
            _safeTimer += dt;
            if (g > -0.3 && _safeTimer > 0.25)
            {
                _safe = new Vec3(X, Y, Z);
                _safeTimer = 0;
            }
        }
        Anim = Speed > 0.3 && !Airborne ? PlayerAnim.Walk : PlayerAnim.Idle;
        AnimRate = Math.Max(0.6, Speed / WalkSpeed);

        // Boarding, or calling the boat to you from the water's edge.
        var db = Hypot(Boat.X - X, Boat.Z - Z);
        var boatAfloat = _world.Height(Boat.X, Boat.Z) < BoatDraft * 0.5;
        Prompt = "";
        if (db < 3.6 && boatAfloat && !Airborne)
        {
            Prompt = "E   step into the boat";
            if (pressed)
            {
                Mode = PlayerMode.Boat;
                Speed = 0;
                _boatCall = null;
                _hasBoarded = true;
            }
        }
        else if (_hasBoarded && db > 40 && _boatCall == null && !Airborne)
        {
            var water = NearbyWater();
            if (water != null)
            {
                Prompt = _holdE > 0 ? "calling..." : "hold E   call the boat";
                if (_holdE > 0.9)
                {
                    _boatCall = water;
                    _holdE = -999;
                    Event?.Invoke(PlayerEvent.CallBoat);
                }
            }
        }
    }

    private bool CanMoveTo(double x, double z, double len)
    {
        // Never trap anyone: already overlapping something (a respawn, a jump's arc), you may move
        // anywhere that overlaps no deeper, which lets you slide out but never through a wall.
        if (Platforms != null && Platforms.Blocked(x, z, Y))
        {
            var clear = BodyRadius;
            while (clear > 0.04 && Platforms.Blocked(X, Z, Y, clear)) clear -= 0.05;
            if (clear >= BodyRadius || Platforms.Blocked(x, z, Y, clear)) return false;
        }
        var g = Ground(x, z);
        if (Airborne) return g <= Y + 0.15; // only a wall stops you mid-air
        if (g < WadeDepth) return false; // deep water: jump it or stay out
        return g - Y <= StepUp || (g - Y) / Math.Max(len, 1e-3) < MaxClimb;
    }

    private Vec2? NearbyWater()
    {
        for (var r = 2.5; r <= 10; r += 1.5)
        {
            for (var k = 0; k < 16; k++)
            {
                var a = k / 16.0 * Math.PI * 2;
                var x = X + Math.Sin(a) * r;
                var z = Z + Math.Cos(a) * r;
                if (_world.Height(x, z) < -0.9 && !(Platforms?.BlocksBoat(x, z, 1.5) ?? false)) return new Vec2(x, z);
            }
        }
        return null;
    }

    /// <summary>The called boat drifts to you across the water, ignoring the shallows like a dream would.</summary>
    private void GlideCalledBoat(double dt)
    {
        if (_boatCall is not { } c || Mode == PlayerMode.Boat) return;
        var b = Boat;
        var dx = c.X - b.X;
        var dz = c.Z - b.Z;
        var d = Hypot(dx, dz);
        if (d < 0.8)
        {
            _boatCall = null;
            return;
        }
        var v = Math.Min(d, 6 * dt + d * 0.6 * dt);
        b.X += dx / d * v;
        b.Z += dz / d * v;
        var diff = WrapAngle(Math.Atan2(dx, dz) - b.Heading);
        b.Heading += diff * Math.Min(1, dt * 1.5);
    }

    private void Row(double dt, in PlayerInput input, bool pressed, bool jumped)
    {
        var b = Boat;
        var pull = input.MoveY;
        b.Rowing = Math.Abs(pull) > 0.1 || Math.Abs(input.MoveX) > 0.1;
        if (b.Rowing) b.Stroke = (b.Stroke + dt / StrokePeriod) % 1;
        else b.Stroke += (0 - b.Stroke) * Math.Min(1, dt * 1.5);
        // Thrust arrives in pulses during the drive phase of each stroke, not as a constant push.
        var drive = Math.Max(0, Math.Sin(b.Stroke * Math.PI * 2 - 0.4));
        b.Speed += pull * drive * 3.2 * dt * (input.Sprint ? 1.5 : 1);

        // Long stroke: Space on the catch, once per stroke, for a surge.
        var cycle = Math.Floor(_t / StrokePeriod);
        if (jumped && b.Rowing && _strokeUsed != cycle)
        {
            _strokeUsed = cycle;
            var onCatch = b.Stroke > 0.86 || b.Stroke < 0.16;
            if (onCatch)
            {
                b.Speed += 2.6 * SignOrOne(pull);
                Event?.Invoke(PlayerEvent.PowerStroke);
            }
            else
            {
                b.Speed += 0.4 * SignOrOne(pull);
                Event?.Invoke(PlayerEvent.WeakStroke);
            }
        }
        b.Speed = Math.Max(-2.5, Math.Min(BoatMax, b.Speed * Math.Exp(-0.5 * dt)));
        var turn = -input.MoveX * (0.55 + Math.Min(1, Math.Abs(b.Speed) * 0.25)) * (b.Rowing ? 1 : 0.3);
        b.Heading += turn * dt;

        var f = _world.Flow(b.X, b.Z);
        var fm = Hypot(f.X, f.Z);
        b.Current += (Math.Min(1, fm / 6) - b.Current) * Math.Min(1, dt * 2);
        var nx = b.X + (Math.Sin(b.Heading) * b.Speed + f.X) * dt;
        var nz = b.Z + (Math.Cos(b.Heading) * b.Speed + f.Z) * dt;
        var dirSign = SignOrOne(b.Speed);
        var bowX = nx + Math.Sin(b.Heading) * 1.9 * dirSign;
        var bowZ = nz + Math.Cos(b.Heading) * 1.9 * dirSign;
        if (!HullBlocked(bowX, bowZ) && !HullBlocked(nx, nz))
        {
            b.X = nx;
            b.Z = nz;
        }
        else
        {
            b.Speed *= -0.2; // gentle bump off the shallows or a stone
        }
        // Currents gently swing the bow to follow them.
        if (fm > 0.5)
        {
            var diff = WrapAngle(Math.Atan2(f.X, f.Z) - b.Heading);
            b.Heading += diff * Math.Min(1, dt * 0.25) * (b.Rowing ? 0.3 : 1);
        }
        X = b.X;
        Z = b.Z;
        Y = b.Bob;
        Heading = b.Heading;
        Anim = b.Rowing ? PlayerAnim.Row : PlayerAnim.Sit;
        AnimRate = 1;

        var shore = FindShore();
        Prompt = shore != null && Math.Abs(b.Speed) < 1.6 ? "E   step ashore" : "";
        if (pressed && shore is { } s && Prompt.Length > 0)
        {
            Mode = PlayerMode.Walk;
            b.Speed = 0;
            b.Rowing = false;
            Place(s.X, s.Z, Math.Atan2(s.X - b.X, s.Z - b.Z));
        }
    }

    private bool HullBlocked(double x, double z) =>
        _world.Height(x, z) >= BoatDraft || (Platforms?.BlocksBoat(x, z, 1.1) ?? false);

    private Vec2? FindShore()
    {
        Vec2? best = null;
        var bestR = 0.0;
        for (var r = 2.2; r <= 4.4; r += 0.7)
        {
            for (var k = 0; k < 16; k++)
            {
                var a = k / 16.0 * Math.PI * 2;
                var x = Boat.X + Math.Sin(a) * r;
                var z = Boat.Z + Math.Cos(a) * r;
                var h = Ground(x, z);
                if (h > 0.05 && h < 2.5 && (best == null || r < bestR))
                {
                    best = new Vec2(x, z);
                    bestR = r;
                }
            }
        }
        return best;
    }
}
