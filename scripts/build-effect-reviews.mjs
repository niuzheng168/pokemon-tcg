// Local authoring only: turn the per-unit semantic review of agreed effect programs (.data/effect-review/batches and
// results, procedure in docs/rules/zh-CN/V20261019/EFFECT-REVIEW.md) into the committed ledger
// catalog/zh-CN/V20261019/library/machine/effect-reviews.json. Planted decoys are scored and never recorded as reviews.
//   node scripts/build-effect-reviews.mjs --key <decoy key json> [--publish]
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { clean } from './effect-units.mjs';
import { programSha256, reviewLedger, inexpressible, REVIEW_SCHEMA } from './effect-review-certificates.mjs';
import * as reviewed from '../catalog/zh-CN/V20261019/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), base = join(root, '.data/effect-review');
const { values: opt } = parseArgs({ options: { key: { type: 'string' }, publish: { type: 'boolean', default: false } } });
if (!opt.key) throw new Error('--key (the decoy key, kept outside the reviewers\' directory) is required.');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const decoys = JSON.parse(await readFile(opt.key, 'utf8'));
const keys = new Map();
for (const d of reviewed.DEFINITIONS) for (const a of d.mechanics.abilities ?? []) if (a.usage?.key) keys.set(clean(a.name), a.usage.key);

const reviews = [], score = { planted: 0, caught: 0 }, verdicts = {};
for (const file of (await readdir(join(base, 'batches'))).sort()) {
  const batch = JSON.parse(await readFile(join(base, 'batches', file), 'utf8'));
  const results = new Map(JSON.parse(await readFile(join(base, 'results', file.replace('batch', 'result')), 'utf8'))
    .map((r) => [r.uid, r]));
  if (results.size !== batch.length || batch.some((it) => !results.has(it.uid))) throw new Error(`Incomplete review: ${file}`);
  for (const item of batch) {
    let { verdict, reason } = results.get(item.uid);
    if (Object.hasOwn(decoys, item.uid)) {
      score.planted++;
      if (verdict !== 'correct') score.caught++;
      continue;
    }
    // The reviewed program with the deterministic usage key the certificate builder uses.
    const program = { status: 'ok', ...structuredClone(item.program) };
    if (item.kind === 'ability' && program.usage?.key)
      program.usage.key = keys.get(clean(item.ability.name)) ?? `cn:ability:machine-${sha(clean(item.ability.name)).slice(0, 20)}`;
    // One reviewer caught these classes where another passed them: apply the finding to every unit alike.
    const issue = inexpressible(item, program);
    if (issue && verdict === 'correct') { verdict = 'wrong'; reason = `一致性检查：${issue}`; }
    reviews.push({ uid: item.uid, verdict, ...(verdict !== 'correct' && reason ? { reason } : {}), programSha256: programSha256(program) });
    verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
  }
}
const ledger = { schema: REVIEW_SCHEMA, reviewer: 'claude-opus-5.5', reviewedOn: '2026-10-22',
  procedure: 'docs/rules/zh-CN/V20261019/EFFECT-REVIEW.md', decoys: score, verdicts,
  reviews: reviews.sort((a, b) => a.uid.localeCompare(b.uid)) };
reviewLedger(ledger);
const out = opt.publish ? join(root, 'catalog/zh-CN/V20261019/library/machine/effect-reviews.json') : join(base, 'effect-reviews.json');
await writeFile(out, JSON.stringify(ledger, null, 0) + '\n');
console.log(JSON.stringify({ reviews: reviews.length, verdicts, decoys: score, out }));
