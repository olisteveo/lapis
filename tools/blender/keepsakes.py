"""Mara's five keepsakes, each with the little place it waits in.

Run headless:  blender -b --factory-startup --python tools/blender/keepsakes.py -- <out_dir>
Writes <out_dir>/keepsakes.glb (+ export/fbx/keepsakes.fbx).

Objects come in pairs per keepsake id (shell, wings, lantern, compass, ribbon), both with their origin at the
ground in the middle of the setting, Z up:
  Setting_<id>   what stays in the world: the rock, the staff, the hook, the chest, the post
  Keepsake_<id>  the thing you pick up, already in place on its setting
Keepsakes are drawn a little larger than life so they read from a distance at night.

Vertex colours (COLOR_0): R height through the part 0..1 (cloth: root 0 -> free end 1, the flutter weight),
G 0 solid / 0.5 glow / 1 cloth or paper that moves, B per-part random.
Material names are what the game keys its shading on (ks_*).
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_assets as B  # noqa: E402

from mathutils import Matrix, Vector  # noqa: E402

UP = Vector((0, 0, 1))
TAU = 2 * math.pi

MATS = {
    "ks_stone": (0.42, 0.43, 0.5), "ks_wood": (0.36, 0.27, 0.2), "ks_sand": (0.86, 0.76, 0.66),
    "ks_iron": (0.16, 0.16, 0.2), "ks_rope": (0.62, 0.52, 0.36), "ks_shell": (1.0, 0.76, 0.8),
    "ks_paper": (1.0, 0.86, 0.62), "ks_wing": (0.92, 0.9, 1.0), "ks_brass": (0.78, 0.6, 0.3),
    "ks_ribbon": (1.0, 0.56, 0.66), "ks_glow": (0.7, 1.0, 0.94), "ks_dial": (0.92, 0.87, 0.75),
}
NAMES = list(MATS)
M = {n: i for i, n in enumerate(NAMES)}


def mats():
    return [B.material(n, rgb, double_sided=n in ("ks_wing", "ks_ribbon", "ks_paper")) for n, rgb in MATS.items()]


def newell(mb, idx):
    n = Vector()
    for k in range(len(idx)):
        a, b = Vector(mb.verts[idx[k]]), Vector(mb.verts[idx[(k + 1) % len(idx)]])
        n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
    return n


def face_away(mb, idx, mat, ref):
    """Adds a face wound so its normal points away from ref (shells and strips built in any order)."""
    cen = sum((Vector(mb.verts[i]) for i in idx), Vector()) / len(idx)
    if newell(mb, idx).dot(cen - Vector(ref)) < 0:
        idx = list(reversed(idx))
    mb.f(idx, mat)


def strip(mb, path, side, width, mat, col_fn, twist=None):
    """A flat band through path points, width along `side` (a vector or a function of t): ribbons and ties."""
    n = len(path)
    rows = []
    for i, p in enumerate(path):
        t = i / max(1, n - 1)
        s = side(t) if callable(side) else Vector(side)
        s = s.normalized() * (width(t) if callable(width) else width) / 2
        c = col_fn(t)
        rows.append((mb.v(Vector(p) - s, c), mb.v(Vector(p) + s, c)))
    for (a0, a1), (b0, b1) in zip(rows, rows[1:]):
        mb.f((a0, a1, b1, b0), mat)
    return rows


def clone(mb):
    c = B.MeshBuilder()
    c.verts, c.faces, c.mats, c.cols = list(mb.verts), list(mb.faces), list(mb.mats), list(mb.cols)
    return c


def held(mb, name):
    """The keepsake again, centred on its own middle, for holding up in first person (Held_<id>)."""
    c = clone(mb)
    lo = Vector([min(v[k] for v in c.verts) for k in range(3)])
    hi = Vector([max(v[k] for v in c.verts) for k in range(3)])
    mid = (lo + hi) / 2
    B.xform(c, 0, lambda p: p - mid)
    c.build(f"Held_{name}", mats())


# ---------------------------------------------------------------- the seashell, on a wet rock shelf

def scallop(mb, center, R, rot, col):
    """A fan shell: ribbed dome over a flatter underside, hinge at the local origin, opening along +X."""
    nr, na, spread = 7, 26, 1.15
    def top(r, a):
        dome = 0.2 * R * math.sin(math.pi * min(r / R, 1) * 0.5 + 0.2) * math.cos(a * 0.7)
        rib = 0.03 * R * abs(math.sin(a * 9)) * (r / R)
        return dome + rib
    def pt(r, a, z):
        rr = r * (1 + 0.035 * math.cos(a * 18))
        return Vector(center) + rot @ Vector((math.cos(a) * rr, math.sin(a) * rr, z))
    ref_top = Vector(center) - rot @ Vector((0, 0, R * 3))
    ref_bot = Vector(center) + rot @ Vector((0, 0, R * 3))
    pole_t = mb.v(pt(0, 0, 0.02 * R), col)
    pole_b = mb.v(pt(0, 0, 0.0), col)
    T, Bt = [], []
    for i in range(1, nr + 1):
        r = R * i / nr
        T.append([mb.v(pt(r, -spread + 2 * spread * j / na, top(r, -spread + 2 * spread * j / na)), col) for j in range(na + 1)])
        Bt.append([mb.v(pt(r, -spread + 2 * spread * j / na, top(r, -spread + 2 * spread * j / na) * 0.3), col) for j in range(na + 1)])
    for j in range(na):
        face_away(mb, (pole_t, T[0][j], T[0][j + 1]), M["ks_shell"], ref_top)
        face_away(mb, (pole_b, Bt[0][j], Bt[0][j + 1]), M["ks_shell"], ref_bot)
    for i in range(nr - 1):
        for j in range(na):
            face_away(mb, (T[i][j], T[i + 1][j], T[i + 1][j + 1], T[i][j + 1]), M["ks_shell"], ref_top)
            face_away(mb, (Bt[i][j], Bt[i + 1][j], Bt[i + 1][j + 1], Bt[i][j + 1]), M["ks_shell"], ref_bot)
    mid = Vector(center) + rot @ Vector((R * 0.5, 0, R * 0.05))
    for j in range(na):
        face_away(mb, (T[-1][j], T[-1][j + 1], Bt[-1][j + 1], Bt[-1][j]), M["ks_shell"], mid)
    for j in (0, na):
        face_away(mb, (pole_t, T[0][j], Bt[0][j], pole_b), M["ks_shell"], mid)
        for i in range(nr - 1):
            face_away(mb, (T[i][j], T[i + 1][j], Bt[i + 1][j], Bt[i][j]), M["ks_shell"], mid)
    # Two little ears either side of the hinge.
    for s in (-1, 1):
        a, b, c = pt(0.02, 0, 0.02 * R), pt(R * 0.28, s * 0.9, 0.05 * R), pt(R * 0.22, s * 0.25, 0.08 * R)
        ids = [mb.v(a, col), mb.v(b, col), mb.v(c, col)]
        face_away(mb, ids, M["ks_shell"], ref_top)


def build_shell():
    rnd = random.Random(9101)
    st = B.MeshBuilder()
    B.blob(st, (0, 0, 0.1), (0.95, 0.7, 0.32), rnd, u=16, v=9, mat=M["ks_stone"], rough=0.12, flat=0.5,
           col=(0, 0, rnd.random()))
    B.blob(st, (-0.55, 0.45, 0.2), (0.5, 0.42, 0.42), rnd, u=12, v=8, mat=M["ks_stone"], rough=0.15, flat=0.3,
           col=(0, 0, rnd.random()))
    for k in range(7):
        a = rnd.uniform(0, TAU)
        d = rnd.uniform(0.95, 1.35)
        B.blob(st, (math.cos(a) * d, math.sin(a) * d, 0.02), (0.08, 0.06, 0.05), rnd, u=8, v=5, mat=M["ks_stone"],
               rough=0.2, flat=0.4, col=(0, 0, rnd.random()))
    B.ramp_r(st, 0, -0.2, 0.6)
    st.build("Setting_shell", mats())
    ks = B.MeshBuilder()
    rot = Matrix.Rotation(0.6, 3, "Z") @ Matrix.Rotation(-0.25, 3, "Y")
    scallop(ks, (-0.15, -0.1, 0.5), 0.36, rot, (0, 0, 0.3))
    B.ramp_r(ks, 0, 0.45, 0.7)
    held(ks, "shell")
    ks.build("Keepsake_shell", mats())


# ---------------------------------------------------------------- moth wings, tied to a staff on the peak

def ellipse(cx, cy, a, b, rot, n=14):
    c, s = math.cos(rot), math.sin(rot)
    return [(cx + c * a * math.cos(t) - s * b * math.sin(t), cy + s * a * math.cos(t) + c * b * math.sin(t))
            for t in (TAU * k / n for k in range(n))]


def build_wings():
    rnd = random.Random(9201)
    st = B.MeshBuilder()
    # A forked staff, a little windblown.
    B.limb(st, [(0, 0, -0.3), (0.02, 0.01, 0.6), (0.05, 0, 1.3), (0.06, -0.02, 2.05)], [0.055, 0.05, 0.045, 0.035],
           segments=7, mat=M["ks_wood"], col_fn=lambda t: (t, 0, 0.2))
    B.limb(st, [(0.05, 0, 1.55), (0.2, -0.02, 1.85), (0.27, -0.03, 2.0)], [0.03, 0.022, 0.016], segments=5,
           mat=M["ks_wood"], col_fn=lambda t: (0.7 + 0.3 * t, 0, 0.4))
    # A ring of stones round its foot, as if someone marked the spot.
    for k in range(6):
        a = TAU * k / 6 + rnd.uniform(-0.2, 0.2)
        B.blob(st, (math.cos(a) * 0.75, math.sin(a) * 0.75, 0.1), (0.22, 0.17, 0.17), rnd, u=10, v=6,
               mat=M["ks_stone"], rough=0.15, flat=0.4, col=(0, 0, rnd.random()))
    B.ramp_r(st, 0, -0.3, 2.1)
    st.build("Setting_wings", mats())

    ks = B.MeshBuilder()
    root = Vector((0.06, -0.09, 1.72))
    # Wings in the staff's front plane (X across, Z up), paper over a stick frame, each a little canted.
    for side in (-1, 1):
        for poly, depth in ((ellipse(0.34, 0.14, 0.36, 0.16, 0.35), 0.006), (ellipse(0.2, -0.13, 0.22, 0.14, -0.55), 0.006)):
            pts = [(side * u, v) for u, v in poly]
            start = len(ks.verts)
            B.extrude(ks, pts, root, (1, 0, 0), (0, 0, 1), (0, -1, 0), depth, M["ks_wing"], (0, 1, rnd.random()))
            # Flutter weight grows toward the wing tips.
            for i in range(start, len(ks.verts)):
                x = abs(ks.verts[i][0] - root.x)
                ks.cols[i] = (min(1.0, x / 0.6), 1.0, ks.cols[i][2], 1.0)
        # A glowing eye-spot on each forewing, and the stick along its leading edge.
        eye = ellipse(side * 0.42, 0.17, 0.06, 0.05, 0.0, 10)
        B.extrude(ks, eye, root + Vector((0, -0.007, 0)), (1, 0, 0), (0, 0, 1), (0, -1, 0), 0.003, M["ks_glow"],
                  (0.6, 0.5, rnd.random()))
        B.limb(ks, [root, root + Vector((side * 0.35, -0.01, 0.26)), root + Vector((side * 0.66, -0.01, 0.22))],
               [0.009, 0.008, 0.006], segments=4, mat=M["ks_wood"], col_fn=lambda t: (t, 0, 0.5))
    # The body, and the string that ties it to the staff.
    B.limb(ks, [root + Vector((0, 0, 0.1)), root + Vector((0, -0.02, -0.18))], [0.025, 0.012], segments=6,
           mat=M["ks_rope"], col_fn=lambda t: (0.0, 0.0, 0.7))
    B.limb(ks, [root + Vector((0, 0.01, 0.0)), Vector((0.06, 0.0, 1.72)), Vector((0.05, 0.05, 1.7))], [0.006] * 3,
           segments=4, mat=M["ks_rope"], col_fn=lambda t: (0.0, 0.0, 0.8))
    held(ks, "wings")
    ks.build("Keepsake_wings", mats())


# ---------------------------------------------------------------- the paper lantern, hung from a crook

def build_lantern():
    rnd = random.Random(9301)
    st = B.MeshBuilder()
    crook = [(0, 0, -0.2), (0.03, 0, 0.8), (0.0, 0.0, 1.7), (0.08, 0, 2.2), (0.3, 0, 2.42), (0.52, 0, 2.38),
             (0.62, 0, 2.22)]
    B.limb(st, crook, [0.06, 0.055, 0.05, 0.045, 0.04, 0.035, 0.03], segments=7, mat=M["ks_wood"],
           col_fn=lambda t: (t, 0, 0.3))
    for k in range(5):
        a = rnd.uniform(0, TAU)
        d = rnd.uniform(0.3, 0.7)
        B.blob(st, (math.cos(a) * d, math.sin(a) * d, 0.05), (0.14, 0.11, 0.1), rnd, u=8, v=5, mat=M["ks_stone"],
               rough=0.2, flat=0.4, col=(0, 0, rnd.random()))
    B.ramp_r(st, 0, -0.2, 2.45)
    st.build("Setting_lantern", mats())

    ks = B.MeshBuilder()
    hang = Vector((0.62, 0, 2.2))
    c = hang - Vector((0, 0, 0.62))
    B.limb(ks, [hang, hang - Vector((0, 0, 0.3))], [0.006, 0.006], segments=4, mat=M["ks_rope"],
           col_fn=lambda t: (0, 0, 0.6))
    # Ribbed paper globe, glowing from within; dark wooden cap and foot ring.
    ribs = lambda t, a: 1.0 - 0.05 * abs(math.cos(a * 6))
    prof = [(0.06, -0.22), (0.15, -0.2), (0.23, -0.12), (0.26, 0.0), (0.23, 0.12), (0.15, 0.2), (0.06, 0.22)]
    B.lathe(ks, prof, 24, M["ks_paper"], col_fn=lambda t: (t, 0.5, 0.5), center=c, radial_fn=ribs, cap_bottom=True,
            cap_top=True)
    B.lathe(ks, [(0.0, 0.2), (0.08, 0.2), (0.09, 0.26), (0.03, 0.31), (0.0, 0.31)], 10, M["ks_wood"],
            col_fn=lambda t: (t, 0, 0.1), center=c)
    B.lathe(ks, [(0.0, -0.27), (0.08, -0.27), (0.08, -0.2), (0.0, -0.2)], 10, M["ks_wood"],
            col_fn=lambda t: (t, 0, 0.1), center=c)
    # A paper tassel.
    B.limb(ks, [c - Vector((0, 0, 0.27)), c - Vector((0, 0, 0.5))], [0.02, 0.008], segments=5, mat=M["ks_ribbon"],
           col_fn=lambda t: (t, 1.0, 0.9))
    held(ks, "lantern")
    ks.build("Keepsake_lantern", mats())


# ---------------------------------------------------------------- the compass, on a half-buried chest

def build_compass():
    rnd = random.Random(9401)
    st = B.MeshBuilder()
    B.blob(st, (0.1, 0.1, -0.05), (1.5, 1.1, 0.4), rnd, u=18, v=9, mat=M["ks_sand"], rough=0.1, flat=0.6,
           col=(0, 0, rnd.random()))
    tilt = Matrix.Rotation(0.2, 3, "X") @ Matrix.Rotation(0.12, 3, "Y")
    cc = Vector((0.0, 0.0, 0.3))
    s = len(st.verts)
    B.obox(st, (0, 0, 0), (1, 0, 0), (0, 1, 0), 0.42, 0.28, 0.24, M["ks_wood"], (0, 0, 0.2))
    # Iron bands round the chest and a domed lid.
    for x in (-0.3, 0.3):
        B.obox(st, (x, 0, 0), (1, 0, 0), (0, 1, 0), 0.03, 0.29, 0.25, M["ks_iron"], (0, 0, 0.6))
    B.obox(st, (0, 0, 0.27), (1, 0, 0), (0, 1, 0), 0.43, 0.29, 0.04, M["ks_wood"], (0, 0, 0.3))
    B.obox(st, (0, -0.29, 0.12), (1, 0, 0), (0, 1, 0), 0.05, 0.015, 0.06, M["ks_iron"], (0, 0, 0.7))
    B.xform(st, s, lambda p: tilt @ p + cc)
    # A snapped oar stuck in the sand behind it.
    B.limb(st, [(-0.7, 0.6, -0.3), (-0.75, 0.68, 0.9)], [0.04, 0.035], segments=6, mat=M["ks_wood"],
           col_fn=lambda t: (t, 0, 0.5), jag=(rnd, 0.08))
    B.ramp_r(st, 0, -0.3, 1.0)
    st.build("Setting_compass", mats())

    ks = B.MeshBuilder()
    top = tilt @ Vector((0.05, 0.02, 0.31)) + cc
    face = tilt @ Vector((0, 0, 1))
    rot = UP.rotation_difference(face).to_matrix()
    R = 0.17
    B.lathe(ks, [(0.0, 0.0), (R, 0.0), (R + 0.01, 0.03), (R, 0.055), (R - 0.02, 0.055), (R - 0.02, 0.045),
                 (0.0, 0.045)], 28, M["ks_brass"], col_fn=lambda t: (t, 0, 0.2))
    B.lathe(ks, [(0.0, 0.046), (R - 0.025, 0.046), (R - 0.025, 0.05), (0.0, 0.05)], 28, M["ks_dial"],
            col_fn=lambda t: (t, 0, 0.4))
    # The needle: a slim diamond, its north end glowing. Its own piece, so a held compass can swing it.
    nd = B.MeshBuilder()
    B.extrude(nd, [(0, -0.018), (0.13, 0), (0, 0.018)], (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), 0.006,
              M["ks_glow"], (0.9, 0.5, 0.8))
    B.extrude(nd, [(-0.13, 0), (0, -0.018), (0, 0.018)], (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), 0.006,
              M["ks_brass"], (0.9, 0, 0.8))
    B.limb(ks, [(0, R + 0.005, 0.03), (0, R + 0.04, 0.03)], [0.008, 0.008], segments=5, mat=M["ks_brass"],
           col_fn=lambda t: (0.5, 0, 0.3))
    B.limb(ks, [(0.03 * math.cos(a), R + 0.06 + 0.03 * math.sin(a), 0.03) for a in (TAU * k / 10 for k in range(10))],
           [0.006] * 10, segments=4, mat=M["ks_brass"], col_fn=lambda t: (0.5, 0, 0.3), closed=True)
    # Its lid, hinged open at the back.
    lid = Matrix.Rotation(1.9, 3, "X")
    sl = len(ks.verts)
    B.lathe(ks, [(0.0, 0.0), (R, 0.0), (R, 0.015), (0.0, 0.02)], 28, M["ks_brass"], col_fn=lambda t: (t, 0, 0.25))
    B.xform(ks, sl, lambda p: lid @ (p - Vector((0, -R, 0))) + Vector((0, -R, 0.05)))
    # Held, the case sits face up at its own origin and the needle pivots at the origin.
    clone(ks).build("Held_compass", mats())
    clone(nd).build("Held_needle", mats())
    s = len(ks.verts)
    ks.merge(clone(nd))
    B.xform(ks, s, lambda p: p + Vector((0, 0, 0.052)))
    B.xform(ks, 0, lambda p: rot @ p + top)
    ks.build("Keepsake_compass", mats())


# ---------------------------------------------------------------- her ribbon, tied round a drowned post

def build_ribbon():
    rnd = random.Random(9501)
    st = B.MeshBuilder()
    post = [(0, 0, -2.0), (0.03, 0.0, -0.4), (0.08, 0.02, 0.8), (0.12, 0.03, 1.6)]
    B.limb(st, post, [0.17, 0.16, 0.15, 0.14], segments=9, mat=M["ks_wood"], col_fn=lambda t: (t, 0, 0.3),
           jag=(rnd, 0.12))
    B.blob(st, (0, 0, -0.75), (0.6, 0.5, 0.35), rnd, u=12, v=7, mat=M["ks_stone"], rough=0.15, flat=0.3,
           col=(0, 0, rnd.random()))
    ring = [(0.1 + 0.18 * math.cos(a), 0.025 + 0.18 * math.sin(a), 1.35) for a in (TAU * k / 14 for k in range(14))]
    B.limb(st, ring, [0.018] * 14, segments=5, mat=M["ks_iron"], col_fn=lambda t: (0.9, 0, 0.6), closed=True)
    B.ramp_r(st, 0, -2.0, 1.7)
    st.build("Setting_ribbon", mats())

    ks = B.MeshBuilder()
    pc = Vector((0.085, 0.02, 1.0))
    r = 0.165
    # The band round the post.
    band = [pc + Vector((math.cos(a) * r, math.sin(a) * r, 0)) for a in (TAU * k / 18 for k in range(19))]
    strip(ks, band, UP, 0.07, M["ks_ribbon"], lambda t: (0.0, 1.0, 0.2))
    knot = pc + Vector((0, -r - 0.02, 0))
    B.sphere(ks, knot, 0.035, u=8, v=5, mat=M["ks_ribbon"], col=(0.0, 1.0, 0.3), scale=(1.2, 0.8, 1.0))
    # Two loops and two trailing tails, in front of the post.
    for s in (-1, 1):
        loop = [knot + Vector((s * 0.22 * math.sin(math.pi * u), -0.02 * math.sin(math.pi * u),
                               0.06 * math.sin(TAU * u) + 0.06 * math.sin(math.pi * u)))
                for u in (k / 16 for k in range(17))]
        strip(ks, loop, (0, 0.3, 1), 0.06, M["ks_ribbon"], lambda t: (0.4 * math.sin(math.pi * t), 1.0, 0.4))
        tail = [knot + Vector((s * (0.04 + 0.12 * u), -0.02 - 0.05 * u, -0.6 * u + 0.03 * math.sin(u * 7)))
                for u in (k / 10 for k in range(11))]
        strip(ks, tail, (1, 0, 0), lambda t: 0.06 * (1 - 0.3 * t), M["ks_ribbon"], lambda t: (t, 1.0, 0.6 + 0.2 * s))
    held(ks, "ribbon")
    ks.build("Keepsake_ribbon", mats())


def build():
    B.reset()
    build_shell()
    build_wings()
    build_lantern()
    build_compass()
    build_ribbon()
    B.export("keepsakes")


if __name__ == "__main__":
    build()
