"""Retargets Viggle motions (Mixamo skeleton GLBs) onto the Keeper rig, as JSON the asset build bakes.

Run headless:  blender -b --factory-startup --python tools/blender/viggle_retarget.py -- <raw_dir> <out_dir>
Reads <raw_dir>/<name>.glb (tools/viggle/text-to-motion.sh), writes <out_dir>/<name>.json:
  {"fps": 30, "frames": [{"rot": {bone: [x, y, z] euler XYZ radians}, "hips": [x, y, z]}, ...]}
Each target bone takes its source bone's change of orientation, in world space, from a rest swung onto
our bone's rest direction (the source rests in a T-pose, ours arms-down), so the two rigs' differing bone
axes and rest poses don't matter. The hips are grounded by matching the ankles to the floor and scaling
by leg length; their drift across the ground is measured from the first frame, so the figure stays put.
"""
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_assets as B  # noqa: E402

import bpy  # noqa: E402
from mathutils import Euler, Quaternion, Vector  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1:]
RAW, OUT = os.path.abspath(ARGS[0]), os.path.abspath(ARGS[1])

MAP = {
    "hips": "Hips", "spine": "Spine", "chest": "Spine2", "neck": "Neck", "head": "Head",
}
for side, mix in (("L", "Left"), ("R", "Right")):
    MAP.update({
        f"shoulder.{side}": f"{mix}Shoulder", f"upperarm.{side}": f"{mix}Arm", f"forearm.{side}": f"{mix}ForeArm",
        f"hand.{side}": f"{mix}Hand", f"thigh.{side}": f"{mix}UpLeg", f"shin.{side}": f"{mix}Leg",
        f"foot.{side}": f"{mix}Foot",
    })


def keeper_rig():
    arm = bpy.data.armatures.new("KeeperRig")
    rig = bpy.data.objects.new("KeeperRig", arm)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (head, tail, _) in B.BONES.items():
        eb = arm.edit_bones.new(name)
        eb.head, eb.tail, eb.roll = head, tail, 0
    for name, (_, _, parent) in B.BONES.items():
        if parent:
            arm.edit_bones[name].parent = arm.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def source_bone(src, name):
    for pb in src.pose.bones:
        if pb.name.split(":")[-1] == name:
            return pb
    raise KeyError(name)


def retarget(path, rig):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    src = next(o for o in set(bpy.data.objects) - before if o.type == "ARMATURE")
    act = src.animation_data.action
    f0, f1 = (int(round(v)) for v in act.frame_range)
    fps = bpy.context.scene.render.fps
    order = list(B.BONES)  # parents before children
    rest = {n: rig.data.bones[n].matrix_local.to_quaternion() for n in order}
    # The source rests in a T-pose and ours with arms down, so each source bone's rest is first
    # swung onto our bone's rest direction; motion is then measured from that matched rest.
    s_rest = {}
    for n in order:
        sb = source_bone(src, MAP[n]).bone
        tb = rig.data.bones[n]
        align = (sb.tail_local - sb.head_local).rotation_difference(tb.tail_local - tb.head_local)
        s_rest[n] = align @ sb.matrix_local.to_quaternion()
    s_hips = source_bone(src, MAP["hips"])
    ankles = [source_bone(src, f"{m}Foot") for m in ("Left", "Right")]
    # Leg length, ankle to hip, sets the scale; the lowest the ankles reach in the clip is the floor.
    src_leg = s_hips.bone.head_local.z - min(a.bone.head_local.z for a in ankles)
    tgt_ankle = B.BONES["foot.L"][0][2]
    scale = (B.BONES["hips"][0][2] - tgt_ankle) / max(src_leg, 1e-3)
    floor = float("inf")
    for f in range(f0, f1 + 1):
        bpy.context.scene.frame_set(f)
        floor = min(floor, *((src.matrix_world @ a.head).z for a in ankles))
    frames, prev, start = [], {n: Euler() for n in order}, None
    for f in range(f0, f1 + 1):
        bpy.context.scene.frame_set(f)
        # The Mixamo root is turned upright only while animating, so rest is read in armature
        # space and the pose in the world.
        sw = src.matrix_world.copy()
        world = {}
        rot = {}
        for n in order:
            pb = source_bone(src, MAP[n])
            delta = (sw @ pb.matrix).to_quaternion() @ s_rest[n].inverted()
            world[n] = delta @ rest[n]
            parent = B.BONES[n][2]
            # Pose-space rotation = parent pose @ (parent rest^-1 @ rest) @ local, solved for local.
            base = (world[parent] @ rest[parent].inverted() @ rest[n]) if parent else rest[n]
            local = base.inverted() @ world[n]
            e = local.to_euler("XYZ", prev[n])
            prev[n] = e
            rot[n] = [round(e.x, 5), round(e.y, 5), round(e.z, 5)]
        head = sw @ s_hips.head
        if start is None:
            start = head.copy()
        hip_z = (head.z - floor) * scale + tgt_ankle
        d = Vector(((head.x - start.x) * scale, (head.y - start.y) * scale, hip_z - B.BONES["hips"][0][2]))
        # Root bone location is in its rest frame: undo the rest rotation.
        loc = rest["hips"].inverted() @ d
        frames.append({"rot": rot, "hips": [round(loc.x, 5), round(loc.y, 5), round(loc.z, 5)]})
    for o in set(bpy.data.objects) - before:
        bpy.data.objects.remove(o, do_unlink=True)
    return {"fps": fps, "frames": frames}


def main():
    B.reset()
    rig = keeper_rig()
    os.makedirs(OUT, exist_ok=True)
    for path in sorted(glob.glob(os.path.join(RAW, "*.glb"))):
        name = os.path.splitext(os.path.basename(path))[0]
        data = retarget(path, rig)
        with open(os.path.join(OUT, f"{name}.json"), "w") as fh:
            json.dump(data, fh, separators=(",", ":"))
        print(f"[lapis] retargeted {name}: {len(data['frames'])} frames at {data['fps']} fps")


main()
