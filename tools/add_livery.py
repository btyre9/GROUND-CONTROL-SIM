"""Registers aircraft models and liveries in 3d-aircraft/aircraft.json, which the sim reads at start.

    python3 add_livery.py model 3d-aircraft B739 models/B739.glb --sizes C --types B739
    python3 add_livery.py livery 3d-aircraft B739 DAL N814DN "path/to/(9ENG) Delta N814DN"

A model is a .glb made by xplane_obj_to_glb.py; --sizes are the gate size classes it may park at.
A livery is a folder from a livery pack: every texture in it that the model uses (matched by path under
objects/, ignoring case and extension) is shrunk and saved under 3d-aircraft/liveries/, so the sim can
paint the model per airline at run time. Normal maps, lit maps and cockpit or cabin art are skipped.
"""
import argparse
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xplane_obj_to_glb import encode_image  # noqa: E402


def load_manifest(root):
    path = os.path.join(root, 'aircraft.json')
    if os.path.exists(path):
        with open(path) as f:
            return path, json.load(f)
    return path, {'models': {}, 'liveries': []}


def save_manifest(path, manifest):
    with open(path, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')


def glb_materials(path):
    """(name, is transparent) for each material in a .glb."""
    with open(path, 'rb') as f:
        f.read(12)
        length, _ = struct.unpack('<II', f.read(8))
        gltf = json.loads(f.read(length))
    return [(m.get('name', ''), m.get('alphaMode') == 'BLEND') for m in gltf.get('materials', [])]


def livery_textures(folder):
    """Texture files in a livery folder by lower-case path under objects/ without extension."""
    found = {}
    for base, _, files in os.walk(folder):
        for name in files:
            stem, ext = os.path.splitext(name)
            if ext.lower() not in ('.png', '.dds') or name.startswith('._'):
                continue
            if any(skip in stem.lower() for skip in ('_nml', '_lit', 'cockpit', 'cabin')):
                continue
            rel = os.path.relpath(os.path.join(base, stem), folder).replace(os.sep, '/')
            parts = rel.split('/')
            lowered = [p.lower() for p in parts]
            if 'objects' in lowered:
                rel = '/'.join(parts[lowered.index('objects') + 1:])
            found[rel.lower()] = os.path.join(base, name)
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    m = sub.add_parser('model')
    m.add_argument('root'); m.add_argument('id'); m.add_argument('file')
    m.add_argument('--sizes', default='C'); m.add_argument('--types', default='')
    lv = sub.add_parser('livery')
    lv.add_argument('root'); lv.add_argument('model'); lv.add_argument('airline'); lv.add_argument('name'); lv.add_argument('folder')
    lv.add_argument('--max-texture', type=int, default=2048)
    args = parser.parse_args()

    path, manifest = load_manifest(args.root)
    if args.command == 'model':
        manifest['models'][args.id] = {'file': args.file, 'sizeClasses': args.sizes.split(','),
                                       'types': [t for t in args.types.split(',') if t]}
        save_manifest(path, manifest)
        print(f'model {args.id}: {args.file}')
        return

    model = manifest['models'].get(args.model)
    if not model:
        sys.exit(f'Register model {args.model} first.')
    available = livery_textures(args.folder)
    out_rel = f'liveries/{args.model}-{args.airline}-{args.name}'
    out_dir = os.path.join(args.root, out_rel)
    os.makedirs(out_dir, exist_ok=True)
    textures = {}
    for key, transparent in glb_materials(os.path.join(args.root, model['file'])):
        source = available.get(key.lower())
        if not source:
            continue
        data, mime = encode_image(source, args.max_texture, not transparent)
        file = key.replace('/', '__') + ('.jpg' if mime == 'image/jpeg' else '.png')
        with open(os.path.join(out_dir, file), 'wb') as f:
            f.write(data)
        textures[key] = f'{out_rel}/{file}'
    manifest['liveries'] = [l for l in manifest['liveries'] if l['folder'] != out_rel]
    manifest['liveries'].append({'model': args.model, 'airline': args.airline.upper(), 'name': args.name,
                                 'folder': out_rel, 'textures': textures})
    save_manifest(path, manifest)
    size = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir))
    print(f'livery {args.model} {args.airline} {args.name}: {len(textures)} textures, {size // 1024} KB ({", ".join(textures)})')


if __name__ == '__main__':
    main()
