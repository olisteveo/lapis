// UNTESTED AGAINST THE s&box SDK. Written from the public s&box API as best known; not compiled.
using System;
using Lapis.Core;
using Sandbox;

namespace Lapis.Sandbox;

/// <summary>Scene-level wrapper for the night clock: ticks it and re-raises its cues for story and UI.</summary>
public sealed class LapisNight : Component
{
    /// <summary>Seconds from dusk until Mara wakes.</summary>
    [Property] public float NightLength { get; set; } = 600f;

    public NightClock Clock { get; private set; } = null!;
    public float Progress => (float)Clock.Progress;
    public string Phrase => Clock.Phrase;

    public event Action<NightCue>? Cue;

    protected override void OnAwake()
    {
        Clock = new NightClock(NightLength);
        Clock.Cue += c => Cue?.Invoke(c);
    }

    protected override void OnFixedUpdate()
    {
        Clock.Length = NightLength;
        Clock.Update(Time.Delta);
    }

    /// <summary>A fresh night: resting at a lighthouse, or after waking.</summary>
    public void Reset() => Clock.Reset();
}
