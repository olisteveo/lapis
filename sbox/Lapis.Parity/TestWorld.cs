using Lapis.Core;
using static Lapis.Core.LapisMath;

namespace Lapis.Parity;

// Mirror of tools/parity/world.ts. Keep the two in lockstep; the traces are only meaningful
// if both controllers see identical terrain, colliders and platforms.
public sealed class TestWorld : IWorldQuery, IColliders, IPlatforms
{
    private const double Tau = Math.PI * 2;

    private static readonly (double X, double Y, double Z) Tower = (-20, 2, 0);
    private const double Rise = 0.25;
    private const double StepAngle = 0.314159;
    private const double Start = 0.6;
    private const int Steps = 40;
    private const double Newel = 0.35;
    private const double WallIn = 2.5;
    private const double WallOut = 2.85;
    private const double DoorWidth = 1.4;

    private static readonly (double X0, double X1, double Z0, double Z1, double Top) Ledge = (-10, -6, 6, 10, 2.0);
    private static readonly (double X, double Z, double R, double Top) Pillar = (-4, 20, 1.5, 12);
    private static readonly (double X, double Z, double R) Rock = (32, -9.5, 2);

    private static readonly (double X, double Z, double R)[] Circles =
    {
        (5, 8, 0.6),
        (-4, 3, 0.8),
        (2, -6, 0.5),
    };

    public double Height(double x, double z)
    {
        var h = 1.5 + 0.35 * Math.Sin(0.21 * x + 0.3) + 0.3 * Math.Cos(0.17 * z) + 0.15 * Math.Sin(0.13 * (x + z));
        h -= 0.3 * Math.Max(0, x - 12);
        var d = Hypot(x - Tower.X, z - Tower.Z);
        var w = Math.Max(0, Math.Min(1, (8 - d) / 3));
        return h + (Tower.Y - h) * w;
    }

    public Vec2 Flow(double x, double z)
    {
        if (x < 30) return new Vec2(0, 0);
        var s = 4 * Math.Max(0, Math.Min(1, (z - 20) / 10));
        return new Vec2(0.6 * Math.Sin(z * 0.1) * s * 0.25, s);
    }

    public void Near(double x, double z, double reach, ColliderVisitor visit)
    {
        foreach (var (cx, cz, r) in Circles)
            if (Hypot(x - cx, z - cz) <= reach + r) visit(cx, cz, r);
    }

    private static double AngleGap(double a, double b) => Math.Abs(((a - b + Math.PI * 3) % Tau) - Math.PI);

    private static bool TowerLocal(double x, double z, out double r, out double phi)
    {
        var dx = x - Tower.X;
        var dz = z - Tower.Z;
        r = phi = 0;
        if (Math.Abs(dx) > 7 || Math.Abs(dz) > 7) return false;
        phi = ((Math.Atan2(-dz, dx) % Tau) + Tau) % Tau;
        r = Hypot(dx, dz);
        return true;
    }

    private static List<double> TowerSurfaces(double r, double phi)
    {
        var output = new List<double>();
        if (r > Newel - 0.05 && r <= WallIn + 0.05)
        {
            for (var k = 0; k < 4; k++)
            {
                var i = Math.Floor((((phi - Start + Tau) % Tau) + k * Tau) / StepAngle);
                if (i >= Steps) break;
                output.Add((i + 1) * Rise);
            }
        }
        return output;
    }

    public double Top(double x, double z, double y = double.PositiveInfinity)
    {
        var best = double.NegativeInfinity;
        if (x >= Ledge.X0 && x <= Ledge.X1 && z >= Ledge.Z0 && z <= Ledge.Z1) best = Ledge.Top;
        if (Hypot(x - Pillar.X, z - Pillar.Z) <= Pillar.R) best = Math.Max(best, Pillar.Top);
        if (TowerLocal(x, z, out var r, out var phi))
        {
            var h = y - Tower.Y;
            foreach (var s in TowerSurfaces(r, phi))
                if (s <= h + 0.55 && Tower.Y + s > best) best = Tower.Y + s;
        }
        return best;
    }

    public bool Blocked(double x, double z, double y)
    {
        if (!TowerLocal(x, z, out var r, out var phi)) return false;
        const double b = 0.35;
        var h = y - Tower.Y;
        if (r < Newel + b && h < 12) return true;
        if (r > WallIn - b && r < WallOut + b && h < 12)
        {
            var inDoor = h < 1.5 && AngleGap(phi, 0) * r < DoorWidth / 2 - b * 0.5;
            if (!inDoor) return true;
        }
        foreach (var s in TowerSurfaces(r, phi))
            if (s > h + 0.55 && s - 0.32 < h + 1.75) return true;
        return false;
    }

    public bool BlocksBoat(double x, double z, double radius) => Hypot(x - Rock.X, z - Rock.Z) < Rock.R + radius;
}
