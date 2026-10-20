#!/usr/bin/env python3
"""Generates and edits every memory film that doesn't exist yet, a few at a time.

Usage: python3 tools/memories/make_all.py [id ...]   (no ids: all of tools/memories/memories.json)
Each clip: tools/viggle/video.sh (Viggle H3, 1 credit/second) with the shared style, the scene and
reference frames for consistency, then tools/memories/edit_memory.py (Tesseract) into
public/memories/<id>.mp4. Stops on the first failure, e.g. when the key runs out of credits.
"""
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HERE = os.path.dirname(os.path.abspath(__file__))
spec = json.load(open(os.path.join(HERE, "memories.json")))
want = set(sys.argv[1:])
todo = [m for m in spec["memories"]
        if (not want or m["id"] in want) and not os.path.exists(os.path.join(ROOT, "public", "memories", f"{m['id']}.mp4"))]
print(f"{len(todo)} to make, {sum(m['seconds'] for m in todo)} credits")


def make(m):
    # The day style's light and island win over a night scene, so night scenes lead and use their own.
    prompt = f"{m['scene']} {spec['nightStyle']}" if m.get("night") else f"{spec['style']} {m['scene']}"
    refs = [os.path.join(HERE, r) for r in spec["refsByAge"].get(m["age"], [])]
    gen = subprocess.run([os.path.join(ROOT, "tools", "viggle", "video.sh"), m["id"], str(m["seconds"]), prompt, *refs],
                         capture_output=True, text=True)
    if gen.returncode:
        raise RuntimeError(f"{m['id']}: generation failed: {gen.stderr.strip()}")
    clip = os.path.join(ROOT, "tools", "viggle", "raw", "video", f"{m['id']}.mp4")
    ed = subprocess.run([sys.executable, os.path.join(HERE, "edit_memory.py"), m["id"], clip], capture_output=True, text=True)
    if ed.returncode:
        raise RuntimeError(f"{m['id']}: edit failed: {ed.stderr.strip() or ed.stdout.strip()}")
    return ed.stdout.strip()


with ThreadPoolExecutor(max_workers=3) as pool:
    for result in pool.map(make, todo):
        print(result, flush=True)
