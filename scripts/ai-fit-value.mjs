// Fit ai/evaluate.mjs's position model to self-play: policy players with the reviewed CN decks, every turn's start seen
// from both sides, labelled with who won. A logistic regression without intercept (the features are "mine minus
// theirs"), L2-regularised, fitted by Newton's method on 80% of the games and checked on the rest. It also fits one
// scale for the hand-set weights the search plays with (they guide moves better; the scale makes their estimate a
// chance to win).
//   node scripts/ai-fit-value.mjs [games=600] [workers=8] [--write]
// --write replaces ai/value-weights.mjs with the fitted weights.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { deckList, RULESET, DECKS } from '../catalog/zh-CN/V20261019/index.mjs';
import { createPolicy } from '../ai/policy.mjs';
import { createEvaluator, FEATURES, HAND_WEIGHTS } from '../ai/evaluate.mjs';
import { playSafely, stepCounter } from '../ai/play.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });
const NOISE = [0, 0, 0.1, 0.3];

async function selfPlay(games) {
  const release = await loadRelease(), ids = Object.keys(DECKS);
  for (const g of games) {
    const decks = [ids[g % ids.length], ids[Math.floor(g / ids.length) % ids.length]].map(deckList);
    const { game, catalog } = await createReviewedGame({ release, decks, seed: [g + 1, 31, 7, 3], format: FORMAT, matchMode: 'normal' });
    const sim = new Simulation(game.snapshot(), catalog), { vector } = createEvaluator(catalog);
    const policies = [0, 1].map((i) => createPolicy(catalog, { noise: NOISE[(g + 3 * i) % NOISE.length], seed: [g + 1, i + 1, 5, 9] }));
    const count = stepCounter(), rng = [g + 3, 1, 4, 1], rows = [];
    let lastTurn = -1;
    for (let steps = 0, p; (p = sim.actor) !== null && steps < 3000; steps++) {
      const s = sim.state;
      if (s.phase === 'main' && !s.pending && s.turn !== lastTurn) {
        lastTurn = s.turn;
        for (const me of [0, 1]) rows.push({ me, x: vector(sim.view(me), me) });
      }
      playSafely(sim, p, policies[p](sim.view(p), p, count(sim, p)), rng);
    }
    const r = sim.state.result;
    parentPort.postMessage({ g, rows: r && !r.draw ? rows.map(({ me, x }) => ({ x, y: Number(r.winner === me) })) : [] });
  }
}

// Newton's method for L2-regularised logistic regression without intercept.
function fit(rows, lambda = 1) {
  const k = rows[0].x.length, w = Array(k).fill(0);
  for (let iter = 0; iter < 30; iter++) {
    const g = Array(k).fill(0), H = Array.from({ length: k }, () => Array(k).fill(0));
    for (const { x, y } of rows) {
      const p = 1 / (1 + Math.exp(-x.reduce((n, v, i) => n + v * w[i], 0))), s = p * (1 - p);
      for (let i = 0; i < k; i++) {
        g[i] += (p - y) * x[i];
        for (let j = 0; j < k; j++) H[i][j] += s * x[i] * x[j];
      }
    }
    for (let i = 0; i < k; i++) { g[i] += lambda * w[i]; H[i][i] += lambda; }
    const step = solve(H, g);
    for (let i = 0; i < k; i++) w[i] -= step[i];
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return w;
}
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    const pivot = M.reduce((best, row, r) => (r >= c && Math.abs(row[c]) > Math.abs(M[best][c]) ? r : best), c);
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
function score(rows, w) {
  let loss = 0, right = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const { x, y } of rows) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, 1 / (1 + Math.exp(-x.reduce((n, v, i) => n + v * w[i], 0)))));
    loss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    right += Number((p > 0.5) === (y === 1));
    const b = bins[Math.min(9, Math.floor(p * 10))];
    b.n++; b.p += p; b.y += y;
  }
  return { logLoss: +(loss / rows.length).toFixed(4), accuracy: +(right / rows.length).toFixed(3),
    calibration: bins.filter((b) => b.n).map((b) => [+(b.p / b.n).toFixed(2), +(b.y / b.n).toFixed(2), b.n]) };
}

if (isMainThread) {
  const args = process.argv.slice(2), write = args.includes('--write');
  const [games = 600, workers = 8] = args.filter((a) => !a.startsWith('--')).map(Number);
  const n = Math.min(workers, games, availableParallelism()), byGame = new Map(), started = performance.now();
  await Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve, reject) => {
    new Worker(new URL(import.meta.url), { workerData: { games: Array.from({ length: games }, (_, g) => g).filter((g) => g % n === i) } })
      .on('message', (m) => byGame.set(m.g, m.rows)).on('error', reject).on('exit', resolve);
  })));
  const train = [], test = [];
  for (const [g, rows] of byGame) (g % 5 === 0 ? test : train).push(...rows);
  const w = fit(train);
  // The hand-set weights' scale: a one-feature fit on their combined score.
  const hand = (rows) => rows.map(({ x, y }) => ({ x: [x.reduce((n, v, i) => n + v * HAND_WEIGHTS[i], 0)], y }));
  const [scale] = fit(hand(train), 0.01), scaled = HAND_WEIGHTS.map((v) => v * scale);
  const report = { games: byGame.size, rows: { train: train.length, test: test.length },
    fitted: score(test, w), hand: score(test, HAND_WEIGHTS), handScaled: { scale: +scale.toFixed(4), ...score(test, scaled) },
    minutes: +((performance.now() - started) / 60000).toFixed(1), weights: Object.fromEntries(FEATURES.map((f, i) => [f, +w[i].toFixed(4)])) };
  console.log(JSON.stringify(report, null, 1));
  if (write) {
    const fitted = { games: report.games, rows: train.length, testLogLoss: report.fitted.logLoss, testAccuracy: report.fitted.accuracy,
      handScaledLogLoss: report.handScaled.logLoss, handScaledAccuracy: report.handScaled.accuracy };
    await writeFile(new URL('../ai/value-weights.mjs', import.meta.url), `// Generated by scripts/ai-fit-value.mjs: ai/evaluate.mjs's weights (order of FEATURES), fitted to self-play, and the
// scale of the hand-set weights the search plays with.
export const VALUE_WEIGHTS = Object.freeze({
  fitted: Object.freeze(${JSON.stringify(fitted)}),
  weights: Object.freeze(${JSON.stringify(w.map((v) => +v.toFixed(5)))}),
  handScale: ${+scale.toFixed(5)},
});
`);
    console.log('Wrote ai/value-weights.mjs');
  }
} else await selfPlay(workerData.games);
