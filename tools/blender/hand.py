"""The Keeper's hand, as Mara remembers it: one right hand posed for each keepsake it holds.

Built in keepsakes.py's run (Hand_<id> objects in keepsakes.glb). Sculpted with a skin modifier over a
bone-like skeleton (wrist, palm, three joints per finger, a two-jointed thumb on a fleshy base),
then subdivided, so it reads as a real hand rather than capsules.

Frame (Blender, Z up): palm faces +Z (up), fingers point +Y (away from the eye once exported, -Z in
the game), thumb to +X (right hand). Origin at the centre of the palm.
"""
import math

import bpy
from mathutils import Matrix, Vector

# Finger knuckle x, segment lengths (proximal, middle, distal) and base radius: index to little.
FINGERS = [
    (0.026, (0.040, 0.024, 0.019), 0.0108),
    (0.008, (0.044, 0.027, 0.020), 0.0112),
    (-0.010, (0.041, 0.025, 0.019), 0.0105),
    (-0.027, (0.031, 0.020, 0.016), 0.0093),
]

# How each keepsake is gripped: finger curl (radians per joint, roughly), thumb swing in and curl,
# and a little spread between the fingers.
GRIPS = {
    "shell": {"curl": (0.55, 0.6, 0.45), "thumb_in": 0.55, "thumb_curl": 0.35, "spread": 0.04},
    "wings": {"curl": (1.35, 1.45, 1.0), "thumb_in": 0.95, "thumb_curl": 0.7, "spread": 0.0},
    "lantern": {"curl": (1.2, 1.35, 0.95), "thumb_in": 0.85, "thumb_curl": 0.6, "spread": 0.0},
    "compass": {"curl": (0.18, 0.2, 0.12), "thumb_in": 0.25, "thumb_curl": 0.1, "spread": 0.06},
    "ribbon": {"curl": (0.75, 0.85, 0.55), "thumb_in": 0.6, "thumb_curl": 0.45, "spread": 0.03},
}


def _chain(start, direction, lengths, curl, radius, axis=Vector((1, 0, 0))):
    """Joint positions along a finger, bending about `axis` by `curl` at each joint (tip toward +Z)."""
    pts, rads = [Vector(start)], [radius]
    d = Vector(direction).normalized()
    p = Vector(start)
    for i, (L, c) in enumerate(zip(lengths, curl)):
        d = (Matrix.Rotation(c, 3, axis) @ d).normalized()
        p = p + d * L
        pts.append(p.copy())
        rads.append(radius * (0.92 - 0.1 * i))
    return pts, rads


def build_hand(name, grip, material):
    verts, edges, radii = [], [], []

    def add(p, r):
        verts.append(tuple(p))
        radii.append(r)
        return len(verts) - 1

    # Wrist and the body of the palm: wide and flat.
    wrist = add((0.0, -0.085, -0.006), (0.021, 0.014))
    heel = add((0.0, -0.038, 0.0), (0.031, 0.012))
    mid = add((0.0, 0.0, 0.0), (0.038, 0.012))
    edges += [(wrist, heel), (heel, mid)]

    for k, (x, lengths, r) in enumerate(FINGERS):
        spread = (k - 1.5) * grip["spread"]
        base = add((x * 0.92, 0.03, 0.0), (r * 1.15, r * 0.95))
        edges.append((mid, base))
        direction = Matrix.Rotation(-spread, 3, Vector((0, 0, 1))) @ Vector((0, 1, 0))
        pts, rads = _chain((x, 0.044, 0.002), direction, lengths, grip["curl"], r)
        prev = base
        for p, rr in zip(pts, rads):
            i = add(p, (rr, rr * 0.9))
            edges.append((prev, i))
            prev = i

    # The thumb rises from the fleshy pad at the heel of the palm and swings in across it.
    pad = add((0.024, -0.03, 0.002), (0.015, 0.012))
    edges.append((heel, pad))
    t0 = Vector((0.04, -0.012, 0.006))
    swing = Matrix.Rotation(grip["thumb_in"], 3, Vector((0, 0, 1)))
    out = (swing @ Vector((0.75, 0.66, 0.15))).normalized()
    side = out.cross(Vector((0, 0, 1))).normalized()
    pts, rads = _chain(t0, out, (0.032, 0.026), (grip["thumb_curl"] * 0.6, grip["thumb_curl"]), 0.0105, axis=-side)
    prev = pad
    for p, rr in zip(pts, rads):
        i = add(p, (rr, rr * 0.95))
        edges.append((prev, i))
        prev = i

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, edges, [])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mod = obj.modifiers.new("skin", "SKIN")
    mod.use_smooth_shade = True
    skin = mesh.skin_vertices[0].data
    for i, r in enumerate(radii):
        skin[i].radius = r
    skin[wrist].use_root = True
    sub = obj.modifiers.new("subsurf", "SUBSURF")
    sub.levels = 2
    sub.render_levels = 2
    mesh.materials.append(material)
    return obj


def build_hands():
    material = bpy.data.materials.new("ghost_hand")
    for key, grip in GRIPS.items():
        build_hand(f"Hand_{key}", grip, material)
    print("[lapis] built ghost hands")
