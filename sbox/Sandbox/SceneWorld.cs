// UNTESTED AGAINST THE s&box SDK. Written from the public s&box API as best known (Component,
// Scene.Trace, GameObject.WorldPosition); not compiled. Expect small API-name fixes on first build.
using System;
using Lapis.Core;
using Sandbox;

namespace Lapis.Sandbox;

/// <summary>
/// Lapis is Y-up metres with heading 0 = +Z; s&amp;box is Z-up inches, X forward, Y left.
/// Both are right-handed, so lapis (x, y, z) maps to s&amp;box (z, x, y) and a Lapis heading in radians
/// is the s&amp;box yaw in degrees. Everything engine-facing goes through here.
/// </summary>
public static class LapisSpace
{
    public const float UnitsPerMetre = 39.37f;

    public static Vector3 ToWorld(Vec3 p, float waterLevel) =>
        new((float)p.Z * UnitsPerMetre, (float)p.X * UnitsPerMetre, (float)p.Y * UnitsPerMetre + waterLevel);

    public static Vector3 ToWorld(double x, double y, double z, float waterLevel) => ToWorld(new Vec3(x, y, z), waterLevel);

    public static Vec3 FromWorld(Vector3 v, float waterLevel) =>
        new(v.y / UnitsPerMetre, (v.z - waterLevel) / UnitsPerMetre, v.x / UnitsPerMetre);

    public static Rotation HeadingToRotation(double heading) => Rotation.FromYaw((float)(heading * 180.0 / Math.PI));

    /// <summary>Lapis camera yaw is measured so that forward is (-sin, -cos); s&amp;box forward is (cos, sin) of its yaw.</summary>
    public static double CameraYawFromDegrees(float yawDegrees) => yawDegrees * Math.PI / 180.0 - Math.PI;
}

/// <summary>
/// Adapts a scene to the core's world queries with traces. Terrain is anything tagged "terrain";
/// standable platforms (stairs, ledges, stones) are tagged "platform"; walls and rails "solid".
/// </summary>
public sealed class SceneWorld : IWorldQuery, IColliders, IPlatforms
{
    private const float TraceTop = 100000f;
    private readonly Scene _scene;
    private readonly GameObject _ignore;
    private readonly float _waterLevel;

    public SceneWorld(Scene scene, GameObject ignore, float waterLevel)
    {
        _scene = scene;
        _ignore = ignore;
        _waterLevel = waterLevel;
    }

    /// <summary>Optional currents; the core treats a null field as still water.</summary>
    public Func<double, double, Vec2>? Currents { get; set; }

    public double Height(double x, double z)
    {
        var from = LapisSpace.ToWorld(x, 0, z, _waterLevel).WithZ(TraceTop);
        var tr = _scene.Trace.Ray(from, from.WithZ(-TraceTop)).WithTag("terrain").IgnoreGameObjectHierarchy(_ignore).Run();
        // No terrain under a point means open sea: deep enough to never be wadeable.
        return tr.Hit ? LapisSpace.FromWorld(tr.HitPosition, _waterLevel).Y : -50;
    }

    public Vec2 Flow(double x, double z) => Currents?.Invoke(x, z) ?? Vec2.Zero;

    public void Near(double x, double z, double reach, ColliderVisitor visit)
    {
        foreach (var c in _scene.GetAllComponents<LapisCircleCollider>())
        {
            var p = LapisSpace.FromWorld(c.WorldPosition, _waterLevel);
            var r = c.Radius;
            if (LapisMath.Hypot(x - p.X, z - p.Z) <= reach + r) visit(p.X, p.Z, r);
        }
    }

    /// <summary>
    /// Casting down from one step above y returns exactly the "highest surface within a step",
    /// which is what makes stacked spiral treads work without the core knowing about stairs.
    /// </summary>
    public double Top(double x, double z, double y = double.PositiveInfinity)
    {
        var startY = double.IsPositiveInfinity(y) ? TraceTop : LapisSpace.ToWorld(x, y + 0.55, z, _waterLevel).z;
        var from = LapisSpace.ToWorld(x, 0, z, _waterLevel).WithZ((float)startY);
        var tr = _scene.Trace.Ray(from, from.WithZ(-TraceTop)).WithTag("platform").IgnoreGameObjectHierarchy(_ignore).Run();
        return tr.Hit ? LapisSpace.FromWorld(tr.HitPosition, _waterLevel).Y : double.NegativeInfinity;
    }

    public bool Blocked(double x, double z, double y, double body = PlayerController.BodyRadius)
    {
        // Sweep the body from knee to head; a hit there is a wall, rail or low tread.
        var radius = (float)body * LapisSpace.UnitsPerMetre;
        var knee = LapisSpace.ToWorld(x, y + 0.6, z, _waterLevel);
        var head = LapisSpace.ToWorld(x, y + 1.75, z, _waterLevel);
        var tr = _scene.Trace.Sphere(radius, knee, head).WithAnyTags("solid", "platform").IgnoreGameObjectHierarchy(_ignore).Run();
        return tr.Hit || tr.StartedSolid;
    }

    public double Ceiling(double x, double z, double y)
    {
        var head = LapisSpace.ToWorld(x, y + PlayerController.Head, z, _waterLevel);
        var tr = _scene.Trace.Ray(head, head + Vector3.Up * 4 * LapisSpace.UnitsPerMetre).WithAnyTags("solid", "platform").IgnoreGameObjectHierarchy(_ignore).Run();
        return tr.Hit ? LapisSpace.FromWorld(tr.HitPosition, _waterLevel).Y : double.PositiveInfinity;
    }

    public bool BlocksBoat(double x, double z, double radius)
    {
        var at = LapisSpace.ToWorld(x, 0, z, _waterLevel);
        var tr = _scene.Trace.Sphere((float)radius * LapisSpace.UnitsPerMetre, at, at + Vector3.Up).WithAnyTags("solid", "platform").Run();
        return tr.Hit || tr.StartedSolid;
    }
}

/// <summary>A trunk or post the walker slides around: the core's circular colliders.</summary>
public sealed class LapisCircleCollider : Component
{
    [Property] public float Radius { get; set; } = 0.5f;
}
