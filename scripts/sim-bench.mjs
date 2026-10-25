// How fast the engine simulates: whole CPU-vs-CPU games with the reviewed CN decks, in simulation mode
// (Simulation, trust.js). Prints ms per command and steps per second over all workers.
//   node scripts/sim-bench.mjs [games=6] [workers=1] [--checked]
// --checked plays the same games through OfficialGame instead (every check on, a copy per command), for comparison.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { createAI } from '../public/cn/ai.js';
import { loadRelease } from '../server/catalog.mjs';
import { deckList, RULESET } from '../catalog/zh-CN/V20261019/index.mjs';

const DECKS = ['raging-bolt-679141', 'csvh1c-pikachu', 'dragapult-676815'];
const PAIRS = [[0, 1], [0, 2], [1, 2], [1, 0], [2, 0], [2, 1]];
const FORMAT = Object.freeze({ ...RULESET, id: 'open' });

async function play(games) {
  const release = await loadRelease();
  const total = { steps: 0, view: 0, ai: 0, play: 0, fork: 0, forks: 0 };
  for (const g of games) {
    const decks = PAIRS[g % PAIRS.length].map((i) => deckList(DECKS[i]));
    const { game, catalog } = await createReviewedGame({ release, decks, seed: [g + 1, 7, 1, 8], format: FORMAT, matchMode: 'normal' });
    const ai = createAI(catalog), clock = (key, f) => { const t = performance.now(), r = f(); total[key] += performance.now() - t; return r; };
    if (workerData.checked) {
      for (let s; !(s = game.snapshot()).result; total.steps++) {
        const player = s.pending ? s.pending.player : s.current, view = clock('view', () => game.view(player));
        const action = clock('ai', () => ai(view, player));
        clock('play', () => game.dispatch({ player, expectedRevision: view.revision, action }));
      }
    } else {
      const sim = new Simulation(game.snapshot(), catalog);
      for (let player; (player = sim.actor) !== null; total.steps++) {
        const view = clock('view', () => sim.view(player));
        const action = clock('ai', () => ai(view, player));
        clock('play', () => sim.play(player, action));
        if (total.steps % 10 === 0) { clock('fork', () => sim.fork()); total.forks++; }
      }
    }
  }
  return total;
}

if (isMainThread) {
  const args = process.argv.slice(2), checked = args.includes('--checked');
  const [games = 6, workers = 1] = args.filter((a) => !a.startsWith('--')).map(Number);
  const n = Math.min(workers, games, availableParallelism());
  const started = performance.now();
  const parts = await Promise.all(Array.from({ length: n }, (_, w) => new Promise((resolve, reject) => {
    const mine = Array.from({ length: games }, (_, g) => g).filter((g) => g % n === w);
    new Worker(new URL(import.meta.url), { workerData: { games: mine, checked } })
      .on('message', resolve).on('error', reject);
  })));
  const wall = performance.now() - started, sum = (k) => parts.reduce((a, p) => a + p[k], 0), steps = sum('steps');
  console.log(JSON.stringify({
    mode: checked ? 'checked' : 'simulation', games, workers: n, steps, stepsPerGame: Math.round(steps / games),
    msPerStep: { play: +(sum('play') / steps).toFixed(2), view: +(sum('view') / steps).toFixed(2), ai: +(sum('ai') / steps).toFixed(2) },
    ...(checked ? {} : { msPerFork: +(sum('fork') / sum('forks')).toFixed(2) }),
    stepsPerSecond: Math.round(steps / (wall / 1000)), wallSeconds: +(wall / 1000).toFixed(1),
  }));
} else parentPort.postMessage(await play(workerData.games));
