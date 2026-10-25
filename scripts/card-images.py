#!/usr/bin/env python3
"""Image work for the card library index (scripts/build-card-library.mjs runs this). Needs Pillow (with WebP).

    python3 scripts/card-images.py compare      stdin: JSON [[image A, image B], ...]
                                                stdout: JSON [distance or null, ...]
    python3 scripts/card-images.py thumbs <out> reads <out>/index.json, writes <out>/thumbs/<sha256[:16]>.webp

compare: how different two card images look, as the mean absolute RGB difference (0-255) of both drawn on white at
48x67. Two sources' images of the same card face measure under ~5 (holo renderings that differ more count as
different); a 精灵球/大师球 mirror foil of the same number measures 7 or more, another card far more.

thumbs: small WebP thumbnails for the 卡牌库 grid, named by the image's SHA-256, so a changed image gets a new one;
existing files are kept. The site falls back to the full image when a thumbnail is missing.
"""
import json, os, sys
from multiprocessing import Pool

WIDTH = 300
PROBE = (48, 67)


def probe(path):
    from PIL import Image
    with Image.open(path) as im:
        im = im.convert('RGBA')
        flat = Image.new('RGBA', im.size, (255, 255, 255, 255))
        flat.alpha_composite(im)
        return flat.convert('RGB').resize(PROBE, Image.LANCZOS)


def distance(pair):
    from PIL import ImageChops, ImageStat
    try:
        a, b = (probe(p) for p in pair)
        return round(sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3, 2)
    except Exception:  # an unreadable image is never the same face
        return None


def compare():
    pairs = json.load(sys.stdin)
    with Pool() as pool:
        json.dump(pool.map(distance, pairs, chunksize=8), sys.stdout)


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


def thumbs(out):
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
    if sys.argv[1:2] == ['compare']:
        compare()
    elif sys.argv[1:2] == ['thumbs'] and len(sys.argv) == 3:
        thumbs(sys.argv[2])
    else:
        sys.exit(__doc__)
