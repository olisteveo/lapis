"""Synthesises every Lapis sound offline into public/audio/*.wav.

    tools/audio/.venv/bin/python tools/audio/build_sounds.py [out_dir]

Everything is generated from noise and oscillators with numpy, deterministic per seed.
Loops are built to be seamless: their noise is FFT-shaped (inherently circular), their
modulations are periodic over the loop length, and reverb is applied as a circular
convolution so tails wrap around the loop point.
"""
import math
import os
import sys
import wave

import numpy as np

SR = 44100
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "public", "audio")
rng = np.random.default_rng(1337)


# ---------------------------------------------------------------- primitives

def t_axis(seconds):
    return np.arange(int(seconds * SR)) / SR


def shaped_noise(n, shape):
    """White noise with its spectrum multiplied by shape(freq_hz). Circular, so loopable."""
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    out = np.fft.irfft(spec * shape(f), n)
    return out / (np.max(np.abs(out)) + 1e-9)


def band(lo, hi, soft=1.5):
    def shape(f):
        f = np.maximum(f, 1)
        return 1 / (1 + (lo / f) ** (2 * soft)) / (1 + (f / hi) ** (2 * soft))
    return shape


def tilt(power):
    """1/f^power spectrum: 0 white, 0.5 pink, 1 brown."""
    return lambda f: 1 / np.maximum(f, 20) ** power


def mul_shape(*shapes):
    return lambda f: np.prod([s(f) for s in shapes], axis=0)


def env_ad(n, attack, decay, curve=4.0):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    d = np.exp(-np.maximum(t - attack, 0) * curve / max(decay, 1e-4))
    return a * d


def impulse_response(seconds=2.6, damp=3.2, bright=6000):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = shaped_noise(n, band(120, bright)) * np.exp(-t * damp)
    ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
    return ir / np.sqrt(np.sum(ir ** 2))


def reverb(x, wet=0.35, seconds=2.6, circular=False, damp=3.2):
    ir = impulse_response(seconds, damp)
    if circular:
        n = len(x)
        irc = np.zeros(n)
        irc[: min(n, len(ir))] = ir[:n]
        y = np.fft.irfft(np.fft.rfft(x) * np.fft.rfft(irc), n)
    else:
        n = len(x) + len(ir)
        y = np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(ir, n), n)
        x = np.pad(x, (0, len(y) - len(x)))
    return x * (1 - wet) + y * wet * 2.2


def grains(n, rate, length_ms, lo, hi, seed_jitter=1.0):
    """Sparse filtered clicks: sand grains, leaf crackle, droplets of spray."""
    out = np.zeros(n)
    count = rng.poisson(rate * n / SR)
    gl = max(8, int(length_ms * SR / 1000))
    for _ in range(count):
        p = rng.integers(0, max(1, n - gl))
        g = rng.standard_normal(gl) * np.exp(-np.linspace(0, 6 * seed_jitter, gl))
        out[p:p + gl] += g * rng.uniform(0.3, 1.0)
    spec = np.fft.rfft(out)
    f = np.fft.rfftfreq(n, 1 / SR)
    return np.fft.irfft(spec * band(lo, hi)(f), n)


def droplet(freq, dur=0.06):
    t = t_axis(dur)
    # Droplets chirp upward as the cavity closes.
    phase = 2 * np.pi * np.cumsum(freq * (1 + 1.8 * t / dur)) / SR
    return np.sin(phase) * np.exp(-t * 60)


def place(buf, clip, at, wrap=False):
    if wrap:
        idx = (np.arange(len(clip)) + at) % len(buf)
        np.add.at(buf, idx, clip)
    else:
        end = min(len(buf), at + len(clip))
        buf[at:end] += clip[: end - at]


def normalise(x, peak_db=-1.0):
    return x / (np.max(np.abs(x)) + 1e-9) * 10 ** (peak_db / 20)


def fade_edges(x, ms=4):
    n = int(ms * SR / 1000)
    x = x.copy()
    x[:n] *= np.linspace(0, 1, n)
    x[-n:] *= np.linspace(1, 0, n)
    return x


def write(name, x, peak_db=-1.0):
    os.makedirs(OUT, exist_ok=True)
    x = normalise(x, peak_db)
    data = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(os.path.join(OUT, f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    print(f"  {name}.wav  {len(x) / SR:.2f}s")


# ---------------------------------------------------------------- footsteps

def step_sand(i):
    n = int(0.32 * SR)
    heel = shaped_noise(n, band(70, 260)) * env_ad(n, 0.004, 0.05, 5)
    shuffle = shaped_noise(n, band(500, 4200)) * env_ad(n, 0.012, 0.16 + 0.04 * rng.random(), 4)
    crunch = grains(n, 900 + 400 * rng.random(), 1.2, 1800, 9000) * env_ad(n, 0.01, 0.14, 4)
    return fade_edges(heel * 0.9 + shuffle * 0.45 + crunch * 0.6)


def step_wet(i):
    n = int(0.36 * SR)
    heel = shaped_noise(n, band(60, 220)) * env_ad(n, 0.003, 0.06, 5)
    squelch = shaped_noise(n, band(250, 1600)) * env_ad(n, 0.02, 0.2, 3.5)
    # A short sucking resonance as the foot lifts out of wet sand.
    t = t_axis(0.36)
    suck = np.sin(2 * np.pi * np.cumsum(420 - 250 * t / 0.36) / SR) * env_ad(n, 0.08, 0.12, 6) * 0.25
    return fade_edges(heel * 0.8 + squelch * 0.55 + np.roll(suck, int(0.1 * SR)))


def step_water(i):
    n = int(0.7 * SR)
    splash = shaped_noise(n, band(400, 6500)) * env_ad(n, 0.01, 0.28, 3.5)
    body = shaped_noise(n, band(90, 500)) * env_ad(n, 0.006, 0.12, 4)
    out = splash * 0.7 + body * 0.6
    for _ in range(rng.integers(6, 14)):
        place(out, droplet(rng.uniform(900, 2600)) * rng.uniform(0.1, 0.35), int(rng.uniform(0.08, 0.55) * SR))
    return fade_edges(out)


def step_jungle(i):
    n = int(0.4 * SR)
    thump = shaped_noise(n, band(60, 240)) * env_ad(n, 0.004, 0.07, 5)
    crackle = grains(n, 1600 + 900 * rng.random(), 2.0, 1500, 8000) * env_ad(n, 0.015, 0.22, 3.5)
    rustle = shaped_noise(n, band(1200, 7000)) * env_ad(n, 0.03, 0.25, 3)
    out = thump * 0.9 + crackle * 0.8 + rustle * 0.25
    if rng.random() < 0.35:
        snap = shaped_noise(int(0.03 * SR), band(1500, 6000)) * env_ad(int(0.03 * SR), 0.0005, 0.01, 6)
        place(out, snap * 0.9, int(rng.uniform(0.02, 0.12) * SR))
    return fade_edges(out)


# ---------------------------------------------------------------- boat

def oar_dip(i):
    n = int(1.1 * SR)
    entry = shaped_noise(n, band(300, 3500)) * env_ad(n, 0.02, 0.35, 3)
    gulp = shaped_noise(n, band(80, 400)) * env_ad(n, 0.04, 0.3, 3)
    out = entry * 0.6 + gulp * 0.7
    for _ in range(rng.integers(4, 9)):
        place(out, droplet(rng.uniform(800, 2000), 0.08) * 0.2, int(rng.uniform(0.25, 0.9) * SR))
    return fade_edges(reverb(out, 0.15, 1.2)[:n])


def oar_drip(i):
    n = int(1.4 * SR)
    out = np.zeros(n)
    for _ in range(rng.integers(10, 18)):
        place(out, droplet(rng.uniform(1000, 3200), 0.05) * rng.uniform(0.15, 0.5), int(rng.uniform(0.0, 1.25) * SR))
    return fade_edges(reverb(out, 0.25, 1.0)[:n])


# ---------------------------------------------------------------- story one-shots

PENTA = [587.33, 659.25, 739.99, 880.0, 987.77, 1174.66]


def bell(freq, dur=5.0, partials=((1, 1), (2.0, 0.5), (2.76, 0.4), (4.07, 0.25), (5.4, 0.18), (6.8, 0.1))):
    t = t_axis(dur)
    out = np.zeros_like(t)
    for ratio, amp in partials:
        for detune in (-0.0015, 0.0015):
            out += amp * np.sin(2 * np.pi * freq * ratio * (1 + detune) * t) * np.exp(-t * (1.2 + ratio * 0.5))
    return out * np.clip(t / 0.004, 0, 1)


def chime(i):
    base = PENTA[i % len(PENTA)]
    out = bell(base)
    place(out, 0.5 * bell(base * 1.5, 4.5), int(0.12 * SR))
    shimmer = shaped_noise(len(out), band(5000, 14000)) * env_ad(len(out), 0.3, 2.0, 3) * 0.06
    return reverb(out + shimmer, 0.45, 3.5)


def memory_swell(i):
    dur = 7.0
    t = t_axis(dur)
    chord = [293.66, 369.99, 440.0, 554.37, 659.25]
    out = np.zeros_like(t)
    for k, f in enumerate(chord):
        for d in (-0.003, 0.0, 0.004):
            out += np.sin(2 * np.pi * f * (1 + d) * t + k) * (0.6 if k else 1.0)
    shape = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2
    air = shaped_noise(len(t), band(2000, 9000)) * 0.05
    return reverb((out * 0.2 + air) * shape, 0.5, 4.0)


def star_fall(i):
    dur = 3.2
    t = t_axis(dur)
    # A descending glassy whistle, then a soft hiss as it meets the sea far away.
    f = 2400 * np.exp(-t * 0.9) + 300
    whistle = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 0.8) * np.clip(t / 0.3, 0, 1)
    hiss = shaped_noise(len(t), band(1500, 7000)) * np.exp(-np.abs(t - 2.4) * 4) * 0.4
    return reverb(whistle * 0.35 + hiss, 0.5, 3.0)


# ---------------------------------------------------------------- ambience loops

def loop_surf(seconds=24.0):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    period = seconds / 3
    phase = (t % period) / period
    # Swell builds, breaks, then a long seething wash back down the sand.
    crash = np.exp(-((phase - 0.42) / 0.05) ** 2)
    wash = np.where(phase > 0.42, np.exp(-(phase - 0.42) * 5), 0)
    build = np.clip(phase / 0.42, 0, 1) ** 2 * 0.35
    rumble = shaped_noise(n, mul_shape(tilt(1.0), band(30, 400)))
    hiss = shaped_noise(n, band(800, 9000))
    body = shaped_noise(n, mul_shape(tilt(0.5), band(150, 2500)))
    slow = 0.75 + 0.25 * np.sin(2 * np.pi * t / seconds)
    out = rumble * (0.5 + 0.4 * build + 0.5 * crash) + body * (0.2 + 0.5 * crash + 0.35 * wash) + hiss * (0.05 + 0.35 * wash + 0.2 * crash)
    return reverb(out * slow, 0.2, 2.0, circular=True)


def loop_lapping(seconds=16.0):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = shaped_noise(n, mul_shape(tilt(0.7), band(120, 1800))) * 0.15
    laps = np.zeros(n)
    for k in range(int(seconds / 1.9)):
        at = int((k * 1.9 + rng.uniform(-0.3, 0.3)) * SR)
        m = int(0.9 * SR)
        lap = shaped_noise(m, band(200, 2200)) * env_ad(m, 0.12, 0.5, 3) * rng.uniform(0.5, 1)
        place(laps, lap, at % n, wrap=True)
        for _ in range(rng.integers(1, 4)):
            place(laps, droplet(rng.uniform(700, 1800), 0.07) * 0.12, (at + int(rng.uniform(0.1, 0.6) * SR)) % n, wrap=True)
    return reverb(out + laps * 0.7, 0.25, 1.6, circular=True)


def loop_wind(seconds=30.0):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    base = shaped_noise(n, mul_shape(tilt(0.6), band(120, 1400)))
    whistle = shaped_noise(n, band(700, 1100, 4))
    gust = 0.55 + 0.25 * np.sin(2 * np.pi * 2 * t / seconds) + 0.2 * np.sin(2 * np.pi * 5 * t / seconds + 1.3)
    return base * gust + whistle * 0.12 * gust ** 3


def loop_jungle(seconds=24.0):
    n = int(seconds * SR)
    out = shaped_noise(n, mul_shape(tilt(0.4), band(200, 3000))) * 0.03
    t1 = t_axis(0.012)
    # Crickets: trains of short pulses at each insect's own pitch and rhythm.
    for c in range(9):
        pitch = rng.uniform(3800, 5600)
        rate = rng.uniform(14, 26)
        pulses = rng.integers(2, 6)
        gap = rng.uniform(0.45, 1.3)
        amp = rng.uniform(0.04, 0.12)
        pulse = np.sin(2 * np.pi * pitch * t1) * np.sin(np.pi * t1 / t1[-1])
        at = rng.uniform(0, gap)
        while at < seconds:
            for p in range(pulses):
                place(out, pulse * amp, int((at + p / rate) * SR) % n, wrap=True)
            at += gap * rng.uniform(0.85, 1.15)
    # Tree frogs: soft low knocks, a few per loop.
    for _ in range(14):
        f = rng.uniform(420, 900)
        m = int(0.14 * SR)
        tt = np.arange(m) / SR
        frog = np.sin(2 * np.pi * f * tt) * (0.5 + 0.5 * np.sin(2 * np.pi * 38 * tt)) * env_ad(m, 0.01, 0.1, 4)
        at = int(rng.uniform(0, seconds) * SR)
        for r in range(rng.integers(1, 4)):
            place(out, frog * rng.uniform(0.05, 0.12), (at + int(r * 0.18 * SR)) % n, wrap=True)
    return reverb(out, 0.35, 2.4, circular=True)


def loop_music(seconds=48.0):
    """Slow dream pad: D lydian colours, each chord breathing into the next."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    chords = [
        [146.83, 220.0, 277.18, 329.63, 440.0],   # Dmaj9
        [123.47, 185.0, 246.94, 293.66, 369.99],  # Bm7
        [98.0, 196.0, 246.94, 277.18, 369.99],    # Gmaj7#11
        [110.0, 220.0, 277.18, 329.63, 493.88],   # A6/9
    ]
    seg = seconds / len(chords)
    out = np.zeros(n)
    for k, chord in enumerate(chords):
        centre = (k + 0.5) * seg
        # Raised-cosine window, periodic over the loop so the last chord melts into the first.
        d = (t - centre + seconds / 2) % seconds - seconds / 2
        w = np.clip(np.cos(np.pi * d / (seg * 1.6)), 0, 1) ** 2
        for v, f in enumerate(chord):
            # Frequencies snapped to whole cycles per loop keep the wrap seamless.
            for det in (-0.0025, 0.0025):
                ff = round(f * (1 + det) * seconds) / seconds
                tone = np.sin(2 * np.pi * ff * t) + 0.3 * np.sin(2 * np.pi * 2 * ff * t) + 0.1 * np.sin(2 * np.pi * 3 * ff * t)
                out += tone * w * (0.5 if v == 0 else 0.3)
    # Sparse twinkles, like the bell of a star somewhere far off.
    for _ in range(10):
        f = rng.choice(PENTA) * rng.choice([1, 2])
        place(out, bell(f, 3.0) * 0.18, int(rng.uniform(0, seconds) * SR), wrap=True)
    return reverb(out, 0.55, 5.0, circular=True, damp=1.6)


# ---------------------------------------------------------------- build

def main():
    print(f"[lapis] writing audio to {os.path.abspath(OUT)}")
    sets = {"step_sand": step_sand, "step_wet": step_wet, "step_water": step_water, "step_jungle": step_jungle}
    for name, fn in sets.items():
        for i in range(6):
            write(f"{name}_{i}", fn(i), -3)
    for i in range(3):
        write(f"oar_dip_{i}", oar_dip(i), -4)
    for i in range(2):
        write(f"oar_drip_{i}", oar_drip(i), -8)
    for i in range(6):
        write(f"chime_{i}", chime(i), -2)
    write("memory_swell", memory_swell(0), -6)
    write("star_fall", star_fall(0), -4)
    write("loop_surf", loop_surf(), -3)
    write("loop_lapping", loop_lapping(), -3)
    write("loop_wind", loop_wind(), -3)
    write("loop_jungle", loop_jungle(), -3)
    write("loop_music", loop_music(), -3)


if __name__ == "__main__":
    main()
