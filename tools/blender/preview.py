"""Renders a preview of an exported asset for visual review.

blender -b --factory-startup --python tools/blender/preview.py -- <in.glb> <out.png> \
    [dist] [height] [target_z] [name_filter] [action:frame,action:frame...|-] [azimuth] [spacing] [cull] [target_x]

name_filter keeps only root objects whose name contains it (use '*' for all).
Poses are laid out side by side by duplicating the rig per action:frame.
"""
import sys

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
src, out = args[0], args[1]
dist = float(args[2]) if len(args) > 2 else 20
height = float(args[3]) if len(args) > 3 else 6
target_z = float(args[4]) if len(args) > 4 else 5
name_filter = args[5] if len(args) > 5 else "*"
poses = [p.split(":") for p in args[6].split(",")] if len(args) > 6 and args[6] != "-" else []
azimuth = float(args[7]) if len(args) > 7 else 15.0

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
scene = bpy.context.scene

roots = [o for o in scene.objects if o.parent is None]
if name_filter != "*":
    for o in list(roots):
        if name_filter not in o.name:
            for c in o.children_recursive:
                bpy.data.objects.remove(c)
            bpy.data.objects.remove(o)
    roots = [o for o in scene.objects if o.parent is None]

if poses:
    rig = next(o for o in roots if o.type == "ARMATURE")
    copies = [rig]
    for _ in poses[1:]:
        dup = rig.copy()
        scene.collection.objects.link(dup)
        for c in rig.children:
            cc = c.copy()
            cc.data = c.data
            scene.collection.objects.link(cc)
            cc.parent = dup
            for m in cc.modifiers:
                if m.type == "ARMATURE":
                    m.object = dup
        copies.append(dup)
    for o, (act, frame) in zip(copies, poses):
        o.animation_data_create()
        o.animation_data.action = bpy.data.actions[act]
        if hasattr(o.animation_data, "action_slot") and o.animation_data.action_suitable_slots:
            o.animation_data.action_slot = o.animation_data.action_suitable_slots[0]
        o.animation_data.action_extrapolation = "HOLD"
        # Bake the pose so each copy can show a different frame.
        scene.frame_set(int(frame))
        for pb in o.pose.bones:
            pb.matrix_basis = pb.matrix_basis.copy()
        o.animation_data.action = None
    roots = copies

import math
spacing = float(args[8]) if len(args) > 8 else dist * 0.3
_az = math.radians(azimuth)
for i, o in enumerate(roots):
    # Lay out perpendicular to the view so side views don't stack objects.
    k = (i - (len(roots) - 1) / 2) * spacing
    o.location.x = math.cos(_az) * k
    o.location.y = math.sin(_az) * k

# Workbench MATERIAL mode reads the viewport colour, which the glTF importer leaves white.
for mat in bpy.data.materials:
    bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.node_tree else None
    if bsdf:
        sock = bsdf.inputs["Base Color"]
        col = sock.default_value
        # With vertex colours present the factor sits in a Mix node in front of the BSDF.
        if sock.links:
            for inp in sock.links[0].from_node.inputs:
                if inp.type == "RGBA" and not inp.links:
                    col = inp.default_value
                    break
        mat.diffuse_color = col

scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_cavity = True
scene.display.shading.show_shadows = False
scene.display.shading.show_backface_culling = len(args) > 9 and args[9] == "cull"
scene.render.resolution_x = 1600
scene.render.resolution_y = 900
scene.render.filepath = out
scene.world = bpy.data.worlds.new("w")

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 35
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
az = math.radians(azimuth)
target_x = float(args[10]) if len(args) > 10 else 0.0
cam.location = (target_x + math.sin(az) * dist, -math.cos(az) * dist, height)
cam.rotation_euler = (Vector((target_x, 0, target_z)) - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
bpy.ops.render.render(write_still=True)
