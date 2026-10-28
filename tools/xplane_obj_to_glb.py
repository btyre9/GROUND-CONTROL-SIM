"""Converts an X-Plane aircraft's exterior OBJ8 models into one glTF binary (.glb) for the tower view.

X-Plane builds many parts in their own local space and moves them into place with animation commands
(translate, rotate, show/hide) driven by datarefs. This bakes one static pose: landing gear down, doors
closed, control surfaces neutral. The result keeps X-Plane's axes (x right, y up, nose toward -z), in
meters, with the origin moved to the ground between the main gear, which is where the sim pivots.

Only the objects you list are kept, so the cockpit and cabin interior are left out. Each material is
named after its texture's path under objects/ (without extension), which is how liveries find what to
replace. The aircraft's lights (beacons, strobes, nav, landing, logo) go into the file's extras with
their positions, and cabin window glass gets a random number per window so the sim can light some.

Usage:
    python3 xplane_obj_to_glb.py AIRCRAFT_FOLDER OUT.glb --objects a.obj,b.obj [--acf NAME.acf]
        [--windows cabin/glass_exterior.obj] [--set dataref=value ...] [--livery FOLDER]
        [--paint TEXTURE] [--max-texture 2048]

--set poses the model: any dataref whose name contains the given text takes that value (gear is down
by default). --livery uses a livery folder's textures in place of the aircraft's own. Textures larger
than --max-texture are shrunk; opaque ones are stored as JPEG.
"""
import argparse
import json
import math
import os
import random
import struct
import subprocess
import sys
import tempfile

# Datarefs whose value is not 0 in the baked pose (matched by substring). --set adds more.
# Gear down: older aircraft use acf_gear_deploy, newer ones gear/deploy_ratio.
POSE = {'gear_deploy': 1.0, 'gear/deploy_ratio': 1.0}

LIGHT_TYPES = ('beacon', 'strobe', 'nav', 'landing', 'taxi', 'logo', 'generic')


def dataref_value(name):
    for key, value in POSE.items():
        if key in name:
            return value
    return 0.0


def lerp_keys(keys, value):
    """Interpolates (value, output) keyframes, clamping at the ends."""
    if value <= keys[0][0]:
        return keys[0][1]
    for (v1, a), (v2, b) in zip(keys, keys[1:]):
        if value <= v2:
            f = 0 if v2 == v1 else (value - v1) / (v2 - v1)
            return [x + (y - x) * f for x, y in zip(a, b)] if isinstance(a, list) else a + (b - a) * f
    return keys[-1][1]


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def translation(x, y, z):
    return [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]]


def rotation(axis, degrees):
    x, y, z = axis
    n = math.sqrt(x * x + y * y + z * z) or 1
    x, y, z = x / n, y / n, z / n
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    t = 1 - c
    return [[t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0],
            [t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0],
            [t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0],
            [0, 0, 0, 1]]


IDENTITY = translation(0, 0, 0)


def transform(m, x, y, z):
    return [m[r][0] * x + m[r][1] * y + m[r][2] * z + m[r][3] for r in range(3)]


def light_type(name, rgb):
    """Which kind of aircraft light a named X-Plane light is, and its color."""
    name = name.lower()
    kind = next((k for k in LIGHT_TYPES if k in name), None)
    if not kind or 'spill' in name:
        return None, None
    if rgb is None:
        rgb = {'beacon': [1, 0, 0], 'strobe': [1, 1, 1]}.get(kind, [1, 0.95, 0.85])
        if kind == 'nav':
            rgb = [1, 0, 0] if 'left' in name else [0, 1, 0.3] if 'right' in name else [1, 1, 1]
    return kind, [round(c, 3) for c in rgb]


def read_obj(path):
    """Reads one OBJ8 in the baked pose: its textures, attributes, triangles and lights."""
    vertices, indices, commands = [], [], []
    info = {'texture': None, 'lit': None, 'blend': False}
    with open(path, encoding='latin-1') as f:
        for line in f:
            t = line.split()
            if not t:
                continue
            if t[0] == 'VT':
                vertices.append([float(v) for v in t[1:9]])
            elif t[0] in ('IDX10', 'IDX'):
                indices.extend(int(v) for v in t[1:])
            elif t[0] == 'TEXTURE' and len(t) > 1:
                info['texture'] = t[1]
            elif t[0] == 'TEXTURE_LIT' and len(t) > 1:
                info['lit'] = t[1]
            elif t[0] == 'BLEND_GLASS':
                info['blend'] = True
            elif t[0].startswith('ANIM') or t[0] in ('TRIS', 'LIGHT_PARAM', 'LIGHT_NAMED', 'LIGHT_CUSTOM'):
                commands.append(t)

    # Walk the animation tree: each ANIM_begin starts from its parent's matrix and visibility.
    stack = [(IDENTITY, True)]
    matrix, visible = IDENTITY, True
    key_block = None
    out_pos, out_nrm, out_uv, out_idx, lights = [], [], [], [], []
    for t in commands:
        op = t[0]
        if op == 'ANIM_begin':
            stack.append((matrix, visible))
        elif op == 'ANIM_end':
            matrix, visible = stack.pop()
        elif op == 'ANIM_trans':
            a, b = [float(v) for v in t[1:4]], [float(v) for v in t[4:7]]
            v1, v2 = float(t[7]), float(t[8])
            value = dataref_value(t[9]) if len(t) > 9 else 0
            offset = lerp_keys([(v1, a), (v2, b)], value) if v2 != v1 else a
            matrix = mat_mul(matrix, translation(*offset))
        elif op == 'ANIM_rotate':
            axis = [float(v) for v in t[1:4]]
            r1, r2, v1, v2 = (float(v) for v in t[4:8])
            value = dataref_value(t[8]) if len(t) > 8 else 0
            angle = lerp_keys([(v1, r1), (v2, r2)], value) if v2 != v1 else r1
            matrix = mat_mul(matrix, rotation(axis, angle))
        elif op in ('ANIM_trans_begin', 'ANIM_rotate_begin'):
            key_block = {'axis': [float(v) for v in t[1:4]] if op == 'ANIM_rotate_begin' else None,
                         'ref': t[-1], 'keys': []}
        elif op == 'ANIM_trans_key':
            key_block['keys'].append((float(t[1]), [float(v) for v in t[2:5]]))
        elif op == 'ANIM_rotate_key':
            key_block['keys'].append((float(t[1]), float(t[2])))
        elif op in ('ANIM_trans_end', 'ANIM_rotate_end'):
            value = lerp_keys(sorted(key_block['keys']), dataref_value(key_block['ref']))
            step = translation(*value) if op == 'ANIM_trans_end' else rotation(key_block['axis'], value)
            matrix = mat_mul(matrix, step)
            key_block = None
        elif op in ('ANIM_hide', 'ANIM_show'):
            v1, v2, value = float(t[1]), float(t[2]), dataref_value(t[3])
            if min(v1, v2) <= value <= max(v1, v2):
                visible = op == 'ANIM_show'
        elif op in ('LIGHT_PARAM', 'LIGHT_NAMED') and visible and len(t) >= 5:
            rgb = [float(v) for v in t[5:8]] if op == 'LIGHT_PARAM' and len(t) >= 8 and 'airplane_' in t[1] else None
            kind, color = light_type(t[1], rgb)
            if kind:
                lights.append({'type': kind, 'color': color, 'pos': transform(matrix, *(float(v) for v in t[2:5]))})
        elif op == 'TRIS' and visible:
            start, count = int(t[1]), int(t[2])
            remap = {}
            tri = indices[start:start + count]
            # X-Plane's front faces wind clockwise and glTF's counter-clockwise, so swap two corners.
            tri = [tri[k + j] for k in range(0, len(tri) - 2, 3) for j in (0, 2, 1)]
            for i in tri:
                if i not in remap:
                    x, y, z, nx, ny, nz, s, tt = vertices[i]
                    remap[i] = len(out_pos)
                    out_pos.append(transform(matrix, x, y, z))
                    n = [matrix[r][0] * nx + matrix[r][1] * ny + matrix[r][2] * nz for r in range(3)]
                    length = math.sqrt(sum(c * c for c in n)) or 1
                    out_nrm.append([c / length for c in n])
                    out_uv.append([s, 1 - tt])     # X-Plane textures start at the bottom.
                out_idx.append(remap[i])
    return info, (out_pos, out_nrm, out_uv, out_idx), lights


def window_values(positions, seed):
    """A random number per cabin window, shared by every vertex of that window: windows sit about
    51 cm apart along each side, so position along the fuselage and side pick the window."""
    rng = random.Random(seed)
    table = {}
    values = []
    for x, _, z in positions:
        key = (x > 0, round(z / 0.508))
        if key not in table:
            table[key] = rng.random()
        values.append(table[key])
    return values


def encode_image(path, max_size, jpeg):
    """Image bytes shrunk to max_size pixels on the long side, as JPEG (opaque) or PNG."""
    suffix = '.jpg' if jpeg else '.png'
    out = tempfile.NamedTemporaryFile(suffix=suffix, delete=False).name
    try:
        try:
            from PIL import Image
            with Image.open(path) as image:
                image.thumbnail((max_size, max_size))
                (image.convert('RGB') if jpeg else image).save(out, quality=82)
        except ImportError:
            fmt = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82'] if jpeg else ['-s', 'format', 'png']
            result = subprocess.run(['sips', *fmt, '-Z', str(max_size), path, '--out', out], capture_output=True)
            if result.returncode != 0:
                raise RuntimeError(result.stderr.decode(errors='replace'))
        with open(out, 'rb') as f:
            return f.read(), 'image/jpeg' if jpeg else 'image/png'
    finally:
        os.unlink(out)


def gear_positions(acf_path):
    """Nose and main gear (x, z) in meters from the .acf, where positions are in feet."""
    gear = {}
    with open(acf_path, encoding='latin-1') as f:
        for line in f:
            t = line.split()
            key = t[1].split('/') if len(t) == 3 and t[0] == 'P' else []
            if len(key) == 3 and key[0] == '_gear' and key[2] in ('_gear_x', '_gear_z'):
                gear.setdefault(int(key[1]), {})[key[2]] = float(t[2]) * 0.3048
    gear = [g for g in gear.values() if '_gear_x' in g and '_gear_z' in g]
    nose = [g for g in gear if abs(g['_gear_x']) < 0.5]
    mains = [g for g in gear if abs(g['_gear_x']) >= 0.5]
    if not mains:
        return None
    return {'main_z': sum(g['_gear_z'] for g in mains) / len(mains),
            'nose_z': nose[0]['_gear_z'] if nose else None}


def write_glb(path, parts, images, extras):
    """parts: dicts with positions, normals, uvs, indices, optional windows, and material settings."""
    blob = bytearray()
    views, accessors, primitives, materials, textures = [], [], [], [], []

    def add_view(data, target=None):
        while len(blob) % 4:
            blob.append(0)
        view = {'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)}
        if target:
            view['target'] = target
        blob.extend(data)
        views.append(view)
        return len(views) - 1

    gltf_images = [{'bufferView': add_view(data), 'mimeType': mime} for data, mime in images]
    textures = [{'source': i, 'sampler': 0} for i in range(len(images))]
    flat = lambda rows, n: struct.pack(f'<{len(rows) * n}f', *[c for r in rows for c in r])

    for part in parts:
        positions, idx = part['positions'], part['indices']
        if not idx:
            continue
        attributes = {}
        attributes['POSITION'] = len(accessors)
        accessors.append({'bufferView': add_view(flat(positions, 3), 34962), 'componentType': 5126, 'count': len(positions),
                          'type': 'VEC3', 'min': [min(p[i] for p in positions) for i in range(3)],
                          'max': [max(p[i] for p in positions) for i in range(3)]})
        attributes['NORMAL'] = len(accessors)
        accessors.append({'bufferView': add_view(flat(part['normals'], 3), 34962), 'componentType': 5126, 'count': len(positions), 'type': 'VEC3'})
        attributes['TEXCOORD_0'] = len(accessors)
        accessors.append({'bufferView': add_view(flat(part['uvs'], 2), 34962), 'componentType': 5126, 'count': len(positions), 'type': 'VEC2'})
        if part.get('windows'):
            attributes['_WINDOW'] = len(accessors)
            accessors.append({'bufferView': add_view(struct.pack(f'<{len(positions)}f', *part['windows']), 34962),
                              'componentType': 5126, 'count': len(positions), 'type': 'SCALAR'})
        index_acc = len(accessors)
        accessors.append({'bufferView': add_view(struct.pack(f'<{len(idx)}I', *idx), 34963), 'componentType': 5125,
                          'count': len(idx), 'type': 'SCALAR'})
        material = {'name': part['key'] or 'untextured', 'doubleSided': True,
                    'pbrMetallicRoughness': {'metallicFactor': 0.15, 'roughnessFactor': 0.4},
                    'extras': {'windows': bool(part.get('windows'))}}
        if part['image'] is not None:
            material['pbrMetallicRoughness']['baseColorTexture'] = {'index': part['image']}
        if part['lit'] is not None:
            # Off by day; the sim turns it up at night.
            material['emissiveTexture'] = {'index': part['lit']}
            material['emissiveFactor'] = [0, 0, 0]
        if part['blend']:
            material['alphaMode'] = 'BLEND'
        materials.append(material)
        primitives.append({'attributes': attributes, 'indices': index_acc, 'material': len(materials) - 1})

    gltf = {
        'asset': {'version': '2.0', 'generator': 'OpenATC xplane_obj_to_glb.py', 'extras': extras},
        'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0, 'name': extras.get('name', 'aircraft')}],
        'meshes': [{'primitives': primitives}], 'materials': materials, 'textures': textures,
        'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}],
        'images': gltf_images, 'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}]
    }
    if not images:
        for key in ('textures', 'samplers', 'images'):
            del gltf[key]
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    while len(blob) % 4:
        blob.append(0)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
        f.write(struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))


def texture_key(texture_path, objects_dir):
    """The texture's path under objects/, without extension: e.g. '737_9ENG/737_9ENG_fuselage'."""
    return os.path.splitext(os.path.relpath(texture_path, objects_dir))[0].replace(os.sep, '/')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('folder', help='The aircraft folder (the one holding the .acf)')
    parser.add_argument('out', help='Output .glb path')
    parser.add_argument('--objects', default='fuselage.obj,wings_engines.obj,gear.obj',
                        help='Exterior objects in the objects/ folder, comma separated (skip cabin and cockpit)')
    parser.add_argument('--acf', help='Which .acf to read the gear from, when the folder has several')
    parser.add_argument('--windows', default='', help='Objects that are cabin window glass, comma separated')
    parser.add_argument('--set', action='append', default=[], metavar='DATAREF=VALUE', help='Pose a dataref')
    parser.add_argument('--paint', help='Livery texture to use instead of the default paint')
    parser.add_argument('--livery', help='Livery folder whose textures replace the aircraft\'s own')
    parser.add_argument('--max-texture', type=int, default=2048, help='Largest texture size in pixels')
    args = parser.parse_args()
    for item in args.set:
        name, value = item.split('=')
        POSE[name] = float(value)

    folder = os.path.abspath(args.folder)
    objects_dir = os.path.join(folder, 'objects')
    windows = set(filter(None, args.windows.split(',')))
    images, image_of, parts, lights = [], {}, [], []

    def find_texture(obj_path, name):
        path = os.path.normpath(os.path.join(os.path.dirname(obj_path), name))
        if args.paint and os.path.basename(path) == os.path.basename(args.paint):
            return os.path.abspath(args.paint)
        # Liveries and aircraft mix .png and .dds for the same texture, so try both.
        bases = [os.path.join(os.path.abspath(args.livery), os.path.relpath(path, folder))] if args.livery else []
        for base in bases + [path]:
            for candidate in (base, os.path.splitext(base)[0] + '.png', os.path.splitext(base)[0] + '.dds'):
                if os.path.exists(candidate):
                    return candidate
        return path

    def image_index(path, max_size, jpeg):
        if not os.path.exists(path):
            print(f'warning: texture {path} not found', file=sys.stderr)
            return None
        if (path, jpeg) not in image_of:
            image_of[(path, jpeg)] = len(images)
            images.append(encode_image(path, max_size, jpeg))
        return image_of[(path, jpeg)]

    for name in args.objects.split(','):
        obj_path = os.path.join(objects_dir, name)
        info, (positions, normals, uvs, idx), obj_lights = read_obj(obj_path)
        lights.extend(obj_lights)
        key, image, lit = None, None, None
        if info['texture']:
            texture_path = os.path.normpath(os.path.join(os.path.dirname(obj_path), info['texture']))
            key = texture_key(texture_path, objects_dir)
            image = image_index(find_texture(obj_path, info['texture']), args.max_texture, not info['blend'])
        if info['lit']:
            lit = image_index(find_texture(obj_path, info['lit']), args.max_texture // 2, True)
        part = {'positions': positions, 'normals': normals, 'uvs': uvs, 'indices': idx, 'key': key,
                'image': image, 'lit': lit, 'blend': info['blend'] or 'glass' in (key or '')}
        if name in windows:
            part['windows'] = window_values(positions, name)
        parts.append(part)
        print(f'{name}: {len(positions)} vertices, {len(idx) // 3} triangles, {len(obj_lights)} lights')

    # Move the origin to the ground between the main gear.
    acfs = [f for f in os.listdir(folder) if f.endswith('.acf')]
    acf = os.path.join(folder, args.acf) if args.acf else os.path.join(folder, acfs[0]) if acfs else None
    gear = gear_positions(acf) if acf else None
    ground = min(p[1] for part in parts for p in part['positions'])
    shift_z = gear['main_z'] if gear else 0
    for part in parts:
        for p in part['positions']:
            p[1] -= ground
            p[2] -= shift_z
    merged = []
    for light in lights:
        light['pos'] = [round(light['pos'][0], 2), round(light['pos'][1] - ground, 2), round(light['pos'][2] - shift_z, 2)]
        # X-Plane often stacks several sprites on one lamp; keep one per lamp.
        if not any(m['type'] == light['type'] and math.dist(m['pos'], light['pos']) < 0.6 for m in merged):
            merged.append(light)
    extras = {'name': os.path.splitext(os.path.basename(args.out))[0], 'lights': merged}
    if gear and gear['nose_z'] is not None:
        extras['wheelbaseM'] = round(gear['main_z'] - gear['nose_z'], 2)
    all_pos = [p for part in parts for p in part['positions']]
    extras['lengthM'] = round(max(p[2] for p in all_pos) - min(p[2] for p in all_pos), 2)
    extras['spanM'] = round(max(p[0] for p in all_pos) - min(p[0] for p in all_pos), 2)
    write_glb(args.out, parts, images, extras)
    counts = {k: sum(1 for l in merged if l['type'] == k) for k in LIGHT_TYPES}
    print(f'wrote {args.out}: {os.path.getsize(args.out) // 1024} KB, wheelbase {extras.get("wheelbaseM")} m, '
          f'length {extras["lengthM"]} m, span {extras["spanM"]} m, lights {counts}')


if __name__ == '__main__':
    main()
