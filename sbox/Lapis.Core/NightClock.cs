using System;
using System.Collections.Generic;

namespace Lapis.Core;

public enum NightCue
{
    Late,
    Cold,
    Eyes,
    Wake,
}

/// <summary>The night: how long Mara can stay asleep before she surfaces.</summary>
public sealed class NightClock
{
    /// <summary>Fraction of the night at which each cue fires.</summary>
    private static readonly (double At, NightCue Cue)[] Cues =
    {
        (0.6, NightCue.Late),
        (0.78, NightCue.Cold),
        (0.92, NightCue.Eyes),
        (1, NightCue.Wake),
    };

    private readonly HashSet<NightCue> _fired = new();

    public NightClock(double length) => Length = length;

    /// <summary>Seconds from dusk to waking.</summary>
    public double Length { get; set; }

    /// <summary>0 at dusk, 1 when she wakes.</summary>
    public double Progress { get; private set; }

    public event Action<NightCue>? Cue;

    /// <summary>A fresh night: resting at a lighthouse, or after waking.</summary>
    public void Reset()
    {
        Progress = 0;
        _fired.Clear();
    }

    /// <summary>Pick up a saved night: cues already passed count as heard, so none replay.</summary>
    public void Resume(double progress)
    {
        Progress = Math.Min(1, Math.Max(0, progress));
        _fired.Clear();
        foreach (var (at, cue) in Cues)
            if (at <= Progress) _fired.Add(cue);
    }

    /// <summary>Give back a share of the elapsed night (1 = a fresh night); cues not yet reached fire again.</summary>
    public void Rewind(double share)
    {
        Progress *= 1 - Math.Min(1, Math.Max(0, share));
        foreach (var (at, cue) in Cues)
            if (at > Progress) _fired.Remove(cue);
    }

    public void Update(double dt)
    {
        Progress = Math.Min(1, Progress + dt / Length);
        foreach (var (at, cue) in Cues)
        {
            if (Progress >= at && _fired.Add(cue))
                Cue?.Invoke(cue);
        }
    }

    /// <summary>A gentle word for the HUD, so the night can be read without a bar.</summary>
    public string Phrase =>
        Progress < 0.35 ? "the night is young"
        : Progress < 0.6 ? "the night wears on"
        : Progress < 0.8 ? "the night grows late"
        : "dawn is close";
}
