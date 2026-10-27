// Where the general policy goes wrong (docs/ai/STATUS.md): games between two players (level 3, the policy, by default)
// with decks drawn from the training pool, and at a sample of their decisions a deep search scores every candidate move
// (16 worlds through the player's next turn by default, every candidate kept to the end). One record per searched
// decision: the policy's move and the search's best, each candidate's value and standard error, and what kind of move
// each is (move type, what the card does, the request kind), so --summary can rank the kinds of decisions by the win
// chance the policy gives away. The games go on with the players' own moves. With --twice the search scores the same
// candidates again in other worlds: how often its best move is the same tells how much of its choice is noise (Kev's
// labels come from such searches).
//   node scripts/ai-mistakes.mjs --out <dir> [--games 200] [--workers N] [--start 0] [--every 1] [--worlds 16]
//     [--horizon next] [--players "level:3 level:3"] [--twice]
//   node scripts/ai-mistakes.mjs --summary <dir> [--min-gap 0.02] [--top 40]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { mkdirSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync, gunzipSync, constants } from 'node:zlib';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { randomIndex } from '../public/rules/random.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { poolDeckList, poolPair } from '../ai/decks.mjs';
import { makeAgent } from '../ai/agents.mjs';
import { createSearch, moveKey } from '../ai/search.mjs';
import { boardReader } from '../ai/board.mjs';
import { describer } from '../ai/describe.mjs';
import { playSafely, stepCounter, TURN_STEP_LIMIT } from '../ai/play.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });
const FLAGS = ['draws', 'fetches', 'attaches', 'heals', 'gust', 'switchOwn', 'discardsHand', 'thinsDeck', 'selfKnockOut'];

/** What kind of move `action` is, in a short key: the move type, the card's kind and what it does (from its effects). */
function kindReader(catalog) {
  const { facts } = boardReader(catalog), said = describer(catalog);
  const flags = (f) => { const on = FLAGS.filter((k) => f[k]); return on.length ? `[${on.join(',')}]` : ''; };
  const mon = (view, id) => view.players.flatMap((p) => [p.active, ...p.bench]).find((m) => m?.id === id);
  const kind = (view, me, action) => {
    const mine = view.players[me], hand = Array.isArray(mine.hand) ? mine.hand : [];
    if (action.type === 'answer') { const q = view.pending; return `answer:${q.kind}${q.effect?.op ? `:${q.effect.op}` : ''}`; }
    const card = action.cardId && hand.find((c) => c.instanceId === action.cardId), f = card && facts(card.definitionId);
    switch (action.type) {
      case 'playTrainer': return `playTrainer:${f?.category ?? '?'}${f ? flags(f) : ''}`;
      case 'attachEnergy': return `attachEnergy:${f?.energyType ? 'basic' : 'special'}:${action.pokemonId === mine.active?.id ? 'active' : 'bench'}`;
      case 'useAbility': { const m = mon(view, action.pokemonId) ?? mine.active; return `useAbility${m ? flags(facts(m.stack.at(-1).definitionId)) : ''}`; }
      case 'bench': return `bench:${f?.stage ?? '?'}`;
      default: return action.type;
    }
  };
  // The move in words: describe.mjs for a main-phase move; for an answer, the cards or options it selects.
  const text = (view, me, action, state) => {
    if (action.type !== 'answer') return said.move(view, me, action);
    const name = (id) => { const c = state.cards[id]; return c ? catalog.definition(c.definitionId).name : id; };
    return `选择 ${action.selected.map(name).join('、') || '（不选）'}`;
  };
  return { kind, text };
}

async function run({ games, specs, out, every, worlds, horizon, twice }) {
  const release = await loadRelease();
  for (const g of games) {
    const decks = poolPair(g);
    try {
      const { game, catalog } = await createReviewedGame({ release, decks: decks.map(poolDeckList), seed: [g + 1, 31, 37, 41], format: FORMAT, matchMode: 'normal' });
      const sim = new Simulation(game.snapshot(), catalog), agents = specs.map((spec, i) => makeAgent(spec, catalog, [g + 1, i + 1, 43, 47]));
      const search = createSearch(catalog, { worlds, horizon, seed: [g + 1, 53, 59, 61] }), { kind, text } = kindReader(catalog);
      const count = stepCounter(), local = [g + 7, 3, 1, 4], sample = [g + 3, 5, 7, 11], records = [];
      let steps = 0, stopped = null;
      for (let p; (p = sim.actor) !== null; steps++) {
        const s = sim.state, inTurn = count(sim, p);
        if (steps >= 3000 || inTurn >= TURN_STEP_LIMIT) { stopped = steps >= 3000 ? 'step-limit' : 'turn-limit'; break; }
        const action = agents[p].decide(sim, p, inTurn);
        if (s.phase !== 'setup' && randomIndex(sample, every) === 0) {
          const result = search(s, p, { prune: false, seed: [g + 1, steps, 67, 71] }), scored = result.moves.filter((m) => m.value !== null);
          if (scored.length >= 2) {
            const view = sim.view(p), own = moveKey(s, action);
            const row = (m) => ({ kind: kind(view, p, m.action), text: text(view, p, m.action, s), value: +m.value.toFixed(4), se: +(m.se ?? 0).toFixed(4) });
            const chosen = scored.find((m) => m.key === own);
            const record = { g, decks, turn: s.turn, me: p, request: view.pending ? view.pending.kind : null,
              chosen: chosen ? scored.indexOf(chosen) : -1, moves: scored.map(row) };
            if (twice) {
              const again = search(s, p, { moves: scored.map((m) => m.action), prune: false, seed: [g + 1, steps, 73, 79] });
              record.again = scored.map((m) => +(again.moves.find((x) => x.key === m.key)?.value ?? NaN).toFixed(4));
            }
            records.push(record);
          }
        }
        playSafely(sim, p, action, local);
      }
      const r = stopped ? null : sim.state.result;
      if (records.length) appendFileSync(out, gzipSync(`${records.map((x) => JSON.stringify({ ...x, winner: r ? (r.draw ? null : r.winner) : null })).join('\n')}\n`));
      parentPort.postMessage({ g, ok: true, n: records.length });
    } catch (error) {
      parentPort.postMessage({ g, ok: false, error: `${decks.join(' vs ')}: ${String(error.stack).split('\n').slice(0, 3).join(' | ')}` });
    }
  }
}

/** Every record in a run's directory (a file still being written may end in half a record: skipped). */
function readRun(dir) {
  return readdirSync(dir).filter((f) => /^mistakes-.*\.jsonl\.gz$/.test(f)).flatMap((f) =>
    gunzipSync(readFileSync(join(dir, f)), { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8').split('\n')
      .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }));
}

/**
 * The summary: how often the policy plays the search's best move, how much win chance it gives away (best minus its
 * move, where the search tells them apart: the gap is over `minGap` and over twice its standard error), the pairs of
 * kinds (policy's → search's) that give away the most, and with --twice how stable the search's best move is.
 */
function summary(dir, minGap, top) {
  const records = readRun(dir).filter((r) => r.chosen >= 0);
  const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
  let same = 0, clear = 0, lost = 0;
  const pairs = new Map();
  for (const r of records) {
    const best = r.moves[0], mine = r.moves[r.chosen], gap = best.value - mine.value, se = Math.hypot(best.se, mine.se);
    if (r.chosen === 0) { same++; continue; }
    if (gap < minGap || gap < 2 * se) continue;
    clear++; lost += gap;
    const k = `${mine.kind} → ${best.kind}`, e = pairs.get(k) ?? { n: 0, lost: 0, examples: [] };
    e.n++; e.lost += gap;
    if (e.examples.length < 3) e.examples.push(`${mine.text} → ${best.text} (+${gap.toFixed(3)})`);
    pairs.set(k, e);
  }
  console.log(`${records.length} searched decisions: the policy played the search's best in ${pct(same, records.length)}; ` +
    `clearly worse (gap ≥ ${minGap} and ≥ 2 SE) in ${pct(clear, records.length)}, ${(lost / Math.max(1, records.length)).toFixed(4)} win chance given away per decision`);
  console.log('\npolicy → search: decisions, win chance given away in all, examples');
  for (const [k, e] of [...pairs].sort((a, b) => b[1].lost - a[1].lost).slice(0, top))
    console.log(`${String(e.n).padStart(5)} ${e.lost.toFixed(2).padStart(7)}  ${k}\n${e.examples.map((x) => `        ${x}`).join('\n')}`);
  const twice = records.filter((r) => r.again);
  if (twice.length) {
    const bestOf = (values) => values.indexOf(Math.max(...values.filter((v) => !Number.isNaN(v))));
    const agree = twice.filter((r) => bestOf(r.again) === 0).length;
    const wide = twice.filter((r) => r.moves[0].value - r.moves[1].value >= minGap);
    console.log(`\nthe search again in other worlds: the same best move in ${pct(agree, twice.length)} of ${twice.length}; ` +
      `where the first search's top two differ by ≥ ${minGap}: ${pct(wide.filter((r) => bestOf(r.again) === 0).length, wide.length)} of ${wide.length}`);
  }
}

if (isMainThread) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, summary: { type: 'string' }, games: { type: 'string', default: '200' },
    workers: { type: 'string' }, start: { type: 'string', default: '0' }, every: { type: 'string', default: '1' }, worlds: { type: 'string', default: '16' },
    horizon: { type: 'string', default: 'next' }, players: { type: 'string', default: 'level:3 level:3' }, twice: { type: 'boolean', default: false },
    'min-gap': { type: 'string', default: '0.02' }, top: { type: 'string', default: '40' } } });
  if (values.summary) { summary(values.summary, Number(values['min-gap']), Number(values.top)); process.exit(0); }
  if (!values.out) throw new Error('--out <dir> or --summary <dir> is required.');
  mkdirSync(values.out, { recursive: true });
  const games = Number(values.games), start = Number(values.start), specs = values.players.split(/\s+/).filter(Boolean);
  if (specs.length !== 2) throw new Error('--players names two players.');
  const n = Math.min(Number(values.workers ?? availableParallelism() - 1), games), started = performance.now();
  let done = 0, failed = 0, searched = 0;
  await Promise.all(Array.from({ length: n }, (_, w) => new Promise((resolve, reject) => {
    const list = Array.from({ length: games }, (_, k) => start + k).filter((g) => g % n === w);
    new Worker(new URL(import.meta.url), { workerData: { games: list, specs, every: Number(values.every), worlds: Number(values.worlds),
      horizon: values.horizon, twice: values.twice, out: `${values.out}/mistakes-${start}-${w}.jsonl.gz` } })
      .on('message', (m) => {
        done++; searched += m.n ?? 0;
        if (!m.ok) { failed++; console.error(`game ${m.g}: ${m.error}`); }
        console.log(`${done}/${games} games, ${failed} failed, ${searched} decisions searched, ${((performance.now() - started) / 60000).toFixed(1)} min`);
      }).on('error', reject).on('exit', resolve);
  })));
} else await run(workerData);
