// Two AI players over many games with the reviewed CN decks: who wins, with a 95% interval, and how long each thinks.
//   node scripts/ai-arena.mjs <agentA> <agentB> [games=12] [workers=4] [first=0] [--pool] [--sprt=0.5,0.53] [--swap-decks]
// (first: the number of the first game, for more games with other seeds than an earlier run; --pool: decks drawn from
// the whole training pool, ai/decks.mjs, instead of the three preset decks; --sprt=p0,p1: a sequential test, stopping as
// soon as A's score is shown to be p0 or less, or p1 or more (5% errors each way), games then being the most to play)
// Agents (ai/agents.mjs): level:1 … level:5, legacy, policy:<noise>, search:<option>=<value>,… (e.g. search:worlds=4,horizon=turn).
// Seats alternate and every deck pairing is played both ways, so neither side keeps the first turn or a deck.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { deckList, RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { makeAgent } from '../ai/agents.mjs';
import { poolDeckList, poolPair } from '../ai/decks.mjs';
import { playGame } from '../ai/play.mjs';
import { metaPrintings, listKey } from '../ai/meta.mjs';

const DECKS = ['raging-bolt-679141', 'csvh1c-pikachu', 'dragapult-676815'];
const PAIRS = [[0, 1], [1, 2], [2, 0], [0, 0], [1, 1], [2, 2]];
const FORMAT = Object.freeze({ ...RULESET, id: 'open' });

async function play({ games, specs, pool, swap }) {
  const release = await loadRelease();
  for (const g of games) {
    // Game g and g+1 share decks and seed with the seats swapped; with --swap-decks, games 4k…4k+3 share the deal and the
    // two players also swap decks (4k+2, 4k+3), so each player pilots each deck of the pairing.
    const deal = swap ? g >> 2 : g >> 1, dealt = pool ? poolPair(deal) : PAIRS[deal % PAIRS.length].map((i) => DECKS[i]);
    const ids = swap && (g >> 1) & 1 ? [...dealt].reverse() : dealt;
    const pair = pool ? ids.map(poolDeckList) : ids.map(deckList);
    const seed = [deal + 11, 7, 3, 5], aFirst = g % 2 === 0, decks = aFirst ? pair : [...pair].reverse();
    const named = aFirst ? ids.join(' vs ') : [...ids].reverse().join(' vs ');
    const { game, catalog } = await createReviewedGame({ release, decks, seed, format: FORMAT, matchMode: 'normal' });
    // A player guessing from the metagame gets a catalog with its printings, and the metagame without its opponent's list.
    const meta = specs.some((s) => s.includes('opponent=meta')) ? await release.catalogFor([...new Set([...decks.flat(), ...metaPrintings()])]) : null;
    const listOf = (i) => listKey(Object.entries(Object.groupBy(pair[i], (p) => p)).map(([p, l]) => [p, l.length]));
    const a = makeAgent(specs[0], catalog, [g + 1, 2, 3, 4], { metaCatalog: meta, exclude: [listOf(1)] });
    const b = makeAgent(specs[1], catalog, [g + 101, 2, 3, 4], { metaCatalog: meta, exclude: [listOf(0)] });
    const seats = aFirst ? [a, b] : [b, a];
    try {
      const r = playGame(new Simulation(game.snapshot(), catalog), seats, { seed: [g + 7, 1, 1, 1] });
      const winner = r.winner === null ? null : (r.winner === 0) === aFirst ? 'A' : 'B';
      parentPort.postMessage({ g, winner, reason: r.reason, steps: r.steps, ms: aFirst ? r.ms : [...r.ms].reverse(), decks: named });
    } catch (error) {
      // A crash is reported with its game and counted as undecided; the other games go on.
      parentPort.postMessage({ g, winner: null, reason: `error: ${error.stack.split('\n').slice(0, 3).join(' | ')}`, steps: 0, ms: [0, 0], decks: named });
    }
  }
}

function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - w) / d, (c + w) / d];
}

if (isMainThread) {
  const args = process.argv.slice(2), pool = args.includes('--pool'), swap = args.includes('--swap-decks');
  const sprt = args.find((a) => a.startsWith('--sprt='))?.slice(7).split(',').map(Number) ?? null;
  const [specA, specB, games = '12', workers = '4', first = '0'] = args.filter((a) => !a.startsWith('--'));
  if (!specA || !specB) throw new Error('Usage: node scripts/ai-arena.mjs <agentA> <agentB> [games] [workers] [first] [--pool]');
  const n = Number(games), w = Math.min(Number(workers), n, availableParallelism()), results = [];
  const started = performance.now();
  const report = (extra = {}) => {
    const aWins = results.filter((r) => r.winner === 'A').length, bWins = results.filter((r) => r.winner === 'B').length;
    const decided = aWins + bWins, [lo, hi] = wilson(aWins, decided);
    const think = (i) => results.reduce((t, r) => t + r.ms[i], 0) / results.reduce((t, r) => t + r.steps / 2, 0);
    console.log(JSON.stringify({ A: specA, B: specB, games: results.length, aWins, bWins, undecided: results.length - decided,
      aRate: decided ? +(aWins / decided).toFixed(3) : null, ci95: [+lo.toFixed(3), +hi.toFixed(3)],
      msPerMove: { A: Math.round(think(0)), B: Math.round(think(1)) }, wallMinutes: +((performance.now() - started) / 60000).toFixed(1), ...extra }));
  };
  // The sequential test over deals (a game and its seats swapped: one sample, A's mean score), normal approximation:
  // LLR = (p1 − p0) / variance × (Σ score − deals × (p0 + p1) / 2), stopping at ln(β / (1 − α)) or ln((1 − β) / α).
  const halves = new Map(), deals = [];
  const llr = () => {
    if (deals.length < 8) return 0;
    const mean = deals.reduce((a, b) => a + b, 0) / deals.length;
    const variance = Math.max(1e-4, deals.reduce((a, x) => a + (x - mean) ** 2, 0) / (deals.length - 1));
    return (sprt[1] - sprt[0]) / variance * (deals.reduce((a, b) => a + b, 0) - deals.length * (sprt[0] + sprt[1]) / 2);
  };
  const [LOWER, UPPER] = [Math.log(0.05 / 0.95), Math.log(0.95 / 0.05)];
  await Promise.all(Array.from({ length: w }, (_, i) => new Promise((resolve, reject) => {
    const mine = Array.from({ length: n }, (_, g) => g + Number(first)).filter((g) => g % w === i);
    new Worker(new URL(import.meta.url), { workerData: { games: mine, specs: [specA, specB], pool, swap } })
      .on('message', (r) => {
        results.push(r);
        console.log(`game ${String(r.g).padStart(3)}: ${r.winner ?? '-'} (${r.reason}, ${r.steps} steps) A ${(r.ms[0] / 1000).toFixed(1)}s B ${(r.ms[1] / 1000).toFixed(1)}s, ${r.decks}`);
        if (!sprt) return;
        const deal = r.g >> 1, score = r.winner === 'A' ? 1 : r.winner === 'B' ? 0 : 0.5;
        if (!halves.has(deal)) { halves.set(deal, score); return; }
        deals.push((halves.get(deal) + score) / 2);
        const value = llr();
        if (value <= LOWER || value >= UPPER) {
          report({ sprt: { p0: sprt[0], p1: sprt[1], deals: deals.length, llr: +value.toFixed(2), accepted: value >= UPPER ? `A ≥ ${sprt[1]}` : `A ≤ ${sprt[0]}` } });
          process.exit(0);
        }
      })
      .on('error', reject).on('exit', resolve);
  })));
  report(sprt ? { sprt: { p0: sprt[0], p1: sprt[1], deals: deals.length, llr: +llr().toFixed(2), accepted: null } } : {});
} else await play(workerData);
