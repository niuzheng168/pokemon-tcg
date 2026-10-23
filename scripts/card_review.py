#!/usr/bin/env python3
"""Card-face review of the whole local card library (library_v1, Simplified Chinese) with Foundry vision models.

Every unique card with an image is read independently by two models (different Foundry resources), as a whole card and
as enlarged crops of the small print (mark, number, weakness / resistance / retreat). `compare` then decides field by
field against the library's two text sources (MIK and 52Poké): fields where the image readings and the sources agree are
accepted; the rest are listed for review. `adjudicate` then shows each model the card with the conflicting fields'
region enlarged and their candidate values (shuffled, sources hidden); a field both models settle on the same
candidate is accepted by the next `compare`. The 83 hand-reviewed printings (bound to the CN/V20261019 release) are the
gold set the decision rules are checked on; `adjudicate --gold` also offers each model one plausible wrong candidate
(a dropped ex / V, a swapped noun or negation, another number) against known-right fields.

    python3 scripts/card_review.py read  --model astra|sol [--part full|small] [--workers 24] [--limit N] [--gold]
    python3 scripts/card_review.py compare [--gold]
    python3 scripts/card_review.py adjudicate --model astra|sol [--workers 16] [--limit N] [--gold]
    python3 scripts/card_review.py status

Inputs: .data/card-library/index.json (node scripts/build-card-library.mjs), the library images and, for --gold,
.data/card-review/gold.json (node scripts/card-review-gold.mjs). Outputs (not in git):
.data/card-review/reads/<model>-<part>/<image sha256[:16]>.json, keyed by the image, so a rerun only reads new images;
.data/card-review/adjudications[-gold]/<model>/<sha1(card id)[:16]>.json, valid while the field's candidates stay the same.
Results (in git): catalog/zh-CN/V20261019/library/review/review.jsonl (`compare`) and the Claude review rounds' batches and
verdicts beside it (claude/, claude-r2/ …, claude-tools/); the reviewers' small JPEGs stay in .data/card-review/<round>/images.
Keys come from Foundry .env files outside the repository (FOUNDRY_ASTRA_ENV / FOUNDRY_SOL_ENV), never from git.
"""
import argparse, base64, io, json, os, re, sys, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, '.data')
INDEX = os.path.join(DATA, 'card-library', 'index.json')
OUT = os.path.join(DATA, 'card-review')
# The review's results are committed: the accepted card faces (review.jsonl) and the Claude review rounds' batches and
# verdicts. Model readings, adjudications and the reviewers' small JPEGs stay in OUT (.data, not committed).
REVIEW = os.path.join(ROOT, 'catalog', 'zh-CN', 'V20261019', 'library', 'review')
REVIEW_FILE = os.path.join(REVIEW, 'review.jsonl')
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
    content = [{'type': 'text', 'text': FULL_PROMPT if part == 'full' else SMALL_PROMPT}]
    content += [{'type': 'image_url', 'image_url': {'url': data_url(v), 'detail': 'high'}} for v in views(path, part)]
    return request(model, content, tries)


def request(model, content, tries=6):
    env_path, deployment = MODELS[model]
    e = env(env_path)
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


def cards(gold=False, with_images=True):
    index = json.load(open(INDEX, encoding='utf8'))
    base = os.path.join(index['library'], index['language'])
    out = []
    for e in index['entries']:
        if e.get('duplicateOf') or (with_images and not e.get('image')) or (gold and not e.get('printingId')):
            continue
        out.append({**e, 'path': os.path.join(base, e['image'].get('dir') or e['dir'], e['image']['file']) if e.get('image') else None})
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
STAGE = {'基础': 'basic', '基礎': 'basic', '基础宝可梦': 'basic', 'basic': 'basic', 'Basic': 'basic',
         '1阶进化': 'stage1', 'Stage 1': 'stage1', 'Stage1': 'stage1', 'stage1': 'stage1',
         '2阶进化': 'stage2', 'Stage 2': 'stage2', 'Stage2': 'stage2', 'stage2': 'stage2', 'VMAX': 'vmax', 'VSTAR': 'vstar',
         'V-UNION': 'v-union', 'BREAK': 'break', 'BREAK进化': 'break', 'BREAK Evolution': 'break', '升级': 'levelup', 'Level Up': 'levelup',
         'M进化': 'mega', 'Mega Evolution': 'mega', '传说': 'legend', 'Legend': 'legend',
         # VMAX and VSTAR cards print 「V进化」: it confirms either.
         'V进化': 'v-evolution'}
TEXT_RULE = os.environ.get('CARD_REVIEW_TEXT_RULE', 'either')
# Reminder text printed on every card of a kind (GX / VSTAR once-per-game, the Pokémon Tool rule): the image readers
# copy it, the text sources leave it out.
REMINDERS = [r'[\[［【(（]?在?(对战|战斗)中[^。\]］】)）]*?(GX|VSTAR)[^。\]］】)）]*?(只|仅)(能够|能|可以|可)使用1次[。\]］】)）]?',
             r'[\[［【(（]?在?(对战|战斗)中[^。\]］】)）]*?(只|仅)(能够|能|可以|可)使用1次(GX招式|VSTAR力量)[。\]］】)）]?',
             r'宝可梦道具可以附着在自己的宝可梦身上[，,]?', r'每只宝可梦身上只可以附着1张宝可梦道具[，,]?并保持附(着|加)(的)?状态[。]?',
             r'^宝可梦道具(?=宝可梦道具|身上)',
             # The award line of a tournament prize card (「2025 宝可梦集换式卡牌游戏深圳大师赛 冠军」): printed, not rules text.
             r'(?:[一-鿿]{2}\s*宝可梦\s*)?(?:\d{4}\s*)?宝可梦集换式卡牌游戏[^。]{0,20}?(?:冠军|亚军|季军|四强|八强)']
# A reading that words a text differently must still name the same things: rule-box suffixes (ex, V, GX… – the text
# sources often drop these printed logos), negations, card kinds, zones, players and quantifiers.
KEY_TERMS = re.compile(r'[A-Za-z]+|不|无法|没|未|非|基础|进化|1阶|2阶|支援者|物品|竞技场|道具|特殊能量|基本能量|备战|战斗|弃牌区|手牌|奖赏卡'
                       r'|放逐区|对手|自己|双方|伤害|影响|最多|全部|所有|每|正面|反面|上方|下方|昏厥|中毒|灼伤|麻痹|睡眠|混乱|特性|招式|撤退|弱点|抗性')
SYNONYMS = [('抵抗力', '抗性'), ('抵抗', '抗性')]  # older printings
ENERGY_CODE = {'G': '草', 'R': '火', 'W': '水', 'L': '雷', 'P': '超', 'F': '斗', 'D': '恶', 'M': '钢', 'N': '龙', 'Y': '妖', 'C': '无'}


def source_text(s):
    """A text as the library records it → the printed text: 52Poké's language-conversion markup
    -{zh-hans:简;zh-hant:繁}- keeps the Simplified side, a literal 「\\n」 is a line break, and leftover template
    parameters (「|jeffect=…|eeffect=…」, the Japanese and English texts) are cut off."""
    if not isinstance(s, str): return s
    s = re.split(r'\|[je]effect=', s)[0]
    return re.sub(r'-\{zh-hans:(.*?);zh-hant:.*?\}-', r'\1', s, flags=re.S).replace('\\n', '\n')


def norm_text(s):
    import re, unicodedata
    s = unicodedata.normalize('NFKC', str(s or ''))
    for r in REMINDERS: s = re.sub(r, '', s.strip())
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


def costs(cost):
    if isinstance(cost, str): cost = [c for c in cost if c != '0']
    return [c for c in cost or [] if c != '+']


def card_values(src, raw=False):
    """One source or reading → {field: value}: comparable (normalized) values, or with raw=True the values as written."""
    keep = lambda f: (lambda x: x) if raw else f
    text, typ, wr = keep(norm_text), keep(norm_type), keep(norm_wr)
    v = {'name': text(src.get('name')), 'mark': keep(norm_mark)(src.get('mark')), 'card_text': text(src.get('card_text'))}
    if src.get('kind', 'pokemon') == 'pokemon' or src.get('hp') is not None:
        v.update({'hp': src.get('hp') if raw else str(src.get('hp') or ''), 'type': typ(src.get('type')),
                  'stage': src.get('stage') if raw else STAGE.get(str(src.get('stage')), src.get('stage')),
                  'evolves_from': text(src.get('evolves_from')), 'weakness': wr(src.get('weakness')),
                  'resistance': wr(src.get('resistance')), 'retreat': keep(norm_retreat)(src.get('retreat'))})
        ab, at = src.get('abilities') or [], src.get('attacks') or []
        v['ability.count'], v['attack.count'] = len(ab), len(at)
        for i, a in enumerate(ab):
            v[f'ability.{i}.name'], v[f'ability.{i}.text'] = text(a.get('name')), text(a.get('text'))
    else:
        # A Trainer prints an attack only as a Tool 「可以使用这张卡牌上的招式」: compared like a Pokémon's when a source has one.
        at = src.get('attacks') or []
        if at: v['attack.count'] = len(at)
    for i, a in enumerate(at):
        v[f'attack.{i}.name'], v[f'attack.{i}.text'] = text(a.get('name')), text(a.get('text'))
        v[f'attack.{i}.cost'] = a.get('cost') if raw else ''.join(filter(None, (norm_type(c) for c in costs(a.get('cost')))))
        v[f'attack.{i}.damage'] = a.get('damage') if raw else norm_damage(a.get('damage'))
    return v


def library_source(e, base):
    m = json.load(open(os.path.join(base, e['dir'], 'metadata.merged.json'), encoding='utf8'))
    c, p = m['card'], m['printing']
    text = c.get('text')
    texts = lambda xs: [{**x, 'text': source_text(x.get('text'))} for x in xs or []]
    src = {'kind': c['kind'], 'name': c['name'], 'mark': p.get('regulationMark'),
           'card_text': source_text('\n'.join(text) if isinstance(text, list) else (text or '')),
           'hp': c.get('hp'), 'type': c.get('type'), 'stage': c.get('stage'), 'evolves_from': c.get('evolvesFrom'), 'weakness': c.get('weakness'),
           'resistance': c.get('resistance'), 'retreat': c.get('retreat'), 'abilities': texts(c.get('abilities')), 'attacks': texts(c.get('attacks'))}
    if src['stage'] == 'V':  # a few VMAX / VSTAR records carry the stage 「V」
        src['stage'] = 'VMAX' if c['name'].endswith('VMAX') else 'VSTAR' if c['name'].endswith('VSTAR') else src['stage']
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
    f = read_path(model, part, e) if e.get('image') else ''
    return json.load(open(f, encoding='utf8')).get('reading') if f and os.path.exists(f) else None


SMALL_FIELDS = ('mark', 'weakness', 'resistance', 'retreat')
FULL = ('astra-full', 'sol-full')


def same_meaning(ref, reading):
    """A reading that words a text slightly differently (投掷/抛掷, 附着/附有) but has the same numbers and Energy types,
    and is mostly the same characters, confirms the source's text."""
    import difflib
    if not ref or not reading: return False
    skeleton = lambda t: (re.findall(r'\d+', t), re.findall(r'[草火水雷超斗恶钢龙妖](?=能量|宝可梦)', t))
    return (skeleton(ref) == skeleton(reading) and key_terms(ref) == key_terms(reading)
            and difflib.SequenceMatcher(None, ref, reading, autojunk=False).ratio() >= 0.8)


def key_terms(t):
    import collections
    for a, b in SYNONYMS: t = t.replace(a, b)
    t = re.sub(r'([GRWLPFDMNYC])(?=能量)', lambda m: ENERGY_CODE[m.group(1)], t)  # 「C能量」 in some sources
    return collections.Counter(KEY_TERMS.findall(t))


# 「[对战中，己方的GX招式只能使用1次。]」 / 「…VSTAR力量…」 in any of the printed wordings (as REMINDERS above).
SPECIAL_REMINDERS = [re.compile(r'[\[［【(（]?在?(对战|战斗)中[^。\]］】)）]*?(GX|VSTAR)[^。\]］】)）]*?(只|仅)(能够|能|可以|可)使用1次'),
             re.compile(r'[\[［【(（]?在?(对战|战斗)中[^。\]］】)）]*?(只|仅)(能够|能|可以|可)使用1次(GX|VSTAR)(招式|力量)')]
REMINDER_TEXT = {'GX': '[对战中，己方的GX招式只能使用1次。]', 'VSTAR': '[对战中，己方的VSTAR力量只能使用1次。]'}


def reminder_kind(text):
    for r in SPECIAL_REMINDERS:
        m = r.search(text or '')
        if m: return 'GX' if 'GX' in m.group(0) else 'VSTAR'
    return None


def decide_text(got, ref):
    hits = [k for k in FULL if got[k] == ref or ref in ('', None) and got[k] in ('', None)]
    if len(hits) == 1:
        # One reading confirms the source; if the other reads different key terms (an ex the source and one reader both
        # miss, 影响 / 伤害, a negation), the confirmation is not independent enough: adjudicate.
        other = got[next(k for k in FULL if k not in hits)]
        if other and key_terms(other) != key_terms(ref or ''): hits = []
    if hits and (TEXT_RULE == 'either' or 'astra-full' in hits):
        return True, 'text-confirmed-by-' + '+'.join(h.split('-')[0] for h in hits)
    reads = [got[k] for k in FULL if got[k] is not None]
    if reads and all(same_meaning(ref, r) for r in reads):
        return True, 'text-same-meaning'
    return False, None


def decide_mark(got, ref, sources):
    votes = [got[k] for k in ('astra-full', 'sol-full', 'astra-small', 'sol-small') if got[k] is not None]
    if len(set(x for x in sources if x is not None)) > 1:  # the two sources disagree: the image readings choose
        ref = max(set(sources) - {None}, key=votes.count)
    if ref is not None:
        # The enlarged small-print crops read marks far better than the whole card does.
        if got['astra-small'] == got['sol-small'] == ref: return True, ref, 'mark-small-print-confirms'
        agree, other = votes.count(ref), max([votes.count(x) for x in set(votes) - {ref}] or [0])
        if agree >= 2 and agree > other: return True, ref, 'mark-source-and-images'
        if not votes: return True, ref, 'mark-source-only'  # too small to read on these scans
        return False, ref, None
    small = [got['astra-small'], got['sol-small']]
    if small[0] is not None and small[0] == small[1] and got['astra-full'] == small[0]:
        return True, small[0], 'mark-images-only'  # no source has the mark: three image readings agree
    if not votes: return True, None, 'mark-none'  # nothing anywhere: the card has no mark (e.g. basic Energy)
    return False, None, None


def decide_structure(f, got, ref, sources):
    reads = [got[k] for k in FULL] + ([got['astra-small'], got['sol-small']] if f in SMALL_FIELDS else [])
    if f == 'stage' and ref in ('vmax', 'vstar'):
        reads = [ref if x == 'v-evolution' else x for x in reads]
    if len(set(map(json.dumps, sources))) == 1 and ref in reads:
        return True, ref, 'structure-sources-agree-and-image-confirms'
    if all(x in (None, '') for x in sources) and got['astra-full'] not in (None, '') and got['astra-full'] == got['sol-full']:
        return True, got['astra-full'], 'structure-images-agree'  # no source has it: both readings agree
    agreed = reads[0] if reads[0] not in (None, '') and all(x == reads[0] for x in reads) else None
    if agreed and len(set(map(json.dumps, sources))) == 1 and ref:
        # The library records only the Weakness / Resistance type (「斗」), all four readings the value too (「斗×2」).
        if f in ('weakness', 'resistance') and len(ref) == 1 and agreed[0] == ref and len(agreed) > 1:
            return True, agreed, 'structure-source-type-images-value'
        # The text sources drop the damage modifier (「120」 for 「120+」).
        if f.endswith('.damage') and ref.isdigit() and agreed[:-1] == ref and agreed[-1] in '+×-':
            return True, agreed, 'damage-images-add-modifier'
    return False, ref, None


def decide_evolves_from(got, ref, sources):
    """Both readings name the same existing Pokémon where the sources have nothing or drop its printed suffix
    (「叶伊布」 for 「叶伊布V」)."""
    a = got['astra-full']
    if not a or a != got['sol-full'] or a not in POKEMON_NAMES: return False
    return all(not x for x in sources) or len(set(sources)) == 1 and re.fullmatch(re.escape(ref) + '[A-Za-z]+', a) is not None


def image_identity(e, reads, src, out):
    """Why the card's image may show another card than its record, or None: the name the review settled on is a
    reading's, not the source's (the library pairs a few records with another card's image), or most readings agree on
    a card number of another set size (maybe another printing of the card, maybe a misread digit)."""
    if 'name' in out and norm_text(out['name']['value']) != norm_text(src.get('name')):
        return 'image-shows-another-name'
    import collections, unicodedata
    nums = [unicodedata.normalize('NFKC', str(r.get('number'))).upper().replace(' ', '') for r in reads.values() if r and r.get('number')]
    top = collections.Counter(nums).most_common(1)
    rec = unicodedata.normalize('NFKC', str(e.get('number') or '')).upper().replace(' ', '')
    if top and top[0][1] >= 3 and '/' in rec and '/' in top[0][0]:
        mine, theirs = rec.split('/')[-1], top[0][0].split('/')[-1]
        if not (mine.startswith(theirs) or theirs.startswith(mine)):  # 「017/103 01」: a variant suffix, the same set
            return 'image-shows-another-printing'
    return None


def gather(e, base):
    """One card's two text sources and four image readings: comparable values V and as-written values raw, by source."""
    lib, mik_id = library_source(e, base)
    mik = mik_source(mik_id)
    reads = {k: load_read(*k.split('-'), e) for k in ('astra-full', 'sol-full', 'astra-small', 'sol-small')}
    V = {'lib': card_values(lib), 'mik': card_values(mik) if mik else None}
    for k, r in reads.items():
        V[k] = card_values({**r, 'kind': lib['kind']}) if r else None
    raw = {'lib': card_values(lib, raw=True), 'mik': card_values(mik, raw=True) if mik else None,
           **{k: card_values({**r, 'kind': lib['kind']}, raw=True) if r else None for k, r in reads.items()}}
    return lib, mik_id, mik, reads, V, raw


def decide(e, base):
    """Field-by-field decision for one card: the accepted value as written (`raw`, from MIK, else the library, else the
    image readings) with the rule that accepted it, or a conflict for review. A conflict both models settled on the
    zoomed card (`adjudicate`) is accepted with the candidate they chose."""
    lib, mik_id, mik, reads, V, raw = gather(e, base)
    settled = adjudicated(e)
    fields = sorted({f for src in V.values() if src for f in src} - {'number'})
    if lib['kind'] != 'pokemon':
        # A Tool's printed attack: only when the library has it, and then its source is the library (MIK gives no Trainer attacks).
        tool_attack = lib['kind'] == 'trainer' and V['lib'].get('attack.count', 0) > 0
        fields = [f for f in fields if f in ('name', 'mark', 'card_text') or tool_attack and f.startswith('attack.')]
    else:
        fields = [f for f in fields if f != 'card_text']
    union = V['lib'].get('stage') == 'v-union'
    if union:  # each V-UNION card shows a quarter of the whole Pokémon: only the card-level fields can be read
        fields = [f for f in fields if f in ('name', 'mark', 'hp', 'type')]
    out, conflicts = {}, []
    for f in fields:
        got = {k: (src.get(f) if src else None) for k, src in V.items()}
        ref_key = 'mik' if mik and not (lib['kind'] != 'pokemon' and f.startswith('attack.')) else 'lib'
        ref, sources = got[ref_key], [got['lib']] + ([got['mik']] if ref_key == 'mik' else [])
        if f.split('.')[-1] in ('name', 'text') or f in ('name', 'evolves_from', 'card_text'):
            ok, rule = decide_text(got, ref)
            value = raw[ref_key].get(f)
            if not ok and f == 'evolves_from' and decide_evolves_from(got, ref, sources):
                ok, rule, value = True, 'evolves-from-images-agree-known-name', raw['astra-full'][f]
        elif f == 'mark':
            ok, mark, rule = decide_mark(got, ref, sources)
            value = mark
        else:
            ok, value_n, rule = decide_structure(f, got, ref, sources)
            src_key = next((k for k in (ref_key, 'lib', 'mik', 'astra-full') if got.get(k) == value_n and raw.get(k)), ref_key)
            value = raw[src_key].get(f) if raw.get(src_key) else None
        if ok and isinstance(value, str) and re.fullmatch(r'(attack|ability)\.\d+\.text', f) and not reminder_kind(value):
            # The comparison leaves out the GX / VSTAR once-per-game reminder, so a source without it can be accepted.
            # Both whole-card readings print it: the card does, and the reminder is what marks a GX attack / VSTAR Power.
            kinds = {reminder_kind((raw.get(k) or {}).get(f) or '') for k in FULL}
            if len(kinds) == 1 and None not in kinds:
                value, rule = value.rstrip() + REMINDER_TEXT[kinds.pop()], rule + '+reminder-in-both-readings'
        if not ok and f in settled and settled[f]['candidates'] == candidate_set(f, got):
            ok, rule, value = True, 'adjudicated-zoom-astra+sol', settled[f]['raw']
        cv = CLAUDE_VERDICTS.get(e['id'], {}).get(f)
        if not ok and cv and cv['candidates'] == candidate_set(f, got):  # the chosen candidate is a source's or a reading's
            ok, rule, value = True, 'claude-image-review', cv['raw']
        if ok:
            out[f] = {'value': value, 'rule': rule}
        else:
            conflicts.append({'field': f, **{k: v for k, v in got.items() if v is not None}})
    identity = image_identity(e, reads, mik or lib, out)
    src_v = V['mik' if mik else 'lib']
    for f in list(out) if identity else []:
        # Another card: nothing its image confirms counts. Another printing: only what it shows as the source has it (a
        # reprint every field of which equals the source); values only the image has are not this printing's.
        if identity == 'image-shows-another-name' or src_v.get(f) != card_values_field(f, out[f]['value'], lib['kind']):
            conflicts.append({'field': f, 'identity': identity}); del out[f]
    cat = CLAUDE_VERDICTS.get(e['id'], {}).get('category')
    if cat and lib['kind'] == 'trainer':  # a Trainer the library gives no category: Claude's, if a reading prints the word too
        word = cat['raw'].removesuffix('卡')
        if any(word in json.dumps(r, ensure_ascii=False) for r in (reads['astra-full'], reads['sol-full']) if r):
            out['category'] = {'value': json.loads(cat['norm']), 'rule': 'claude-image-review+reading'}
    if e['id'] in CLAUDE_TOOL_LABELS and lib['kind'] == 'trainer' and all(
            '宝可梦道具' in json.dumps(r, ensure_ascii=False) for r in (reads['astra-full'], reads['sol-full']) if r) and any(
            reads[k] for k in ('astra-full', 'sol-full')):
        # 「物品」 at the top and 「宝可梦道具」 printed too: a Pokémon Tool (I.B-02), as Claude saw and both readings print.
        out['category'] = {'value': 'tool', 'rule': 'claude-tool-label+reading'}
    return {'id': e['id'], 'dir': e['dir'], 'printingId': e.get('printingId'), 'kind': lib['kind'], 'name': lib['name'], 'mik': mik_id,
            'image': bool(e.get('image')), 'special': 'v-union' if union else None,
            'reads': {k: bool(r) for k, r in reads.items()}, 'accepted': out, 'conflicts': conflicts}


# ---------------- adjudicate: each model settles the conflicts on the zoomed card, choosing among the candidates ----------------
ADJ_VERSION = 'adj-v1'
ADJ = os.path.join(OUT, 'adjudications')
ORDER = ('mik', 'lib', 'astra-full', 'sol-full', 'astra-small', 'sol-small')
# Region of the card face that prints each field, as fractions (left, top, right, bottom).
REGIONS = {'top': (0, 0, 1, 0.16), 'middle': (0, 0.38, 1, 0.93), 'bottom': (0, 0.8, 1, 0.97), 'mark': (0, 0.88, 0.5, 1)}

ADJ_PROMPT = '''这是一张简体中文宝可梦集换式卡牌（PTCG）。第一张图是整张卡，后面是卡面局部的放大图。
几个文字来源对下面这些字段的内容有分歧。请只根据卡面判断每个字段实际印的是什么。
- 候选之间可能只差一两个字：有没有 ex、V、GX、VMAX、VSTAR 之类的标志，一个动词、名词、否定词或数字。请在放大图上逐字核对这些位置，不要按常见说法推测。
- printed：照卡面逐字抄写这个字段；能量符号写成【属性单字】（草 火 水 雷 超 斗 恶 钢 龙 妖 无）；看不清的字用□。
- match：与卡面完全一致的候选字母；没有一个完全一致就写 null。标点和空格的差别不算。
字段和候选：
{fields}
只输出一个 JSON 对象：{{"fields":[{{"id":字段编号,"printed":"...","match":"A"或null}}]}}'''

FIELD_LABELS = {'name': '卡名', 'hp': 'HP', 'type': '属性', 'stage': '阶段（基础 / 1阶进化 / 2阶进化 / VMAX / VSTAR 等）', 'evolves_from': '进化来源（「从××进化」）',
                'weakness': '弱点', 'resistance': '抗性', 'retreat': '撤退所需能量的个数', 'mark': '规则标记（卡牌左下角小方框里的字母）',
                'card_text': '卡牌的效果文字', 'ability.count': '特性的个数', 'attack.count': '招式的个数'}
PART_LABELS = {'name': '名称', 'text': '效果文字', 'cost': '所需能量', 'damage': '伤害'}


def field_label(f):
    if f in FIELD_LABELS: return FIELD_LABELS[f]
    kind, i, part = f.split('.')
    return f"第{int(i) + 1}个{'招式' if kind == 'attack' else '特性'}的{PART_LABELS[part]}"


def field_region(f):
    if f in ('name', 'hp', 'type', 'stage', 'evolves_from'): return 'top'
    if f == 'mark': return 'mark'
    if f in ('weakness', 'resistance', 'retreat'): return 'bottom'
    return 'middle'


def render(f, v):
    """An as-written value, as the prompt shows it."""
    if v in (None, '', []): return '（卡面上没有这一项）'
    if f.endswith('.cost'): return ''.join(f'【{norm_type(c)}】' for c in costs(v)) or '（不需要能量）'
    if f in ('weakness', 'resistance'): return f"{norm_type(v.get('type') or v.get('energy'))}{v.get('value') or ''}" if isinstance(v, dict) else str(v)
    return str(v)


def candidate_set(f, got):
    """The distinct comparable values of one conflicting field: what an adjudication is valid for."""
    return sorted({json.dumps(got[k], ensure_ascii=False) for k in ORDER if got.get(k) is not None})


def candidates(f, V, raw):
    """Distinct candidates of one field: comparable value, as-written value (the first source's) and where it came from."""
    out = {}
    for k in ORDER:
        if V.get(k) is None or V[k].get(f) is None: continue
        n = json.dumps(V[k][f], ensure_ascii=False)
        out.setdefault(n, {'norm': n, 'raw': raw[k].get(f), 'from': []})['from'].append(k)
    return list(out.values())


def zoom_views(path, regions):
    from PIL import Image
    im = Image.open(path).convert('RGBA')
    im = Image.alpha_composite(Image.new('RGBA', im.size, (255, 255, 255, 255)), im)
    w, h = im.size
    out = [im.resize((w * 2, h * 2), Image.LANCZOS) if w < 600 else im]
    for r in regions:
        x0, y0, x1, y1 = REGIONS[r]
        crop = im.crop((round(w * x0), round(h * y0), round(w * x1), round(h * y1)))
        s = max(1, 1200 / crop.width)
        out.append(crop.resize((round(crop.width * s), round(crop.height * s)), Image.LANCZOS))
    return out


def adj_path(model, e, gold=False):
    import hashlib
    return os.path.join(OUT, 'adjudications-gold' if gold else 'adjudications', model, hashlib.sha1(e['id'].encode()).hexdigest()[:16] + '.json')


def adjudicate_card(model, e, items):
    """items: [(field, [candidate…])] → {field: {candidates, letters, printed, match, chosen}} or {'error'}."""
    import random
    rnd = random.Random(f"{e['id']}|{model}")  # the order of the candidates does not tell their source
    lines, letters = [], {}
    for i, (f, cands) in enumerate(items, 1):
        cs = cands[:]; rnd.shuffle(cs)
        letters[f] = {chr(65 + j): c for j, c in enumerate(cs)}
        lines.append(f'{i}. {field_label(f)}\n' + '\n'.join(f'   {L}: {render(f, c["raw"])}' for L, c in letters[f].items()))
    regions = sorted({field_region(f) for f, _ in items}, key=list(REGIONS).index)
    content = [{'type': 'text', 'text': ADJ_PROMPT.format(fields='\n'.join(lines))}]
    content += [{'type': 'image_url', 'image_url': {'url': data_url(v), 'detail': 'high'}} for v in zoom_views(e['path'], regions)]
    r = request(model, content)
    if 'error' in r: return r
    answers = {a.get('id'): a for a in (r['reading'].get('fields') or []) if isinstance(a, dict)}
    out = {}
    for i, (f, cands) in enumerate(items, 1):
        a = answers.get(i) or answers.get(str(i)) or {}
        c = letters[f].get(str(a.get('match') or '').strip().upper()[:1])
        out[f] = {'candidates': sorted(x['norm'] for x in cands), 'letters': {L: x['norm'] for L, x in letters[f].items()},
                  'printed': a.get('printed'), 'match': a.get('match'), 'chosen': c['norm'] if c else None, 'raw': c['raw'] if c else None}
    return {'fields': out, 'deployment': r['deployment'], 'prompt': ADJ_VERSION, 'usage': r['usage'], 'sec': r['sec']}


def adjudicated(e, gold=False):
    """Fields both models settled on the same candidate: {field: {candidates, raw}}."""
    got = []
    for m in MODELS:
        f = adj_path(m, e, gold)
        if not os.path.exists(f): return {}
        got.append(json.load(open(f, encoding='utf8'))['fields'])
    a, s = got
    return {f: {'candidates': d['candidates'], 'raw': d['raw']} for f, d in a.items()
            if d['chosen'] is not None and f in s and s[f]['chosen'] == d['chosen'] and s[f]['candidates'] == d['candidates']}


def perturb(f, v, seed):
    """A plausible wrong candidate for a known-right value (the gold calibration): the kinds of difference the text
    sources and the readers actually show."""
    import random
    rnd = random.Random(seed)
    if f.endswith('.text') or f == 'card_text':
        options = []
        for a, b in (('影响', '伤害'), ('伤害', '影响'), ('没有', '放有'), ('放有', '没有'), ('自己', '对手'), ('对手', '自己'), ('备战', '战斗'), ('最多', '')):
            if a in v: options.append(v.replace(a, b, 1))
        if 'ex' in v: options.append(v.replace('ex', '', 1))
        elif '宝可梦」' in v: options.append(v.replace('宝可梦」', '宝可梦ex」', 1))
        m = re.search(r'\d+', v)
        if m: options.append(v[:m.start()] + str(int(m.group()) + (10 if int(m.group()) >= 10 else 1)) + v[m.end():])
        return rnd.choice(options) if options else None
    if f.endswith('.name') or f in ('name', 'evolves_from'):
        return v + 'GX' if v and not v.endswith(('GX', 'V', 'ex')) else (v[:-2] if v and v.endswith('GX') else None)
    if f == 'hp' or f.endswith('.damage'):
        m = re.match(r'\d+', str(v or ''))
        return str(v).replace(m.group(), str(int(m.group()) + 10), 1) if m else None
    if f == 'retreat': return (v or 0) + 1
    if f == 'mark': return {'E': 'F', 'F': 'E', 'G': 'E', 'H': 'I', 'I': 'H', 'D': 'I'}.get(v)
    return None


def cmd_adjudicate(a):
    index = json.load(open(INDEX, encoding='utf8'))
    base = os.path.join(index['library'], index['language'])
    by_id = {e['id']: e for e in cards(a.gold, with_images=True)}
    review = [json.loads(l) for l in open(os.path.join(OUT, 'review-gold.jsonl') if a.gold else REVIEW_FILE, encoding='utf8')]
    gold = json.load(open(os.path.join(OUT, 'gold.json'), encoding='utf8')) if a.gold else None
    jobs = []
    for r in review:
        e = by_id.get(r['id'])
        if not e: continue  # no image
        lib, mik_id, mik, reads, V, raw = gather(e, base)
        items = [(c['field'], candidates(c['field'], V, raw)) for c in r['conflicts']]
        if a.gold:  # known-right accepted fields against one plausible wrong candidate each
            g = gold.get(r['printingId']); truth_v, truth_raw = card_values(g), card_values(g, raw=True)
            picked = [f for f in sorted(r['accepted']) if f in truth_v and f != 'mark' or f == 'mark' and g.get('mark')]
            import random
            random.Random(r['id']).shuffle(picked)
            for f in picked[:3]:
                wrong = perturb(f, truth_raw[f], r['id'] + f)
                if wrong is None: continue
                vw = card_values_field(f, wrong, r['kind'])
                if vw == truth_v[f]: continue
                items.append((f, [{'norm': json.dumps(truth_v[f], ensure_ascii=False), 'raw': truth_raw[f], 'from': ['gold']},
                                  {'norm': json.dumps(vw, ensure_ascii=False), 'raw': wrong, 'from': ['decoy']}]))
        items = [(f, c) for f, c in items if len(c) > 1]
        if items: jobs.append((e, items))
    todo = []
    for e, items in jobs:
        p = adj_path(a.model, e, a.gold)
        if os.path.exists(p):
            done = json.load(open(p, encoding='utf8'))['fields']
            if all(f in done and done[f]['candidates'] == sorted(x['norm'] for x in c) for f, c in items): continue
        todo.append((e, items))
    if a.limit: todo = todo[:a.limit]
    os.makedirs(os.path.dirname(adj_path(a.model, {'id': ''}, a.gold)), exist_ok=True)
    print(f'{a.model}: {len(jobs)} cards with conflicts, {len(todo)} to adjudicate with {a.workers} workers', flush=True)
    lock, done, failed, started = threading.Lock(), [0], [0], time.time()

    def one(job):
        e, items = job
        r = adjudicate_card(a.model, e, items)
        r['card'] = e['id']
        if 'fields' in r:
            p = adj_path(a.model, e, a.gold)
            with open(p + '.tmp', 'w', encoding='utf8') as f: json.dump(r, f, ensure_ascii=False)
            os.replace(p + '.tmp', p)
        with lock:
            done[0] += 1
            if 'error' in r:
                failed[0] += 1
                with open(os.path.join(OUT, f'errors-adj-{a.model}.jsonl'), 'a', encoding='utf8') as f: f.write(json.dumps(r, ensure_ascii=False) + '\n')
            if done[0] % 50 == 0 or done[0] == len(todo):
                rate = done[0] / max(time.time() - started, 1) * 60
                print(f'  {done[0]}/{len(todo)} ({failed[0]} failed), {rate:.0f}/min, eta {(len(todo) - done[0]) / max(rate, 0.1):.0f} min', flush=True)

    with ThreadPoolExecutor(a.workers) as pool:
        for f in as_completed([pool.submit(one, j) for j in todo]): f.result()
    if a.gold: gold_adjudication_check(jobs, gold)


def gold_adjudication_check(jobs, gold):
    """Calibration: every field must be settled on the hand-reviewed value, or left unsettled – never on another
    candidate. Decoy fields (one plausible wrong candidate) and the gold cards' real conflicts are counted apart."""
    tally = {k: [0, 0, 0] for k in ('decoy', 'real')}  # right, wrong, unsettled
    for e, items in jobs:
        settled = adjudicated(e, gold=True)
        g = gold[e['printingId']]
        for f, cands in items:
            kind = 'decoy' if [c['from'] for c in cands] == [['gold'], ['decoy']] else 'real'
            s = settled.get(f)
            if s is None: tally[kind][2] += 1; continue
            right = card_values_field(f, s['raw'], 'pokemon' if g.get('hp') is not None else 'trainer') == card_values(g).get(f)
            tally[kind][0 if right else 1] += 1
            if not right: print('  WRONG', kind, e['id'], f, 'chose', repr(s['raw']), 'truth', repr(card_values(g, raw=True).get(f)))
    for k, (r, w, u) in tally.items(): print(f'gold adjudication ({k}): {r} settled right, {w} settled wrong, {u} unsettled')


# ---------------- Claude image review: what adjudication left, in batches for Claude subagents ----------------
CLAUDE = os.path.join(REVIEW, 'claude')
CATEGORIES = {'item': '物品卡', 'supporter': '支援者卡', 'stadium': '竞技场卡', 'tool': '宝可梦道具'}


def small_jpeg(im, path, box=700, quality=80, limit=110_000):
    """A copy small enough for the model gateway (≈100 KB)."""
    im = im.convert('RGB'); im.thumbnail((box, box))
    while True:
        im.save(path, 'JPEG', quality=quality)
        if os.path.getsize(path) <= limit or quality <= 50: return path
        quality -= 10


def claude_rounds():
    """The Claude review rounds' directories (batches and results): round 1 is claude/, later rounds claude-r2/, claude-r3/ …"""
    later = sorted((d for d in os.listdir(REVIEW) if d.startswith('claude-r') and d[8:].isdigit()), key=lambda d: int(d[8:]))
    return [CLAUDE] + [os.path.join(REVIEW, d) for d in later]


def cmd_claude_prep(a):
    """Batches of the cards still in conflict (and Trainers without a category) for Claude subagents: per card the
    candidates of every open field (shuffled, sources hidden) and small JPEGs of the card and the enlarged regions.
    A later round (--round 2 …) keeps the earlier rounds and asks only fields no earlier round was shown; cards whose
    image shows another card are left out (they play only as an identical reprint, like cards without an image)."""
    import hashlib, random, shutil
    round_dir = CLAUDE if a.round == 1 else os.path.join(REVIEW, f'claude-r{a.round}')
    image_dir = os.path.join(OUT, os.path.basename(round_dir), 'images')
    if os.path.isdir(os.path.join(round_dir, 'results')) and os.listdir(os.path.join(round_dir, 'results')):
        raise SystemExit(f'{os.path.relpath(round_dir, ROOT)} already has results; not overwriting them.')
    asked = set()
    for d in claude_rounds() if a.round > 1 else []:
        if d == round_dir or not os.path.isdir(os.path.join(d, 'batches')): continue
        for name in os.listdir(os.path.join(d, 'batches')):
            for c in json.load(open(os.path.join(d, 'batches', name), encoding='utf8')):
                asked.update((c['card'], f['field']) for f in c['fields'])
    index = json.load(open(INDEX, encoding='utf8'))
    base = os.path.join(index['library'], index['language'])
    by_id = {e['id']: e for e in cards(with_images=True)}
    review = [json.loads(l) for l in open(REVIEW_FILE, encoding='utf8')]
    entries = {e['id']: e for e in index['entries']}
    jobs = []
    for r in review:
        e = by_id.get(r['id'])
        if not e: continue
        lib, mik_id, mik, reads, V, raw = gather(e, base)
        if a.round > 1 and any(c.get('identity') for c in r['conflicts']): continue
        items = [(c['field'], candidates(c['field'], V, raw)) for c in r['conflicts'] if (r['id'], c['field']) not in asked]
        if entries[r['id']]['kind'] == 'trainer' and not entries[r['id']]['category'] and (r['id'], 'category') not in asked:
            items.append(('category', [{'norm': json.dumps(k), 'raw': v, 'from': ['category']} for k, v in CATEGORIES.items()]))
        if items: jobs.append((e, items))
    CLAUDE_DIR = round_dir
    shutil.rmtree(CLAUDE_DIR, ignore_errors=True); shutil.rmtree(image_dir, ignore_errors=True)
    for d in ('batches', 'results'): os.makedirs(os.path.join(CLAUDE_DIR, d))
    os.makedirs(image_dir)
    from PIL import Image
    batches = [jobs[i:i + a.batch] for i in range(0, len(jobs), a.batch)]
    for n, batch in enumerate(batches, 1):
        out = []
        for e, items in batch:
            key = hashlib.sha1(e['id'].encode()).hexdigest()[:12]
            rnd = random.Random(e['id'] + '|claude')
            regions = sorted({'top' if f == 'category' else field_region(f) for f, _ in items}, key=list(REGIONS).index)
            views_ = zoom_views(e['path'], regions)
            images = [small_jpeg(views_[0], os.path.join(image_dir, f'{key}-card.jpg'))]
            images += [small_jpeg(v, os.path.join(image_dir, f'{key}-zoom-{r}.jpg'), box=1000) for r, v in zip(regions, views_[1:])]
            fields = []
            for f, cands in items:
                cs = cands[:]
                if f != 'category': rnd.shuffle(cs)
                fields.append({'field': f, 'label': '训练家卡的类别（卡牌顶部印的是物品 / 支援者 / 竞技场 / 宝可梦道具）' if f == 'category' else field_label(f),
                               'candidates': {chr(65 + j): render(f, c['raw']) for j, c in enumerate(cs)},
                               '_norms': {chr(65 + j): c['norm'] for j, c in enumerate(cs)}, '_raws': {chr(65 + j): c['raw'] for j, c in enumerate(cs)},
                               '_from': {chr(65 + j): c['from'] for j, c in enumerate(cs)}})
            out.append({'card': e['id'], 'name': e['name'], 'kind': e['kind'], 'images': [os.path.relpath(p, ROOT) for p in images], 'fields': fields})
        json.dump(out, open(os.path.join(CLAUDE_DIR, 'batches', f'batch-{n:02d}.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print(f'{len(jobs)} cards, {sum(len(i) for _, i in jobs)} fields in {len(batches)} batches → {os.path.relpath(CLAUDE_DIR, ROOT)}/batches')


def claude_verdicts():
    """{card id: {field: {candidates, raw, norm}}} from the Claude reviewers' results: a field is settled only when the
    reviewer's printed text matches one candidate, which came from a text source or a model reading."""
    out = {}
    for rd in claude_rounds():
      d = os.path.join(rd, 'results')
      for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        batch = {c['card']: c for c in json.load(open(os.path.join(rd, 'batches', name), encoding='utf8'))}
        for res in json.load(open(os.path.join(d, name), encoding='utf8')):
            card = batch.get(res.get('card'))
            if not card: continue
            fields = {f['field']: f for f in card['fields']}
            for v in res.get('fields') or []:
                f = fields.get(v.get('field')); L = str(v.get('match') or '').strip().upper()[:1]
                if f and L not in f['_norms'] and v.get('printed') and f['field'] != 'category':
                    # The reviewer's transcription equals one candidate once compared as `compare` does (the GX / VSTAR
                    # once-per-game reminder and the Tool rule text left out): that candidate.
                    n = json.dumps(card_values_field(f['field'], v['printed'], card['kind']), ensure_ascii=False)
                    L = next((k for k, x in f['_norms'].items() if x == n and '□' not in n), L)
                if not f or L not in f['_norms']: continue
                out.setdefault(card['card'], {})[f['field']] = {'candidates': sorted(f['_norms'].values()), 'raw': f['_raws'][L], 'norm': f['_norms'][L]}
    return out


def claude_tool_labels():
    """The Trainers a Claude reviewer saw printed with 「宝可梦道具」 (claude-tools/results): Sword & Shield and earlier print
    「物品」 at the top of a Pokémon Tool and 「宝可梦道具」 below the artwork; such a card is a Pokémon Tool (I.B-02)."""
    d = os.path.join(REVIEW, 'claude-tools', 'results')
    return {res['card'] for name in (sorted(os.listdir(d)) if os.path.isdir(d) else [])
            for res in json.load(open(os.path.join(d, name), encoding='utf8'))
            if res.get('verdict') == 'tool' and res.get('tool_label') is True and res.get('name_matches') is True}


CLAUDE_VERDICTS = {}
CLAUDE_TOOL_LABELS = set()
POKEMON_NAMES = set()


def cmd_compare(a):
    index = json.load(open(INDEX, encoding='utf8'))
    base = os.path.join(index['library'], index['language'])
    POKEMON_NAMES.update(norm_text(e['name']) for e in index['entries'] if e['kind'] == 'pokemon')
    CLAUDE_VERDICTS.update(claude_verdicts())
    CLAUDE_TOOL_LABELS.update(claude_tool_labels())
    todo = cards(a.gold, with_images=False)
    with ThreadPoolExecutor(16) as pool:
        results = list(pool.map(lambda e: decide(e, base), todo))
    out = os.path.join(OUT, 'review-gold.jsonl') if a.gold else REVIEW_FILE
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf8') as f:
        for r in results: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    n_fields = sum(len(r['accepted']) + len(r['conflicts']) for r in results)
    n_conf = sum(len(r['conflicts']) for r in results)
    clean = sum(1 for r in results if not r['conflicts'])
    print(f'{len(results)} cards compared ({sum(1 for r in results if not r["image"])} without image, '
          f'{sum(1 for r in results if r["image"] and not all(r["reads"].values()))} with readings missing): '
          f'{clean} with every field accepted; {n_fields} fields, {n_conf} in conflict ({n_conf / max(n_fields, 1):.1%}) → {out}')
    if a.gold: gold_check(results)


def gold_check(results):
    gold = json.load(open(os.path.join(OUT, 'gold.json'), encoding='utf8'))
    wrong, wording, checked, conflicts = [], [], 0, 0
    for r in results:
        g = gold.get(r['printingId'])
        if not g: continue
        truth, truth_raw = card_values(g), card_values(g, raw=True)
        for f, d in r['accepted'].items():
            if f == 'mark' and g['mark'] is None: continue
            if f in truth:
                checked += 1
                mine = card_values_field(f, d['value'], r['kind'])
                if truth[f] == mine: continue
                line = f"{r['printingId']} {f}: accepted {d['value']!r}, truth {truth_raw[f]!r} ({d['rule']})"
                # The same meaning in slightly different words (the source's typo): right for the rules, not verbatim.
                (wording if d['rule'] == 'text-same-meaning' and same_meaning(truth[f], mine) else wrong).append(line)
        conflicts += len(r['conflicts'])
    print(f'gold: {checked} accepted fields checked against the hand review, {len(wrong)} wrong, {len(wording)} worded differently '
          f'with the same meaning; {conflicts} fields left for review')
    for w in wrong: print('  WRONG', w)
    for w in wording: print('  WORDING', w)


def card_values_field(f, value, kind):
    """The comparable form of one accepted (raw) value."""
    if f.endswith('.text') or f.endswith('.name') or f in ('name', 'evolves_from', 'card_text'): return norm_text(value)
    if f == 'mark': return norm_mark(value)
    if f == 'hp': return str(value or '')
    if f == 'type': return norm_type(value)
    if f == 'stage': return STAGE.get(str(value), value)
    if f in ('weakness', 'resistance'): return norm_wr(value)
    if f == 'retreat': return norm_retreat(value)
    if f.endswith('.cost'): return ''.join(filter(None, (norm_type(c) for c in costs(value))))
    if f.endswith('.damage'): return norm_damage(value)
    return value


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
    j = sub.add_parser('adjudicate'); j.add_argument('--model', choices=MODELS, required=True); j.add_argument('--workers', type=int, default=16)
    j.add_argument('--limit', type=int, default=0); j.add_argument('--gold', action='store_true')
    cp = sub.add_parser('claude-prep'); cp.add_argument('--batch', type=int, default=8); cp.add_argument('--round', type=int, default=1)
    sub.add_parser('status')
    a = p.parse_args()
    {'read': cmd_read, 'compare': cmd_compare, 'adjudicate': cmd_adjudicate, 'claude-prep': cmd_claude_prep, 'status': cmd_status}[a.cmd](a)
