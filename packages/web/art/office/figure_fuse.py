"""Fuse each continuous surface of the posed figure into one soft shape before it renders (office
figure v2, spec §2.1 and §3; plan Task 3).

The figure is rigid parts on joints (`figure.py`); rendered as they are, every joint shows a cap or a
tube end — "too much like tubes and boxes" (nick, 2026-10-22). After a frame is posed, the parts of one
fuse group (`o["fuse"]`: the skin, the head, a top, the trousers, a hair style) are joined into one mesh,
voxel-remeshed and smoothed, and that copy renders in their place. The originals stay posed underneath,
hidden, for the next frame.

The seated overlay needs to know which pixels are arms (the ID pass's green byte, `o["arm"]` per part).
A fused copy has two material slots, body and arm, and each face takes the slot of the original part it
is nearest — so a fused sleeve still splits off as `<layer>@arms`.
"""

from __future__ import annotations

import bmesh
import bpy
from mathutils.bvhtree import BVHTree

# (voxel size, Laplacian iterations) per kind of surface — the values the brainstorm's spike was
# approved with: a finer voxel for the face, more smoothing on the larger cloth and skin surfaces.
PARAMS = {"head": (0.3, 12), "skin": (0.4, 20), "hair": (0.35, 10), "cloth": (0.5, 18)}
LAMBDA = 0.6


def _kind(group: str) -> str:
    if group in ("head", "skin"):
        return group
    return "hair" if group.startswith("hair/") else "cloth"


def _world_bmesh(objs: list[bpy.types.Object], depsgraph) -> bmesh.types.BMesh:
    """The objects' evaluated meshes (modifiers applied), in world space, in one bmesh."""
    bm = bmesh.new()
    for o in objs:
        ev = o.evaluated_get(depsgraph)
        me = bpy.data.meshes.new_from_object(ev)
        me.transform(o.matrix_world)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    return bm


def fuse_frame(meshes: list[bpy.types.Object]) -> list[bpy.types.Object]:
    """Fuse every group of the posed frame once; the copies start hidden.

    A frame is rendered by many calls (the base, then each variant with the base as a holdout), and
    the fused shapes do not change between them — fusing once per frame instead of once per call is
    what keeps a full figure render near two hours instead of twelve (measured 2026-10-22: 2.2 s a
    call fusing per call). `show_for_call` then swaps the copies in for each call."""
    groups: dict[str, list[bpy.types.Object]] = {}
    for o in meshes:
        g = o.get("fuse")
        if g:
            groups.setdefault(g, []).append(o)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    copies = []
    for group, parts in groups.items():
        if len(parts) < 2:
            continue
        voxel, iters = PARAMS[_kind(group)]
        bm = _world_bmesh(parts, depsgraph)
        me = bpy.data.meshes.new(f"fused/{group}")
        bm.to_mesh(me)
        bm.free()
        o = bpy.data.objects.new(f"fused/{group}", me)
        bpy.context.scene.collection.objects.link(o)
        rm = o.modifiers.new("remesh", "REMESH")
        rm.mode, rm.voxel_size = "VOXEL", voxel
        sm = o.modifiers.new("smooth", "LAPLACIANSMOOTH")
        sm.lambda_factor, sm.iterations = LAMBDA, iters
        sm.use_volume_preserve, sm.use_normalized = False, True
        # apply both, so the faces can be sorted into body and arm below
        me2 = bpy.data.meshes.new_from_object(o.evaluated_get(bpy.context.evaluated_depsgraph_get()))
        o.modifiers.clear()
        old = o.data
        o.data = me2
        bpy.data.meshes.remove(old)
        for p in me2.polygons:
            p.use_smooth = True
        body_mat = parts[0].material_slots[0].material if parts[0].material_slots else None
        me2.materials.append(body_mat)
        me2.materials.append(body_mat)
        arm_parts = [p for p in parts if p.get("arm")]
        if arm_parts and len(arm_parts) < len(parts):
            arm_bm = _world_bmesh(arm_parts, depsgraph)
            body_bm = _world_bmesh([p for p in parts if not p.get("arm")], depsgraph)
            arm_t, body_t = BVHTree.FromBMesh(arm_bm), BVHTree.FromBMesh(body_bm)
            for poly in me2.polygons:
                c = poly.center
                da = arm_t.find_nearest(c)[3]
                db = body_t.find_nearest(c)[3]
                poly.material_index = 1 if da is not None and (db is None or da < db) else 0
            arm_bm.free()
            body_bm.free()
        elif arm_parts:
            for poly in me2.polygons:
                poly.material_index = 1
        o["layer"] = parts[0]["layer"]
        o["arm"] = False
        o["arm_slots"] = [False, True]
        o.hide_render = True
        o["fused_from"] = [p.name for p in parts]
        copies.append(o)
    return copies


def show_for_call(copies: list[bpy.types.Object]) -> None:
    """After `show` set up a call: each copy renders in place of its parts, in their state."""
    for o in copies:
        parts = [bpy.data.objects[n] for n in o["fused_from"]]
        on = [p for p in parts if not p.hide_render]
        o.hide_render = not on
        if on:
            o.is_holdout = on[0].is_holdout
            for p in on:
                p.hide_render = True




def clear(copies: list[bpy.types.Object]) -> None:
    """Delete a frame's copies (the next `show` sets the parts' visibility again)."""
    for o in copies:
        me = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.meshes.remove(me)
