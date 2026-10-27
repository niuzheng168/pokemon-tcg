// Each deck its own way of playing (M7): the plan rules of the policy (policy.mjs, plan*) help some decks and hurt others
// (猛雷鼓 lost 12 points with all of them on, 皮皮 gained 10), so every deck of the training pool tries a few sets of
// them, playing every pool deck (the policy without plan rules) from both seats on the same deals, and keeps the set
// that beats playing without them by at least one standard error of the paired difference; a second run on new deals
// checks the choice. The result, ai/deck-weights.json, is data the deck plans read (deck-plan.mjs): a list found there
// (or a list of the same archetype) plays with its own rule weights. `--stage strategy` then tries the written strategy
// (deck-plan.mjs strategyOf, by a language model) on top of each deck's chosen rules the same way, its yardstick being
// those rules alone.
//   node scripts/ai-deck-tune.mjs [--decks id,id] [--seeds 20] [--workers N] [--out ai/deck-weights.json] [--stage rules|strategy]
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { DECK_POOL, poolDeckList } from '../ai/decks.mjs';
import { policyAgent, playGame } from '../ai/play.mjs';
import { deckPlan } from '../ai/deck-plan.mjs';
import { listKey } from '../ai/meta.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });
const OFF = { planPiece: 0, planBench: 0, planOffBench: 0, planEvolve: 0, planAttach: 0, planAmmo: 0, planPromote: 0 };
const STRUCTURE = { planBench: 20, planEvolve: 10, planPromote: 200, planAmmo: 1 };
/** The sets of plan rules a deck tries (the values the A/B tests used); `none` is the yardstick. */
export const VARIANTS = Object.freeze({
  none: OFF,
  all: { ...OFF, ...STRUCTURE, planPiece: 25, planAttach: 10 },
  piece: { ...OFF, planPiece: 25 },
  attach: { ...OFF, planAttach: 10 },
  structure: { ...OFF, ...STRUCTURE },
  'structure+piece': { ...OFF, ...STRUCTURE, planPiece: 25 },
  'structure+attach': { ...OFF, ...STRUCTURE, planAttach: 10 },
  'piece+attach': { ...OFF, planPiece: 25, planAttach: 10 },
});
const ORDERS = { stratOpening: 400, stratBench: 20, stratSearch: 20, stratKeep: 15, stratDiscard: 20, stratPromote: 100, stratAttach: 15 };
/** What the written strategy adds (the values the arena tests used): its attackers and goal board, its orders, or both. */
export const STRATEGY_VARIANTS = Object.freeze({ none: {}, structure: { strategy: 1 }, orders: ORDERS, all: { strategy: 1, ...ORDERS } });

// A worker plays the games it is sent: { deck, variant, weights, opponent, seed, first } → { ...job, won }.
async function serve() {
  const release = await loadRelease();
  parentPort.on('message', async (jobs) => {
    const out = [];
    for (const job of jobs) {
      const decks = job.first ? [poolDeckList(job.opponent), poolDeckList(job.deck)] : [poolDeckList(job.deck), poolDeckList(job.opponent)];
      let won = 0.5;
      try {
        const { game, catalog } = await createReviewedGame({ release, decks, seed: [job.seed + 1, 3, 5, 7], format: FORMAT, matchMode: 'normal' });
        const me = policyAgent(catalog, { weights: job.weights, seed: [job.seed, 1, 2, 3] });
        const them = policyAgent(catalog, { weights: OFF, seed: [job.seed, 4, 5, 6] });
        const r = playGame(new Simulation(game.snapshot(), catalog), job.first ? [them, me] : [me, them], { seed: [job.seed, job.first, 9, 9] });
        won = r.winner === null ? 0.5 : Number(r.winner === job.first);
      } catch { /* an engine refusal: half */ }
      out.push({ deck: job.deck, variant: job.variant, opponent: job.opponent, seed: job.seed, first: job.first, won });
    }
    parentPort.postMessage(out);
  });
}

if (isMainThread) {
  const { values } = parseArgs({ options: { decks: { type: 'string' }, seeds: { type: 'string', default: '20' }, workers: { type: 'string' },
    out: { type: 'string', default: new URL('../ai/deck-weights.json', import.meta.url).pathname }, stage: { type: 'string', default: 'rules' } } });
  const decks = values.decks ? values.decks.split(',') : Object.keys(DECK_POOL), opponents = Object.keys(DECK_POOL), seeds = Number(values.seeds);
  const workers = Number(values.workers ?? availableParallelism() - 1), started = performance.now();
  const pool = Array.from({ length: workers }, () => new Worker(new URL(import.meta.url)));
  // Every job list in chunks, spread over the workers; resolves with all results.
  const run = (jobs) => new Promise((resolve) => {
    const results = [], chunks = [];
    for (let i = 0; i < jobs.length; i += 25) chunks.push(jobs.slice(i, i + 25));
    let next = 0, open = 0;
    const feed = (w) => { if (next < chunks.length) { open++; w.postMessage(chunks[next++]); } else if (!open) resolve(results); };
    for (const w of pool) {
      w.removeAllListeners('message');
      w.on('message', (out) => { results.push(...out); open--; if (next >= chunks.length && !open) resolve(results); else feed(w); });
      feed(w);
    }
  });
  const out = existsSync(values.out) ? JSON.parse(readFileSync(values.out, 'utf8')) : { decks: {} };
  // A variant's weights: a set of plan rules, or (stage strategy) the deck's chosen rules with a strategy variant.
  const strategy = values.stage === 'strategy', variantsOf = strategy ? STRATEGY_VARIANTS : VARIANTS;
  const weightsOf = (deck, variant) => (strategy ? { ...(out.decks[deck]?.rules?.weights ?? out.decks[deck]?.weights ?? {}), ...STRATEGY_VARIANTS[variant] } : VARIANTS[variant]);
  const jobsFor = (deck, variants, seedBase) => variants.flatMap((variant) => opponents.flatMap((opponent) =>
    Array.from({ length: seeds }, (_, s) => [0, 1].map((first) => ({ deck, variant, weights: weightsOf(deck, variant), opponent, seed: seedBase + s, first }))).flat()));
  // Paired: each variant against none on the same opponent, deal and seat.
  const compare = (results, variant) => {
    const key = (r) => `${r.opponent}/${r.seed}/${r.first}`, base = new Map(results.filter((r) => r.variant === 'none').map((r) => [key(r), r.won]));
    const diffs = results.filter((r) => r.variant === variant).map((r) => r.won - base.get(key(r)));
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length, sd = Math.sqrt(diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (diffs.length - 1));
    const rate = results.filter((r) => r.variant === variant).reduce((a, r) => a + r.won, 0) / diffs.length;
    return { rate: +rate.toFixed(4), gain: +mean.toFixed(4), se: +(sd / Math.sqrt(diffs.length)).toFixed(4) };
  };
  const release = await loadRelease();
  for (const deck of decks) {
    const results = await run(jobsFor(deck, Object.keys(variantsOf), 0));
    const table = Object.fromEntries(Object.keys(variantsOf).map((v) => [v, compare(results, v)]));
    const best = Object.entries(table).filter(([v, t]) => v !== 'none' && t.gain > t.se).sort((a, b) => b[1].gain - a[1].gain)[0]?.[0] ?? 'none';
    // The choice again on new deals (its gain above is the best of several, so it reads high).
    const check = best === 'none' ? null : compare(await run(jobsFor(deck, ['none', best], 1000)), best);
    const chosen = check && check.gain > 0 ? best : 'none';
    const catalog = await release.catalogFor(DECK_POOL[deck].cards.map(([p]) => p)), plan = deckPlan(catalog, DECK_POOL[deck].cards);
    const games = results.length + (check ? 2 * opponents.length * seeds * 2 : 0);
    if (strategy) {
      // The rules stage's choice stays as it was; the weights the deck plays with gain the strategy's.
      const rules = out.decks[deck].rules ?? { chosen: out.decks[deck].chosen, weights: out.decks[deck].weights };
      out.decks[deck] = { ...out.decks[deck], rules, strategy: { chosen, table, check, games }, weights: weightsOf(deck, chosen) };
    } else out.decks[deck] = { list: listKey(DECK_POOL[deck].cards), archetype: plan.archetype, chosen, weights: VARIANTS[chosen], table, check, games };
    writeFileSync(values.out, `${JSON.stringify(out, null, 1)}\n`);
    console.log(`${deck.padEnd(28)} ${chosen.padEnd(17)} ${Object.entries(table).map(([v, t]) => `${v} ${(100 * t.gain).toFixed(1)}`).join('  ')}` +
      `${check ? `  | check ${best} ${(100 * check.gain).toFixed(1)}±${(100 * check.se).toFixed(1)}` : ''}  ${((performance.now() - started) / 60000).toFixed(1)} min`);
  }
  process.exit(0);
} else await serve();
