"""The Dream Lighthouse: a climbable, rune-wrapped tower with a floating star crystal in its lamp room.

Run headless:  blender -b --factory-startup --python tools/blender/lighthouse.py -- <out_dir>
Writes <out_dir>/lighthouse.glb, <out_dir>/lighthouse.json (walkable geometry) and export/fbx/lighthouse.fbx.

Blender Z-up, origin at the ground centre of the tower base. Objects:
  DreamLighthouse   everything static
    StarCrystal     child, origin at its own centre (the game spins and bobs it)

Vertex colours (COLOR_0): R height through the whole asset 0..1, G 0 solid / 0.5 glow, B per-part random.

The exterior stair is computed from the constants below and the same numbers go to lighthouse.json, so the
collision the game builds from the JSON matches the treads exactly: tread i has its top at (i+1)*RISE and spans
angles [i*A, (i+1)*A] counter-clockwise from +X, radially from the tower wall at that height out WIDTH metres.
"""
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_assets as B  # noqa: E402

from mathutils import Vector  # noqa: E402

TAU = 2 * math.pi
UP = Vector((0, 0, 1))

R_BASE, R_TOP = 3.2, 2.4
GALLERY_Z = 22.0
RISE = 0.25
STEPS = round(GALLERY_Z / RISE) - 1          # the gallery floor itself is the step after the last tread
TURNS = 2.25                                 # measured to the gallery arrival edge
A = TAU * TURNS / (STEPS + 1)
WIDTH = 1.3
TREAD_T = 0.32                               # thicker than the rise so treads overlap into one solid flight
STAIR_RAIL_H = 0.9
GALLERY_OUT = 4.4
GALLERY_T = 0.4
GALLERY_RAIL_H = 1.0
# The gallery floor is cut away above the last treads so climbers keep >2 m headroom under its slab.
OPEN_STEPS = 10
DOOR_ANGLE = -0.30                           # just clockwise of the stair foot, so the first treads clear it
DOOR_W, DOOR_SPRING = 1.2, 1.75
PLINTH = ((5.6, 0.06), (4.9, 0.2))           # (radius, top z), outer apron then the raised plinth
GLASS_Z0, GLASS_Z1, GLASS_R = 23.02, 25.8, 2.15
CRYSTAL_Z = 24.4


def tower_r(z):
    z = max(0.0, min(GALLERY_Z, z))
    return R_BASE + (R_TOP - R_BASE) * z / GALLERY_Z


def tread(i):
    top = (i + 1) * RISE
    inner = tower_r(top)
    return dict(top=top, a0=i * A, a1=(i + 1) * A, inner=inner, outer=inner + WIDTH)


def stair_line(th):
    """Height of the stair's walking line at angle th (unwrapped): through the middle of each tread's rise."""
    return RISE * th / A + RISE / 2


def radial(th):
    return Vector((math.cos(th), math.sin(th), 0.0))


def tangent(th):
    return Vector((-math.sin(th), math.cos(th), 0.0))


def polar(r, th, z):
    return Vector((r * math.cos(th), r * math.sin(th), z))


OPEN_FROM, OPEN_TO = (STEPS - OPEN_STEPS) * A, STEPS * A


def under_floor(th, clearance):
    """True if no tread top lies within `clearance` below the gallery slab's underside at angle th."""
    for i in range(STEPS):
        t = tread(i)
        rel = (th - t["a0"]) % TAU
        if rel <= t["a1"] - t["a0"] and GALLERY_Z - GALLERY_T - t["top"] < clearance:
            return False
    return True


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


# ---------------------------------------------------------------- the build

class Parts:
    """Tracks which faces get smooth shading (round things) and hands out per-part colours."""

    def __init__(self, mb, seed):
        self.mb, self.rnd, self.smooth = mb, random.Random(seed), []

    def col(self, glow=False):
        return (0.0, 0.5 if glow else 0.0, self.rnd.random())

    def fn(self, glow=False):
        c = self.col(glow)
        return lambda t: c

    def mark_smooth(self, start):
        self.smooth.append((start, len(self.mb.faces)))


def build_tower(mb, P):
    levels = [0.0, 1.6, 10.6, 12.4, GALLERY_Z]
    prof = [(tower_r(z), z) for z in levels] + [(R_TOP, 22.85), (2.52, 22.9), (2.52, GLASS_Z0), (0, GLASS_Z0)]

    def mat_fn(i):
        zm = (prof[i][1] + prof[i + 1][1]) / 2
        if zm < 1.6:
            return STONE
        if 10.6 < zm < 12.4 or zm > 22.86:
            return BAND
        return WHITE

    s = len(mb.faces)
    B.lathe(mb, prof, 48, col_fn=P.fn(), mat_fn=mat_fn)
    P.mark_smooth(s)

    # Worn plinth and a looser paved apron; the outer rims wander a little but the tops stay flat to walk on.
    for (r, top), z0, k in ((PLINTH[0], -0.3, 7), (PLINTH[1], -0.1, 11)):
        wob = lambda t, a, k=k: 1.0 + (0.018 * math.sin(a * k + 1.3) + 0.008 * math.sin(a * 3 + 0.4)) * (t < 0.99)
        B.lathe(mb, [(r, z0), (r, top - 0.07), (r - 0.08, top), (R_BASE - 0.1, top)], 36, STONE, col_fn=P.fn(),
                radial_fn=wob)


def build_stair(mb, P):
    for i in range(STEPS):
        t = tread(i)
        col = P.col()
        top, bot = t["top"], t["top"] - TREAD_T
        secs = []
        for a in (t["a0"], t["a1"]):
            secs.append([mb.v(polar(r, a, z), col) for r, z in
                         ((t["inner"] - 0.04, top), (t["outer"], top), (t["outer"], bot), (t["inner"] - 0.04, bot))])
        B.rings_loft(mb, secs, STONE)
        if i >= 3:
            am = (t["a0"] + t["a1"]) / 2
            d, tg = radial(am), tangent(am)
            rw = tower_r(bot) - 0.06
            B.extrude(mb, [(rw, bot + 0.01), (t["inner"] + 0.85, bot + 0.01), (rw, bot - 0.75)],
                      -tg * 0.11, d, UP, tg, 0.22, STONE, col)

    # Railing: posts every third tread on the outer edge, one continuous top rail through their heads.
    rail_r = lambda i: tread(i)["outer"] - 0.08
    for i in range(1, STEPS, 3):
        t = tread(i)
        am = (t["a0"] + t["a1"]) / 2
        base = polar(rail_r(i), am, t["top"])
        B.limb(mb, [base, base + UP * STAIR_RAIL_H], [0.03, 0.03], segments=4, mat=IRON, col_fn=P.fn())
        if i % 9 == 4:
            B.sphere(mb, base + UP * (STAIR_RAIL_H + 0.08), 0.08, u=6, v=3, mat=WINDOW, col=P.col(True))
    path = [polar(rail_r(0), 0.04, RISE + STAIR_RAIL_H)]
    for i in range(STEPS):
        t = tread(i)
        path.append(polar(rail_r(i), (t["a0"] + t["a1"]) / 2, t["top"] + STAIR_RAIL_H))
    path.append(polar(rail_r(STEPS - 1), STEPS * A, STEPS * RISE + STAIR_RAIL_H))
    s = len(mb.faces)
    B.limb(mb, path, [0.035] * len(path), segments=4, mat=IRON, col_fn=P.fn())
    P.mark_smooth(s)


def build_gallery(mb, P):
    a0, a1 = OPEN_TO, OPEN_FROM + TAU
    n = max(2, round((a1 - a0) / 0.13))
    angles = [a0 + (a1 - a0) * k / n for k in range(n + 1)]
    z1, z0 = GALLERY_Z, GALLERY_Z - GALLERY_T
    for prof, mat in (([(R_TOP - 0.05, z1), (GALLERY_OUT - 0.08, z1), (GALLERY_OUT - 0.08, z0), (R_TOP - 0.05, z0)],
                       STONE),
                      ([(GALLERY_OUT - 0.08, z1), (GALLERY_OUT, z1), (GALLERY_OUT, z0 - 0.06),
                        (GALLERY_OUT - 0.08, z0 - 0.06)], BAND)):
        col = P.col()
        B.rings_loft(mb, [[mb.v(polar(r, a, z), col) for r, z in prof] for a in angles], mat)

    # Corbels under the slab, left out wherever they would crowd the stair beneath.
    for k in range(16):
        a = TAU * (k + 0.5) / 16
        if not under_floor(a, 3.2) or a0 + (a - a0) % TAU > a1:
            continue
        d, tg = radial(a), tangent(a)
        B.extrude(mb, [(tower_r(z0) - 0.06, z0 + 0.01), (GALLERY_OUT - 0.2, z0 + 0.01), (tower_r(z0 - 1.3) - 0.06, z0 - 1.3)],
                  -tg * 0.15, d, UP, tg, 0.3, WHITE, P.col())

    # Railing round the outer edge, plus rails across both edges of the stairwell opening.
    rr = GALLERY_OUT - 0.1
    rail_pts = lambda h: [polar(rr, a, z1 + h) for a in angles]
    for h, rad in ((GALLERY_RAIL_H, 0.04), (GALLERY_RAIL_H * 0.5, 0.025)):
        s = len(mb.faces)
        B.limb(mb, rail_pts(h), [rad] * len(angles), segments=4, mat=IRON, col_fn=P.fn())
        P.mark_smooth(s)
    posts = max(2, round((a1 - a0) * rr / 1.3))
    for k in range(posts + 1):
        a = a0 + (a1 - a0) * k / posts
        base = polar(rr, a, z1)
        B.limb(mb, [base, base + UP * GALLERY_RAIL_H], [0.035, 0.035], segments=4, mat=IRON, col_fn=P.fn())
        if k % 2 == 0:
            B.sphere(mb, base + UP * (GALLERY_RAIL_H + 0.1), 0.1, u=6, v=3, mat=WINDOW, col=P.col(True))
    for a, r_in in ((a1, R_TOP), (a0, tread(STEPS - 1)["outer"] - 0.08)):
        ends = [polar(r_in, a, z1), polar(rr, a, z1)]
        for h, rad in ((GALLERY_RAIL_H, 0.04), (GALLERY_RAIL_H * 0.5, 0.025)):
            B.limb(mb, [p + UP * h for p in ends], [rad, rad], segments=5, mat=IRON, col_fn=P.fn())
        B.limb(mb, [ends[0], ends[0] + UP * GALLERY_RAIL_H], [0.035, 0.035], segments=4, mat=IRON, col_fn=P.fn())

    # Chains of small glowing orbs hanging off the slab's rim.
    rnd = random.Random(2207)
    placed = 0
    for k in range(40):
        a = a0 + 0.3 + (a1 - a0 - 0.6) * k / 39
        if placed >= 6 or k % 6:
            continue
        top = polar(GALLERY_OUT - 0.25, a, z0 - 0.02)
        count = rnd.randint(3, 6)
        bottom = top - UP * (0.45 * count + 0.1)
        B.limb(mb, [top, bottom], [0.012, 0.012], segments=3, mat=IRON, col_fn=P.fn())
        c = P.col(True)
        for j in range(count):
            B.sphere(mb, top - UP * (0.45 * (j + 1)), 0.09 + 0.035 * (j == count - 1), u=5, v=3, mat=WINDOW, col=c)
        placed += 1


def build_lamp_room(mb, P):
    s = len(mb.faces)
    B.lathe(mb, [(GLASS_R, GLASS_Z0), (GLASS_R, GLASS_Z1)], 16, GLASS, col_fn=P.fn(True), cap_bottom=False,
            cap_top=False)
    P.mark_smooth(s)
    for k in range(8):
        a = TAU * (k + 0.5) / 8
        d = radial(a)
        B.plank(mb, polar(GLASS_R + 0.02, a, GLASS_Z0), polar(GLASS_R + 0.02, a, GLASS_Z1), 0.09, 0.07, up=d,
                mat=IRON, col=P.col())
    # A rune halo on the lamp-room floor under the crystal.
    ring = [polar(0.8, TAU * k / 16, GLASS_Z0 + 0.08) for k in range(16)]
    B.limb(mb, ring, [0.05] * 16, segments=4, mat=RUNE, col_fn=P.fn(True), closed=True)

    roof = [(r, GLASS_Z1 + z) for r, z in
            ((2.7, -0.05), (2.95, 0.1), (2.4, 0.28), (2.5, 0.7), (2.32, 1.15), (1.85, 1.6), (1.2, 2.0), (0.6, 2.38),
             (0.25, 2.72), (0.08, 3.05), (0, 3.2))]
    ROOF_TOP = GLASS_Z1 + 3.2
    s = len(mb.faces)
    B.lathe(mb, roof, 24, BAND, col_fn=P.fn())
    P.mark_smooth(s)

    # Finial: rod, gold orb, crescent-moon vane and a star glint on the tip.
    B.limb(mb, [Vector((0, 0, ROOF_TOP - 0.2)), Vector((0, 0, ROOF_TOP + 1.45))], [0.035, 0.03], segments=5, mat=IRON, col_fn=P.fn())
    B.sphere(mb, (0, 0, ROOF_TOP + 0.2), 0.13, u=8, v=5, mat=WINDOW, col=P.col(True))
    vane = plane_map((0, 0, 0), (1, 0, 0), (0, 0, 1))
    region(mb, vane, crescent(0.34, 0.15, math.radians(160), math.radians(380), 12, 0, ROOF_TOP + 0.85),
           -0.03, 0.03, RUNE, P.col(True), back=True)
    for U, V in (((1, 0, 0), (0, 0, 1)), ((0, 1, 0), (0, 0, 1))):
        region(mb, plane_map((0, 0, ROOF_TOP + 1.6), U, V), ("star", four_star(0.22, 0.14, 0.035)), -0.02, 0.02, RUNE,
               P.col(True), back=True)


def build_door(mb, P):
    m = wall_map(DOOR_ANGLE, PLINTH[1][1])
    hw, sp = DOOR_W / 2, DOOR_SPRING

    def arch(w, n=10):
        pts = [(-w, 0.0), (-w, sp)]
        pts += [(-w * math.cos(math.pi * k / n), sp + w * math.sin(math.pi * k / n)) for k in range(1, n)]
        return pts + [(w, sp), (w, 0.0)]

    region(mb, m, ("poly", arch(hw)), -0.06, 0.03, WINDOW, P.col(True))
    region(mb, m, ("band", arch(hw + 0.22), arch(hw), False), -0.06, 0.17, STONE, P.col())
    for u0, u1 in ((-hw, -0.09), (0.09, hw)):
        region(mb, m, ("poly", [(u0, 0.0), (u1, 0.0), (u1, sp - 0.05), (u0, sp - 0.05)]), 0.0, 0.08, WOOD, P.col())
    for k in (1, 2, 3):
        a = math.pi * k / 4
        region(mb, m, stroke((0, sp), (math.cos(a) * hw, sp + math.sin(a) * hw), 0.025), 0.0, 0.07, IRON, P.col())
    region(mb, wall_map(DOOR_ANGLE, PLINTH[1][1] + sp + hw + 0.45), ("star", four_star(0.2, 0.14, 0.04)), 0.0, 0.06,
           RUNE, P.col(True))
    for s in (-1, 1):
        lamp = wall_map(DOOR_ANGLE + s * (hw + 0.5) / tower_r(1.8), 1.9)
        region(mb, lamp, ("star", four_star(0.16, 0.11, 0.035)), 0.0, 0.06, WINDOW, P.col(True))


def build_runes(mb, P):
    off = 4.9  # half the stair's pitch, so the band runs midway between its turns
    z_of = lambda th: stair_line(th) + off
    th_of = lambda z: (z - off - RISE / 2) * A / RISE
    th0, th1 = th_of(1.9), th_of(19.8)
    for dv in (-0.52, 0.52):
        n = round((th1 - th0) / 0.12)
        L = [(th0 + (th1 - th0) * k / n, z_of(th0 + (th1 - th0) * k / n) + dv - 0.03) for k in range(n + 1)]
        R = [(u, v + 0.06) for u, v in L]
        region(mb, helix_map, ("band", L, R, False), -0.02, 0.025, RUNE, P.col(True), sides=False)
    order = ["star", "algiz", "ring", "tiwaz", "moon", "sowilo", "star", "othala", "algiz", "ring", "tiwaz", "moon"]
    th, k = th0 + 0.15, 0
    while th < th1 - 0.1:
        z = z_of(th)
        for shape in map(lambda sh: scaled(sh, 1.4), GLYPHS[order[k % len(order)]]()):
            region(mb, wall_map(th, z), shape, -0.02, 0.045, RUNE, P.col(True))
        th += 1.15 / tower_r(z)
        k += 1
    return k


WINDOWS = [(1.0 + 2 * k, 2.75) for k in range(6)] + [(-2.0 + 2 * k, 7.2) for k in range(6)]


def build_windows(mb, P):
    count = 0
    for th, off in WINDOWS:
        z = stair_line(th) + off
        if not 3.0 < z < 20.2:
            continue
        d = radial(th)
        rot = UP.rotation_difference(d).to_matrix()
        base = polar(tower_r(z), th, z)
        s = len(mb.verts)
        B.lathe(mb, [(0.3, -0.1), (0.44, -0.1), (0.44, 0.08), (0.3, 0.11), (0.3, -0.1)], 10, WHITE,
                col_fn=P.fn(), cap_bottom=False, cap_top=False)
        B.lathe(mb, [(0.31, -0.06), (0.31, 0.04), (0, 0.06)], 10, WINDOW, col_fn=P.fn(True), cap_bottom=False)
        B.xform(mb, s, lambda p: rot @ p + base)
        # Mullion cross in the glow so it reads as a window, not a lamp.
        for a in (0.0, math.pi / 2):
            m = wall_map(th, z)
            region(mb, m, stroke((-0.31 * math.cos(a), -0.31 * math.sin(a)), (0.31 * math.cos(a), 0.31 * math.sin(a)),
                                 0.022), 0.0, 0.075, IRON, P.col())
        count += 1
    return count


def build_crystal():
    """Two crossed four-point star lenses (XZ and YZ planes), origin at the centre."""
    mb = B.MeshBuilder()
    rnd = random.Random(2290)
    star = four_star(1.1, 0.85, 0.24)
    for U, V, N in (((1, 0, 0), (0, 0, 1), (0, -1, 0)), ((0, 1, 0), (0, 0, 1), (1, 0, 0))):
        U, V, N = Vector(U), Vector(V), Vector(N)
        col = (0.0, 0.5, rnd.random())
        ring = [mb.v(U * u + V * v, col) for u, v in star]
        front, back = mb.v(N * 0.36, col), mb.v(-N * 0.36, col)
        n = len(ring)
        for i in range(n):
            j = (i + 1) % n
            mb.f((front, ring[i], ring[j]), 0)
            mb.f((back, ring[j], ring[i]), 0)
    # Orient outward: positive signed volume.
    vol = sum(Vector(mb.verts[f[0]]).dot(Vector(mb.verts[f[1]]).cross(Vector(mb.verts[f[2]]))) for f in mb.faces)
    if vol < 0:
        mb.faces = [tuple(reversed(f)) for f in mb.faces]
    for i, (x, y, z) in enumerate(mb.verts):
        r, g, b, a = mb.cols[i]
        mb.cols[i] = ((z + 1.1) / 2.2, g, b, a)
    return mb


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def write_json(path, n_glyphs, n_windows):
    treads = [tread(i) for i in range(STEPS)]
    r4 = lambda x: round(x, 6)
    data = {
        "units": "metres, Blender Z-up; glTF/three: (x, y, z)_three = (x, z, -y)_blender. Angles are radians "
                 "counter-clockwise seen from above from +X (in three: atan2(-z, x)); the mapping is a proper "
                 "rotation so ccw stays ccw from above.",
        "towerRadius": [R_BASE, R_TOP],
        "towerRadiusRule": f"r(z) = {R_BASE} - {R_BASE - R_TOP:g} * z / {GALLERY_Z} for 0 <= z <= {GALLERY_Z}; "
                           f"{R_TOP} above (lamp-room parapet to z={GLASS_Z0})",
        "plinth": [{"radius": r, "top": z} for r, z in PLINTH],
        "gallery": {
            "z": GALLERY_Z, "inner": R_TOP, "outer": GALLERY_OUT, "thickness": GALLERY_T,
            "railHeight": GALLERY_RAIL_H, "railRadius": round(GALLERY_OUT - 0.1, 4),
            "opening": {"from": r4(OPEN_FROM), "to": r4(OPEN_TO), "fromMod2Pi": r4(OPEN_FROM % TAU),
                        "toMod2Pi": r4(OPEN_TO % TAU),
                        "note": "no floor over [from, to] (ccw, radially inner..outer): the stairwell. The stair "
                                "arrives at angle `to`; a rail closes the `from` edge."},
        },
        "stair": {
            "startAngle": 0.0, "turnDirection": "ccw", "rise": RISE, "anglePerStep": r4(A), "steps": STEPS,
            "turns": r4(STEPS * A / TAU), "firstTreadTop": RISE, "lastTreadTop": STEPS * RISE,
            "arrivalAngle": r4(STEPS * A), "width": WIDTH, "treadThickness": TREAD_T,
            "inner": [r4(treads[0]["inner"]), r4(treads[-1]["inner"])],
            "outer": [r4(treads[0]["outer"]), r4(treads[-1]["outer"])],
            "innerRule": "inner_i = towerRadius((i+1)*rise); outer_i = inner_i + width",
            "treadRule": "tread i: top z=(i+1)*rise, angles [startAngle+i*a, startAngle+(i+1)*a], radii "
                         "[inner_i, outer_i], solid down to top-treadThickness",
            "innerPerStep": [r4(t["inner"]) for t in treads],
            "outerPerStep": [r4(t["outer"]) for t in treads],
            "minOuterTreadDepth": r4(treads[-1]["outer"] * A),
            "railHeight": STAIR_RAIL_H, "railInset": 0.08,
        },
        "door": {"angle": DOOR_ANGLE, "width": DOOR_W, "height": round(DOOR_SPRING + DOOR_W / 2, 3),
                 "sillZ": PLINTH[1][1]},
        "lampGlass": {"radius": GLASS_R, "z": [GLASS_Z0, GLASS_Z1]},
        "crystalCenterZ": CRYSTAL_Z,
        "glyphs": n_glyphs, "windows": n_windows,
    }
    with open(path, "w") as fh:
        json.dump(data, fh, indent=1)
    return data


def build():
    B.reset()
    mb = B.MeshBuilder()
    P = Parts(mb, 2201)
    tally = {}

    def run(fn):
        s = sum(len(f) - 2 for f in mb.faces)
        res = fn(mb, P)
        tally[fn.__name__[6:]] = sum(len(f) - 2 for f in mb.faces) - s
        return res

    run(build_tower)
    run(build_stair)
    run(build_gallery)
    run(build_lamp_room)
    run(build_door)
    n_glyphs = run(build_runes)
    n_windows = run(build_windows)
    print(f"[lighthouse] tris by part {tally}")

    top = max(v[2] for v in mb.verts)
    for i, v in enumerate(mb.verts):
        r, g, b, a = mb.cols[i]
        mb.cols[i] = (max(0.0, min(1.0, v[2] / top)), g, b, a)

    main = mb.build("DreamLighthouse", [MATS[n]() for n in MAIN_MATS], smooth=False)
    assert len(main.data.polygons) == len(mb.faces), "mesh.validate() dropped faces; smooth ranges would drift"
    for s, e in P.smooth:
        for p in main.data.polygons[s:e]:
            p.use_smooth = True
    crystal = build_crystal().build("StarCrystal", [MATS["star_crystal"]()], smooth=False, parent=main,
                                    location=(0, 0, CRYSTAL_Z))

    os.makedirs(B.OUT, exist_ok=True)
    data = write_json(os.path.join(B.OUT, "lighthouse.json"), n_glyphs, n_windows)
    for o in (main, crystal):
        print(f"[lighthouse] {o.name}: {tri_count(o)} tris, mats {[m.name for m in o.data.materials]}")
    print(f"[lighthouse] stair {STEPS} treads, {data['stair']['turns']} turns, a={A:.5f} rad, "
          f"outer depth top {data['stair']['minOuterTreadDepth']:.3f} m, glyphs {n_glyphs}, windows {n_windows}")
    B.export("lighthouse")


if __name__ == "__main__":
    build()
