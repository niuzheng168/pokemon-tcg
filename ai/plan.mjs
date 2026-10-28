// Turn planning: search whole action sequences of the player's own turn, not one move (docs/ai/STATUS.md, M6). Strong
// bots for other card games with many actions a turn (Hearthstone's turn searchers, Dou Di Zhu's hand planners) look for
// the best way to play the whole turn; the one-move search (search.mjs) branches only at the current move and leaves
// the rest of the turn to the policy, so it cannot see lines like "switch, attach, then attack".
//
// In each of `worlds` dealt worlds (worlds.mjs: own deck reshuffled from the cards left, the opponent's unseen cards
// guessed), a beam search over this turn's moves: from every position, the policy's favourite `expand` moves (plus
// ending the turn and every attack) are played; a move that ends the turn ends a line, and the line is scored at the end
// of the opponent's reply (played by the policy) by evaluate.mjs. The positions kept for the next step are the `beam`
// best by the evaluation as they stand, separately for each first move, so every first move is planned as deeply. Within
// a world the planner knows its draws in advance, but it learns them before acting in a real game too; across worlds the
// value of a first move is the mean over worlds of its best line. The move played is the first move with the best value,
// unless the policy's own move is within `margin` of it. `exact` (1): an attack's selections only near the policy's
// (search.mjs candidates). `budget` (ms a decision, 0: none) stops each world's search from
// going deeper once its share is spent (a long turn of many Abilities once took a game over four hours).
import { Simulation } from '../public/rules/engine.js';
import { createPolicy } from './policy.mjs';
import { boardReader } from './board.mjs';
import { readFileSync } from 'node:fs';
import { createEvaluator, SEARCH_WEIGHTS } from './evaluate.mjs';
import { sampleWorld, randomState } from './worlds.mjs';
import { candidates, moveKey } from './search.mjs';
import { playSafely, stepCounter, TURN_STEP_LIMIT } from './play.mjs';
import { planFor } from './deck-plan.mjs';

// A position in a few fields: two lines reaching the same one (attach then evolve, evolve then attach) are one.
function signature(s) {
  const mon = (m) => m && [m.stack, m.energy, m.tools, m.counters, m.conditions ?? null];
  return JSON.stringify([s.turn, s.current, s.stadium, s.pending && [s.pending.kind, s.pending.options], s.players.map((p) =>
    [mon(p.active), p.bench.map(mon), [...p.hand].sort(), p.deck.length, p.discard.length, p.prizes.length, p.flags])]);
}

export function createPlanner(catalog, { worlds = 4, beam = 3, expand = 5, depth = 10, reply = true, top = 2, margin = 0.015,
  budget = 0, exact = 0, spread = 0, evalWeights = null, seed = [3, 5, 7, 9] } = {}) {
  let current = null;
  const rng = [...seed], chooser = createPolicy(catalog, { plans: (p) => (current ? planFor(catalog, current, p) : null) });
  // The evaluator's weights: the search's, or others to test (an array, or a JSON file of one).
  const weights = typeof evalWeights === 'string' ? JSON.parse(readFileSync(evalWeights, 'utf8')) : evalWeights ?? SEARCH_WEIGHTS;
  const { facts } = boardReader(catalog), { evaluate } = createEvaluator(catalog, weights);
  const copies = (definitionId, attackId) => !!facts(definitionId).attacks.find((a) => a.attackId === attackId)?.copies;

  // The moves tried from a position: the policy's `expand` favourites, ending the turn and every attack; for a request,
  // the options worth comparing (search.mjs candidates), the policy's first. With `spread`, at most that many of the
  // favourites attach or evolve with the same card (one Energy to each of four Pokémon took all the places once, and
  // the cards that should have come first were never tried).
  function movesAt(sim, me, r) {
    const view = sim.view(me), list = candidates(view, me, sim.state, chooser, r, copies, { exact: !!exact });
    if (view.pending) return list.slice(0, expand + 1);
    const keys = new Set(list.map((a) => moveKey(sim.state, a))), out = new Map(), per = new Map();
    const card = (a) => ((a.type === 'attachEnergy' || a.type === 'evolve') && a.cardId ? `${a.type}:${sim.state.cards[a.cardId]?.definitionId}` : null);
    for (const a of chooser.rank(view, me)) {
      const k = moveKey(sim.state, a), always = a.type === 'endTurn' || a.type === 'attack';
      if (!keys.has(k) || out.has(k) || !(always || out.size < expand)) continue;
      const c = !always && spread ? card(a) : null;
      if (c && (per.get(c) ?? 0) >= spread) continue;
      if (c) per.set(c, (per.get(c) ?? 0) + 1);
      out.set(k, a);
    }
    return [...out.values()];
  }

  // The opponent's choices in the middle of `me`'s turn (a Pokémon to promote, say) are the policy's.
  function settleOthers(sim, me, startTurn, policy, local) {
    const count = stepCounter();
    for (let p; (p = sim.actor) !== null && p !== me && sim.state.turn === startTurn;) {
      const n = count(sim, p);
      if (n >= TURN_STEP_LIMIT) return false;
      playSafely(sim, p, policy(sim.view(p), p, n), local);
    }
    return true;
  }

  // A finished line: the position after the opponent's reply (or at the end of `me`'s turn), for `me`.
  function score(sim, me, startTurn, r) {
    if (sim.state.result) return evaluate(sim.view(me), me);
    if (!reply) return evaluate(sim.view(me), me);
    const end = sim.fork(), policy = createPolicy(catalog, { noise: 0.1, seed: randomState(r), plans: (p) => planFor(catalog, end.state, p) });
    const local = randomState(r), count = stepCounter();
    for (let p, steps = 0; (p = end.actor) !== null && !end.state.result && steps < 400; steps++) {
      if (end.state.turn > startTurn + 1 && !end.state.pending) break;
      const n = count(end, p);
      if (n >= TURN_STEP_LIMIT) break;
      playSafely(end, p, policy(end.view(p), p, n), local);
    }
    return evaluate(end.view(me), me);
  }

  /** One world: for each first move (by key), the best value of a line starting with it. */
  function planWorld(snapshot, me, worldSeed) {
    const r = [...worldSeed], root = new Simulation(sampleWorld(snapshot, catalog, me, r), catalog, { checked: false });
    const startTurn = snapshot.turn, policy = createPolicy(catalog, { seed: randomState(r), plans: (p) => planFor(catalog, root.state, p) });
    const local = randomState(r);
    const lines = new Map(); // first key -> { action, ends: [{ sim, h }] }
    const deadline = budget ? performance.now() + budget / worlds : Infinity;
    let frontier = [{ sim: root, first: null }];
    for (let d = 0; d < depth && frontier.length && (d === 0 || performance.now() < deadline); d++) {
      const next = new Map(); // first key -> [{ sim, h, sig }]
      for (const node of frontier) {
        for (const action of movesAt(node.sim, me, r)) {
          const sim = node.sim.fork();
          if (sim.attempt(me, action)) continue;
          const firstKey = node.first ?? moveKey(node.sim.state, action);
          if (!lines.has(firstKey)) lines.set(firstKey, { action, ends: [] });
          const ok = settleOthers(sim, me, startTurn, policy, local);
          const h = evaluate(sim.view(me), me);
          if (!ok || sim.state.result || sim.state.turn !== startTurn || sim.actor !== me) lines.get(firstKey).ends.push({ sim, h });
          else {
            const list = next.get(firstKey) ?? [];
            list.push({ sim, h, sig: signature(sim.state), first: firstKey });
            next.set(firstKey, list);
          }
        }
      }
      // The `beam` best positions of each first move, two lines to the same position counted once.
      frontier = [...next.values()].flatMap((list) => {
        const seen = new Set();
        return list.sort((a, b) => b.h - a.h).filter((x) => !seen.has(x.sig) && seen.add(x.sig)).slice(0, beam);
      });
    }
    // Lines still open at the depth limit: the policy finishes the turn.
    for (const node of frontier) {
      const sim = node.sim.fork(), count = stepCounter();
      for (let p; (p = sim.actor) !== null && sim.state.turn === startTurn && !sim.state.result;) {
        const n = count(sim, p);
        if (n >= TURN_STEP_LIMIT) break;
        playSafely(sim, p, policy(sim.view(p), p, n), local);
      }
      lines.get(node.first).ends.push({ sim, h: evaluate(sim.view(me), me) });
    }
    // Each first move: its `top` best lines as they stand, scored after the opponent's reply; the best of them.
    const out = new Map();
    for (const [key, { action, ends }] of lines) {
      const best = ends.sort((a, b) => b.h - a.h).slice(0, top).map((e) => score(e.sim, me, startTurn, r));
      if (best.length) out.set(key, { action, value: Math.max(...best) });
    }
    return out;
  }

  /** The move for `me` in `snapshot` (a full game state; the planner hides what `me` cannot know): { moves, best }. */
  function analyse(snapshot, me) {
    current = snapshot;
    const view = new Simulation(snapshot, catalog, { checked: false }).view(me), own = chooser(view, me);
    if (snapshot.phase === 'setup' || snapshot.current !== me) return { moves: [], best: own };
    const totals = new Map();
    for (let w = 0; w < worlds; w++) {
      for (const [key, { action, value }] of planWorld(snapshot, me, randomState(rng))) {
        const t = totals.get(key) ?? { action, values: [] };
        t.values.push(value); totals.set(key, t);
      }
    }
    // Moves found in every world only (a move pruned or refused in some world has no comparable mean).
    const moves = [...totals.entries()].filter(([, t]) => t.values.length === worlds)
      .map(([key, t]) => ({ key, action: t.action, value: t.values.reduce((a, b) => a + b, 0) / worlds, n: worlds }))
      .sort((a, b) => b.value - a.value);
    if (!moves.length) return { moves, best: own };
    const policyMove = moves.find((m) => m.key === moveKey(snapshot, own));
    const best = policyMove && moves[0].value - policyMove.value < margin ? policyMove : moves[0];
    return { moves, best: best.action };
  }
  return analyse;
}

/** The planner as a player: its own turn is planned, everything else is the policy's. */
export function planAgent(catalog, options = {}, name = `plan(${options.worlds ?? 4},${options.beam ?? 3})`) {
  let state = null;
  const analyse = createPlanner(catalog, options), policy = createPolicy(catalog, { seed: options.seed, plans: (p) => (state ? planFor(catalog, state, p) : null) });
  const agent = { name, last: null, decide: (sim, me, steps) => {
    state = sim.state;
    if (sim.state.current !== me || sim.state.phase === 'setup' || steps > 40) return policy(sim.view(me), me, steps);
    agent.last = analyse(sim.state, me);
    return agent.last.best;
  } };
  return agent;
}
