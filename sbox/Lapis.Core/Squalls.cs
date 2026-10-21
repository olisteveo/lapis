using System;

namespace Lapis.Core;

/// <summary>mulberry32, bit for bit with src/core/heightfield.ts: the same seed gives the same sequence.</summary>
public sealed class Mulberry32
{
    private uint _a;

    public Mulberry32(uint seed) => _a = seed;

    public double Next()
    {
        unchecked
        {
            _a += 0x6d2b79f5;
            var t = (_a ^ (_a >> 15)) * (1 | _a);
            t = (t + (t ^ (t >> 7)) * (61 | t)) ^ t;
            return (t ^ (t >> 14)) / 4294967296.0;
        }
    }
}

public enum SquallPhase
{
    Calm,
    Building,
    Raging,
    Passing,
}

/// <summary>
/// Squalls: rain and wind rolling in off the sea. A squall builds, rages, then passes; the calm
/// between them shortens and the squalls grow fiercer with pressure.
/// </summary>
public sealed class SquallClock
{
    private const double Build = 26;
    private const double Pass = 18;

    private readonly Mulberry32 _rnd;
    private double _t;
    private double _length;
    private double _peak = 1;
    private double _clock;

    public SquallClock(uint seed = 4242)
    {
        _rnd = new Mulberry32(seed);
        WindAngle = _rnd.Next() * Math.PI * 2;
        // The first one never comes in the opening minutes.
        _length = 180 + _rnd.Next() * 60;
    }

    public SquallPhase Phase { get; private set; } = SquallPhase.Calm;

    /// <summary>0..1: how hard it's raining and blowing right now.</summary>
    public double Intensity { get; private set; }

    /// <summary>Direction the wind blows toward, radians (0 = +z).</summary>
    public double WindAngle { get; private set; }

    /// <summary>Waking after a collapse or the night's end: the sky clears, and the next squall is a while off.</summary>
    public void Calm(double pressure = 0)
    {
        Enter(SquallPhase.Calm, pressure);
        Intensity = 0;
    }

    public double WindX => Math.Sin(WindAngle) * Intensity;
    public double WindZ => Math.Cos(WindAngle) * Intensity;

    private static double Lerp(double a, double b, double t) => a + (b - a) * t;
    private static double Smooth(double t) => t * t * (3 - 2 * t);

    /// <summary>Returns the phase just entered on the frame it changes, else null.</summary>
    public SquallPhase? Update(double dt, double pressure, bool enabled = true)
    {
        _clock += dt;
        _t += dt;
        WindAngle += (_rnd.Next() - 0.5) * dt * 0.12;
        SquallPhase? entered = null;
        if (!enabled)
        {
            if (Phase != SquallPhase.Calm) entered = Enter(SquallPhase.Calm, pressure);
            Intensity = Math.Max(0, Intensity - dt * 0.2);
            return entered;
        }
        if (_t >= _length)
        {
            var next = Phase switch
            {
                SquallPhase.Calm => SquallPhase.Building,
                SquallPhase.Building => SquallPhase.Raging,
                SquallPhase.Raging => SquallPhase.Passing,
                _ => SquallPhase.Calm,
            };
            entered = Enter(next, pressure);
        }
        var k = Math.Min(1, _t / _length);
        var gust = 0.85 + 0.15 * Math.Sin(_clock * 1.7) * Math.Sin(_clock * 0.53);
        Intensity = Phase switch
        {
            SquallPhase.Building => Smooth(k) * _peak,
            SquallPhase.Raging => _peak * gust,
            SquallPhase.Passing => (1 - Smooth(k)) * _peak,
            _ => 0,
        };
        return entered;
    }

    private SquallPhase Enter(SquallPhase phase, double pressure)
    {
        Phase = phase;
        _t = 0;
        var p = Math.Min(1, Math.Max(0, pressure));
        switch (phase)
        {
            case SquallPhase.Calm:
                _length = Lerp(260, 80, p) * (0.75 + _rnd.Next() * 0.5);
                break;
            case SquallPhase.Building:
                _length = Build;
                _peak = 0.6 + 0.4 * p;
                // Each squall comes from somewhere new.
                WindAngle = _rnd.Next() * Math.PI * 2;
                break;
            case SquallPhase.Raging:
                _length = Lerp(45, 90, p) * (0.8 + _rnd.Next() * 0.4);
                break;
            default:
                _length = Pass;
                break;
        }
        return phase;
    }
}
