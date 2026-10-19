namespace Lapis.Core;

/// <summary>A point or direction on the ground plane. Y is up in Lapis, so the plane is (X, Z).</summary>
public readonly struct Vec2
{
    public readonly double X;
    public readonly double Z;

    public Vec2(double x, double z)
    {
        X = x;
        Z = z;
    }

    public static Vec2 Zero => default;

    public double Length => LapisMath.Hypot(X, Z);

    public override string ToString() => $"({X:0.###}, {Z:0.###})";
}

/// <summary>A world position, Y up. Kept engine-free: the s&amp;box adapter converts to Sandbox.Vector3.</summary>
public readonly struct Vec3
{
    public readonly double X;
    public readonly double Y;
    public readonly double Z;

    public Vec3(double x, double y, double z)
    {
        X = x;
        Y = y;
        Z = z;
    }

    public override string ToString() => $"({X:0.###}, {Y:0.###}, {Z:0.###})";
}
