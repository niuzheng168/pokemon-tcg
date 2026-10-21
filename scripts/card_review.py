#!/usr/bin/env python3
"""Card-face review of the whole local card library (library_v1, Simplified Chinese) with Foundry vision models.

Every unique card with an image is read independently by two models (different Foundry resources), as a whole card and
as enlarged crops of the small print (mark, number, weakness / resistance / retreat). `compare` then decides field by
field against the library's two text sources (MIK and 52Poké): fields where the image readings and the sources agree are
accepted; the rest are listed for review. The 83 hand-reviewed printings (bound to the CN/V20261019 release) are the
gold set the decision rules are checked on.

    python3 scripts/card_review.py read  --model astra|sol [--part full|small] [--workers 24] [--limit N] [--gold]
    python3 scripts/card_review.py compare [--gold]
    python3 scripts/card_review.py status

Inputs: .data/card-library/index.json (node scripts/build-card-library.mjs), the library images and, for --gold,
.data/card-review/gold.json (node scripts/card-review-gold.mjs). Outputs (not in git):
.data/card-review/reads/<model>-<part>/<image sha256[:16]>.json, keyed by the image, so a rerun only reads new images.
Keys come from Foundry .env files outside the repository (FOUNDRY_ASTRA_ENV / FOUNDRY_SOL_ENV), never from git.
"""
import argparse, base64, io, json, os, sys, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, '.data')
INDEX = os.path.join(DATA, 'card-library', 'index.json')
OUT = os.path.join(DATA, 'card-review')
MODELS = {
    'astra': (os.environ.get('FOUNDRY_ASTRA_ENV', '/home/largeniu/g/pokemon/pokemon-tcg/.env.foundry2'), 'gpt-6-astra'),
    'sol': (os.environ.get('FOUNDRY_SOL_ENV', '/home/largeniu/g/pokemon/pokemon-tcg/.env.foundry'), 'gpt-6.1-sol-global-standard'),
}
PROMPT_VERSION = 'v1'

FULL_PROMPT = '''这是一张简体中文宝可梦集换式卡牌（PTCG）的卡图。请逐字转录卡面文字。
要求：
- 照卡面原文抄写，不要改写、润色或按常见说法补全；看不清的字用□代替，并在 uncertain 里写明是哪个字段。
- 效果文字中的能量符号写成【属性】，属性用单字：草 火 水 雷 超 斗 恶 钢 龙 妖 无。
- 招式费用 cost 是能量符号列表，每个元素是上面的单字；不需要能量的招式写空列表。
- 只输出一个 JSON 对象，字段如下（不适用的写 null 或空数组）：
{"name":卡名,"hp":数字,"type":属性单字,"stage":卡面阶段文字如"基础"/"1阶进化"/"2阶进化"/"VMAX"/"VSTAR","evolves_from":进化来源卡名,
 "abilities":[{"name":特性名,"text":效果}],
 "attacks":[{"name":招式名,"cost":[...],"damage":伤害数字及符号如"60"或"30+"或"20×"，没有则"","text":效果}],
 "weakness":{"type":单字,"value":如"×2"}或null,"resistance":{"type":单字,"value":如"-30"}或null,"retreat":撤退所需能量个数（没有画能量图标就是0）,
 "card_text":训练家卡或特殊能量的效果文字（多段用换行分隔）,"rule_text":规则框文字（如ex规则、ACE SPEC规则、太晶规则、VSTAR规则）,
 "number":卡号如"094/207","mark":规则标记字母,"uncertain":[...]}'''

SMALL_PROMPT = '''这两张图是同一张简体中文宝可梦卡牌的局部放大图：第一张是卡牌底部左侧，第二张是卡牌下部整行（宝可梦卡的弱点、抗性、撤退栏在这里）。
请只读下面这些小字，照卡面抄写，看不清就写 null 并在 uncertain 里说明：
- mark：规则标记，是印在小方框里的单个大写字母（如 D E F G H I J）；卡面没有就写 null。
- number：卡号，如 "094/207"。
- weakness：{"type":属性单字,"value":如"×2"} 或 null；resistance：{"type":属性单字,"value":如"-30"} 或 null。
- retreat：撤退栏里画了几个能量图标（数字；栏里没有图标就是 0；不是宝可梦卡写 null）。
属性单字：草 火 水 雷 超 斗 恶 钢 龙 妖 无。
只输出 JSON：{"mark":...,"number":...,"weakness":...,"resistance":...,"retreat":...,"uncertain":[...]}'''


def env(path):
    return dict(l.strip().split('=', 1) for l in open(path, encoding='utf8') if '=' in l and not l.lstrip().startswith('#'))


def data_url(im):
    buf = io.BytesIO()
    im.convert('RGB').save(buf, 'JPEG', quality=92)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def views(path, part):
    from PIL import Image
    im = Image.open(path).convert('RGBA')
    bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
    im = Image.alpha_composite(bg, im)
    w, h = im.size
    up = lambda x, s: x.resize((round(x.width * s), round(x.height * s)), Image.LANCZOS)
    if part == 'full':
        return [up(im, 2 if w < 600 else 1)]
    s = 4 if w < 600 else 1.5
    return [up(im.crop((0, round(h * 0.86), round(w * 0.6), h)), s), up(im.crop((0, round(h * 0.72), w, round(h * 0.95))), s * 0.75)]


def call(model, path, part, tries=6):
    env_path, deployment = MODELS[model]
    e = env(env_path)
    content = [{'type': 'text', 'text': FULL_PROMPT if part == 'full' else SMALL_PROMPT}]
    content += [{'type': 'image_url', 'image_url': {'url': data_url(v), 'detail': 'high'}} for v in views(path, part)]
    body = json.dumps({'model': deployment, 'messages': [{'role': 'user', 'content': content}],
                       'max_completion_tokens': 8000, 'response_format': {'type': 'json_object'}}).encode()
    url = e['AOAI_ENDPOINT'].rstrip('/') + '/chat/completions'
    for i in range(tries):
        t = time.time()
        try:
            req = urllib.request.Request(url, body, {'api-key': e['FOUNDRY_KEY'], 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=600) as r:
                data = json.load(r)
            return {'reading': json.loads(data['choices'][0]['message']['content']), 'deployment': deployment, 'prompt': PROMPT_VERSION,
                    'usage': {k: data.get('usage', {}).get(k) for k in ('prompt_tokens', 'completion_tokens')}, 'sec': round(time.time() - t, 1)}
        except urllib.error.HTTPError as err:
            msg = err.read().decode(errors='replace')[:300]
            if err.code in (408, 429, 500, 502, 503, 504) and i < tries - 1:
                time.sleep(min(60, 5 * 2 ** i)); continue
            return {'error': f'HTTP {err.code}: {msg}'}
        except Exception as err:  # network hiccup or a non-JSON answer
            if i < tries - 1:
                time.sleep(5 * (i + 1)); continue
            return {'error': repr(err)[:300]}


def cards(gold=False):
    index = json.load(open(INDEX, encoding='utf8'))
    base = os.path.join(index['library'], index['language'])
    out = []
    for e in index['entries']:
        if e.get('duplicateOf') or not e.get('image') or (gold and not e.get('printingId')):
            continue
        out.append({**e, 'path': os.path.join(base, e['dir'], e['image']['file'])})
    return out


def read_path(model, part, e):
    return os.path.join(OUT, 'reads', f'{model}-{part}', e['image']['sha256'][:16] + '.json')


def cmd_read(a):
    todo = [e for e in cards(a.gold) if not os.path.exists(read_path(a.model, a.part, e))]
    seen, unique = set(), []
    for e in todo:  # one read per image
        if e['image']['sha256'] not in seen:
            seen.add(e['image']['sha256']); unique.append(e)
    if a.limit: unique = unique[:a.limit]
    os.makedirs(os.path.join(OUT, 'reads', f'{a.model}-{a.part}'), exist_ok=True)
    lock, done, failed, started = threading.Lock(), [0], [0], time.time()
    print(f'{a.model}-{a.part}: {len(unique)} images to read with {a.workers} workers', flush=True)

    def one(e):
        r = call(a.model, e['path'], a.part)
        r['card'] = {'id': e['id'], 'dir': e['dir'], 'image': e['image']['sha256']}
        if 'reading' in r:
            path = read_path(a.model, a.part, e)
            with open(path + '.tmp', 'w', encoding='utf8') as f: json.dump(r, f, ensure_ascii=False)
            os.replace(path + '.tmp', path)
        with lock:
            done[0] += 1
            if 'error' in r:
                failed[0] += 1
                with open(os.path.join(OUT, f'errors-{a.model}-{a.part}.jsonl'), 'a', encoding='utf8') as f: f.write(json.dumps(r, ensure_ascii=False) + '\n')
            if done[0] % 100 == 0 or done[0] == len(unique):
                rate = done[0] / max(time.time() - started, 1) * 60
                print(f'  {done[0]}/{len(unique)} ({failed[0]} failed), {rate:.0f}/min, eta {(len(unique) - done[0]) / max(rate, 0.1):.0f} min', flush=True)

    with ThreadPoolExecutor(a.workers) as pool:
        for f in as_completed([pool.submit(one, e) for e in unique]): f.result()


# ---------------- compare: decide every field from the sources and the readings ----------------
MIK = os.environ.get('MIK_ARCHIVE', '/nas/share/Pokemon/archives/pokemon-cards-mik-20261019/mik-full-20261019/cards')
TYPE = {'草': '草', '火': '火', '水': '水', '雷': '雷', '电': '雷', '超': '超', '斗': '斗', '闘': '斗', '恶': '恶', '悪': '恶', '钢': '钢',
        '龙': '龙', '妖': '妖', '妖精': '妖', '无': '无', '无色': '无', '一般': '无',
        'G': '草', 'R': '火', 'W': '水', 'L': '雷', 'P': '超', 'F': '斗', 'D': '恶', 'M': '钢', 'N': '龙', 'Y': '妖', 'C': '无'}
STAGE = {'基础': 'basic', 'basic': 'basic', 'Basic': 'basic', '1阶进化': 'stage1', 'Stage 1': 'stage1', 'Stage1': 'stage1', 'stage1': 'stage1',
         '2阶进化': 'stage2', 'Stage 2': 'stage2', 'Stage2': 'stage2', 'stage2': 'stage2', 'VMAX': 'vmax', 'VSTAR': 'vstar',
         'V-UNION': 'v-union', 'BREAK': 'break', 'BREAK Evolution': 'break', '升级': 'levelup', 'Level Up': 'levelup',
         'M进化': 'mega', 'Mega Evolution': 'mega', '传说': 'legend', 'Legend': 'legend'}
# Fields decided by the text sources (MIK, else the library) checked against the image; the rest by the two
# structured sources (library ≈ 52Poké, MIK) checked against the image.
TEXT_RULE = os.environ.get('CARD_REVIEW_TEXT_RULE', 'either')


def norm_text(s):
    import re, unicodedata
    s = unicodedata.normalize('NFKC', str(s or ''))
    s = re.sub(r'[\[［（(][^\]］）)]*只能使用1次[^\]］）)]*[\]］）)]', '', s)  # GX / VSTAR reminder text
    return ''.join(c for c in s if not c.isspace() and not unicodedata.category(c).startswith(('P', 'S')) or c in '×+-□')


def norm_type(t):
    return TYPE.get(str(t).strip('【】'), str(t)) if t not in (None, '') else None


def norm_damage(d):
    import unicodedata
    return unicodedata.normalize('NFKC', str(d or '')).replace('x', '×').replace('X', '×').replace('点', '').strip()


def norm_wr(x):
    if not x or not isinstance(x, dict) or not x.get('type') and not x.get('energy'): return None
    import unicodedata
    v = unicodedata.normalize('NFKC', str(x.get('value') or '')).replace('x', '×').replace('X', '×').replace(' ', '')
    return f"{norm_type(x.get('type') or x.get('energy'))}{v}"


def norm_retreat(r):
    try: return int(r or 0)
    except (TypeError, ValueError): return None


def norm_mark(m):
    m = str(m or '').strip().upper()
    return m if len(m) == 1 and m.isalpha() else None


def card_values(src):
    """One source or reading → {field: comparable value} (pokemon fields, trainer text, mark)."""
    v = {'name': norm_text(src.get('name')), 'mark': norm_mark(src.get('mark')), 'card_text': norm_text(src.get('card_text'))}
    if src.get('kind', 'pokemon') == 'pokemon' or src.get('hp') is not None:
        v.update({'hp': str(src.get('hp') or ''), 'type': norm_type(src.get('type')), 'stage': STAGE.get(str(src.get('stage')), src.get('stage')),
                  'evolves_from': norm_text(src.get('evolves_from')), 'weakness': norm_wr(src.get('weakness')),
                  'resistance': norm_wr(src.get('resistance')), 'retreat': norm_retreat(src.get('retreat'))})
        ab, at = src.get('abilities') or [], src.get('attacks') or []
        v['ability.count'], v['attack.count'] = len(ab), len(at)
        for i, a in enumerate(ab):
            v[f'ability.{i}.name'], v[f'ability.{i}.text'] = norm_text(a.get('name')), norm_text(a.get('text'))
        for i, a in enumerate(at):
            cost = a.get('cost') or []
            if isinstance(cost, str): cost = [c for c in cost if c != '0']
            v[f'attack.{i}.name'], v[f'attack.{i}.text'] = norm_text(a.get('name')), norm_text(a.get('text'))
            v[f'attack.{i}.cost'] = ''.join(filter(None, (norm_type(c) for c in cost)))
            v[f'attack.{i}.damage'] = norm_damage(a.get('damage'))
    return v


def library_source(e, base):
    m = json.load(open(os.path.join(base, e['dir'], 'metadata.merged.json'), encoding='utf8'))
    c, p = m['card'], m['printing']
    text = c.get('text')
    src = {'kind': c['kind'], 'name': c['name'], 'mark': p.get('regulationMark'), 'card_text': '\n'.join(text) if isinstance(text, list) else (text or ''),
           'hp': c.get('hp'), 'type': c.get('type'), 'stage': c.get('stage'), 'evolves_from': c.get('evolvesFrom'), 'weakness': c.get('weakness'),
           'resistance': c.get('resistance'), 'retreat': c.get('retreat'), 'abilities': c.get('abilities') or [], 'attacks': c.get('attacks') or []}
    mik = next((s['id'] for s in m.get('sources') or [] if s['kind'] == 'mik'), None)
    return src, mik


def mik_source(mik_id):
    f = os.path.join(MIK, mik_id or '-', 'metadata.json')
    if not mik_id or not os.path.exists(f): return None
    k = json.load(open(f, encoding='utf8'))
    kind = {'Pokemon': 'pokemon'}.get(k.get('cardType'), 'energy' if 'Energy' in str(k.get('cardType')) else 'trainer')
    src = {'kind': kind, 'name': k.get('name'), 'mark': k.get('regulationMark')}
    pa = k.get('pokemonAttr') or {}
    if kind == 'pokemon':
        src.update({'hp': pa.get('hp'), 'type': pa.get('energyType'), 'stage': pa.get('stage'), 'evolves_from': pa.get('evolvesFrom') or None,
                    'weakness': pa.get('weakness'), 'resistance': pa.get('resistance'), 'retreat': pa.get('retreatCost'),
                    'abilities': pa.get('ability') or [], 'attacks': pa.get('attack') or []})
    else:
        src['card_text'] = (k.get('description') or '').strip()
    return src


def load_read(model, part, e):
    f = read_path(model, part, e)
    return json.load(open(f, encoding='utf8')).get('reading') if os.path.exists(f) else None


SMALL_FIELDS = ('mark', 'weakness', 'resistance', 'retreat')


def decide(e, base):
    """Field-by-field decision for one card: accepted value and the evidence, or a conflict for review."""
    lib, mik_id = library_source(e, base)
    mik = mik_source(mik_id)
    reads = {k: load_read(*k.split('-'), e) for k in ('astra-full', 'sol-full', 'astra-small', 'sol-small')}
    V = {'lib': card_values(lib), 'mik': card_values(mik) if mik else None}
    for k, r in reads.items():
        V[k] = card_values({**r, 'kind': lib['kind']}) if r else None
    fields = sorted({f for src in V.values() if src for f in src} - {'number'})
    if lib['kind'] != 'pokemon':
        fields = [f for f in fields if f in ('name', 'mark', 'card_text')]
    else:
        fields = [f for f in fields if f != 'card_text']
    out, conflicts = {}, []
    for f in fields:
        got = {k: (src.get(f) if src else None) for k, src in V.items()}
        full = [got['astra-full'], got['sol-full']]
        small = [got['astra-small'], got['sol-small']] if f in SMALL_FIELDS else []
        ref = got['mik'] if mik else got['lib']
        if f.split('.')[-1] in ('name', 'text') or f in ('name', 'evolves_from', 'card_text'):
            # Wording: MIK (else the library) must be confirmed by an image reading.
            hits = [k for k in ('astra-full', 'sol-full') if got[k] == ref or ref in ('', None) and got[k] in ('', None)]
            ok = bool(hits) if TEXT_RULE == 'either' else 'astra-full' in hits
            rule = 'text-confirmed-by-' + '+'.join(h.split('-')[0] for h in hits)
        elif f == 'mark':
            # Small print: both enlarged readings agree with each other and with a source.
            ok = ref is not None and small[0] == small[1] == ref or (got['lib'] == ref and small.count(ref) >= 1 and ref is not None)
            if not ok and ref is None and small[0] is not None and small[0] == small[1] and got['astra-full'] == small[0]:
                ref, ok = small[0], True  # no source has the mark: three image readings agree
            if not ok and all(x is None for x in [got['lib'], got['mik'], *small, got['astra-full']]):
                ref, ok = None, True  # nothing anywhere: the card has no mark (e.g. basic Energy)
            rule = 'mark'
        else:
            # Structure: the two sources agree and an image reading confirms.
            srcs = [got['lib']] + ([got['mik']] if mik else [])
            ok = len(set(map(json.dumps, srcs))) == 1 and (got['astra-full'] == ref or ref in small)
            rule = 'structure-sources-agree-and-image-confirms'
        if ok:
            out[f] = {'value': ref, 'rule': rule}
        else:
            conflicts.append({'field': f, **{k: v for k, v in got.items() if v is not None}})
    return {'id': e['id'], 'dir': e['dir'], 'printingId': e.get('printingId'), 'kind': lib['kind'], 'name': lib['name'], 'mik': mik_id,
            'reads': {k: bool(r) for k, r in reads.items()}, 'accepted': out, 'conflicts': conflicts}


def cmd_compare(a):
    index = json.load(open(INDEX, encoding='utf8'))
    base = os.path.join(index['library'], index['language'])
    todo = [e for e in cards(a.gold) if all(os.path.exists(read_path(*k.split('-'), e)) for k in ('astra-full', 'sol-full', 'astra-small', 'sol-small'))]
    with ThreadPoolExecutor(16) as pool:
        results = list(pool.map(lambda e: decide(e, base), todo))
    out = os.path.join(OUT, 'review-gold.jsonl' if a.gold else 'review.jsonl')
    with open(out, 'w', encoding='utf8') as f:
        for r in results: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    n_fields = sum(len(r['accepted']) + len(r['conflicts']) for r in results)
    n_conf = sum(len(r['conflicts']) for r in results)
    clean = sum(1 for r in results if not r['conflicts'])
    print(f'{len(results)} cards compared: {clean} with every field accepted; {n_fields} fields, {n_conf} in conflict ({n_conf / max(n_fields, 1):.1%}) → {out}')
    if a.gold: gold_check(results)


def gold_check(results):
    gold = json.load(open(os.path.join(OUT, 'gold.json'), encoding='utf8'))
    wrong, checked, conflicts = [], 0, 0
    for r in results:
        g = gold.get(r['printingId'])
        if not g: continue
        truth = card_values(g)
        for f, d in r['accepted'].items():
            if f == 'mark' and g['mark'] is None: continue
            if f in truth:
                checked += 1
                if truth[f] != d['value']: wrong.append(f"{r['printingId']} {f}: accepted {d['value']!r}, truth {truth[f]!r} ({d['rule']})")
        conflicts += len(r['conflicts'])
    print(f'gold: {checked} accepted fields checked against the hand review, {len(wrong)} wrong; {conflicts} fields left for review')
    for w in wrong: print('  WRONG', w)


def cmd_status(a):
    all_cards = cards()
    images = {e['image']['sha256'][:16] for e in all_cards}
    print(f'{len(all_cards)} unique cards with images, {len(images)} distinct images')
    d = os.path.join(OUT, 'reads')
    for label in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        n = sum(1 for f in os.listdir(os.path.join(d, label)) if f.endswith('.json') and f[:-5] in images)
        print(f'  {label}: {n}/{len(images)}')


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('read'); r.add_argument('--model', choices=MODELS, required=True); r.add_argument('--part', choices=['full', 'small'], default='full')
    r.add_argument('--workers', type=int, default=24); r.add_argument('--limit', type=int, default=0); r.add_argument('--gold', action='store_true')
    c = sub.add_parser('compare'); c.add_argument('--gold', action='store_true')
    sub.add_parser('status')
    a = p.parse_args()
    {'read': cmd_read, 'compare': cmd_compare, 'status': cmd_status}[a.cmd](a)
