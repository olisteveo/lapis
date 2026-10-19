"""Extracts the dominant palette from reference paintings via k-means in Lab-ish space.

    tools/audio/.venv/bin/python tools/art/palette.py <img> [<img> ...]
"""
import sys

import numpy as np
from PIL import Image

px = []
for path in sys.argv[1:]:
    im = Image.open(path).convert('RGB').resize((150, 300))
    px.append(np.asarray(im, dtype=np.float32).reshape(-1, 3) / 255)
X = np.concatenate(px)
rng = np.random.default_rng(0)
K = 16
C = X[rng.choice(len(X), K, replace=False)]
for _ in range(40):
    d = ((X[:, None, :] - C[None]) ** 2).sum(-1)
    lab = d.argmin(1)
    C = np.array([X[lab == k].mean(0) if np.any(lab == k) else C[k] for k in range(K)])
counts = np.bincount(lab, minlength=K)
order = np.argsort(C @ np.array([0.299, 0.587, 0.114]))
for k in order:
    r, g, b = (C[k] * 255).round().astype(int)
    print(f"0x{r:02x}{g:02x}{b:02x}  {counts[k] / len(X) * 100:5.1f}%")
