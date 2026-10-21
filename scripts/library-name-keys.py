#!/usr/bin/env python3
"""Name keys for every card name of the card library: the ASCII identity the kernel's same-name rule and evolution use.

    python3 scripts/library-name-keys.py   → catalog/zh-CN/V20261019/library/name-keys.json

A name already in the reviewed pool keeps its key (皮卡丘ex → pikachu-ex); the others get their pinyin
(阿罗拉 六尾V → a-luo-la-liu-wei-v). Names are compared without spaces (the sources write 「船长 皮卡丘」 and
「船长皮卡丘」): the file maps the spaceless name to {key, name}, the name being the spelling most cards use. The
kernel needs one key per name and one name per key, so two names with the same pinyin get -2, -3, … in name order.
Existing keys never change: the file is read first and only new names are added. Needs pypinyin.
"""
import collections, json, os, re, subprocess, unicodedata
from pypinyin import lazy_pinyin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'catalog', 'zh-CN', 'V20261019', 'library', 'name-keys.json')
INDEX = os.path.join(ROOT, '.data', 'card-library', 'index.json')


def bare(name):
    return re.sub(r'\s+', '', name)


def slug(name):
    name = unicodedata.normalize('NFKC', name).replace('◇', '-prism-star').replace('&', '-and-').replace('δ', '-delta')
    return re.sub(r'[^a-z0-9]+', '-', '-'.join(lazy_pinyin(name)).lower()).strip('-') or 'card'


def reviewed_keys():
    js = "import('./catalog/zh-CN/V20261019/index.mjs').then((p) => console.log(JSON.stringify(Object.fromEntries(p.DEFINITIONS.map((d) => [d.name, d.nameKey])))))"
    return json.loads(subprocess.run(['node', '-e', js], cwd=ROOT, capture_output=True, text=True, check=True).stdout)


def main():
    keys = json.load(open(OUT, encoding='utf8')) if os.path.exists(OUT) else {}
    for name, key in reviewed_keys().items():
        keys.setdefault(bare(name), {'key': key, 'name': name})
    index = json.load(open(INDEX, encoding='utf8'))
    spellings = collections.defaultdict(collections.Counter)
    for e in index['entries']:
        if e.get('duplicateOf'): continue
        spellings[bare(e['name'])][e['name']] += 1
        if e.get('evolvesFrom'): spellings[bare(e['evolvesFrom'])][e['evolvesFrom']] += 0
    taken = {v['key'] for v in keys.values()}
    added = 0
    for b in sorted(b for b in spellings if b and b not in keys):
        name = max(spellings[b].items(), key=lambda kv: (kv[1], ' ' in kv[0]))[0]
        base = key = slug(name); i = 1
        while key in taken:
            i += 1; key = f'{base}-{i}'
        keys[b] = {'key': key, 'name': name}; taken.add(key); added += 1
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf8') as f:
        f.write('{\n' + ',\n'.join(f'{json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}' for k, v in sorted(keys.items())) + '\n}')
        f.write('\n')
    print(f'{len(keys)} name keys ({added} new) → {os.path.relpath(OUT, ROOT)}')


if __name__ == '__main__':
    main()
