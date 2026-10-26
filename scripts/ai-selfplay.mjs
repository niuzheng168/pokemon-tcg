// Self-play for the learned position value (ai/value-model.mjs): games between players drawn from --players, with two
// decks drawn from the training pool (ai/decks.mjs), and at every turn's start the position's features
// (ai/features.mjs) from both sides, labelled later with who won. Each worker thread appends its games to its own
// gzip file in <out>, one JSON line per game ({ g, decks, players, winner, reason, steps, rows: [{ turn, me, x, v }] },
// v: evaluate.mjs's features, for comparison), so a run can be stopped and continued with --start.
// With --kev, every main-phase decision a search player compared two moves or more is also written, for fine-tuning a
// language model (Kev): the position and the moves in words (ai/describe.mjs) with the search's estimate of each, in
// kev-*.jsonl.gz ({ g, turn, me, state, moves: [{ text, value, n }], chosen }).
//   node scripts/ai-selfplay.mjs --out <dir> [--games 1000] [--workers N] [--start 0] [--kev]
//     [--players "policy:0 policy:0.1 policy:0.3 policy:0.6"]   (agents.mjs makeAgent specs; each seat draws one)
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { mkdirSync, appendFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { DECK_POOL, poolDeckList } from '../ai/decks.mjs';
import { makeAgent } from '../ai/agents.mjs';
import { featureReader } from '../ai/features.mjs';
import { createEvaluator } from '../ai/evaluate.mjs';
import { describer } from '../ai/describe.mjs';
import { playSafely, stepCounter, TURN_STEP_LIMIT } from '../ai/play.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });
const round = (x) => x.map((v) => Math.round(v * 1e4) / 1e4);
const mix = (g, i) => {
  let x = Math.imul(g + 1, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca77);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
};

async function selfPlay({ games, players, out, kev }) {
  const release = await loadRelease(), ids = Object.keys(DECK_POOL);
  for (const g of games) {
    // Every pairing of decks in turn; the players by a hash of the game number.
    const decks = [ids[g % ids.length], ids[Math.floor(g / ids.length) % ids.length]], specs = [0, 1].map((i) => players[mix(g, i) % players.length]);
    try {
      const { game, catalog } = await createReviewedGame({ release, decks: decks.map(poolDeckList), seed: [g + 1, 19, 23, 29], format: FORMAT, matchMode: 'normal' });
      const sim = new Simulation(game.snapshot(), catalog), features = featureReader(catalog), { vector } = createEvaluator(catalog);
      const agents = specs.map((spec, i) => makeAgent(spec, catalog, [g + 1, i + 1, 41, 43]));
      const count = stepCounter(), local = [g + 7, 3, 1, 4], rows = [], said = kev && describer(catalog), examples = [];
      let lastTurn = -1, steps = 0, stopped = null;
      for (let p; (p = sim.actor) !== null; steps++) {
        const s = sim.state, inTurn = count(sim, p);
        if (steps >= 3000 || inTurn >= TURN_STEP_LIMIT) { stopped = steps >= 3000 ? 'step-limit' : 'turn-limit'; break; }
        if (s.phase === 'main' && !s.pending && s.turn !== lastTurn) {
          lastTurn = s.turn;
          for (const me of [0, 1]) { const view = sim.view(me); rows.push({ turn: s.turn, me, x: round(features(view, me)), v: round(vector(view, me)) }); }
        }
        const action = agents[p].decide(sim, p, inTurn), analysis = agents[p].last;
        if (said && analysis && !s.pending && s.phase === 'main' && analysis.moves.filter((m) => m.value !== null).length >= 2) {
          const view = sim.view(p), moves = analysis.moves.filter((m) => m.value !== null);
          examples.push({ g, turn: s.turn, me: p, state: said.state(view, p),
            moves: moves.map((m) => ({ text: said.move(view, p, m.action), value: Math.round(m.value * 1e4) / 1e4, n: m.n })),
            chosen: moves.findIndex((m) => m.action === action) });
        }
        playSafely(sim, p, action, local);
      }
      const r = stopped ? null : sim.state.result;
      appendFileSync(out, gzipSync(`${JSON.stringify({ g, decks, players: specs, winner: r ? (r.draw ? null : r.winner) : null,
        reason: r?.reason ?? stopped, steps, rows })}\n`));
      if (examples.length) appendFileSync(out.replace('/games-', '/kev-'), gzipSync(`${examples.map((e) => JSON.stringify({ ...e,
        winner: r ? (r.draw ? null : r.winner) : null })).join('\n')}\n`));
      parentPort.postMessage({ g, ok: true });
    } catch (error) {
      parentPort.postMessage({ g, ok: false, error: `${decks.join(' vs ')}: ${String(error.stack).split('\n').slice(0, 3).join(' | ')}` });
    }
  }
}

if (isMainThread) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, games: { type: 'string', default: '1000' }, workers: { type: 'string' },
    start: { type: 'string', default: '0' }, kev: { type: 'boolean', default: false }, players: { type: 'string', default: 'policy:0 policy:0.1 policy:0.3 policy:0.6' } } });
  if (!values.out) throw new Error('--out <dir> is required.');
  mkdirSync(values.out, { recursive: true });
  const games = Number(values.games), start = Number(values.start), players = values.players.split(/\s+/).filter(Boolean);
  const n = Math.min(Number(values.workers ?? availableParallelism() - 1), games), started = performance.now();
  let done = 0, failed = 0;
  await Promise.all(Array.from({ length: n }, (_, w) => new Promise((resolve, reject) => {
    const list = Array.from({ length: games }, (_, k) => start + k).filter((g) => g % n === w);
    new Worker(new URL(import.meta.url), { workerData: { games: list, players, kev: values.kev, out: `${values.out}/games-${start}-${w}.jsonl.gz` } })
      .on('message', (m) => {
        done++;
        if (!m.ok) { failed++; console.error(`game ${m.g}: ${m.error}`); }
        if (done % 500 === 0 || done === games)
          console.log(`${done}/${games} games, ${failed} failed, ${(done / ((performance.now() - started) / 1000)).toFixed(1)} games/s`);
      }).on('error', reject).on('exit', resolve);
  })));
} else await selfPlay(workerData);
