// Monte Carlo search over the moves available now. A rollout deals one possible world (worlds.mjs: hidden cards dealt
// again, a new random state), plays a candidate move in it, lets the policy play both sides up to the horizon and
// scores the position (a finished game 1/0, otherwise evaluate.mjs). Every candidate is played in the same worlds with
// the same rollout randomness, so their differences are not noise from different deals. After half the worlds the
// weaker half of the candidates can be dropped.
//
// The search is a plan of rollout jobs (plan), so the same jobs can run here one after another (analyse) or spread over
// worker threads (ai/service.mjs); a job depends only on its inputs, so both give the same answer.
import { readFileSync } from 'node:fs';
import { Simulation } from '../public/rules/engine.js';
import { randomIndex } from '../public/rules/random.js';
import { createPolicy } from './policy.mjs';
import { boardReader } from './board.mjs';
import { createEvaluator, SEARCH_WEIGHTS } from './evaluate.mjs';
import { VALUE_WEIGHTS } from './value-weights.mjs';
import { createLearnedEvaluator, loadValueModel, DEFAULT_MODEL } from './value-model.mjs';
import { sampleWorld, randomState } from './worlds.mjs';
import { metaGuesser } from './meta.mjs';
import { playSafely, stepCounter, TURN_STEP_LIMIT } from './play.mjs';

/** Moves that do the same thing (two copies of one card, say) share a key; only one of them is searched. */
export function moveKey(state, action) {
  const def = (id) => state.cards[id]?.definitionId ?? id;
  if (action.type === 'answer') return `answer:${action.selected.map(def).sort().join(',')}`;
  const { cardId, jointCardIds, cardIds, ...rest } = action;
  return JSON.stringify({ ...rest, ...(cardId ? { card: def(cardId) } : {}), ...(jointCardIds ? { joint: jointCardIds.map(def).sort() } : {}),
    ...(cardIds ? { cards: cardIds.map(def) } : {}) });
}

// Requests the policy answers alone: nothing to compare, or (face-down Prize cards) nothing to tell the options apart.
const SIMPLE_REQUESTS = new Set(['view-cards', 'counter-allocation', 'guess-answer', 'janken', 'coin-face', 'choose-order', 'mulligan-bonus', 'prize']);

/**
 * The moves worth comparing now: every distinct legal move, or for a request each single option / a few selections.
 * `copies(definitionId, attackId)` tells an attack that copies attacks: choosing one to copy would only ask again, so
 * such a choice is searched only among the others.
 */
export function candidates(view, me, state, policy, rng, copies = () => false) {
  const q = view.pending, out = new Map();
  const add = (action) => { if (action) { const k = moveKey(state, action); if (!out.has(k)) out.set(k, action); } };
  if (!q) { view.legalActions.filter((a) => a.type !== 'concede').forEach(add); return [...out.values()]; }
  add(policy(view, me));
  if (q.kind === 'copy-attack') {
    (q.attacks ?? []).filter((a) => !copies(a.card.definitionId, a.attackId)).forEach((a) => add({ type: 'answer', requestId: q.id, selected: [a.optionId] }));
    return [...out.values()];
  }
  if (SIMPLE_REQUESTS.has(q.kind) || !q.options?.length) return [...out.values()];
  const max = Math.min(q.maximum ?? q.minimum, q.options.length);
  if (max <= 1) q.options.forEach((id) => add({ type: 'answer', requestId: q.id, selected: [id] }));
  if (q.minimum === 0) add({ type: 'answer', requestId: q.id, selected: [] });
  for (let i = 0; i < 6 && max > 1; i++) {
    const size = Math.max(q.minimum, max - randomIndex(rng, 2)), pool = [...q.options], selected = [];
    while (selected.length < size) selected.push(...pool.splice(randomIndex(rng, pool.length), 1));
    add({ type: 'answer', requestId: q.id, selected });
  }
  return [...out.values()];
}

/** The main-phase moves worth searching: the policy's (`chooser`'s) favourites up to `cap`, ending the turn and every attack. */
export function shortlistOf(chooser, view, me, state, list, cap) {
  if (list.length <= cap) return list;
  const keys = new Set(list.map((a) => moveKey(state, a))), chosen = new Map();
  for (const a of chooser.rank(view, me)) {
    const k = moveKey(state, a);
    if (keys.has(k) && (chosen.size < cap || a.type === 'endTurn' || a.type === 'attack')) chosen.set(k, chosen.get(k) ?? a);
  }
  return [...chosen.values()];
}

const FACTS = ['took', 'lost', 'koThem', 'koUs', 'hand', 'deck', 'won', 'lostGame'];
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : -1;

/**
 * options: worlds (how many deals), horizon ('turn': to the end of my turn; 'reply': through the opponent's next turn;
 * 'next': through my next turn too),
 * shortlist (most main-phase moves searched, the policy's favourites plus ending the turn and every attack),
 * margin (how much better than the policy's own move another move must look to be chosen instead: the estimates are
 * noisy, and a move that only looks a little better is as likely a lucky deal), noise (the policy's, inside the
 * rollouts), evaluator ('search', 'fitted' or their average 'blend', evaluate.mjs; 'learned', value-model.mjs, with
 * the model file `model` or ai/value-model.json), weights (evaluate.mjs's weights to use instead of the evaluator's: an
 * array, or a JSON file with { weights }), opponent (how the opponent's unseen cards are guessed: 'guess' from their
 * public cards; 'meta' from the metagame's lists too, meta.mjs, which needs a catalog with metaPrintings and leaves out
 * the list keys `exclude`; 'oracle' only to measure, worlds.mjs sampleWorld), seed.
 */
export function createSearch(catalog, { worlds = 8, horizon = 'reply', noise = 0.1, seed = [2, 4, 6, 8], maxSteps = 200,
  shortlist = Infinity, margin = 0, evaluator = 'search', model = DEFAULT_MODEL, weights: own = null, opponent = 'guess', exclude = [] } = {}) {
  const rng = [...seed], chooser = createPolicy(catalog), { facts } = boardReader(catalog);
  const copies = (definitionId, attackId) => !!facts(definitionId).attacks.find((a) => a.attackId === attackId)?.copies;
  const weights = (typeof own === 'string' ? JSON.parse(readFileSync(own, 'utf8')).weights : own) ?? { search: SEARCH_WEIGHTS,
    fitted: VALUE_WEIGHTS.weights, blend: SEARCH_WEIGHTS.map((w, i) => (w + (VALUE_WEIGHTS.weights[i] ?? 0)) / 2) }[evaluator];
  const { evaluate } = evaluator === 'learned' ? createLearnedEvaluator(catalog, loadValueModel(model)) : createEvaluator(catalog, weights);
  const guesser = opponent === 'meta' ? metaGuesser(catalog, { exclude }) : null;

  /** The world dealt from `worldSeed`, and the randomness its rollouts share. */
  function deal(snapshot, me, worldSeed) {
    const r = [...worldSeed], world = new Simulation(sampleWorld(snapshot, catalog, me, r, { opponent, guesser }), catalog, { checked: false });
    return { world, rolloutSeed: randomState(r) };
  }

  /**
   * One rollout: in the world dealt from `worldSeed`, `me` plays `action`, then the policy plays both sides to the
   * horizon. Returns the score for `me` and what happened on the way (the reasons a move is good or bad): Prizes `me`
   * took by the end of its turn and whether the opponent's Active was Knocked Out, Prizes the opponent took after that
   * and whether `me`'s Active (as its turn ended) was Knocked Out then, `me`'s hand and deck at the end of its turn, and
   * whether the game ended. null when the rules refuse the move in that world.
   */
  function rollout(snapshot, me, worldSeed, action, cache = new Map()) {
    const key = worldSeed.join(',');
    if (!cache.has(key)) cache.set(key, deal(snapshot, me, worldSeed));
    const { world, rolloutSeed } = cache.get(key), sim = world.fork();
    if (sim.attempt(me, action)) return null;
    const policy = createPolicy(catalog, { noise, seed: rolloutSeed }), local = [...rolloutSeed].reverse();
    const count = stepCounter(), prizes = (i) => sim.state.players[i].prizes.length;
    const { turn: startTurn, current: startCurrent } = snapshot, before = snapshot.players[me].prizes.length;
    // The horizon in turn boundaries: the end of this turn, of the opponent's reply, or of `me`'s next turn as well.
    const depth = { turn: 1, reply: 2, next: 3 }[horizon] - (startCurrent === me || horizon === 'turn' ? 0 : 1);
    const done = (s) => s.turn >= startTurn + depth && !s.pending;
    const inPlay = (i, id) => [sim.state.players[i].active, ...sim.state.players[i].bench].some((m) => m?.id === id);
    const theirActive = snapshot.players[1 - me].active?.id ?? null;
    let turnEnd = null;
    const mark = () => {
      turnEnd ??= { mine: prizes(me), theirs: prizes(1 - me), hand: sim.state.players[me].hand.length, deck: sim.state.players[me].deck.length,
        koThem: theirActive && !inPlay(1 - me, theirActive) ? 1 : 0, active: sim.state.players[me].active?.id ?? null };
    };
    for (let steps = 0, p; (p = sim.actor) !== null && !done(sim.state) && steps < maxSteps; steps++) {
      if (sim.state.turn !== startTurn) mark();
      const inTurn = count(sim, p);
      if (inTurn >= TURN_STEP_LIMIT) break;
      playSafely(sim, p, policy(sim.view(p), p, inTurn), local);
    }
    mark();
    const result = sim.state.result;
    return {
      value: evaluate(sim.view(me), me),
      facts: { took: before - turnEnd.mine, lost: turnEnd.theirs - prizes(1 - me), koThem: turnEnd.koThem,
        koUs: horizon === 'reply' && turnEnd.active && !inPlay(me, turnEnd.active) ? 1 : 0, hand: turnEnd.hand, deck: turnEnd.deck,
        won: result ? Number(result.winner === me) : 0, lostGame: result ? Number(!result.draw && result.winner !== me) : 0 },
    };
  }

  /**
   * The search as a plan: it yields lists of rollout jobs { world, action } and expects their results back in order.
   * `moves` searches exactly those; `prune: false` keeps every move to the end (the advisor rates them all); `seed`
   * makes one request reproducible on its own.
   */
  function* plan(snapshot, me, { moves = null, prune = true, seed: own = null } = {}) {
    const r = own ? [...own] : rng, view = new Simulation(snapshot, catalog, { checked: false }).view(me);
    // During setup nothing of the opponent is public yet, so there is no world to deal: the policy places the Pokémon.
    let list = moves ?? (snapshot.phase === 'setup' ? [chooser(view, me)] : candidates(view, me, snapshot, chooser, r, copies));
    if (!moves && !view.pending) list = shortlistOf(chooser, view, me, snapshot, list, shortlist);
    const stats = list.map((action) => ({ action, key: moveKey(snapshot, action), values: [], facts: [], refused: false, dropped: false }));
    if (stats.length <= 1) return summary(stats, null, 0, true);
    const policyMove = moves ? null : moveKey(snapshot, chooser(view, me));
    const seeds = Array.from({ length: worlds }, () => randomState(r)), half = Math.ceil(worlds / 2);
    for (const [index, round] of [seeds.slice(0, half), seeds.slice(half)].entries()) {
      if (!round.length) continue;
      if (index === 1 && prune && stats.length > 2) {
        const alive = stats.filter((x) => !x.refused).sort((a, b) => mean(b.values) - mean(a.values));
        alive.slice(Math.max(2, Math.ceil(alive.length / 2))).forEach((x) => { x.dropped = true; });
      }
      const live = stats.filter((x) => !x.refused && !x.dropped);
      const jobs = round.flatMap((world) => live.map((x) => ({ world, action: x.action })));
      const results = yield jobs;
      results.forEach((res, i) => {
        const x = live[i % live.length];
        if (!res) x.refused = true;
        else if (!x.refused) { x.values.push(res.value); x.facts.push(res.facts); }
      });
    }
    return summary(stats, policyMove, margin);
  }

  /**
   * Score the candidate moves for `me` in the position `snapshot` (a full game state: the search itself hides what `me`
   * cannot know), one rollout after another. Returns { moves: [{ action, key, value, se, n, facts }], best }.
   */
  function analyse(snapshot, me, options = {}) {
    const it = plan(snapshot, me, options), cache = new Map();
    let step = it.next();
    while (!step.done) step = it.next(step.value.map((job) => rollout(snapshot, me, job.world, job.action, cache)));
    return step.value;
  }
  return Object.assign(analyse, { plan, rollout });
}

// The moves best first; `best` is the policy's own move unless another looks at least `margin` better.
function summary(stats, policyMove, margin, only = false) {
  const moves = stats.filter((x) => !x.refused).map((x) => {
    const n = x.values.length, m = mean(x.values), sd = n > 1 ? Math.sqrt(x.values.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1)) : 0;
    const avg = (k) => x.facts.reduce((a, f) => a + f[k], 0) / n;
    return { action: x.action, key: x.key, value: only ? null : m, se: n > 1 ? sd / Math.sqrt(n) : null, n,
      facts: n ? Object.fromEntries(FACTS.map((k) => [k, avg(k)])) : null };
  }).sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || b.n - a.n);
  const own = margin > 0 && moves.find((m) => m.key === policyMove && m.value != null);
  const best = own && moves[0].value - own.value < margin ? own : moves[0];
  return { moves, best: best?.action ?? null };
}
