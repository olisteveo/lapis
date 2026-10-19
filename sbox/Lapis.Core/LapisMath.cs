using System;

namespace Lapis.Core;

/// <summary>The few JavaScript Math semantics the port has to reproduce bit-for-bit, not just approximately.</summary>
public static class LapisMath
{
    /// <summary>
    /// V8's Math.hypot for two arguments: scale by the larger magnitude and use a compensated sum.
    /// A plain Sqrt(x*x + y*y) differs in the last bit often enough to drift a long trace.
    /// </summary>
    public static double Hypot(double x, double y)
    {
        double ax = Math.Abs(x), ay = Math.Abs(y);
        if (double.IsInfinity(ax) || double.IsInfinity(ay)) return double.PositiveInfinity;
        if (double.IsNaN(ax) || double.IsNaN(ay)) return double.NaN;
        double max = Math.Max(ax, ay);
        if (max == 0) return 0;
        double sum = 0, compensation = 0;
        Accumulate(ax / max, ref sum, ref compensation);
        Accumulate(ay / max, ref sum, ref compensation);
        return Math.Sqrt(sum) * max;
    }

    private static void Accumulate(double n, ref double sum, ref double compensation)
    {
        double summand = n * n - compensation;
        double preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }

    /// <summary>JS <c>Math.sign(v || 1)</c>: zero (either sign) and NaN count as forward.</summary>
    public static double SignOrOne(double v) => v == 0 || double.IsNaN(v) ? 1 : Math.Sign(v);

    public static double Clamp(double v, double min, double max) => Math.Max(min, Math.Min(max, v));

    /// <summary>Wraps an angle difference into (-pi, pi] the same way the TS does, via atan2.</summary>
    public static double WrapAngle(double a) => Math.Atan2(Math.Sin(a), Math.Cos(a));
}
