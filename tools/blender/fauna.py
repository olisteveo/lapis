"""Dream creatures (fauna.glb) and one-of-a-kind wonder landmarks (wonders.glb) for Lapis.

Run headless:  blender -b --factory-startup --python tools/blender/fauna.py -- <out_dir> [fauna|wonders]
Reuses the builders in build_assets.py; Blender Z-up, every random stream seeded.

fauna.glb (animated in the vertex shader, COLOR_0):
  Walkers (StarDeer, Tortoise) face +X, origin on the ground between the feet.
    R  leg swing weight = clamp((HIP_Z - z) / HIP_Z): 0 at (and above) the hip pivot, 1 at the hoof / foot.
       Linear in z, so a rotation of theta about the hip axis is  dx = theta * R * HIP_Z  (small angle).
    G  1 legs, 0 body / head / antlers / shell, 0.5 StarDeer antler star buds
    B  leg gait phase: front-left 0.0, back-right 0.25, front-right 0.5, back-left 0.75; 0 elsewhere
    All hips of one creature share one pivot height:  StarDeer HIP_Z = 1.25 m,  Tortoise HIP_Z = 3.0 m.
    Left is +Y (facing +X, Z up).
  Fliers (SkyManta, Moth) face +X, origin at the centre of mass.
    R  0 at the body -> 1 at the wing / tail tip    G  1 wings and tail, 0 body    B  0
wonders.glb (static props, origin at ground contact, z = 0 ground / waterline):
    R  height gradient through the object (0 ground -> 1 top) on solid parts; 0 -> 1 root to tip on sway parts
    G  0 solid, 0.5 glow (moonblossoms, mushroom glow), 1 parts that may sway (foliage, hanging roots / grass)
    B  per-part random
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_assets as B   # reuse MeshBuilder, tube, ptube, sphere, material, smoothstep, reset, export, etc.

import math
import random

import bpy
from mathutils import Matrix, Vector

V = Vector
UP = Vector((0, 0, 1))
X = Vector((1, 0, 0))
Y = Vector((0, 1, 0))
ss = B.smoothstep

DEER_HIP_Z = 1.25
TORTOISE_HIP_Z = 3.0
TORTOISE_MOUND_TOP = 7.5   # flat top of the planting mound (crown rises 0.08 m more at its centre)
TORTOISE_MOUND_R = 1.7     # radius of the flat part, centred on x = MOUND_X, y = 0
TORTOISE_MOUND_X = -0.3
GAIT = {"FL": 0.0, "BR": 0.25, "FR": 0.5, "BL": 0.75}


def clamp01(x):
    return max(0.0, min(1.0, x))


def recolor(mb, start, fn):
    """fn(position, (r, g, b)) -> (r, g, b) for every vertex added since start."""
    for i in range(start, len(mb.verts)):
        r, g, b, _ = mb.cols[i]
        mb.cols[i] = (*fn(V(mb.verts[i]), (r, g, b)), 1.0)


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def signed_volume(obj):
    """Positive when a closed mesh's faces point outward; a cheap winding sanity check."""
    vol = 0.0
    me = obj.data
    for p in me.polygons:
        vs = [me.vertices[i].co for i in p.vertices]
        for k in range(1, len(vs) - 1):
            vol += vs[0].dot(vs[k].cross(vs[k + 1])) / 6.0
    return vol


def section_loft(mb, stations, seg=10, col=(0, 0, 0), origin=(0, 0, 0), fwd=X, up=UP, mat=0, cap=False):
    """Body from (u, zc, half_width, half_height_top, half_height_bottom) stations along fwd; width 0 is a pole."""
    o, fwd, up = V(origin), V(fwd).normalized(), V(up)
    side = up.cross(fwd).normalized()
    up = fwd.cross(side).normalized()
    rings = []
    for u, zc, w, ht, hb in stations:
        c = o + fwd * u + up * zc
        cf = col if callable(col) else (lambda p, c0=col: c0)
        if w <= 0:
            rings.append([mb.v(c, cf(c))])
            continue
        ring = []
        for s in range(seg):
            a = 2 * math.pi * s / seg
            ca, sa = math.cos(a), math.sin(a)
            p = c + side * (w * ca) + up * ((ht if sa > 0 else hb) * sa)
            ring.append(mb.v(p, cf(p)))
        rings.append(ring)
    return B.rings_loft(mb, rings, mat, cap, cap)


def star_bud(mb, c, r, col, mat, stretch=1.7):
    """Elongated octahedron: a four-point sparkle that survives the painterly outline pass."""
    c = V(c)
    ring = [mb.v(c + V((math.cos(a) * r, math.sin(a) * r, 0)), col) for a in (k * math.pi / 2 + 0.4 for k in range(4))]
    t = mb.v(c + V((0, 0, r * stretch)), col)
    b = mb.v(c - V((0, 0, r * stretch)), col)
    for i in range(4):
        j = (i + 1) % 4
        mb.f((t, ring[i], ring[j]), mat)
        mb.f((b, ring[j], ring[i]), mat)


def walker_leg(mb, path, radii, hip_z, phase, seg=7, mat=0, radial_fn=None):
    s = len(mb.verts)
    B.ptube(mb, path, radii, segments=seg, mat=mat, cap_start=True, cap_end=True, radial_fn=radial_fn)
    recolor(mb, s, lambda p, c: (clamp01((hip_z - p.z) / hip_z), 1.0, phase))


def frame_to(vec):
    """Rotation taking +Z onto vec."""
    return UP.rotation_difference(V(vec).normalized()).to_matrix()


# ================================================================ fauna

def build_star_deer():
    """Dream deer, 1.6 m at the withers, long-legged, with a crown of bare starlit branches."""
    rnd = random.Random(2101)
    mb = B.MeshBuilder()
    body = (0.0, 0.0, 0.0)
    torso = [(0.95, 1.36, 0, 0, 0), (0.88, 1.37, 0.12, 0.14, 0.16), (0.76, 1.39, 0.18, 0.2, 0.27),
             (0.55, 1.39, 0.2, 0.22, 0.3), (0.3, 1.38, 0.19, 0.2, 0.27), (0.02, 1.38, 0.17, 0.18, 0.2),
             (-0.28, 1.39, 0.18, 0.18, 0.2), (-0.52, 1.4, 0.2, 0.18, 0.22), (-0.7, 1.39, 0.17, 0.16, 0.2),
             (-0.82, 1.37, 0.11, 0.11, 0.13), (-0.88, 1.35, 0, 0, 0)]
    section_loft(mb, torso, seg=12, col=body)

    neck = [V((0.62, 0, 1.4)), V((0.84, 0, 1.6)), V((0.97, 0, 1.83)), V((1.05, 0, 2.02)), V((1.1, 0, 2.12))]
    B.ptube(mb, neck, [0.17, 0.125, 0.095, 0.085, 0.08], segments=10, col_fn=lambda t: body, cap_start=True)

    hd = V((math.cos(math.radians(-38)), 0, math.sin(math.radians(-38))))
    ho = V((1.08, 0, 2.15))
    head = [(-0.07, 0, 0, 0, 0), (0.0, 0.0, 0.08, 0.09, 0.075), (0.08, -0.005, 0.085, 0.085, 0.08),
            (0.18, -0.01, 0.065, 0.065, 0.07), (0.3, -0.015, 0.048, 0.05, 0.06), (0.39, -0.02, 0.042, 0.042, 0.05),
            (0.43, -0.022, 0.03, 0.03, 0.035), (0.445, -0.024, 0, 0, 0)]
    head_up = hd.cross(Y).normalized()
    section_loft(mb, head, seg=10, col=body, origin=ho, fwd=hd, up=head_up)

    for sgn in (-1, 1):
        # Ears: long leaves held out sideways, the deer's alert silhouette under the antlers.
        root = ho + hd * 0.03 + head_up * 0.05 + Y * (sgn * 0.06)
        d = V((-0.3, sgn * 0.85, 0.35)).normalized()
        wax = V((0.7, 0, 0.7))
        wax = (wax - d * wax.dot(d)).normalized()
        nrm = d.cross(wax).normalized()
        st = []
        for i in range(5):
            s = i / 4
            p = root + d * (0.2 * s)
            w = 0.055 * math.sin(math.pi * min(1.0, 0.2 + 0.85 * s)) + 0.002
            st.append((p + wax * w, p - wax * w, nrm, 0.008, body))
        B.blade_loft(mb, st, cap_start=True)

    B.ptube(mb, [V((-0.84, 0, 1.46)), V((-0.94, 0, 1.49)), V((-1.0, 0, 1.44))], [0.055, 0.05, 0.012],
            segments=6, col_fn=lambda t: body, cap_start=True)

    # Legs: front legs straight with a soft knee; hind legs with the backward hock.
    for sgn in (1, -1):
        y = sgn * 0.12
        front = [(0.57, y * 0.4, 1.42), (0.55, y, 1.2), (0.5, y, 0.98), (0.53, y, 0.76), (0.55, y, 0.55),
                 (0.555, y, 0.33), (0.56, y, 0.12), (0.59, y, 0.05), (0.63, y, 0.005)]
        walker_leg(mb, front, [0.07, 0.11, 0.075, 0.05, 0.044, 0.031, 0.033, 0.035, 0.028], DEER_HIP_Z,
                   GAIT["FL" if sgn > 0 else "FR"])
        y = sgn * 0.125
        hind = [(-0.52, y * 0.4, 1.44), (-0.45, y, 1.16), (-0.38, y, 0.95), (-0.55, y, 0.72), (-0.7, y, 0.55),
                (-0.67, y, 0.35), (-0.63, y, 0.12), (-0.6, y, 0.05), (-0.56, y, 0.005)]
        walker_leg(mb, hind, [0.08, 0.15, 0.085, 0.055, 0.05, 0.032, 0.033, 0.035, 0.028], DEER_HIP_Z,
                   GAIT["BL" if sgn > 0 else "BR"])

    # Antlers: recursive bare branches fanning out like a winter tree; a star bud on every tip.
    bud = (1.0, 0.5, 0.0)

    def branch(p, d, L, r, depth, sgn):
        st = 4 if depth < 2 else 3
        pts = [V(p)]
        dd = V(d)
        for i in range(st):
            dd = (dd + V((rnd.uniform(-0.1, 0.1), rnd.uniform(-0.1, 0.1), rnd.uniform(-0.04, 0.1))) + UP * 0.06).normalized()
            pts.append(pts[-1] + dd * (L / st))
        rads = [r * (1 - 0.5 * i / st) for i in range(st + 1)]
        B.ptube(mb, pts, rads, segments=(6, 5, 4, 3)[min(depth, 3)], col_fn=lambda t: body,
                cap_start=depth == 0, cap_end=False)
        if depth >= 3:
            star_bud(mb, pts[-1] + dd * 0.012, 0.024, bud, 1)
            return
        kids = (0.35, 0.65, 1.0) if depth == 0 else ((0.45, 0.75, 1.0) if depth == 1 else (0.6, 1.0))
        lat = Y * sgn
        for k, t in enumerate(kids):
            f = t * st
            i = min(int(f), st - 1)
            q = pts[i].lerp(pts[i + 1], f - i)
            rq = rads[i] + (rads[i + 1] - rads[i]) * (f - i)
            fan = -1 if (k + depth) % 2 == 0 else 1
            if t >= 1.0:
                nd = dd + X * (fan * 0.3) + lat * 0.15
            else:
                nd = dd * 0.7 + X * (fan * rnd.uniform(0.35, 0.6)) + lat * rnd.uniform(0.25, 0.5) + UP * 0.12
            branch(q, nd.normalized(), L * rnd.uniform(0.62, 0.75), rq * 0.8, depth + 1, sgn)

    for sgn in (-1, 1):
        base = ho + hd * 0.05 + head_up * 0.07 + Y * (sgn * 0.045)
        branch(base, V((-0.15, sgn * 0.6, 0.78)).normalized(), 0.72, 0.036, 0, sgn)

    mats = [B.material("deer", (0.62, 0.55, 0.62)),
            B.material("antler_glow", (1.0, 0.95, 0.75), emission=(1.0, 0.9, 0.6))]
    return mb.build("StarDeer", mats, smooth=True)


MANTA_HALF = 4.5
MANTA_BODY_S = 0.18  # |y| / MANTA_HALF below which vertices are body (G = 0)


def manta_le(s):
    return 1.55 - 3.4 * s ** 1.6


def manta_te(s):
    return -1.9 + 1.2 * ss(0.0, 0.25, s) - 1.15 * ss(0.25, 1.0, s) ** 1.6


def manta_camber(s):
    return -0.4 * s ** 1.6 + 0.55 * ss(0.72, 1.0, s) ** 2


def manta_thick(s):
    return 0.03 + 0.42 * math.exp(-(s / 0.15) ** 2) + 0.09 * (1 - s) ** 2


def manta_prof(c):
    return math.sin(math.pi * min(1.0, c ** 0.75)) ** 0.8


def manta_top(x, y):
    s = min(1.0, abs(y) / MANTA_HALF)
    le, te = manta_le(s), manta_te(s)
    c = clamp01((le - x) / max(1e-4, le - te))
    return manta_camber(s) + manta_thick(s) * manta_prof(c)


def manta_col(y):
    s = abs(y) / MANTA_HALF
    if s <= MANTA_BODY_S:
        return (0.0, 0.0, 0.0)
    return (clamp01((s - MANTA_BODY_S) / (1 - MANTA_BODY_S)), 1.0, 0.0)


def build_sky_manta():
    """Manta ray, 9 m across: swept pointed wings with upturned tips, cephalic horns, whip tail, starry back."""
    rnd = random.Random(2201)
    mb = B.MeshBuilder()
    n_span, n_chord = 18, 9
    ss_ = [((i / n_span) ** 1.25) for i in range(n_span + 1)]
    ys = [-MANTA_HALF * s for s in reversed(ss_[1:])] + [MANTA_HALF * s for s in ss_]
    rings = []
    for y in ys:
        s = abs(y) / MANTA_HALF
        col = manta_col(y)
        le, te, zc, h = manta_le(s), manta_te(s), manta_camber(s), manta_thick(s)
        if s >= 0.999:
            rings.append([mb.v((le, y, zc), col)])
            continue
        top, bot = [], []
        for j in range(n_chord + 1):
            c = j / n_chord
            x = le + (te - le) * c
            pr = manta_prof(c)
            top.append(mb.v((x, y, zc + h * pr), col))
            if 0 < j < n_chord:
                bot.append(mb.v((x, y, zc - 0.55 * h * pr), col))
        rings.append(top + list(reversed(bot)))
    B.rings_loft(mb, rings, 0, False, False)

    # Cephalic lobes: broad paddles either side of the mouth, rolled inward like scrolls.
    for sgn in (-1, 1):
        y0 = sgn * 0.5
        x0 = manta_le(abs(y0) / MANTA_HALF) - 0.12
        z0 = manta_camber(abs(y0) / MANTA_HALF) + 0.04
        st = []
        for i in range(6):
            s = i / 5
            roll = math.radians(80) * s
            p = V((x0 + 0.62 * s, y0 - sgn * 0.08 * s, z0 - 0.12 * s))
            w = 0.16 * (1 - 0.3 * s)
            across = V((0, sgn * math.cos(roll), -math.sin(roll)))
            nrm = V((0, sgn * math.sin(roll), math.cos(roll)))
            st.append((p + across * w, p - across * w, nrm, 0.035 * (1 - 0.5 * s), (0.0, 0.0, 0.0)))
        B.blade_loft(mb, st, cap_start=True)

    # Tail: a long whip from the pelvic notch.
    x0 = manta_te(0.0) + 0.15
    path = [V((x0 - 4.6 * t, 0.06 * math.sin(t * 5), 0.15 * math.sin(t * 3.0) + 0.02)) for t in (i / 12 for i in range(13))]
    s0 = len(mb.verts)
    B.ptube(mb, path, [0.09 * (1 - t) ** 1.2 + 0.006 for t in (i / 12 for i in range(13))], segments=5,
            cap_start=True)
    recolor(mb, s0, lambda p, c: (clamp01((x0 - p.x) / 4.6), 1.0, 0.0))
    # Pelvic fins: small flaps flanking the tail root.
    for sgn in (-1, 1):
        st = []
        for i in range(3):
            s = i / 2
            p = V((manta_te(0.0) + 0.35 - 0.3 * s, sgn * (0.2 + 0.25 * s), -0.02))
            st.append((p + V((0.18 * (1 - s), 0, 0)), p - V((0.18 * (1 - s) + 0.02, 0, 0)), V((0, 0, 1)), 0.03, (0.0, 0.0, 0.0)))
        B.blade_loft(mb, st, cap_start=True)

    # Glowing spots: two rows down the spine, then a chevron spray thinning out across the wings.
    spots = []
    for k in range(8):
        x = 0.9 - 0.32 * k
        for sgn in (-1, 1):
            spots.append((x, sgn * (0.2 + 0.03 * k), 0.07 - 0.003 * k))
    for k in range(46):
        s = rnd.uniform(0.12, 0.72) ** 1.1
        y = rnd.choice((-1, 1)) * s * MANTA_HALF
        le, te = manta_le(s), manta_te(s)
        x = le + (te - le) * rnd.uniform(0.2, 0.7)
        spots.append((x, y, (0.075 - 0.06 * s) * rnd.uniform(0.7, 1.2)))
    for x, y, r in spots:
        col = manta_col(y)
        z = manta_top(x, y) + 0.015
        c = mb.v((x, y, z + 0.005), col)
        ring = [mb.v((x + math.cos(a) * r, y + math.sin(a) * r, manta_top(x + math.cos(a) * r, y + math.sin(a) * r) + 0.012), col)
                for a in (2 * math.pi * i / 6 for i in range(6))]
        for i in range(6):
            mb.f((c, ring[i], ring[(i + 1) % 6]), 1)

    # Centre of mass from the planform, weighted by thickness.
    num = den = 0.0
    for k in range(200):
        s = k / 199
        chord = manta_le(s) - manta_te(s)
        a = chord * manta_thick(s)
        num += a * (manta_le(s) + manta_te(s)) / 2
        den += a
    cx = num / den
    B.xform(mb, 0, lambda p: p - V((cx, 0, 0)))
    mats = [B.material("manta", (0.16, 0.2, 0.36)),
            B.material("manta_glow", (0.55, 0.85, 1.0), emission=(0.4, 0.8, 1.0))]
    return mb.build("SkyManta", mats, smooth=True)


def build_moth():
    """0.25 m moth: slim furry body, broad triangular forewings over rounded hindwings, feathered antennae."""
    mb = B.MeshBuilder()
    body = (0.0, 0.0, 0.0)
    B.sphere(mb, (-0.008, 0, 0), 0.012, u=6, v=5, col=body, scale=(2.7, 1.0, 0.95))
    B.sphere(mb, (0.03, 0, 0.002), 0.009, u=5, v=4, col=body)
    for sgn in (-1, 1):
        # Feathered antenna: one small leaf, swept forward and out.
        a0 = V((0.036, sgn * 0.004, 0.007))
        d = V((0.6, sgn * 0.55, 0.45)).normalized()
        side = d.cross(UP).normalized()
        rows = [[mb.v(a0, body)],
                [mb.v(a0 + d * 0.016 - side * 0.006, body), mb.v(a0 + d * 0.018, body), mb.v(a0 + d * 0.016 + side * 0.006, body)],
                [mb.v(a0 + d * 0.036, body)]]
        if sgn < 0:
            rows = [list(reversed(r)) for r in rows]
        B.loft(mb, rows, 0)

        def wing(lead_pts, trail_pts, dz):
            rows = []
            n = len(lead_pts)
            for i in range(n):
                s = i / (n - 1)
                lift = V((0, 0, dz + 0.01 * s * s))
                lead = V((lead_pts[i][0], sgn * lead_pts[i][1], 0)) + lift
                trail = V((trail_pts[i][0], sgn * trail_pts[i][1], 0)) + lift
                col = (s, 1.0, 0.0)
                if (lead - trail).length < 1e-5:
                    rows.append([mb.v(lead, col)])
                    continue
                ids = [mb.v(lead, col), mb.v(lead.lerp(trail, 0.45) + V((0, 0, 0.0025)), col), mb.v(trail, col)]
                rows.append(ids if sgn > 0 else list(reversed(ids)))
            B.loft(mb, rows, 0)

        # Forewing: straight leading edge to a slightly hooked apex, trailing edge sweeping back to the tornus.
        wing([(0.014, 0.006), (0.022, 0.03), (0.029, 0.058), (0.034, 0.086), (0.036, 0.11), (0.03, 0.125)],
             [(-0.008, 0.006), (-0.02, 0.03), (-0.03, 0.058), (-0.032, 0.083), (-0.018, 0.106), (0.03, 0.125)], 0.003)
        # Hindwing: a rounded fan peeking out behind.
        wing([(-0.002, 0.006), (-0.014, 0.03), (-0.028, 0.052), (-0.043, 0.07), (-0.058, 0.074)],
             [(-0.022, 0.005), (-0.042, 0.022), (-0.06, 0.04), (-0.07, 0.058), (-0.058, 0.074)], 0.0)
    return mb.build("Moth", [B.material("moth", (0.85, 0.8, 0.7), True)], smooth=True)


TORTOISE_RIM_Z, TORTOISE_DOME_H = 2.6, 4.6


def tortoise_dome(x, y):
    """Shell surface height at plan position (x, y), before scute grooves."""
    q = math.hypot((x - TORTOISE_MOUND_X) / 5.0, y / 4.15)
    return TORTOISE_RIM_Z + TORTOISE_DOME_H * max(0.0, 1 - q ** 2.2) ** 0.5


def build_tortoise():
    """Ancient giant tortoise, 14 m nose to tail: towering domed shell carrying a little hill, pillar legs."""
    rnd = random.Random(2301)
    mb = B.MeshBuilder()
    A, Bw, cx = 5.0, 4.15, TORTOISE_MOUND_X
    zero = (0.0, 0.0, 0.0)

    # Scute plates as a Voronoi pattern in plan: grooves sink where two plates meet.
    centres = [(cx + 1.75 * k, 0.0) for k in range(-2, 3)]
    for sgn in (-1, 1):
        centres += [(cx + x, sgn * 2.35) for x in (-2.7, -0.9, 0.9, 2.7)]
        for k in range(11):
            a = math.pi * (k + 0.5) / 11
            centres.append((cx + 4.85 * math.cos(a), sgn * 4.05 * math.sin(a)))
    centres += [(cx + 4.9, 0.0), (cx - 4.9, 0.0)]

    def groove(x, y):
        d = sorted(math.hypot(x - a, y - b) for a, b in centres)
        return 1.0 - ss(0.0, 0.5, d[1] - d[0]), d[0]

    def saddle(ca):
        return 0.9 * max(0.0, ca) ** 6 - 0.3 * max(0.0, -ca) ** 4

    sides = 72
    rings = [[mb.v((cx, 0, tortoise_dome(cx, 0) - 0.3), zero)]]
    for q in (0.25, 0.35, 0.44, 0.52, 0.59, 0.65, 0.71, 0.76, 0.81, 0.855, 0.895, 0.93, 0.96, 0.985, 1.0):
        ring = []
        for s in range(sides):
            a = 2 * math.pi * s / sides
            ca, sa = math.cos(a), math.sin(a)
            x, y = cx + A * q * ca, Bw * q * sa
            z = tortoise_dome(x, y) + saddle(ca) * ss(0.8, 1.0, q)
            g, d0 = groove(x, y)
            # Plates sink at their seams and swell toward their centres, like old horn.
            k = -0.13 * g + 0.06 * (1 - ss(0.0, 1.1, d0))
            out = V((x - cx, y, (z - 2.0) * 0.5)).normalized()
            ring.append(mb.v(V((x, y, z)) + out * k, zero))
        rings.append(ring)
    for q, dz in ((1.035, -0.35), (1.015, -0.7), (0.95, -0.8), (0.7, -0.9), (0.35, -0.95)):
        ring = []
        for s in range(sides):
            a = 2 * math.pi * s / sides
            ca, sa = math.cos(a), math.sin(a)
            serr = -0.2 * (s % 2) if q > 1.0 else 0.0  # the serrated marginal edge
            ring.append(mb.v((cx + A * q * ca, Bw * q * sa, TORTOISE_RIM_Z + dz + serr + saddle(ca)), zero))
        rings.append(ring)
    rings.append([mb.v((cx, 0, 1.6), zero)])
    B.rings_loft(mb, rings, 1, False, False)

    # Planting mound: flat crown, soft skirt settling onto (and just into) the shell.
    Rm, zt = TORTOISE_MOUND_R, TORTOISE_MOUND_TOP
    noise = B.lumps(rnd, 0.1)
    mrings = [[mb.v((cx, 0, zt + 0.08), zero)]]
    for r in (0.6, 1.2, Rm, Rm + 0.35, Rm + 0.75, Rm + 1.15, Rm + 1.55, Rm + 2.0):
        ring = []
        for s in range(32):
            a = 2 * math.pi * s / 32
            rr = r * (noise(V((math.cos(a), math.sin(a), 0.0))) if r > Rm else 1.0)
            x, y = cx + rr * math.cos(a), rr * math.sin(a)
            if r <= Rm:
                z = zt + 0.08 * (1 - (r / Rm) ** 2)
            else:
                u = clamp01((r - Rm) / 2.0) ** 1.4
                z = zt * (1 - u) + (tortoise_dome(x, y) - 0.15) * u
            ring.append(mb.v((x, y, z), zero))
        mrings.append(ring)
    B.rings_loft(mb, mrings, 2, False, False)

    # Neck: wrinkled folds rising forward out of the shell.
    neck = [V((3.5, 0, 3.0)), V((4.7, 0, 3.25)), V((5.8, 0, 3.8)), V((6.6, 0, 4.6)), V((7.05, 0, 5.3))]
    pts = []
    for i in range(16):
        t = i / 15
        f = t * (len(neck) - 1)
        k = min(int(f), len(neck) - 2)
        pts.append(neck[k].lerp(neck[k + 1], f - k))
    fold = lambda t, a: 1.0 + 0.09 * math.sin(t * 46) * (0.6 + 0.4 * math.cos(a * 2)) + 0.03 * math.sin(a * 5 + t * 20)
    B.ptube(mb, pts, [1.1 - 0.35 * (i / 15) for i in range(16)], segments=14, mat=0,
            col_fn=lambda t: zero, cap_start=True, cap_end=False, radial_fn=fold)
    hd = V((0.96, 0, -0.12)).normalized()
    hup = hd.cross(Y).normalized()
    ho = V((6.95, 0, 5.45))
    head = [(-0.35, 0.0, 0.78, 0.74, 0.6), (0.1, 0.05, 0.78, 0.72, 0.58), (0.55, 0.04, 0.7, 0.6, 0.52),
            (0.95, 0.0, 0.56, 0.46, 0.44), (1.25, -0.06, 0.4, 0.32, 0.33), (1.45, -0.12, 0.22, 0.18, 0.22),
            (1.52, -0.16, 0, 0, 0)]
    section_loft(mb, head, seg=14, col=zero, origin=ho, fwd=hd, up=hup)
    for sgn in (-1, 1):
        # Heavy brow over a sleepy eye.
        B.sphere(mb, ho + hd * 0.42 + hup * 0.3 + Y * (sgn * 0.5), 0.22, u=8, v=5, col=zero, scale=(1.5, 0.7, 0.6))
        B.sphere(mb, ho + hd * 0.5 + hup * 0.16 + Y * (sgn * 0.56), 0.1, u=6, v=4, col=zero)

    B.ptube(mb, [V((cx - 4.6, 0, 2.3)), V((cx - 5.2, 0, 1.95)), V((cx - 5.55, 0, 1.5))], [0.45, 0.3, 0.05],
            segments=8, col_fn=lambda t: zero, cap_start=True)

    # Legs: elephantine pillars with sagging skin rings and blunt nails, the front pair bowed outward.
    wr = lambda t, a: 1.0 + 0.06 * math.sin(t * 38 + a) * ss(0.1, 0.8, t)
    for name, x, y in (("FL", 3.0, 1), ("FR", 3.0, -1), ("BL", -3.5, 1), ("BR", -3.5, -1)):
        ph = GAIT[name]
        front = x > 0
        fx = 0.3 if front else -0.15
        path = [V((x - (0.5 if front else -0.4), y * 2.0, 3.6)), V((x, y * 2.85, 2.6)), V((x + fx * 0.5, y * 3.2, 1.5)),
                V((x + fx, y * 3.25, 0.55)), V((x + fx, y * 3.25, 0.14)), V((x + fx, y * 3.25, 0.0))]
        walker_leg(mb, path, [1.0, 1.0, 0.88, 0.82, 1.0, 0.92], TORTOISE_HIP_Z, ph, seg=12, radial_fn=wr)
        s0 = len(mb.verts)
        for k in range(4):
            a = (-0.75 + 0.5 * k) + (0.0 if front else math.pi)
            p = V((x + fx + math.cos(a) * 0.97, y * 3.25 + math.sin(a) * 0.97, 0.16))
            B.sphere(mb, p, 0.22, u=6, v=4, col=zero, scale=(1.0, 1.0, 0.8))
        recolor(mb, s0, lambda p, c, ph=ph: (1.0, 1.0, ph))

    mats = [B.material("tortoise_skin", (0.36, 0.34, 0.3)), B.material("tortoise_shell", (0.28, 0.24, 0.2)),
            B.material("tortoise_moss", (0.18, 0.26, 0.15))]
    return mb.build("Tortoise", mats, smooth=True)


def export_fauna():
    B.reset()
    objs = [build_star_deer(), build_sky_manta(), build_moth(), build_tortoise()]
    report(objs)
    B.export("fauna")


# ================================================================ wonders

def report(objs):
    for o in objs:
        print(f"[lapis] {o.name}: {tri_count(o)} tris, volume {signed_volume(o):.2f}")


def whale_spine_z(x):
    ctrl = [(-23.0, -1.6), (-18.0, 0.4), (-12.0, 3.6), (-6.0, 8.2), (0.0, 10.6), (6.0, 9.8), (10.0, 6.6), (13.0, 4.0)]
    return B.catmull(ctrl, x)[0]


def build_whale_skeleton():
    """45 m whale skeleton sinking into sand: rib vault high enough to walk beneath, skull nosing into the dune."""
    rnd = random.Random(3101)
    mb = B.MeshBuilder()

    def tangent(x):
        return V((1.0, 0, (whale_spine_z(x + 0.2) - whale_spine_z(x - 0.2)) / 0.4)).normalized()

    # Vertebrae from the skull back to the tail, shrinking as the column dives into the sand.
    xs, x = [], 12.2
    while x > -23:
        xs.append(x)
        size = 0.55 + 0.45 * ss(-20, 0, x) - 0.25 * ss(6, 12, x)
        x -= 1.15 * size + 0.1
    for i, x in enumerate(xs):
        b = rnd.random()
        col = (0.0, 0.0, b)
        size = 0.55 + 0.45 * ss(-20, 0, x) - 0.25 * ss(6, 12, x)
        p = V((x, 0, whale_spine_z(x)))
        t = tangent(x)  # points toward +X (the head)
        L = 0.85 * size
        disc = lambda tt, a: 1.0 + 0.12 * ss(0.3, 0.0, abs(tt - 0.5))
        B.limb(mb, [p - t * L / 2, p, p + t * L / 2], [0.62 * size] * 3, segments=9, col_fn=lambda tt: col,
               radial_fn=disc)
        up = (UP - t * UP.dot(t)).normalized()
        side = t.cross(up).normalized()
        h = 1.7 * size * (1.0 - 0.5 * ss(-10, -20, x))
        # Neural spines rake back toward the tail; the transverse processes splay like oars.
        tip = p + up * (0.5 * size + h) - t * 0.35 * h
        B.limb(mb, [p + up * 0.4 * size, p + up * (0.5 * size + h * 0.5) - t * 0.12 * h, tip],
               [0.22 * size, 0.17 * size, 0.08 * size], segments=5, col_fn=lambda tt: col,
               radial_fn=lambda tt, a: 1.0 + 0.6 * math.cos(a) ** 2)
        if x < 9:
            for sgn in (-1, 1):
                w = 1.3 * size * (1.0 - 0.6 * ss(-8, -20, x))
                B.limb(mb, [p + side * sgn * 0.4 * size, p + side * sgn * (0.4 * size + w) - up * 0.15 * size],
                       [0.16 * size, 0.07 * size], segments=4, col_fn=lambda tt: col,
                       radial_fn=lambda tt, a: 1.0 + 0.8 * math.sin(a) ** 2)

    # Ribs: tall elliptical arcs from the column out and down into the sand, raked back.
    ribs = [x for x in xs if -9.0 < x < 10.6][::2]
    for k, x in enumerate(ribs):
        zs = whale_spine_z(x)
        span = (4.8 + 3.0 * math.sin(math.pi * clamp01((10.6 - x) / 19.6))) * rnd.uniform(0.95, 1.05)
        for sgn in (-1, 1):
            b = rnd.random()
            col = (0.0, 0.0, b)
            th_max = math.radians(rnd.uniform(108, 116))
            broken = rnd.random() < 0.18
            fallen = rnd.random() < 0.08 and k % 3 == 1
            if fallen:
                continue
            if broken:
                th_max *= rnd.uniform(0.45, 0.7)
            D = (zs + 0.6) / (1 - math.cos(math.radians(112)))
            path = []
            n = 14
            for i in range(n + 1):
                th = th_max * i / n
                path.append(V((x - 0.25 - 1.6 * (i / n) ** 1.2,
                               sgn * (0.7 + span * math.sin(th)),
                               zs - 0.2 - D * (1 - math.cos(th)))))
            rads = [0.44 * (1 - 0.45 * i / n) for i in range(n + 1)]
            B.limb(mb, path, rads, segments=7, col_fn=lambda tt: col,
                   radial_fn=lambda tt, a: 1.0 + 0.35 * math.cos(2 * a),
                   jag=(rnd, 0.35) if broken else None)
            if broken:
                # The snapped-off piece lies in the sand beneath its stump.
                a = rnd.uniform(0, 6.28)
                end = path[-1]
                base = V((end.x + rnd.uniform(-1.5, 1.5), end.y * 1.15, 0.1))
                d = V((math.cos(a), math.sin(a), 0))
                seg = [base + d * (3.0 * i / 4) + V((0, 0, 0.6 * math.sin(math.pi * i / 4))) for i in range(5)]
                B.limb(mb, seg, [0.22, 0.24, 0.22, 0.19, 0.15], segments=6, col_fn=lambda tt: col, jag=(rnd, 0.25))

    # Skull: domed braincase, a long flat rostrum diving into the sand, and the bowed jaws splayed either side.
    col = (0.0, 0.0, rnd.random())
    B.blob(mb, (12.8, 0, 3.7), (3.0, 3.6, 2.5), rnd, u=14, v=9, col=col, rough=0.08, flat=0.3)
    B.blob(mb, (14.8, 0, 3.4), (2.6, 4.2, 1.2), rnd, u=12, v=7, col=col, rough=0.06)
    rost = []
    for i in range(12):
        u = i / 11
        x = 13.8 + 11.4 * u
        # Starts narrow inside the braincase, swells to the broad maxillary plate, then tapers to the tip.
        w = (2.2 + 1.1 * ss(0.0, 0.15, u)) * (1 - u) ** 0.9 + 0.14
        zc = 3.5 - 3.2 * u ** 1.3
        th = 0.55 * (1 - u) + 0.12
        rost.append((x, zc, w, th, th * 0.8))
    rost.append((25.4, 0.15, 0, 0, 0))
    s0 = len(mb.verts)
    section_loft(mb, [(x, 0.0, w, ht, hb) for x, zc, w, ht, hb in rost], seg=10, col=col, origin=(0, 0, 0), cap=True)
    # Lower each station to its own height (section_loft takes a straight axis).
    zs_by_x = {round(x, 4): zc for x, zc, *_ in rost}
    for i in range(s0, len(mb.verts)):
        vx, vy, vz = mb.verts[i]
        key = min(zs_by_x, key=lambda k: abs(k - vx))
        # Upper face gets a raised midline crest: the ridge of the rostrum.
        crest = 0.25 * max(0.0, 1 - abs(vy) / 0.6) if vz > 0 else 0.0
        mb.verts[i] = (vx, vy, vz + zs_by_x[key] + crest)
    for sgn in (-1, 1):
        # Zygomatic arch / eye socket brace from braincase to rostrum.
        B.limb(mb, [V((12.4, sgn * 3.3, 2.8)), V((14.0, sgn * 4.5, 2.6)), V((15.8, sgn * 3.7, 2.8))],
               [0.45, 0.36, 0.38], segments=6, col_fn=lambda tt: col)
        jaw = [V((12.0, sgn * 3.0, 0.5)), V((15.5, sgn * 4.8, 0.6)), V((19.5, sgn * 4.6, 0.5)),
               V((23.0, sgn * 2.9, 0.25)), V((25.9, sgn * 0.9, 0.05))]
        B.limb(mb, jaw, [0.8, 0.85, 0.7, 0.52, 0.32], segments=9, col_fn=lambda tt: col,
               radial_fn=lambda tt, a: 1.0 + 0.3 * math.cos(2 * a))
        # Coronoid hook at the back of each jaw.
        B.limb(mb, [V((13.2, sgn * 3.7, 0.8)), V((13.0, sgn * 3.8, 1.8)), V((12.5, sgn * 3.75, 2.2))],
               [0.42, 0.28, 0.1], segments=5, col_fn=lambda tt: col)

    # One flipper splayed on the sand: shoulder blade, arm and four long fingers.
    col = (0.0, 0.0, rnd.random())
    sc = V((7.2, 7.5, 0.25))
    B.blob(mb, sc, (1.6, 1.9, 0.3), rnd, u=10, v=5, col=col, rough=0.1, rot=Matrix.Rotation(0.5, 3, "Z"))
    arm = [sc + V((0.4, 1.4, 0.1)), sc + V((1.6, 3.0, 0.15)), sc + V((2.5, 4.4, 0.1))]
    B.limb(mb, arm, [0.42, 0.33, 0.34], segments=6, col_fn=lambda tt: col)
    for f in range(4):
        a = math.radians(40 + 16 * f)
        base = arm[-1]
        pts = [base + V((math.cos(a), math.sin(a), 0)) * (0.9 * j) + V((0, 0, 0.12 * math.sin(j))) for j in range(6)]
        rads = [0.2 * (1 - 0.12 * j) for j in range(6)]
        B.limb(mb, pts, rads, segments=5, col_fn=lambda tt: col,
               radial_fn=lambda tt, ang: 1.0 + 0.25 * abs(math.sin(tt * math.pi * 5)))

    B.ramp_r(mb, 0, 0.0, 12.0, skip_g=())
    return mb.build("WhaleSkeleton", [B.material("bone", (0.86, 0.83, 0.74))], smooth=True)


def floating_rock(mb, rnd, R, depth):
    """Inverted mountain: grassy cap with a few boulders, craggy stone underbelly with hanging spurs,
    roots and grass fringes trailing beneath."""
    sides = 18
    noise = B.lumps(rnd, 0.22)
    rim = []
    for s in range(sides):
        a = 2 * math.pi * s / sides
        r = R * noise(V((math.cos(a), math.sin(a), 0.3))) * rnd.uniform(0.88, 1.06)
        rim.append((a, r))
    b = rnd.random()
    grass = (0.0, 0.0, b)
    top_c = mb.v((0, 0, R * 0.16), grass)
    top_rings = []
    for f in (0.35, 0.65, 0.88):
        top_rings.append([mb.v((math.cos(a) * r * f, math.sin(a) * r * f,
                                R * 0.14 * (1 - f * f) + rnd.uniform(-0.04, 0.04) * R), grass) for a, r in rim])
    edge = [mb.v((math.cos(a) * r, math.sin(a) * r, -R * 0.02), grass) for a, r in rim]
    rings_top = [[top_c]] + top_rings + [edge]
    for ra, rb in zip(rings_top, rings_top[1:]):
        for s in range(sides):
            s2 = (s + 1) % sides
            if len(ra) == 1:
                mb.f((ra[0], rb[s], rb[s2]), 1)
            else:
                mb.f((ra[s], rb[s], rb[s2], ra[s2]), 1)
    rock = (0.0, 0.0, b)
    under = [edge, [mb.v((math.cos(a) * r * 1.04, math.sin(a) * r * 1.04, -R * 0.2), rock) for a, r in rim]]
    levels = 7
    off = V((rnd.uniform(-0.3, 0.3) * R, rnd.uniform(-0.3, 0.3) * R, 0))
    for k in range(1, levels):
        t = k / levels
        z = -R * 0.2 - depth * t
        ring = []
        for s, (a, r) in enumerate(rim):
            # Ledges: every other level juts out a little, so the underside reads as strata, not a cone.
            rr = r * (1 - t) ** 0.7 * rnd.uniform(0.75, 1.12) * (1.08 if k % 2 else 0.95)
            ring.append(mb.v((off.x * t + math.cos(a) * rr, off.y * t + math.sin(a) * rr,
                              z + rnd.uniform(-0.35, 0.35) * depth / levels), rock))
        under.append(ring)
    under.append([mb.v((off.x, off.y, -R * 0.2 - depth * rnd.uniform(1.0, 1.15)), rock)])
    for ra, rb in zip(under, under[1:]):
        for s in range(sides):
            s2 = (s + 1) % sides
            if len(rb) == 1:
                mb.f((ra[s], rb[0], ra[s2]), 0)
            else:
                mb.f((ra[s], rb[s], rb[s2], ra[s2]), 0)

    # Secondary spurs hanging off the underbelly.
    for k in range(rnd.randint(2, 4)):
        a = rnd.uniform(0, 6.28)
        t = rnd.uniform(0.2, 0.45)
        r = R * (1 - t) ** 0.7 * 0.7
        c = V((off.x * t + math.cos(a) * r, off.y * t + math.sin(a) * r, -R * 0.2 - depth * t))
        h = depth * rnd.uniform(0.3, 0.5)
        rs = R * rnd.uniform(0.16, 0.24)
        tilt = Matrix.Rotation(rnd.uniform(-0.25, 0.25), 3, "X") @ Matrix.Rotation(rnd.uniform(-0.25, 0.25), 3, "Y")
        s0 = len(mb.verts)
        # A craggy stalactite: a jagged hexagonal cone pointing down.
        B.lathe(mb, [(0.0, -h), (rs * 0.35, -h * 0.6), (rs * 0.8, -h * 0.25), (rs, 0.0), (0.0, rs * 0.5)], 6, 0,
                col_fn=lambda t: rock, rot=rnd.uniform(0, 1), radial_fn=lambda t, a: 1.0 + 0.25 * math.sin(a * 3 + t * 7),
                cap_bottom=False, cap_top=False)
        B.xform(mb, s0, lambda p: tilt @ p + c)
    # Boulders on the cap.
    for k in range(rnd.randint(1, 3)):
        a = rnd.uniform(0, 6.28)
        f = rnd.uniform(0.2, 0.7)
        rr = R * rnd.uniform(0.08, 0.15)
        c = V((math.cos(a) * R * f * 0.9, math.sin(a) * R * f * 0.9, R * 0.14 * (1 - f * f) + rr * 0.3))
        B.blob(mb, c, (rr * 1.3, rr, rr * 0.8), rnd, u=7, v=5, mat=0, col=rock, rough=0.15, flat=0.5)

    # Hanging roots from the underbelly.
    for k in range(rnd.randint(5, 9)):
        a = rnd.uniform(0, 6.28)
        t = rnd.uniform(0.1, 0.5)
        r = R * (1 - t) ** 0.7 * 0.85
        start = V((off.x * t + math.cos(a) * r, off.y * t + math.sin(a) * r, -R * 0.2 - depth * t))
        L = rnd.uniform(1.5, 3.5) + R * 0.35
        rb = rnd.random()
        ph = rnd.uniform(0, 6.28)
        path = [start + V((math.cos(a) * 0.06 * u * L + 0.3 * math.sin(u * 6 + ph),
                           math.sin(a) * 0.06 * u * L + 0.3 * math.cos(u * 5 + ph), -L * u)) for u in (i / 6 for i in range(7))]
        B.ptube(mb, path, [0.14 * (1 - 0.85 * i / 6) + 0.02 for i in range(7)], segments=4, mat=0,
                col_fn=lambda u, rb=rb: (u, 1.0, rb), cap_start=False)
    # Grass fringes spilling over the rim.
    for s, (a, r) in enumerate(rim):
        if rnd.random() < 0.3:
            continue
        L = rnd.uniform(0.8, 2.2) * (0.6 + 0.4 * R / 8)
        gb = rnd.random()
        p0 = V((math.cos(a) * r * 1.04, math.sin(a) * r * 1.04, -R * 0.01))
        out = V((math.cos(a), math.sin(a), 0))
        side = V((-math.sin(a), math.cos(a), 0))
        w = r * 0.14
        rows = []
        for i in range(4):
            u = i / 3
            p = p0 + out * (0.3 * L * math.sin(u * 1.5)) - UP * (L * u)
            ww = w * (1 - u * 0.7)
            col = (u, 1.0, gb)
            rows.append([mb.v(p - side * ww, col), mb.v(p, col), mb.v(p + side * ww, col)] if u < 1 else
                        [mb.v(p - side * ww * 0.6, col), mb.v(p - side * ww * 0.1 - UP * L * 0.25, col),
                         mb.v(p + side * ww * 0.6, col)])
        B.loft(mb, rows, 1)


def build_floating_rocks():
    rnd = random.Random(3201)
    root = bpy.data.objects.new("FloatingRocks", None)
    bpy.context.scene.collection.objects.link(root)
    spots = [(0, 0, 22, 9), (-24, 14, 16, 5), (18, 20, 31, 6.5), (26, -12, 15, 4), (-14, -22, 27, 5.5),
             (6, -30, 38, 3.5), (-30, -4, 34, 4.2), (34, 8, 20, 3)]
    mats = [B.material("stone", (0.42, 0.4, 0.44)), B.material("grass", (0.2, 0.32, 0.18), True)]
    objs = []
    for i, (x, y, z, R) in enumerate(spots):
        mb = B.MeshBuilder()
        floating_rock(mb, rnd, R, R * rnd.uniform(1.3, 2.0))
        o = mb.build(f"FloatingRock_{i}", mats, smooth=True, parent=root, location=(x, y, z))
        objs.append(o)
    return root, objs


def build_moon_tree():
    """Colossal ancient tree, ~45 m: a walk-in hollow of fused buttress columns, sprawling limbs, glowing blossoms."""
    rnd = random.Random(3301)
    mb = B.MeshBuilder()
    bark = lambda t: (t, 0.0, 0.0)
    flute = lambda t, a: 1.0 + 0.06 * math.sin(a * 9 + t * 4.0) + 0.03 * math.sin(a * 17)

    # Buttress columns ringing a hollow; the wide gap facing +X is the doorway (~3.5 m at the ground, ~2.3 m
    # under the ceiling at z = 5.5).
    n_col = 11
    for k in range(n_col):
        a = math.radians(36) + (2 * math.pi - math.radians(72)) * k / (n_col - 1)
        r0 = 6.2 + rnd.uniform(-0.3, 0.3)
        tw = rnd.uniform(-0.25, 0.25)
        path = []
        for i in range(9):
            t = i / 8
            rr = r0 - (r0 - 2.6) * ss(0.0, 1.0, t) ** 0.8
            aa = a + tw * t
            path.append(V((math.cos(aa) * rr, math.sin(aa) * rr, -0.6 + 14.0 * t)))
        rads = [1.9 - 0.8 * (i / 8) for i in range(9)]
        B.ptube(mb, path, rads, segments=9, mat=0, col_fn=bark, radial_fn=flute, cap_end=False)
        # Surface root: the column flows out over the ground as a snaking ridge.
        p = V((math.cos(a) * r0, math.sin(a) * r0, 0.0))
        d = V((math.cos(a), math.sin(a), 0))
        rpath = [p - d * 0.8 + UP * 0.2]
        aa = a
        for j in range(5):
            aa += rnd.uniform(-0.3, 0.3)
            rpath.append(rpath[-1] + V((math.cos(aa), math.sin(aa), 0)) * rnd.uniform(2.0, 3.2) - UP * 0.12)
        B.ptube(mb, rpath, [1.1 * (1 - 0.8 * j / 5) + 0.1 for j in range(6)], segments=6, mat=0,
                col_fn=lambda t: (0.0, 0.0, 0.0))

    # Main trunk: starts narrow inside the column ring (its underside is the hollow's ceiling) and swells to
    # swallow the column tops, so no seam shows outside.
    trunk = []
    trunk_r = [3.0, 3.6, 4.05, 4.35, 4.45, 4.3, 4.1, 3.85, 3.6, 3.35, 3.15, 2.95, 2.75, 2.6]
    for i in range(14):
        t = i / 13
        trunk.append(V((0.9 * math.sin(t * 2.2) * t, 0.7 * math.sin(t * 1.7 + 1) * t, 5.5 + 25.5 * t)))
    B.ptube(mb, trunk, trunk_r, segments=14, mat=0, col_fn=bark, radial_fn=flute, cap_start=True, cap_end=True)

    # Limbs: huge, heavy, reaching out then drooping, forked twice.
    pads, blossoms = [], []

    def grow(p, yaw, e0, e1, L, r0, depth):
        st = (6, 5, 4)[depth]
        path = B.bend_spine(p, yaw, e0, e1, L, st, power=1.0, wander=0.15, rnd=rnd)
        rads = [r0 * (1 - 0.6 * i / st) for i in range(st + 1)]
        B.ptube(mb, path, rads, segments=(8, 5, 4)[depth], mat=0, col_fn=bark, cap_end=depth == 2)
        if depth < 2:
            for c in range(3 if depth == 0 else 2):
                t = (0.45, 0.7, 0.95)[c] if depth == 0 else (0.6, 0.95)[c]
                f = t * st
                i = min(int(f), st - 1)
                q = path[i].lerp(path[i + 1], f - i)
                sgn = -1 if c % 2 else 1
                grow(q, yaw + sgn * rnd.uniform(0.35, 0.8), math.radians(rnd.uniform(12, 30)),
                     math.radians(rnd.uniform(-22, 2)), L * rnd.uniform(0.5, 0.65), rads[i] * 0.75, depth + 1)
        if depth == 0:
            pads.append((path[len(path) // 2] + UP * 1.5, 4.0))
        pads.append((path[-1], 5.0 if depth == 2 else 4.4))

    yaw0 = rnd.uniform(0, 6.28)
    n_limbs = 7
    for li in range(n_limbs):
        t = 0.6 + 0.38 * li / (n_limbs - 1)
        f = t * 13
        i = min(int(f), 12)
        p = trunk[i].lerp(trunk[i + 1], f - i)
        yaw = yaw0 + li * GOLDEN_ANGLE
        grow(p, yaw, math.radians(rnd.uniform(28, 45)), math.radians(rnd.uniform(-10, 6)),
             rnd.uniform(15, 20), trunk_r[i] * 0.6, 0)
    grow(trunk[-1], yaw0, math.radians(75), math.radians(30), 9.0, 2.2, 1)

    # Foliage: each cushion is a high dome over a broader skirt, so masses read solid from any side.
    for pos, size in pads:
        ph = rnd.random()
        sz = size * rnd.uniform(0.9, 1.15)
        # Cumulus cushion: lumpy dome with a flattened belly, the shape a painter blocks a crown in with.
        s0 = len(mb.verts)
        B.blob(mb, pos + UP * (0.35 * sz), (sz, sz * rnd.uniform(0.8, 1.0), sz * 0.5), rnd, u=8, v=5, mat=1,
               col=(1.0, 1.0, ph), rough=0.22, flat=0.55, rot=Matrix.Rotation(rnd.uniform(0, 6.28), 3, "Z"))
        c0 = pos + UP * (0.35 * sz)
        recolor(mb, s0, lambda p, c: (clamp01((p - c0).length / sz), 1.0, ph))
        for k in range(rnd.randint(3, 5)):
            a = rnd.uniform(0, 6.28)
            r = sz * rnd.uniform(0.25, 0.95)
            drop = sz * 0.05 + rnd.uniform(0.1, 0.5)
            top = pos + V((math.cos(a) * r, math.sin(a) * r, -drop))
            blossoms.append((top, rnd.uniform(0.8, 4.0) if rnd.random() < 0.4 else 0.0))
    # A few glowing blossoms hang inside the hollow, lighting the way in.
    for k in range(7):
        a = rnd.uniform(0, 6.28)
        r = rnd.uniform(0.5, 2.2)
        blossoms.append((V((math.cos(a) * r, math.sin(a) * r, 5.4)), rnd.uniform(1.0, 2.5)))

    for top, thread in blossoms:
        b = rnd.random()
        size = rnd.uniform(0.35, 0.6)
        bell_top = top - UP * thread
        if thread > 0:
            B.ptube(mb, [top, top.lerp(bell_top, 0.5) + V((0.1, 0, 0)), bell_top], [0.03, 0.025, 0.02], segments=3,
                    mat=1, col_fn=lambda t, b=b: (t, 1.0, b), cap_start=False, cap_end=False)
        # Pentagonal hanging bell with flared petal tips, open at the mouth (the glow material is double sided).
        glow = (1.0, 0.5, b)
        apex = mb.v(bell_top, glow)
        rot = rnd.uniform(0, 6.28)
        ring = [mb.v(bell_top + V((math.cos(rot + 2 * math.pi * j / 5) * size, math.sin(rot + 2 * math.pi * j / 5) * size,
                                    -size * 1.1)), glow) for j in range(5)]
        tips = [mb.v(bell_top + V((math.cos(rot + 2 * math.pi * (j + 0.5) / 5) * size * 1.35,
                                     math.sin(rot + 2 * math.pi * (j + 0.5) / 5) * size * 1.35, -size * 1.45)), glow)
                for j in range(5)]
        for j in range(5):
            j2 = (j + 1) % 5
            mb.f((apex, ring[j2], ring[j]), 2)
            mb.f((ring[j], ring[j2], tips[j]), 2)

    print(f"[lapis] moon tree: {len(blossoms)} blossoms, {len(pads)} foliage cushions")
    B.ramp_r(mb, 0, 0.0, 45.0, skip_g=(0.5, 1.0))
    mats = [B.material("bark", (0.3, 0.27, 0.3)), B.material("foliage", (0.16, 0.24, 0.3), True),
            B.material("moonblossom_glow", (0.92, 0.94, 1.0), True, emission=(0.75, 0.85, 1.0))]
    return mb.build("MoonTree", mats, smooth=True)


GOLDEN_ANGLE = math.pi * (3 - math.sqrt(5))


def build_bell_tower():
    """Drowned bell tower, ~24 m above water, leaning 10 degrees: windowed shaft, open belfry, broken spire."""
    rnd = random.Random(3401)
    mb = B.MeshBuilder()
    stone = lambda: (0.0, 0.0, rnd.random())
    H = 2.5   # half width of the shaft
    T = 0.6   # wall thickness
    z0, z_belfry, z_corn = -4.0, 15.0, 19.6

    # Plinth below the waterline.
    B.obox(mb, (0, 0, -3.2), X, Y, H + 0.5, H + 0.5, 0.8, col=stone())
    # Walls with window openings: each face is built as solid slabs around the gaps.
    windows = [(4.0, 6.2, 0.45), (9.5, 11.8, 0.45)]
    for fi in range(4):
        ang = fi * math.pi / 2
        n = V((math.cos(ang), math.sin(ang), 0))
        u = V((-n.y, n.x, 0))
        c0 = n * (H - T / 2)
        half = H  # faces overlap at the corners
        z = -2.4
        for wb, wt, ww in windows + [(z_belfry, z_belfry, 0)]:
            if wb > z:
                B.obox(mb, c0 + UP * ((z + wb) / 2), u, UP, half, (wb - z) / 2, T / 2, col=stone())
            if ww:
                for sgn in (-1, 1):
                    cx = sgn * (ww + (half - ww) / 2)
                    B.obox(mb, c0 + u * cx + UP * ((wb + wt) / 2), u, UP, (half - ww) / 2, (wt - wb) / 2, T / 2, col=stone())
                # Rounded window head: a lintel block notched into three steps reads as an arch.
                B.obox(mb, c0 + UP * (wt + 0.12), u, UP, ww, 0.12, T / 2 + 0.05, col=stone())
                B.obox(mb, c0 + n * 0.1 + UP * (wb - 0.08), u, UP, ww + 0.15, 0.08, T / 2 + 0.05, col=stone())
            z = wt + (0.24 if ww else 0)
    # Floor of the belfry and the string courses.
    for zc, out in ((3.0, 0.14), (8.4, 0.14), (z_belfry, 0.22)):
        B.obox(mb, (0, 0, zc), X, Y, H + out, H + out, 0.16, col=stone())
    # Quoins: alternating long and short corner stones.
    for ci in range(4):
        sx, sy = (1, 1, -1, -1)[ci], (1, -1, -1, 1)[ci]
        z = -2.4
        k = 0
        while z < z_belfry - 0.1:
            h = 0.55
            lx, ly = (0.85, 0.5) if k % 2 == 0 else (0.5, 0.85)
            c = V((sx * (H - lx / 2 + 0.06), sy * (H - ly / 2 + 0.06), z + h / 2))
            B.obox(mb, c, X, Y, lx / 2, ly / 2, h / 2 - 0.03, col=stone())
            z += h
            k += 1

    # Belfry: corner piers carrying round arches on every face.
    P = 0.65
    for ci in range(4):
        sx, sy = (1, 1, -1, -1)[ci], (1, -1, -1, 1)[ci]
        B.obox(mb, (sx * (H - P), sy * (H - P), (z_belfry + 18.1) / 2), X, Y, P, P, (18.1 - z_belfry) / 2, col=stone())
    span = H - 2 * P
    ar = span
    for fi in range(4):
        ang = fi * math.pi / 2
        n = V((math.cos(ang), math.sin(ang), 0))
        u = V((-n.y, n.x, 0))
        c = n * (H - T / 2) + UP * 18.1
        nv = 9
        for j in range(nv):
            a0, a1 = math.pi * j / nv, math.pi * (j + 1) / nv
            am = (a0 + a1) / 2
            radial = u * math.cos(am) + UP * math.sin(am)
            tang = -u * math.sin(am) + UP * math.cos(am)
            B.obox(mb, c + radial * (ar + 0.25), tang, n, (ar + 0.25) * math.pi / nv / 2 - 0.015, T / 2 + 0.04, 0.27,
                   col=stone())
        # Spandrels fill between the arch and the cornice.
        for sgn in (-1, 1):
            B.obox(mb, c + u * (sgn * (ar * 0.85)) + UP * (ar * 0.78 + 0.3), u, UP, ar * 0.32, (z_corn - 18.1 - ar * 0.78 - 0.3) / 2 + 0.2, T / 2, col=stone())
    # Cornice, with one corner fallen away.
    for fi in range(4):
        ang = fi * math.pi / 2
        n = V((math.cos(ang), math.sin(ang), 0))
        u = V((-n.y, n.x, 0))
        L = H + 0.4 if fi != 1 else H - 0.9
        off = 0.0 if fi != 1 else -1.3
        B.obox(mb, n * (H - 0.1) + u * off + UP * (z_corn + 0.25), u, n, L, 0.55, 0.28, col=stone())
    B.obox(mb, (0, 0, z_corn + 0.3), X, Y, H - 0.4, H - 0.4, 0.25, col=stone())

    # The bell, frozen mid-swing under its headstock.
    s0 = len(mb.verts)
    B.obox(mb, (0, 0, 17.95), Y, X, H - 0.2, 0.22, 0.22, mat=1, col=(0.0, 0.0, 0.3))
    prof = [(0.0, 0.25), (0.45, 0.2), (0.75, -0.95), (0.86, -1.32), (0.98, -1.42), (0.92, -1.3), (0.8, -1.05),
            (0.62, -0.3), (0.55, 0.05), (0.42, 0.28), (0.2, 0.4), (0.0, 0.42)]
    b0 = len(mb.verts)
    B.lathe(mb, prof, 20, 1, col_fn=lambda t: (0.0, 0.0, 0.3), cap_bottom=False, cap_top=False)
    B.sphere(mb, (0, 0, -1.25), 0.16, u=8, v=5, mat=1, col=(0.0, 0.0, 0.3))
    B.ptube(mb, [V((0, 0, 0.1)), V((0, 0, -1.15))], [0.04, 0.04], segments=4, mat=1, col_fn=lambda t: (0.0, 0.0, 0.3))
    tilt = Matrix.Rotation(math.radians(16), 3, "X")
    B.xform(mb, b0, lambda p: tilt @ p + V((0, 0, 17.6)))

    # Broken spire: an octagonal pyramid snapped off, hollow, with a ragged rim.
    zs, zb = z_corn + 0.55, z_corn + 0.55 + 4.6
    r_at = lambda z: 2.2 * (1 - (z - zs) / 9.5)
    prof = [(r_at(zs), zs), (r_at(zs + 1.5), zs + 1.5), (r_at(zs + 3.0), zs + 3.0), (r_at(zb), zb),
            (r_at(zb) - 0.3, zb), (r_at(zs + 3.0) - 0.3, zs + 3.0), (r_at(zs) - 0.3, zs + 0.2)]
    sides = 8
    cache = {}

    def zf(t, a):
        if 0.45 < t < 0.75:
            key = round(a, 3)
            if key not in cache:
                cache[key] = -rnd.uniform(0.0, 1.8) * (0.4 + 0.6 * abs(math.sin(a * 1.3 + 0.7)))
            return cache[key]
        return 0.0

    B.lathe(mb, prof, sides, 0, col_fn=lambda t: stone(), rot=math.pi / 8, z_fn=zf, cap_bottom=False, cap_top=False)
    # Corner pinnacles, one snapped.
    for ci in range(4):
        sx, sy = (1, 1, -1, -1)[ci], (1, -1, -1, 1)[ci]
        h = 2.4 if ci != 2 else 0.9
        B.lathe(mb, [(0.42, zs - 0.05), (0.42, zs + 0.5), (0.3, zs + 0.6), (0.0, zs + 0.6 + h)], 4, 0,
                col_fn=lambda t: stone(), center=(sx * (H - 0.2), sy * (H - 0.2), 0), rot=math.pi / 4, cap_top=False)

    # Rubble: fallen blocks heaped against the base, a few breaking the surface.
    for k in range(26):
        a = rnd.uniform(0, 6.28)
        r = rnd.uniform(H + 0.6, H + 5.0)
        z = rnd.uniform(-3.5, 0.3)
        sz = rnd.uniform(0.35, 0.8)
        B.obox(mb, (math.cos(a) * r, math.sin(a) * r, z), V((math.cos(a + k), math.sin(a + k), rnd.uniform(-0.4, 0.4))),
               UP, sz * 1.4, sz, sz * 0.8, col=stone())

    lean = Matrix.Rotation(math.radians(10), 3, "Y")
    B.xform(mb, 0, lambda p: lean @ p)
    B.ramp_r(mb, 0, -4.0, 24.0, skip_g=())
    mats = [B.material("ruin_stone", (0.5, 0.5, 0.47)), B.material("bronze", (0.55, 0.42, 0.22))]
    return mb.build("BellTower", mats, smooth=False)


def mushroom(mb, rnd, base, height, lean_dir, kind, small=False):
    """Stem plus cap; the gills underneath glow. kind: 'parasol', 'dome' or 'bell'. small drops detail."""
    b = rnd.random()
    stem_r = height * (0.09 if small else rnd.uniform(0.045, 0.06))
    lean = rnd.uniform(0.06, 0.16)
    ph = rnd.uniform(0, 6.28)
    out = V((math.cos(lean_dir), math.sin(lean_dir), 0))
    side = V((-out.y, out.x, 0))
    n = 5 if small else 10
    stem_h = height * (0.9 if kind != "bell" else 0.8)
    path = [V(base) + out * (lean * stem_h * (i / n) ** 1.6) + side * (0.04 * stem_h * math.sin(i / n * 3 + ph))
            + UP * (stem_h * i / n - 0.3) for i in range(n + 1)]
    rads = [stem_r * (1.0 + 0.8 * math.exp(-i * 4.0 / n) - 0.15 * (i / n)) for i in range(n + 1)]
    B.ptube(mb, path, rads, segments=6 if small else 10, mat=0, col_fn=lambda t: (t, 0.0, b),
            radial_fn=lambda t, a: 1.0 + 0.04 * math.sin(a * 6 + t * 9))
    top = path[-1]
    tan = (path[-1] - path[-2]).normalized()
    if not small:
        # Annulus: a drooping skirt two-thirds up the stem.
        k = int(n * 0.68)
        sp = path[k]
        sr = rads[k]
        s0 = len(mb.verts)
        B.lathe(mb, [(sr * 0.9, 0.0), (sr * 1.9, -sr * 1.0), (sr * 1.8, -sr * 1.15), (sr * 0.95, -sr * 0.25)], 12, 0,
                col_fn=lambda t: (0.6, 0.0, b), radial_fn=lambda t, a: 1.0 + 0.08 * math.sin(a * 7), cap_bottom=False, cap_top=False)
        M = frame_to((path[k + 1] - path[k - 1]))
        B.xform(mb, s0, lambda p: M @ p + sp)

    R = height * {"parasol": 0.42, "dome": 0.3, "bell": 0.24}[kind] * rnd.uniform(0.9, 1.1)
    if small:
        R = height * 0.4
    if kind == "parasol":
        # Broad thin canopy with a small raised boss in the middle.
        prof = [(stem_r * 0.9, -0.02 * R), (R * 0.5, -0.07 * R), (R * 0.9, -0.12 * R), (R, -0.15 * R),
                (R * 1.01, -0.1 * R), (R * 0.9, 0.01 * R), (R * 0.62, 0.1 * R), (R * 0.28, 0.16 * R),
                (R * 0.12, 0.23 * R), (0.0, 0.25 * R)]
    elif kind == "dome":
        prof = [(stem_r * 0.9, -0.05 * R), (R * 0.5, -0.14 * R), (R * 0.88, -0.32 * R), (R, -0.45 * R),
                (R * 1.03, -0.32 * R), (R * 0.98, 0.05 * R), (R * 0.82, 0.4 * R), (R * 0.5, 0.62 * R), (0.0, 0.7 * R)]
    else:
        prof = [(stem_r * 0.9, 0.1 * R), (R * 0.5, -0.25 * R), (R * 0.85, -0.65 * R), (R, -0.9 * R),
                (R * 1.02, -0.76 * R), (R * 0.86, -0.1 * R), (R * 0.6, 0.6 * R), (R * 0.32, 1.15 * R), (0.0, 1.45 * R)]
    gill = 3  # first ring bands: the underside, in the glow material
    s0 = len(mb.verts)
    wav = rnd.uniform(0, 6.28)
    B.lathe(mb, prof, 12 if small else 24, 1, col_fn=lambda t: (1.0, 0.5, b) if t < 0.36 else (t, 0.0, b),
            mat_fn=lambda i: 2 if i < gill else 1,
            radial_fn=lambda t, a: 1.0 + 0.05 * math.sin(a * 5 + wav) * ss(0.25, 0.5, t),
            z_fn=lambda t, a: (0.04 * R * abs(math.sin(a * 12)) if 0.05 < t < 0.3 else 0.0),
            cap_bottom=False, cap_top=False)
    M = frame_to(tan.lerp(UP, 0.4))
    B.xform(mb, s0, lambda p: M @ p + top)
    # Glowing warts scattered over the cap top.
    tops = prof[5:]
    for k in range(0 if small else rnd.randint(8, 13)):
        a = rnd.uniform(0, 6.28)
        f = rnd.uniform(0.15, 0.85)
        hit = None
        for (r1, z1), (r2, z2) in zip(tops, tops[1:]):
            if r2 <= f * R <= r1:
                w = (f * R - r2) / max(1e-6, r1 - r2)
                hit = (f * R, z2 + (z1 - z2) * w)
        if hit is None:
            continue
        p = M @ V((math.cos(a) * hit[0], math.sin(a) * hit[0], hit[1])) + top
        B.sphere(mb, p, R * rnd.uniform(0.05, 0.1), u=5, v=3, mat=2, col=(1.0, 0.5, b), scale=(1, 1, 0.4))


def build_mushroom_ring():
    """Fairy ring, ~50 m across: eleven giant glowing mushrooms and a single small one in the middle."""
    rnd = random.Random(3501)
    mb = B.MeshBuilder()
    n = 11
    kinds = ["parasol", "dome", "bell"]
    for k in range(n):
        a = 2 * math.pi * k / n + rnd.uniform(-0.12, 0.12)
        r = rnd.uniform(22.0, 25.0)
        h = rnd.uniform(8.0, 20.0)
        mushroom(mb, rnd, (math.cos(a) * r, math.sin(a) * r, 0.0), h, a + rnd.uniform(-0.4, 0.4), kinds[k % 3])
        # A couple of babies huddle at some of the feet.
        for j in range(rnd.randint(0, 2)):
            aa = a + rnd.uniform(-0.12, 0.12)
            rr = r + rnd.uniform(-3, 3)
            mushroom(mb, rnd, (math.cos(aa) * rr, math.sin(aa) * rr, 0.0), rnd.uniform(1.2, 2.5), rnd.uniform(0, 6.28),
                     "dome", small=True)
    mushroom(mb, rnd, (0.0, 0.0, 0.0), 1.6, 0.3, "parasol", small=True)
    B.ramp_r(mb, 0, 0.0, 20.0, skip_g=(0.5,))
    mats = [B.material("mushroom_stem", (0.82, 0.8, 0.74)), B.material("mushroom_cap", (0.45, 0.32, 0.55)),
            B.material("mushroom_glow", (0.6, 1.0, 0.85), True, emission=(0.4, 1.0, 0.8))]
    return mb.build("MushroomRing", mats, smooth=True)


def export_wonders():
    B.reset()
    objs = [build_whale_skeleton()]
    root, rocks = build_floating_rocks()
    objs += rocks
    objs += [build_moon_tree(), build_bell_tower(), build_mushroom_ring()]
    report(objs)
    B.export("wonders")


if __name__ == "__main__":
    for asset, fn in (("fauna", export_fauna), ("wonders", export_wonders)):
        if not B.ONLY or asset in B.ONLY:
            fn()
