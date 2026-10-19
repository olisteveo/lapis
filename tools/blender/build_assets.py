"""Procedurally builds Lapis props and exports glTF (web) + FBX (s&box).

Run headless:  blender -b --factory-startup --python tools/blender/build_assets.py -- <out_dir> [asset ...]
Materials are placeholders keyed by name; the game swaps them for stylised node materials.

Vertex colour convention (COLOR_0), read by the game's shaders:
  R  gradient along the part, 0 at its root -> 1 at its tip (glow ramp, sway weight)
  G  part id: 0 trunk / hull, 1 frond / foliage, 0.5 fruit / detail
  B  per-part random, for desynchronising wind sway
"""
import math
import os
import random
import sys

import bpy
from mathutils import Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(ARGS[0] if ARGS else "public/models")
ONLY = set(ARGS[1:])
FBX_OUT = os.path.join(os.path.dirname(os.path.dirname(OUT)), "export", "fbx")
FPS = 30


# ---------------------------------------------------------------- utilities

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS


def material(name, rgb, double_sided=False, emission=None):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.85
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 4.0
    mat.use_backface_culling = not double_sided
    mat.diffuse_color = (*rgb, 1.0)
    return mat


class MeshBuilder:
    """Collects geometry plus per-vertex colours, then emits a Blender object."""

    def __init__(self):
        self.verts, self.faces, self.mats, self.cols = [], [], [], []

    def v(self, co, col=(0, 0, 0)):
        self.verts.append(tuple(co))
        self.cols.append((*col, 1.0))
        return len(self.verts) - 1

    def f(self, idx, mat=0):
        self.faces.append(tuple(idx))
        self.mats.append(mat)

    def merge(self, other, mat_offset=0):
        base = len(self.verts)
        self.verts += other.verts
        self.cols += other.cols
        self.faces += [tuple(i + base for i in face) for face in other.faces]
        self.mats += [m + mat_offset for m in other.mats]

    def build(self, name, materials, smooth=True, parent=None, location=(0, 0, 0), modifiers=()):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(self.verts, [], self.faces)
        mesh.validate()
        for m in materials:
            mesh.materials.append(m)
        for poly, mi in zip(mesh.polygons, self.mats):
            poly.material_index = mi
            poly.use_smooth = smooth
        attr = mesh.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        for i, c in enumerate(self.cols):
            attr.data[i].color = c
        mesh.color_attributes.active_color = attr
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = location
        if parent:
            obj.parent = parent
        for kind, opts in modifiers:
            mod = obj.modifiers.new(kind.lower(), kind)
            for k, val in opts.items():
                setattr(mod, k, val)
        return obj


def frame_along(path, i):
    p = Vector(path[i])
    a = Vector(path[max(i - 1, 0)])
    b = Vector(path[min(i + 1, len(path) - 1)])
    t = (b - a).normalized()
    ref = Vector((0, 0, 1)) if abs(t.z) < 0.95 else Vector((1, 0, 0))
    side = t.cross(ref).normalized()
    fwd = side.cross(t).normalized()
    return p, t, side, fwd


def tube(mb, path, radii, segments=8, mat=0, col_fn=None, cap_start=True, cap_end=True, squash=1.0):
    rings = []
    n = len(path)
    for i in range(n):
        p, _, side, fwd = frame_along(path, i)
        t = i / max(1, n - 1)
        col = col_fn(t) if col_fn else (t, 0, 0)
        ring = []
        for s in range(segments):
            a = 2 * math.pi * s / segments
            ring.append(mb.v(p + (side * math.cos(a) + fwd * math.sin(a) * squash) * radii[i], col))
        rings.append(ring)
    for ra, rb in zip(rings, rings[1:]):
        for s in range(segments):
            s2 = (s + 1) % segments
            mb.f((ra[s], rb[s], rb[s2], ra[s2]), mat)
    if cap_start:
        mb.f(rings[0], mat)
    if cap_end:
        mb.f(list(reversed(rings[-1])), mat)
    return rings


def sphere(mb, center, radius, u=10, v=7, mat=0, col=(0, 0, 0), scale=(1, 1, 1)):
    c = Vector(center)
    top = mb.v(c + Vector((0, 0, radius * scale[2])), col)
    rings = []
    for j in range(1, v):
        phi = math.pi * j / v
        ring = []
        for i in range(u):
            th = 2 * math.pi * i / u
            ring.append(mb.v(c + Vector((
                math.sin(phi) * math.cos(th) * radius * scale[0],
                math.sin(phi) * math.sin(th) * radius * scale[1],
                math.cos(phi) * radius * scale[2])), col))
        rings.append(ring)
    bot = mb.v(c - Vector((0, 0, radius * scale[2])), col)
    for i in range(u):
        mb.f((top, rings[0][i], rings[0][(i + 1) % u]), mat)
        mb.f((bot, rings[-1][(i + 1) % u], rings[-1][i]), mat)
    for ra, rb in zip(rings, rings[1:]):
        for i in range(u):
            i2 = (i + 1) % u
            mb.f((ra[i], rb[i], rb[i2], ra[i2]), mat)


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- palms

def palm_trunk(mb, rnd, height, lean, lean_dir, segments, ring_step):
    rings = max(6, int(height / ring_step))
    path, radii = [], []
    bend_phase = rnd.uniform(0, 6.28)
    for i in range(rings + 1):
        t = i / rings
        # Coconut palms curve up from a leaning base: strong lean low, recovering near the crown.
        off = lean * height * (t ** 1.6) * (1.0 - 0.35 * t)
        wob = 0.12 * math.sin(t * 5 + bend_phase) * t
        path.append((math.cos(lean_dir) * off + wob, math.sin(lean_dir) * off, height * t))
        r = 0.16 + 0.12 * (1 - t) ** 1.5
        r *= 1.0 + 0.9 * math.exp(-t * height * 1.2)  # root flare
        if i % 2 == 1 and segments > 5:
            r *= 0.94  # leaf-scar rings
        radii.append(r)
    tube(mb, path, radii, segments=segments, mat=0, col_fn=lambda t: (t, 0.0, 0.0), cap_start=False)
    p, t, side, fwd = frame_along(path, len(path) - 1)
    return p, t


def palm_frond_hi(mb, base, yaw, elev, length, droop, rnd, phase):
    d = Vector((math.cos(yaw) * math.cos(elev), math.sin(yaw) * math.cos(elev), math.sin(elev)))
    horiz = Vector((math.cos(yaw), math.sin(yaw), 0))
    side = Vector((-horiz.y, horiz.x, 0))
    up = Vector((0, 0, 1))
    stations = 30
    spine = []
    for i in range(stations + 1):
        t = i / stations
        # Rachis: launches along its elevation, then gravity bends it down quadratically.
        spine.append(base + d * (length * t) - up * (droop * length * t * t))
    col_rachis = lambda t: (t, 1.0, phase)
    tube(mb, spine, [0.05 * (1 - 0.8 * i / stations) for i in range(stations + 1)], segments=3, mat=1,
         col_fn=col_rachis, cap_start=False, cap_end=False)
    for i in range(2, stations + 1):
        t = i / stations
        p = spine[i]
        tangent = (spine[min(i + 1, stations)] - spine[i - 1]).normalized()
        leaf_len = length * 0.28 * math.sin(math.pi * min(1.0, 0.1 + t * 0.95)) ** 0.6
        for s in (-1, 1):
            # Leaflets angle forward along the rachis and hang more toward the frond tip.
            hang = 0.35 + 0.9 * t + rnd.uniform(-0.15, 0.15)
            dirv = (side * s * math.cos(hang) - up * math.sin(hang) + tangent * 0.45).normalized()
            tip = p + dirv * leaf_len
            w = 0.045 + 0.03 * (1 - t)
            n = tangent * w
            mid = p + dirv * leaf_len * 0.45 - up * 0.04
            a = mb.v(p, (t, 1.0, phase))
            b = mb.v(mid + n, (t, 1.0, phase))
            c = mb.v(tip, (min(1.0, t + 0.08), 1.0, phase))
            e = mb.v(mid - n, (t, 1.0, phase))
            mb.f((a, b, c, e), 1)


def palm_frond_lo(mb, base, yaw, elev, length, droop, phase):
    d = Vector((math.cos(yaw) * math.cos(elev), math.sin(yaw) * math.cos(elev), math.sin(elev)))
    horiz = Vector((math.cos(yaw), math.sin(yaw), 0))
    side = Vector((-horiz.y, horiz.x, 0))
    up = Vector((0, 0, 1))
    stations = 4
    rows = []
    for i in range(stations + 1):
        t = i / stations
        p = base + d * (length * t) - up * (droop * length * t * t)
        w = length * 0.2 * math.sin(math.pi * min(1.0, 0.1 + t)) ** 0.6
        col = (t, 1.0, phase)
        rows.append((mb.v(p + side * w - up * w * 0.6, col), mb.v(p, col), mb.v(p - side * w - up * w * 0.6, col)))
    for ra, rb in zip(rows, rows[1:]):
        mb.f((ra[1], rb[1], rb[0], ra[0]), 1)
        mb.f((ra[2], rb[2], rb[1], ra[1]), 1)


def build_palm(name, height, lean, seed, fronds, frond_len, lod):
    rnd = random.Random(seed)
    mb = MeshBuilder()
    lean_dir = rnd.uniform(0, 2 * math.pi)
    hi = lod == "hi"
    crown, _ = palm_trunk(mb, rnd, height, lean, lean_dir, 9 if hi else 5, 0.35 if hi else height / 5)
    # Golden-angle phyllotaxis: fronds spiral like the real crown, oldest (lowest) drooping most.
    golden = math.pi * (3 - math.sqrt(5))
    for k in range(fronds):
        age = k / max(1, fronds - 1)  # 0 youngest -> 1 oldest
        yaw = k * golden + rnd.uniform(-0.1, 0.1)
        elev = math.radians(70 - 95 * age + rnd.uniform(-8, 8))
        length = frond_len * (0.65 + 0.4 * age) * rnd.uniform(0.9, 1.1)
        droop = 0.25 + 0.55 * age
        base = crown - Vector((0, 0, 0.25 * age))
        phase = rnd.random()
        if hi:
            palm_frond_hi(mb, base, yaw, elev, length, droop, rnd, phase)
        elif k % 2 == 0 or age > 0.5:
            # Distant crowns only need the silhouette: skip half the young upright fronds.
            palm_frond_lo(mb, base, yaw, elev, length, droop, phase)
    if hi:
        for k in range(rnd.randint(4, 7)):
            a = rnd.uniform(0, 6.28)
            c = crown + Vector((math.cos(a) * 0.22, math.sin(a) * 0.22, -0.35 - rnd.uniform(0, 0.25)))
            sphere(mb, c, 0.13, u=7, v=5, mat=2, col=(1.0, 0.5, rnd.random()))
    mats = [material("trunk", (0.85, 0.55, 0.5)), material("frond", (0.95, 0.45, 0.4), True), material("fruit", (0.5, 0.3, 0.2))]
    return mb.build(name, mats, smooth=hi)


def build_bush(name, radius, seed, lod):
    """Broad-leaf jungle clump: a cluster of drooping leaf cards around a dark core."""
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    sphere(mb, (0, 0, radius * 0.35), radius * 0.6, u=8 if hi else 5, v=5 if hi else 3, mat=0,
           col=(0.0, 0.0, 0.0), scale=(1, 1, 0.7))
    leaves = 46 if hi else 14
    up = Vector((0, 0, 1))
    for k in range(leaves):
        yaw = rnd.uniform(0, 6.28)
        elev = rnd.uniform(0.1, 1.2)
        base = Vector((rnd.uniform(-0.3, 0.3) * radius, rnd.uniform(-0.3, 0.3) * radius, radius * rnd.uniform(0.2, 0.6)))
        d = Vector((math.cos(yaw) * math.cos(elev), math.sin(yaw) * math.cos(elev), math.sin(elev)))
        side = Vector((-math.sin(yaw), math.cos(yaw), 0))
        L = radius * rnd.uniform(0.8, 1.2)
        W = L * 0.28
        stations = 4 if hi else 2
        rows = []
        phase = rnd.random()
        for i in range(stations + 1):
            t = i / stations
            p = base + d * L * t - up * (0.5 * L * t * t)
            w = W * math.sin(math.pi * min(1.0, 0.15 + t * 0.9))
            rows.append((mb.v(p + side * w - up * w * 0.3, (t, 1.0, phase)), mb.v(p, (t, 1.0, phase)),
                         mb.v(p - side * w - up * w * 0.3, (t, 1.0, phase))))
        for ra, rb in zip(rows, rows[1:]):
            mb.f((ra[1], rb[1], rb[0], ra[0]), 1)
            mb.f((ra[2], rb[2], rb[1], ra[1]), 1)
    return mb.build(name, [material("foliage_core", (0.03, 0.06, 0.05)), material("foliage", (0.08, 0.16, 0.1), True)], smooth=hi)


# ---------------------------------------------------------------- jungle

UP = Vector((0, 0, 1))
GOLDEN = math.pi * (3 - math.sqrt(5))


def dir_vec(yaw, elev):
    return Vector((math.cos(yaw) * math.cos(elev), math.sin(yaw) * math.cos(elev), math.sin(elev)))


def horiz_side(yaw):
    return Vector((-math.sin(yaw), math.cos(yaw), 0))


def ptube(mb, path, radii, segments=8, mat=0, col_fn=None, cap_start=False, cap_end=True, radial_fn=None):
    """Outward-facing tube on rotation-minimising frames, so limbs that bend through vertical don't twist.
    radial_fn(t, angle) scales the radius per vertex (bark fluting, shaggy fibre)."""
    path = [Vector(p) for p in path]
    n = len(path)
    tans = [(path[min(i + 1, n - 1)] - path[max(i - 1, 0)]).normalized() for i in range(n)]
    ref = Vector((1, 0, 0)) if abs(tans[0].x) < 0.9 else Vector((0, 1, 0))
    nrm = (ref - tans[0] * ref.dot(tans[0])).normalized()
    rings = []
    for i in range(n):
        if i:
            nrm = tans[i - 1].rotation_difference(tans[i]) @ nrm
            nrm = (nrm - tans[i] * nrm.dot(tans[i])).normalized()
        bi = tans[i].cross(nrm)
        t = i / max(1, n - 1)
        col = col_fn(t) if col_fn else (t, 0, 0)
        ring = []
        for s in range(segments):
            a = 2 * math.pi * s / segments
            r = radii[i] * (radial_fn(t, a) if radial_fn else 1.0)
            ring.append(mb.v(path[i] + (nrm * math.cos(a) + bi * math.sin(a)) * r, col))
        rings.append(ring)
    for ra, rb in zip(rings, rings[1:]):
        for s in range(segments):
            s2 = (s + 1) % segments
            mb.f((ra[s], rb[s], rb[s2], ra[s2]), mat)
    if cap_start:
        mb.f(rings[0], mat)
    if cap_end:
        mb.f(list(reversed(rings[-1])), mat)
    return rings


def loft(mb, rows, mat):
    """Joins rows of vertex ids (each ordered across the width) into a sheet; a 1-vertex row closes a tip.
    Winding puts the normal on length x width, i.e. the leaf's upper face."""
    for ra, rb in zip(rows, rows[1:]):
        if len(ra) == len(rb):
            for j in range(len(ra) - 1):
                mb.f((ra[j], rb[j], rb[j + 1], ra[j + 1]), mat)
        elif len(rb) == 1:
            for j in range(len(ra) - 1):
                mb.f((ra[j], rb[0], ra[j + 1]), mat)
        elif len(ra) == 1:
            for j in range(len(rb) - 1):
                mb.f((ra[0], rb[j], rb[j + 1]), mat)


def bend_spine(base, yaw, e0, e1, length, stations, power=1.0, wander=0.0, rnd=None):
    """Integrates a heading whose elevation eases from e0 to e1: arching fronds, rising-then-levelling limbs."""
    pts = [Vector(base)]
    step = length / stations
    ph = rnd.uniform(0, 6.28) if rnd else 0.0
    for i in range(stations):
        t = (i + 0.5) / stations
        e = e0 + (e1 - e0) * t ** power
        y = yaw + wander * math.sin(t * 4.0 + ph)
        pts.append(pts[-1] + dir_vec(y, e) * step)
    return pts


def gravity_spine(base, yaw, elev, length, droop, stations):
    d = dir_vec(yaw, elev)
    return [Vector(base) + d * (length * i / stations) - UP * (droop * length * (i / stations) ** 2) for i in range(stations + 1)]


def spine_frames(spine, yaw, roll=0.0):
    """Per-station (tangent, side, normal); side stays horizontal-ish so blades lie flat before roll."""
    n = len(spine)
    s0 = horiz_side(yaw)
    out = []
    for i in range(n):
        tan = (spine[min(i + 1, n - 1)] - spine[max(i - 1, 0)]).normalized()
        side = s0 - tan * s0.dot(tan)
        side = side.normalized() if side.length > 1e-6 else s0
        nrm = tan.cross(side).normalized()
        if roll:
            side = (side * math.cos(roll) + nrm * math.sin(roll)).normalized()
            nrm = tan.cross(side).normalized()
        out.append((tan, side, nrm))
    return out


def leaf_blade(mb, spine, widths, yaw, fold, mat, col_fn, roll=0.0, cols=(-1, 0, 1)):
    """Lofts a blade along its spine. fold > 0 arches the halves down off the midrib."""
    rows = []
    frames = spine_frames(spine, yaw, roll)
    n = len(spine)
    for i, (p, w, (tan, side, nrm)) in enumerate(zip(spine, widths, frames)):
        col = col_fn(i / max(1, n - 1))
        if w < 1e-4:
            rows.append([mb.v(p, col)])
            continue
        rows.append([mb.v(p + side * (k * w) - nrm * (fold * w * k * k), col) for k in cols])
    loft(mb, rows, mat)


def umbrella(mb, center, radius, drop, rnd, rim=8, mat=0, col=(1.0, 1.0, 0.0), inner=False, star=False):
    """Shallow ragged dome: a cheap foliage mass that keeps a leafy rim in silhouette.
    star alternates long and short rim points so the outline reads as leaf tips, not a hat brim."""
    c = mb.v(center, (0.0, col[1], col[2]))
    pts = []
    ph = rnd.uniform(0, 6.28)
    for j in range(rim):
        a = ph + 2 * math.pi * j / rim
        r = radius * rnd.uniform(0.7, 1.15) * (0.6 if star and j % 2 else 1.0)
        pts.append((a, r))
    ring_o = [mb.v(center + Vector((math.cos(a) * r, math.sin(a) * r, -drop * (r / radius) * rnd.uniform(0.8, 1.25))), col)
              for a, r in pts]
    if inner:
        ring_i = [mb.v(center + Vector((math.cos(a) * r * 0.55, math.sin(a) * r * 0.55, -drop * 0.22)), (0.5, col[1], col[2])) for a, r in pts]
        for j in range(rim):
            j2 = (j + 1) % rim
            mb.f((c, ring_i[j], ring_i[j2]), mat)
            mb.f((ring_i[j], ring_o[j], ring_o[j2], ring_i[j2]), mat)
    else:
        for j in range(rim):
            mb.f((c, ring_o[j], ring_o[(j + 1) % rim]), mat)


# --- trees: a shared skeleton plan, so _hi and _lo keep the same silhouette

def plan_canopy(seed, height, crown_r, n_limbs, n_fins):
    """Rainforest emergent: buttressed clear bole to ~2/3 height, then a few big limbs fanning into an umbrella."""
    rnd = random.Random(seed)
    H = height
    k = H / 20.0
    bole = H * rnd.uniform(0.6, 0.66)
    lean_dir = rnd.uniform(0, 2 * math.pi)
    lean = rnd.uniform(0.015, 0.04)
    ph1, ph2 = rnd.uniform(0, 6.28), rnd.uniform(0, 6.28)
    r_base = 0.72 * k + 0.08
    trunk, radii = [], []
    rings = 18
    top = bole
    for i in range(rings + 1):
        t = i / rings
        z = -0.6 + (top + 0.6) * t
        zt = max(0.0, z) / top
        # Sinuous bole: two low-frequency wobbles that grow with height, plus a slight overall lean.
        x = math.cos(lean_dir) * lean * H * zt + 0.55 * k * math.sin(zt * 3.1 + ph1) * zt
        y = math.sin(lean_dir) * lean * H * zt + 0.55 * k * math.sin(zt * 2.6 + ph2) * zt
        r = r_base * (1 - 0.38 * zt) * (1 + 0.7 * math.exp(-max(0.0, z) / (1.3 * k)))
        trunk.append(Vector((x, y, z)))
        radii.append(r)

    fins = []
    a0 = rnd.uniform(0, 6.28)
    for f in range(n_fins):
        a = a0 + 2 * math.pi * f / n_fins + rnd.uniform(-0.35, 0.35)
        fins.append(dict(a=a, reach=rnd.uniform(2.6, 3.8) * k, h=rnd.uniform(3.2, 5.0) * k,
                         bend=rnd.uniform(-0.5, 0.5), th=rnd.uniform(0.2, 0.3) * k,
                         root=rnd.uniform(1.8, 3.2) * k))

    boughs, tips = [], []

    def sample(path, rads, t):
        f = t * (len(path) - 1)
        i = min(int(f), len(path) - 2)
        u = f - i
        return path[i].lerp(path[i + 1], u), rads[i] + (rads[i + 1] - rads[i]) * u

    def grow(start, yaw, e0, e1, L, r0, depth):
        st = 8 if depth == 0 else (5 if depth == 1 else 4)
        path = bend_spine(start, yaw, e0, e1, L, st, power=0.8, wander=0.12, rnd=rnd)
        rads = [r0 * (1 - 0.62 * (i / st)) for i in range(st + 1)]
        boughs.append((path, rads, depth))
        if depth < 2:
            kids = 3 if depth == 0 else rnd.randint(1, 2)
            for c in range(kids):
                t = rnd.uniform(0.5, 0.85) if c else rnd.uniform(0.85, 0.97)
                p, r = sample(path, rads, t)
                sgn = 1 if c % 2 else -1
                grow(p, yaw + sgn * rnd.uniform(0.45, 1.0), math.radians(rnd.uniform(25, 45)),
                     math.radians(rnd.uniform(-8, 12)), L * rnd.uniform(0.42, 0.58), r * 0.82, depth + 1)
        size = (1.0 if depth == 2 else 1.25) * k
        tips.append((path[-1], yaw, size, depth))
        if depth == 1:
            # Extra foliage along the branch fills the crown into layered cushions rather than tip pompoms.
            tips.append((path[len(path) // 2], yaw + rnd.uniform(-0.8, 0.8), 0.85 * k, 2))

    tyaw = rnd.uniform(0, 6.28)
    for li in range(n_limbs):
        # The first limb carries on from the bole's end at full radius so the fork has no visible seam.
        t = rnd.uniform(0.78, 0.95) if li else 0.97
        p, r = sample(trunk, radii, t)
        yaw = tyaw + 2 * math.pi * li / n_limbs + rnd.uniform(-0.3, 0.3)
        grow(p, yaw, math.radians(rnd.uniform(48, 66) if li else 82), math.radians(rnd.uniform(4, 18)),
             crown_r * rnd.uniform(0.62, 0.8), r * (0.72 if li else 0.9), 0)
    return dict(trunk=(trunk, radii), fins=fins, boughs=boughs, tips=tips, r_base=r_base, k=k,
                pads=True, spray_n=(1, 2), blade=(1.5 * k + 0.3, 6))


def plan_understory(seed, height, crown_r):
    """Slender sub-canopy tree with tiered, nearly horizontal branches: a loose, see-through crown."""
    rnd = random.Random(seed)
    H = height
    lean_dir = rnd.uniform(0, 6.28)
    ph = rnd.uniform(0, 6.28)
    trunk, radii = [], []
    rings = 14
    for i in range(rings + 1):
        t = i / rings
        z = -0.2 + (H * 0.9 + 0.2) * t
        zt = max(0.0, z) / H
        off = 0.35 * math.sin(zt * 2.4 + ph) * zt + 0.5 * zt * zt
        trunk.append(Vector((math.cos(lean_dir) * off, math.sin(lean_dir) * off, z)))
        radii.append(0.13 * (1 - 0.6 * zt) * (1 + 0.5 * math.exp(-max(0.0, z) * 2.5)))
    boughs, tips = [], []
    tiers = 4
    yaw = rnd.uniform(0, 6.28)
    for ti in range(tiers):
        u = ti / (tiers - 1)
        idx = int((0.5 + 0.42 * u) * rings)
        for b in range(3 if ti < tiers - 1 else 2):
            yaw += GOLDEN * 1.3 + rnd.uniform(-0.25, 0.25)
            # Rounded crown: middle tiers reach furthest.
            L = crown_r * (0.75 + 0.35 * math.sin(math.pi * (0.25 + 0.6 * u))) * (1.0 - 0.3 * u) * rnd.uniform(0.8, 1.1)
            path = bend_spine(trunk[idx], yaw, math.radians(rnd.uniform(18, 38)), math.radians(rnd.uniform(-6, 8)),
                              L, 5, power=0.7, wander=0.18, rnd=rnd)
            r0 = radii[idx] * 0.6
            boughs.append((path, [r0 * (1 - 0.7 * i / 5) for i in range(6)], 1))
            tips.append((path[-1], yaw, 0.95, 1))
            if rnd.random() < 0.7:
                tips.append((path[3], yaw + rnd.uniform(-1, 1), 0.7, 2))
    tips.append((trunk[-1], yaw, 0.8, 1))
    return dict(trunk=(trunk, radii), fins=[], boughs=boughs, tips=tips, r_base=0.13, k=0.35,
                pads=False, spray_n=(1, 3), blade=(0.95, 5))


def leaf_spray(mb, center, yaw_out, size, n, rnd, phase, mat):
    """A rosette of drooping oval blades: the basic leaf unit of the broadleaf crowns."""
    for b in range(n):
        yaw = yaw_out + 2 * math.pi * b / n + rnd.uniform(-0.35, 0.35)
        outward = math.cos(yaw - yaw_out)
        elev = rnd.uniform(0.05, 0.5) - 0.2 * outward
        L = size * rnd.uniform(0.75, 1.1)
        W = L * 0.28
        spine = gravity_spine(center, yaw, elev, L, rnd.uniform(0.3, 0.55), 3)
        widths = [W * 0.35, W, W * 0.8, 0.0]
        leaf_blade(mb, spine, widths, yaw, 0.35, mat, lambda t: (t, 1.0, phase), roll=rnd.uniform(-0.35, 0.35))


def build_tree(name, plan, seed, lod):
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    k = plan["k"]
    trunk, radii = plan["trunk"]
    bark_ph = rnd.uniform(0, 6.28)
    if hi:
        # Shallow fluting reads as bark relief under rim light without any texture.
        flute = lambda t, a: 1.0 + 0.045 * math.sin(a * 7 + bark_ph + t * 2.0)
        ptube(mb, trunk, radii, segments=12, mat=0, col_fn=lambda t: (t, 0.0, 0.0), radial_fn=flute)
    else:
        idx = list(range(0, len(trunk), 3)) + ([len(trunk) - 1] if (len(trunk) - 1) % 3 else [])
        ptube(mb, [trunk[i] for i in idx], [radii[i] for i in idx], segments=6, mat=0, col_fn=lambda t: (t, 0.0, 0.0))

    base = trunk[0].copy()
    base.z = 0.0
    for fin in plan["fins"]:
        st = 7 if hi else 3
        r_in = plan["r_base"] * 0.5
        R = fin["reach"]
        rows, centers = [], []
        for i in range(st + 1):
            u = i / st
            rho = r_in + (R - r_in) * u
            a = fin["a"] + fin["bend"] * u * u
            c = base + Vector((math.cos(a) * rho, math.sin(a) * rho, 0))
            fwd = Vector((math.cos(a), math.sin(a), 0))
            side = Vector((-fwd.y, fwd.x, 0))
            # Concave top edge: tall where it meets the trunk, sweeping down to a knife edge on the ground.
            zt = fin["h"] * (1 - u) ** 2.3 + 0.04
            th = fin["th"] * (1 - 0.75 * u) + 0.02
            zb = -0.6
            prof = ([(-1.0, zb), (-0.95, 0.45), (-0.65, 0.85), (0.0, 1.0), (0.65, 0.85), (0.95, 0.45), (1.0, zb)]
                    if hi else [(-1.0, zb), (0.0, 1.0), (1.0, zb)])
            col = (0.0, 0.0, 0.0)
            row = [mb.v(c + side * (th * sx) + UP * (zz if zz < 0 else zt * zz), col) for sx, zz in prof]
            rows.append(row)
            centers.append((c, fwd))
        for ra, rb in zip(rows, rows[1:]):
            for j in range(len(ra) - 1):
                mb.f((ra[j], rb[j], rb[j + 1], ra[j + 1]), 0)
        mb.f(list(reversed(rows[-1])), 0)
        if hi:
            # The fin runs on as a surface root snaking over the ground.
            c, fwd = centers[-1]
            a = fin["a"] + fin["bend"]
            path = [c - fwd * 0.3 + UP * 0.0]
            for i in range(1, 6):
                a += rnd.uniform(-0.35, 0.35)
                path.append(path[-1] + Vector((math.cos(a), math.sin(a), 0)) * (fin["root"] / 5) + UP * (-0.012 * i))
            ptube(mb, path, [0.15 * k * (1 - 0.7 * i / 5) + 0.03 for i in range(6)], segments=5, mat=0,
                  col_fn=lambda t: (0.0, 0.0, 0.0))

    for path, rads, depth in plan["boughs"]:
        if hi:
            ptube(mb, path, rads, segments=(8, 5, 3)[min(depth, 2)], mat=0, col_fn=lambda t: (t, 0.0, 0.0))
        elif depth < 2:
            step = 2 if depth == 0 else len(path) - 1
            idx = list(range(0, len(path), step)) + ([len(path) - 1] if (len(path) - 1) % step else [])
            ptube(mb, [path[i] for i in idx], [rads[i] for i in idx], segments=4 if depth == 0 else 3, mat=0,
                  col_fn=lambda t: (t, 0.0, 0.0))

    blade_len, blades = plan["blade"]
    for pos, yaw, size, depth in plan["tips"]:
        phase = rnd.random()
        if hi:
            lo_n, hi_n = plan["spray_n"]
            for s in range(rnd.randint(lo_n, hi_n)):
                if s == 0:
                    c = pos + UP * 0.1
                else:
                    a = yaw + rnd.uniform(-1.6, 1.6)
                    c = pos + Vector((math.cos(a), math.sin(a), 0)) * size * rnd.uniform(0.6, 1.2) + UP * rnd.uniform(-0.3, 0.35) * size
                    ptube(mb, [pos, pos.lerp(c, 0.5) + UP * 0.12 * size, c], [0.035 * k + 0.01, 0.025 * k + 0.008, 0.012],
                          segments=3, mat=0, col_fn=lambda t: (0.8 + 0.2 * t, 0.0, phase), cap_end=False)
                leaf_spray(mb, c, yaw + rnd.uniform(-0.4, 0.4), blade_len * rnd.uniform(0.85, 1.15), blades, rnd,
                           rnd.random(), 1)
            if plan["pads"]:
                umbrella(mb, pos + UP * 0.2 * size, 1.2 * size, 0.5 * size, rnd, rim=9, mat=2, col=(0.6, 1.0, phase))
        elif depth < 2 or not plan["pads"]:
            umbrella(mb, pos + UP * 0.45 * size, (2.6 if plan["pads"] else 1.25) * size, 0.9 * size, rnd, rim=10,
                     mat=1, col=(1.0, 1.0, phase), star=True)
    mats = [material("bark", (0.16, 0.12, 0.1)), material("foliage", (0.08, 0.16, 0.1), True),
            material("canopy_core", (0.03, 0.07, 0.05), True)]
    return mb.build(name, mats, smooth=True)


# --- ferns

def fern_frond(mb, base, yaw, e0, e1, length, rnd, phase, pairs, pinna_rows, pinna_len, mat, rachis_r, power=1.4,
               rachis_seg=3):
    """Arching frond: rachis eases from steep to drooping, with paired pinnae swept toward the tip."""
    spine = bend_spine(base, yaw, e0, e1, length, pairs, power=power, wander=0.06, rnd=rnd)
    frames = spine_frames(spine, yaw)
    n = len(spine)
    r_idx = list(range(0, n, 2)) + ([n - 1] if (n - 1) % 2 else [])
    ptube(mb, [spine[i] for i in r_idx], [rachis_r * (1 - 0.8 * i / (n - 1)) for i in r_idx], segments=rachis_seg,
          mat=mat, col_fn=lambda t: (t, 1.0, phase), cap_end=False)
    stipe = 0.14
    for i in range(1, n):
        u = i / (n - 1)
        if u < stipe:
            continue
        f = (u - stipe) / (1 - stipe)
        # Lanceolate outline: pinnae longest about a third of the way up, tapering to the tip.
        Lp = pinna_len * (f ** 0.5) * ((1 - f) ** 0.9) / 0.402 + 0.02
        p = spine[i]
        tan, side, nrm = frames[i]
        for s in (-1, 1):
            sweep = 0.55 + 0.35 * f + rnd.uniform(-0.08, 0.08)
            dirv = (side * s * math.cos(sweep) + tan * math.sin(sweep) + nrm * (0.25 - 0.5 * f)).normalized()
            e = nrm.cross(dirv).normalized()
            rows = []
            for ru, rw in pinna_rows:
                q = p + dirv * (Lp * ru) - nrm * (Lp * 0.18 * ru * ru)
                col = (u, 1.0, phase)
                w = rw * Lp * 0.24
                rows.append([mb.v(q, col)] if w < 1e-4 else [mb.v(q - e * w, col), mb.v(q + e * w, col)])
            loft(mb, rows if s > 0 else [list(reversed(r)) for r in rows], mat)
    return spine


def fern_frond_lo(mb, base, yaw, e0, e1, length, phase, mat, power=1.4, width=0.2):
    spine = bend_spine(base, yaw, e0, e1, length, 5, power=power)
    n = len(spine)
    widths = [length * width * (f ** 0.5) * ((1 - f) ** 0.9) / 0.402 for f in (i / (n - 1) for i in range(n))]
    leaf_blade(mb, spine, widths, yaw, 0.15, mat, lambda t: (t, 1.0, phase))


def fiddlehead(mb, base, yaw, height, curl_r, mat, phase):
    """Uncurling crozier: a stalk that rolls into a tight spiral at its top."""
    path = [Vector(base) + UP * (height * i / 6) for i in range(6)]
    top = path[-1]
    out = dir_vec(yaw, 0)
    for j in range(1, 13):
        a = j / 12 * math.pi * 1.8
        r = curl_r * (1 - 0.6 * j / 12)
        path.append(top + out * (r - r * math.cos(a)) + UP * (r * math.sin(a)))
    ptube(mb, path, [0.018 * (1 - 0.55 * i / len(path)) for i in range(len(path))], segments=4, mat=mat,
          col_fn=lambda t: (t, 0.5, phase))


GROUND_PINNA = [(0.0, 0.3), (0.45, 1.0), (1.0, 0.0)]
LACE_PINNA = [(0.0, 0.35), (0.18, 1.0), (0.36, 0.55), (0.56, 0.85), (0.76, 0.4), (1.0, 0.0)]


def build_fern(name, seed, size, fronds, upright, lod):
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    yaw0 = rnd.uniform(0, 6.28)
    for k in range(fronds):
        age = rnd.random()
        yaw = yaw0 + k * GOLDEN + rnd.uniform(-0.15, 0.15)
        L = size * rnd.uniform(0.8, 1.1) * (0.85 + 0.25 * age)
        e0 = math.radians(78 - 20 * age + 10 * upright + rnd.uniform(-6, 6))
        e1 = math.radians(-18 - 45 * age + 25 * upright + rnd.uniform(-8, 8))
        base = Vector((math.cos(yaw) * 0.04, math.sin(yaw) * 0.04, 0.0))
        phase = rnd.random()
        if hi:
            fern_frond(mb, base, yaw, e0, e1, L, rnd, phase, 16, GROUND_PINNA, L * 0.17, 0, 0.012 * size)
        else:
            fern_frond_lo(mb, base, yaw, e0, e1, L, phase, 0, width=0.13)
    if hi:
        for j in range(2):
            a = rnd.uniform(0, 6.28)
            fiddlehead(mb, Vector((math.cos(a) * 0.05, math.sin(a) * 0.05, 0)), a, size * rnd.uniform(0.25, 0.4),
                       0.05 * size, 0, rnd.random())
    return mb.build(name, [material("fern", (0.1, 0.2, 0.12), True)], smooth=hi)


def build_tree_fern(name, seed, height, lod):
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    lean_dir = rnd.uniform(0, 6.28)
    ph = rnd.uniform(0, 6.28)
    rings = 22 if hi else 5
    path, radii = [], []
    for i in range(rings + 1):
        t = i / rings
        z = -0.2 + (height + 0.2) * t
        off = 0.25 * t * t + 0.12 * math.sin(t * 3 + ph) * t
        path.append(Vector((math.cos(lean_dir) * off, math.sin(lean_dir) * off, z)))
        radii.append(0.15 * (1 - 0.2 * t) * (1 + 1.0 * math.exp(-max(0.0, z) * 3.0)))
    jit = random.Random(seed + 7)
    # Matted fibre: independent per-vertex radius noise makes a shaggy, hairy silhouette.
    shag = (lambda t, a: 1.0 + jit.uniform(-0.2, 0.42)) if hi else None
    ptube(mb, path, radii, segments=11 if hi else 5, mat=0, col_fn=lambda t: (t * 0.3, 0.0, 0.0), radial_fn=shag)
    crown = path[-1]
    fronds = 10
    yaw0 = rnd.uniform(0, 6.28)
    for k in range(fronds):
        yaw = yaw0 + k * GOLDEN + rnd.uniform(-0.1, 0.1)
        L = rnd.uniform(2.3, 2.9)
        e0 = math.radians(rnd.uniform(45, 62))
        e1 = math.radians(rnd.uniform(-42, -22))
        phase = rnd.random()
        b = crown + Vector((math.cos(yaw) * 0.08, math.sin(yaw) * 0.08, 0))
        if hi:
            fern_frond(mb, b, yaw, e0, e1, L, rnd, phase, 13, LACE_PINNA, L * 0.25, 1, 0.025, power=1.2, rachis_seg=4)
        else:
            fern_frond_lo(mb, b, yaw, e0, e1, L, phase, 1, power=1.2, width=0.25)
    # Skirt of dead fronds hanging against the trunk below the crown.
    for k in range(6):
        yaw = rnd.uniform(0, 6.28)
        L = rnd.uniform(1.3, 1.9)
        b = crown + Vector((math.cos(yaw) * 0.14, math.sin(yaw) * 0.14, -0.15 - rnd.uniform(0, 0.25)))
        phase = rnd.random()
        if hi:
            fern_frond(mb, b, yaw, math.radians(-10), math.radians(-82), L, rnd, phase, 8,
                       [(0.0, 0.3), (0.5, 0.7), (1.0, 0.0)], L * 0.11, 1, 0.018, power=0.8)
        else:
            fern_frond_lo(mb, b, yaw, math.radians(-10), math.radians(-82), L, phase, 1, power=0.8, width=0.08)
    if hi:
        for j in range(3):
            a = rnd.uniform(0, 6.28)
            fiddlehead(mb, crown + Vector((math.cos(a) * 0.06, math.sin(a) * 0.06, 0)), a, rnd.uniform(0.25, 0.45),
                       0.09, 1, rnd.random())
    return mb.build(name, [material("bark", (0.16, 0.12, 0.1)), material("fern", (0.1, 0.2, 0.12), True)], smooth=True)


# --- banana / heliconia

def banana_leaf(mb, base, yaw, elev, L, droop, rnd, phase, mat, hi, age):
    W = L * 0.16
    st = 12 if hi else 4
    spine = gravity_spine(base, yaw, elev, L, droop, st)
    roll = rnd.uniform(-0.25, 0.25)
    frames = spine_frames(spine, yaw, roll)
    n = len(spine)
    widths = [W * math.sin(math.pi * (i / (n - 1))) ** 0.42 for i in range(n)]
    fold = 0.28 + 0.2 * age
    col = lambda i: (i / (n - 1), 1.0, phase)
    if not hi:
        leaf_blade(mb, spine, widths, yaw, fold, mat, lambda t: (t, 1.0, phase), roll=roll)
        return
    mids = [mb.v(spine[i] + frames[i][2] * (0.015 * widths[i] / W), col(i)) for i in range(n)]
    for s in (-1, 1):
        # Wind shreds banana blades along their veins: split the half-blade into panels that hang at different angles.
        tears = set(rnd.sample(range(2, n - 2), rnd.randint(1, 2) + int(age * 3)))
        extra = rnd.uniform(0.0, 0.1)
        rows = []
        for i in range(n):
            tan, side, nrm = frames[i]
            w = widths[i]
            if w < 1e-4:
                rows.append(([mids[i]], [mids[i]]))
                continue

            def mk(shift, ex):
                r = [mids[i]]
                for kk in (0.5, 1.0):
                    wave = 0.012 * L * math.sin(i * 2.3 + s) * kk
                    off = side * (s * kk * w) - nrm * ((fold + ex) * w * kk * kk) + tan * (shift * kk) + nrm * wave
                    r.append(mb.v(spine[i] + off, col(i)))
                return r if s > 0 else list(reversed(r))

            if i in tears:
                gap = 0.025 * L
                a = mk(-gap, extra)
                extra = rnd.uniform(0.0, 0.35) * (0.5 + age)
                rows.append((a, mk(gap, extra)))
            else:
                r = mk(0.0, extra)
                rows.append((r, r))
        for i in range(n - 1):
            loft(mb, [rows[i][1], rows[i + 1][0]], mat)


def build_banana(name, seed, lod):
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    stems = [(Vector((0, 0, 0)), 2.3, 6, 2.1), (None, 1.4, 4, 1.5), (None, 0.8, 3, 1.1)]
    a0 = rnd.uniform(0, 6.28)
    for si, (pos, h, n_leaves, leaf_len) in enumerate(stems):
        if pos is None:
            a = a0 + si * 2.4
            pos = Vector((math.cos(a) * 0.45, math.sin(a) * 0.45, 0))
        out = math.atan2(pos.y, pos.x) if pos.length > 0 else 0.0
        lean = 0.0 if si == 0 else 0.12
        top = pos + Vector((math.cos(out) * lean * h, math.sin(out) * lean * h, h))
        st = 6 if hi else 2
        path = [pos.lerp(top, i / st) + UP * (-0.2 * (1 - i / st)) for i in range(st + 1)]
        r0 = 0.11 + 0.03 * h
        rib = (lambda t, a: 1.0 + 0.05 * math.sin(a * 5)) if hi else None
        ptube(mb, path, [r0 * (1 - 0.35 * i / st) for i in range(st + 1)], segments=8 if hi else 5, mat=0,
              col_fn=lambda t: (t * 0.4, 0.0, 0.0), radial_fn=rib)
        yaw0 = rnd.uniform(0, 6.28)
        for k in range(n_leaves):
            age = k / max(1, n_leaves - 1)
            yaw = yaw0 + k * GOLDEN * 1.1 + rnd.uniform(-0.2, 0.2)
            elev = math.radians(72 - 40 * age + rnd.uniform(-6, 6))
            phase = rnd.random()
            # Petiole climbs out of the pseudostem's crown before the blade arches over.
            pet_len = 0.25 + 0.25 * leaf_len / 2.1
            pb = top + Vector((math.cos(yaw) * r0 * 0.5, math.sin(yaw) * r0 * 0.5, -0.1 * age))
            pe = pb + dir_vec(yaw, elev + 0.25) * pet_len
            if hi:
                ptube(mb, [pb, pb.lerp(pe, 0.5), pe], [0.035, 0.03, 0.025], segments=4, mat=0,
                      col_fn=lambda t: (0.4 + 0.1 * t, 0.0, phase), cap_end=False)
            L = leaf_len * rnd.uniform(0.85, 1.1)
            banana_leaf(mb, pe, yaw, elev, L, 0.45 + 0.75 * age, rnd, phase, 1, hi, age)
        if si == 0:
            # Newest leaf still rolled into a cigar, standing straight up out of the crown.
            cig = [top + UP * (0.9 * i / 4) + Vector((0.03 * i, 0, 0)) for i in range(5)]
            ptube(mb, cig, [0.05, 0.05, 0.04, 0.025, 0.005], segments=6 if hi else 3, mat=1,
                  col_fn=lambda t: (t, 1.0, 0.3))
            if hi:
                # Hanging heliconia-like inflorescence: the one warm accent in the clump.
                ya = yaw0 + 1.0
                ped = gravity_spine(top, ya, 0.6, 0.9, 1.2, 6)
                ptube(mb, ped, [0.03] * len(ped), segments=4, mat=2, col_fn=lambda t: (t, 0.5, 0.6))
                for j in range(5):
                    p = ped[-1] - UP * (0.12 * j)
                    sphere(mb, p, 0.09 - 0.012 * j, u=6, v=4, mat=2, col=(1.0, 0.5, 0.6), scale=(1, 1, 1.6))
    mats = [material("stem", (0.2, 0.26, 0.14)), material("leaf_broad", (0.1, 0.22, 0.12), True),
            material("flower", (0.9, 0.3, 0.35))]
    return mb.build(name, mats, smooth=True)


# --- vines

VINE_HEIGHT = 12.0


def build_vines(name, seed, lod):
    """Lianas hanging from an anchor cluster at z = VINE_HEIGHT.
    Origin is on the ground directly below the anchors (base at z=0 like every other asset), so the
    game places it on the terrain under a canopy tree and scales it so the anchors meet the limbs."""
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    strands = []
    for k in range(10):
        a = rnd.uniform(0, 6.28)
        r = math.sqrt(rnd.random()) * 2.4
        anchor = Vector((math.cos(a) * r, math.sin(a) * r, VINE_HEIGHT + rnd.uniform(-0.4, 0.3)))
        L = min(rnd.uniform(5.5, 11.6), anchor.z - 0.25)
        strands.append(dict(kind="hang", anchor=anchor, L=L, r=rnd.uniform(0.028, 0.05), amp=rnd.uniform(0.15, 0.6),
                            ph=rnd.uniform(0, 6.28), dir=rnd.uniform(0, 6.28), leafy=rnd.random() < 0.8,
                            phase=rnd.random()))
    for k in range(2):
        a = rnd.uniform(0, 6.28)
        A = Vector((math.cos(a) * 2.0, math.sin(a) * 2.0, VINE_HEIGHT))
        b = a + rnd.uniform(2.0, 2.8)
        B = Vector((math.cos(b) * 2.0, math.sin(b) * 2.0, VINE_HEIGHT - rnd.uniform(0, 1.0)))
        strands.append(dict(kind="loop", A=A, B=B, sag=rnd.uniform(3.0, 5.5), r=rnd.uniform(0.06, 0.09),
                            phase=rnd.random(), leafy=k == 0))
    for sd in strands:
        if sd["kind"] == "hang":
            st = 12 if hi else 5
            d = dir_vec(sd["dir"], 0)
            path = []
            for i in range(st + 1):
                u = i / st
                lateral = sd["amp"] * math.sin(u * 4.0 + sd["ph"]) * u
                # Free end kicks out into a loose curl, like a tendril searching for a hold.
                curl = smoothstep(0.72, 1.0, u)
                p = sd["anchor"] + d * (lateral + 0.35 * curl) - UP * (sd["L"] * u - 0.25 * curl)
                path.append(p)
        else:
            st = 18 if hi else 6
            path = [sd["A"].lerp(sd["B"], i / st) - UP * (sd["sag"] * 4 * (i / st) * (1 - i / st)) for i in range(st + 1)]
        phase = sd["phase"]
        if hi:
            ptube(mb, path, [sd["r"] * (1 - 0.5 * i / st) if sd["kind"] == "hang" else sd["r"] for i in range(st + 1)],
                  segments=3 if sd["kind"] == "hang" else 4, mat=0, col_fn=lambda t: (t, 0.0, phase))
            if not sd["leafy"]:
                continue
            # Leaves follow a 137 degree spiral; they thin out toward the free end.
            n = len(path)
            arc = sum((path[i + 1] - path[i]).length for i in range(n - 1))
            count = int(arc / 0.2)
            ang = rnd.uniform(0, 6.28)
            for j in range(count):
                u = (j + rnd.uniform(0, 0.6)) / count
                if sd["kind"] == "hang" and rnd.random() < u * 0.7:
                    continue
                f = u * (n - 1)
                i = min(int(f), n - 2)
                p = path[i].lerp(path[i + 1], f - i)
                ang += math.radians(137.5)
                out = Vector((math.cos(ang), math.sin(ang), 0))
                side = Vector((-out.y, out.x, 0))
                size = rnd.uniform(0.3, 0.48) * (1.2 - 0.5 * u)
                tipd = (out * 0.8 - UP * rnd.uniform(0.4, 1.0)).normalized()
                nrm = tipd.cross(side).normalized()
                c = (u, 1.0, phase)
                base = p + out * 0.03
                mid = base + tipd * size * 0.45 + nrm * size * 0.08
                vs = [mb.v(base, c), mb.v(mid + side * size * 0.32, c), mb.v(base + tipd * size, c),
                      mb.v(mid - side * size * 0.32, c)]
                mb.f((vs[0], vs[3], vs[2], vs[1]), 1)
        else:
            # Two crossed leafy ribbons stand in for strand + leaves at distance.
            w = 0.12 if sd["leafy"] else 0.04
            for rot in (0.0, math.pi / 2):
                sv = dir_vec(rnd.uniform(0, 6.28) + rot, 0)
                rows = [[mb.v(p - sv * w * (1 - 0.5 * i / st), (i / st, 1.0, phase)),
                         mb.v(p + sv * w * (1 - 0.5 * i / st), (i / st, 1.0, phase))] for i, p in enumerate(path)]
                loft(mb, rows, 1)
    return mb.build(name, [material("vine", (0.14, 0.12, 0.09)), material("foliage", (0.08, 0.16, 0.1), True)],
                    smooth=hi)


# --- ground cover

COLOCASIA = [(0.0, 1.0), (0.45, 0.8), (0.95, 0.52), (1.5, 0.44), (2.1, 0.46), (2.55, 0.46), (2.85, 0.3), (math.pi, 0.07)]


def leaf_outline(theta):
    a = abs(theta)
    for (a0, r0), (a1, r1) in zip(COLOCASIA, COLOCASIA[1:]):
        if a <= a1:
            return r0 + (r1 - r0) * smoothstep(a0, a1, a)
    return COLOCASIA[-1][1]


def build_groundcover(name, seed, lod):
    """Elephant-ear clump: heart-shaped blades on arching stalks, tips hanging toward the ground."""
    rnd = random.Random(seed)
    mb = MeshBuilder()
    hi = lod == "hi"
    yaw0 = rnd.uniform(0, 6.28)
    for k in range(9):
        age = rnd.random()
        yaw = yaw0 + k * GOLDEN + rnd.uniform(-0.2, 0.2)
        Ls = rnd.uniform(0.35, 0.6) * (1.1 - 0.3 * age)
        phase = rnd.random()
        stalk = bend_spine(Vector((math.cos(yaw) * 0.03, math.sin(yaw) * 0.03, 0)), yaw, math.radians(80),
                           math.radians(30 - 20 * age), Ls, 5 if hi else 2, power=1.2)
        ptube(mb, stalk, [0.016 - 0.007 * i / (len(stalk) - 1) for i in range(len(stalk))], segments=4 if hi else 3,
              mat=0, col_fn=lambda t: (t * 0.5, 0.0, phase), cap_end=False)
        L = rnd.uniform(0.26, 0.4)
        pitch = math.radians(-4 - 22 * age + rnd.uniform(-6, 6))
        d = dir_vec(yaw, pitch)
        side = horiz_side(yaw)
        nrm = d.cross(side).normalized()
        attach = stalk[-1]
        rim = 16 if hi else 7
        fold = 0.22
        droop = 0.12 + 0.2 * age

        def local(x, y):
            z = -droop * max(x, 0.0) ** 2 / L - fold * abs(y) + 0.15 * max(-x, 0.0)
            return attach + d * x + side * y + nrm * z

        c = mb.v(attach, (0.5, 1.0, phase))
        thetas = [-math.pi + 2 * math.pi * j / rim for j in range(rim)]
        outer = []
        for th in thetas:
            r = L * leaf_outline(th)
            outer.append(mb.v(local(r * math.cos(th) + 0.05 * L, r * math.sin(th)), (1.0, 1.0, phase)))
        if hi:
            inner = []
            for th in thetas:
                r = L * leaf_outline(th) * 0.5
                inner.append(mb.v(local(r * math.cos(th) + 0.05 * L, r * math.sin(th)), (0.75, 1.0, phase)))
            for j in range(rim):
                j2 = (j + 1) % rim
                mb.f((c, inner[j], inner[j2]), 1)
                mb.f((inner[j], outer[j], outer[j2], inner[j2]), 1)
        else:
            for j in range(rim):
                mb.f((c, outer[j], outer[(j + 1) % rim]), 1)
    return mb.build(name, [material("stem", (0.2, 0.26, 0.14)), material("leaf_broad", (0.1, 0.22, 0.12), True)],
                    smooth=hi)


CANOPIES = [
    # name, seed, height, crown radius, limbs, buttress fins
    ("CanopyA", 61, 22.0, 8.5, 5, 5),
    ("CanopyB", 64, 16.0, 6.8, 4, 4),
]


PALMS = [
    # name, height, lean, seed, fronds, frond length
    ("PalmTall", 19.0, 0.06, 11, 24, 4.8),
    ("PalmMid", 15.0, 0.12, 12, 22, 4.6),
    ("PalmLean", 11.0, 0.42, 13, 21, 4.4),
    ("PalmYoung", 7.0, 0.20, 14, 18, 3.8),
]


def export_flora():
    reset()
    for name, h, lean, seed, fronds, flen in PALMS:
        build_palm(f"{name}_hi", h, lean, seed, fronds, flen, "hi")
        build_palm(f"{name}_lo", h, lean, seed, fronds, flen, "lo")
    for i, r in enumerate((1.3, 2.1)):
        build_bush(f"Bush{i}_hi", r, 40 + i, "hi")
        build_bush(f"Bush{i}_lo", r, 40 + i, "lo")
    for name, seed, h, cr, limbs, fins in CANOPIES:
        plan = plan_canopy(seed, h, cr, limbs, fins)
        for lod in ("hi", "lo"):
            build_tree(f"{name}_{lod}", plan, seed + 500, lod)
    plan = plan_understory(71, 6.8, 2.6)
    for lod in ("hi", "lo"):
        build_tree(f"Understory_{lod}", plan, 571, lod)
        build_fern(f"FernA_{lod}", 81, 1.45, 13, 0.0, lod)
        build_fern(f"FernB_{lod}", 82, 1.1, 9, 1.0, lod)
        build_tree_fern(f"TreeFern_{lod}", 85, 3.8, lod)
        build_banana(f"Banana_{lod}", 90, lod)
        build_vines(f"Vines_{lod}", 95, lod)
        build_groundcover(f"Groundcover_{lod}", 100, lod)
    export("flora")


# ---------------------------------------------------------------- boat

LENGTH, BEAM, DEPTH = 3.7, 1.32, 0.52
STRAKES = 6


def hull_point(u, v, lap=True):
    """u: 0 stern -> 1 bow. v: -1 port sheer .. 0 keel .. 1 starboard sheer."""
    x = (u - 0.5) * LENGTH
    half_b = BEAM * 0.5 * math.sin(math.pi * (0.1 + 0.9 * u)) ** 0.55
    z_keel = -DEPTH * (1.0 - 0.8 * smoothstep(0.7, 1.0, u) - 0.25 * smoothstep(0.25, 0.0, u))
    z_sheer = 0.06 + 0.2 * u ** 3 + 0.08 * (1 - u) ** 2
    a = abs(v) * math.pi / 2
    y = math.copysign(half_b * math.sin(a) ** 0.75, v)
    z = z_keel + (z_sheer - z_keel) * (1 - math.cos(a)) ** 0.9
    if lap:
        # Clinker laps: each strake steps outward over the one below it.
        k = abs(v) * STRAKES
        frac = k - math.floor(k)
        out = 0.014 * smoothstep(0.0, 0.85, frac)
        n = Vector((0, y, z - z_keel * 0.4)).normalized()
        y += n.y * out
        z += n.z * out
    return Vector((x, y, z))


def build_boat():
    reset()
    wood = material("hull", (0.42, 0.22, 0.12), True)
    paint = material("hull_paint", (0.82, 0.78, 0.68), True)
    trim = material("trim", (0.3, 0.17, 0.1))
    brass = material("brass", (0.75, 0.55, 0.25))
    glass = material("lantern_glow", (1.0, 0.7, 0.35), emission=(1.0, 0.55, 0.2))

    mb = MeshBuilder()
    NU, NV = 48, 72
    grid = []
    for i in range(NU + 1):
        u = i / NU
        row = []
        for j in range(NV + 1):
            v = -1 + 2 * j / NV
            # Lower strakes painted cream like the boats in the reference, upper planks bare wood.
            row.append(mb.v(hull_point(u, v), (abs(v), 0.0, 0.0)))
        grid.append(row)
    for i in range(NU):
        for j in range(NV):
            v = -1 + 2 * (j + 0.5) / NV
            mat = 1 if abs(v) < 0.55 else 0
            mb.f((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]), mat)
    transom = [grid[0][j] for j in range(NV + 1)]
    mb.f(transom, 0)
    hull = mb.build("Boat", [wood, paint], modifiers=[("SOLIDIFY", {"thickness": 0.022, "offset": -1})])

    det = MeshBuilder()
    # Gunwale rails and stem post.
    for s in (-1, 1):
        rail = [hull_point(i / 30, s * 1.0, lap=False) + Vector((0, 0, 0.012)) for i in range(31)]
        tube(det, rail, [0.028] * 31, segments=6, mat=0)
    stem = [hull_point(0.96 + 0.04 * t, 0, lap=False) * (1 - t) + hull_point(1.0, 1.0, lap=False) * t + Vector((0.03, 0, 0.04 * t)) for t in (0, 0.33, 0.66, 1.0)]
    tube(det, stem, [0.035, 0.035, 0.035, 0.03], segments=6, mat=0)
    # Ribs.
    for u in [0.12 + 0.76 * k / 8 for k in range(9)]:
        rib = [hull_point(u, -1 + 2 * j / 16, lap=False) * 0.97 + Vector((0, 0, 0.01)) for j in range(17)]
        tube(det, rib, [0.014] * 17, segments=4, mat=0, cap_start=False, cap_end=False)
    # Thwarts (seats) and floor boards.
    for u, h in ((0.2, 0.18), (0.48, 0.2), (0.78, 0.16)):
        x = (u - 0.5) * LENGTH
        w = hull_point(u, 1.0, lap=False).y * 0.94
        z = -DEPTH + h + 0.18
        box(det, (x - 0.13, -w, z), (x + 0.13, w, z), 0.035, mat=0)
    for k in range(-2, 3):
        y = k * 0.11
        box(det, (-1.2, y - 0.045, -DEPTH + 0.05), (1.05, y + 0.045, -DEPTH + 0.05), 0.018, mat=0)
    # Oarlocks.
    for s in (-1, 1):
        p = hull_point(0.56, s * 1.0, lap=False) + Vector((0, 0, 0.04))
        tube(det, [p + Vector((math.cos(a) * 0.04, 0, math.sin(a) * 0.04 + 0.03)) for a in [math.pi * k / 6 for k in range(7)]],
             [0.008] * 7, segments=4, mat=1)
    # Coiled painter rope at the bow.
    coil = []
    for k in range(60):
        a = k / 60 * math.pi * 2 * 3
        r = 0.09 + 0.015 * (k / 60)
        coil.append((1.15 + math.cos(a) * r, math.sin(a) * r, -DEPTH + 0.2 + 0.012 * (k / 20)))
    tube(det, coil, [0.012] * 60, segments=4, mat=0)
    det.build("BoatDetail", [trim, brass], parent=hull)

    # The keeper's lantern on a short post at the stern: the warm light the boat carries.
    lan = MeshBuilder()
    tube(lan, [(0, 0, 0), (0, 0, 0.55)], [0.018, 0.018], segments=6, mat=0)
    tube(lan, [(0, 0, 0.42), (0.12, 0, 0.42), (0.12, 0, 0.36)], [0.01] * 3, segments=4, mat=0)
    tube(lan, [(0.12, 0, 0.36), (0.12, 0, 0.22)], [0.045, 0.045], segments=8, mat=1)
    tube(lan, [(0.12, 0, 0.215), (0.12, 0, 0.2)], [0.055, 0.055], segments=8, mat=0)
    tube(lan, [(0.12, 0, 0.36), (0.12, 0, 0.39)], [0.052, 0.02], segments=8, mat=0)
    lan.build("Lantern", [brass, glass], parent=hull, location=(-LENGTH * 0.45, 0, 0.05))

    for s, name in ((1, "OarL"), (-1, "OarR")):
        oar = MeshBuilder()
        # Loom runs inboard (handle) to outboard (blade); origin sits at the oarlock pin.
        tube(oar, [(0, -s * 0.75, 0), (0, -s * 0.55, 0), (0, s * 0.3, 0), (0, s * 1.6, 0)],
             [0.022, 0.03, 0.034, 0.026], segments=6, mat=0)
        blade = []
        for k in range(9):
            t = k / 8
            w = 0.03 + 0.07 * math.sin(math.pi * min(1, 0.2 + t * 0.85)) ** 0.5
            blade.append((t, w))
        rows = []
        for t, w in blade:
            y = s * (1.55 + 0.75 * t)
            rows.append((oar.v((-w, y, 0.004 * (1 - t))), oar.v((w, y, -0.004 * (1 - t)))))
        for ra, rb in zip(rows, rows[1:]):
            if s > 0:
                oar.f((ra[0], ra[1], rb[1], rb[0]), 0)
            else:
                oar.f((ra[0], rb[0], rb[1], ra[1]), 0)
        p = hull_point(0.56, s * 1.0, lap=False)
        oar.build(name, [material("oar", (0.5, 0.33, 0.2), True)], parent=hull, location=(p.x, p.y, p.z + 0.07))
    export("boat")


def box(mb, a, c, thickness, mat=0):
    x0, y0, z0 = a
    x1, y1, _ = c
    z1 = z0 + thickness
    vs = [mb.v(p) for p in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
    for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        mb.f([vs[i] for i in f], mat)


# ---------------------------------------------------------------- the Keeper

# Bone layout (Blender: character faces -Y, +X is the character's left, Z up, feet at z=0).
BONES = {
    "hips": ((0, 0, 0.93), (0, 0, 1.08), None),
    "spine": ((0, 0, 1.08), (0, 0, 1.26), "hips"),
    "chest": ((0, 0, 1.26), (0, 0, 1.42), "spine"),
    "neck": ((0, 0, 1.42), (0, 0, 1.5), "chest"),
    "head": ((0, 0, 1.5), (0, 0, 1.72), "neck"),
}
for side, sx in (("L", 1), ("R", -1)):
    BONES.update({
        f"shoulder.{side}": ((sx * 0.03, 0, 1.40), (sx * 0.17, 0, 1.40), "chest"),
        f"upperarm.{side}": ((sx * 0.19, 0, 1.39), (sx * 0.23, 0.01, 1.12), f"shoulder.{side}"),
        f"forearm.{side}": ((sx * 0.23, 0.01, 1.12), (sx * 0.25, -0.03, 0.88), f"upperarm.{side}"),
        f"hand.{side}": ((sx * 0.25, -0.03, 0.88), (sx * 0.255, -0.05, 0.79), f"forearm.{side}"),
        f"thigh.{side}": ((sx * 0.095, 0, 0.93), (sx * 0.105, -0.01, 0.5), "hips"),
        f"shin.{side}": ((sx * 0.105, -0.01, 0.5), (sx * 0.11, 0.02, 0.09), f"thigh.{side}"),
        f"foot.{side}": ((sx * 0.11, 0.02, 0.09), (sx * 0.11, -0.15, 0.03), f"shin.{side}"),
    })


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length


def build_keeper():
    reset()
    coat_m = material("coat", (0.04, 0.05, 0.1))
    trousers_m = material("trousers", (0.09, 0.08, 0.09))
    boots_m = material("boots", (0.03, 0.025, 0.025))
    skin_m = material("skin", (0.62, 0.44, 0.38))
    beanie_m = material("beanie", (0.85, 0.36, 0.25))

    # --- body via skin modifier over a vertex skeleton, then subdivided.
    nodes = {
        "pelvis": ((0, 0, 0.94), (0.15, 0.11)), "waist": ((0, 0, 1.08), (0.145, 0.1)),
        "chest": ((0, 0, 1.28), (0.18, 0.12)), "neck0": ((0, 0, 1.43), (0.06, 0.06)),
        "neck1": ((0, 0, 1.49), (0.052, 0.052)), "head0": ((0, -0.005, 1.585), (0.095, 0.105)),
        "head1": ((0, -0.005, 1.665), (0.085, 0.09)),
    }
    edges = [("pelvis", "waist"), ("waist", "chest"), ("chest", "neck0"), ("neck0", "neck1"),
             ("neck1", "head0"), ("head0", "head1")]
    for side, sx in (("L", 1), ("R", -1)):
        nodes.update({
            f"sh{side}": ((sx * 0.17, 0, 1.39), (0.08, 0.075)), f"el{side}": ((sx * 0.23, 0.01, 1.12), (0.062, 0.062)),
            f"wr{side}": ((sx * 0.25, -0.03, 0.88), (0.048, 0.048)), f"ha{side}": ((sx * 0.255, -0.05, 0.8), (0.045, 0.03)),
            f"hp{side}": ((sx * 0.095, 0, 0.9), (0.085, 0.085)), f"kn{side}": ((sx * 0.105, -0.01, 0.5), (0.062, 0.062)),
            f"an{side}": ((sx * 0.11, 0.02, 0.1), (0.05, 0.05)), f"to{side}": ((sx * 0.11, -0.15, 0.04), (0.05, 0.035)),
        })
        edges += [("chest", f"sh{side}"), (f"sh{side}", f"el{side}"), (f"el{side}", f"wr{side}"), (f"wr{side}", f"ha{side}"),
                  ("pelvis", f"hp{side}"), (f"hp{side}", f"kn{side}"), (f"kn{side}", f"an{side}"), (f"an{side}", f"to{side}")]
    keys = list(nodes)
    mesh = bpy.data.meshes.new("KeeperSkin")
    mesh.from_pydata([nodes[k][0] for k in keys], [(keys.index(a), keys.index(b)) for a, b in edges], [])
    body = bpy.data.objects.new("KeeperBody", mesh)
    bpy.context.scene.collection.objects.link(body)
    skin = body.modifiers.new("skin", "SKIN")
    skin.branch_smoothing = 0.6
    for i, k in enumerate(keys):
        mesh.skin_vertices[0].data[i].radius = nodes[k][1]
    mesh.skin_vertices[0].data[0].use_root = True
    sub = body.modifiers.new("sub", "SUBSURF")
    sub.levels = 2
    deps = bpy.context.evaluated_depsgraph_get()
    body_mesh = bpy.data.meshes.new_from_object(body.evaluated_get(deps))
    bpy.data.objects.remove(body)

    mb = MeshBuilder()
    for v in body_mesh.vertices:
        mb.v(v.co)
    for p in body_mesh.polygons:
        c = sum((body_mesh.vertices[i].co for i in p.vertices), Vector()) / len(p.vertices)
        if c.z > 1.49:
            mat = 3  # skin (head)
        elif c.z < 0.16:
            mat = 2  # boots
        elif c.z < 0.62 or (c.z < 0.95 and abs(c.x) > 0.02 and c.z < 0.9):
            mat = 1  # trousers
        else:
            mat = 0  # coat
        # Hands are skin too.
        if c.z < 0.9 and abs(c.x) > 0.2:
            mat = 3
        mb.f(list(p.vertices), mat)
    bpy.data.meshes.remove(body_mesh)

    # --- peacoat skirt: flared open cone from waist to mid thigh.
    skirt_start = len(mb.verts)
    skirt_rows = []
    for j in range(7):
        t = j / 6
        z = 1.1 - 0.3 * t
        # Starts flush with the waist and flares, so the hem reads as cloth rather than a tube.
        rx = 0.15 + 0.075 * t ** 1.3
        ry = 0.108 + 0.05 * t ** 1.3
        ring = []
        for i in range(20):
            a = 2 * math.pi * i / 20
            hem = 0.012 * math.sin(a * 3 + 1.0) * t
            ring.append(mb.v((math.cos(a) * rx, math.sin(a) * ry, z + hem)))
        skirt_rows.append(ring)
    for ra, rb in zip(skirt_rows, skirt_rows[1:]):
        for i in range(20):
            mb.f((ra[i], ra[(i + 1) % 20], rb[(i + 1) % 20], rb[i]), 0)
    skirt_end = len(mb.verts)
    # Turned-up collar.
    col_rows = []
    for j, (z, r) in enumerate(((1.395, 0.1), (1.46, 0.088))):
        col_rows.append([mb.v((math.cos(2 * math.pi * i / 16) * r, math.sin(2 * math.pi * i / 16) * r * 0.9, z)) for i in range(16)])
    for i in range(16):
        mb.f((col_rows[0][i], col_rows[0][(i + 1) % 16], col_rows[1][(i + 1) % 16], col_rows[1][i]), 0)
    # Beanie: domed cap with a rolled brim, the one warm accent so the tiny figure reads at distance.
    sphere(mb, (0, -0.005, 1.645), 0.104, u=14, v=8, mat=4, scale=(1, 1.05, 0.95))
    tube(mb, [(math.cos(a) * 0.106, math.sin(a) * 0.112 - 0.005, 1.61) for a in [2 * math.pi * k / 16 for k in range(17)]],
         [0.022] * 17, segments=6, mat=4, cap_start=False, cap_end=False)

    obj = mb.build("Keeper", [coat_m, trousers_m, boots_m, skin_m, beanie_m], smooth=True)

    # --- armature.
    arm_data = bpy.data.armatures.new("KeeperRig")
    rig = bpy.data.objects.new("KeeperRig", arm_data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (head, tail, parent) in BONES.items():
        eb = arm_data.edit_bones.new(name)
        eb.head, eb.tail = head, tail
        eb.roll = 0
    for name, (_, _, parent) in BONES.items():
        if parent:
            arm_data.edit_bones[name].parent = arm_data.edit_bones[parent]
            arm_data.edit_bones[name].use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")

    # Weights from distance to bone segments: smooth, deterministic, no bone-heat failures.
    segs = {n: (Vector(h), Vector(t)) for n, (h, t, _) in BONES.items()}
    groups = {n: obj.vertex_groups.new(name=n) for n in BONES}
    for v in obj.data.vertices:
        p = v.co
        cands = list(segs)
        if p.z > 1.56:
            cands = ["head"]
        elif skirt_start <= v.index < skirt_end:
            # Back of the hem follows the pelvis only (thigh pull tears it open when walking);
            # the front takes some thigh so the coat lifts over the lap when seated.
            side = "L" if p.x > 0 else "R"
            front = max(0.0, -p.y / 0.15) * smoothstep(1.05, 0.8, p.z)
            tw = 0.45 * front
            groups["hips"].add([v.index], 1.0 - tw, "REPLACE")
            if tw > 0.01:
                groups[f"thigh.{side}"].add([v.index], tw, "REPLACE")
            continue
        dists = sorted((seg_dist(p, *segs[n]) + 1e-4, n) for n in cands)[:3]
        ws = [(1.0 / d ** 5, n) for d, n in dists]
        total = sum(w for w, _ in ws)
        for w, n in ws:
            if w / total > 0.02:
                groups[n].add([v.index], w / total, "REPLACE")
    obj.parent = rig
    mod = obj.modifiers.new("rig", "ARMATURE")
    mod.object = rig

    bake_keeper_actions(rig)
    export("keeper", animations=True)


def bake_keeper_actions(rig):
    rig.animation_data_create()
    for pb in rig.pose.bones:
        pb.rotation_mode = "XYZ"

    def clear():
        for pb in rig.pose.bones:
            pb.rotation_euler = (0, 0, 0)
            pb.location = (0, 0, 0)

    def key(frame, pose, hips_z=0.0, hips_y=0.0):
        clear()
        for bone, (x, y, z) in pose.items():
            rig.pose.bones[bone].rotation_euler = (math.radians(x), math.radians(y), math.radians(z))
        # Bone-local Y points up the hip bone, so world Z offset is local Y.
        rig.pose.bones["hips"].location = (0, hips_z, hips_y)
        for pb in rig.pose.bones:
            pb.keyframe_insert("rotation_euler", frame=frame)
            pb.keyframe_insert("location", frame=frame)

    def action(name, frames):
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data.action = act
        for frame, pose, hz, hy in frames:
            key(frame, pose, hz, hy)
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 1, act)
        rig.animation_data.action = None

    # Positive X rotation on a downward-pointing limb swings it backward (toward +Y).
    def walk_pose(phase):
        s = math.sin(phase)
        return {
            "thigh.L": (-28 * s, 0, 0), "thigh.R": (28 * s, 0, 0),
            "shin.L": (35 * max(0.0, math.sin(phase + 1.3)), 0, 0),
            "shin.R": (35 * max(0.0, math.sin(phase + 1.3 + math.pi)), 0, 0),
            "foot.L": (-10 * s, 0, 0), "foot.R": (10 * s, 0, 0),
            "upperarm.L": (20 * s, 0, 4), "upperarm.R": (-20 * s, 0, -4),
            "forearm.L": (-15 - 8 * max(0, -s), 0, 0), "forearm.R": (-15 - 8 * max(0, s), 0, 0),
            "spine": (-4, 3 * s, 0), "chest": (0, -4 * s, 0), "head": (2, 0, 0),
        }

    walk = []
    for k in range(9):
        ph = 2 * math.pi * k / 8
        walk.append((1 + k * 4, walk_pose(ph), -0.025 * abs(math.cos(ph)), 0.0))
    action("walk", walk)

    idle = []
    for k in range(5):
        ph = 2 * math.pi * k / 4
        b = math.sin(ph)
        idle.append((1 + k * 20, {"chest": (-2 * b, 0, 0), "head": (3 + 2 * b, 2 * math.sin(ph * 0.5), 0),
                                  "upperarm.L": (0, 0, 3), "upperarm.R": (0, 0, -3),
                                  "forearm.L": (-8, 0, 0), "forearm.R": (-8, 0, 0)}, 0.004 * b, 0.0))
    action("idle", idle)

    def seated(extra):
        base = {"thigh.L": (-85, 0, 4), "thigh.R": (-85, 0, -4), "shin.L": (80, 0, 0), "shin.R": (80, 0, 0),
                "foot.L": (-5, 0, 0), "foot.R": (-5, 0, 0)}
        base.update(extra)
        return base

    row = []
    for k in range(13):
        ph = 2 * math.pi * k / 12
        # Catch (arms forward, torso leaning in) -> drive (lean back, elbows pulled in).
        drive = 0.5 - 0.5 * math.cos(ph)
        lean = -22 + 40 * drive
        row.append((1 + k * 4, seated({
            "spine": (lean * 0.6, 0, 0), "chest": (lean * 0.4, 0, 0), "head": (-lean * 0.5, 0, 0),
            "upperarm.L": (-70 + 50 * drive, 0, 18), "upperarm.R": (-70 + 50 * drive, 0, -18),
            "forearm.L": (-10 - 75 * drive, 0, 0), "forearm.R": (-10 - 75 * drive, 0, 0),
        }), -0.42, 0.0))
    action("row", row)

    action("sit", [(1, seated({"spine": (-6, 0, 0), "upperarm.L": (-25, 0, 10), "upperarm.R": (-25, 0, -10),
                               "forearm.L": (-50, 0, 0), "forearm.R": (-50, 0, 0), "head": (8, 0, 0)}), -0.42, 0.0),
                   (60, seated({"spine": (-4, 0, 0), "upperarm.L": (-25, 0, 10), "upperarm.R": (-25, 0, -10),
                                "forearm.L": (-50, 0, 0), "forearm.R": (-50, 0, 0), "head": (4, 0, 0)}), -0.42, 0.0)])


# ---------------------------------------------------------------- export

def export(name, animations=False):
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(FBX_OUT, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, f"{name}.glb"),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_vertex_color="ACTIVE",
        export_animations=animations,
        export_animation_mode="NLA_TRACKS",
        export_skins=True,
    )
    bpy.ops.export_scene.fbx(
        filepath=os.path.join(FBX_OUT, f"{name}.fbx"),
        apply_scale_options="FBX_SCALE_ALL",
        object_types={"MESH", "EMPTY", "ARMATURE"},
        bake_anim=animations,
        bake_anim_use_nla_strips=animations,
        bake_anim_use_all_actions=False,
    )
    print(f"[lapis] exported {name}")


for asset, fn in (("flora", export_flora), ("boat", build_boat), ("keeper", build_keeper)):
    if not ONLY or asset in ONLY:
        fn()
