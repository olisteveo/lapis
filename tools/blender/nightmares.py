"""Nightmares (nightmares.glb): ink-and-shadow creatures that creep in as the night grows late.

Run headless:  blender -b --factory-startup --python tools/blender/nightmares.py -- <out_dir>
Reuses the builders in build_assets.py / fauna.py; Blender Z-up, every random stream seeded, all face +X.
Materials: ink (glossy near-black body), ink_eye (emissive eyes), ink_edge (thin rims / hems / thorn tips the
game may tint).

Wraith (drifting, origin on the ground below its centre, lowest tendril tip at z = 0.2):
  R  0 at the core -> 1 at tendril and finger tips (ripple weight). The robe itself ramps 0 -> 0.35 down to the
     tattered hem so the hem can ripple with the tendrils; hood, eyes and torso stay 0.
  G  1 on tendrils, arms, sleeves and fingers; 0 on robe, hood and eyes
  B  random phase per tendril / per arm (one value for a whole arm incl. sleeve and fingers); 0 elsewhere
Crawler (walker, origin on the ground between the feet), exactly fauna.py's walker encoding:
  R  leg swing weight = clamp((HIP_Z - z) / HIP_Z), HIP_Z = 0.42 m shared by all six hips
  G  1 legs (incl. knee spurs), 0 body / spines / eyes
  B  tripod gait: L-front, R-mid, L-back 0.0;  R-front, L-mid, R-back 0.5; 0 elsewhere. Left is +Y.
NightmareThorns (static corruption, origin at ground):
  R  0 root -> 1 tip along each tendril (thorns inherit their host's value); 0 on the puddle / root knot
  G  smoothstep(0.25, 0.6, R) along tendrils: 0 on the rigid lower stems, 1 on the tips that may sway
  B  random phase per tendril (branches share their parent's)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_assets as B
import fauna as F

import math
import random

from mathutils import Matrix, Vector

V = Vector
UP = V((0, 0, 1))
X = V((1, 0, 0))
Y = V((0, 1, 0))
ss = B.smoothstep
clamp01 = F.clamp01

CRAWLER_HIP_Z = 0.42
INK, EYE, EDGE = 0, 1, 2


def ink_mats(eyes=True):
    ink = B.material("ink", (0.012, 0.012, 0.022))
    ink.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.18
    edge = B.material("ink_edge", (0.16, 0.07, 0.3))
    edge.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.3
    mats = [ink]
    if eyes:
        mats.append(B.material("ink_eye", (1.0, 0.5, 0.18), emission=(1.0, 0.42, 0.12)))
    mats.append(edge)
    return mats


def spline(ctrl, n):
    """Uniform Catmull-Rom through control points, n samples including both ends."""
    ctrl = [V(c) for c in ctrl]
    m = len(ctrl) - 1
    out = []
    for i in range(n):
        f = i / (n - 1) * m
        k = min(int(f), m - 1)
        t = f - k
        p0, p1, p2, p3 = ctrl[max(k - 1, 0)], ctrl[k], ctrl[k + 1], ctrl[min(k + 2, m)]
        out.append(0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                          + (3 * p1 - p0 - 3 * p2 + p3) * t ** 3))
    return out


def horn(mb, path, radii, seg=6, mat=INK, col_fn=None, cap_start=False, radial_fn=None):
    """Tube that tapers to a sharp pole at path[-1]; radii has len(path) - 1 entries.
    col_fn(t) gets t over the whole path (pole = 1)."""
    n = len(path)
    cf = col_fn or (lambda t: (t, 0.0, 0.0))
    m = n - 1
    rings = B.ptube(mb, path[:-1], radii, segments=seg, mat=mat,
                    col_fn=lambda tl: cf(tl * (m - 1) / (n - 1)), cap_start=cap_start, cap_end=False,
                    radial_fn=radial_fn)
    pole = mb.v(path[-1], cf(1.0))
    last = rings[-1]
    for s in range(seg):
        mb.f((last[s], last[(s + 1) % seg], pole), mat)
    return rings


def remat(mb, face_start, mat, pred):
    """Reassigns faces added since face_start whose vertex positions satisfy pred([Vector])."""
    for i in range(face_start, len(mb.faces)):
        if pred([V(mb.verts[j]) for j in mb.faces[i]]):
            mb.mats[i] = mat


def spike(mb, base, d, length, r, col, mat, sides=3, rnd=None):
    """Open-based pyramid (embedded in its host): a thorn. Faces oriented outward explicitly."""
    base, d = V(base), V(d).normalized()
    ref = UP if abs(d.z) < 0.9 else X
    a = d.cross(ref).normalized()
    b = d.cross(a)
    rot = rnd.uniform(0, 6.28) if rnd else 0.0
    ring = [mb.v(base + (a * math.cos(rot + 2 * math.pi * k / sides) + b * math.sin(rot + 2 * math.pi * k / sides)) * r,
                 col) for k in range(sides)]
    tip = mb.v(base + d * length, col)
    for k in range(sides):
        i, j = ring[k], ring[(k + 1) % sides]
        pi, pj, pt = V(mb.verts[i]), V(mb.verts[j]), V(mb.verts[tip])
        nrm = (pj - pi).cross(pt - pi)
        cen = (pi + pj + pt) / 3 - base
        mb.f((i, j, tip) if nrm.dot(cen) > 0 else (j, i, tip), mat)


# ================================================================ Wraith

def build_wraith():
    """2.9 m hooded wraith, hunched and legless: the robe unravels into trailing ink tendrils, overlong arms reach
    forward with spindly fingers, and three mismatched embers burn in the void of the hood."""
    rnd = random.Random(6101)
    mb = B.MeshBuilder()
    seg = 16

    # ---- robe: horizontal sections bottom -> top. (z, x centre, half width, front depth, back depth)
    robe = [(1.08, -0.2, 0.2, 0.18, 0.2), (1.3, -0.17, 0.22, 0.19, 0.23), (1.55, -0.1, 0.27, 0.2, 0.27),
            (1.8, 0.0, 0.36, 0.2, 0.34), (2.0, 0.12, 0.41, 0.19, 0.39), (2.15, 0.24, 0.43, 0.17, 0.38),
            (2.26, 0.34, 0.37, 0.14, 0.3), (2.35, 0.42, 0.22, 0.1, 0.18)]
    hem_r = lambda z: 0.35 * ss(1.75, 0.95, z)
    fold_ph = rnd.uniform(0, 6.28)

    def robe_ring(z, xc, w, fd, bd, jag=None, scale=1.0):
        ring = []
        for s in range(seg):
            a = 2 * math.pi * s / seg
            ca, sa = math.cos(a), math.sin(a)
            fold = 1.0 + 0.05 * math.sin(3 * a + z * 6 + fold_ph) + 0.03 * math.sin(7 * a - z * 4)
            dz = jag[s] if jag else 0.0
            p = V((xc + ca * (fd if ca > 0 else bd) * fold * scale, sa * w * fold * scale, z + dz))
            ring.append(mb.v(p, (hem_r(p.z), 0.0, 0.0)))
        return ring

    f0 = len(mb.faces)
    # Tattered hem: long ragged points alternating with short ones, longest at the back where it trails.
    jag = []
    for s in range(seg):
        a = 2 * math.pi * s / seg
        back = 0.5 - 0.5 * math.cos(a)
        jag.append(-(rnd.uniform(0.22, 0.38) + 0.16 * back) if s % 2 == 0 else -rnd.uniform(0.0, 0.05))
    rings = [[mb.v((-0.21, 0, 1.0), (0.1, 0, 0))],
             robe_ring(0.92, -0.21, 0.2, 0.18, 0.2, scale=0.55),
             robe_ring(0.9, -0.21, 0.21, 0.19, 0.21, jag=jag, scale=1.18),
             robe_ring(0.97, -0.21, 0.205, 0.18, 0.2)]
    rings += [robe_ring(*st) for st in robe]
    rings.append([mb.v((0.45, 0, 2.4), (0, 0, 0))])
    B.rings_loft(mb, rings, INK, False, False)
    # Only the ragged points of the hem are the tintable edge.
    remat(mb, f0, EDGE, lambda ps: max(p.z for p in ps) <= 0.98)

    # ---- hood: sections along a forward-down axis, folding back inward at the opening into a deep void.
    hc = V((0.58, 0.0, 2.44))
    hd = V((1.0, 0.0, -0.55)).normalized()
    hup = hd.cross(Y).normalized()

    def hood_ring(u, w, ht, hb, scale=1.0, brow=0.0, n=16):
        c = hc + hd * u
        ring = []
        for s in range(n):
            a = 2 * math.pi * s / n
            ca, sa = math.cos(a), math.sin(a)
            h = ht if sa > 0 else hb
            peak = 1.0 + 0.35 * max(0.0, sa) ** 6   # the cowl rises to a soft point
            p = c + Y * (ca * w * scale) + hup * (sa * h * peak * scale) + hd * (brow * max(0.0, sa) ** 2)
            ring.append(mb.v(p, (0.0, 0.0, 0.0)))
        return ring

    f0 = len(mb.faces)
    tip = hc + hd * -0.42 + hup * 0.2 - UP * 0.06
    hood = [[mb.v(tip, (0, 0, 0))],
            hood_ring(-0.3, 0.12, 0.15, 0.12),
            hood_ring(-0.15, 0.22, 0.25, 0.2),
            hood_ring(0.02, 0.26, 0.29, 0.25),
            hood_ring(0.16, 0.255, 0.29, 0.25, brow=0.07),
            hood_ring(0.2, 0.25, 0.28, 0.24, brow=0.09),
            hood_ring(0.17, 0.25, 0.28, 0.24, scale=0.84, brow=0.07),
            hood_ring(0.02, 0.24, 0.27, 0.23, scale=0.7),
            [mb.v(hc + hd * -0.12, (0, 0, 0))]]
    B.rings_loft(mb, hood, INK, False, False)
    # The thin lip of the opening is the tintable rim.
    lip = set(hood[5]) | set(hood[6])
    for i in range(f0, len(mb.faces)):
        if all(j in lip for j in mb.faces[i]):
            mb.mats[i] = EDGE

    # ---- eyes: three mismatched embers deep in the void, slanted almond slits.
    for side, up, r, tilt in ((-0.085, 0.035, 0.046, 0.3), (0.08, 0.06, 0.034, -0.4), (0.02, -0.08, 0.022, 0.0)):
        s0 = len(mb.verts)
        B.sphere(mb, (0, 0, 0), r, u=8, v=5, mat=EYE, col=(0, 0, 0), scale=(0.45, 1.7, 0.75))
        M = Matrix((hd, Y, hup)).transposed() @ Matrix.Rotation(tilt, 3, "X")
        c = hc + hd * 0.07 + Y * side + hup * up
        B.xform(mb, s0, lambda p, M=M, c=c: M @ p + c)

    # ---- arms: overlong and thin, reaching forward out of ragged sleeves; one high, one low.
    arms = [
        (1, [(0.3, 0.34, 2.14), (0.48, 0.58, 1.86), (0.66, 0.68, 1.68), (1.05, 0.62, 1.76), (1.5, 0.48, 1.92)]),
        (-1, [(0.28, -0.34, 2.12), (0.44, -0.58, 1.8), (0.6, -0.66, 1.54), (0.98, -0.62, 1.44), (1.38, -0.5, 1.4)]),
    ]
    for sgn, ctrl in arms:
        ph = rnd.random()
        path = spline(ctrl, 12)
        col = lambda t, ph=ph: (t, 1.0, ph)
        # Arm proper: R 0 at the shoulder -> 0.7 at the wrist.
        B.ptube(mb, path, [0.06 - 0.032 * (i / 11) for i in range(12)], segments=7, mat=INK,
                col_fn=lambda t, ph=ph: (0.7 * t, 1.0, ph), cap_start=True, cap_end=True)
        # Sleeve over the upper arm, flaring into a jagged cuff that folds back to hug the arm.
        sp = spline(ctrl[:3], 6)
        f0 = len(mb.faces)
        rs = B.ptube(mb, sp, [0.12, 0.13, 0.14, 0.155, 0.17, 0.19], segments=9, mat=INK,
                     col_fn=lambda t, ph=ph: (0.32 * t, 1.0, ph), cap_start=True, cap_end=False,
                     radial_fn=lambda t, a: 1.0 + 0.12 * math.sin(a * 3 + 1.3) * t)
        end, prev = sp[-1], sp[-2]
        tan = (end - prev).normalized()
        cuff = []
        for k, i in enumerate(rs[-1]):
            p = V(mb.verts[i])
            drop = rnd.uniform(0.14, 0.28) if k % 2 == 0 else rnd.uniform(0.0, 0.04)
            cuff.append(mb.v(p + tan * 0.04 - UP * drop + (p - end) * 0.1, (0.34, 1.0, ph)))
        inner = [mb.v(end + tan * 0.02 + (V(mb.verts[i]) - end).normalized() * 0.06, (0.34, 1.0, ph)) for i in rs[-1]]
        n = len(cuff)
        for s in range(n):
            s2 = (s + 1) % n
            a, b2 = rs[-1][s], rs[-1][s2]
            mb.f((a, b2, cuff[s2], cuff[s]), EDGE)
            mb.f((cuff[s], cuff[s2], inner[s2], inner[s]), EDGE)
        # Hand: a bony knot at the wrist, then long fingers that curl down like they're about to close.
        wrist = path[-1]
        fwd = (path[-1] - path[-3]).normalized()
        side = UP.cross(fwd).normalized()
        down = fwd.cross(side).normalized() * -1
        B.sphere(mb, wrist + fwd * 0.04, 0.05, u=6, v=4, mat=INK, col=(0.74, 1.0, ph), scale=(1.0, 1.0, 0.7))
        palm = wrist + fwd * 0.09
        for k, (spread, L) in enumerate(((-0.55, 0.32), (-0.18, 0.4), (0.18, 0.42), (0.55, 0.34), (1.25 * sgn, 0.22))):
            sp_ang = spread if k < 4 else spread
            d = (fwd * math.cos(sp_ang) + side * math.sin(sp_ang)).normalized()
            pts = [palm - fwd * 0.03]
            dd = d.copy()
            for j in range(5):
                pts.append(pts[-1] + dd * (L / 5))
                dd = (dd + down * (0.28 + 0.06 * j)).normalized()
            horn(mb, pts, [0.02, 0.017, 0.014, 0.011, 0.008], seg=5, mat=INK,
                 col_fn=lambda t, ph=ph: (0.78 + 0.22 * t, 1.0, ph))

    # ---- tendrils: the robe unravels into ink ropes that trail behind as it drifts.
    n_t = 11
    tips = [0.2, 0.38, 0.27, 0.5, 0.31, 0.44, 0.24, 0.58, 0.35, 0.47, 0.3]
    for k in range(n_t):
        ph = rnd.random()
        a = 2 * math.pi * k / n_t + rnd.uniform(-0.15, 0.15)
        out = V((math.cos(a), math.sin(a), 0))
        lat = V((-out.y, out.x, 0))
        root = V((-0.21, 0, 0.98)) + out * rnd.uniform(0.08, 0.18)
        back = 0.5 - 0.5 * math.cos(a)        # back tendrils trail further
        tz = tips[k]
        trail = 0.2 + 0.45 * back + rnd.uniform(0.0, 0.15)
        w1, w2 = rnd.uniform(-0.12, 0.12), rnd.uniform(-0.15, 0.15)
        ctrl = [root,
                root + out * 0.12 - UP * 0.25,
                root + out * 0.2 - X * trail * 0.3 + lat * w1 - UP * (0.98 - tz) * 0.5,
                root + out * 0.24 - X * trail * 0.7 + lat * w2 - UP * (0.98 - tz) * 0.85,
                root + out * 0.3 - X * trail + lat * (w1 * -0.8) + UP * (tz - 0.98),
                root + out * 0.36 - X * (trail + 0.12) + lat * (w2 * -0.5) + UP * (tz - 0.98 + 0.1)]
        path = spline(ctrl, 11)
        r0 = rnd.uniform(0.07, 0.1) if k % 3 else rnd.uniform(0.04, 0.05)
        horn(mb, path, [r0 * (1 - i / 10) ** 0.9 + 0.006 for i in range(10)], seg=6, mat=INK,
             col_fn=lambda t, ph=ph: (t, 1.0, ph))

    # Two ink streamers peel off the hood point and trail behind like smoke.
    for k, (sy, drop) in enumerate(((0.05, 0.55), (-0.07, 0.8))):
        ph = rnd.random()
        root = tip + hd * 0.06
        ctrl = [root, root + V((-0.25, sy, -0.05)), root + V((-0.55, sy * 2.2, -drop * 0.45)),
                root + V((-0.8, sy * 1.5, -drop * 0.8)), root + V((-1.0, sy * 2.5, -drop))]
        horn(mb, spline(ctrl, 10), [0.045 * (1 - i / 9) ** 0.8 + 0.005 for i in range(9)], seg=5, mat=INK,
             col_fn=lambda t, ph=ph: (t, 1.0, ph))

    obj = mb.build("Wraith", ink_mats(), smooth=True)
    return obj


# ================================================================ Crawler

def build_crawler():
    """1.6 m six-legged ink hound: hunched spined back, head slung low with a cluster of ember eyes, high
    spider knees. Walker encoding as fauna.py (HIP_Z = 0.42)."""
    rnd = random.Random(6201)
    mb = B.MeshBuilder()
    zero = (0.0, 0.0, 0.0)
    H = CRAWLER_HIP_Z

    body = [(-0.76, 0.3, 0, 0, 0), (-0.68, 0.32, 0.05, 0.045, 0.045), (-0.56, 0.36, 0.12, 0.11, 0.09),
            (-0.4, 0.4, 0.19, 0.15, 0.13), (-0.22, 0.41, 0.2, 0.15, 0.13), (-0.06, 0.42, 0.15, 0.12, 0.1),
            (0.04, 0.42, 0.12, 0.1, 0.09), (0.14, 0.43, 0.15, 0.13, 0.1), (0.27, 0.42, 0.15, 0.12, 0.1),
            (0.37, 0.39, 0.1, 0.09, 0.08), (0.45, 0.34, 0.1, 0.1, 0.08), (0.55, 0.31, 0.105, 0.09, 0.075),
            (0.64, 0.28, 0.075, 0.06, 0.055), (0.7, 0.26, 0.035, 0.03, 0.03), (0.72, 0.255, 0, 0, 0)]
    F.section_loft(mb, body, seg=16, col=zero)

    def top_z(x):
        for (u0, z0, w0, h0, _), (u1, z1, w1, h1, _) in zip(body, body[1:]):
            if u0 <= x <= u1:
                f = (x - u0) / (u1 - u0)
                return z0 + (z1 - z0) * f + h0 + (h1 - h0) * f
        return 0.3

    # Spine ridge: thorns curving back, tallest over the swollen abdomen; tips are the tintable edge.
    f0 = len(mb.faces)
    xs = [-0.6, -0.5, -0.4, -0.3, -0.2, -0.1, 0.0, 0.1, 0.19, 0.28, 0.36]
    for x in xs:
        h = 0.06 + 0.1 * math.exp(-((x + 0.3) / 0.22) ** 2) + 0.04 * math.exp(-((x - 0.16) / 0.1) ** 2)
        h *= rnd.uniform(0.85, 1.1)
        b = V((x, 0, top_z(x) - 0.02))
        lean = rnd.uniform(0.35, 0.6)
        pts = [b, b + V((-lean * 0.25 * h, 0, 0.45 * h)), b + V((-lean * 0.6 * h, 0, 0.8 * h)),
               b + V((-lean * 1.1 * h, 0, 1.0 * h))]
        horn(mb, pts, [0.022 + 0.08 * h, 0.012 + 0.04 * h, 0.006 + 0.015 * h], seg=5, mat=INK, col_fn=lambda t: zero)
        tipz = b.z + 0.62 * h
        remat(mb, len(mb.faces) - 15, EDGE, lambda ps, tz=tipz: min(p.z for p in ps) > tz)
    # Swept-back head horns.
    for sgn in (-1, 1):
        b = V((0.5, sgn * 0.06, 0.41))
        pts = [b, b + V((-0.06, sgn * 0.03, 0.06)), b + V((-0.16, sgn * 0.06, 0.1)), b + V((-0.27, sgn * 0.08, 0.1))]
        horn(mb, pts, [0.025, 0.016, 0.008], seg=5, mat=INK, col_fn=lambda t: zero)
        remat(mb, len(mb.faces) - 15, EDGE, lambda ps: min(p.x for p in ps) < 0.36)

    # Eye cluster: two big embers, smaller ones scattered like a spider's.
    for p, r in (((0.625, 0.052, 0.335), 0.03), ((0.625, -0.052, 0.335), 0.03), ((0.565, 0.085, 0.37), 0.019),
                 ((0.57, -0.08, 0.372), 0.021), ((0.672, 0.026, 0.3), 0.013), ((0.672, -0.03, 0.302), 0.012),
                 ((0.52, 0.0, 0.405), 0.015)):
        B.sphere(mb, p, r, u=7, v=5, mat=EYE, col=zero, scale=(0.8, 1.0, 0.9))

    # Legs: hips under the shoulders, knees thrown up above the back like a spider's, needle feet.
    legs = [("LF", 0.26, 1, (0.86, 0.4)), ("RF", 0.26, -1, (0.86, 0.4)),
            ("LM", 0.1, 1, (0.14, 0.62)), ("RM", 0.1, -1, (0.14, 0.62)),
            ("LB", -0.08, 1, (-0.62, 0.5)), ("RB", -0.08, -1, (-0.62, 0.5))]
    gait = {"LF": 0.0, "RM": 0.0, "LB": 0.0, "RF": 0.5, "LM": 0.5, "RB": 0.5}
    for name, hx, sgn, (fx, fy) in legs:
        ph = gait[name]
        hip = V((hx, sgn * 0.09, H))
        foot = V((fx, sgn * fy, 0.0))
        d = foot - hip
        d.z = 0
        kz = 0.6 if name[1] != "B" else 0.57
        ctrl = [hip, hip + d * 0.12 + UP * 0.1, hip + d * 0.4 + V((0, 0, kz - H)), hip + d * 0.7 + V((0, 0, 0.34 - H)),
                hip + d * 0.93 + V((0, 0, 0.07 - H)), foot]
        path = spline(ctrl, 13)
        rads = [0.04 - 0.028 * (i / 11) + 0.01 * math.exp(-((i / 11 - 0.36) / 0.07) ** 2) for i in range(12)]
        s0 = len(mb.verts)
        horn(mb, path, rads, seg=6, mat=INK, cap_start=True)
        # Knee spur.
        k = 5
        kn = path[k]
        tdir = (path[k + 1] - path[k - 1]).normalized()
        spur_d = (UP * 1.0 - tdir * 0.5).normalized()
        f0 = len(mb.faces)
        spts = [kn, kn + spur_d * 0.035, kn + spur_d * 0.065 - tdir * 0.015, kn + spur_d * 0.09 - tdir * 0.035]
        horn(mb, spts, [0.016, 0.01, 0.005], seg=4, mat=INK)
        remat(mb, f0, EDGE, lambda ps, kz=kn.z: min(p.z for p in ps) > kz + 0.045)
        F.recolor(mb, s0, lambda p, c, ph=ph: (clamp01((H - p.z) / H), 1.0, ph))

    return mb.build("Crawler", ink_mats(), smooth=True)


# ================================================================ NightmareThorns

def build_thorns():
    """Black brambles bursting from a puddle of ink, ~3 m across and 2.5 m tall: hooked spires and low reaching
    runners, all bristling with thorns."""
    rnd = random.Random(6301)
    mb = B.MeshBuilder()
    zero = (0.0, 0.0, 0.0)

    # Ink puddle: splattered lobed disc, its thin outer lip the tintable edge.
    n = 22
    lobe = [1.0 + 0.22 * math.sin(3 * 2 * math.pi * s / n + 0.7) * math.sin(5 * 2 * math.pi * s / n)
            + rnd.uniform(-0.08, 0.12) for s in range(n)]
    prof = [(0.45, 0.16), (0.8, 0.1), (1.05, 0.06), (1.2, 0.025), (1.24, -0.03)]
    centre = mb.v((0, 0, 0.18), zero)
    rings = []
    for r, z in prof:
        ring = []
        for s in range(n):
            a = 2 * math.pi * s / n
            rr = r * (lobe[s] if r > 0.6 else 1.0)
            ring.append(mb.v((math.cos(a) * rr, math.sin(a) * rr, z), zero))
        rings.append(ring)
    for s in range(n):
        mb.f((centre, rings[0][s], rings[0][(s + 1) % n]), INK)
    for k, (ra, rb) in enumerate(zip(rings, rings[1:])):
        for s in range(n):
            s2 = (s + 1) % n
            mb.f((ra[s], rb[s], rb[s2], ra[s2]), EDGE if k == len(rings) - 2 else INK)
    # Root knot where the stems erupt.
    B.blob(mb, (0, 0, 0.12), (0.5, 0.45, 0.32), rnd, u=10, v=5, mat=INK, col=zero, rough=0.18, flat=0.7)

    def col_t(t, ph):
        return (t, ss(0.25, 0.6, t), ph)

    def bramble(ctrl, r0, ph, seg, stations, thorns, t_off=0.0, t_span=1.0):
        path = spline(ctrl, stations)
        m = stations - 1
        rads = [r0 * (1 - i / m) ** 0.85 + 0.004 for i in range(m)]
        cf = lambda t: col_t(t_off + t_span * t, ph)
        horn(mb, path, rads, seg=seg, mat=INK, col_fn=cf)
        # Thorns: hooked toward the tip, sized to the stem.
        for j in range(thorns):
            t = 0.12 + 0.72 * (j + rnd.uniform(-0.3, 0.3)) / max(1, thorns - 1)
            f = t * m
            i = min(int(f), m - 1)
            p = path[i].lerp(path[i + 1], f - i)
            tan = (path[i + 1] - path[i]).normalized()
            r = rads[i] + (rads[min(i + 1, m - 1)] - rads[i]) * (f - i)
            ref = UP if abs(tan.z) < 0.9 else X
            a = rnd.uniform(0, 6.28)
            nb = tan.cross(ref).normalized()
            nrm = (nb * math.cos(a) + tan.cross(nb) * math.sin(a)).normalized()
            d = (nrm + tan * 0.6).normalized()
            spike(mb, p + nrm * r * 0.4, d, 2.4 * r + 0.05, r * 0.55, cf(t), EDGE, rnd=rnd)
        return path, rads

    specs = [  # (yaw, kind, size)
        (0.3, "spire", 1.85), (2.4, "spire", 1.65), (4.3, "spire", 1.4),
        (1.25, "reach", 1.0), (3.3, "reach", 0.95), (5.3, "reach", 1.05), (0.0, "low", 0.95), (2.0, "low", 0.85),
        (3.9, "low", 1.0),
    ]
    for yaw, kind, size in specs:
        ph = rnd.random()
        yaw += rnd.uniform(-0.15, 0.15)
        out = V((math.cos(yaw), math.sin(yaw), 0))
        lat = V((-out.y, out.x, 0))
        root = out * rnd.uniform(0.08, 0.25) + UP * 0.05
        w = rnd.uniform(-0.25, 0.25)
        if kind == "spire":
            H = size
            ctrl = [root, root + out * 0.18 + UP * H * 0.25 + lat * w * 0.3, root + out * 0.22 + UP * H * 0.55 - lat * w * 0.4,
                    root + out * 0.3 + UP * H * 0.82 + lat * w * 0.3, root + out * 0.55 + UP * H,
                    root + out * 0.8 + UP * (H - 0.18), root + out * 0.8 + UP * (H - 0.38) - lat * 0.06]
            path, rads = bramble(ctrl, 0.13 * (H / 2.5) ** 0.5 + 0.03, ph, 6, 13, 10)
            branch_ts = (0.38, 0.6)
        elif kind == "reach":
            L = size
            ctrl = [root, root + out * 0.35 + UP * 0.55, root + out * 0.75 * L + UP * 0.95 + lat * w,
                    root + out * 1.05 * L + UP * 0.7 - lat * w * 0.5, root + out * 1.2 * L + UP * 0.35,
                    root + out * 1.3 * L + UP * 0.45 + lat * 0.1]
            path, rads = bramble(ctrl, 0.1, ph, 6, 11, 8)
            branch_ts = (0.45,)
        else:
            L = size
            ctrl = [root, root + out * 0.4 + UP * 0.28, root + out * 0.8 * L + UP * 0.38 + lat * w,
                    root + out * L + UP * 0.2, root + out * 1.15 * L + UP * 0.32 + lat * w * 0.5]
            path, rads = bramble(ctrl, 0.075, ph, 5, 9, 4)
            branch_ts = ()
        for bt in branch_ts:
            m = len(path) - 1
            i = int(bt * m)
            p = path[i]
            tan = (path[i + 1] - path[i]).normalized()
            sd = lat * (1 if rnd.random() > 0.5 else -1)
            L = rnd.uniform(0.45, 0.75)
            d0 = (sd + tan * 0.4 + UP * 0.3).normalized()
            ctrl = [p - d0 * 0.03, p + d0 * L * 0.4, p + d0 * L * 0.75 + UP * L * 0.25 + tan * 0.1,
                    p + d0 * L + UP * L * 0.3 + tan * 0.25]
            bramble(ctrl, rads[i] * 0.55, ph, 5, 8, 3, t_off=bt, t_span=1.0 - bt)

    return mb.build("NightmareThorns", ink_mats(eyes=False), smooth=True)


def export_nightmares():
    B.reset()
    objs = [build_wraith(), build_crawler(), build_thorns()]
    for o in objs:
        lo = [min(v.co[k] for v in o.data.vertices) for k in range(3)]
        hi = [max(v.co[k] for v in o.data.vertices) for k in range(3)]
        print(f"[lapis] {o.name}: {F.tri_count(o)} tris, volume {F.signed_volume(o):.3f}, "
              f"bbox {[round(a, 3) for a in lo]} .. {[round(a, 3) for a in hi]}")
    print(f"[lapis] Crawler HIP_Z = {CRAWLER_HIP_Z}")
    B.export("nightmares")


if __name__ == "__main__":
    export_nightmares()
