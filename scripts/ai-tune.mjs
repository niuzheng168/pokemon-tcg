// Tune the search's position value by self-play (SPSA): evaluate.mjs's 13 weights and the search's margin are nudged
// together in a random ± direction each step, the two sides (θ + cΔ against θ − cΔ, both searching like level 4) play
// --games games on the training decks (ai/decks.mjs, both seats of every deal), and θ moves toward the side that won
// more. A step needs only results, so it optimises what matters, games won, where a value fitted to outcomes learns
// what goes with winning instead of what a move does (docs/ai/STATUS.md, M5). Every step is a line in --out; the
// result is the average θ of the second half, in --out with .best.json ({ weights, margin }).
//   node scripts/ai-tune.mjs --out <file.jsonl> [--steps 60] [--games 48] [--workers N] [--gain 1.5]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { randomIndex } from '../public/rules/random.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { poolDeckList, poolPair } from '../ai/decks.mjs';
import { searchAgent } from '../ai/agents.mjs';
import { playGame } from '../ai/play.mjs';
import { FEATURES, SEARCH_WEIGHTS } from '../ai/evaluate.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });
const SEARCH = { worlds: 4, horizon: 'turn', shortlist: 8 };

async function play({ games, sides }) {
  const release = await loadRelease();
  for (const g of games) {
    // Deal g >> 1 for both seats: game g has side 0 first when g is even.
    const ids = poolPair(g >> 1), first = g % 2;
    try {
      const { game, catalog } = await createReviewedGame({ release, decks: ids.map(poolDeckList), seed: [(g >> 1) + 101, 5, 7, 9], format: FORMAT, matchMode: 'normal' });
      const agents = sides.map((side, i) => searchAgent(catalog, { ...SEARCH, ...side, seed: [g + 1, i + 1, 3, 5] }));
      const seats = first ? [agents[1], agents[0]] : agents, r = playGame(new Simulation(game.snapshot(), catalog), seats, { seed: [g + 9, 2, 2, 2] });
      parentPort.postMessage({ g, winner: r.winner === null ? null : r.winner === 0 ? first : 1 - first });
    } catch {
      parentPort.postMessage({ g, winner: null });
    }
  }
}

// Both sides play `games` games (numbers from `base`) on `workers` threads; the share side 0 won (draws count half).
async function match(sides, base, games, workers) {
  const results = [];
  await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((resolve, reject) => {
    const list = Array.from({ length: games }, (_, k) => base + k).filter((g) => g % workers === w);
    new Worker(new URL(import.meta.url), { workerData: { games: list, sides } })
      .on('message', (m) => results.push(m)).on('error', reject).on('exit', resolve);
  })));
  return results.reduce((n, r) => n + (r.winner === null ? 0.5 : r.winner === 0 ? 1 : 0), 0) / results.length;
}

if (isMainThread) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, steps: { type: 'string', default: '60' }, games: { type: 'string', default: '48' },
    workers: { type: 'string' }, gain: { type: 'string', default: '1.5' }, seed: { type: 'string', default: '1' } } });
  if (!values.out) throw new Error('--out <file.jsonl> is required.');
  const steps = Number(values.steps), games = Number(values.games), gain = Number(values.gain);
  const workers = Math.min(Number(values.workers ?? availableParallelism() - 1), games), rng = [Number(values.seed), 3, 5, 7];
  // θ: the weights, then the margin. Each moves in steps of its own size: a quarter of its start (at least 0.01).
  let theta = [...SEARCH_WEIGHTS, 0.015];
  const size = theta.map((v, i) => (i < FEATURES.length ? Math.max(0.01, Math.abs(v) * 0.25) : 0.005));
  const clamp = (t) => t.map((v, i) => (i < FEATURES.length ? v : Math.max(0, v)));
  const side = (t) => ({ weights: t.slice(0, FEATURES.length), margin: t[FEATURES.length] });
  const history = [];
  for (let k = 0; k < steps; k++) {
    const c = 1 / (k + 1) ** 0.101, delta = theta.map(() => (randomIndex(rng, 2) ? 1 : -1));
    const plus = clamp(theta.map((v, i) => v + c * size[i] * delta[i])), minus = clamp(theta.map((v, i) => v - c * size[i] * delta[i]));
    const started = performance.now(), score = await match([side(plus), side(minus)], k * 10000, games, workers);
    // Toward the side that won more, by how much more it won.
    theta = clamp(theta.map((v, i) => v + gain * (2 * score - 1) * size[i] * delta[i]));
    history.push(theta);
    appendFileSync(values.out, `${JSON.stringify({ step: k + 1, score: +score.toFixed(3), minutes: +((performance.now() - started) / 60000).toFixed(1),
      theta: Object.fromEntries([...FEATURES, 'margin'].map((f, i) => [f, +theta[i].toFixed(4)])) })}\n`);
    console.log(`step ${k + 1}/${steps}: θ+ scored ${score.toFixed(3)}`);
  }
  const half = history.slice(Math.floor(history.length / 2)), mean = theta.map((_, i) => half.reduce((n, t) => n + t[i], 0) / half.length);
  writeFileSync(values.out.replace(/\.jsonl$/, '') + '.best.json', `${JSON.stringify({ ...side(mean), steps, games,
    features: FEATURES }, null, 1)}\n`);
  console.log('wrote', values.out.replace(/\.jsonl$/, '') + '.best.json');
} else await play(workerData);
