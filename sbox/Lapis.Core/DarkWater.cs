using System;
using System.Collections.Generic;

namespace Lapis.Core;

/// <summary>A clear circle the Dark Water can't enter: a restored region, or the shore you woke on.</summary>
public readonly struct Refuge
{
    public Refuge(double x, double z, double r)
    {
        X = x;
        Z = z;
        R = r;
    }

    public double X { get; }
    public double Z { get; }
    public double R { get; }
}

/// <summary>
/// Dark Water: starless black water that creeps in from the horizon through the night. Restored
/// constellations hold it back around their regions.
/// </summary>
public static class DarkWater
{
    /// <summary>Distance from the island's heart at which the Dark Water starts.</summary>
    public const double ReachFar = 6200;

    /// <summary>Width of its soft edge, in metres.</summary>
    public const double Edge = 180;

    /// <summary>How close it comes by dawn in each mode.</summary>
    public static double ReachNear(SurvivalMode mode) => mode == SurvivalMode.Story ? 3300 : 2300;

    private static double Smooth(double a, double b, double x)
    {
        var t = Math.Min(1, Math.Max(0, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
    }

    /// <summary>How far from the island's heart the Dark Water has reached at this point of the night.</summary>
    public static double Reach(double night, SurvivalMode mode)
    {
        if (mode == SurvivalMode.Wander) return double.PositiveInfinity;
        return ReachFar - (ReachFar - ReachNear(mode)) * Smooth(0.2, 0.95, night);
    }

    /// <summary>0 clear to 1 fully dark at (x, z). Refuges clear it out to 1.2 r, fading to nothing by 1.8 r.</summary>
    public static double At(double x, double z, double reach, IReadOnlyList<Refuge> refuges)
    {
        if (double.IsInfinity(reach)) return 0;
        var dark = Smooth(reach - Edge, reach + Edge, Math.Sqrt(x * x + z * z));
        if (dark <= 0) return 0;
        foreach (var f in refuges)
        {
            var dx = x - f.X;
            var dz = z - f.Z;
            dark *= 1 - Smooth(f.R * 1.8, f.R * 1.2, Math.Sqrt(dx * dx + dz * dz));
        }
        return dark;
    }
}
