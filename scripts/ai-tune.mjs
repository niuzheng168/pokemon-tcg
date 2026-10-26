// Tune by self-play (SPSA): the parameters θ are nudged together in a random ± direction, the two sides (θ + cΔ against
// θ − cΔ) play one deal of the training decks (ai/decks.mjs) from both seats, and θ moves a little toward the side that
// won more. This needs only results, so it optimises what matters, games won, where a value fitted to outcomes learns
// what goes with winning instead of what a move does (docs/ai/STATUS.md, M5). --target says what θ is:
// - search: evaluate.mjs's 13 weights and the margin, both sides searching like level 4;
// - policy: the general policy's scores (policy.mjs POLICY_WEIGHTS), both sides playing the policy.
// Every thread takes the current θ when it starts a pair and updates θ when the pair ends, so no thread waits for
// another's long game. Every --log pairs a line goes to --out; the result is the average θ over the second half of the
// pairs, in --out with .best.json ({ weights, margin } or { weights: { name: score } }).
//   node scripts/ai-tune.mjs --out <file.jsonl> [--target search|policy] [--pairs 1000] [--workers N] [--gain 0.03] [--log 20]
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { randomIndex } from '../public/rules/random.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { poolDeckList, poolPair } from '../ai/decks.mjs';
import { searchAgent } from '../ai/agents.mjs';
import { playGame, policyAgent } from '../ai/play.mjs';
import { FEATURES, SEARCH_WEIGHTS } from '../ai/evaluate.mjs';
import { POLICY_WEIGHTS } from '../ai/policy.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });
const SEARCH = { worlds: 4, horizon: 'turn', shortlist: 8 };

// A worker plays the deal it is sent from both seats ({ deal, sides } → { deal, score }: side 0's points, a win 1, a
// draw or an unfinished game ½).
async function serve() {
  const release = await loadRelease();
  parentPort.on('message', async ({ deal, sides, target }) => {
    let score = 0;
    for (const first of [0, 1]) {
      try {
        const { game, catalog } = await createReviewedGame({ release, decks: poolPair(deal).map(poolDeckList), seed: [deal + 101, 5, 7, 9], format: FORMAT, matchMode: 'normal' });
        const agents = sides.map((side, i) => (target === 'policy' ? policyAgent(catalog, { ...side, seed: [deal + 1, i + 1, 3, 5] })
          : searchAgent(catalog, { ...SEARCH, ...side, seed: [deal + 1, i + 1, 3, 5] })));
        const r = playGame(new Simulation(game.snapshot(), catalog), first ? [agents[1], agents[0]] : agents, { seed: [deal + 9, first, 2, 2] });
        score += r.winner === null ? 0.5 : Number(r.winner === first);
      } catch {
        score += 0.5;
      }
    }
    parentPort.postMessage({ deal, score });
  });
}

if (isMainThread) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, target: { type: 'string', default: 'search' }, pairs: { type: 'string', default: '1000' }, workers: { type: 'string' },
    gain: { type: 'string', default: '0.03' }, log: { type: 'string', default: '20' }, seed: { type: 'string', default: '1' } } });
  if (!values.out) throw new Error('--out <file.jsonl> is required.');
  const pairs = Number(values.pairs), gain = Number(values.gain), every = Number(values.log), rng = [Number(values.seed), 3, 5, 7];
  const workers = Math.min(Number(values.workers ?? availableParallelism() - 1), pairs);
  const target = values.target, policy = target === 'policy';
  if (!['search', 'policy'].includes(target)) throw new Error('--target is search or policy.');
  // θ and the size of each one's nudge. Search: the weights (a quarter of each, at least 0.01), then the margin (0.005,
  // never below 0). Policy: the scores (15% of each, at least 2; 1 for the small ones; a quarter of a scale below 1).
  const names = policy ? Object.keys(POLICY_WEIGHTS) : [...FEATURES, 'margin'];
  let theta = policy ? Object.values(POLICY_WEIGHTS) : [...SEARCH_WEIGHTS, 0.015];
  const size = theta.map((v, i) => (policy ? (v >= 5 ? Math.max(2, v * 0.15) : v >= 1 ? 1 : v * 0.25)
    : i < FEATURES.length ? Math.max(0.01, Math.abs(v) * 0.25) : 0.005));
  const clamp = (t) => (policy ? t : t.map((v, i) => (i < FEATURES.length ? v : Math.max(0, v))));
  const side = (t) => (policy ? { weights: Object.fromEntries(names.map((n, i) => [n, t[i]])) }
    : { weights: t.slice(0, FEATURES.length), margin: t[FEATURES.length] });
  const named = (t) => Object.fromEntries(names.map((f, i) => [f, +t[i].toFixed(4)]));
  const sum = theta.map(() => 0), started = performance.now();
  let sent = 0, done = 0, averaged = 0, recent = [];
  await new Promise((resolve, reject) => {
    const start = (worker) => {
      if (sent >= pairs) return;
      const delta = theta.map(() => (randomIndex(rng, 2) ? 1 : -1)), deal = sent++;
      worker.delta = delta;
      worker.postMessage({ deal, target, sides: [side(clamp(theta.map((v, i) => v + size[i] * delta[i]))), side(clamp(theta.map((v, i) => v - size[i] * delta[i])))] });
    };
    for (let w = 0; w < workers; w++) {
      const worker = new Worker(new URL(import.meta.url)).on('error', reject);
      worker.on('message', ({ score }) => {
        // Toward the side that scored more than its half (score − 1 of 2 points).
        theta = clamp(theta.map((v, i) => v + gain * (score - 1) * size[i] * worker.delta[i]));
        done++;
        recent.push(score);
        if (done > pairs / 2) { theta.forEach((v, i) => { sum[i] += v; }); averaged++; }
        if (done % every === 0 || done === pairs) {
          appendFileSync(values.out, `${JSON.stringify({ pairs: done, minutes: +((performance.now() - started) / 60000).toFixed(1),
            plusScore: +(recent.reduce((a, b) => a + b, 0) / (2 * recent.length)).toFixed(3), theta: named(theta) })}\n`);
          recent = [];
        }
        if (done === pairs) { resolve(); return; }
        start(worker);
      });
      start(worker);
    }
  });
  const mean = sum.map((v) => v / averaged);
  writeFileSync(`${values.out.replace(/\.jsonl$/, '')}.best.json`, `${JSON.stringify({ target, ...side(mean), pairs, gain, named: named(mean) }, null, 1)}\n`);
  console.log(`${pairs} pairs in ${((performance.now() - started) / 60000).toFixed(1)} min; wrote ${values.out.replace(/\.jsonl$/, '')}.best.json`);
  process.exit(0);
} else await serve();
