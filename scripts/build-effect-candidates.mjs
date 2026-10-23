// Local authoring only: no model/API calls. Re-check both raw results, match a separate semantic template — or, for an
// agreed program no template covers, a committed per-unit semantic review (scripts/effect-review-certificates.mjs) —
// then publish a small, reproducible snapshot. The installed release is built only from committed machine definitions.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { unitOf, clean } from './effect-units.mjs';
import { modelOutputPath } from './effect-translation-rounds.mjs';
import { certifyCandidate, canonicalEffectResult } from './effect-certificates.mjs';
import { reviewLedger, reviewedConsensusProof, DISAGREEMENT_FAMILY } from './effect-review-certificates.mjs';
import { check } from './effect-validate.mjs';
import * as reviewed from '../catalog/zh-CN/V20261019/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), base = join(root, '.data/effect-translation');
const { values: opt } = parseArgs({ options: { publish: { type: 'boolean', default: false },
  out: { type: 'string', default: join(base, 'certified.json') } } });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const text = await readFile(join(base, 'corpus.jsonl'), 'utf8'), units = text.trim().split('\n').map(JSON.parse);
const reviews = reviewLedger(JSON.parse(await readFile(join(root, 'catalog/zh-CN/V20261019/library/machine/effect-reviews.json'), 'utf8')));
const keys = new Map();
for (const d of reviewed.DEFINITIONS) for (const a of d.mechanics.abilities ?? []) if (a.usage?.key) {
  const name = clean(a.name), existing = keys.get(name);
  if (existing && existing !== a.usage.key) throw new Error(`Conflicting reviewed Ability keys: ${name}`);
  keys.set(name, a.usage.key);
}
const candidates = [], withheld = {}, families = {};
// The review covers exactly one program: the agreed one, or (models disagreeing) the one model program it judged.
function normalized(unit, row, key) {
  const x = structuredClone(row.result);
  if (unit.kind === 'ability' && x.usage?.key) x.usage.key = key;
  return x;
}
function consensus(unit, rows, key) {
  const [a, b] = rows.map((r) => normalized(unit, r, key));
  if (canonicalEffectResult(a) === canonicalEffectResult(b)) return reviewedConsensusProof(unit, a, reviews);
  for (const [i, x] of [a, b].entries()) {
    const proof = reviewedConsensusProof(unit, x, reviews, DISAGREEMENT_FAMILY);
    if (proof) return { ...proof, reviewedModel: ['astra', 'sol'][i] };
  }
  return null;
}
for (const unit of units) {
  const { uid, ...identity } = unit;
  if (uid !== unitOf(identity).uid) throw new Error(`Stale unit identity: ${unit.uid}`);
  const raw = await Promise.all(['astra', 'sol'].map((model) => readFile(modelOutputPath(base, model, unit.uid), 'utf8')));
  const rows = raw.map(JSON.parse);
  if (rows.some((r) => r.uid !== unit.uid || r.result.uid !== unit.uid)) throw new Error(`Mismatched model UID: ${unit.uid}`);
  const key = unit.kind === 'ability' ? keys.get(clean(unit.ability.name)) ?? `cn:ability:machine-${sha(clean(unit.ability.name)).slice(0, 20)}` : undefined;
  const certificate = certifyCandidate(unit, rows[0].result, rows[1].result, key) ?? consensus(unit, rows, key);
  if (!certificate) { withheld['not independently certified'] = (withheld['not independently certified'] ?? 0) + 1; continue; }
  // A disagreement certificate rests on one model's program; only that one must pass the kernel checks.
  const failed = (certificate.reviewedModel ? [certificate.result] : rows.map((r) => normalized(unit, r, key)))
    .map((x) => check(unit, x)).find((c) => !c.valid);
  // A certificate never admits a program the current kernel checks refuse (e.g. a once-per-game rule the text does not print).
  if (failed) { withheld[`kernel check: ${failed.error.slice(0, 80)}`] = (withheld[`kernel check: ${failed.error.slice(0, 80)}`] ?? 0) + 1; continue; }
  candidates.push({ unit, ...certificate, models: rows.map((r, i) => ({
    alias: ['astra', 'sol'][i], prompt: r.prompt, ...(r.round ? { round: r.round } : {}), resultSha256: sha(raw[i]),
  })) });
  families[certificate.family] = (families[certificate.family] ?? 0) + 1;
}
const output = { schema: 'cn-certified-effects/1', corpusSha256: sha(text),
  certificateTests: ['tests/effect-certificates.test.mjs', 'tests/reviewed-effect-certificates.test.mjs',
    'tests/effect-mechanism-certificates.test.mjs', 'tests/effect-review-certificates.test.mjs', 'tests/cn-cards/machine-effects.test.mjs'],
  units: candidates.sort((a, b) => a.unit.uid.localeCompare(b.unit.uid)), families, withheld };
for (const path of new Set([opt.out, ...(opt.publish ? [join(root, 'catalog/zh-CN/V20261019/library/machine/effects.json')] : [])])) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(output) + '\n');
}
console.log(JSON.stringify({ certified: candidates.length, families, withheld, out: opt.out }, null, 2));
