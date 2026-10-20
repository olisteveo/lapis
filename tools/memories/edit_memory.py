#!/usr/bin/env python3
"""Edits a generated memory clip into a finished memory film with Tesseract.

Usage: python3 tools/memories/edit_memory.py <fragment-id> <clip.mp4>
Creates tools/memories/<id>/<id>.tsrct (kept local: it embeds the source media) and exports
public/memories/<id>.mp4. The treatment is the same for every memory, so they read as one film:
a light finishing grade over the clip's own look, fine grain, a soft vignette and halation, a
gentle fade up and out, the clip's own sound under the game's memory swell.
"""
import json
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TSRCT = os.path.expanduser("~/Library/Application Support/Tesseract/bin/tsrct")
ENV = dict(os.environ, TESSERACT_CALLER="agent-skill", TESSERACT_SKILL="tesseract-video",
           TESSERACT_HOST="claude", TESSERACT_DISTRIBUTION="standalone-skill")


def run(*args):
    out = subprocess.run([TSRCT, *args], env=ENV, capture_output=True, text=True)
    if out.returncode:
        sys.exit(f"tsrct {' '.join(args[:2])} failed:\n{out.stderr or out.stdout}")
    return out.stdout


def main():
    fid, clip = sys.argv[1], os.path.abspath(sys.argv[2])
    work = os.path.join(ROOT, "tools", "memories", fid)
    os.makedirs(os.path.join(work, ".tesseract-work"), exist_ok=True)
    proj = os.path.join(work, f"{fid}.tsrct")
    if os.path.exists(proj):
        os.remove(proj)
    run("project", "create", "--project", proj)
    meta = json.loads(run("project", "import-video", "--project", proj, "--file", clip, "--asset-id", "footage"))
    run("project", "import-asset", "--project", proj, "--file", os.path.join(ROOT, "public", "audio", "memory_swell.wav"),
        "--asset-id", "swell", "--kind", "audio")
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
             "sourceIntrinsicDuration": src_ms, "volume": 0.8,
             "transform": {"anchorPoint": [0, 0], "position": [0, (1080 - fh) / 2], "scale": [100, 100], "rotation": 0, "opacity": 100},
             "source": {"assetId": "footage", "fit": "cover", "sourceRect": {"x": 0, "y": 0, "width": 1920, "height": fh}}}
    eff = lambda i, x: {"id": i, "effect": x, "enabled": True}
    grade = {"type": "Adjustment", "id": 2, "name": "Memory finish", "blendMode": "normal",
             "activeRange": {"start": 0, "duration": D},
             "transform": {"anchorPoint": [0, 0], "position": [0, 0], "scale": [100, 100], "rotation": 0, "opacity": 100},
             "effects": [
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
    swell = {"type": "Audio", "id": 90, "name": "Memory swell", "playback": window(0, D), "sourceRange": {"start": 0, "duration": D},
             "sourceIntrinsicDuration": 11000, "source": {"assetId": "swell"}, "volume": 0.4, "captionsEnabled": False}
    e["composition"]["layers"] = [fade, grade, video, swell]
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
        vol(1, "if (t < 0.6) return k(0, 0.8, t / 0.6); if (t > D - 0.8) return k(0.8, 0, (t - D + 0.8) / 0.8); return 0.8;"),
        vol(90, "if (t > D - 1.2) return k(0.4, 0, (t - D + 1.2) / 1.2); return 0.4;"),
    ]
    acts = os.path.join(work, ".tesseract-work", "actions.json")
    json.dump(actions, open(acts, "w"))
    run("project", "apply", "--project", proj, "--actions", acts)
    os.makedirs(os.path.join(ROOT, "public", "memories"), exist_ok=True)
    out = os.path.join(ROOT, "public", "memories", f"{fid}.mp4")
    run("export", "--project", proj, "--output", out, "--resolution", "1080p", "--fps", "30")
    run("filmstrip", "--project", proj, "--timestamps-ms", f"300,{D // 3},{2 * D // 3},{D - 300}",
        "--tile-width", "480", "--tile-height", "270", "--output", os.path.join(work, "filmstrip.png"))
    # The game lists which fragments have films.
    index = os.path.join(ROOT, "public", "memories", "index.json")
    ids = set(json.load(open(index))) if os.path.exists(index) else set()
    ids.add(fid)
    json.dump(sorted(ids), open(index, "w"), indent=1)
    print(f"{fid}: {out} ({os.path.getsize(out) // 1024} KB, {D} ms)")


main()
