"""Turns a Microsoft Rocketbox avatar (https://github.com/microsoft/Microsoft-Rocketbox, MIT license) into
a ramp agent for the ramp sim, as one glTF binary (.glb), and builds the shared animation file.

Rocketbox people are a single skinned mesh (body, head and helmet materials, sometimes a tool belt) on a
3ds Max Biped skeleton ("Bip01 ..."), in centimeters, facing -Y in Blender. This keeps the mesh and
skeleton, paints them with their own textures, and dresses them for the ramp:

- the hard hat and tool belt come off (ramp agents wear a cap or beanie, not a helmet)
- a high-visibility vest is made from the torso itself: the chest and back faces are copied, pushed out
  a little and painted fluorescent with two silver retro-reflective bands, so it fits any body and bends
  with it (it keeps the body's skin weights). Avatars already wearing a vest keep theirs
- a cap or beanie, and earmuffs or a headset with a boom mic, ride on the head bone
- a pair of orange lighted wands ride on the hand bones (nodes "wand_L" and "wand_R", so the sim can
  show them only for marshallers and wing walkers)

The result is in meters, Y up, facing +Z (the sim's convention for people), with no animations; the
animations go in a separate file shared by every agent (they all have the same skeleton).

Usage (Blender 4.2 or later, in the background):
    blender -b --python tools/rocketbox_to_glb.py -- avatar AVATAR_FOLDER OUT.glb
        [--vest lime|orange|none] [--headwear cap|beanie|none] [--ears muffs|headset] [--max-texture 1024]
        [--preview OUT.png]
    blender -b --python tools/rocketbox_to_glb.py -- animations --rig AVATAR.fbx OUT.glb ANIM.fbx [ANIM.fbx ...]

AVATAR_FOLDER is a Rocketbox avatar folder (with Export/NAME.fbx and Textures/). Animation clips are
named after their files, without "m_"/"f_" and ".max".
"""
import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

VESTS = {'lime': (0.78, 0.96, 0.15), 'orange': (1.0, 0.36, 0.05)}
ORANGE = (1.0, 0.33, 0.06)
LIME = (0.72, 0.95, 0.1)
# Company uniforms: shirt and trouser colors (painted over the Rocketbox workwear), the vest design,
# cap color and logo color, and a radio speaker-mic on the vest.
UNIFORMS = {
    'workwear': {},
    'delta': {'shirt': (0.62, 0.04, 0.07), 'trousers': (0.15, 0.15, 0.16), 'vest': 'delta',
              'cap': (0.24, 0.25, 0.27), 'logo': (0.75, 0.03, 0.08), 'radio': True},
}
SILVER = (0.80, 0.82, 0.83)


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(path):
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False)
    arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    return arm, meshes


def load_image(path, max_size):
    image = bpy.data.images.load(path)
    if max(image.size) > max_size:
        k = max_size / max(image.size)
        image.scale(max(1, int(image.size[0] * k)), max(1, int(image.size[1] * k)))
    return image


def material(name, color=None, image=None, normal=None, roughness=0.8, emission=None):
    """A Principled material the glTF exporter understands: base color (a color or an image), an
    optional normal map, and an optional emission image (the reflective bands)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Roughness'].default_value = roughness
    if color:
        bsdf.inputs['Base Color'].default_value = (*color, 1)
    if image:
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = image
        links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    if normal:
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = normal
        tex.image.colorspace_settings.name = 'Non-Color'
        nm = nodes.new('ShaderNodeNormalMap')
        links.new(tex.outputs['Color'], nm.inputs['Color'])
        links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if emission:
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = emission
        links.new(tex.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = 1.0
    return m


def paint(body, folder, max_size):
    """Each Rocketbox material (m108_body, m108_head, ...) has Textures/<name>_color.tga and _normal.tga."""
    for i, old in enumerate(body.data.materials):
        name = old.name
        old.name = name + '_imported'          # Frees the name for the new material.
        tex = os.path.join(folder, 'Textures', name + '_{}.tga')
        color = load_image(tex.format('color'), max_size) if os.path.exists(tex.format('color')) else None
        normal = load_image(tex.format('normal'), max_size) if os.path.exists(tex.format('normal')) else None
        body.data.materials[i] = material(name, image=color, normal=normal,
                                          roughness=0.55 if name.endswith('head') else 0.85)


def strip(body, suffixes):
    """Deletes the faces of materials whose names end with any of these (helmet, tools)."""
    slots = [i for i, m in enumerate(body.data.materials) if m.name.split('_')[-1] in suffixes]
    if not slots:
        return
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in slots], context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bm.to_mesh(body.data)
    bm.free()
    for i in reversed(slots):
        body.data.materials.pop(index=i)


def world_verts(obj, material_suffix=None):
    m = obj.matrix_world
    mats = [i for i, mat in enumerate(obj.data.materials) if material_suffix is None or mat.name.endswith(material_suffix)]
    verts = set()
    for p in obj.data.polygons:
        if p.material_index in mats:
            verts.update(p.vertices)
    return [m @ obj.data.vertices[i].co for i in verts]


def bounds(points):
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return lo, hi


# Small 5x7 block letters for the vest's chest lettering.
LETTERS = {
    'D': ['1110', '1001', '1001', '1001', '1001', '1001', '1110'],
    'E': ['1111', '1000', '1000', '1110', '1000', '1000', '1111'],
    'L': ['1000', '1000', '1000', '1000', '1000', '1000', '1111'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    'A': ['0110', '1001', '1001', '1111', '1001', '1001', '1001'],
}


def vest_images(design, size=512):
    """The vest's fabric and a mask of its retro-reflective (silver) parts, for emission at night.

    The vest's UVs wrap round the body: u = 0.5 is the middle of the chest, 0 and 1 the middle of the
    back, u above 0.5 the wearer's left; v runs from the vest's hem (0) to the shoulders (1).
    Designs: 'lime' and 'orange', plain vests with two silver bands round the body; 'delta', orange
    with lime bands edged in silver (over the shoulders, down the front and back, round the waist), a
    black hem, a US flag patch and the name on the left chest."""
    import numpy as np
    u = (np.arange(size) + 0.5) / size
    U, V = np.meshgrid(u, u)
    rgb = np.zeros((size, size, 3))
    silver = np.zeros((size, size), bool)

    def fill(mask, color):
        rgb[mask] = color

    def banded(mask, edge):
        # A lime band with a silver edge on each side of it.
        fill(mask, LIME)
        silver[edge & ~mask] = True

    if design in VESTS:
        fill(np.ones_like(U, bool), VESTS[design])
        band = ((V > 0.12) & (V < 0.22)) | ((V > 0.42) & (V < 0.52))
        silver |= band
    else:
        fill(np.ones_like(U, bool), ORANGE)
        fill(V < 0.22, (0.05, 0.05, 0.05))
        waist = (V > 0.27) & (V < 0.35)
        banded(waist, (V > 0.255) & (V < 0.365))
        for c in (0.42, 0.58, 0.08, 0.92):        # Down the front either side, and the back.
            d = np.minimum(abs(U - c), 1 - abs(U - c))
            stripe = (d < 0.022) & (V > 0.35)
            banded(stripe, (d < 0.03) & (V > 0.35))
        # US flag patch on the wearer's left chest: red and white stripes, a blue canton.
        fu, fv, fw, fh = 0.635, 0.70, 0.05, 0.07
        flag = (abs(U - fu) < fw / 2) & (abs(V - fv) < fh / 2)
        stripes = np.floor((V - (fv - fh / 2)) / fh * 7) % 2 == 0
        fill(flag & stripes, (0.7, 0.05, 0.08))
        fill(flag & ~stripes, (0.95, 0.95, 0.95))
        fill(flag & (U < fu) & (V > fv), (0.05, 0.12, 0.35))
        # The name above it, in dark red block letters.
        x0, y0, px = 0.6, 0.83, 0.006
        for ch in 'DELTA':
            rows = LETTERS[ch]
            for r, row in enumerate(rows):
                for c, bit in enumerate(row):
                    if bit == '1':
                        cell = (abs(U - (x0 + c * px)) < px / 2) & (abs(V - (y0 - r * px)) < px / 2)
                        fill(cell, (0.35, 0.02, 0.04))
            x0 += (len(rows[0]) + 1) * px
    fill(silver, SILVER)
    fabric = bpy.data.images.new('hivis_vest', size, size)
    mask = bpy.data.images.new('hivis_reflective', size, size)
    fabric.pixels = np.concatenate([rgb, np.ones((size, size, 1))], axis=2).ravel()
    m = silver.astype(float) * 0.9
    mask.pixels = np.stack([m, m, m, np.ones_like(m)], axis=2).ravel()
    fabric.pack()
    mask.pack()
    return fabric, mask


def recolor_clothes(arm, body, shirt, trousers):
    """Repaints the blue Rocketbox workwear: the top (above the hips) as the shirt and the rest as
    trousers. Cloth pixels are found by their blue color and keep their shading (folds, seams); which
    part of the texture is shirt or trousers comes from where those faces sit on the body."""
    import numpy as np
    slot = next(i for i, m in enumerate(body.data.materials) if m.name.endswith('body'))
    tex = next(n for n in body.data.materials[slot].node_tree.nodes if n.type == 'TEX_IMAGE').image
    w, h = tex.size
    px = np.array(tex.pixels[:]).reshape(h, w, 4)
    hips = (arm.matrix_world @ arm.data.bones['Bip01 Pelvis'].head_local).z + 0.06
    # Masks of where the torso, the arms and the feet lie in the texture, by drawing their UV triangles.
    upper = np.zeros((h, w), bool)
    torso = np.zeros((h, w), bool)
    feet = np.zeros((h, w), bool)
    groups = {g.index: g.name for g in body.vertex_groups}
    limbs = {f'Bip01 {s} {b}' for s in 'LR' for b in ('UpperArm', 'Forearm', 'Hand')}
    me = body.data
    me.calc_loop_triangles()
    uv = me.uv_layers.active.data
    world = body.matrix_world
    for tri in me.loop_triangles:
        if tri.material_index != slot:
            continue
        z = sum((world @ me.vertices[v].co).z for v in tri.vertices) / 3
        on_limb = all(sum(g.weight for g in me.vertices[v].groups if groups.get(g.group) in limbs) > 0.5 for v in tri.vertices)
        mask = (upper if on_limb else torso) if z >= hips else feet if z < 0.14 else None
        if mask is None:
            continue
        pts = np.array([uv[i].uv[:] for i in tri.loops]) * (w, h)
        x0, y0 = np.floor(pts.min(0)).astype(int)
        x1, y1 = np.ceil(pts.max(0)).astype(int)
        xs, ys = np.meshgrid(np.arange(max(0, x0), min(w, x1 + 1)) + 0.5, np.arange(max(0, y0), min(h, y1 + 1)) + 0.5)
        (ax, ay), (bx, by), (cx, cy) = pts
        det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(det) < 1e-9:
            continue
        l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / det
        l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / det
        inside = (l1 >= -0.01) & (l2 >= -0.01) & (1 - l1 - l2 >= -0.01)
        mask[ys[inside].astype(int), xs[inside].astype(int)] = True
    upper |= torso
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    # A vest the avatar came with (fluorescent yellow, silver bands) turns the new vest's orange, so
    # nothing yellow shows where the new vest leaves gaps. Yellow gloves on the hands stay.
    yellow = torso & (r > 0.45) & (g > 0.4) & (b < 0.35)
    band = torso & (np.minimum(np.minimum(r, g), b) > 0.55) & (np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b) < 0.08)
    vest_lum = (0.3 * r + 0.59 * g + 0.11 * b)
    for part in (yellow, band):
        if part.any():
            px[part, :3] = np.clip(np.array(ORANGE) * (vest_lum[part] / np.median(vest_lum[part]))[:, None], 0, 1)
    cloth = (b > r + 0.08) & (b > g)
    lum = 0.3 * r + 0.59 * g + 0.11 * b
    shade = np.clip(lum / max(1e-3, np.median(lum[cloth])), 0, 1.8)[..., None]
    # Tan work boots become black safety boots (only what is not trouser cloth).
    boots = feet & ~cloth
    boot_shade = np.clip(lum / max(1e-3, np.median(lum[boots]) if boots.any() else 1), 0, 2)[..., None]
    for part, color, k in ((cloth & upper, shirt, shade), (cloth & ~upper, trousers, shade), (boots, (0.07, 0.07, 0.07), boot_shade)):
        px[part, :3] = np.clip(np.array(color) * k[part], 0, 1)
    tex.pixels = px.ravel()
    tex.pack()


def add_vest(arm, body, design):
    """Copies the torso's faces (from the hips to just below the collar, between the shoulder joints,
    not weighted mostly to the arms, neck or legs), pushes them out 1.5 cm along their normals, and
    paints them as a hi-vis vest. The copy keeps the body's vertex groups and armature, so it moves with
    the body, and covers any vest the avatar came with."""
    bone = lambda name: arm.matrix_world @ arm.data.bones[name].head_local
    neck, hips = bone('Bip01 Neck').z - 0.02, bone('Bip01 Pelvis').z - 0.08
    center, shoulder = bone('Bip01 Neck').x, abs(bone('Bip01 L UpperArm').x - bone('Bip01 Neck').x) - 0.02
    to_world = body.matrix_world
    groups = {g.index: g.name for g in body.vertex_groups}
    limbs = {f'Bip01 {s} {b}' for s in 'LR' for b in ('UpperArm', 'Forearm', 'Hand', 'Thigh', 'Calf')} | {'Bip01 Neck', 'Bip01 Head'}
    body_slot = next(i for i, m in enumerate(body.data.materials) if m.name.endswith('body'))

    def inside(v):
        p = to_world @ v.co
        return (hips < p.z < neck and abs(p.x - center) < shoulder
                and sum(g.weight for g in v.groups if groups.get(g.group) in limbs) < 0.5)

    keep = set()
    for p in body.data.polygons:
        if p.material_index == body_slot and all(inside(body.data.vertices[i]) for i in p.vertices):
            keep.add(p.index)
    vest = body.copy()
    vest.data = body.data.copy()
    vest.name = 'hivis_vest'
    bpy.context.scene.collection.objects.link(vest)
    bm = bmesh.new()
    bm.from_mesh(vest.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * 1.5         # Mesh units are centimeters under the armature's 0.01 scale.
    # UVs wrap round the body: u by angle about the vertical axis, v by height.
    zs = [v.co.z for v in bm.verts]
    z0, z1 = min(zs), max(zs)
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        us = [math.atan2(loop.vert.co.x, -loop.vert.co.y) / (2 * math.pi) + 0.5 for loop in f.loops]
        if max(us) - min(us) > 0.5:          # Across the middle of the back: keep the face whole.
            us = [x + 1 if x < 0.5 else x for x in us]
        for loop, x in zip(f.loops, us):
            loop[uv].uv = (x, (loop.vert.co.z - z0) / ((z1 - z0) or 1))
    bm.to_mesh(vest.data)
    bm.free()
    fabric, mask = vest_images(design)
    vest.data.materials.clear()
    vest.data.materials.append(material('hivis_vest', image=fabric, roughness=0.7, emission=mask))
    return vest


def head_frame(body):
    """Where the head is: its bounds in world meters (after the helmet is gone)."""
    lo, hi = bounds(world_verts(body, 'head'))
    return lo, hi, (lo + hi) / 2


def attach(obj, arm, bone):
    """Parents an object to a bone, keeping where it is in the world."""
    world = obj.matrix_world.copy()
    obj.parent = arm
    obj.parent_type = 'BONE'
    obj.parent_bone = bone
    bpy.context.view_layer.update()
    obj.matrix_world = world


def mesh_object(name, build, mat):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    build(bm)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    obj.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(obj)
    for p in me.polygons:
        p.use_smooth = True
    return obj


def add_headwear(arm, body, kind, color=(0.05, 0.08, 0.13), logo=None):
    """A ball cap (with a logo of the given color on the front, if any) or a beanie."""
    lo, hi, c = head_frame(body)
    r = (hi.x - lo.x) / 2
    fabric = material('cap', color=color, roughness=0.85)
    if kind == 'cap':
        def build(bm):
            bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=10, radius=r * 1.08)
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.01], context='VERTS')
            for v in bm.verts:
                v.co.y *= 1.1               # A little longer front to back, like a head.
            # Brim: a half ellipse out over the face (-Y is the face side), tipped down a little.
            arc = [(math.cos(t) * r * 0.95, -(r * 0.9 + math.sin(t) * r * 0.95)) for t in [i / 14 * math.pi for i in range(15)]]
            verts = [bm.verts.new((x, y, -0.006 - (-y - r * 0.9) * 0.25)) for x, y in arc]
            bm.faces.new(verts)
        cap = mesh_object('cap', build, fabric)
        cap.location = (c.x, c.y - r * 0.02, hi.z - r * 0.88)
        if logo:
            # A small upward triangle on the front panel.
            def mark(bm):
                s = r * 0.32
                bm.faces.new([bm.verts.new((-s, 0, 0)), bm.verts.new((s, 0, 0)), bm.verts.new((0, 0, s * 1.1))])
            m = mesh_object('cap_logo', mark, material('cap_logo', color=logo, roughness=0.6))
            m.location = (c.x, c.y - r * 0.02 - r * 1.19, hi.z - r * 0.88 + r * 0.3)
            m.rotation_euler = (math.radians(-12), 0, 0)
            bpy.context.view_layer.update()
            attach(m, arm, 'Bip01 Head')
    elif kind == 'beanie':
        def build(bm):
            bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=10, radius=r * 1.1)
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -r * 0.25], context='VERTS')
        cap = mesh_object('beanie', build, material('beanie', color=(0.06, 0.06, 0.07), roughness=0.95))
        cap.location = (c.x, c.y + r * 0.03, hi.z - r * 0.72)
    else:
        return
    bpy.context.view_layer.update()
    attach(cap, arm, 'Bip01 Head')


def add_ears(arm, body, kind):
    """Earmuffs (red cups on a band over the head), or a black headset with a boom mic for agents on
    the radio. Ears sit at the sides of the head, a little below its middle."""
    lo, hi, c = head_frame(body)
    r = (hi.x - lo.x) / 2
    color = (0.75, 0.08, 0.05) if kind == 'muffs' else (0.03, 0.03, 0.03)
    cup = material('ear_cups', color=color, roughness=0.5)
    ear_z = lo.z + (hi.z - lo.z) * 0.55
    for side in (-1, 1):
        def build(bm):
            bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.042, radius2=0.042, depth=0.035)
        o = mesh_object(f'ear_{"L" if side > 0 else "R"}', build, cup)
        o.rotation_euler = (0, math.pi / 2, 0)
        o.location = (c.x + side * (r + 0.012), c.y + 0.01, ear_z)
        bpy.context.view_layer.update()
        attach(o, arm, 'Bip01 Head')

    def band(bm):
        pts = [Vector((math.cos(a) * (r + 0.02), 0, math.sin(a) * (hi.z - ear_z + 0.015)))
               for a in [i / 16 * math.pi for i in range(17)]]
        prev = None
        for p in pts:
            v = bm.verts.new(p)
            if prev:
                bm.edges.new((prev, v))
            prev = v
    b = mesh_object('ear_band', band, cup)
    mod = b.modifiers.new('thick', 'SKIN')
    for v in b.data.skin_vertices[0].data:
        v.radius = (0.008, 0.008)
    b.location = (c.x, c.y + 0.01, ear_z)
    bpy.context.view_layer.update()
    bpy.context.view_layer.objects.active = b
    bpy.ops.object.modifier_apply(modifier=mod.name)
    attach(b, arm, 'Bip01 Head')
    if kind == 'headset':
        def boom(bm):
            bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=0.004, radius2=0.004, depth=0.11)
        mic = mesh_object('boom_mic', boom, cup)
        mic.rotation_euler = (math.radians(75), 0, math.radians(-35))
        mic.location = (c.x + r * 0.75, c.y - r * 0.7, ear_z - 0.035)
        bpy.context.view_layer.update()
        attach(mic, arm, 'Bip01 Head')


def add_radio(arm):
    """A speaker-mic clipped high on the vest's right front (the name is on the left)."""
    neck = arm.matrix_world @ arm.data.bones['Bip01 Neck'].head_local
    black = material('radio', color=(0.02, 0.02, 0.02), roughness=0.45)

    def build(bm):
        bmesh.ops.create_cube(bm, size=1)
        for v in bm.verts:
            v.co.x *= 0.055
            v.co.y *= 0.025
            v.co.z *= 0.075
    mic = mesh_object('speaker_mic', build, black)
    mic.location = (neck.x - 0.085, neck.y - 0.14, neck.z - 0.14)
    bpy.context.view_layer.update()
    attach(mic, arm, 'Bip01 Spine2')


def add_wands(arm):
    """Lighted marshalling wands: a black grip in the fist and a 40 cm orange tube along the hand."""
    glow = material('wand', color=(1.0, 0.3, 0.02), roughness=0.4)
    glow.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value = (1.0, 0.3, 0.02, 1)
    glow.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 2.0
    bones = arm.data.bones
    for side in ('L', 'R'):
        hand = bones[f'Bip01 {side} Hand']
        finger = bones[f'Bip01 {side} Finger2']
        head = arm.matrix_world @ hand.head_local
        tip = arm.matrix_world @ finger.head_local
        along = (tip - head).normalized()

        def build(bm):
            bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=0.022, radius2=0.018, depth=0.42)
        wand = mesh_object(f'wand_{side}', build, glow)
        # The tube's axis is Z; turn it along the hand and set it from the palm outward.
        wand.matrix_world = Matrix.Translation(tip + along * 0.17) @ along.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        bpy.context.view_layer.update()
        attach(wand, arm, f'Bip01 {side} Hand')


def export(path, with_animations=False):
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_animations=with_animations,
                              export_image_format='JPEG', export_jpeg_quality=85, export_yup=True,
                              export_apply=False, export_skins=True, export_morph=False)


def preview(path):
    """A quick front three-quarter render, to check the outfit."""
    scene = bpy.context.scene
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    cam.location = (1.6, -2.6, 1.3)
    cam.rotation_euler = (math.radians(86), 0, math.radians(31))
    scene.camera = cam
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(40), 0, math.radians(30))
    scene.collection.objects.link(sun)
    scene.world = bpy.data.worlds.new('w')
    scene.world.color = (0.5, 0.55, 0.6)
    try:
        scene.render.engine = 'BLENDER_EEVEE_NEXT'
    except TypeError:
        scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = 600, 800
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def avatar(a):
    clear()
    name = os.path.basename(os.path.normpath(a.folder))
    arm, meshes = import_fbx(os.path.join(a.folder, 'Export', name + '.fbx'))
    body = max(meshes, key=lambda o: len(o.data.vertices))
    strip(body, {'helmet', 'tools'})
    paint(body, a.folder, a.max_texture)
    bpy.context.view_layer.update()
    uniform = UNIFORMS[a.uniform]
    if uniform.get('shirt'):
        recolor_clothes(arm, body, uniform['shirt'], uniform['trousers'])
    vest = uniform.get('vest', a.vest)
    if vest != 'none':
        add_vest(arm, body, vest)
    add_headwear(arm, body, a.headwear, uniform.get('cap', (0.05, 0.08, 0.13)), uniform.get('logo'))
    add_ears(arm, body, a.ears)
    add_wands(arm)
    if uniform.get('radio'):
        add_radio(arm)
    for o in bpy.context.scene.objects:
        if o.type == 'EMPTY':
            bpy.data.objects.remove(o)
    if a.preview:
        preview(a.preview)
    export(a.out)


def fcurves(action):
    """An action's F-curves (Blender 4.4+ keeps them per slot)."""
    if hasattr(action, 'fcurves') and not getattr(action, 'is_action_layered', False):
        return action.fcurves
    from bpy_extras import anim_utils
    return anim_utils.action_get_channelbag_for_slot(action, action.slots[0]).fcurves


def animations(a):
    """One file holding every clip on the skeleton of an avatar (no mesh). Rocketbox animation files
    come with their armature turned and scaled differently from the avatars', so each clip is moved
    onto the avatar's own armature: rotations carry over as they are, and the pelvis' movement is
    rescaled to the avatar's units. The exported skeleton root then matches every avatar file."""
    clear()
    arm, meshes = import_fbx(a.rig)
    for m in meshes:
        bpy.data.objects.remove(m)
    spine = lambda armature: (armature.data.bones['Bip01 Spine'].head_local - armature.data.bones['Bip01 Pelvis'].head_local).length
    actions = []
    for path in a.clips:
        before = set(bpy.data.actions)
        bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False)
        src = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE' and o is not arm)
        ratio = spine(arm) / spine(src)
        act = next(x for x in bpy.data.actions if x not in before)
        act.use_fake_user = True
        for fc in fcurves(act):
            if fc.data_path.endswith('.location'):
                for k in fc.keyframe_points:
                    k.co.y *= ratio
                    k.handle_left.y *= ratio
                    k.handle_right.y *= ratio
        for o in list(bpy.context.scene.objects):
            if o is not arm and o.type in ('ARMATURE', 'MESH', 'EMPTY'):
                bpy.data.objects.remove(o)
        clip = os.path.basename(path).split('.')[0]
        clip = clip[2:] if clip[:2] in ('m_', 'f_') else clip
        act.name = clip
        actions.append(act)
    # Each action as an NLA track, so the exporter writes them all.
    arm.animation_data_create()
    for act in actions:
        track = arm.animation_data.nla_tracks.new()
        track.name = act.name
        track.strips.new(act.name, int(act.frame_range[0]), act)
    arm.animation_data.action = None
    for o in list(bpy.context.scene.objects):
        if o.type == 'EMPTY':
            bpy.data.objects.remove(o)
    bpy.ops.export_scene.gltf(filepath=a.out, export_format='GLB', export_animations=True,
                              export_animation_mode='NLA_TRACKS', export_yup=True, export_skins=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='mode', required=True)
    p = sub.add_parser('avatar')
    p.add_argument('folder')
    p.add_argument('out')
    p.add_argument('--uniform', choices=sorted(UNIFORMS), default='workwear')
    p.add_argument('--vest', choices=['lime', 'orange', 'delta', 'none'], default='lime')
    p.add_argument('--headwear', choices=['cap', 'beanie', 'none'], default='cap')
    p.add_argument('--ears', choices=['muffs', 'headset'], default='muffs')
    p.add_argument('--max-texture', type=int, default=1024)
    p.add_argument('--preview')
    q = sub.add_parser('animations')
    q.add_argument('--rig', required=True, help="An avatar's FBX, whose skeleton the clips go on")
    q.add_argument('out')
    q.add_argument('clips', nargs='+')
    a = parser.parse_args(argv)
    avatar(a) if a.mode == 'avatar' else animations(a)


main()
