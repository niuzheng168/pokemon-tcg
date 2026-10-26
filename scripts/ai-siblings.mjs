// Counterfactual self-play for the learned position value (ai/value-model.mjs). Self-play alone teaches the value what
// usually goes with winning (in long policy games: a thick deck, few cards drawn), not what a move does. So at about
// one decision a turn the mover's shortlisted moves (search.mjs) are each played out: the move, the policy to the end of
// the turn (where the search evaluates) and on to the end of the game, in --rollouts worlds (the same cards, both
// decks shuffled again, a new random state; the same worlds for every move). Each rollout is written like a self-play
// game (scripts/ai-selfplay.mjs) with two rows, the position as the turn ended from both sides, so
// scripts/ai-train-value.mjs reads it as it is ({ g, decks, players, winner, reason, steps, rows, branch }).
//   node scripts/ai-siblings.mjs --out <dir> [--games 1000] [--workers N] [--start 0] [--moves 5] [--rollouts 2]
//     [--chance 0.35] [--players "policy:0 policy:0.1 policy:0.3"]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { mkdirSync, appendFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { randomIndex } from '../public/rules/random.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { DECK_POOL, poolDeckList } from '../ai/decks.mjs';
import { makeAgent } from '../ai/agents.mjs';
import { createPolicy } from '../ai/policy.mjs';
import { candidates, shortlistOf } from '../ai/search.mjs';
import { randomState } from '../ai/worlds.mjs';
import { featureReader } from '../ai/features.mjs';
import { createEvaluator } from '../ai/evaluate.mjs';
import { playSafely, stepCounter, TURN_STEP_LIMIT } from '../ai/play.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });
const ROLLOUT_NOISE = 0.1;
const round = (x) => x.map((v) => Math.round(v * 1e4) / 1e4);
const mix = (g, i) => {
  let x = Math.imul(g + 1, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca77);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
};

async function siblings({ games, players, out, moves: cap, rollouts, chance }) {
  const release = await loadRelease(), ids = Object.keys(DECK_POOL);
  for (const g of games) {
    const decks = [ids[g % ids.length], ids[Math.floor(g / ids.length) % ids.length]], specs = [0, 1].map((i) => players[mix(g, i) % players.length]);
    try {
      const { game, catalog } = await createReviewedGame({ release, decks: decks.map(poolDeckList), seed: [g + 1, 17, 13, 11], format: FORMAT, matchMode: 'normal' });
      const sim = new Simulation(game.snapshot(), catalog), features = featureReader(catalog), { vector } = createEvaluator(catalog);
      const agents = specs.map((spec, i) => makeAgent(spec, catalog, [g + 1, i + 1, 41, 43])), chooser = createPolicy(catalog);
      const rng = [g + 5, 9, 2, 6], count = stepCounter(), local = [g + 7, 3, 1, 4], lines = [];

      // The world for one rollout: the same cards, both decks in a new order, a new random state.
      const world = (snapshot) => {
        const s = structuredClone(snapshot);
        for (const p of s.players) for (let i = p.deck.length - 1; i > 0; i--) { const j = randomIndex(rng, i + 1); [p.deck[i], p.deck[j]] = [p.deck[j], p.deck[i]]; }
        s.rng = randomState(rng);
        return s;
      };
      // `me` plays `action` in `snapshot`, then the policy plays both sides to the end. The rows are the position as
      // `me`'s turn ended, from both sides; null when the rules refuse the move or the game ends in the turn or not at all.
      const playOut = (snapshot, me, action, seed) => {
        const run = new Simulation(snapshot, catalog, { checked: false });
        if (run.attempt(me, action)) return null;
        const policy = createPolicy(catalog, { noise: ROLLOUT_NOISE, seed }), rolls = [...seed].reverse(), counter = stepCounter();
        let rows = null, steps = 0;
        for (let p; (p = run.actor) !== null; steps++) {
          const s = run.state, inTurn = counter(run, p);
          if (!rows && s.turn > snapshot.turn && !s.pending)
            rows = [me, 1 - me].map((i) => { const view = run.view(i); return { turn: s.turn, me: i, x: round(features(view, i)), v: round(vector(view, i)) }; });
          if (steps >= 3000 || inTurn >= TURN_STEP_LIMIT) return null;
          playSafely(run, p, policy(run.view(p), p, inTurn), rolls);
        }
        const r = run.state.result;
        return rows && r && !r.draw ? { winner: r.winner, reason: r.reason, steps, rows } : null;
      };
      const branch = (me) => {
        const view = sim.view(me), snapshot = sim.snapshot();
        const list = shortlistOf(chooser, view, me, snapshot, candidates(view, me, snapshot, chooser, rng), cap);
        if (list.length < 2) return;
        const worlds = Array.from({ length: rollouts }, () => ({ snapshot: world(snapshot), seed: randomState(rng) }));
        list.forEach((action, move) => worlds.forEach((w, k) => {
          let res = null;
          // A rollout the engine cannot finish is left out; the game goes on.
          try { res = playOut(w.snapshot, me, action, w.seed); } catch { res = null; }
          if (res) lines.push(JSON.stringify({ g, decks, players: specs, ...res, branch: { turn: snapshot.turn, me, move, type: action.type, world: k } }));
        }));
      };

      let branched = -1;
      for (let steps = 0, p; (p = sim.actor) !== null && steps < 3000; steps++) {
        const s = sim.state, inTurn = count(sim, p);
        if (inTurn >= TURN_STEP_LIMIT) break;
        if (s.phase === 'main' && !s.pending && p === s.current && s.turn !== branched && randomIndex(rng, 1000) < chance * 1000) {
          branched = s.turn;
          branch(p);
        }
        playSafely(sim, p, agents[p].decide(sim, p, inTurn), local);
      }
      if (lines.length) appendFileSync(out, gzipSync(`${lines.join('\n')}\n`));
      parentPort.postMessage({ g, ok: true, rollouts: lines.length });
    } catch (error) {
      parentPort.postMessage({ g, ok: false, error: `${decks.join(' vs ')}: ${String(error.stack).split('\n').slice(0, 3).join(' | ')}` });
    }
  }
}

if (isMainThread) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, games: { type: 'string', default: '1000' }, workers: { type: 'string' },
    start: { type: 'string', default: '0' }, moves: { type: 'string', default: '5' }, rollouts: { type: 'string', default: '2' },
    chance: { type: 'string', default: '0.35' }, players: { type: 'string', default: 'policy:0 policy:0.1 policy:0.3' } } });
  if (!values.out) throw new Error('--out <dir> is required.');
  mkdirSync(values.out, { recursive: true });
  const games = Number(values.games), start = Number(values.start), players = values.players.split(/\s+/).filter(Boolean);
  const n = Math.min(Number(values.workers ?? availableParallelism() - 1), games), started = performance.now();
  let done = 0, failed = 0, written = 0;
  await Promise.all(Array.from({ length: n }, (_, w) => new Promise((resolve, reject) => {
    const list = Array.from({ length: games }, (_, k) => start + k).filter((g) => g % n === w);
    new Worker(new URL(import.meta.url), { workerData: { games: list, players, out: `${values.out}/sib-${start}-${w}.jsonl.gz`,
      moves: Number(values.moves), rollouts: Number(values.rollouts), chance: Number(values.chance) } })
      .on('message', (m) => {
        done++;
        written += m.rollouts ?? 0;
        if (!m.ok) { failed++; console.error(`game ${m.g}: ${m.error}`); }
        if (done % 50 === 0 || done === games)
          console.log(`${done}/${games} games, ${failed} failed, ${written} rollouts, ${(written / ((performance.now() - started) / 1000)).toFixed(1)} rollouts/s`);
      }).on('error', reject).on('exit', resolve);
  })));
} else await siblings(workerData);
