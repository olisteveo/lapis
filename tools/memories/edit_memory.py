#!/usr/bin/env python3
"""Edits a generated memory clip into a finished memory film with Tesseract.

Usage: python3 tools/memories/edit_memory.py <fragment-id> <clip.mp4>
Creates tools/memories/<id>/<id>.tsrct (kept local: it embeds the source media) and exports
public/memories/<id>.mp4. The treatment is the same for every memory, so they read as one film:
a light finishing grade over the clip's own look, fine grain, a soft vignette and halation, a
gentle fade up and out. The clip's own sound is muted (its generated speech isn't English); the
scene's ambience beds from tools/memories/memories.json play under the game's memory swell.
"""
import json
import os
import subprocess
import sys
import wave

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TSRCT = os.path.expanduser("~/Library/Application Support/Tesseract/bin/tsrct")
ENV = dict(os.environ, TESSERACT_CALLER="agent-skill", TESSERACT_SKILL="tesseract-video",
           TESSERACT_HOST="claude", TESSERACT_DISTRIBUTION="standalone-skill")


def run(*args):
    out = subprocess.run([TSRCT, *args], env=ENV, capture_output=True, text=True)
    if out.returncode:
        sys.exit(f"tsrct {' '.join(args[:2])} failed:\n{out.stderr or out.stdout}")
    return out.stdout


# Drawn-ness of the memories: 0 is the raw footage, 1 the full painted treatment.
STYLE = {"amount": 1.0, "brush": 4.4, "flatten": 0.9, "levels": 4.0, "ink": 1.0, "inkThreshold": 0.1, "boilFps": 8.0,
         "saturation": 1.25, "posterize": 0.65, "haze": 1.0, "edgeBlur": 1.0}
# Overrides for trying a different balance without editing this file, e.g. MEMORY_STYLE='{"amount":0.6}'.
STYLE.update(json.loads(os.environ.get("MEMORY_STYLE", "{}")))


def painterly():
    wgsl = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "painterly.wgsl")).read()
    p = lambda name, desc, lo, hi: {"name": name, "description": desc, "min": lo, "max": hi, "default": STYLE.get(name, 0)}
    return {"type": "customShader", "name": "memoryPainterly",
            "description": "Paints real footage like the game's drawing: Kuwahara brushwork, banded gouache tones, inked edges, paper grain and a hand-drawn boil.",
            "wgsl": wgsl,
            "params": [
                p("animationTime", "Engine-driven layer clock, in seconds.", 0, 3600),
                p("amount", "How drawn: 0 is the raw footage, 1 the full painted look.", 0, 1),
                p("brush", "Brush size in pixels per Kuwahara step; larger melts more detail.", 0.5, 6),
                p("flatten", "How strongly lightness is pulled into flat gouache bands.", 0, 1),
                p("levels", "Number of tonal bands.", 2, 12),
                p("ink", "Strength of the inked outlines.", 0, 1),
                p("inkThreshold", "Edge strength needed before ink is drawn; higher draws fewer lines.", 0.02, 0.6),
                p("boilFps", "How many times a second the drawing wobbles, like redrawn frames.", 0, 24),
                p("saturation", "Colour richness after painting; above 1 for a storybook palette.", 0, 2),
                p("posterize", "How strongly colours snap to a reduced set of flat colours.", 0, 1),
                p("haze", "Milky glow and lifted shadows: how hazy the memory feels.", 0, 1),
                p("edgeBlur", "How strongly the frame melts into soft focus toward its edges.", 0, 1),
            ]}


def main():
    fid, clip = sys.argv[1], os.path.abspath(sys.argv[2])
    work = os.path.join(ROOT, "tools", "memories", fid)
    os.makedirs(os.path.join(work, ".tesseract-work"), exist_ok=True)
    proj = os.path.join(work, f"{fid}.tsrct")
    if os.path.exists(proj):
        os.remove(proj)
    run("project", "create", "--project", proj)
    meta = json.loads(run("project", "import-video", "--project", proj, "--file", clip, "--asset-id", "footage"))
    beds = next(m for m in json.load(open(os.path.join(ROOT, "tools", "memories", "memories.json")))["memories"]
                if m["id"] == fid)["ambience"]
    for name in {"memory_swell", *(b[0] for b in beds)}:
        run("project", "import-asset", "--project", proj, "--file", os.path.join(ROOT, "public", "audio", f"{name}.wav"),
            "--asset-id", name, "--kind", "audio")
    editable = os.path.join(work, ".tesseract-work", "editable.json")
    run("project", "checkout", "--project", proj, "--output", editable)

    src_ms, w, h = meta["durationMs"], meta["width"], meta["height"]
    D = (src_ms // 100) * 100
    e = json.load(open(editable))
    e["dimensions"] = {"width": 1920, "height": 1080}
    e["duration"] = D / 1000

    def window(at, dur, src=0):
        return {"type": "windowed", "inputRange": {"start": at, "duration": dur},
                "mapping": {"type": "linear", "input": {"start": at, "duration": dur}, "output": {"start": src, "duration": dur}},
                "inputOffsetMs": 0}

    # Fit the clip's frame to 1920 wide, centred vertically (sources are often 1088 tall).
    fh = round(h * 1920 / w)
    video = {"type": "Video", "id": 1, "name": "Memory", "playback": window(0, D), "sourceRange": {"start": 0, "duration": D},
             "sourceIntrinsicDuration": src_ms, "volume": 0,
             "transform": {"anchorPoint": [0, 0], "position": [0, (1080 - fh) / 2], "scale": [100, 100], "rotation": 0, "opacity": 100},
             "source": {"assetId": "footage", "fit": "cover", "sourceRect": {"x": 0, "y": 0, "width": 1920, "height": fh}}}
    eff = lambda i, x: {"id": i, "effect": x, "enabled": True}
    grade = {"type": "Adjustment", "id": 2, "name": "Memory finish", "blendMode": "normal",
             "activeRange": {"start": 0, "duration": D},
             "transform": {"anchorPoint": [0, 0], "position": [0, 0], "scale": [100, 100], "rotation": 0, "opacity": 100},
             "effects": [
                 # Half real, half drawn: the footage is painted over before the finishing grade.
                 eff(20, painterly()),
                 eff(21, {"type": "primaryGrade", "semanticVersion": 1, "temperature": 0.04, "tint": 0, "exposure": 0,
                          "contrast": -0.06, "highlights": -0.06, "shadows": 0.04, "whites": 0, "blacks": 0.05,
                          "saturation": -0.06, "vibrance": 0}),
                 eff(22, {"type": "halation", "threshold": 0.82, "radius": 22, "intensity": 0.35, "tintRed": 1, "tintGreen": 0.4, "tintBlue": 0.18}),
                 eff(23, {"type": "vignette", "amount": 0.32, "feather": 0.75, "radius": 0.95}),
                 eff(24, {"type": "grain", "amount": 0.12, "size": 1.2, "softness": 0.5, "aspectRatio": 1, "seed": 11}),
             ]}
    fade = {"type": "Rect", "id": 3, "name": "Fade", "blendMode": "normal", "activeRange": {"start": 0, "duration": D},
            "transform": {"anchorPoint": [0, 0], "position": [0, 0], "scale": [100, 100], "rotation": 0, "opacity": 100},
            "effects": [], "rect": {"size": [1920, 1080], "fillColor": [0.01, 0.01, 0.02, 1]}}
    def audio(i, name, gain):
        w = wave.open(os.path.join(ROOT, "public", "audio", f"{name}.wav"))
        ms = w.getnframes() * 1000 // w.getframerate()
        return {"type": "Audio", "id": i, "name": name, "playback": window(0, D), "sourceRange": {"start": 0, "duration": D},
                "sourceIntrinsicDuration": ms, "source": {"assetId": name}, "volume": gain, "captionsEnabled": False}
    sound = [audio(90, "memory_swell", 0.4)] + [audio(91 + i, name, gain) for i, (name, gain) in enumerate(beds)]
    e["composition"]["layers"] = [fade, grade, video, *sound]
    json.dump(e, open(editable, "w"), indent=1)
    run("project", "commit", "--project", proj, "--file", editable)

    lin, ease = {"type": "linear"}, {"type": "cubicBezier", "x1": 0.3, "y1": 0, "x2": 0.2, "y2": 1}
    k = lambda layer, prop, pts, tag: {"type": "setFxPropertyKeyframes", "compositionId": "main",
                                       "property": {"layerId": layer, "propertyType": prop},
                                       "keyframes": [{"id": f"{tag}-{i}", "layerTime": t, "value": {"type": "float", "value": v}, "easing": ez}
                                                     for i, (t, v, ez) in enumerate(pts)]}
    vol = lambda layer, code: {"type": "setFxPropertyAnimator", "compositionId": "main", "property": {"layerId": layer, "propertyType": "volume"},
                               "animator": {"type": "jsScript", "layerTimeJsCode": "var t = input.time.seconds; var D = " + str(D / 1000) +
                                            "; function k(a,b,p){return a+(b-a)*Math.max(0,Math.min(1,p));}\n" + code}, "dependencies": []}
    actions = [
        k(3, "opacity", [(0, 100, lin), (700, 0, ease), (D - 700, 0, lin), (D, 100, ease)], "fade"),
        vol(90, "if (t > D - 1.2) return k(0.4, 0, (t - D + 1.2) / 1.2); return 0.4;"),
    ] + [vol(91 + i, f"var g = {gain}; if (t < 0.6) return k(0, g, t / 0.6); if (t > D - 0.8) return k(g, 0, (t - D + 0.8) / 0.8); return g;")
         for i, (_, gain) in enumerate(beds)]
    acts = os.path.join(work, ".tesseract-work", "actions.json")
    json.dump(actions, open(acts, "w"))
    run("project", "apply", "--project", proj, "--actions", acts)
    os.makedirs(os.path.join(ROOT, "public", "memories"), exist_ok=True)
    out = os.environ.get("MEMORY_OUT") or os.path.join(ROOT, "public", "memories", f"{fid}.mp4")
    run("export", "--project", proj, "--output", out, "--resolution", "1080p", "--fps", "30")
    run("filmstrip", "--project", proj, "--timestamps-ms", f"300,{D // 3},{2 * D // 3},{D - 300}",
        "--tile-width", "480", "--tile-height", "270", "--output", os.path.join(work, "filmstrip.png"))
    if os.environ.get("MEMORY_OUT"):
        print(f"{fid}: {out} (trial)")
        return
    # The game lists which fragments have films.
    index = os.path.join(ROOT, "public", "memories", "index.json")
    ids = set(json.load(open(index))) if os.path.exists(index) else set()
    ids.add(fid)
    json.dump(sorted(ids), open(index, "w"), indent=1)
    print(f"{fid}: {out} ({os.path.getsize(out) // 1024} KB, {D} ms)")


main()
