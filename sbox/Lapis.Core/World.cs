namespace Lapis.Core;

/// <summary>Terrain the player stands on and the water currents that carry the boat.</summary>
public interface IWorldQuery
{
    double Height(double x, double z);

    /// <summary>Water current (m/s) at a point: star currents that carry the boat. Zero where there is none.</summary>
    Vec2 Flow(double x, double z) => Vec2.Zero;
}

public delegate void ColliderVisitor(double cx, double cz, double radius);

/// <summary>Circular solids the walker can't pass through (tree trunks, the beached hull).</summary>
public interface IColliders
{
    /// <summary>Visits every collider near (x, z) as (cx, cz, radius).</summary>
    void Near(double x, double z, double reach, ColliderVisitor visit);
}

/// <summary>Standable surfaces above the terrain: stepping stones, stairs, ledges.</summary>
public interface IPlatforms
{
    /// <summary>Highest standable top at (x, z) within a step of height y (stacked surfaces, like a stair), or -Infinity.</summary>
    double Top(double x, double z, double y = double.PositiveInfinity);

    /// <summary>Is a walker at (x, z, y) inside a wall, rail or under a low ceiling?</summary>
    bool Blocked(double x, double z, double y) => false;

    /// <summary>True if something solid in the water blocks a hull at (x, z).</summary>
    bool BlocksBoat(double x, double z, double radius);
}
