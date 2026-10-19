"""Region-specific flora and ruins for Lapis: Lantern Wood, Moonflower Meadows, Glass Dunes, Drowned Town.

Run headless:  blender -b --factory-startup --python tools/blender/biomes.py -- <out_dir>
Writes <out_dir>/biomes.glb (+ export/fbx/biomes.fbx). Same vertex colour convention as build_assets:
  R  gradient root -> tip of the part (sway weight, glow ramp); ruins use height through the object
  G  0 wood / stem / stone, 1 leaf / petal / grass, 0.5 glow / emissive detail
  B  per-part random phase
Flora come as _hi / _lo pairs; ruins are single objects whose bases reach z=-2 (they stand in water).
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_assets as B  # noqa: E402

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

UP = B.UP
TAU = 2 * math.pi


def align(axis):
    return UP.rotation_difference(Vector(axis).normalized()).to_matrix()


def place(mb, start, rot, offset):
    offset = Vector(offset)
    B.xform(mb, start, lambda p: rot @ p + offset)


def subset(seq, k):
    n = len(seq)
    if k >= n:
        return list(seq)
    return [seq[i] for i in sorted({round(i * (n - 1) / (k - 1)) for i in range(k)})]


def mats(*names):
    return [MATS[n]() for n in names]


def _glow(name, rgb, emit, strength=4.0, double_sided=False):
    def make():
        m = B.material(name, rgb, double_sided, emission=emit)
        m.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = strength
        return m
    return make


MATS = {
    "mushroom_stem": lambda: B.material("mushroom_stem", (0.72, 0.7, 0.66)),
    "mushroom_cap": lambda: B.material("mushroom_cap", (0.26, 0.15, 0.36)),
    "mushroom_glow": _glow("mushroom_glow", (0.55, 0.95, 0.9), (0.3, 0.9, 0.85)),
    "bark": lambda: B.material("bark", (0.16, 0.12, 0.1)),
    "foliage": lambda: B.material("foliage", (0.08, 0.16, 0.1), True),
    "lantern_glow": _glow("lantern_glow", (1.0, 0.75, 0.4), (1.0, 0.6, 0.25)),
    "stem": lambda: B.material("stem", (0.2, 0.26, 0.14)),
    "moonflower_glow": _glow("moonflower_glow", (0.92, 0.94, 1.0), (0.75, 0.82, 1.0), double_sided=True),
    "grass": lambda: B.material("grass", (0.3, 0.34, 0.2), True),
    "crystal": _glow("crystal", (0.6, 0.75, 0.95), (0.35, 0.55, 0.95), strength=0.6),
    "ruin_stone": lambda: B.material("ruin_stone", (0.5, 0.5, 0.47)),
}


# ---------------------------------------------------------------- mushrooms

# Cap sections in units of the cap radius, (r, z) about the cap origin. The top shell starts with an
# inturned lip that tucks under the gill sheet's rim so no slit opens between them. under[0].r is replaced
# by the stem radius (the gill sheet starts inside the stem).
CAPS = {
    "flat": dict(top=[(0.86, -0.135), (0.93, -0.16), (1.0, -0.1), (0.99, -0.02), (0.92, 0.07), (0.78, 0.17),
                      (0.58, 0.25), (0.33, 0.31), (0.0, 0.34)],
                 under=[(0.0, -0.03), (0.3, -0.06), (0.55, -0.092), (0.75, -0.112), (0.88, -0.128)], gill=0.03),
    "bell": dict(top=[(0.82, -0.04), (0.9, -0.075), (0.97, -0.01), (0.95, 0.18), (0.84, 0.42), (0.64, 0.66),
                      (0.38, 0.84), (0.16, 0.94), (0.0, 0.97)],
                 under=[(0.0, 0.42), (0.3, 0.33), (0.55, 0.18), (0.72, 0.05), (0.84, -0.03)], gill=0.035),
    "dome": dict(top=[(0.84, -0.06), (0.92, -0.09), (1.0, -0.02), (0.96, 0.12), (0.82, 0.26), (0.6, 0.37),
                      (0.32, 0.43), (0.0, 0.45)],
                 under=[(0.0, 0.05), (0.35, 0.0), (0.62, -0.03), (0.86, -0.05)], gill=0.03),
}


def shroom(mb, rnd, base, H, r0, yaw, lean, R, kind, phase, st=14, seg=10, ts=28, us=56, top_k=None,
           under_k=None, spots=0, skirt=False, tilt=0.5, top_mat=1, fibre=True, bury=0.3, wave=0.0):
    """One mushroom: a leaning S-curved stem, a cap tilted part-way toward the stem's tip direction, a
    corrugated glowing gill sheet underneath and optional glowing spots on top. wave ripples the rim.
    Give each call its own rnd so _hi and _lo draw the same shape."""
    ph = rnd.uniform(0, TAU)
    wph = rnd.uniform(0, TAU)
    d = Vector((math.cos(yaw), math.sin(yaw), 0))
    perp = Vector((-d.y, d.x, 0))
    path, radii = [], []
    for i in range(st + 1):
        t = i / st
        z = -bury + (H + bury) * t
        off = lean * H * t ** 1.6
        wob = 0.05 * H * math.sin(t * 3.6 + ph) * math.sin(math.pi * t)
        path.append(Vector(base) + d * off + perp * wob + UP * z)
        zr = max(z, 0.0)
        # Bulbous volva at the foot, then a slender taper.
        radii.append(r0 * (1 - 0.3 * t) * (1 + 0.9 * math.exp(-zr / (0.05 * H + 0.03))))
    fib = (lambda t, a: 1.0 + 0.035 * math.sin(a * 9 + ph + t * 3)) if fibre else None
    B.ptube(mb, path, radii, segments=seg, mat=0, col_fn=lambda t: (t, 0.0, phase), cap_start=False,
            radial_fn=fib)
    tan = (path[-1] - path[-2]).normalized()
    rot = align(UP.lerp(tan, tilt))
    axis = rot @ UP
    rs = radii[-1]
    cap = CAPS[kind]
    top = [(r * R, z * R) for r, z in cap["top"]]
    under = [(rs * 0.85 if i == 0 else r * R, z * R) for i, (r, z) in enumerate(cap["under"])]
    if top_k:
        top = subset(top, top_k)
    if under_k:
        under = subset(under, under_k)
    rim = lambda r, a: wave * R * B.smoothstep(0.5, 1.0, r / R) * math.sin(5 * a + wph)
    s0 = len(mb.verts)
    gd = cap["gill"] * R
    n_g = us // 2
    nu, nt = len(under), len(top)

    def under_z(t, a):
        r = under[round(t * (nu - 1))][0]
        z = rim(r, a)
        if us >= 24:
            z -= gd * math.sin(math.pi * t) ** 0.7 * (0.5 + 0.5 * math.cos(n_g * a))
        return z

    B.lathe(mb, under, us, 2, col_fn=lambda t: (1.0, 0.5, phase), z_fn=under_z, cap_bottom=False, cap_top=False)
    B.lathe(mb, top, ts, top_mat, col_fn=lambda t: (1.0, 0.5 if top_mat == 2 else 0.0, phase), cap_bottom=False,
            cap_top=False, z_fn=lambda t, a: rim(top[round(t * (nt - 1))][0], a))
    for _ in range(spots):
        j = rnd.randint(3, len(top) - 3)
        u = rnd.random()
        (ra, za), (rb, zb) = top[j], top[j + 1]
        r, z = ra + (rb - ra) * u, za + (zb - za) * u
        nr, nz = zb - za, -(rb - ra)
        ln = math.hypot(nr, nz)
        nr, nz = nr / ln, nz / ln
        a = rnd.uniform(0, TAU)
        n = Vector((nr * math.cos(a), nr * math.sin(a), nz))
        rad = 0.075 * R * rnd.uniform(0.45, 1.0)
        k0 = len(mb.verts)
        B.sphere(mb, (0, 0, 0), rad, u=6, v=4, mat=2, col=(1.0, 0.5, phase), scale=(1, 1, 0.4))
        place(mb, k0, align(n), Vector((r * math.cos(a), r * math.sin(a), z + rim(r, a))) + n * rad * 0.12)
    # Drop the cap so the stem tip sits above the gill sheet's inner ring, sealing the junction.
    place(mb, s0, rot, path[-1] - axis * (under[0][1] + 0.03 * R))
    if skirt:
        i = int(st * 0.86)
        p = path[i]
        tn = (path[i + 1] - path[i - 1]).normalized()
        r = radii[i]
        k0 = len(mb.verts)
        B.lathe(mb, [(r * 0.9, -0.05 * H), (r * 1.7, -0.07 * H), (r * 1.85, -0.06 * H), (r * 1.25, 0.0),
                     (r * 0.9, 0.01 * H)], 16, 0, col_fn=lambda t: (i / st, 0.0, phase), cap_bottom=False,
                cap_top=False, radial_fn=lambda t, a: 1.0 + (0.12 * math.sin(a * 5 + ph) if t < 0.6 else 0.0))
        place(mb, k0, align(tn), p)
    return path[-1]


def base_minis(mb, seed, count, radius, H, hi):
    """Smaller mushrooms around a giant's foot. The plan draws are independent of LOD, so _lo keeps the
    first few of _hi's minis exactly."""
    plan = random.Random(seed)
    for k in range(count):
        a = plan.uniform(0, TAU)
        rr = radius * plan.uniform(0.9, 1.7)
        h = H * plan.uniform(0.05, 0.16)
        kind = plan.choice(("dome", "flat", "bell"))
        lean = plan.uniform(0.05, 0.3)
        kw = dict(st=4, seg=6, ts=12, us=24, top_k=5, under_k=3, fibre=False) if hi else \
            dict(st=1, seg=3, ts=5, us=5, top_k=2, under_k=2, fibre=False)
        shroom(mb, random.Random(seed * 31 + k), (math.cos(a) * rr, math.sin(a) * rr, 0), h, 0.035 * h + 0.012, a,
               lean, 0.3 * h, kind, plan.random(), bury=0.05, **kw)


def build_giant_mushroom(name, seed, lod, variant):
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    big = dict(st=16, seg=10, ts=30, us=60, skirt=True) if hi else dict(st=4, seg=6, ts=10, us=10, top_k=4, under_k=3,
                                                                        fibre=False)
    if variant == "A":
        shroom(mb, random.Random(seed + 1), (0, 0, 0), 12.0, 0.34, rnd.uniform(0, TAU), 0.16, 4.6, "flat",
               rnd.random(), spots=18 if hi else 0, wave=0.05, **big)
        base_minis(mb, seed + 2, 5 if hi else 2, 0.9, 12.0, hi)
    else:
        yaw = rnd.uniform(0, TAU)
        shroom(mb, random.Random(seed + 1), (0, 0, 0), 8.0, 0.28, yaw, 0.2, 3.0, "bell", rnd.random(),
               spots=12 if hi else 0, tilt=0.4, wave=0.03, **big)
        small = dict(big, skirt=False, ts=24 if hi else 8, us=48 if hi else 8)
        shroom(mb, random.Random(seed + 3), (0.35 * math.cos(yaw + 2.6), 0.35 * math.sin(yaw + 2.6), 0), 5.2, 0.2,
               yaw + 2.4, 0.3, 2.2, "dome", rnd.random(), spots=7 if hi else 0, tilt=0.6, wave=0.04, **small)
        base_minis(mb, seed + 2, 4 if hi else 2, 0.75, 8.0, hi)
    return mb.build(name, mats("mushroom_stem", "mushroom_cap", "mushroom_glow"), smooth=True)


def build_mushroom_cluster(name, seed, lod):
    plan = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    n = 7
    specs = []
    for k in range(n):
        a = k * B.GOLDEN * 1.7 + plan.uniform(-0.3, 0.3)
        rr = 0.03 + 0.17 * math.sqrt((k + 0.5) / n)
        # Tallest in the middle so the clump reads as a mound, not a row.
        h = (0.45 - 0.3 * rr / 0.2) * plan.uniform(0.8, 1.15)
        specs.append((k, a, rr, h, plan.uniform(0.05, 0.22), plan.uniform(0.22, 0.32) * h + 0.02,
                      plan.choice(("dome", "bell", "flat")), plan.random()))
    if not hi:
        specs = sorted(specs, key=lambda s: -s[3])[:4]
    for k, a, rr, h, lean, R, kind, phase in specs:
        kw = dict(st=3, seg=5, ts=8, us=8, top_k=4, under_k=2, fibre=False) if hi else \
            dict(st=1, seg=3, ts=5, us=5, top_k=2, under_k=2, fibre=False)
        shroom(mb, random.Random(seed * 17 + k), (math.cos(a) * rr, math.sin(a) * rr, 0), h, 0.04 * h + 0.008, a,
               lean, R, kind, phase, top_mat=2 if h < 0.25 else 1, bury=0.03, **kw)
    return mb.build(name, mats("mushroom_stem", "mushroom_cap", "mushroom_glow"), smooth=True)


MeshBuilder = B.MeshBuilder


# ---------------------------------------------------------------- lantern tree

def plan_lantern_tree(seed, H, n_lanterns):
    """Gnarled, crooked tree: short twisting bole that forks low into wandering limbs; lanterns hang from
    the outer branches. Shared by _hi and _lo so both keep one silhouette."""
    rnd = random.Random(seed)
    k = H / 10.0
    bole = H * 0.4
    ph1, ph2 = rnd.uniform(0, TAU), rnd.uniform(0, TAU)
    trunk, radii = [], []
    rings = 16
    for i in range(rings + 1):
        t = i / rings
        z = -0.4 + (bole + 0.4) * t
        zt = max(z, 0.0) / bole
        x = 0.8 * k * math.sin(zt * 3.6 + ph1) * zt
        y = 0.8 * k * math.sin(zt * 3.0 + ph2) * zt
        trunk.append(Vector((x, y, z)))
        radii.append(0.42 * k * (1 - 0.35 * zt) * (1 + 0.9 * math.exp(-max(z, 0.0) / (0.45 * k))))

    boughs, tips, cands = [], [], []

    def sample(path, rads, t):
        f = t * (len(path) - 1)
        i = min(int(f), len(path) - 2)
        u = f - i
        return path[i].lerp(path[i + 1], u), rads[i] + (rads[i + 1] - rads[i]) * u

    def grow(start, yaw, e0, e1, L, r0, depth):
        st = (8, 5, 4)[depth]
        path = B.bend_spine(start, yaw, e0, e1, L, st, power=0.9, wander=0.4, rnd=rnd)
        # Crooked elbows: knock each joint sideways so limbs zig-zag like an old hawthorn.
        for i in range(2, len(path)):
            path[i] = path[i] + Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.6, 0.6))) * 0.06 * L
        rads = [r0 * (1 - 0.62 * i / st) for i in range(st + 1)]
        boughs.append((path, rads, depth))
        if depth < 2:
            kids = rnd.randint(2, 3) if depth == 0 else 2
            for c in range(kids):
                t = rnd.uniform(0.45, 0.9)
                p, r = sample(path, rads, t)
                sgn = 1 if c % 2 else -1
                grow(p, yaw + sgn * rnd.uniform(0.5, 1.2), math.radians(rnd.uniform(15, 45)),
                     math.radians(rnd.uniform(-20, 15)), L * rnd.uniform(0.5, 0.65), r * 0.78, depth + 1)
        if depth >= 1:
            tips.append((path[-1], yaw, depth))
            for t in (0.4, 0.7, 0.95):
                p, r = sample(path, rads, t)
                cands.append(p - UP * r)

    yaw0 = rnd.uniform(0, TAU)
    n_limbs = 4
    for li in range(n_limbs):
        t = 1.0 if li == 0 else rnd.uniform(0.72, 0.92)
        p, r = sample(trunk, radii, t)
        yaw = yaw0 + TAU * li / n_limbs + rnd.uniform(-0.3, 0.3)
        e0 = math.radians(78 if li == 0 else rnd.uniform(45, 62))
        e1 = math.radians(40 if li == 0 else rnd.uniform(5, 25))
        grow(p, yaw, e0, e1, H * rnd.uniform(0.42, 0.52), r * (1.0 if li == 0 else 0.62), 0)

    roots = []
    for j in range(5):
        a = yaw0 + TAU * j / 5 + rnd.uniform(-0.3, 0.3)
        d = Vector((math.cos(a), math.sin(a), 0))
        reach = rnd.uniform(1.4, 2.3) * k
        path = [trunk[0] * 0 + d * (0.2 * k) + UP * (0.7 * k)]
        for i in range(1, 6):
            u = i / 5
            a += rnd.uniform(-0.25, 0.25)
            path.append(Vector((math.cos(a), math.sin(a), 0)) * (0.2 * k + reach * u) +
                        UP * (0.7 * k * (1 - u) ** 2 - 0.12 * u))
        roots.append(path)

    hangs = []
    rnd.shuffle(cands)
    for c in cands:
        if len(hangs) >= n_lanterns:
            break
        if all((c - h[0]).length > 1.0 for h in hangs):
            L = rnd.uniform(0.3, 1.6)
            s = rnd.uniform(0.14, 0.22) * k
            if c.z - L - 2.2 * s > 1.8:
                hangs.append((c, L, s, rnd.random()))
    return dict(trunk=(trunk, radii), boughs=boughs, tips=tips, hangs=hangs, roots=roots, k=k)


def build_lantern_tree(name, plan, seed, lod):
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    k = plan["k"]
    trunk, radii = plan["trunk"]
    ph = rnd.uniform(0, TAU)
    # Spiral fluting reads as a twisted, wrung-out trunk.
    twist = lambda t, a: 1.0 + 0.11 * math.sin(3 * a + t * 7 + ph) + 0.04 * math.sin(7 * a - t * 11)
    if hi:
        B.ptube(mb, trunk, radii, segments=12, mat=0, col_fn=lambda t: (t * 0.3, 0.0, 0.0), radial_fn=twist)
        for path in plan["roots"]:
            B.ptube(mb, path, [0.2 * k * (1 - 0.75 * i / 5) + 0.03 for i in range(6)], segments=5, mat=0,
                    col_fn=lambda t: (0.0, 0.0, 0.0))
    else:
        idx = subset(list(range(len(trunk))), 8)
        B.ptube(mb, [trunk[i] for i in idx], [radii[i] for i in idx], segments=6, mat=0,
                col_fn=lambda t: (t * 0.3, 0.0, 0.0))
    for path, rads, depth in plan["boughs"]:
        r0 = 0.3 + 0.35 * depth
        cf = lambda t, r0=r0: (min(1.0, r0 + 0.35 * t), 0.0, 0.0)
        if hi:
            B.ptube(mb, path, rads, segments=(8, 4, 3)[depth], mat=0, col_fn=cf,
                    radial_fn=twist if depth == 0 else None)
        elif depth < 2:
            sub = subset(list(range(len(path))), 4 if depth == 0 else 2)
            B.ptube(mb, [path[i] for i in sub], [rads[i] for i in sub], segments=4 if depth == 0 else 3, mat=0,
                    col_fn=cf)
    for pos, yaw, depth in plan["tips"]:
        phase = rnd.random()
        if hi:
            if depth == 1 and rnd.random() < 0.5:
                continue
            B.leaf_spray(mb, pos + UP * 0.05, yaw + rnd.uniform(-0.4, 0.4), 0.8 * k * rnd.uniform(0.85, 1.15), 5,
                         rnd, phase, 1)
        elif depth == 2:
            B.umbrella(mb, pos + UP * 0.3 * k, 0.95 * k, 0.4 * k, rnd, rim=7, mat=1, col=(1.0, 1.0, phase),
                       star=True)
    for anchor, L, s, phase in plan["hangs"]:
        end = anchor - UP * L
        if hi:
            mid = anchor.lerp(end, 0.5) + Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), 0)) * 0.03
            B.ptube(mb, [anchor + UP * 0.05, mid, end], [0.012, 0.01, 0.009], segments=3, mat=0,
                    col_fn=lambda t: (0.85 + 0.15 * t, 0.0, phase), cap_end=False)
            prof = [(0.0, -2.2 * s), (0.5 * s, -2.0 * s), (0.9 * s, -1.5 * s), (s, -1.0 * s), (0.75 * s, -0.45 * s),
                    (0.25 * s, -0.08 * s), (0.0, 0.0)]
            # Physalis-style ribbed husk: 3 lobes on 6 sides.
            B.lathe(mb, prof, 6, 2, center=end, col_fn=lambda t: (1.0 - 0.2 * t, 0.5, phase),
                    radial_fn=lambda t, a, rot=phase * TAU: 1.0 + 0.18 * math.cos(3 * (a - rot)), rot=phase * TAU)
        else:
            B.lathe(mb, [(0.0, -2.2 * s), (s * 1.1, -1.1 * s), (0.0, 0.0)], 4, 2, center=end,
                    col_fn=lambda t: (1.0 - 0.2 * t, 0.5, phase), rot=phase * TAU)
    return mb.build(name, mats("bark", "foliage", "lantern_glow"), smooth=True)


# ---------------------------------------------------------------- moonflowers

def moon_petal(mb, rnd, n_pet, j, L, W, phase, cup, rows_u):
    """Petal in the flower's local frame (axis +Z): rises steeply and curls in at the edges to form a cup."""
    phi = TAU * j / n_pet + rnd.uniform(-0.15, 0.15)
    d = Vector((math.cos(phi), math.sin(phi), 0))
    td = Vector((-d.y, d.x, 0))
    rows = []
    p = d * 0.008
    prev = 0.0
    for u in rows_u:
        e = math.radians(28 + 52 * u)
        p = p + (d * math.cos(e) + UP * math.sin(e)) * (L * (u - prev))
        prev = u
        w = W * math.sin(math.pi * (0.18 + 0.82 * u)) ** 0.7 if u < 1 else 0.0
        col = (0.85 + 0.15 * u, 0.5, phase)
        if w < 1e-4:
            rows.append([mb.v(p, col)])
        else:
            rows.append([mb.v(p + td * (kk * w) - d * (cup * w * kk * kk), col) for kk in (-1, 0, 1)])
    B.loft(mb, rows, 2)


def build_moonflowers(name, seed, lod):
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    n = 9
    yaw0 = rnd.uniform(0, TAU)
    for k in range(n):
        yaw = yaw0 + k * B.GOLDEN + rnd.uniform(-0.2, 0.2)
        rr = 0.05 + 0.18 * math.sqrt(rnd.random())
        base = Vector((math.cos(yaw) * rr, math.sin(yaw) * rr, -0.02))
        L = rnd.uniform(0.62, 1.22)
        phase = rnd.random()
        bud = k >= n - 2
        # Stems lean out of the clump then straighten so the cups face the sky.
        spine = B.bend_spine(base, yaw, math.radians(rnd.uniform(66, 80)), math.radians(rnd.uniform(84, 92)), L,
                             5 if hi else 1, power=0.8, wander=0.1 if hi else 0.0, rnd=rnd)
        tip = spine[-1]
        tan = (spine[-1] - spine[-2]).normalized()
        cf = lambda t, phase=phase: (0.85 * t, 0.0, phase)
        if hi:
            B.ptube(mb, spine, [0.011 - 0.004 * i / 5 for i in range(6)], segments=3, mat=0, col_fn=cf,
                    cap_end=False)
        else:
            B.ptube(mb, spine, [0.012, 0.008], segments=3, mat=0, col_fn=cf, cap_end=False)
        rot = align(UP.lerp(tan, 0.4))
        s0 = len(mb.verts)
        if bud:
            if hi:
                B.sphere(mb, (0, 0, 0.03), 0.028, u=5, v=4, mat=2, col=(0.95, 0.5, phase), scale=(1, 1, 1.7))
            else:
                B.lathe(mb, [(0, 0), (0.03, 0.03), (0, 0.08)], 3, 2, col_fn=lambda t: (0.95, 0.5, phase))
        elif hi:
            Lp, Wp = rnd.uniform(0.1, 0.14), rnd.uniform(0.035, 0.045)
            for j in range(5):
                moon_petal(mb, rnd, 5, j, Lp, Wp, phase, 0.5, (0.0, 0.4, 0.75, 1.0))
            B.sphere(mb, (0, 0, 0.02), 0.016, u=4, v=3, mat=2, col=(1.0, 0.5, phase))
        else:
            Lp = rnd.uniform(0.1, 0.14)
            c = mb.v((0, 0, 0), (0.85, 0.5, phase))
            ring = [mb.v((math.cos(a) * Lp * 0.75, math.sin(a) * Lp * 0.75, Lp * 0.7), (1.0, 0.5, phase))
                    for a in (TAU * i / 5 for i in range(5))]
            for i in range(5):
                mb.f((c, ring[i], ring[(i + 1) % 5]), 2)
        place(mb, s0, rot, tip)
    for k in range(7 if hi else 3):
        yaw = yaw0 + 0.6 + k * TAU / (7 if hi else 3) + rnd.uniform(-0.3, 0.3)
        L = rnd.uniform(0.28, 0.45)
        phase = rnd.random()
        spine = B.bend_spine(Vector((math.cos(yaw) * 0.05, math.sin(yaw) * 0.05, 0)), yaw, math.radians(70),
                             math.radians(rnd.uniform(-25, 5)), L, 3 if hi else 2, power=1.3)
        W = 0.028
        widths = [W * 0.6, W, W * 0.6, 0.0] if hi else [W, W * 0.7, 0.0]
        B.leaf_blade(mb, spine, widths, yaw, 0.2, 1, lambda t, phase=phase: (t * 0.6, 1.0, phase),
                     cols=(-1, 0, 1) if hi else (-1, 1))
    return mb.build(name, mats("stem", "foliage", "moonflower_glow"), smooth=hi)


# ---------------------------------------------------------------- grasses

def build_meadow_grass(name, seed, lod):
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    n = 40 if hi else 16
    st = 5 if hi else 3
    for k in range(n):
        yaw = rnd.uniform(0, TAU)
        rr = 0.07 * math.sqrt(rnd.random())
        base = Vector((math.cos(yaw) * rr, math.sin(yaw) * rr, -0.02))
        L = rnd.uniform(0.65, 1.35)
        # Longer blades arch further over; short ones stay upright.
        arch = (L - 0.65) / 0.7
        spine = B.bend_spine(base, yaw + rnd.uniform(-0.4, 0.4), math.radians(rnd.uniform(74, 88)),
                             math.radians(rnd.uniform(30, 60) - 55 * arch), L, st, power=1.6)
        W = rnd.uniform(0.012, 0.02)
        widths = [W * (1 - (i / st)) ** 0.7 for i in range(st + 1)]
        phase = rnd.random()
        B.leaf_blade(mb, spine, widths, yaw, 0.0, 0, lambda t, phase=phase: (t, 1.0, phase),
                     roll=rnd.uniform(-0.7, 0.7), cols=(-1, 1))
    return mb.build(name, mats("grass"), smooth=hi)


def build_dune_grass(name, seed, lod):
    """Marram: stiff, in-rolled, needle-tipped blades fanning from a sparse tuft, a few dead ones flopped over."""
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    n = 26 if hi else 13
    st = 4 if hi else 2
    for k in range(n):
        yaw = rnd.uniform(0, TAU)
        rr = 0.1 * math.sqrt(rnd.random())
        base = Vector((math.cos(yaw) * rr, math.sin(yaw) * rr, -0.03))
        dead = k % 7 == 6
        if dead:
            L = rnd.uniform(0.35, 0.55)
            e0, e1 = math.radians(rnd.uniform(35, 50)), math.radians(rnd.uniform(-35, -15))
        else:
            L = rnd.uniform(0.5, 0.95)
            e0 = math.radians(rnd.uniform(62, 88))
            e1 = e0 - math.radians(rnd.uniform(4, 22))
        spine = B.bend_spine(base, yaw, e0, e1, L, st, power=1.3)
        W = rnd.uniform(0.007, 0.011)
        widths = [W * (1 - i / st) for i in range(st + 1)]
        phase = rnd.random()
        B.leaf_blade(mb, spine, widths, yaw, 0.0, 0, lambda t, phase=phase: (t, 1.0, phase),
                     roll=rnd.uniform(0.5, 1.2) * rnd.choice((-1, 1)), cols=(-1, 1))
    if hi:
        for k in range(2):
            yaw = rnd.uniform(0, TAU)
            L = rnd.uniform(0.75, 0.95)
            spine = B.bend_spine(Vector((math.cos(yaw) * 0.04, math.sin(yaw) * 0.04, 0)), yaw, math.radians(84),
                                 math.radians(76), L, 5, power=1.0)
            # Seed head: the last stretch of the stalk swells into a tight spike.
            widths = [0.005, 0.004, 0.004, 0.014, 0.016, 0.0]
            phase = rnd.random()
            for roll in (0.0, math.pi / 2):
                B.leaf_blade(mb, spine, widths, yaw, 0.0, 0, lambda t, phase=phase: (t, 1.0, phase), roll=roll,
                             cols=(-1, 1))
    return mb.build(name, mats("grass"), smooth=hi)


# ---------------------------------------------------------------- crystals

def shard(mb, rnd, base, direction, L, r, bury, hi, phase):
    """Hexagonal prism with a two-step faceted point, built along +Z then tilted; base sunk below ground."""
    if hi:
        prof = [(r, -bury), (r * 0.95, L * 0.45), (r * 0.86, L * 0.74), (r * 0.42, L * 0.9), (0.0, L)]
    else:
        prof = [(r, -bury), (r * 0.86, L * 0.74), (0.0, L)]
    rot = rnd.uniform(0, TAU)
    wf = [rnd.uniform(0.78, 1.22) for _ in range(6)]
    # Per-side widths constant along the length keep each facet planar: an irregular hexagon, not noise.
    rf = lambda t, a: wf[round((a - rot) / (TAU / 6)) % 6]
    n = len(prof)
    k0 = len(mb.verts)
    B.lathe(mb, prof, 6, 0, rot=rot, radial_fn=rf, cap_bottom=False,
            col_fn=lambda t: (max(0.0, prof[round(t * (n - 1))][1]) / L, 0.5, phase))
    place(mb, k0, align(direction), base)


def crystal_cluster(mb, rnd, specs, hi):
    for (x, y, z), yaw, tilt, L, small in specs:
        if small and not hi:
            continue
        r = L * rnd.uniform(0.12, 0.17)
        d = Vector((math.cos(yaw) * math.sin(tilt), math.sin(yaw) * math.sin(tilt), math.cos(tilt)))
        bury = max(0.25, r * math.tan(min(tilt, 1.3)) * 1.4 + 0.15)
        shard(mb, rnd, Vector((x, y, z)), d, L, r, bury, hi and not small, rnd.random())


def crystal_specs(seed, n, Lmax, Lmin, spread, tilt_range, small_n, central=True):
    rnd = random.Random(seed)
    out = []
    if central:
        out.append(((0, 0, -0.1), rnd.uniform(0, TAU), math.radians(rnd.uniform(4, 12)), Lmax, False))
    for i in range(n - (1 if central else 0)):
        a = i * B.GOLDEN * 2.3 + rnd.uniform(-0.3, 0.3)
        rr = spread * rnd.uniform(0.35, 1.0)
        L = rnd.uniform(Lmin, Lmax * 0.75)
        out.append(((math.cos(a) * rr, math.sin(a) * rr, -0.1), a + rnd.uniform(-0.4, 0.4),
                    math.radians(rnd.uniform(*tilt_range)), L, False))
    for i in range(small_n):
        a = rnd.uniform(0, TAU)
        rr = spread * rnd.uniform(0.9, 1.6)
        out.append(((math.cos(a) * rr, math.sin(a) * rr, -0.05), a, math.radians(rnd.uniform(35, 65)),
                    rnd.uniform(0.25, 0.45), True))
    return out


def build_crystals(name, specs, seed, lod):
    rnd = random.Random(seed)
    mb = MeshBuilder()
    crystal_cluster(mb, rnd, specs, lod == "hi")
    return mb.build(name, mats("crystal"), smooth=False)


# ---------------------------------------------------------------- ruins

FACES = ((0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5))


def hexa(mb, corners, col):
    """Eight corners in obox order (x fastest, then y, then z; x cross y = z) -> six outward quads."""
    vs = [mb.v(c, col) for c in corners]
    for f in FACES:
        mb.f([vs[i] for i in f], 0)


def stone(mb, rnd, c, ax, ay, hx, hy, hz, jit=0.03, gap=0.018):
    """Masonry block: an oriented box shrunk by a joint gap with every corner nudged off true."""
    ax = Vector(ax).normalized()
    ay = Vector(ay)
    ay = (ay - ax * ay.dot(ax)).normalized()
    az = ax.cross(ay)
    c = Vector(c)
    hx, hy, hz = max(hx - gap, 0.01), max(hy - gap, 0.01), max(hz - gap, 0.01)
    corners = [c + ax * (sx * hx) + ay * (sy * hy) + az * (sz * hz) +
               Vector((rnd.uniform(-jit, jit), rnd.uniform(-jit, jit), rnd.uniform(-jit, jit)))
               for sz in (-1, 1) for sy in (-1, 1) for sx in (-1, 1)]
    hexa(mb, corners, (0.0, 0.0, rnd.random()))


def box(mb, rnd, x0, x1, y0, y1, z0, z1, **kw):
    stone(mb, rnd, ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (1, 0, 0), (0, 1, 0),
          (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, **kw)


def tumbled(mb, rnd, c, h, tilt=0.5):
    """A fallen block lying askew, half sunk."""
    rot = Matrix.Rotation(rnd.uniform(0, TAU), 3, "Z") @ Matrix.Rotation(rnd.uniform(-tilt, tilt), 3, "X")
    stone(mb, rnd, c, rot @ Vector((1, 0, 0)), rot @ Vector((0, 1, 0)), *h, jit=0.05)


BEVEL = [("BEVEL", {"width": 0.035, "segments": 1, "limit_method": "ANGLE"})]


def finish_ruin(mb, name, top):
    B.ramp_r(mb, 0, -2.0, top)
    return mb.build(name, mats("ruin_stone"), smooth=False, modifiers=BEVEL)


def build_ruin_arch():
    """Freestanding arch, span along X, 1 m deep in Y: block piers, 13 voussoirs (one lost), spandrel fill and
    cornice surviving on the -X side only."""
    rnd = random.Random(901)
    mb = MeshBuilder()
    ri, ro, spring, D = 2.5, 3.25, 2.6, 0.5
    pw = 0.95
    for side in (-1, 1):
        xi, xo = side * ri, side * (ri + pw)
        x0, x1 = min(xi, xo), max(xi, xo)
        box(mb, rnd, x0 - 0.15, x1 + 0.15, -D - 0.15, D + 0.15, -2.0, -0.7)
        z = -0.7
        course = 0
        while z < spring - 0.3 - 0.25:
            h = rnd.uniform(0.42, 0.55)
            if spring - 0.3 - (z + h) < 0.25:
                h = spring - 0.3 - z
            if course % 2:
                box(mb, rnd, x0, x1, -D, D, z, z + h)
            else:
                xm = (x0 + x1) / 2 + rnd.uniform(-0.12, 0.12)
                for a, b in ((x0, xm), (xm, x1)):
                    if side > 0 and course == 4 and a == x0:
                        continue  # a lost block, leaving a notch in the pier face
                    box(mb, rnd, a, b, -D, D, z, z + h)
            z += h
            course += 1
        box(mb, rnd, x0 - 0.1, x1 + 0.1, -D - 0.08, D + 0.08, z, spring)
    n = 13
    da = math.pi / n
    for i in range(n):
        if i == 2:
            continue
        a0, a1 = i * da + 0.006, (i + 1) * da - 0.006
        ro_i = ro * (1.1 if i == n // 2 else 1.0) - (0.25 if i == 3 else 0.0)
        dd = D * (1.08 if i == n // 2 else 1.0)
        corners = []
        for sz in (-1, 1):
            for r in (ri, ro_i):
                for a in (a0, a1):
                    j = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))) * 0.025
                    corners.append(Vector((math.cos(a) * r, sz * dd, spring + math.sin(a) * r)) + j)
        hexa(mb, corners, (0.0, 0.0, rnd.random()))
    top = spring + ro + 0.05
    z = spring
    while z < top - 0.1:
        h = min(rnd.uniform(0.4, 0.5), top - z)
        dz = z - spring
        xe = -math.sqrt(max(ro * ro - dz * dz, 0.0)) - 0.03
        x = -(ri + pw)
        while x < xe - 0.2:
            w = min(rnd.uniform(0.6, 1.1), xe - x)
            box(mb, rnd, x, x + w, -D + 0.04, D - 0.04, z, z + h)
            x += w
        z += h
    for x0, x1 in ((-3.65, -2.3), (-2.3, -0.9)):
        box(mb, rnd, x0, x1, -D - 0.12, D + 0.12, top, top + 0.32)
    # Only two courses of fill survive on the +X side.
    z = spring
    for c in range(2):
        h = 0.45
        dz = z + h - spring
        xe = math.sqrt(ro * ro - dz * dz) + 0.03
        box(mb, rnd, xe, ri + pw, -D + 0.04, D - 0.04, z, z + h)
        z += h
    for c, h in (((1.3, 1.5, -0.15), (0.45, 0.3, 0.25)), ((2.2, -1.4, -0.25), (0.5, 0.35, 0.3)),
                 ((-1.1, 1.8, -0.3), (0.55, 0.4, 0.28))):
        tumbled(mb, rnd, c, h)
    return finish_ruin(mb, "RuinArch", top + 0.32)


FLUTES = 20


def column_base(mb, rnd):
    box(mb, rnd, -0.85, 0.85, -0.85, 0.85, -2.0, -0.2)
    box(mb, rnd, -0.72, 0.72, -0.72, 0.72, -0.2, 0.22)
    B.lathe(mb, [(0.6, 0.2), (0.63, 0.27), (0.59, 0.34), (0.5, 0.38), (0.52, 0.43), (0.47, 0.48), (0.0, 0.48)], 24,
            col_fn=lambda t: (0, 0, 0.3), radial_fn=lambda t, a: 1.0 + rnd.uniform(-0.015, 0.015))


def shaft_r(z):
    return 0.46 - 0.08 * max(0.0, (z - 0.48) / 5.6) ** 1.3


def flute_fn(rnd, rot, chip=None):
    step = TAU / (2 * FLUTES)

    def f(t, a):
        k = 1.0 if round((a - rot) / step) % 2 == 0 else 0.92
        if chip and abs(((a - chip[0] + math.pi) % TAU) - math.pi) < chip[1] and chip[2] <= t <= chip[3]:
            k *= 0.82
        return k * (1.0 + rnd.uniform(-0.01, 0.01))
    return f


def drum(mb, rnd, z0, z1, chip=None, top_fn=None, center=(0, 0, 0)):
    rot = rnd.uniform(-0.05, 0.05)
    g = 0.012
    prof = [(shaft_r(z0), z0 + g), (shaft_r((z0 + z1) / 2), (z0 + z1) / 2), (shaft_r(z1), z1 - g), (0.0, z1 - g)]
    c = Vector(center) + Vector((rnd.uniform(-0.012, 0.012), rnd.uniform(-0.012, 0.012), 0))
    B.lathe(mb, prof, 2 * FLUTES, rot=rot, center=c, col_fn=lambda t: (0, 0, rnd.random()),
            radial_fn=flute_fn(rnd, rot, chip), z_fn=top_fn)


def build_ruin_column():
    rnd = random.Random(911)
    mb = MeshBuilder()
    column_base(mb, rnd)
    zs = [0.48, 1.45, 2.4, 3.3, 4.25, 5.15, 6.05]
    for i, (z0, z1) in enumerate(zip(zs, zs[1:])):
        drum(mb, rnd, z0, z1, chip=(1.2, 0.5, 0.0, 0.7) if i == 3 else None)
    B.lathe(mb, [(0.39, 6.04), (0.44, 6.1), (0.58, 6.28), (0.63, 6.36), (0.0, 6.36)], 24,
            col_fn=lambda t: (0, 0, 0.6), radial_fn=lambda t, a: 1.0 + rnd.uniform(-0.02, 0.02))
    box(mb, rnd, -0.68, 0.68, -0.68, 0.68, 6.36, 6.62)
    # A stub of fallen architrave still resting on the capital, skewed off its seat.
    stone(mb, rnd, (0.25, 0.05, 6.86), (math.cos(0.18), math.sin(0.18), 0), (0, 1, 0), 0.95, 0.42, 0.24, jit=0.04)
    return finish_ruin(mb, "RuinColumn", 7.1)


def build_ruin_column_broken():
    rnd = random.Random(921)
    mb = MeshBuilder()
    column_base(mb, rnd)
    drum(mb, rnd, 0.48, 1.45)
    drum(mb, rnd, 1.45, 2.4, chip=(4.0, 0.6, 0.3, 1.0))
    ph = rnd.uniform(0, TAU)
    z0, z1 = 2.4, 2.95
    # Snapped drum: a sloping, ragged fracture that dips into a crater in the middle.
    frac = lambda a: 0.2 * math.sin(a + ph) + 0.06 * math.sin(3 * a + 2 * ph) + 0.025 * math.sin(7 * a)
    jag = lambda t, a: 0.0 if t < 0.2 else frac(a) * (1.0 if t < 0.5 else 0.5)
    rot = rnd.uniform(-0.05, 0.05)
    B.lathe(mb, [(shaft_r(z0), z0 + 0.012), (shaft_r(z1), z1), (shaft_r(z1) * 0.55, z1 - 0.02), (0.0, z1 - 0.12)],
            2 * FLUTES, rot=rot, col_fn=lambda t: (0, 0, 0.8), z_fn=jag,
            radial_fn=lambda t, a: flute_fn(rnd, rot)(t, a) if t < 0.5 else 1.0 + 0.1 * math.sin(2 * a + ph))
    k0 = len(mb.verts)
    B.lathe(mb, [(shaft_r(3.3), -0.45), (shaft_r(3.3), 0.0), (shaft_r(4.2), 0.45), (0.0, 0.45)], 2 * FLUTES,
            col_fn=lambda t: (0, 0, 0.45), radial_fn=flute_fn(rnd, 0.0, (2.0, 0.7, 0.0, 1.0)), cap_bottom=True)
    place(mb, k0, Matrix.Rotation(0.4, 3, "Z") @ Matrix.Rotation(math.radians(88), 3, "X"), (1.55, 0.55, 0.22))
    k0 = len(mb.verts)
    B.lathe(mb, [(0.39, -0.3), (0.44, -0.24), (0.58, -0.06), (0.63, 0.02), (0.0, 0.02)], 24,
            col_fn=lambda t: (0, 0, 0.7))
    box(mb, rnd, -0.68, 0.68, -0.68, 0.68, 0.02, 0.28)
    place(mb, k0, Matrix.Rotation(0.9, 3, "Z") @ Matrix.Rotation(math.radians(-32), 3, "Y"), (-1.35, 1.25, -0.15))
    return finish_ruin(mb, "RuinColumnBroken", 3.0)


def build_ruin_wall():
    """8 m wall along X, 0.8 m thick, coursed blocks with a ragged top (tall at -X) and a lintelled window."""
    rnd = random.Random(931)
    mb = MeshBuilder()
    X0, X1, T = -4.0, 4.0, 0.4
    wx0, wx1, sill, head = -1.25, 0.05, 1.7, 3.3
    ph = rnd.uniform(0, TAU)

    def h(x):
        u = (x - X0) / (X1 - X0)
        return 5.0 - 3.0 * smooth(0.45, 1.0, u) + 0.35 * math.sin(x * 2.3 + ph) - 0.9 * smooth(0.82, 0.95, u)

    smooth = B.smoothstep
    box(mb, rnd, X0 - 0.15, X1 + 0.15, -T - 0.15, T + 0.15, -2.0, -1.4)
    breaks = [-1.4]
    while breaks[-1] < 5.2:
        breaks.append(breaks[-1] + rnd.uniform(0.4, 0.5))
    # Force joints at the sill and head lines, dropping any neighbouring joint that would leave a sliver.
    breaks = sorted([b for b in breaks if min(abs(b - sill), abs(b - head)) > 0.22] + [sill, head])
    course = 0
    for z, z1 in zip(breaks, breaks[1:]):
        ch = z1 - z
        spans = [(X0, X1)]
        if z >= sill - 1e-3 and z + ch <= head + 1e-3:
            spans = [(X0, wx0), (wx1, X1)]
        for a, b in spans:
            x = a + (rnd.uniform(0.2, 0.5) if course % 2 and a == X0 else 0.0)
            if x > a:
                if z + ch < h(a) + rnd.uniform(-0.2, 0.2):
                    box(mb, rnd, a, x, -T, T, z, z + ch)
            while x < b - 0.05:
                w = min(rnd.uniform(0.6, 1.2), b - x)
                if b - (x + w) < 0.25:
                    w = b - x
                xc = x + w / 2
                lintel = z + 1e-3 >= head and z < head + 0.45 and x < wx1 + 0.3 and x + w > wx0 - 0.3
                gone = z > 0.5 and rnd.random() < 0.04
                if z + ch < h(xc) + rnd.uniform(-0.25, 0.25) and not lintel and not gone:
                    box(mb, rnd, x, x + w, -T + rnd.uniform(-0.03, 0.03), T + rnd.uniform(-0.03, 0.03), z, z + ch)
                x += w
        if abs(z - head) < 1e-3:
            box(mb, rnd, wx0 - 0.35, wx1 + 0.35, -T - 0.02, T + 0.02, head, head + 0.45)
        if abs(z + ch - sill) < 1e-3:
            box(mb, rnd, wx0 - 0.08, wx1 + 0.08, -T - 0.1, T + 0.1, sill - 0.14, sill + 0.04)
        course += 1
    for c, hh in (((2.6, 1.0, -0.1), (0.45, 0.3, 0.22)), ((3.3, -1.1, -0.2), (0.5, 0.35, 0.25)),
                  ((1.7, 1.5, -0.25), (0.4, 0.3, 0.22)), ((-2.6, -1.2, -0.25), (0.45, 0.3, 0.22))):
        tumbled(mb, rnd, c, hh)
    return finish_ruin(mb, "RuinWall", 5.3)


def build_ruin_steps():
    """Landing at the origin (top +0.6) with eight steps descending along +X under the water to below -1.5,
    between cheek walls; the +Y cheek has crumbled away after the third step."""
    rnd = random.Random(941)
    mb = MeshBuilder()
    Wh = 1.4
    top0, rise, run, n = 0.6, 0.26, 0.42, 8
    for y0, y1 in ((-Wh, -0.2), (-0.2, Wh)):
        box(mb, rnd, -1.6, -0.55, y0, y1, -2.0, top0)
        box(mb, rnd, -0.55, 0.0, y0, y1, -2.0, top0)
    for i in range(n):
        x0 = i * run
        zt = top0 - rise * (i + 1)
        cuts = sorted([-Wh, Wh] + [rnd.uniform(-0.8, -0.2), rnd.uniform(0.3, 0.9)][: 1 + i % 2])
        for a, b in zip(cuts, cuts[1:]):
            # Lower treads have settled: tilted and sunk a little more the deeper they go.
            sink = rnd.uniform(0, 0.06) * (1 + i * 0.4)
            box(mb, rnd, x0, x0 + run + 0.02, a, b, -2.0, zt - sink, jit=0.03 + 0.008 * i)
    for side, keep in ((-1, n), (1, 3)):
        y0, y1 = sorted((side * Wh, side * (Wh + 0.55)))
        box(mb, rnd, -1.6, 0.0, y0, y1, -2.0, top0 + 0.55)
        for i in range(keep):
            x0 = i * run
            zt = top0 - rise * (i + 1) + 0.55
            if side < 0 and i == 5:
                zt -= 0.5
            box(mb, rnd, x0, x0 + run, y0, y1, -2.0, zt)
    tumbled(mb, rnd, (1.6, 2.4, -0.3), (0.4, 0.28, 0.25))
    tumbled(mb, rnd, (2.5, 2.0, -0.6), (0.35, 0.25, 0.22))
    return finish_ruin(mb, "RuinSteps", top0 + 0.55)


# ---------------------------------------------------------------- export + checks

def report():
    """Triangle counts per object, plus closed islands of single-sided materials whose signed volume is
    negative (i.e. faces wound inward)."""
    dg = bpy.context.evaluated_depsgraph_get()
    for o in sorted(bpy.context.scene.objects, key=lambda o: o.name):
        if o.type != "MESH":
            continue
        me = o.evaluated_get(dg).to_mesh()
        tris = sum(len(p.vertices) - 2 for p in me.polygons)
        bm = bmesh.new()
        bm.from_mesh(me)
        seen, closed, inverted = set(), 0, 0
        for f in bm.faces:
            if f.index in seen:
                continue
            stack, island = [f], []
            seen.add(f.index)
            while stack:
                g = stack.pop()
                island.append(g)
                for e in g.edges:
                    for h in e.link_faces:
                        if h.index not in seen:
                            seen.add(h.index)
                            stack.append(h)
            if all(len(e.link_faces) == 2 for g in island for e in g.edges):
                closed += 1
                vol = 0.0
                for g in island:
                    vs = [v.co for v in g.verts]
                    for i in range(1, len(vs) - 1):
                        vol += vs[0].dot(vs[i].cross(vs[i + 1]))
                if vol < 0:
                    inverted += 1
        bm.free()
        names = [m.name for m in o.data.materials]
        print(f"[biomes] {o.name:24s} {tris:6d} tris  closed islands {closed:3d}  inverted {inverted}  {names}")


def export_biomes():
    B.reset()
    for lod in ("hi", "lo"):
        build_giant_mushroom(f"GiantMushroomA_{lod}", 1101, lod, "A")
        build_giant_mushroom(f"GiantMushroomB_{lod}", 1102, lod, "B")
        build_lantern_tree(f"LanternTree_{lod}", plan_lantern_tree(1201, 10.5, 16), 1202, lod)
        build_mushroom_cluster(f"MushroomCluster_{lod}", 1301, lod)
        build_moonflowers(f"Moonflowers_{lod}", 1401, lod)
        build_meadow_grass(f"MeadowGrass_{lod}", 1501, lod)
        build_crystals(f"CrystalA_{lod}", crystal_specs(1601, 8, 3.0, 0.6, 0.75, (18, 50), 3), 1602, lod)
        build_crystals(f"CrystalB_{lod}", crystal_specs(1611, 4, 1.6, 0.5, 0.6, (30, 72), 3, central=False), 1612,
                       lod)
        build_dune_grass(f"DuneGrass_{lod}", 1701, lod)
    build_ruin_arch()
    build_ruin_column()
    build_ruin_column_broken()
    build_ruin_wall()
    build_ruin_steps()
    report()
    B.export("biomes")


if __name__ == "__main__":
    export_biomes()
