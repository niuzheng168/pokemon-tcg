#!/usr/bin/env python3
"""Translation of printed card effects into the kernel's effect entries, with Foundry text models.

Every distinct printed effect (a unit: scripts/effect-units.mjs) is translated independently by two models (different
Foundry resources) into `[key, handlerId, parameters]` entries over the existing handlers, or marked unsupported with
the reason. The reference the models work from is .data/effect-translation/handler-reference.md (the handler shapes,
placements and limits, written from public/rules/ and schemas/). Results are checked by the kernel itself
(scripts/effect-validate.mjs) and compared between the models; the hand-reviewed pool is the gold set.

    python3 scripts/effect_translate.py translate --model astra|sol --units gold|corpus [--round rN] [--batch 8] [--workers 8] [--limit N]
    python3 scripts/effect_translate.py check --units gold|corpus
    python3 scripts/effect_translate.py score            (gold: translations against the reviewed entries)
    python3 scripts/effect_translate.py status --units gold|corpus

Outputs (not in git): .data/effect-translation/out/<model>/<uid>.json, checks-<units>.jsonl. Keys come from the Foundry
.env files (FOUNDRY_ASTRA_ENV / FOUNDRY_SOL_ENV, as scripts/card_review.py), never from git.

Re-translation rounds (scripts/effect-translation-rounds.json): `--round rN` translates only that round's units into
out-rN/<model>/, leaving earlier outputs in place. Every reader takes a unit's latest round that has an output.
"""
import argparse, hashlib, json, os, re, subprocess, sys, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from card_review import MODELS, env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, '.data', 'effect-translation')
REFERENCE = os.path.join(OUT, 'handler-reference.md')
UNITS = {'gold': os.path.join(OUT, 'gold.jsonl'), 'corpus': os.path.join(OUT, 'corpus.jsonl')}
PROMPT_VERSION = 't1'  # t1 + the usage-key note (2026-10-21): same task, same expected answers
ROUNDS = json.load(open(os.path.join(ROOT, 'scripts', 'effect-translation-rounds.json'), encoding='utf8'))

INSTRUCTIONS = '''You translate the printed effect texts of Simplified-Chinese Pokémon TCG cards into effect entries for the
CN/V20261019 rules engine described in the reference below. You get a JSON list of units and answer with one result per unit.

A unit is {uid, kind, text, card:{name, kind, stage, hp, category}, attack?:{name, cost, damage}, ability?:{name}}:
- kind "attack": the printed text of one attack. attack.damage is the printed damage column: "" (none), "120", "30+", "70×",
  "120-". The engine deals a plain printed damage itself; a "+", "×" or "-" damage needs exactly one formula entry
  (cn.damageValue@1 or cn.prizeDamage@1) that returns the WHOLE base damage including the printed number (§1, §3.1).
  An attack with an empty text and plain damage has nothing to translate: {"status":"ok","effects":[]}.
- kind "ability": an Ability. Return mode, usage, trigger (triggered only), condition (activated only, if printed) and effects (§1).
- kind "trainer": an Item, Supporter, Pokémon Tool or Stadium (card.category). Return effects, and playCosts / condition if
  printed. Do not translate the general rule text every card of the category carries (one Supporter per turn, how Tools
  attach, Stadium replacement); translate everything specific to this card.
- kind "energy": a Special Energy. Return baseUnits (what it provides, §1) and effects.
- kind "rule": a Pokémon's printed rule box other than the automatic ex rule (e.g. the Tera rule). Return rules.

Result shapes:
{"uid":"…","status":"ok","effects":[[key, handlerId, parameters], …], …the kind's other fields}
{"uid":"…","status":"unsupported","reasons":["<the clause>: <why, citing the §5 item>"]}

Rules:
1. Exactness over coverage. If any clause of the text cannot be expressed exactly with the handlers and shapes of the
   reference, the whole unit is "unsupported". Never drop a clause, never approximate, never invent handlers, fields or
   enum values. Respect placement (which handlers an attack, Ability, Trainer, Tool, Stadium or Energy may use).
2. Use the exact parameter shapes of the reference: every required field present, no extra fields, enums exact.
3. Placeholders: a card name used as a name key → "NAME:<the name exactly as printed in 「」>"; this card's definition id
   inside ids → "DEF". The attack of an attack unit has the key "a" and the Ability of an ability unit "b", so an effect id
   is "DEF:a:<entry key>" and an attack id "DEF:a". Evidence lists → "CARD_EVIDENCE". Ability usage keys: "cn:ability:<slug>" (the script sets the slug from the name).
4. Entry keys: short ASCII slugs (e.g. "draw", "damage", "burn"), unique within the unit.
5. Bracketed reminder text that restates a general rule (e.g. 「[备战宝可梦不计算弱点、抗性。]」) is part of the meaning of the
   clause it belongs to, not a separate effect.
6. Answer with exactly one JSON object {"results":[…]}: one result per input unit, in the same order, with the same uids.

=== REFERENCE ===
'''


def call(model, units, tries=6):
    env_path, deployment = MODELS[model]
    e = env(env_path)
    system = INSTRUCTIONS + open(REFERENCE, encoding='utf8').read()
    payload = [{k: u[k] for k in ('uid', 'kind', 'text', 'card', 'attack', 'ability') if k in u} for u in units]
    body = json.dumps({'model': deployment, 'messages': [{'role': 'system', 'content': system},
                                                         {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)}],
                       'max_completion_tokens': 32000, 'response_format': {'type': 'json_object'}}).encode()
    url = e['AOAI_ENDPOINT'].rstrip('/') + '/chat/completions'
    for i in range(tries):
        t = time.time()
        try:
            req = urllib.request.Request(url, body, {'api-key': e['FOUNDRY_KEY'], 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=900) as r:
                data = json.load(r)
            results = json.loads(data['choices'][0]['message']['content']).get('results') or []
            return {'results': results, 'deployment': deployment, 'prompt': PROMPT_VERSION, 'sec': round(time.time() - t, 1),
                    'usage': {k: data.get('usage', {}).get(k) for k in ('prompt_tokens', 'completion_tokens')}}
        except urllib.error.HTTPError as err:
            msg = err.read().decode(errors='replace')[:300]
            if err.code in (408, 429, 500, 502, 503, 504) and i < tries - 1:
                time.sleep(min(90, 5 * 2 ** i)); continue
            return {'error': f'HTTP {err.code}: {msg}'}
        except Exception as err:  # network hiccup or a non-JSON answer
            if i < tries - 1:
                time.sleep(5 * (i + 1)); continue
            return {'error': repr(err)[:300]}


def load_units(name):
    return [json.loads(l) for l in open(UNITS[name], encoding='utf8') if l.strip()]


def unit_of(line):
    return line.get('unit', line)


def out_path(model, uid, rnd=None):
    return os.path.join(OUT, 'out' if rnd is None else f'out-{rnd}', model, uid + '.json')


def latest_path(model, uid):
    """The unit's output from its latest round that has one (round 1 is out/)."""
    for r in reversed(ROUNDS):
        p = out_path(model, uid, r['round'])
        if os.path.exists(p): return p
    return out_path(model, uid)


def round_uids(rnd):
    spec = next((r for r in ROUNDS if r['round'] == rnd), None)
    if spec is None: sys.exit(f'Unknown round {rnd}; rounds are listed in scripts/effect-translation-rounds.json')
    return [json.loads(l)['uid'] for l in open(os.path.join(ROOT, spec['units']), encoding='utf8') if l.strip()]


def cmd_translate(a):
    units = [unit_of(l) for l in load_units(a.units)]
    if a.round:
        wanted = round_uids(a.round)
        by_uid = {u['uid']: u for u in units}
        missing = [uid for uid in wanted if uid not in by_uid]
        if missing: sys.exit(f'{len(missing)} round units are not in the {a.units} units, e.g. {missing[0]}')
        units = [by_uid[uid] for uid in wanted]
    todo = [u for u in units if not os.path.exists(out_path(a.model, u['uid'], a.round))]
    if a.limit: todo = todo[:a.limit]
    os.makedirs(os.path.dirname(out_path(a.model, 'x', a.round)), exist_ok=True)
    reference = hashlib.sha256(open(REFERENCE, 'rb').read()).hexdigest()
    batches = [todo[i:i + a.batch] for i in range(0, len(todo), a.batch)]
    lock, done, failed, started = threading.Lock(), [0], [0], time.time()
    print(f'{a.model}{" " + a.round if a.round else ""}: {len(todo)} units in {len(batches)} batches with {a.workers} workers', flush=True)

    def one(batch):
        r = call(a.model, batch)
        got = {x.get('uid'): x for x in r.get('results') or [] if isinstance(x, dict)}
        with lock:
            for u in batch:
                res = got.get(u['uid'])
                if res is None:
                    failed[0] += 1
                    with open(os.path.join(OUT, f'errors-{a.model}.jsonl'), 'a', encoding='utf8') as f:
                        f.write(json.dumps({'uid': u['uid'], 'round': a.round, 'error': r.get('error', 'no result for this unit')}, ensure_ascii=False) + '\n')
                    continue
                path = out_path(a.model, u['uid'], a.round)
                with open(path + '.tmp', 'w', encoding='utf8') as f:
                    json.dump({'uid': u['uid'], 'result': res, 'deployment': r.get('deployment'), 'prompt': PROMPT_VERSION,
                               **({'round': a.round, 'referenceSha256': reference} if a.round else {}),
                               'batch': {'size': len(batch), 'sec': r.get('sec'), 'usage': r.get('usage')}}, f, ensure_ascii=False)
                os.replace(path + '.tmp', path)
            done[0] += 1
            if done[0] % 10 == 0 or done[0] == len(batches):
                rate = done[0] / max(time.time() - started, 1) * 60
                print(f'  {done[0]}/{len(batches)} batches ({failed[0]} units failed), {rate:.1f}/min, '
                      f'eta {(len(batches) - done[0]) / max(rate, 0.01):.0f} min', flush=True)

    with ThreadPoolExecutor(a.workers) as pool:
        for f in as_completed([pool.submit(one, b) for b in batches]): f.result()


def usage_key(name):
    """An Ability's usage key: the pinyin slug of its printed name (the models' own romanizations are not reliable)."""
    import unicodedata
    from pypinyin import lazy_pinyin
    name = re.sub(r'\s+', '', unicodedata.normalize('NFKC', name or ''))
    slug = re.sub(r'[^a-z0-9]+', '-', '-'.join(lazy_pinyin(name)).lower()).strip('-')
    return f'cn:ability:{slug or "ability"}'


def normalize(unit, result):
    """Deterministic fixes of a model's result, applied the same way to both models: the usage key from the name."""
    if isinstance(result, dict) and isinstance(result.get('usage'), dict) and 'key' in result['usage'] and unit.get('ability'):
        result = {**result, 'usage': {**result['usage'], 'key': usage_key(unit['ability']['name'])}}
    return result


def results(model, units):
    out = {}
    for u in units:
        p = latest_path(model, u['uid'])
        if os.path.exists(p): out[u['uid']] = normalize(u, json.load(open(p, encoding='utf8'))['result'])
    return out


def kernel_check(units, res):
    """{uid: {valid, error}} from scripts/effect-validate.mjs."""
    lines = ''.join(json.dumps({'uid': u['uid'], 'unit': u, 'result': res[u['uid']]}, ensure_ascii=False) + '\n' for u in units if u['uid'] in res)
    p = subprocess.run(['node', os.path.join(ROOT, 'scripts', 'effect-validate.mjs')], input=lines, capture_output=True, text=True, check=True)
    return {x['uid']: x for x in map(json.loads, p.stdout.splitlines())}


def canonical(result):
    """A result without the free choices (entry keys, the attack's own key in ids, usage key names) for comparison."""
    def norm(v):
        if isinstance(v, dict): return {k: norm(x) for k, x in sorted(v.items()) if k != 'key' or not isinstance(x, str) or not x.startswith('cn:')}
        if isinstance(v, list): return [norm(x) for x in v]
        if isinstance(v, str) and (v == 'DEF' or v.startswith('DEF:')): return re.sub(r'^DEF(:[^:]+)?', 'DEF:*', v)
        return v
    if not result or result.get('status') != 'ok': return {'status': (result or {}).get('status')}
    r = {k: v for k, v in result.items() if k not in ('uid', 'reasons', 'notes')}
    for k in ('effects', 'rules'):
        if k in r: r[k] = [[e[1], e[2]] for e in r[k] if isinstance(e, list) and len(e) == 3]
    if isinstance(r.get('usage'), dict): r['usage'] = {**r['usage'], 'key': '*'}
    return json.loads(json.dumps(norm(r), sort_keys=True))


def cmd_check(a):
    units = [unit_of(l) for l in load_units(a.units)]
    summary = {}
    with open(os.path.join(OUT, f'checks-{a.units}.jsonl'), 'w', encoding='utf8') as f:
        res = {m: results(m, units) for m in MODELS}
        checks = {m: kernel_check(units, res[m]) for m in MODELS}
        for u in units:
            row = {'uid': u['uid'], 'kind': u['kind']}
            for m in MODELS:
                r = res[m].get(u['uid'])
                row[m] = None if r is None else {'status': r.get('status'), 'valid': checks[m].get(u['uid'], {}).get('valid', False),
                                                  'error': checks[m].get(u['uid'], {}).get('error')}
            both = [res[m].get(u['uid']) for m in MODELS]
            row['agree'] = all(both) and canonical(both[0]) == canonical(both[1])
            row['accepted'] = row['agree'] and all(row[m] and row[m]['valid'] for m in MODELS)
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
            key = 'accepted' if row['accepted'] else 'both-unsupported' if all(r and r.get('status') == 'unsupported' for r in both) else 'review'
            summary[key] = summary.get(key, 0) + 1
    print(f'{len(units)} units: ' + ', '.join(f'{k} {v}' for k, v in sorted(summary.items())))
    for m in MODELS:
        ok = sum(1 for u in units if (res[m].get(u['uid']) or {}).get('status') == 'ok')
        valid = sum(1 for u in units if checks[m].get(u['uid'], {}).get('valid'))
        print(f'  {m}: {len(res[m])} answered, {ok} translated, {valid} pass the kernel checks')


def cmd_score(a):
    gold = load_units('gold')
    units = [unit_of(l) for l in gold]
    for m in MODELS:
        res = results(m, units)
        if not res: continue
        checks = kernel_check(units, res)
        exact = valid = unsupported = 0
        misses = []
        for g in gold:
            r = res.get(g['uid'])
            if not r: continue
            if r.get('status') == 'unsupported': unsupported += 1
            if checks.get(g['uid'], {}).get('valid'): valid += 1
            if canonical(r) == canonical(g['expected']): exact += 1
            else: misses.append((g, r))
        print(f'{m}: {len(res)}/{len(gold)} gold units answered; {exact} match the reviewed entries, {valid} pass the kernel checks, '
              f'{unsupported} called unsupported')
        if a.verbose:
            for g, r in misses:
                print(f"  MISS {g['card']} {g['unit']['kind']} {g['unit']['text'][:60]}")
                print('    expected', json.dumps(canonical(g['expected']), ensure_ascii=False)[:600])
                print('    got     ', json.dumps(canonical(r), ensure_ascii=False)[:600])


def cmd_status(a):
    units = [unit_of(l) for l in load_units(a.units)]
    for m in MODELS:
        print(f'  {m}: {len(results(m, units))}/{len(units)}')


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    t = sub.add_parser('translate'); t.add_argument('--model', choices=MODELS, required=True); t.add_argument('--units', choices=UNITS, default='corpus')
    t.add_argument('--batch', type=int, default=8); t.add_argument('--workers', type=int, default=8); t.add_argument('--limit', type=int, default=0)
    t.add_argument('--round', default=None)
    c = sub.add_parser('check'); c.add_argument('--units', choices=UNITS, default='corpus')
    s = sub.add_parser('score'); s.add_argument('-v', '--verbose', action='store_true')
    st = sub.add_parser('status'); st.add_argument('--units', choices=UNITS, default='corpus')
    a = p.parse_args()
    {'translate': cmd_translate, 'check': cmd_check, 'score': cmd_score, 'status': cmd_status}[a.cmd](a)
