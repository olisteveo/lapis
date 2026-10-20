using System;
using System.Collections.Generic;

namespace Lapis.Core;

public enum SurvivalMode
{
    Wander,
    Story,
    Survival,
}

/// <summary>Rates and capacities for one survival mode (docs/SURVIVAL.md).</summary>
public sealed class SurvivalTuning
{
    public SurvivalTuning(double drainDark, double drainWater, double drainWind, double drainDarkWater, double drainRain, double lateFactor, double refill,
        double wispCap, double lanternCap, double flareCost, double flareCooldown, double moteRate, double drawRate)
    {
        DrainDark = drainDark;
        DrainWater = drainWater;
        DrainWind = drainWind;
        DrainDarkWater = drainDarkWater;
        DrainRain = drainRain;
        LateFactor = lateFactor;
        Refill = refill;
        WispCap = wispCap;
        LanternCap = lanternCap;
        FlareCost = flareCost;
        FlareCooldown = flareCooldown;
        MoteRate = moteRate;
        DrawRate = drawRate;
    }

    public double DrainDark { get; }
    public double DrainWater { get; }
    public double DrainWind { get; }
    public double DrainDarkWater { get; }
    public double DrainRain { get; }
    public double LateFactor { get; }
    public double Refill { get; }
    public double WispCap { get; }
    public double LanternCap { get; }
    public double FlareCost { get; }
    public double FlareCooldown { get; }
    public double MoteRate { get; }
    public double DrawRate { get; }

    public static readonly SurvivalTuning Survival = new(1.0 / 420, 1.0 / 60, 1.0 / 240, 1.0 / 40, 1.0 / 150, 2.2, 1.0 / 12, 1, 3, 1, 3, 1.0 / 90, 1.0 / 8);

    /// <summary>The story without the struggle: the cold is slow, flares are free.</summary>
    public static readonly SurvivalTuning Story = new(1.0 / 1200, 1.0 / 240, 0, 1.0 / 160, 1.0 / 400, 1.5, 1.0 / 6, 1, 3, 0, 20, 1.0 / 90, 1.0 / 8);
}

/// <summary>What the Keeper is exposed to this frame, measured by the game.</summary>
public readonly struct Exposure
{
    public Exposure(double lit, bool inWater, double wind, double night, double dark = 0, double rain = 0, double glow = 0)
    {
        Glow = glow;
        Rain = rain;
        Lit = lit;
        InWater = inWater;
        Wind = wind;
        Night = night;
        Dark = dark;
    }

    public double Lit { get; }
    public bool InWater { get; }
    public double Wind { get; }
    public double Night { get; }
    public double Dark { get; }
    public double Rain { get; }

    /// <summary>0..1: glowing plants around her. They soften the cold but never warm her back up.</summary>
    public double Glow { get; }
}

/// <summary>How warm she is: 1 warm, 0 collapsed. Drains in the dark, water and wind; light warms her.</summary>
public sealed class Warmth
{
    public double Value { get; private set; } = 1;

    /// <summary>Returns true on the frame warmth runs out.</summary>
    public bool Update(double dt, Exposure e, SurvivalTuning t)
    {
        var dark = 1 - Math.Min(1, Math.Max(0, e.Lit + e.Glow * 0.6));
        var late = 1 + (t.LateFactor - 1) * e.Night * e.Night;
        var drain = (t.DrainDark * dark * late + (e.InWater ? t.DrainWater : 0) + t.DrainWind * e.Wind * dark + t.DrainDarkWater * e.Dark + t.DrainRain * e.Rain) * dt;
        var gain = t.Refill * Math.Max(0, e.Lit) * dt;
        var before = Value;
        Value = Math.Min(1, Math.Max(0, Value - drain + gain));
        return before > 0 && Value == 0;
    }

    public void Reset() => Value = 1;
}

/// <summary>The light you carry: the wisp's to begin with, more once the paper lantern is found.</summary>
public sealed class LightStore
{
    private double _cooldown;

    public LightStore(double cap)
    {
        Cap = cap;
        Value = cap;
    }

    public double Cap { get; set; }
    public double Value { get; private set; }
    public bool Ready => _cooldown <= 0;

    public void Gain(double amount) => Value = Math.Min(Cap, Value + amount);

    /// <summary>Spend a flare's worth. False (and nothing spent) without enough light or while cooling down.</summary>
    public bool Flare(SurvivalTuning t)
    {
        if (_cooldown > 0 || Value < t.FlareCost - 1e-9) return false;
        Value -= t.FlareCost;
        _cooldown = t.FlareCooldown;
        return true;
    }

    public void Update(double dt) => _cooldown = Math.Max(0, _cooldown - dt);
}

/// <summary>Repeated rests at one lighthouse buy less night each time; a different lighthouse restores it all.</summary>
public sealed class RestReturns
{
    /// <summary>Share of the night a rest restores, by how many times in a row you've rested at that tower.</summary>
    public static readonly double[] Returns = { 1, 0.6, 0.35, 0.2 };

    public int Tower { get; private set; } = -1;
    public int Streak { get; private set; }

    /// <summary>Rest at tower i: returns the share of the elapsed night given back (1 = a whole new night).</summary>
    public double RestAt(int i)
    {
        Streak = i == Tower ? Streak + 1 : 0;
        Tower = i;
        return Returns[Math.Min(Streak, Returns.Length - 1)];
    }

    /// <summary>Waking after the night runs out starts the count again.</summary>
    public void Clear()
    {
        Tower = -1;
        Streak = 0;
    }
}

/// <summary>Glowing places you draw light from dim, then regrow over RegrowSeconds. Keyed by world cell.</summary>
public sealed class Sources
{
    private readonly Dictionary<(long, long), double> _drawn = new();

    public Sources(double cell = 8, double regrowSeconds = 180)
    {
        Cell = cell;
        RegrowSeconds = regrowSeconds;
    }

    public double Cell { get; }
    public double RegrowSeconds { get; }

    private (long, long) Key(double x, double z) => ((long)Math.Floor(x / Cell), (long)Math.Floor(z / Cell));

    /// <summary>How much light is left at (x, z) at time now (seconds): 1 fresh, 0 drawn dry.</summary>
    public double Left(double x, double z, double now)
    {
        if (!_drawn.TryGetValue(Key(x, z), out var at)) return 1;
        return Math.Min(1, Math.Max(0, (now - at) / RegrowSeconds));
    }

    /// <summary>Draw for dt seconds at rate; returns the light taken. The source dims as it gives.</summary>
    public double Draw(double x, double z, double now, double dt, double rate)
    {
        var left = Left(x, z, now);
        if (left <= 0) return 0;
        var taken = Math.Min(left, rate * dt);
        _drawn[Key(x, z)] = now - (left - taken) * RegrowSeconds;
        return taken;
    }
}
