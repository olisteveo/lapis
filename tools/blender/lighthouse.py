"""The Dream Lighthouse: a hollow, rune-carved tower you climb from the inside, with a floating star crystal in its
lamp room and rune rings orbiting outside.

Run headless:  blender -b --factory-startup --python tools/blender/lighthouse.py -- <out_dir>
Writes <out_dir>/lighthouse.glb, <out_dir>/lighthouse.json (walkable geometry) and export/fbx/lighthouse.fbx.

Blender Z-up, origin at the ground centre of the tower base. Objects:
  DreamLighthouse        everything static
    StarCrystal          origin at its own centre (the game spins and bobs it)
    RuneRing_0..2        origin on the tower axis at the ring's height, tilt baked in (the game spins them)

Vertex colours (COLOR_0): R height through the whole asset 0..1, G 0 solid / 0.5 glow, B per-part random.

The interior stair is computed from the constants below and the same numbers go to lighthouse.json: tread i has
its top at (i+1)*RISE and spans angles [START + i*A, START + (i+1)*A] counter-clockwise from +X, radially from the
newel (NEWEL) out to the inner wall face at its top height.
"""
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_assets as B  # noqa: E402

from mathutils import Matrix, Vector  # noqa: E402

TAU = 2 * math.pi
UP = Vector((0, 0, 1))

R_BASE, R_TOP = 3.2, 2.4
WALL_T = 0.35
GALLERY_Z = 22.0
GROUND = 0.2
NEWEL = 0.35
RISE = 0.25
STEPS = round(GALLERY_Z / RISE) - 1          # the top floor is the step after the last tread
A = TAU / 20                                 # 20 treads a turn: 5 m per turn, >= 0.64 m deep at the wall
START = 0.6                                  # first tread sits beside the doorway, not in it
TREAD_T = 0.32
FLOOR_T = 0.3
# The top floor is cut away over the last treads so climbers keep >= 2.2 m headroom under its slab.
OPEN_STEPS = 10
GALLERY_OUT = 4.4
GALLERY_T = 0.4
GALLERY_RAIL_H = 1.0
DOOR_W, DOOR_H = 1.4, 2.5
GDOOR_W, GDOOR_H = 1.2, 2.3
PLINTH = ((5.6, 0.06), (4.9, GROUND))
PARAPET_Z = 23.02
GLASS_Z1, GLASS_R = 26.3, 2.15
CRYSTAL_Z = 25.0                              # bottom tip clears a player's head on the top floor
WS = 48                                      # wall segments
GS = 24                                      # lamp-glass segments
RINGS = ((6.5, 1.25, math.radians(7), 0.4), (12.0, 1.3, math.radians(5), 2.5), (17.0, 1.2, math.radians(8), 4.4))


def tower_r(z):
    z = max(0.0, min(GALLERY_Z, z))
    return R_BASE + (R_TOP - R_BASE) * z / GALLERY_Z


def wall_in(z):
    return tower_r(z) - WALL_T


def tread(i):
    top = (i + 1) * RISE
    return dict(top=top, a0=START + i * A, a1=START + (i + 1) * A, inner=NEWEL, outer=wall_in(top))


def stair_line(th):
    """Height of the stair's walking line at unwrapped angle th."""
    return RISE * (th - START) / A + RISE / 2


def radial(th):
    return Vector((math.cos(th), math.sin(th), 0.0))


def tangent(th):
    return Vector((-math.sin(th), math.cos(th), 0.0))


def polar(r, th, z):
    return Vector((r * math.cos(th), r * math.sin(th), z))


def in_arc(th, a0, a1):
    return a0 + (th - a0) % TAU <= a1


OPEN_FROM, OPEN_TO = START + (STEPS - OPEN_STEPS) * A, START + STEPS * A
FLOOR_ARC = (OPEN_TO, OPEN_FROM + TAU)


def highest_tread_below(th, z):
    """Top of the highest tread under angle th that is below height z (0 for the ground floor)."""
    best = GROUND
    for i in range(STEPS):
        t = tread(i)
        if (th - t["a0"]) % TAU <= A and t["top"] < z:
            best = max(best, t["top"])
    return best


def _gallery_door():
    seg = TAU / GS
    mid = OPEN_TO + (TAU - OPEN_STEPS * A) / 2
    k = round(mid / seg - 0.5) % GS
    return k, (k + 0.5) * seg


GDOOR_K, GDOOR_ANGLE = _gallery_door()
DOOR_SECTOR = 3 * TAU / WS                   # half-width of the wall patch around each doorway


def door_seg(s):
    return (s + 3) % WS < 6


def gdoor_seg(s):
    return (s - (2 * GDOOR_K - 2)) % WS < 6


def gdoor_glass(j):
    return (j - (GDOOR_K - 1)) % GS < 3


# ---------------------------------------------------------------- materials

def _glow(name, rgb, emit, strength=4.0):
    def make():
        m = B.material(name, rgb, emission=emit)
        m.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = strength
        return m
    return make


MATS = {
    "lighthouse_white": lambda: B.material("lighthouse_white", (0.92, 0.88, 0.8)),
    "lighthouse_band": lambda: B.material("lighthouse_band", (0.93, 0.45, 0.36)),
    "stone": lambda: B.material("stone", (0.46, 0.47, 0.56)),
    "iron": lambda: B.material("iron", (0.12, 0.13, 0.2)),
    "lamp_glass": _glow("lamp_glass", (1.0, 0.84, 0.58), (1.0, 0.7, 0.35), 1.5),
    "rune_glow": _glow("rune_glow", (0.62, 0.86, 1.0), (0.45, 0.75, 1.0)),
    "window_glow": _glow("window_glow", (1.0, 0.72, 0.4), (1.0, 0.6, 0.25)),
    "wood": lambda: B.material("wood", (0.34, 0.25, 0.22)),
    "star_crystal": _glow("star_crystal", (1.0, 0.93, 0.68), (1.0, 0.85, 0.5), 6.0),
}
MAIN_MATS = ("lighthouse_white", "lighthouse_band", "stone", "iron", "lamp_glass", "rune_glow", "window_glow", "wood")
WHITE, BAND, STONE, IRON, GLASS, RUNE, WINDOW, WOOD = range(len(MAIN_MATS))


# ---------------------------------------------------------------- flat shapes on surfaces

def area2(pts):
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
               for i in range(len(pts)))


def ccw(pts):
    return list(pts) if area2(pts) > 0 else list(reversed(pts))


def region(mb, mapper, shape, d0, d1, mat, col, back=False, sides=True):
    """Extrudes a 2D shape off a surface. mapper(u, v, d) -> Vector must map counter-clockwise (u, v) onto the
    surface's outward side, d along its normal; the front sits at d1, the side walls run down to d0.
    Shapes: ('poly', pts) convex, ('star', pts) star-shaped about its centroid, ('band', L, R, closed)."""
    kind = shape[0]
    loops = []
    if kind in ("poly", "star"):
        pts = ccw(shape[1])
        n = len(pts)
        F = [mb.v(mapper(u, v, d1), col) for u, v in pts]
        if kind == "star":
            cu, cv = sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n
            c = mb.v(mapper(cu, cv, d1), col)
            for i in range(n):
                mb.f((c, F[i], F[(i + 1) % n]), mat)
        else:
            mb.f(F, mat)
        if back:
            Bk = [mb.v(mapper(u, v, d0), col) for u, v in pts]
            if kind == "star":
                cb = mb.v(mapper(cu, cv, d0), col)
                for i in range(n):
                    mb.f((cb, Bk[(i + 1) % n], Bk[i]), mat)
            else:
                mb.f(list(reversed(Bk)), mat)
        loops = [pts]
    else:
        L, R, closed = shape[1:]
        m = len(L)
        for dd, flip in ((d1, False),) + (((d0, True),) if back else ()):
            FL = [mb.v(mapper(u, v, dd), col) for u, v in L]
            FR = [mb.v(mapper(u, v, dd), col) for u, v in R]
            for k in range(m if closed else m - 1):
                k2 = (k + 1) % m
                ids = [FL[k], FR[k], FR[k2], FL[k2]]
                if (area2([L[k], R[k], R[k2], L[k2]]) < 0) != flip:
                    ids.reverse()
                mb.f(ids, mat)
        if closed:
            outer, inner = (L, R) if abs(area2(L)) > abs(area2(R)) else (R, L)
            loops = [ccw(outer), list(reversed(ccw(inner)))]
        else:
            loops = [ccw(list(L) + list(reversed(R)))]
    if sides:
        for loop in loops:
            n = len(loop)
            F = [mb.v(mapper(u, v, d1), col) for u, v in loop]
            Bk = [mb.v(mapper(u, v, d0), col) for u, v in loop]
            for i in range(n):
                j = (i + 1) % n
                mb.f((F[i], Bk[i], Bk[j], F[j]), mat)


def wall_map(th0, z0):
    """(u, v) metres along the tower surface around (th0, z0); u counter-clockwise, v up."""
    r0 = tower_r(z0)
    return lambda u, v, d: polar(tower_r(z0 + v) + d, th0 + u / r0, z0 + v)


def helix_map(u, v, d):
    """u is the angle itself, v the height: for long ribbons that follow the tower round."""
    return polar(tower_r(v) + d, u, v)


def plane_map(o, U, V):
    o, U, V = Vector(o), Vector(U), Vector(V)
    N = U.cross(V)
    return lambda u, v, d: o + U * u + V * v + N * d


def circle(r, n, cx=0.0, cy=0.0, a0=0.0):
    return [(cx + r * math.cos(a0 + TAU * k / n), cy + r * math.sin(a0 + TAU * k / n)) for k in range(n)]


def four_star(h, w, waist):
    pts = []
    for k in range(4):
        a = k * math.pi / 2
        tip = h if k % 2 else w
        pts.append((tip * math.cos(a), tip * math.sin(a)))
        pts.append((waist * math.cos(a + math.pi / 4), waist * math.sin(a + math.pi / 4)))
    return pts


def stroke(p, q, w=0.032):
    p, q = Vector((*p, 0)), Vector((*q, 0))
    e = (q - p).normalized()
    n = Vector((-e.y, e.x, 0)) * w
    p, q = p - e * w * 0.6, q + e * w * 0.6
    return ("poly", [(c.x, c.y) for c in (p + n, p - n, q - n, q + n)])


def crescent(r, w, a0, a1, n, cx=0.0, cy=0.0):
    L, R = [], []
    for k in range(n + 1):
        t = k / n
        a = a0 + (a1 - a0) * t
        d = (math.cos(a), math.sin(a))
        L.append((cx + d[0] * r, cy + d[1] * r))
        rr = r - (w * math.sin(math.pi * t) + 0.006)
        R.append((cx + d[0] * rr, cy + d[1] * rr))
    return ("band", L, R, False)


def scaled(shape, s):
    if shape[0] == "band":
        return ("band", [(u * s, v * s) for u, v in shape[1]], [(u * s, v * s) for u, v in shape[2]], shape[3])
    return (shape[0], [(u * s, v * s) for u, v in shape[1]])


GLYPHS = {
    "star": lambda: [("star", four_star(0.3, 0.2, 0.055))],
    "ring": lambda: [("band", circle(0.19, 10), circle(0.12, 10), True), ("star", four_star(0.07, 0.07, 0.025))],
    "moon": lambda: [crescent(0.21, 0.1, math.radians(60), math.radians(300), 8)],
    "algiz": lambda: [stroke((0, -0.28), (0, 0.28)), stroke((0, 0.04), (-0.18, 0.26)), stroke((0, 0.04), (0.18, 0.26))],
    "tiwaz": lambda: [stroke((0, -0.28), (0, 0.27)), stroke((0, 0.28), (-0.17, 0.07)), stroke((0, 0.28), (0.17, 0.07))],
    "othala": lambda: [("band", [(0, 0.28), (-0.17, 0.08), (0, -0.12), (0.17, 0.08)],
                        [(0, 0.19), (-0.09, 0.08), (0, -0.03), (0.09, 0.08)], True),
                       stroke((-0.08, -0.05), (-0.2, -0.28)), stroke((0.08, -0.05), (0.2, -0.28))],
    "sowilo": lambda: [stroke((-0.12, 0.27), (0.11, 0.07)), stroke((0.11, 0.07), (-0.11, -0.07)),
                       stroke((-0.11, -0.07), (0.12, -0.27))],
}



def inner_map(th0, z0):
    """Like wall_map but on the inner wall face, seen from inside (u runs clockwise so glyphs read unmirrored)."""
    r0 = wall_in(z0)
    return lambda u, v, d: polar(wall_in(z0 + v) - d, th0 - u / r0, z0 + v)


def inner_helix_map(u, v, d):
    """u is minus the angle, v the height, on the inner wall face."""
    return polar(wall_in(v) - d, -u, v)


# ---------------------------------------------------------------- the build

class Parts:
    """Tracks which faces get smooth shading and hands out per-part colours."""

    def __init__(self, mb, seed):
        self.mb, self.rnd, self.smooth = mb, random.Random(seed), []

    def col(self, glow=False):
        return (0.0, 0.5 if glow else 0.0, self.rnd.random())

    def fn(self, glow=False):
        c = self.col(glow)
        return lambda t: c

    def mark_smooth(self, start):
        self.smooth.append((start, len(self.mb.faces)))


def newell(mb, ids):
    n = Vector()
    for k in range(len(ids)):
        a, b = Vector(mb.verts[ids[k]]), Vector(mb.verts[ids[(k + 1) % len(ids)]])
        n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
    return n


def face_toward(mb, ids, direction, mat):
    """Adds a face wound so its normal points along `direction` (a vector)."""
    ids = list(ids)
    if newell(mb, ids).dot(direction) < 0:
        ids.reverse()
    mb.f(ids, mat)


def seg_lathe(mb, P, prof, sides, mat_fn, skip, smooth=True):
    """Lathe whose bands each get their own vertices (crisp edges between bands) and whose faces can be skipped
    per (band, segment), to leave openings for doorways. Profile counter-clockwise in the r-z half plane."""
    for i in range(len(prof) - 1):
        (ra, za), (rb, zb) = prof[i], prof[i + 1]
        col = P.col()
        a = [mb.v(polar(ra, TAU * s / sides, za), col) for s in range(sides)]
        b = [mb.v(polar(rb, TAU * s / sides, zb), col) for s in range(sides)]
        start = len(mb.faces)
        for s in range(sides):
            if skip(min(za, zb), max(za, zb), s):
                continue
            s2 = (s + 1) % sides
            mb.f((a[s], a[s2], b[s2], b[s]), mat_fn(i))
        if smooth and abs(za - zb) > 1e-6:
            P.mark_smooth(start)


def arch_outline(th0, rref, z0, spring, rad, pad=0.0, phis=None):
    """Arched opening as (angle, z) points: up the right jamb, over the arch, down the left jamb."""
    phis = phis or [math.pi * k / 12 for k in range(13)]
    r = rad + pad
    return ([(th0 + r / rref, z0)] + [(th0 + r * math.cos(p) / rref, spring + r * math.sin(p)) for p in phis] +
            [(th0 - r / rref, z0)])


def arched_patch(mb, P, th0, z0, z1, rad, spring, r_out, r_in, side_z0=None, top=False, mat=WHITE):
    """The wall section [th0 - DOOR_SECTOR, th0 + DOOR_SECTOR] x [z0, z1] with an arched doorway through it.
    The opening's clear width (2 * rad) is measured on the inner face; the outer face splays wider."""
    H = DOOR_SECTOR
    rref = r_in((z0 + spring) / 2)
    Hm, Tm = H * rref, z1 - spring
    pc = math.atan2(Tm, Hm)
    phis = sorted(set([math.pi * k / 12 for k in range(13)] + [pc, math.pi - pc]))
    L = arch_outline(th0, rref, z0, spring, rad, 0.0, phis)
    R = [(th0 + H, z0)]
    for p in phis:
        c, s = math.cos(p), math.sin(p)
        t = min(Hm / abs(c) if abs(c) > 1e-9 else 1e9, Tm / s if s > 1e-9 else 1e9)
        R.append((th0 + t * c / rref, spring + t * s))
    R.append((th0 - H, z0))
    col = P.col()
    start = len(mb.faces)
    for rf, sign in ((r_out, 1), (r_in, -1)):
        FL = [mb.v(polar(rf(z), th, z), col) for th, z in L]
        FR = [mb.v(polar(rf(z), th, z), col) for th, z in R]
        for k in range(len(L) - 1):
            ids = [FL[k], FR[k], FR[k + 1], FL[k + 1]]
            mid = (L[k][0] + R[k + 1][0]) / 2
            face_toward(mb, ids, radial(mid) * sign, mat)
    P.mark_smooth(start)
    O = [mb.v(polar(r_out(z), th, z), col) for th, z in L]
    I = [mb.v(polar(r_in(z), th, z), col) for th, z in L]
    for k in range(len(L) - 1):
        ids = [O[k], O[k + 1], I[k + 1], I[k]]
        zc = (L[k][1] + L[k + 1][1]) / 2
        target = polar((r_out(zc) + r_in(zc)) / 2, th0, min(spring, zc))
        cen = sum((Vector(mb.verts[i]) for i in ids), Vector()) / 4
        face_toward(mb, ids, target - cen, STONE)
    if side_z0 is not None:
        for sgn in (1, -1):
            th = th0 + sgn * H
            ids = [mb.v(polar(r_out(side_z0), th, side_z0), col), mb.v(polar(r_out(z1), th, z1), col),
                   mb.v(polar(r_in(z1), th, z1), col), mb.v(polar(r_in(side_z0), th, side_z0), col)]
            face_toward(mb, ids, tangent(th) * sgn, mat)
    if top:
        angs = [th0 - H + 2 * H * k / 3 for k in range(4)]
        for a0, a1 in zip(angs, angs[1:]):
            ids = [mb.v(polar(r_in(z1), a0, z1), col), mb.v(polar(r_out(z1), a0, z1), col),
                   mb.v(polar(r_out(z1), a1, z1), col), mb.v(polar(r_in(z1), a1, z1), col)]
            face_toward(mb, ids, UP, mat)
    return rref


def door_trim(mb, P, th0, rref, z0, spring, rad, r_out, r_in, frame=True, inner=True):
    """Glowing rune trim round an arched opening (both faces), with a raised stone frame outside."""
    m_out = lambda u, v, d: polar(r_out(v) + d, u, v)
    m_in = lambda u, v, d: polar(r_in(v) - d, -u, v)
    neg = lambda pts: [(-u, v) for u, v in pts]
    L0, L1, L2 = (arch_outline(th0, rref, z0, spring, rad, p) for p in (0.0, 0.1, 0.32))
    region(mb, m_out, ("band", L0, L1, False), -0.01, 0.05, RUNE, P.col(True))
    if frame:
        region(mb, m_out, ("band", L1, L2, False), -0.01, 0.13, STONE, P.col())
    if inner:
        region(mb, m_in, ("band", neg(L0), neg(L1), False), -0.01, 0.04, RUNE, P.col(True))


def build_shell(mb, P):
    """Hollow tapering wall, parapet and lip, with the ground doorway and the gallery doorway cut through."""
    outer = [(tower_r(z), z) for z in (0.0, 1.6, 3.0, 10.6, 12.4, GALLERY_Z)] + \
            [(R_TOP, 22.85), (2.52, 22.9), (2.52, PARAPET_Z)]
    inner = [(wall_in(PARAPET_Z), PARAPET_Z), (wall_in(GALLERY_Z), GALLERY_Z), (wall_in(3.0), 3.0), (wall_in(0.0), 0.0)]
    prof = outer + inner
    n_out = len(outer)

    def mat_fn(i):
        if i >= n_out - 1:
            return BAND if i == n_out - 1 else WHITE
        zm = (prof[i][1] + prof[i + 1][1]) / 2
        if zm < 1.6:
            return STONE
        if 10.6 < zm < 12.4 or zm > 22.86:
            return BAND
        return WHITE

    def skip(zlo, zhi, s):
        return (zhi <= 3.0 + 1e-6 and door_seg(s)) or (zlo >= GALLERY_Z - 1e-6 and gdoor_seg(s))

    seg_lathe(mb, P, prof, WS, mat_fn, skip)

    rref = arched_patch(mb, P, 0.0, 0.0, 3.0, DOOR_W / 2, GROUND + DOOR_H - DOOR_W / 2, tower_r, wall_in)
    door_trim(mb, P, 0.0, rref, 0.0, GROUND + DOOR_H - DOOR_W / 2, DOOR_W / 2, tower_r, wall_in)

    r_o, r_i = (lambda z: R_TOP), (lambda z: wall_in(GALLERY_Z))
    gspring = GALLERY_Z + GDOOR_H - GDOOR_W / 2
    rref = arched_patch(mb, P, GDOOR_ANGLE, GALLERY_Z, GLASS_Z1, GDOOR_W / 2, gspring, r_o, r_i,
                        side_z0=PARAPET_Z, top=True)
    door_trim(mb, P, GDOOR_ANGLE, rref, GALLERY_Z, gspring, GDOOR_W / 2, r_o, r_i)
    # Close the parapet lip where it meets the door bay.
    lip = [(R_TOP, 22.85), (2.52, 22.9), (2.52, PARAPET_Z), (R_TOP, PARAPET_Z)]
    for sgn in (1, -1):
        th = GDOOR_ANGLE + sgn * DOOR_SECTOR
        face_toward(mb, [mb.v(polar(r, th, z), P.col()) for r, z in lip], tangent(th) * sgn, BAND)

    for (r, top), z0, k in ((PLINTH[0], -0.3, 7), (PLINTH[1], -0.1, 11)):
        wob = lambda t, a, k=k: 1.0 + (0.018 * math.sin(a * k + 1.3) + 0.008 * math.sin(a * 3 + 0.4)) * (t < 0.99)
        B.lathe(mb, [(r, z0), (r, top - 0.07), (r - 0.08, top), (R_BASE - 0.1, top)], 36, STONE, col_fn=P.fn(),
                radial_fn=wob)
    # A glowing rune circle on the ground floor round the newel.
    fl = plane_map((0, 0, GROUND), (1, 0, 0), (0, 1, 0))
    region(mb, fl, ("band", circle(1.32, 28), circle(1.22, 28), True), 0.0, 0.006, RUNE, P.col(True), sides=False)
    for k in range(6):
        a = TAU * k / 6 + 0.3
        region(mb, fl, ("star", [(u + 1.75 * math.cos(a), v + 1.75 * math.sin(a)) for u, v in four_star(0.2, 0.2, 0.05)]),
               0.0, 0.006, RUNE, P.col(True), sides=False)


def build_stair(mb, P):
    s = len(mb.faces)
    B.lathe(mb, [(NEWEL, 0.0), (NEWEL, GALLERY_Z), (0.44, 22.08), (0.44, 22.22), (0.3, 22.3), (0.3, 22.75),
                 (0.38, 22.82), (0.38, 22.9), (0, 22.9)], 12, STONE, col_fn=P.fn(), cap_bottom=False)
    P.mark_smooth(s)
    for U in ((1, 0, 0), (0, 1, 0)):
        region(mb, plane_map((0, 0, 23.25), U, (0, 0, 1)), ("star", four_star(0.34, 0.22, 0.05)), -0.02, 0.02, RUNE,
               P.col(True), back=True)
    for i in range(STEPS):
        t = tread(i)
        col = P.col()
        top, bot = t["top"], t["top"] - TREAD_T
        secs = [[mb.v(polar(r, a, z), col) for r, z in
                 ((NEWEL - 0.05, top), (t["outer"] + 0.05, top), (t["outer"] + 0.05, bot), (NEWEL - 0.05, bot))]
                for a in (t["a0"], t["a1"])]
        B.rings_loft(mb, secs, STONE)

    # Top floor: everything except the stairwell opening.
    a0, a1 = FLOOR_ARC
    n = max(2, round((a1 - a0) / 0.13))
    col = P.col()
    prof = [(NEWEL - 0.05, GALLERY_Z), (R_TOP - 0.02, GALLERY_Z), (R_TOP - 0.02, GALLERY_Z - FLOOR_T),
            (NEWEL - 0.05, GALLERY_Z - FLOOR_T)]
    B.rings_loft(mb, [[mb.v(polar(r, a0 + (a1 - a0) * k / n, z), col) for r, z in prof] for k in range(n + 1)], STONE)
    # Rail across the stairwell's far edge, where the floor drops away.
    ends = [polar(NEWEL + 0.05, a1, GALLERY_Z), polar(wall_in(GALLERY_Z) - 0.05, a1, GALLERY_Z)]
    for h, rad in ((1.0, 0.04), (0.5, 0.025)):
        B.limb(mb, [p + UP * h for p in ends], [rad, rad], segments=5, mat=IRON, col_fn=P.fn())
    for p in (ends[0], ends[0].lerp(ends[1], 0.5), ends[1]):
        B.limb(mb, [p, p + UP * 1.0], [0.035, 0.035], segments=4, mat=IRON, col_fn=P.fn())
    B.sphere(mb, ends[0].lerp(ends[1], 0.5) + UP * 1.1, 0.1, u=6, v=3, mat=WINDOW, col=P.col(True))


def build_gallery(mb, P):
    n = 48
    angles = [TAU * k / n for k in range(n)]
    z1, z0 = GALLERY_Z, GALLERY_Z - GALLERY_T
    for prof, mat in (([(R_TOP - 0.05, z1), (GALLERY_OUT - 0.08, z1), (GALLERY_OUT - 0.08, z0), (R_TOP - 0.05, z0)],
                       STONE),
                      ([(GALLERY_OUT - 0.08, z1), (GALLERY_OUT, z1), (GALLERY_OUT, z0 - 0.06),
                        (GALLERY_OUT - 0.08, z0 - 0.06)], BAND)):
        col = P.col()
        secs = [[mb.v(polar(r, a, z), col) for r, z in prof] for a in angles]
        B.rings_loft(mb, secs + [secs[0]], mat, cap_start=False, cap_end=False)
    for k in range(16):
        a = TAU * (k + 0.5) / 16
        d, tg = radial(a), tangent(a)
        B.extrude(mb, [(tower_r(z0) - 0.06, z0 + 0.01), (GALLERY_OUT - 0.2, z0 + 0.01),
                       (tower_r(z0 - 1.3) - 0.06, z0 - 1.3)], -tg * 0.15, d, UP, tg, 0.3, WHITE, P.col())
    rr = GALLERY_OUT - 0.1
    for h, rad in ((GALLERY_RAIL_H, 0.04), (GALLERY_RAIL_H * 0.5, 0.025)):
        s = len(mb.faces)
        B.limb(mb, [polar(rr, a, z1 + h) for a in angles], [rad] * n, segments=4, mat=IRON, col_fn=P.fn(),
               closed=True)
        P.mark_smooth(s)
    posts = 20
    for k in range(posts):
        a = TAU * (k + 0.5) / posts
        base = polar(rr, a, z1)
        B.limb(mb, [base, base + UP * GALLERY_RAIL_H], [0.035, 0.035], segments=4, mat=IRON, col_fn=P.fn())
        if k % 2 == 0:
            B.sphere(mb, base + UP * (GALLERY_RAIL_H + 0.1), 0.1, u=6, v=3, mat=WINDOW, col=P.col(True))
    rnd = random.Random(2207)
    for k in range(6):
        a = TAU * k / 6 + 0.55
        top = polar(GALLERY_OUT - 0.25, a, z0 - 0.02)
        count = rnd.randint(3, 6)
        B.limb(mb, [top, top - UP * (0.45 * count + 0.1)], [0.012, 0.012], segments=3, mat=IRON, col_fn=P.fn())
        c = P.col(True)
        for j in range(count):
            B.sphere(mb, top - UP * (0.45 * (j + 1)), 0.09 + 0.035 * (j == count - 1), u=5, v=3, mat=WINDOW, col=c)


def build_lamp_room(mb, P):
    seg_lathe(mb, P, [(GLASS_R, PARAPET_Z), (GLASS_R, GLASS_Z1)], GS, lambda i: GLASS,
              lambda zlo, zhi, j: gdoor_glass(j))
    for j in range(0, GS, 2):
        if (j - (GDOOR_K - 1)) % GS <= 3:
            continue
        a = TAU * j / GS
        B.plank(mb, polar(GLASS_R + 0.02, a, PARAPET_Z), polar(GLASS_R + 0.02, a, GLASS_Z1), 0.09, 0.07,
                up=radial(a), mat=IRON, col=P.col())
    roof = [(r, GLASS_Z1 + z) for r, z in
            ((2.7, -0.05), (2.95, 0.1), (2.4, 0.28), (2.5, 0.7), (2.32, 1.15), (1.85, 1.6), (1.2, 2.0), (0.6, 2.38),
             (0.25, 2.72), (0.08, 3.05), (0, 3.2))]
    top = GLASS_Z1 + 3.2
    s = len(mb.faces)
    B.lathe(mb, roof, 24, BAND, col_fn=P.fn())
    P.mark_smooth(s)
    B.limb(mb, [Vector((0, 0, top - 0.2)), Vector((0, 0, top + 1.45))], [0.035, 0.03], segments=5, mat=IRON,
           col_fn=P.fn())
    B.sphere(mb, (0, 0, top + 0.2), 0.13, u=8, v=5, mat=WINDOW, col=P.col(True))
    vane = plane_map((0, 0, 0), (1, 0, 0), (0, 0, 1))
    region(mb, vane, crescent(0.34, 0.15, math.radians(160), math.radians(380), 12, 0, top + 0.85), -0.03, 0.03,
           RUNE, P.col(True), back=True)
    for U in ((1, 0, 0), (0, 1, 0)):
        region(mb, plane_map((0, 0, top + 1.6), U, (0, 0, 1)), ("star", four_star(0.22, 0.14, 0.035)), -0.02, 0.02,
               RUNE, P.col(True), back=True)


def window_positions():
    out, th = [], START + 1.0
    while True:
        z = stair_line(th) + 1.9
        if z > 20.5:
            return out
        if z > 2.4:
            out.append((th, z))
        th += 1.9


def porthole(mb, P, th, z, r_surface, inward):
    d = -radial(th) if inward else radial(th)
    rot = UP.rotation_difference(d).to_matrix()
    base = polar(r_surface, th, z)
    s = len(mb.verts)
    B.lathe(mb, [(0.28, -0.1), (0.42, -0.1), (0.42, 0.07), (0.28, 0.1), (0.28, -0.1)], 8, WHITE, col_fn=P.fn(),
            cap_bottom=False, cap_top=False)
    B.lathe(mb, [(0.29, -0.06), (0.29, 0.03), (0, 0.05)], 8, WINDOW, col_fn=P.fn(True), cap_bottom=False)
    B.xform(mb, s, lambda p: rot @ p + base)


def build_windows(mb, P):
    wins = window_positions()
    for th, z in wins:
        porthole(mb, P, th, z, tower_r(z), False)
        porthole(mb, P, th, z, wall_in(z), True)
        m = wall_map(th, z)
        for a in (0.0, math.pi / 2):
            region(mb, m, stroke((-0.29 * math.cos(a), -0.29 * math.sin(a)), (0.29 * math.cos(a), 0.29 * math.sin(a)),
                                 0.022), 0.0, 0.07, IRON, P.col(), sides=False)
    return len(wins)


def build_inner_runes(mb, P):
    off = 3.35  # between the portholes above one turn and the treads of the next
    z_of = lambda th: stair_line(th) + off
    th0 = START + 0.3
    th1 = START + (21.0 - off - RISE / 2) * A / RISE
    for dv in (-0.5, 0.5):
        n = round((th1 - th0) / 0.13)
        L = [(-(th0 + (th1 - th0) * k / n), z_of(th0 + (th1 - th0) * k / n) + dv - 0.025) for k in range(n + 1)]
        R = [(u, v + 0.05) for u, v in L]
        region(mb, inner_helix_map, ("band", L, R, False), -0.02, 0.02, RUNE, P.col(True), sides=False)
    order = ["star", "algiz", "ring", "tiwaz", "moon", "sowilo", "star", "othala", "algiz", "ring", "tiwaz", "moon"]
    th, k = th0 + 0.2, 0
    while th < th1 - 0.1:
        z = z_of(th)
        for shape in GLYPHS[order[k % len(order)]]():
            region(mb, inner_map(th, z), scaled(shape, 1.3), -0.02, 0.025, RUNE, P.col(True), sides=False)
        th += 1.45 / wall_in(z)
        k += 1
    return k


def build_lanterns(mb, P):
    """Wall-bracket lanterns up the stairwell, and short orb chains under the top floor."""
    count, th = 0, START + 1.95
    while stair_line(th) + 2.6 < 20.5:
        zb = stair_line(th) + 2.6
        ri = wall_in(zb)
        d = radial(th)
        B.plank(mb, polar(ri + 0.05, th, zb), polar(ri - 0.5, th, zb), 0.06, 0.07, mat=WOOD, col=P.col())
        tip = polar(ri - 0.45, th, zb)
        B.limb(mb, [tip, tip - UP * 0.22], [0.012, 0.012], segments=3, mat=IRON, col_fn=P.fn())
        c = tip - UP * 0.42
        B.lathe(mb, [(0.0, 0.12), (0.16, 0.0), (0.1, -0.02), (0, -0.02)], 6, IRON, col_fn=P.fn(),
                center=c + UP * 0.1, cap_bottom=False)
        B.sphere(mb, c, 0.15, u=6, v=3, mat=WINDOW, col=P.col(True))
        B.lathe(mb, [(0, -0.2), (0.06, -0.12), (0, -0.1)], 6, IRON, col_fn=P.fn(), center=c, cap_bottom=False,
                cap_top=False)
        th += 3.8
        count += 1
    a0, a1 = FLOOR_ARC
    under = GALLERY_Z - FLOOR_T
    for k in range(4):
        a = a0 + (a1 - a0) * (k + 0.5) / 4
        r = 1.55
        room = under - (highest_tread_below(a, under) + 2.2)
        orbs = max(0, min(5, int((room - 0.1) / 0.32)))
        if not orbs:
            continue
        top = polar(r, a, under)
        B.limb(mb, [top, top - UP * (0.32 * orbs + 0.05)], [0.01, 0.01], segments=3, mat=IRON, col_fn=P.fn())
        c = P.col(True)
        for j in range(orbs):
            B.sphere(mb, top - UP * 0.32 * (j + 1), 0.08 + 0.03 * (j == orbs - 1), u=5, v=3, mat=WINDOW, col=c)
    return count


def build_veins(mb, P):
    """Glowing crystal cracks creeping up the outer plaster from the base."""
    rnd = random.Random(2231)

    def vein(th, z0, length, w0, depth):
        m = wall_map(th, z0)
        pts, u, v = [(0.0, 0.0)], 0.0, 0.0
        steps = max(3, int(length / 0.4))
        for k in range(steps):
            u += rnd.uniform(-0.22, 0.22)
            v += length / steps
            pts.append((u, v))
        L, R = [], []
        for k, (pu, pv) in enumerate(pts):
            a, b = pts[max(k - 1, 0)], pts[min(k + 1, len(pts) - 1)]
            dx, dy = b[0] - a[0], b[1] - a[1]
            ln = math.hypot(dx, dy) or 1.0
            w = w0 * (1 - 0.85 * k / (len(pts) - 1))
            L.append((pu - dy / ln * w, pv + dx / ln * w))
            R.append((pu + dy / ln * w, pv - dx / ln * w))
        region(mb, m, ("band", L, R, False), -0.01, 0.018, RUNE, P.col(True), sides=False)
        if depth < 2:
            for k in rnd.sample(range(1, len(pts) - 2), min(2, len(pts) - 3)):
                bu, bv = pts[k]
                vein(th + bu / tower_r(z0), z0 + bv, length * rnd.uniform(0.3, 0.5), w0 * 0.6, depth + 1)

    for k, th in enumerate((0.75, 1.5, 2.3, 3.1, 3.9, 4.7, 5.5)):
        vein(th + rnd.uniform(-0.1, 0.1), 0.15, rnd.uniform(4.0, 8.5), 0.07, 0)


def build_rune_ring(i, z, gap, tilt, yaw, parent):
    rnd = random.Random(2250 + i)
    mb = B.MeshBuilder()
    radius = tower_r(z) + gap
    col = (0.0, 0.5, rnd.random())
    n = 32
    prof = [(radius - 0.02, -0.07), (radius + 0.02, -0.07), (radius + 0.02, 0.07), (radius - 0.02, 0.07)]
    secs = [[mb.v(polar(r, TAU * k / n, h), col) for r, h in prof] for k in range(n)]
    B.rings_loft(mb, secs + [secs[0]], 0, cap_start=False, cap_end=False)
    order = ["star", "tiwaz", "ring", "algiz", "star", "moon", "sowilo", "othala"]
    for k in range(8):
        a = TAU * k / 8 + rnd.uniform(-0.1, 0.1)
        m = plane_map(polar(radius + 0.022, a, 0.0), tangent(a), UP)
        for shape in GLYPHS[order[k % len(order)]]():
            region(mb, m, scaled(shape, 0.6), -0.044, 0.0, 0, col, back=True)
    rot = Matrix.Rotation(tilt, 3, Vector((math.cos(yaw), math.sin(yaw), 0)))
    B.xform(mb, 0, lambda p: rot @ p)
    obj = mb.build(f"RuneRing_{i}", [MATS["rune_glow"]()], smooth=False, parent=parent, location=(0, 0, z))
    return obj, radius


def build_crystal():
    """Two crossed four-point star lenses (XZ and YZ planes), origin at the centre."""
    mb = B.MeshBuilder()
    rnd = random.Random(2290)
    star = four_star(0.95, 0.78, 0.22)
    for U, V, N in (((1, 0, 0), (0, 0, 1), (0, -1, 0)), ((0, 1, 0), (0, 0, 1), (1, 0, 0))):
        U, V, N = Vector(U), Vector(V), Vector(N)
        col = (0.0, 0.5, rnd.random())
        ring = [mb.v(U * u + V * v, col) for u, v in star]
        front, back = mb.v(N * 0.32, col), mb.v(-N * 0.32, col)
        for k in range(len(ring)):
            j = (k + 1) % len(ring)
            mb.f((front, ring[k], ring[j]), 0)
            mb.f((back, ring[j], ring[k]), 0)
    vol = sum(Vector(mb.verts[f[0]]).dot(Vector(mb.verts[f[1]]).cross(Vector(mb.verts[f[2]]))) for f in mb.faces)
    if vol < 0:
        mb.faces = [tuple(reversed(f)) for f in mb.faces]
    for k, (x, y, z) in enumerate(mb.verts):
        r, g, b, a = mb.cols[k]
        mb.cols[k] = ((z + 0.95) / 1.9, g, b, a)
    return mb


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def write_json(path, rings, counts):
    treads = [tread(i) for i in range(STEPS)]
    r6 = lambda x: round(x, 6)
    data = {
        "units": "metres, Blender Z-up; glTF/three: (x, y, z)_three = (x, z, -y)_blender. Angles are radians "
                 "counter-clockwise seen from above from +X (three: atan2(-z, x)).",
        "wall": {"outer": [R_BASE, R_TOP], "thickness": WALL_T,
                 "rule": f"outer(z) = {R_BASE} - {R_BASE - R_TOP:g} * z / {GALLERY_Z} for 0 <= z <= {GALLERY_Z}, "
                         f"{R_TOP} above (parapet to z={PARAPET_Z}); inner(z) = outer(z) - {WALL_T}"},
        "door": {"angle": 0.0, "width": DOOR_W, "height": DOOR_H, "sillZ": GROUND,
                 "note": "arched (semicircular head); width is the clear width at the inner face, the outer face "
                         "splays wider"},
        "groundFloor": GROUND,
        "plinth": [{"radius": r, "top": z} for r, z in PLINTH],
        "newel": NEWEL, "newelTop": 22.9,
        "stair": {
            "startAngle": START, "turnDirection": "ccw", "rise": RISE, "anglePerStep": r6(A), "steps": STEPS,
            "turns": r6(STEPS * A / TAU), "inner": NEWEL, "outerRule": "inner wall radius at tread height: "
            "outer_i = inner((i+1)*rise)", "firstTreadTop": RISE, "lastTreadTop": STEPS * RISE,
            "treadThickness": TREAD_T, "arrivalAngle": r6(OPEN_TO),
            "treadRule": "tread i: top z=(i+1)*rise, angles [startAngle+i*a, startAngle+(i+1)*a], radii "
                         "[inner, outer_i], solid down to top-treadThickness",
            "outerPerStep": [r6(t["outer"]) for t in treads],
            "minOuterTreadDepth": r6(treads[-1]["outer"] * A),
            "headroomPerTurn": r6(TAU / A * RISE - TREAD_T),
        },
        "topFloor": {"z": GALLERY_Z, "thickness": FLOOR_T, "inner": NEWEL, "outer": r6(wall_in(GALLERY_Z)),
                     "opening": {"from": r6(OPEN_FROM), "to": r6(OPEN_TO), "fromMod2Pi": r6(OPEN_FROM % TAU),
                                 "toMod2Pi": r6(OPEN_TO % TAU),
                                 "note": "no floor over angles [from, to] ccw (newel to wall): the stairwell. The "
                                         "stair arrives at `to`; a rail 1.0 m high closes the `from` edge."}},
        "galleryDoor": {"angle": r6(GDOOR_ANGLE), "width": GDOOR_W, "height": GDOOR_H, "sillZ": GALLERY_Z},
        "gallery": {"z": GALLERY_Z, "inner": R_TOP, "outer": GALLERY_OUT, "thickness": GALLERY_T,
                    "railRadius": round(GALLERY_OUT - 0.1, 4), "railHeight": GALLERY_RAIL_H},
        "runeRings": [{"name": n, "z": z, "radius": r6(r), "tiltRadians": r6(t), "tiltAxisAngle": y}
                      for n, z, r, t, y in rings],
        "lampGlass": {"radius": GLASS_R, "z": [PARAPET_Z, GLASS_Z1]},
        "crystalCenterZ": CRYSTAL_Z,
        "counts": counts,
    }
    with open(path, "w") as fh:
        json.dump(data, fh, indent=1)
    return data


def build():
    B.reset()
    mb = B.MeshBuilder()
    P = Parts(mb, 2201)
    tally, counts = {}, {}

    def run(fn):
        s = sum(len(f) - 2 for f in mb.faces)
        res = fn(mb, P)
        tally[fn.__name__[6:]] = sum(len(f) - 2 for f in mb.faces) - s
        return res

    run(build_shell)
    run(build_stair)
    run(build_gallery)
    run(build_lamp_room)
    counts["windows"] = run(build_windows)
    counts["innerGlyphs"] = run(build_inner_runes)
    counts["lanterns"] = run(build_lanterns)
    run(build_veins)

    top = max(v[2] for v in mb.verts)
    for k, v in enumerate(mb.verts):
        r, g, b, a = mb.cols[k]
        mb.cols[k] = (max(0.0, min(1.0, v[2] / top)), g, b, a)

    main = mb.build("DreamLighthouse", [MATS[n]() for n in MAIN_MATS], smooth=False)
    assert len(main.data.polygons) == len(mb.faces), "mesh.validate() dropped faces; smooth ranges would drift"
    for s, e in P.smooth:
        for p in main.data.polygons[s:e]:
            p.use_smooth = True
    crystal = build_crystal().build("StarCrystal", [MATS["star_crystal"]()], smooth=False, parent=main,
                                    location=(0, 0, CRYSTAL_Z))
    rings, ring_objs = [], []
    for i, (z, gap, tilt, yaw) in enumerate(RINGS):
        o, radius = build_rune_ring(i, z, gap, tilt, yaw, main)
        for k, c in enumerate(o.data.color_attributes[0].data):
            c.color = (max(0.0, min(1.0, (o.data.vertices[k].co.z + z) / top)), *tuple(c.color)[1:])
        rings.append((o.name, z, radius, tilt, yaw))
        ring_objs.append(o)

    os.makedirs(B.OUT, exist_ok=True)
    data = write_json(os.path.join(B.OUT, "lighthouse.json"), rings, counts)
    print(f"[lighthouse] tris by part {tally}")
    total = 0
    for o in [main, crystal] + ring_objs:
        total += tri_count(o)
        print(f"[lighthouse] {o.name}: {tri_count(o)} tris, mats {[m.name for m in o.data.materials]}")
    print(f"[lighthouse] total {total} tris; stair {STEPS} treads, {data['stair']['turns']} turns, a={A:.5f}, "
          f"outer depth top {data['stair']['minOuterTreadDepth']:.3f} m, gallery door {GDOOR_ANGLE:.4f}, {counts}")
    B.export("lighthouse")


if __name__ == "__main__":
    build()
