"""Procedurally builds Lapis props and exports glTF (web) + FBX (s&box).

Run headless:  blender -b --factory-startup --python tools/blender/build_assets.py -- <out_dir> [asset ...]
Materials are placeholders keyed by name; the game swaps them for stylised node materials.

Vertex colour convention (COLOR_0), read by the game's shaders:
  R  gradient along the part, 0 at its root -> 1 at its tip (glow ramp, sway weight)
  G  part id: 0 trunk / hull, 1 frond / foliage, 0.5 fruit / detail
  B  per-part random, for desynchronising wind sway

creatures.glb uses its own encoding (animated in the vertex shader):
  R  position along the body, head / root 0 -> tail / tip 1
  G  1 on wings, fins and tentacles (the parts that flap or trail), 0 on the body
  B  per-part random
"""
import bisect
import math
import os
import random
import sys

import bpy
from mathutils import Matrix, Vector

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
    # This frame (normal, tangent x normal) has the opposite handedness to tube()'s, so the
    # winding is mirrored to keep faces pointing outward.
    for ra, rb in zip(rings, rings[1:]):
        for s in range(segments):
            s2 = (s + 1) % segments
            mb.f((ra[s], ra[s2], rb[s2], rb[s]), mat)
    if cap_start:
        mb.f(list(reversed(rings[0])), mat)
    if cap_end:
        mb.f(rings[-1], mat)
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


# ---------------------------------------------------------------- landmark / creature helpers

def xform(mb, start, fn):
    """Applies fn(Vector) -> Vector to every vertex added since index start (rotating a door, tilting a wreck)."""
    for i in range(start, len(mb.verts)):
        mb.verts[i] = tuple(fn(Vector(mb.verts[i])))


def ramp_r(mb, start, z0, z1, skip_g=(0.5, 1.0)):
    """Rewrites R as height through the object for solid parts; glow and cloth keep their own gradients."""
    for i in range(start, len(mb.verts)):
        r, g, b, a = mb.cols[i]
        if g in skip_g:
            continue
        mb.cols[i] = (max(0.0, min(1.0, (mb.verts[i][2] - z0) / (z1 - z0))), g, b, a)


def rings_loft(mb, rings, mat=0, cap_start=True, cap_end=True):
    """Skins rings of vertex ids (a 1-id ring is a pole). Ring handedness is measured from the geometry and
    flipped if needed, so sections can be built in any convenient frame and still face outward."""
    P = lambda i: Vector(mb.verts[i])
    cent = [sum((P(i) for i in r), Vector()) / len(r) for r in rings]
    k = max(range(len(rings) - 1), key=lambda j: (cent[j + 1] - cent[j]).length)
    j = k if len(rings[k]) > 2 else k + 1
    area = Vector()
    for s in range(len(rings[j])):
        area += (P(rings[j][s]) - cent[j]).cross(P(rings[j][(s + 1) % len(rings[j])]) - cent[j])
    if area.dot(cent[k + 1] - cent[k]) > 0:
        rings = [list(reversed(r)) for r in rings]
    for ra, rb in zip(rings, rings[1:]):
        if len(ra) > 1 and len(rb) > 1:
            n = len(ra)
            for s in range(n):
                mb.f((ra[s], rb[s], rb[(s + 1) % n], ra[(s + 1) % n]), mat)
        elif len(ra) == 1:
            for s in range(len(rb)):
                mb.f((ra[0], rb[s], rb[(s + 1) % len(rb)]), mat)
        elif len(rb) == 1:
            for s in range(len(ra)):
                mb.f((ra[s], rb[0], ra[(s + 1) % len(ra)]), mat)
    if cap_start and len(rings[0]) > 2:
        mb.f(rings[0], mat)
    if cap_end and len(rings[-1]) > 2:
        mb.f(list(reversed(rings[-1])), mat)
    return rings


def limb(mb, path, radii, segments=6, mat=0, col_fn=None, cap_start=True, cap_end=True, radial_fn=None, jag=None,
         closed=False):
    """Rotation-minimising tube skinned through rings_loft. jag=(rnd, depth) splinters the end into a ragged
    ring closed by a pole, for snapped posts and broken ribs. closed=True loops the path (rails, rope wraps)."""
    path = [Vector(p) for p in path]
    n = len(path)
    if closed:
        tans = [(path[(i + 1) % n] - path[(i - 1) % n]).normalized() for i in range(n)]
    else:
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
        col = col_fn(t) if col_fn else (t, 0.0, 0.0)
        ring = []
        for s in range(segments):
            a = 2 * math.pi * s / segments
            r = radii[i] * (radial_fn(t, a) if radial_fn else 1.0)
            off = tans[i] * (jag[0].uniform(-0.35, 1.0) * jag[1]) if jag and i == n - 1 else Vector()
            ring.append(mb.v(path[i] + (nrm * math.cos(a) + bi * math.sin(a)) * r + off, col))
        rings.append(ring)
    if closed:
        rings.append(rings[0])
        cap_start = cap_end = False
    if jag:
        rings.append([mb.v(path[-1] + tans[-1] * jag[1] * 0.1, col_fn(1.0) if col_fn else (1.0, 0.0, 0.0))])
    return rings_loft(mb, rings, mat, cap_start, cap_end)


def lathe(mb, profile, sides, mat=0, col_fn=None, center=(0, 0, 0), rot=0.0, radial_fn=None, z_fn=None,
          mat_fn=None, cap_bottom=True, cap_top=True):
    """Surface of revolution about +Z. Profile [(r, z)] runs counter-clockwise in the r-z half plane (up the
    outside, in across the top); r=0 collapses to a pole. radial_fn / z_fn(t, angle) shape it per vertex."""
    c = Vector(center)
    n = len(profile)
    rings = []
    for i, (r, z) in enumerate(profile):
        t = i / max(1, n - 1)
        col = col_fn(t) if col_fn else (t, 0.0, 0.0)
        if r < 1e-6:
            rings.append([mb.v(c + Vector((0, 0, z)), col)])
            continue
        ring = []
        for s in range(sides):
            a = rot + 2 * math.pi * s / sides
            rr = r * (radial_fn(t, a) if radial_fn else 1.0)
            dz = z_fn(t, a) if z_fn else 0.0
            ring.append(mb.v(c + Vector((math.cos(a) * rr, math.sin(a) * rr, z + dz)), col))
        rings.append(ring)
    for i, (ra, rb) in enumerate(zip(rings, rings[1:])):
        m = mat_fn(i) if mat_fn else mat
        if len(ra) > 1 and len(rb) > 1:
            for s in range(sides):
                s2 = (s + 1) % sides
                mb.f((ra[s], ra[s2], rb[s2], rb[s]), m)
        elif len(ra) == 1 and len(rb) > 1:
            for s in range(sides):
                mb.f((ra[0], rb[(s + 1) % sides], rb[s]), m)
        elif len(rb) == 1 and len(ra) > 1:
            for s in range(sides):
                mb.f((ra[s], ra[(s + 1) % sides], rb[0]), m)
    if cap_bottom and len(rings[0]) > 1:
        mb.f(list(reversed(rings[0])), mat_fn(0) if mat_fn else mat)
    if cap_top and len(rings[-1]) > 1:
        mb.f(rings[-1], mat_fn(n - 2) if mat_fn else mat)
    return rings


def obox(mb, c, ax, ay, hx, hy, hz, mat=0, col=(0, 0, 0)):
    """Oriented box: centre, two axes (the third is ax x ay) and half extents."""
    ax = Vector(ax).normalized()
    ay = Vector(ay)
    ay = (ay - ax * ay.dot(ax)).normalized()
    az = ax.cross(ay)
    c = Vector(c)
    vs = [mb.v(c + ax * (sx * hx) + ay * (sy * hy) + az * (sz * hz), col)
          for sz in (-1, 1) for sy in (-1, 1) for sx in (-1, 1)]
    for f in ((0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)):
        mb.f([vs[i] for i in f], mat)
    return vs


def plank(mb, a, b, width, thick, up=(0, 0, 1), mat=0, col=(0, 0, 0)):
    """Board from a to b; thickness runs along `up` (projected off the length), width across both."""
    a, b, up = Vector(a), Vector(b), Vector(up)
    ax = (b - a).normalized()
    side = up.cross(ax)
    if side.length < 1e-6:
        side = Vector((0, 1, 0)).cross(ax)
    return obox(mb, (a + b) / 2, ax, side, (b - a).length / 2, width / 2, thick / 2, mat, col)


def extrude(mb, poly, origin, u, v, d, depth, mat=0, col=(0, 0, 0)):
    """Extrudes a convex polygon given in (u, v) plane coordinates along d by depth (gable walls, plinths)."""
    o, u, v, d = Vector(origin), Vector(u), Vector(v), Vector(d).normalized()
    m = len(poly)
    area = sum(poly[i][0] * poly[(i + 1) % m][1] - poly[(i + 1) % m][0] * poly[i][1] for i in range(m))
    if (area > 0) != (u.cross(v).dot(d) > 0):
        poly = list(reversed(poly))
    a = [mb.v(o + u * p[0] + v * p[1], col) for p in poly]
    b = [mb.v(o + u * p[0] + v * p[1] + d * depth, col) for p in poly]
    mb.f(list(reversed(a)), mat)
    mb.f(b, mat)
    for i in range(m):
        j = (i + 1) % m
        mb.f((a[i], a[j], b[j], b[i]), mat)


def lumps(rnd, amp, n=5):
    """Smooth deterministic noise on the unit sphere: a few random plane waves."""
    waves = []
    for k in range(n):
        d = Vector((rnd.gauss(0, 1), rnd.gauss(0, 1), rnd.gauss(0, 1))).normalized()
        f = rnd.uniform(1.2, 2.2) * (1 + 0.6 * k)
        waves.append((d * f, rnd.uniform(0, 6.28), amp / (1 + 0.6 * k)))
    return lambda p: 1.0 + sum(a * math.sin(w.dot(p) + ph) for w, ph, a in waves)


def blob(mb, center, size, rnd, u=12, v=8, mat=0, col=(0, 0, 0), rough=0.1, flat=0.0, rot=None):
    """Noisy ellipsoid for stones and boulders. flat squashes the underside so stones sit rather than balance."""
    c = Vector(center)
    noise = lumps(rnd, rough)
    rings = []
    for j in range(v + 1):
        phi = math.pi * j / v
        z = math.cos(phi)
        pts = [(0.0, 0.0)] if j in (0, v) else [(math.sin(phi) * math.cos(2 * math.pi * i / u),
                                                   math.sin(phi) * math.sin(2 * math.pi * i / u)) for i in range(u)]
        ring = []
        for x, y in pts:
            k = noise(Vector((x, y, z)))
            p = Vector((x * size[0] * k, y * size[1] * k, z * size[2] * k * ((1 - flat) if z < 0 else 1.0)))
            if rot:
                p = rot @ p
            ring.append(mb.v(c + p, col))
        rings.append(ring)
    rings_loft(mb, rings, mat, False, False)


def catmull(ctrl, u):
    """Catmull-Rom through rows (u, a, b, ...): smooth body profiles from a short table."""
    us = [p[0] for p in ctrl]
    i = max(0, min(len(ctrl) - 2, bisect.bisect_right(us, u) - 1))
    t = max(0.0, min(1.0, (u - us[i]) / (us[i + 1] - us[i])))
    p0, p1, p2, p3 = ctrl[max(i - 1, 0)], ctrl[i], ctrl[i + 1], ctrl[min(i + 2, len(ctrl) - 1)]
    return [0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t ** 3)
            for a, b, c, d in zip(p0[1:], p1[1:], p2[1:], p3[1:])]


def blade_loft(mb, stations, mat=0, cap_start=False, cap_end=True):
    """Thin closed blade (wing, fin, fluke) from stations (lead, trail, normal, half_thickness, col).
    Diamond section with its thickest point 30% back from the leading edge. col is a tuple or col(point)."""
    rings = []
    for lead, trail, nrm, th, col in stations:
        lead, trail, nrm = Vector(lead), Vector(trail), Vector(nrm).normalized()
        cf = col if callable(col) else (lambda p, c=col: c)
        if (lead - trail).length < 1e-5:
            rings.append([mb.v(lead, cf(lead))])
            continue
        mid = lead.lerp(trail, 0.3)
        pts = [lead, mid + nrm * th, trail, mid - nrm * th]
        rings.append([mb.v(p, cf(p)) for p in pts])
    return rings_loft(mb, rings, mat, cap_start, cap_end)


# ---------------------------------------------------------------- landmarks

PROP_MATS = {
    "wood": lambda: material("wood", (0.34, 0.27, 0.21)),
    "thatch": lambda: material("thatch", (0.52, 0.42, 0.28), True),
    "lamp_glow": lambda: material("lamp_glow", (1.0, 0.72, 0.38), emission=(1.0, 0.6, 0.25)),
    "candle_glow": lambda: material("candle_glow", (1.0, 0.84, 0.55), emission=(1.0, 0.7, 0.35)),
    "stone": lambda: material("stone", (0.45, 0.45, 0.48)),
    "lighthouse_white": lambda: material("lighthouse_white", (0.9, 0.88, 0.82)),
    "lighthouse_band": lambda: material("lighthouse_band", (0.58, 0.1, 0.08)),
    "lamp_glass": lambda: material("lamp_glass", (0.24, 0.3, 0.34)),
    "rope": lambda: material("rope", (0.62, 0.52, 0.36)),
    "sail": lambda: material("sail", (0.88, 0.82, 0.7), True),
}


def prop_mats(*names):
    return [PROP_MATS[n]() for n in names]


JETTY_LEN, JETTY_DECK = 18.0, 1.2


def build_jetty():
    """Landward end at the origin, running out along +X for 18 m; deck top ~1.2 m, piles down to z=-2.5,
    with a few snapped piles carrying on past the end where the pier used to be longer."""
    rnd = random.Random(201)
    mb = MeshBuilder()
    L = JETTY_LEN

    def top(x):
        # Sags mid-length and droops at the seaward end where the piles have scoured out.
        return JETTY_DECK - 0.12 * math.sin(math.pi * min(x, L) / L) - 0.12 * smoothstep(0.65, 1.0, x / L)

    def post(x, y, z1, r=0.13, lean=(0.0, 0.0), jag=False):
        ph, b = rnd.uniform(0, 6.28), rnd.random()
        st = 6
        path = [Vector((x + lean[0] * (i / st) ** 1.5, y + lean[1] * (i / st) ** 1.5, -2.5 + (z1 + 2.5) * i / st))
                for i in range(st + 1)]
        knot = lambda t, a: 1.0 + 0.07 * math.sin(a * 2 + ph) + 0.04 * math.sin(a * 5 + t * 7 + ph)
        limb(mb, path, [r * (1.06 - 0.1 * i / st) for i in range(st + 1)], segments=7,
             col_fn=lambda t: (t, 0.0, b), cap_start=False, radial_fn=knot, jag=(rnd, 0.24) if jag else None)

    bents = [0.35 + i * (L - 0.7) / 7 for i in range(8)]
    for bi, x in enumerate(bents):
        last = bi == len(bents) - 1
        for side in (-1, 1):
            if (bi, side) == (5, -1):
                post(x, -1.0, 0.3, lean=(0.06, -0.14), jag=True)  # snapped below the deck; stringers still carry it
            else:
                post(x, side * 1.0, top(x) + (0.6 if last else -0.3),
                     lean=(rnd.uniform(-0.07, 0.07), rnd.uniform(-0.05, 0.05)))
        tilt = rnd.uniform(-0.03, 0.03)
        plank(mb, (x, -1.3, top(x) - 0.33 - tilt), (x, 1.3, top(x) - 0.33 + tilt), 0.18, 0.2, col=(0, 0, rnd.random()))
        if bi in (1, 3, 6):
            for s in (-1, 1):
                plank(mb, (x + s * 0.15, -s * 1.0, -1.7), (x + s * 0.15, s * 1.0, top(x) - 0.45), 0.14, 0.05,
                      up=(1, 0, 0), col=(0, 0, rnd.random()))

    joints = [0.0] + bents[1:-1] + [L]
    for y in (-0.85, 0.0, 0.85):
        for xa, xb in zip(joints, joints[1:]):
            plank(mb, (xa, y, top(xa) - 0.14), (xb, y, top(xb) - 0.14), 0.12, 0.18, col=(0, 0, rnd.random()))

    n = int(L / 0.25)
    gone = {i for i in range(n) if rnd.random() < 0.05} | {41, 42, 57, 66, 67, 69}
    for i in range(n):
        if i in gone:
            continue
        x = 0.125 + i * 0.25 + rnd.uniform(-0.015, 0.015)
        yaw = rnd.uniform(-0.012, 0.012)
        y0, y1 = -1.2 + rnd.uniform(-0.08, 0.06), 1.2 + rnd.uniform(-0.06, 0.08)
        if rnd.random() < 0.12:
            if rnd.random() < 0.5:
                y0 += rnd.uniform(0.5, 1.0)
            else:
                y1 -= rnd.uniform(0.5, 1.0)
        z, dz = top(x) - 0.025, rnd.uniform(-0.015, 0.015)
        plank(mb, (x + y0 * yaw, y0, z - dz), (x + y1 * yaw, y1, z + dz), rnd.uniform(0.19, 0.215), 0.05,
              col=(0, 0, rnd.random()))

    # Ladder down into the water off the end.
    xe = L + 0.08
    for y in (0.3, 0.75):
        limb(mb, [(xe, y, -1.8), (xe, y, top(L) + 0.75)], [0.045, 0.04], segments=5, cap_start=False)
    for k in range(7):
        if k != 4:
            z = -1.3 + k * 0.38
            limb(mb, [(xe, 0.28, z), (xe, 0.77, z)], [0.03, 0.03], segments=4)

    for x, y, z1, lean in ((L + 1.9, -1.0, 0.85, (0.1, -0.05)), (L + 1.9, 1.0, -0.15, (0.0, 0.05)),
                           (L + 4.1, -0.95, 0.35, (0.25, -0.15)), (L + 4.1, 1.05, 1.5, (0.55, 0.35))):
        post(x, y, z1, lean=lean, jag=True)
    plank(mb, (L + 1.95, -0.95, 0.7), (L + 3.6, 1.0, -0.45), 0.18, 0.2, col=(0, 0, rnd.random()))
    ramp_r(mb, 0, -2.5, JETTY_DECK + 0.6)
    return mb.build("Jetty", prop_mats("wood"), smooth=False)


def build_wreck():
    """Ribs and keel of a ~9 m boat, rolled onto its side and sunk to the bilge; bow toward +X, origin on the
    sand under the keel's middle."""
    rnd = random.Random(301)
    mb = MeshBuilder()
    Lw = 9.0

    def hull(u, v):
        x = (u - 0.5) * Lw
        b = 1.5 * math.sin(math.pi * (0.04 + 0.92 * u)) ** 0.55
        sheer = 1.35 + 0.9 * (2 * u - 1) ** 4 + 0.25 * u
        a = abs(v) * math.pi / 2
        return Vector((x, math.copysign(b * math.sin(a) ** 0.7, v), sheer * (1 - math.cos(a)) ** 1.15))

    def outward(u, v):
        e = 0.01
        n = (hull(u, v + e) - hull(u, v - e)).cross(hull(u + e, v) - hull(u - e, v)).normalized()
        p = hull(u, v)
        return n if n.dot(p - Vector((p.x, 0, 1.2))) > 0 else -n

    limb(mb, [(-4.6 + 9.2 * i / 8, 0, -0.05 + 0.08 * math.sin(math.pi * i / 8)) for i in range(9)], [0.17] * 9,
         segments=6, col_fn=lambda t: (0, 0, 0.1))
    limb(mb, [(4.5 + 0.8 * math.sin(th), 0, 2.0 * (1 - math.cos(th))) for th in (math.pi / 2 * k / 7 for k in range(8))],
         [0.16 - 0.04 * k / 7 for k in range(8)], segments=6, cap_start=False, jag=(rnd, 0.3))
    limb(mb, [(-4.5, 0, 0), (-4.68, 0, 0.9), (-4.85, 0, 1.75)], [0.15, 0.14, 0.13], segments=6, cap_start=False,
         jag=(rnd, 0.25))

    ribs = [0.07 + 0.86 * k / 13 for k in range(14)]
    for u in ribs:
        for side in (-1, 1):
            if rnd.random() < 0.08:
                continue
            vmax, jag = 1.08, None
            if rnd.random() < (0.5 if side > 0 else 0.25):
                vmax, jag = rnd.uniform(0.35, 0.85), (rnd, 0.12)
            st = 9
            path = [hull(u, side * (0.03 + (vmax - 0.03) * i / st)) for i in range(st + 1)]
            limb(mb, path, [0.095 - 0.03 * i / st for i in range(st + 1)], segments=5, jag=jag)

    for side, vs, keep in ((-1, (0.16, 0.3, 0.44, 0.58), 0.75), (1, (0.16, 0.3), 0.45)):
        for v in vs:
            for ua, ub in zip(ribs, ribs[1:]):
                if rnd.random() > keep:
                    continue
                um = (ua + ub) / 2
                n = outward(um, side * v)
                plank(mb, hull(ua - 0.012, side * v) + n * 0.1, hull(ub + 0.012, side * v) + n * 0.1, 0.2, 0.045,
                      up=n, col=(0, 0, rnd.random()))
    um = 0.58
    xm = (um - 0.5) * Lw
    limb(mb, [(xm, 0, 0), (xm + 0.05, 0.03, 1.3), (xm + 0.1, 0.05, 2.6)], [0.16, 0.14, 0.12], segments=7,
         jag=(rnd, 0.35))
    yb = hull(um, 0.45)
    plank(mb, (xm + 0.25, -yb.y, yb.z), (xm + 0.25, yb.y * 0.4, yb.z), 0.26, 0.08, col=(0, 0, rnd.random()))

    R = Matrix.Rotation(math.radians(-6), 3, "Y") @ Matrix.Rotation(math.radians(23), 3, "X")
    xform(mb, 0, lambda p: R @ p + Vector((0, 0, -0.75)))
    ramp_r(mb, 0, -0.9, 2.8)
    return mb.build("Wreck", prop_mats("wood"), smooth=False)


def build_hut():
    """Fisherman's stilt hut, door and porch facing +Y; origin on the ground under the middle of the floor."""
    rnd = random.Random(401)
    mb = MeshBuilder()
    WOOD, THATCH, GLOW = 0, 1, 2
    F, X0, X1, Y0, Y1 = 0.7, -1.6, 1.6, -1.1, 1.1
    slope = 0.45 / (Y1 - Y0)

    def eave(y):
        return 3.2 - (y - Y0) * slope

    def c():
        return (0.0, 0.0, rnd.random())

    for x in (-1.5, 0.0, 1.5):
        for y in (-1.0, 1.0, 2.0):
            z1 = eave(y) + 0.02 if (y == 2.0 and x != 0.0) else F - 0.1
            cc = c()
            limb(mb, [(x, y, -0.4), (x + rnd.uniform(-0.03, 0.03), y, z1)], [0.09, 0.08], segments=6,
                 col_fn=lambda t, cc=cc: cc, cap_start=False)
    for y in (-1.0, 1.0):
        for xa, xb in ((-1.5, 0.0), (1.5, 0.0)):
            plank(mb, (xa, y + 0.1, -0.2), (xb, y + 0.1, F - 0.22), 0.1, 0.04, up=(0, 1, 0), col=c())
    for y in (-1.0, 1.0, 2.0):
        plank(mb, (X0 - 0.12, y, F - 0.13), (X1 + 0.12, y, F - 0.13), 0.14, 0.16, col=c())
    for k in range(13):
        y = -1.12 + k * 0.27
        j = rnd.uniform(-0.05, 0.05)
        xa, xb = X0 - 0.05 + j, X1 + 0.05 + j
        if k == 10:
            xb -= 1.1
        plank(mb, (xa, y, F - 0.025), (xb, y + (0.04 if k == 11 else 0.0), F - 0.025), 0.25, 0.05, col=c())

    door = (-1.25, -0.45, F + 1.85)
    win = (0.3, 1.05, F + 0.95, F + 1.6)

    def wall_x(y, normal_y):
        """Planks standing along a wall of constant y."""
        x = X0 + 0.06
        while x < X1 - 0.05:
            w = rnd.uniform(0.19, 0.25)
            xc = x + w / 2
            topz = eave(y) + rnd.uniform(-0.04, 0.0)
            lean = rnd.uniform(-0.015, 0.015)
            spans = [(F, topz)]
            if normal_y > 0 and door[0] - 0.05 < xc < door[1] + 0.05:
                spans = [(door[2] + 0.06, topz)]
            elif normal_y > 0 and win[0] - 0.05 < xc < win[1] + 0.05:
                spans = [(F, win[2] - 0.02), (win[3] + 0.02, topz)]
            for z0, z1 in spans:
                plank(mb, (xc, y, z0), (xc + lean, y, z1), w - 0.015, 0.04, up=(0, 1, 0), col=c())
            x += w

    def wall_y(x):
        y = Y0 + 0.06
        while y < Y1 - 0.05:
            w = rnd.uniform(0.19, 0.25)
            yc = y + w / 2
            plank(mb, (x, yc, F), (x, yc + rnd.uniform(-0.015, 0.015), eave(yc) + rnd.uniform(-0.04, 0.0)), w - 0.015,
                  0.04, up=(1, 0, 0), col=c())
            y += w

    wall_x(Y0, -1)
    wall_x(Y1, 1)
    wall_y(X0)
    wall_y(X1)
    for x in (X0, X1):
        for y in (Y0, Y1):
            plank(mb, (x, y, F), (x, y, eave(y)), 0.12, 0.12, up=(0, 1, 0), col=c())

    # Door frame and a door hanging ajar.
    for x in (door[0] - 0.03, door[1] + 0.03):
        plank(mb, (x, Y1 + 0.03, F), (x, Y1 + 0.03, door[2] + 0.05), 0.07, 0.07, up=(0, 1, 0), col=c())
    plank(mb, (door[0] - 0.1, Y1 + 0.04, door[2] + 0.07), (door[1] + 0.1, Y1 + 0.04, door[2] + 0.07), 0.08, 0.1,
          up=(0, 1, 0), col=c())
    s0 = len(mb.verts)
    for k in range(4):
        xc = door[0] + 0.1 + k * 0.2
        plank(mb, (xc, Y1 + 0.06, F + 0.03), (xc, Y1 + 0.06, door[2] - 0.02), 0.19, 0.035, up=(0, 1, 0), col=c())
    for z in (F + 0.3, door[2] - 0.3):
        plank(mb, (door[0] + 0.06, Y1 + 0.09, z), (door[1] - 0.06, Y1 + 0.09, z), 0.1, 0.03, up=(0, 1, 0), col=c())
    plank(mb, (door[0] + 0.1, Y1 + 0.09, F + 0.35), (door[1] - 0.1, Y1 + 0.09, door[2] - 0.35), 0.08, 0.03,
          up=(0, 1, 0), col=c())
    hinge = Vector((door[0], Y1 + 0.06, 0))
    rz = Matrix.Rotation(math.radians(38), 3, "Z")
    xform(mb, s0, lambda p: rz @ (p - hinge) + hinge)

    # Window frame, cross bar, and a shutter swung right open.
    for x in (win[0], win[1]):
        plank(mb, (x, Y1 + 0.04, win[2] - 0.03), (x, Y1 + 0.04, win[3] + 0.03), 0.06, 0.06, up=(0, 1, 0), col=c())
    for z, w in ((win[2] - 0.03, 0.12), (win[3] + 0.03, 0.08)):
        plank(mb, (win[0] - 0.08, Y1 + 0.05, z), (win[1] + 0.08, Y1 + 0.05, z), w, 0.05, col=c())
    xm, zm = (win[0] + win[1]) / 2, (win[2] + win[3]) / 2
    plank(mb, (xm, Y1 + 0.04, win[2]), (xm, Y1 + 0.04, win[3]), 0.035, 0.035, up=(0, 1, 0), col=c())
    plank(mb, (win[0], Y1 + 0.04, zm), (win[1], Y1 + 0.04, zm), 0.035, 0.035, up=(0, 1, 0), col=c())
    s0 = len(mb.verts)
    for k in range(3):
        xc = win[0] + 0.125 + k * 0.25
        plank(mb, (xc, Y1 + 0.07, win[2]), (xc, Y1 + 0.07, win[3]), 0.24, 0.03, up=(0, 1, 0), col=c())
    for z in (win[2] + 0.12, win[3] - 0.12):
        plank(mb, (win[0] + 0.05, Y1 + 0.095, z), (win[1] - 0.05, Y1 + 0.095, z), 0.07, 0.025, up=(0, 1, 0), col=c())
    hinge = Vector((win[1] + 0.03, Y1 + 0.07, zm))
    rs = Matrix.Rotation(math.radians(-158), 3, "Z") @ Matrix.Rotation(math.radians(7), 3, "Y")
    xform(mb, s0, lambda p: rs @ (p - hinge) + hinge)

    # Shelf inside the window with the lamp on it.
    plank(mb, (win[0] + 0.02, Y1 - 0.16, win[2] - 0.05), (win[1] - 0.02, Y1 - 0.16, win[2] - 0.05), 0.22, 0.03, col=c())
    lc = (xm + 0.04, Y1 - 0.18, win[2] - 0.035)
    lb = rnd.random()
    lathe(mb, [(0, 0), (0.075, 0), (0.075, 0.03), (0, 0.03)], 8, WOOD, center=lc, col_fn=lambda t: (0, 0, lb))
    lathe(mb, [(0, 0.03), (0.055, 0.03), (0.07, 0.1), (0.055, 0.18), (0, 0.18)], 10, GLOW, center=lc,
          col_fn=lambda t: (t, 0.5, lb))
    lathe(mb, [(0, 0.18), (0.075, 0.18), (0.03, 0.23), (0.012, 0.26), (0, 0.27)], 8, WOOD, center=lc,
          col_fn=lambda t: (0, 0, lb))

    # Roof: rafters, boards, then ragged thatch.
    for x in (-1.68, -0.56, 0.56, 1.68):
        plank(mb, (x, -1.5, eave(-1.5) + 0.07), (x, 2.4, eave(2.4) + 0.07), 0.08, 0.14, col=c())
    n_roof = Vector((0, slope, 1)).normalized()
    for k in range(14):
        if k == 9:
            continue
        y = -1.45 + k * 0.29
        z = eave(y) + 0.16
        plank(mb, (-1.92 + rnd.uniform(0, 0.12), y, z), (1.92 - rnd.uniform(0, 0.12), y, z), 0.28, 0.03, up=n_roof,
              col=c())

    def roof_z(y):
        return eave(y) + 0.19

    rows = [(-1.75, -1.42, -0.32)] + [(-1.6 + k * 0.34, -1.6 + k * 0.34 + 0.62, 0.0) for k in range(12)]
    for k, (ya, yb, drop) in enumerate(rows):
        ph = rnd.random()
        last = k == len(rows) - 1
        ncol = 19
        tops, mids, bots = [], [], []
        for j in range(ncol):
            x = 2.0 - 4.0 * j / (ncol - 1) + rnd.uniform(-0.04, 0.04)
            if j in (0, ncol - 1):
                x += math.copysign(rnd.uniform(-0.12, 0.05), x)
            # Alternate long and short tufts so the hem reads as bundled straw, not a cut sheet.
            y1 = yb + rnd.uniform(-0.04, 0.1) + (0.12 if j % 2 else -0.02) + (0.12 if last else 0.0)
            z1 = roof_z(y1) + 0.09 - (0.16 + rnd.uniform(0, 0.1) if last else 0.0) + drop
            if k == 0:
                # Back fringe hangs off the high edge instead of lying on the roof.
                y1 = yb - rnd.uniform(0.25, 0.4)
                z1 = roof_z(-1.5) - rnd.uniform(0.2, 0.38)
            p0 = Vector((x, ya, roof_z(ya) + 0.03))
            p1 = Vector((x + rnd.uniform(-0.04, 0.04), y1, z1))
            pm = p0.lerp(p1, 0.5) + Vector((0, 0, 0.03))
            tops.append(mb.v(p0, (0.0, 1.0, ph)))
            mids.append(mb.v(pm, (0.5, 1.0, ph)))
            bots.append(mb.v(p1, (1.0, 1.0, ph)))
        chunks = [(0, 6), (10, ncol - 1)] if k == 8 else [(0, ncol - 1)]
        for a, b in chunks:
            loft(mb, [tops[a:b + 1], mids[a:b + 1], bots[a:b + 1]], THATCH)

    # Porch: crates, a rain barrel, a sagging rail and steps down.
    yaw = 0.14
    ax, ay = (math.cos(yaw), math.sin(yaw), 0), (-math.sin(yaw), math.cos(yaw), 0)
    obox(mb, (0.95, 1.62, F + 0.21), ax, ay, 0.27, 0.22, 0.21, WOOD, c())
    for dz in (-0.12, 0.12):
        obox(mb, (0.95, 1.62, F + 0.21 + dz), ax, ay, 0.285, 0.235, 0.025, WOOD, c())
    yaw = 0.62
    obox(mb, (0.9, 1.6, F + 0.57), (math.cos(yaw), math.sin(yaw), 0), (-math.sin(yaw), math.cos(yaw), 0),
         0.19, 0.16, 0.15, WOOD, c())
    bb = rnd.random()
    lathe(mb, [(0, 0), (0.2, 0), (0.245, 0.3), (0.2, 0.62), (0, 0.62)], 12, WOOD, center=(-1.3, 1.78, F),
          col_fn=lambda t: (0, 0, bb))
    plank(mb, (1.5, 1.15, F + 0.92), (1.5, 2.0, F + 0.92), 0.08, 0.05, col=c())
    plank(mb, (1.5, 2.02, F + 0.9), (0.45, 2.06, F + 0.52), 0.08, 0.05, col=c())
    for x in (-1.2, -0.5):
        plank(mb, (x, 2.1, F - 0.05), (x, 2.8, -0.08), 0.16, 0.05, up=(1, 0, 0), col=c())
    for y, z in ((2.33, F - 0.25), (2.58, F - 0.5)):
        plank(mb, (-1.27, y, z), (-0.43, y, z), 0.22, 0.04, col=c())

    ramp_r(mb, 0, -0.4, 3.5)
    return mb.build("Hut", prop_mats("wood", "thatch", "lamp_glow"), smooth=False)


def build_cairn():
    """Seven stacked beach stones with a candle stub on top; origin at the ground under the stack."""
    rnd = random.Random(501)
    mb = MeshBuilder()
    z = 0.0
    rx, h = 0.44, 0.18
    off = Vector((0, 0, 0))
    for k in range(7):
        rx_k = rx * rnd.uniform(0.9, 1.1)
        ry_k = rx * rnd.uniform(0.7, 0.92)
        rot = Matrix.Rotation(rnd.uniform(0, 6.28), 3, "Z") @ Matrix.Rotation(rnd.uniform(-0.12, 0.12), 3, "X")
        # The squashed underside reaches 0.65 h below centre: sink each stone a little into the one beneath.
        cz = z + h * 0.55
        blob(mb, off + Vector((0, 0, cz)), (rx_k, ry_k, h), rnd, u=14, v=8, rough=0.1, flat=0.35, rot=rot,
             col=(0, 0, rnd.random()))
        z = cz + h * 0.9
        off += Vector((rnd.uniform(-0.045, 0.045), rnd.uniform(-0.045, 0.045), 0))
        rx *= rnd.uniform(0.76, 0.86)
        h *= rnd.uniform(0.84, 1.0)
    ramp_r(mb, 0, 0.0, z)
    cb = rnd.random()
    top = off + Vector((0.01, 0, z - 0.012))
    lathe(mb, [(0, 0), (0.06, 0), (0.07, 0.008), (0.04, 0.012), (0.036, 0.04), (0.034, 0.09), (0.026, 0.1),
               (0.005, 0.104), (0.005, 0.12), (0, 0.12)], 10, 1, center=top, col_fn=lambda t: (t * 0.6, 0.5, cb))
    lathe(mb, [(0, 0.12), (0.014, 0.135), (0.012, 0.16), (0.006, 0.18), (0, 0.2)], 6, 1, center=top,
          col_fn=lambda t: (0.7 + 0.3 * t, 0.5, cb))
    return mb.build("Cairn", prop_mats("stone", "candle_glow"), smooth=True)


def build_stone_lantern():
    """Weathered toro: hex base, round shaft, platform, open firebox with a glow core, upturned cap and finial."""
    rnd = random.Random(601)
    mb = MeshBuilder()
    STONE, GLOW = 0, 1
    worn = lambda t, a: 1.0 + 0.02 * math.sin(a * 3 + 1.7 + t * 5) + rnd.uniform(-0.012, 0.012)
    hexr = lambda a, rot: math.cos(math.pi / 6) / math.cos(((a - rot) % (math.pi / 3)) - math.pi / 6)
    col = lambda t: (0, 0, 0.3)
    lathe(mb, [(0.42, -0.1), (0.42, 0.1), (0.37, 0.14), (0.3, 0.17), (0.3, 0.22), (0, 0.22)], 6, STONE, col_fn=col,
          radial_fn=worn)
    lathe(mb, [(0.15, 0.2), (0.155, 0.25), (0.125, 0.3), (0.11, 0.55), (0.14, 0.57), (0.14, 0.61), (0.11, 0.63),
               (0.1, 0.88), (0, 0.88)], 12, STONE, col_fn=col, radial_fn=worn, cap_bottom=False)
    lathe(mb, [(0.12, 0.86), (0.3, 0.98), (0.34, 1.0), (0.34, 1.05), (0.27, 1.07), (0, 1.07)], 6, STONE, col_fn=col,
          radial_fn=worn)
    for k in range(6):
        if k in (1, 4):
            continue
        a = 2 * math.pi * k / 6
        d = Vector((math.cos(a), math.sin(a), 0))
        obox(mb, d * 0.21 + Vector((0, 0, 1.2)), d, (-d.y, d.x, 0), 0.035, 0.04, 0.14, STONE, (0, 0, 0.5))
    for k in (1, 4):
        # Two opposite faces stay walled so the light falls in bars rather than a flat glow.
        a = 2 * math.pi * (k + 0.5) / 6
        d = Vector((math.cos(a), math.sin(a), 0))
        obox(mb, d * 0.19 + Vector((0, 0, 1.2)), d, (-d.y, d.x, 0), 0.025, 0.1, 0.13, STONE, (0, 0, 0.5))
    lathe(mb, [(0, 1.3), (0.26, 1.3), (0.27, 1.34), (0, 1.34)], 6, STONE, col_fn=col, radial_fn=worn)
    cap_rot = math.radians(7)
    upturn = lambda t, a: 0.08 * ((hexr(a, cap_rot) - 0.866) / 0.134) ** 2 * (1.0 if 0.1 < t < 0.4 else 0.35 if t < 0.55 else 0.0)
    lathe(mb, [(0.2, 1.33), (0.56, 1.37), (0.57, 1.42), (0.43, 1.47), (0.2, 1.56), (0.09, 1.6), (0.09, 1.62),
               (0, 1.62)], 24, STONE, col_fn=col, z_fn=upturn, rot=cap_rot,
          radial_fn=lambda t, a: hexr(a, cap_rot) * (1.0 + rnd.uniform(-0.01, 0.01)) if t < 0.6 else 1.0)
    lathe(mb, [(0.075, 1.6), (0.105, 1.66), (0.09, 1.72), (0.05, 1.76), (0.01, 1.8), (0, 1.81)], 10, STONE,
          col_fn=col, radial_fn=worn)
    s0 = len(mb.verts)
    lathe(mb, [(0, 1.11), (0.08, 1.14), (0.1, 1.2), (0.08, 1.26), (0, 1.29)], 8, GLOW,
          col_fn=lambda t: (t, 0.5, 0.3))
    del s0
    lean = Matrix.Rotation(math.radians(2.2), 3, "X")
    xform(mb, 0, lambda p: lean @ (p * 0.9))
    ramp_r(mb, 0, 0.0, 1.63)
    return mb.build("StoneLantern", prop_mats("stone", "lamp_glow"), smooth=False)


def build_lighthouse():
    """The Keeper's lighthouse on a rock platform; keeper's cottage attached on +X, tower door facing -Y."""
    rnd = random.Random(701)
    mb = MeshBuilder()
    WHITE, BAND, STONE, GLASS, WOOD = range(5)
    cs = (0, 0, 0)

    blob(mb, (2.4, 0.0, 0.15), (7.6, 5.4, 1.15), rnd, u=26, v=10, mat=STONE, rough=0.1, flat=0.5)
    for k in range(11):
        a = 2 * math.pi * k / 11 + rnd.uniform(-0.2, 0.2)
        r = rnd.uniform(0.85, 1.05)
        big = 1.3 if math.cos(a) < -0.3 else 1.0
        sz = (rnd.uniform(1.0, 2.0) * big, rnd.uniform(0.8, 1.5) * big, rnd.uniform(0.6, 1.3) * big)
        blob(mb, (2.4 + math.cos(a) * 7.3 * r, math.sin(a) * 5.2 * r, 0.1), sz, rnd, u=12, v=7, mat=STONE, rough=0.14,
             flat=0.4, rot=Matrix.Rotation(rnd.uniform(0, 6.28), 3, "Z"))

    def tower_r(z):
        zt = (z - 1.8) / (21.0 - 1.8)
        return 1.95 + 1.05 * (1 - zt) ** 1.6

    bands = ((7.0, 9.6), (13.6, 16.2))
    levels = sorted(set([round(1.8 + k * 19.2 / 18, 4) for k in range(19)] + [b for bd in bands for b in bd]))
    prof = [(0, -0.4), (3.35, -0.4), (3.35, 1.55), (3.05, 1.75)] + [(tower_r(z), z) for z in levels] + \
           [(2.2, 21.2), (2.55, 21.45), (2.85, 21.6), (2.88, 21.85), (0, 21.85)]

    def tower_mat(i):
        zm = (prof[i][1] + prof[i + 1][1]) / 2
        if zm < 1.8:
            return STONE
        return BAND if any(a <= zm <= b for a, b in bands) and zm < 21 else WHITE

    lathe(mb, prof, 32, col_fn=lambda t: cs, mat_fn=tower_mat)
    for k in range(16):
        a = 2 * math.pi * (k + 0.5) / 16
        d = Vector((math.cos(a), math.sin(a), 0))
        plank(mb, d * (tower_r(20.1) - 0.05) + Vector((0, 0, 20.1)), d * 2.62 + Vector((0, 0, 21.5)), 0.14, 0.2,
              mat=WHITE)
    for k in range(24):
        a = 2 * math.pi * k / 24
        d = Vector((math.cos(a), math.sin(a), 0)) * 2.74
        limb(mb, [d + Vector((0, 0, 21.85)), d + Vector((0, 0, 22.85))], [0.03, 0.03], segments=4, mat=BAND,
             col_fn=lambda t: cs)
    for z, r, seg in ((22.85, 0.045, 5), (22.35, 0.025, 4)):
        ring = [(math.cos(a) * 2.74, math.sin(a) * 2.74, z) for a in (2 * math.pi * k / 36 for k in range(36))]
        limb(mb, ring, [r] * 36, segments=seg, mat=BAND, col_fn=lambda t: cs, closed=True)

    lathe(mb, [(0, 21.85), (1.55, 21.85), (1.55, 22.62), (1.68, 22.68), (1.68, 22.78), (0, 22.78)], 16, WHITE,
          col_fn=lambda t: cs)
    gb = rnd.random()
    lathe(mb, [(0, 22.78), (1.48, 22.78), (1.48, 24.28), (0, 24.28)], 12, GLASS, col_fn=lambda t: (t, 0.5, gb))
    for k in range(12):
        a = 2 * math.pi * k / 12
        d = Vector((math.cos(a), math.sin(a), 0))
        plank(mb, d * 1.49 + Vector((0, 0, 22.78)), d * 1.49 + Vector((0, 0, 24.28)), 0.07, 0.07, up=d, mat=BAND)
    lathe(mb, [(1.46, 23.5), (1.53, 23.5), (1.53, 23.56), (1.46, 23.56), (1.46, 23.5)], 12, BAND,
          col_fn=lambda t: cs, cap_bottom=False, cap_top=False)
    dome = [(0, 24.28), (1.8, 24.28), (1.8, 24.4), (1.62, 24.46)]
    for k in range(1, 8):
        th = 1.35 * k / 7
        dome.append((1.62 * math.cos(th), 24.46 + 1.05 * math.sin(th)))
    dome += [(0.2, 25.56), (0.2, 25.72), (0.3, 25.8), (0.33, 25.9), (0.28, 26.0), (0.1, 26.06), (0.035, 26.1),
             (0.03, 26.55), (0, 26.7)]
    lathe(mb, dome, 20, BAND, col_fn=lambda t: cs)
    plank(mb, (-0.4, 0, 26.35), (0.35, 0, 26.35), 0.035, 0.035, mat=BAND)
    obox(mb, (-0.36, 0, 26.42), (1, 0, 0), (0, 0, 1), 0.07, 0.1, 0.01, BAND)

    for a, z in ((-1.9, 4.8), (-0.4, 8.3), (1.1, 11.8), (2.4, 15.0), (-2.7, 18.4)):
        d = Vector((math.cos(a), math.sin(a), 0))
        t = Vector((-d.y, d.x, 0))
        cpos = d * (tower_r(z) - 0.02) + Vector((0, 0, z))
        obox(mb, cpos, t, (0, 0, 1), 0.3, 0.5, 0.12, WOOD)
        obox(mb, cpos + Vector((0, 0, 0.58)) + d * 0.04, t, (0, 0, 1), 0.38, 0.08, 0.12, WHITE)
        obox(mb, cpos - Vector((0, 0, 0.56)) + d * 0.06, t, (0, 0, 1), 0.36, 0.05, 0.14, WHITE)

    d, t = Vector((0, -1, 0)), Vector((1, 0, 0))
    base = d * (tower_r(2.8) - 0.05)
    obox(mb, base + Vector((0, 0, 2.95)), t, (0, 0, 1), 0.66, 1.18, 0.14, STONE)
    obox(mb, base + Vector((0, 0, 2.85)) + d * 0.08, t, (0, 0, 1), 0.48, 1.05, 0.1, WOOD)
    plank(mb, base + d * 0.35 + Vector((-0.8, 0, 4.25)), base + d * 0.35 + Vector((0.8, 0, 4.25)), 0.6, 0.08,
          up=(0, -0.25, 1), mat=WOOD)
    for k in range(3):
        top = 1.75 - 0.3 * k
        obox(mb, base + d * (0.4 + 0.38 * k) + Vector((0, 0, (top - 0.4) / 2)), t, (0, 0, 1), 0.8 - 0.05 * k,
             (top + 0.4) / 2, 0.2, STONE)

    extrude(mb, [(-2.25, -0.4), (2.25, -0.4), (2.25, 1.38), (-2.25, 1.38)], (2.4, 0, 0), (0, 1, 0), (0, 0, 1),
            (1, 0, 0), 6.0, STONE)
    extrude(mb, [(-2.1, 1.35), (2.1, 1.35), (2.1, 3.7), (0, 5.15), (-2.1, 3.7)], (2.6, 0, 0), (0, 1, 0), (0, 0, 1),
            (1, 0, 0), 5.6, WHITE)
    for s in (-1, 1):
        ay = Vector((0, s * 2.5, -1.8)).normalized()
        nrm = Vector((0, s * 1.8, 2.5)).normalized()
        obox(mb, Vector((5.45, s * 1.25, 4.35)) + nrm * 0.09, (1, 0, 0), ay, 2.95, 1.6, 0.09, WOOD)
    plank(mb, (2.5, 0, 5.36), (8.4, 0, 5.36), 0.22, 0.12, mat=WOOD)
    obox(mb, (7.2, 1.0, 5.0), (1, 0, 0), (0, 1, 0), 0.38, 0.32, 1.35, STONE)
    obox(mb, (7.2, 1.0, 6.4), (1, 0, 0), (0, 1, 0), 0.45, 0.39, 0.06, STONE)
    for x in (7.03, 7.37):
        lathe(mb, [(0, 6.46), (0.11, 6.46), (0.085, 6.72), (0.1, 6.78), (0.1, 6.82), (0, 6.82)], 8, STONE,
              center=(x, 1.0, 0), col_fn=lambda t: cs)
    obox(mb, (5.4, -2.12, 2.33), (1, 0, 0), (0, 0, 1), 0.62, 1.0, 0.06, STONE)
    obox(mb, (5.4, -2.15, 2.28), (1, 0, 0), (0, 0, 1), 0.47, 0.92, 0.06, WOOD)
    plank(mb, (4.75, -2.38, 3.45), (6.05, -2.38, 3.45), 0.55, 0.07, up=(0, -0.2, 1), mat=WOOD)
    for x, y in ((3.8, -1), (7.0, -1), (4.4, 1), (6.9, 1)):
        obox(mb, (x, y * 2.13, 2.6), (1, 0, 0), (0, 0, 1), 0.38, 0.5, 0.05, WOOD)
        obox(mb, (x, y * 2.17, 2.05), (1, 0, 0), (0, 0, 1), 0.47, 0.05, 0.09, STONE)
    obox(mb, (8.23, 0, 4.15), (0, 1, 0), (0, 0, 1), 0.3, 0.36, 0.05, WOOD)
    for k in range(3):
        top = 1.05 - 0.3 * k
        obox(mb, (5.4, -2.42 - 0.32 * k, (top - 0.3) / 2), (1, 0, 0), (0, 0, 1), 0.72, (top + 0.3) / 2, 0.17, STONE)

    ramp_r(mb, 0, 0.0, 26.7)
    return mb.build("Lighthouse", prop_mats("lighthouse_white", "lighthouse_band", "stone", "lamp_glass", "wood"),
                    smooth=False)


def build_swing():
    """Rope swing. Origin on the ground under the seat; the ropes loop over an (absent) bough at z=4, so place
    it under a palm or limb, and pivot any swinging about (0, 0, 4)."""
    rnd = random.Random(801)
    mb = MeshBuilder()
    ROPE, WOOD = 0, 1
    hang, seat = 4.0, 0.5
    for y in (-0.24, 0.24):
        b = rnd.random()
        st = 8
        path = [(0.015 * math.sin(i * 1.3 + y * 10) * math.sin(math.pi * i / st), y, hang - 0.1 - (hang - 0.1 - seat) * i / st)
                for i in range(st + 1)]
        limb(mb, path, [0.016] * (st + 1), segments=5, mat=ROPE, col_fn=lambda t, b=b: (t, 1.0, b))
        loop = [(math.cos(a) * 0.1, y + 0.012 * math.sin(a), hang + math.sin(a) * 0.1)
                for a in (2 * math.pi * k / 14 for k in range(14))]
        limb(mb, loop, [0.016] * 14, segments=5, mat=ROPE, col_fn=lambda t, b=b: (0.0, 1.0, b), closed=True)
        sphere(mb, (0, y, seat - 0.05), 0.032, u=6, v=4, mat=ROPE, col=(1.0, 1.0, b))
    plank(mb, (0, -0.33, seat), (0, 0.33, seat), 0.2, 0.045, mat=WOOD, col=(1.0, 0.0, rnd.random()))
    return mb.build("Swing", prop_mats("rope", "wood"), smooth=False)


def build_toy_boat():
    """A child's toy sailboat, 0.4 m; bow toward +X, origin under the keel."""
    rnd = random.Random(901)
    mb = MeshBuilder()
    WOOD, SAIL = 0, 1
    b = rnd.random()
    rings = []
    n = 12
    for i in range(n + 1):
        u = i / n
        x = -0.2 + 0.4 * u
        w = 0.062 * math.sin(math.pi * (0.18 + 0.82 * u)) ** 0.55
        deck = 0.075 + 0.02 * u ** 2
        keel = 0.035 * smoothstep(0.55, 1.0, u)
        if w < 1e-3:
            rings.append([mb.v((x, 0, deck - 0.005), (0, 0, b))])
            continue
        ring = []
        for s in range(12):
            a = 2 * math.pi * s / 12
            ca, sa = math.cos(a), math.sin(a)
            y = w * math.copysign(abs(ca) ** 0.8, ca)
            z = deck if sa > 0 else deck + (deck - keel) * math.copysign(abs(sa) ** 0.8, sa)
            ring.append(mb.v((x, y, z), (0, 0, b)))
        rings.append(ring)
    rings_loft(mb, rings, WOOD, True, False)
    obox(mb, (-0.08, 0, 0.095), (1, 0, 0), (0, 1, 0), 0.045, 0.032, 0.022, WOOD, (0, 0, b))
    limb(mb, [(0.03, 0, 0.07), (0.03, 0, 0.4)], [0.0065, 0.005], segments=5, col_fn=lambda t: (t, 0, b))
    limb(mb, [(0.03, 0, 0.135), (-0.16, 0, 0.135)], [0.0045, 0.0045], segments=4, col_fn=lambda t: (0.3, 0, b))
    limb(mb, [(0.19, 0, 0.095), (0.25, 0, 0.1)], [0.004, 0.003], segments=4, col_fn=lambda t: (0.2, 0, b))
    sb = rnd.random()
    rows = []
    for k in range(6):
        v = k / 5
        z = 0.14 + 0.24 * v
        leech = 0.03 - 0.175 * (1 - v) ** 1.1
        if k == 5:
            rows.append([mb.v((0.03, 0, z), (1.0, 1.0, sb))])
            continue
        rows.append([mb.v((0.03 + (leech - 0.03) * j / 4, 0.022 * math.sin(math.pi * j / 4) * (1 - v) ** 0.7, z),
                          (v, 1.0, sb)) for j in range(5)])
    loft(mb, rows, SAIL)
    rows = []
    for k in range(5):
        v = k / 4
        fx, fz = 0.245 + (0.04 - 0.245) * v, 0.1 + (0.37 - 0.1) * v
        if k == 4:
            rows.append([mb.v((fx, 0, fz), (1.0, 1.0, sb))])
            continue
        bx, bz = 0.045, 0.12 + 0.2 * v
        rows.append([mb.v((fx + (bx - fx) * j / 3, -0.014 * math.sin(math.pi * j / 3) * (1 - v), fz + (bz - fz) * j / 3),
                          (v, 1.0, sb)) for j in range(4)])
    loft(mb, rows, SAIL)
    loft(mb, [[mb.v((0.034, 0, 0.395), (1, 1, sb)), mb.v((0.034, 0, 0.37), (1, 1, sb))],
              [mb.v((0.085, 0.006, 0.383), (1, 1, sb))]], SAIL)
    return mb.build("ToyBoat", prop_mats("wood", "sail"), smooth=True)


def export_props():
    reset()
    build_jetty()
    build_wreck()
    build_hut()
    build_cairn()
    build_stone_lantern()
    build_lighthouse()
    build_swing()
    build_toy_boat()
    export("props")


# ---------------------------------------------------------------- creatures
# All face +X with the origin at the centre of mass; Z up. See the colour encoding in the module docstring.

def build_bird():
    """Egret in gliding flight: wings spread flat (span 1.4 m), neck out, legs trailing past the tail."""
    rnd = random.Random(1101)
    mb = MeshBuilder()
    Y, Z = Vector((0, 1, 0)), UP
    xh, xt = 0.62, -0.44
    bb = rnd.random()
    stations = [(0.62, 0.075, 0, 0), (0.55, 0.074, 0.007, 0.007), (0.5, 0.075, 0.014, 0.013),
                (0.465, 0.079, 0.026, 0.028), (0.43, 0.074, 0.024, 0.025), (0.37, 0.055, 0.015, 0.016),
                (0.28, 0.035, 0.017, 0.018), (0.19, 0.022, 0.026, 0.028), (0.1, 0.008, 0.055, 0.055),
                (0.0, 0.0, 0.07, 0.064), (-0.1, 0.0, 0.066, 0.056), (-0.2, 0.006, 0.05, 0.04),
                (-0.28, 0.01, 0.045, 0.02), (-0.36, 0.012, 0.05, 0.009), (-0.44, 0.012, 0, 0)]
    rings = []
    for x, z, w, h in stations:
        col = ((xh - x) / (xh - xt), 0.0, bb)
        cpos = Vector((x, 0, z))
        if w == 0:
            rings.append([mb.v(cpos, col)])
            continue
        rings.append([mb.v(cpos + Y * (math.cos(a) * w) + Z * (math.sin(a) * h), col)
                      for a in (2 * math.pi * s / 7 for s in range(7))])
    rings_loft(mb, rings)
    for sgn in (-1, 1):
        lb = rnd.random()
        limb(mb, [(-0.12, sgn * 0.022, -0.035), (-0.38, sgn * 0.024, -0.03), (-0.66, sgn * 0.02, -0.022)],
             [0.008, 0.006, 0.004], segments=3, col_fn=lambda t: (1.0, 0.0, lb))

    def wing(s):
        # Broad arm out to a forward wrist at ~40% span, then a hand that sweeps back to a rounded, slotted tip.
        le = 0.06 + 0.07 * smoothstep(0.0, 0.4, s) - 0.26 * smoothstep(0.4, 1.0, s) ** 1.3
        te = -0.17 - 0.02 * smoothstep(0.2, 0.6, s) - 0.04 * smoothstep(0.6, 1.0, s)
        tip = math.sqrt(max(0.0, 1.0 - smoothstep(0.82, 1.0, s) ** 2))
        mid = (le + te) / 2
        half = (le - te) / 2 * (0.2 + 0.8 * tip)
        return mid + half, mid - half, 0.012 + 0.04 * s * s

    for sgn in (-1, 1):
        wb = rnd.random()
        st = []
        for i in range(11):
            s = i / 10
            le, te, z = wing(s)
            y = sgn * (0.04 + 0.56 * s)
            st.append(((le, y, z), (te, y, z), (0, 0, 1), 0.015 * (1 - 0.75 * s) + 0.003, (s, 1.0, wb)))
        blade_loft(mb, st)
        # Slotted primaries: broad blunt fingers fanning from the hand, the big-seabird tell.
        for k, f in enumerate((0.1, 0.35, 0.6, 0.85)):
            s0 = 0.8 + 0.1 * math.sin(math.pi * f)
            le, te, z = wing(s0)
            ang = math.radians(10 + 45 * f)
            dvec = Vector((-math.sin(ang), sgn * math.cos(ang), 0.0))
            side = Vector((dvec.y, -dvec.x, 0)).normalized() * sgn
            base = Vector((le + (te - le) * (0.15 + 0.7 * f), sgn * (0.04 + 0.56 * s0), z + 0.003))
            Lf = 0.15 - 0.05 * f
            fb = rnd.random()
            fs = []
            for j in range(4):
                u = j / 3
                p = base + dvec * (Lf * u) + Vector((0, 0, 0.012 * u * u))
                w = 0.02 * (1 - 0.55 * u ** 3)
                fs.append((p + side * w, p - side * w, (0, 0, 1), 0.003 * (1 - u) + 0.001, (min(1.0, s0 + 0.2 * u), 1.0, fb)))
            blade_loft(mb, fs)
    return mb.build("Bird", [material("bird", (0.93, 0.93, 0.9))], smooth=True)


def build_jellyfish():
    """Bell up (+Z) with tentacles trailing down -Z; origin at the bell's centre. Swims bell-first, i.e. +Z."""
    rnd = random.Random(1201)
    mb = MeshBuilder()
    bb = rnd.random()
    # Counter-clockwise: subumbrella from the inner pole out to the rim lip, then the exumbrella up to the apex.
    prof = [(0.0, -0.02), (0.1, -0.03), (0.19, -0.055), (0.25, -0.09), (0.275, -0.12), (0.3, -0.13),
            (0.305, -0.1), (0.3, -0.04), (0.27, 0.03), (0.21, 0.09), (0.12, 0.13), (0.0, 0.145)]
    rim = lambda t: max(0.0, 1.0 - abs(t - 0.47) / 0.2)
    lathe(mb, prof, 32, 0, col_fn=lambda t: (0.0, 0.0, bb),
          radial_fn=lambda t, a: 1.0 + 0.035 * math.cos(a * 8) * rim(t),
          z_fn=lambda t, a: -0.03 * abs(math.cos(a * 4)) ** 3 * rim(t))
    for k in range(10):
        a = 2 * math.pi * (k + 0.5) / 10
        b = rnd.random()
        L = rnd.uniform(1.5, 2.0)
        ph = rnd.uniform(0, 6.28)
        st = 10
        root = Vector((math.cos(a) * 0.27, math.sin(a) * 0.27, -0.115))
        path = []
        for i in range(st + 1):
            t = i / st
            drift = 0.12 * t + 0.05 * math.sin(t * 5 + ph) * t
            path.append(root + Vector((math.cos(a) * drift + 0.05 * math.sin(t * 7 + ph) * t,
                                       math.sin(a) * drift + 0.05 * math.cos(t * 6 + ph) * t, -L * t)))
        limb(mb, path, [0.011 * (1 - 0.75 * i / st) for i in range(st + 1)], segments=3, mat=1,
             col_fn=lambda t, b=b: (t, 1.0, b), cap_start=False)
    for k in range(4):
        a = 2 * math.pi * k / 4 + 0.4
        b = rnd.random()
        L = rnd.uniform(0.7, 0.95)
        st = 14
        path = [Vector((math.cos(a) * (0.03 + 0.06 * t) + 0.03 * math.sin(t * 6 + k) * t,
                        math.sin(a) * (0.03 + 0.06 * t) + 0.03 * math.cos(t * 5 + k) * t, -0.03 - L * t))
                for t in (i / st for i in range(st + 1))]
        frill = lambda t, ang, k=k: 1.0 + 0.5 * math.sin(ang * 3 + t * 30 + k) * (0.3 + 0.7 * t)
        limb(mb, path, [0.035 * (1 - 0.6 * i / st) + 0.006 for i in range(st + 1)], segments=6, mat=1,
             col_fn=lambda t, b=b: (t, 1.0, b), radial_fn=frill, cap_start=False)
    return mb.build("Jellyfish", [material("jelly_bell", (0.55, 0.7, 0.95)),
                                  material("jelly_tentacle", (0.75, 0.6, 0.95))], smooth=True)


def build_fish():
    """Small leaping fish, 0.5 m snout to tail fork; laterally compressed with a forked tail."""
    rnd = random.Random(1301)
    mb = MeshBuilder()
    Y, Z = Vector((0, 1, 0)), UP
    xh = 0.25
    R = lambda p: max(0.0, min(1.0, (xh - p[0]) / 0.5))
    bb = rnd.random()
    stations = [(0.25, -0.005, 0, 0, 0), (0.235, -0.004, 0.01, 0.014, 0.014), (0.2, 0.0, 0.022, 0.035, 0.03),
                (0.15, 0.005, 0.03, 0.05, 0.042), (0.09, 0.007, 0.033, 0.058, 0.048), (0.02, 0.006, 0.031, 0.055, 0.045),
                (-0.04, 0.004, 0.025, 0.045, 0.036), (-0.09, 0.002, 0.016, 0.03, 0.025), (-0.13, 0.0, 0.009, 0.017, 0.015),
                (-0.15, 0.0, 0.006, 0.013, 0.012), (-0.155, 0.0, 0, 0, 0)]
    rings = []
    for x, z, w, ht, hb in stations:
        cpos = Vector((x, 0, z))
        col = (R(cpos), 0.0, bb)
        if w == 0:
            rings.append([mb.v(cpos, col)])
            continue
        rings.append([mb.v(cpos + Y * (math.cos(a) * w) + Z * (math.sin(a) * (ht if math.sin(a) > 0 else hb)), col)
                      for a in (2 * math.pi * s / 8 for s in range(8))])
    rings_loft(mb, rings)
    for sgn in (-1, 1):
        sphere(mb, (0.2, sgn * 0.0185, 0.01), 0.0065, u=6, v=4, col=(0.1, 0.0, bb))

    def fin_col(b):
        return lambda p: (R(p), 1.0, b)

    for sgn in (-1, 1):
        b = rnd.random()
        st = []
        for i in range(6):
            s = i / 5
            outer = (-0.135 - 0.115 * s, 0, sgn * (0.012 + 0.08 * s ** 0.8))
            inner = (-0.135 - 0.045 * s - 0.07 * s ** 3, 0, sgn * (0.092 * s ** 3))
            st.append((outer, inner, (0, 1, 0), 0.006 * (1 - s) + 0.0015, fin_col(b)))
        blade_loft(mb, st, cap_start=True)
    b = rnd.random()
    st = []
    for i in range(4):
        s = i / 3
        zb = 0.058 - 0.004
        st.append(((0.07 - 0.09 * s, 0, zb + 0.04 * s), (-0.035 + 0.015 * s, 0, zb + 0.04 * s * 0.92), (0, 1, 0),
                   0.004 * (1 - s) + 0.001, fin_col(b)))
    blade_loft(mb, st)
    for sgn in (-1, 1):
        b = rnd.random()
        st = []
        for i in range(4):
            s = i / 3
            root = Vector((0.14, sgn * 0.026, -0.018))
            p = root + Vector((-0.06 * s, sgn * 0.045 * s, -0.02 * s))
            ch = 0.036 * (1 - 0.7 * s * s)
            st.append((p + Vector((ch * 0.4, 0, 0)), p - Vector((ch * 0.6, 0, 0)), (0, -sgn * 0.3, 1),
                       0.003 * (1 - s) + 0.001, (s, 1.0, b)))
        blade_loft(mb, st)
        b = rnd.random()
        st = []
        for i in range(3):
            s = i / 2
            p = Vector((0.03 - 0.035 * s, sgn * (0.012 + 0.015 * s), -0.04 - 0.025 * s))
            ch = 0.022 * (1 - s) + 0.002
            st.append((p + Vector((ch * 0.5, 0, 0)), p - Vector((ch * 0.5, 0, 0)), (0, -sgn, 0.4),
                       0.002 * (1 - s) + 0.001, (s, 1.0, b)))
        blade_loft(mb, st)
    b = rnd.random()
    st = []
    for i in range(3):
        s = i / 2
        st.append(((-0.055 - 0.05 * s, 0, -0.03 - 0.03 * s), (-0.11 + 0.005 * s, 0, -0.018 - 0.035 * s), (0, 1, 0),
                   0.003 * (1 - s) + 0.001, fin_col(b)))
    blade_loft(mb, st)
    return mb.build("Fish", [material("fish", (0.58, 0.65, 0.75))], smooth=True)


WHALE = [  # u: 0 snout -> 1 fluke tip; half-width, half-height above / below the centre line, centre z
    (0.0, 0.05, 0.05, 0.05, -0.1),
    (0.012, 0.3, 0.17, 0.32, -0.14),
    (0.035, 0.52, 0.3, 0.64, -0.18),
    (0.07, 0.76, 0.48, 0.98, -0.2),
    (0.12, 1.04, 0.72, 1.3, -0.2),
    (0.2, 1.36, 1.04, 1.58, -0.14),
    (0.3, 1.58, 1.26, 1.62, -0.05),
    (0.4, 1.56, 1.32, 1.46, 0.02),
    (0.5, 1.38, 1.27, 1.18, 0.08),
    (0.6, 1.1, 1.14, 0.9, 0.12),
    (0.66, 0.92, 1.08, 0.74, 0.13),
    (0.72, 0.7, 0.88, 0.56, 0.12),
    (0.8, 0.44, 0.64, 0.4, 0.08),
    (0.87, 0.28, 0.44, 0.28, 0.04),
    (0.92, 0.19, 0.28, 0.19, 0.02),
    (0.94, 0.15, 0.2, 0.15, 0.0),
    (0.955, 0.08, 0.1, 0.08, 0.0),
]
WHALE_LEN, WHALE_NOSE = 14.0, 6.5
WHALE_TIP = -8.1  # fluke trailing tips; R reaches 1 here


def build_whale():
    """Humpback, 14 m: knobbly rostrum, ventral pleats, very long scalloped flippers, serrated flukes."""
    rnd = random.Random(1401)
    mb = MeshBuilder()
    R = lambda p: max(0.0, min(1.0, (WHALE_NOSE - p[0]) / (WHALE_NOSE - WHALE_TIP)))
    bb = rnd.random()
    seg = 44
    us = [0.0, 0.004, 0.01, 0.02, 0.034, 0.05, 0.07, 0.095] + [0.12 + 0.03 * k for k in range(28)] + [0.96]
    rings = []
    for u in us:
        w, ht, hb, zc = catmull(WHALE, u)
        x = WHALE_NOSE - WHALE_LEN * u
        col = (R((x,)), 0.0, bb)
        if u in (0.0, us[-1]):
            rings.append([mb.v((x, 0, zc), col)])
            continue
        w, ht, hb = max(w, 0.02), max(ht, 0.02), max(hb, 0.02)
        pleat_u = smoothstep(0.015, 0.06, u) * smoothstep(0.5, 0.4, u)
        mouth_u = smoothstep(0.24, 0.16, u)
        ring = []
        for s in range(seg):
            a = -math.pi / 2 + 2 * math.pi * s / seg
            ca, sa = math.cos(a), math.sin(a)
            y = w * math.copysign(abs(ca) ** 0.85, ca)
            dz = (ht if sa > 0 else hb) * math.copysign(abs(sa) ** 0.95, sa)
            k = 1.0
            # Alternate ventral vertices sink a little: the throat pleats that run from chin to navel.
            k -= 0.03 * pleat_u * smoothstep(-0.3, -0.5, sa) * (s % 2)
            k -= 0.03 * mouth_u * max(0.0, 1.0 - abs(sa + 0.12) / 0.1)
            ring.append(mb.v((x, y * k, zc + dz * k), col))
        rings.append(ring)
    rings_loft(mb, rings)

    def surf(u, f, top=True):
        w, ht, hb, zc = catmull(WHALE, u)
        return Vector((WHALE_NOSE - WHALE_LEN * u, f * w, zc + (ht if top else -hb) * (1 - f * f) ** 0.5 * (1 if top else 1)))

    # Tubercles: knobs scattered along the rostrum and chin, irregular so they read as warts, not rivets.
    for k in range(26):
        u = rnd.uniform(0.015, 0.13)
        f = rnd.uniform(-0.45, 0.45) * min(1.0, u / 0.05 + 0.3)
        p = surf(u, f)
        sphere(mb, p, rnd.uniform(0.07, 0.13), u=6, v=4, col=(R(p), 0.0, bb), scale=(1, 1, 0.6))
    for k in range(10):
        u = rnd.uniform(0.012, 0.08)
        p = surf(u, rnd.choice((-1, 1)) * rnd.uniform(0.6, 0.85), top=False)
        sphere(mb, p, rnd.uniform(0.07, 0.11), u=6, v=4, col=(R(p), 0.0, bb), scale=(1, 0.6, 1))
    for f in (-0.97, 0.97):
        w, ht, hb, zc = catmull(WHALE, 0.135)
        sphere(mb, (WHALE_NOSE - WHALE_LEN * 0.135, f * w, zc - 0.05), 0.1, u=6, v=4, col=(0.135, 0.0, bb))

    # Dorsal: a low hump with a small sickle fin, two-thirds back.
    db = rnd.random()
    st = []
    for i in range(4):
        s = i / 3
        u0, u1 = 0.62, 0.7
        p0, p1 = surf(u0, 0.0), surf(u1, 0.0)
        lead = p0 + (Vector((p1.x + 0.15, 0, p1.z + 0.5)) - p0) * s - Vector((0, 0, 0.15 * (1 - s)))
        trail = p1 + (Vector((p1.x + 0.05, 0, p1.z + 0.5)) - p1) * s ** 0.6 - Vector((0, 0, 0.15 * (1 - s)))
        st.append((lead, trail, (0, 1, 0), 0.12 * (1 - s) + 0.02, lambda p: (R(p), 1.0, db)))
    blade_loft(mb, st, cap_start=True)

    for sgn in (-1, 1):
        fb = rnd.random()
        root = Vector((2.7, sgn * 1.25, -0.75))
        d = Vector((-0.3, sgn * 0.88, -0.36)).normalized()
        cdir = (Vector((1, 0, 0)) - d * d.x).normalized()
        nrm = d.cross(cdir).normalized()
        span, n = 4.6, 22
        st = []
        for i in range(n + 1):
            s = i / n
            ctr = root + d * (span * s) - Vector((0.55 * s * s, 0, 0.15 * s * s))
            chord = 1.0 * (1 - 0.2 * s) * (1 - 0.85 * smoothstep(0.72, 1.0, s)) + 0.04
            # Tubercles: the scalloped leading edge that gives the humpback flipper its unmistakable outline.
            bump = 0.07 * abs(math.sin(math.pi * s * 8)) * (1 - smoothstep(0.85, 1.0, s))
            st.append((ctr + cdir * (0.4 * chord + bump), ctr - cdir * (0.6 * chord), nrm,
                       0.14 * (1 - 0.75 * s) + 0.015, (s, 1.0, fb)))
        blade_loft(mb, st)

    for sgn in (-1, 1):
        fb = rnd.random()
        st = []
        n = 20
        for i in range(n + 1):
            s = i / n
            y = sgn * 2.55 * s
            z = 0.12 * s * s
            le = -6.3 - 1.3 * s ** 1.6
            # Swept, convex trailing edge with a central notch and a ragged rim.
            te = -7.05 + ((-6.3 - 1.3) - -7.05) * s - 0.75 * math.sin(math.pi * s) ** 0.8 \
                + 0.05 * math.sin(s * 40) * 4 * s * (1 - s)
            if i == n:
                te = le
            st.append(((le, y, z), (te, y, z), (0, 0, 1), 0.17 * (1 - s) + 0.02, lambda p, fb=fb: (R(p), 1.0, fb)))
        blade_loft(mb, st, cap_start=True, cap_end=False)

    # Centre of mass from the body table, so the game can spin it about its middle when it breaches.
    num = den = 0.0
    for k in range(200):
        u = k / 199 * 0.97
        w, ht, hb, zc = catmull(WHALE, u)
        a = max(w, 0) * max(ht + hb, 0)
        num += a * (WHALE_NOSE - WHALE_LEN * u)
        den += a
    cx = num / den
    xform(mb, 0, lambda p: p - Vector((cx, 0, 0)))
    obj = mb.build("Whale", [material("whale", (0.16, 0.18, 0.24))], smooth=True)
    print(f"[lapis] whale centre of mass shifted by {cx:.2f} m")
    return obj


def export_creatures():
    reset()
    build_bird()
    build_jellyfish()
    build_fish()
    build_whale()
    export("creatures")


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


for asset, fn in (("flora", export_flora), ("boat", build_boat), ("keeper", build_keeper),
                  ("props", export_props), ("creatures", export_creatures)):
    if not ONLY or asset in ONLY:
        fn()
