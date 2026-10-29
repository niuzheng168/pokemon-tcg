// Check the AI's training decks (ai/training-decks.json): 60 printings of the reviewed release's pool each, legal in the
// format they name (the same check as the deck builder's), with a source; and the ids unique among the release's
// preset decks too, except a list the release offers as a preset under the same id (the table's decks), which must be
// that preset's list. Prints each deck's implementation tiers.
//   node scripts/ai-training-decks.mjs
import { readFileSync } from 'node:fs';
import { loadRelease } from '../server/catalog.mjs';
import { checkIndexedDeck } from '../public/deck-check.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const release = await loadRelease(), index = await release.index();
const byId = new Map(index.entries.map((e) => [e.printingId, e]));
const presets = new Map(read('../public/data/cn/V20261019/decks.json').decks.map((d) => [d.id, d]));
const listKey = (cards) => cards.map(([p, n]) => `${p}×${n}`).sort().join();
const { decks } = read('../ai/training-decks.json'), problems = [], seen = new Set();
for (const d of decks) {
  const issues = [], size = d.cards.reduce((n, [, k]) => n + k, 0), preset = presets.get(d.id);
  if (seen.has(d.id)) issues.push('duplicate id');
  else if (preset && listKey(preset.cards) !== listKey(d.cards)) issues.push('not the list of the preset deck of its id');
  seen.add(d.id);
  if (!d.name || !['tournament', 'starter'].includes(d.kind) || !d.source?.url || !d.source?.retrievedOn) issues.push('name, kind or source missing');
  if (size !== 60) issues.push(`${size} cards`);
  const unknown = d.cards.filter(([p]) => !byId.has(p)).map(([p]) => p);
  if (unknown.length) issues.push(`not in the pool: ${unknown.join(', ')}`);
  else {
    const check = await checkIndexedDeck(release, index, d.cards, d.format, null);
    if (!check.legal) issues.push(...check.issues);
  }
  const tiers = d.cards.reduce((t, [p, k]) => { const tier = byId.get(p)?.tier ?? '?'; return { ...t, [tier]: (t[tier] ?? 0) + k }; }, {});
  console.log(`${d.id.padEnd(30)} ${d.kind.padEnd(10)} ${JSON.stringify(tiers)}${issues.length ? `  ✗ ${issues.join(' | ')}` : ''}`);
  if (issues.length) problems.push(d.id);
}
console.log(`${decks.length} decks, ${problems.length} with problems`);
process.exitCode = problems.length ? 1 : 0;
