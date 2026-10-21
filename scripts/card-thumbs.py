#!/usr/bin/env python3
"""Small WebP thumbnails of the card library's images, for the 卡牌库 grid (scripts/build-card-library.mjs runs this).

    python3 scripts/card-thumbs.py <out>     reads <out>/index.json, writes <out>/thumbs/<sha256[:16]>.webp

Thumbnails are named by the image's SHA-256, so a changed image gets a new one; existing files are kept.
Needs Pillow (with WebP). The site falls back to the full image when a thumbnail is missing.
"""
import json, os, sys
from multiprocessing import Pool

WIDTH = 300


def make(job):
    src, dst = job
    from PIL import Image
    try:
        with Image.open(src) as im:
            im.thumbnail((WIDTH, WIDTH * 2))
            im.save(dst + '.tmp', 'WEBP', quality=80, method=4)
        os.replace(dst + '.tmp', dst)
        return None
    except Exception as error:  # a broken image only loses its thumbnail
        return f'{src}: {error}'


def main(out):
    index = json.load(open(os.path.join(out, 'index.json'), encoding='utf8'))
    thumbs = os.path.join(out, 'thumbs')
    os.makedirs(thumbs, exist_ok=True)
    base = os.path.join(index['library'], index['language'])
    jobs = {}
    for e in index['entries']:
        img = e.get('image')
        if not img:
            continue
        dst = os.path.join(thumbs, img['sha256'][:16] + '.webp')
        if dst not in jobs and not os.path.exists(dst):
            jobs[dst] = (os.path.join(base, img.get('dir') or e['dir'], img['file']), dst)
    errors = []
    if jobs:
        with Pool() as pool:
            errors = [x for x in pool.imap_unordered(make, jobs.values(), chunksize=32) if x]
    print(f'Thumbnails: {len(jobs) - len(errors)} new, {len(errors)} failed, in {thumbs}')
    for e in errors[:20]:
        print('  ' + e, file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1])
