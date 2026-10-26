// Playing a game between two agents on a Simulation. An agent is { name, decide(sim, me, steps) → action }: it gets the
// whole simulation only so that a search can copy the position; every agent here decides from what `me` could know
// (a policy reads `sim.view(me)`, a search deals the hidden cards again first, see worlds.mjs).
import { createPolicy } from './policy.mjs';
import { randomIndex } from '../public/rules/random.js';
import { createAI } from '../public/cn/ai.js';

/** The generic policy as a player (difficulty levels 1–2, and the moves inside a search's simulations). */
export function policyAgent(catalog, { noise = 0, seed, name = `policy(${noise})` } = {}) {
  const policy = createPolicy(catalog, { noise, seed });
  return { name, decide: (sim, me, steps) => policy(sim.view(me), me, steps) };
}

/** The old card-specific CPU (public/cn/ai.js), as a yardstick. */
export function legacyAgent(catalog) {
  const ai = createAI(catalog);
  return { name: 'legacy-cpu', decide: (sim, me) => ai(sim.view(me), me) };
}

/** Steps of one player in a row on the same turn; the policies use it to stop a turn that would not end. */
export function stepCounter() {
  let key = null, n = 0;
  return (sim, me) => {
    const k = `${sim.state.turn}/${me}`;
    n = k === key ? n + 1 : 0; key = k;
    return n;
  };
}

/**
 * Play `action` for `me`; when the rules refuse it (a printed condition a request does not spell out, such as
 * 「不同属性」), try other moves: a random selection of an allowed size, or another legal move. Returns the move played.
 */
export function playSafely(sim, me, action, rng) {
  let error = sim.attempt(me, action);
  for (let tries = 0; error; tries++) {
    if (tries >= 30) throw error;
    const view = sim.view(me), q = view.pending;
    if (q && q.options?.length) {
      const size = q.minimum + randomIndex(rng, Math.min(q.maximum ?? q.minimum, q.options.length) - q.minimum + 1);
      const pool = [...q.options], selected = [];
      while (selected.length < size) selected.push(...pool.splice(randomIndex(rng, pool.length), 1));
      action = { type: 'answer', requestId: q.id, selected };
    } else {
      const moves = view.legalActions.filter((a) => a.type !== 'concede');
      action = tries >= 20 ? { type: 'endTurn' } : moves[randomIndex(rng, moves.length)];
    }
    error = sim.attempt(me, action);
  }
  return action;
}

// Steps of one player in a row on one turn after which a game is given up: a choice that only starts itself again (an
// attack copying an attack that copies attacks) can leave no way out.
export const TURN_STEP_LIMIT = 150;

/**
 * Play `sim` to the end (or `maxSteps`, or a turn of TURN_STEP_LIMIT steps). Returns { winner: 0 | 1 | null, reason,
 * steps, ms: [agent0, agent1] }.
 */
export function playGame(sim, agents, { maxSteps = 3000, seed = [5, 4, 3, 2] } = {}) {
  const ms = [0, 0], count = stepCounter(), rng = [...seed];
  let steps = 0;
  for (let me; (me = sim.actor) !== null; steps++) {
    if (steps >= maxSteps) return { winner: null, reason: 'step-limit', steps, ms };
    const inTurn = count(sim, me);
    if (inTurn >= TURN_STEP_LIMIT) return { winner: null, reason: 'turn-limit', steps, ms };
    const t = performance.now(), action = agents[me].decide(sim, me, inTurn);
    ms[me] += performance.now() - t;
    playSafely(sim, me, action, rng);
  }
  const r = sim.state.result;
  return { winner: r.draw ? null : r.winner, reason: r.reason, steps, ms };
}
