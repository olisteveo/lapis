"""Generates a tileable canvas height texture: woven threads, irregular fibres, dried paint.

    tools/audio/.venv/bin/python tools/art/canvas.py [out.png]
"""
import os
import sys

import numpy as np
from PIL import Image

N = 1024
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'textures', 'canvas.png')
rng = np.random.default_rng(7)


def tile_noise(scale, seed_shift=0):
    """Tileable noise: random spectrum confined to integer frequencies up to `scale`."""
    f = np.fft.fftfreq(N) * N
    fx, fy = np.meshgrid(f, f)
    r = np.sqrt(fx ** 2 + fy ** 2)
    amp = np.where(r > 0, 1 / np.maximum(r, 1) ** 1.2, 0) * (r < scale)
    phase = rng.uniform(0, 2 * np.pi, (N, N))
    img = np.real(np.fft.ifft2(amp * np.exp(1j * phase)))
    return (img - img.mean()) / (img.std() + 1e-9)


y, x = np.mgrid[0:N, 0:N] / N
threads = 160  # threads across the tile
# Warp and weft wobble a little so the weave never looks machine-printed.
wob_x = tile_noise(24) * 0.0015
wob_y = tile_noise(24) * 0.0015
warp = np.sin(2 * np.pi * threads * (x + wob_x)) * 0.5 + 0.5
weft = np.sin(2 * np.pi * threads * (y + wob_y)) * 0.5 + 0.5
over = (np.floor(threads * (x + wob_x)) + np.floor(threads * (y + wob_y))) % 2
weave = np.where(over > 0, warp ** 0.6 * (0.6 + 0.4 * weft), weft ** 0.6 * (0.6 + 0.4 * warp))
fibre = tile_noise(400) * 0.25
paint = tile_noise(40) * 0.35 + tile_noise(12) * 0.25
h = weave * 0.6 + fibre + paint
h = (h - h.min()) / (h.max() - h.min())
os.makedirs(os.path.dirname(OUT), exist_ok=True)
Image.fromarray((h * 255).astype(np.uint8), 'L').save(OUT)
print(f'[lapis] wrote {OUT}')
