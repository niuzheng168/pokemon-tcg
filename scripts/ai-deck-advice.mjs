// Simulated deck-building advice (M7): the changes the metagame suggests for a list (ai/deck-advice.mjs: a core card it
// lacks or plays fewer of, in place of the card its archetype plays least), each played against the training pool (or
// one opponent deck) from both seats on the same deals as the list unchanged, both piloted by the policy with the
// list's plan. Prints each change's paired gain in win rate with its standard error, best first.
//   node scripts/ai-deck-advice.mjs <pool deck id> [--against <pool deck id>] [--seeds 20] [--workers N] [--top 8]
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { DECK_POOL, poolDeckList } from '../ai/decks.mjs';
import { policyAgent, playGame } from '../ai/play.mjs';
import { deckAdvice } from '../ai/deck-advice.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });
const expand = (cards) => cards.flatMap(([p, n]) => Array(n).fill(p));

// A worker plays { list, opponent, seed, first, key } → { key, opponent, seed, first, won }.
async function serve() {
  const release = await loadRelease();
  parentPort.on('message', async (jobs) => {
    const out = [];
    for (const job of jobs) {
      const decks = job.first ? [poolDeckList(job.opponent), job.list] : [job.list, poolDeckList(job.opponent)];
      let won = 0.5;
      try {
        const { game, catalog } = await createReviewedGame({ release, decks, seed: [job.seed + 1, 3, 5, 7], format: FORMAT, matchMode: 'normal' });
        const agents = [policyAgent(catalog, { seed: [job.seed, 1, 2, 3] }), policyAgent(catalog, { seed: [job.seed, 4, 5, 6] })];
        const r = playGame(new Simulation(game.snapshot(), catalog), agents, { seed: [job.seed, job.first, 9, 9] });
        won = r.winner === null ? 0.5 : Number(r.winner === job.first);
      } catch { /* refused: half */ }
      out.push({ key: job.key, opponent: job.opponent, seed: job.seed, first: job.first, won });
    }
    parentPort.postMessage(out);
  });
}

if (isMainThread) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { against: { type: 'string' }, seeds: { type: 'string', default: '20' },
    workers: { type: 'string' }, top: { type: 'string', default: '8' } } });
  const id = positionals[0], deck = DECK_POOL[id];
  if (!deck) throw new Error('Usage: node scripts/ai-deck-advice.mjs <pool deck id> [--against id]');
  const release = await loadRelease(), meta = JSON.parse(readFileSync(new URL('../ai/meta-decks.json', import.meta.url), 'utf8'));
  const catalog = await release.catalogFor([...new Set([...deck.cards.map(([p]) => p), ...meta.printings])]);
  const advice = deckAdvice(catalog, deck.cards);
  if (!advice.archetype) { console.log('No tournament archetype close enough to compare with.'); process.exit(0); }
  // A printing for each name the tournament lists play.
  const printingOf = new Map();
  for (const p of meta.printings) { const d = catalog.definitionFor(p); if (!printingOf.has(d.nameKey)) printingOf.set(d.nameKey, p); }
  const nameKeyOf = (p) => catalog.definitionFor(p).nameKey, nameOf = (p) => catalog.definitionFor(p).name;
  // The card to take out: the one of this list its archetype plays least (Basic Energy last).
  const shares = new Map(advice.rare.map((c) => [c.nameKey, c.share]));
  const removable = [...deck.cards].filter(([p]) => !(catalog.definitionFor(p).kind === 'energy' && catalog.definitionFor(p).mechanics.category === 'basic'))
    .sort((a, b) => (shares.get(nameKeyOf(a[0])) ?? 1) - (shares.get(nameKeyOf(b[0])) ?? 1));
  const changes = [];
  for (const c of [...advice.missing, ...advice.fewer]) {
    const add = printingOf.get(c.nameKey);
    if (!add) continue;
    for (const [out] of removable.slice(0, 2)) {
      if (nameKeyOf(out) === c.nameKey) continue;
      const cards = new Map(deck.cards.map(([p, n]) => [p, n]));
      cards.set(out, cards.get(out) - 1); if (!cards.get(out)) cards.delete(out);
      cards.set(add, (cards.get(add) ?? 0) + 1);
      changes.push({ key: `+${c.name} −${nameOf(out)}`, list: expand([...cards]) });
    }
  }
  if (!changes.length) { console.log('The list already plays what its archetype nearly always plays.'); process.exit(0); }
  const opponents = values.against ? [values.against] : Object.keys(DECK_POOL), seeds = Number(values.seeds);
  const jobs = [{ key: 'unchanged', list: expand(deck.cards) }, ...changes].flatMap((v) => opponents.flatMap((opponent) =>
    Array.from({ length: seeds }, (_, s) => [0, 1].map((first) => ({ key: v.key, list: v.list, opponent, seed: s, first }))).flat()));
  const workers = Number(values.workers ?? availableParallelism() - 1);
  const results = await new Promise((resolve) => {
    const all = [], chunks = [];
    for (let i = 0; i < jobs.length; i += 25) chunks.push(jobs.slice(i, i + 25));
    let next = 0, open = 0;
    for (let w = 0; w < workers; w++) {
      const worker = new Worker(new URL(import.meta.url));
      const feed = () => { if (next < chunks.length) { open++; worker.postMessage(chunks[next++]); } else { worker.terminate(); if (!open) resolve(all); } };
      worker.on('message', (out) => { all.push(...out); open--; feed(); });
      feed();
    }
  });
  const pairKey = (r) => `${r.opponent}/${r.seed}/${r.first}`, base = new Map(results.filter((r) => r.key === 'unchanged').map((r) => [pairKey(r), r.won]));
  const rate = (key) => results.filter((r) => r.key === key).reduce((a, r) => a + r.won, 0) / results.filter((r) => r.key === key).length;
  console.log(`${deck.name}: ${advice.archetype.name} (${advice.archetype.lists} lists); unchanged ${(100 * rate('unchanged')).toFixed(1)}% over ${base.size} games` +
    `${values.against ? ` against ${values.against}` : ' against the pool'}`);
  const rows = changes.map(({ key }) => {
    const diffs = results.filter((r) => r.key === key).map((r) => r.won - base.get(pairKey(r)));
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length, se = Math.sqrt(diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (diffs.length - 1) / diffs.length);
    return { key, mean, se };
  }).sort((a, b) => b.mean - a.mean);
  for (const r of rows.slice(0, Number(values.top))) console.log(`${(100 * r.mean >= 0 ? '+' : '') + (100 * r.mean).toFixed(1)} ±${(100 * r.se).toFixed(1)}  ${r.key}`);
  process.exit(0);
} else await serve();
