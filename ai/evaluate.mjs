// How good a position is for `me`, as a chance of winning (0–1), from `me`'s view: a logistic model over differences
// between the two sides. Every feature is "mine minus theirs", so the two players' chances always add up to 1. A
// finished game is 1, 0 or ½. Two sets of weights (scripts/ai-fit-value.mjs fits both to self-play results):
// - SEARCH_WEIGHTS, what the search plays with: hand-set weights that reward development (Energy attached, cards in
//   hand), scaled so the estimate is a chance to win. Searches with them beat the old CPU 77% of the time.
// - the fully fitted weights predict self-play results better (held-out log loss 0.558 and 68.6% right, against 0.656
//   and 57.5%) but value no development, so a search with them looks only at this turn's Prizes and won only half its
//   games against the old CPU (docs/ai/STATUS.md).
import { boardReader, mons, top } from './board.mjs';
import { VALUE_WEIGHTS } from './value-weights.mjs';

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** The features, in the order of the weights. */
export const FEATURES = Object.freeze([
  'prizesLeft',   // Prizes still to take (theirs − mine): the race itself
  'threat',       // Prizes a Knock Out of their Active next turn would give (with one more Energy at most)
  'reach',        // the most damage my Active does to theirs now, as a share of its HP (up to 1)
  'hp',           // HP left in play, per 100
  'activeHp',     // the Active's HP left, as a share of its maximum
  'energy',       // Energy units attached in play
  'evolved',      // evolved Pokémon in play
  'ready',        // Pokémon that can attack now
  'liability',    // Prizes my Pokémon in play would give (theirs − mine)
  'hand',         // cards in hand (up to 8)
  'noBench',      // nothing on the Bench (a Knock Out of the Active ends the game)
  'deckLow',      // deck cards short of 6
  'toMove',       // whose turn it is
]);

/** The hand-set weights (no reach, active HP, liability or turn), and the search's: those scaled to a chance to win. */
export const HAND_WEIGHTS = Object.freeze([0.75, 0.45, 0, 0.12, 0, 0.08, 0.15, 0.2, 0, 0.05, 0.6, 0.15, 0]);
export const SEARCH_WEIGHTS = Object.freeze(HAND_WEIGHTS.map((w) => w * (VALUE_WEIGHTS.handScale ?? 1)));

export function createEvaluator(catalog, weights = SEARCH_WEIGHTS) {
  const { facts, attached, threatens, bestDamage } = boardReader(catalog);
  const prizeCount = (m) => facts(top(m).definitionId).prizes;
  function side(view, i) {
    const p = view.players[i], foe = view.players[1 - i], board = mons(p), a = p.active, d = foe.active;
    return {
      prizesLeft: p.prizes.count ?? p.prizes.length ?? 0,
      threat: threatens(a, d) ? prizeCount(d) : 0,
      reach: a && d ? Math.min(1, bestDamage(a, d) / Math.max(10, d.effective.currentHp)) : 0,
      hp: board.reduce((n, m) => n + m.effective.currentHp, 0) / 100,
      activeHp: a ? a.effective.currentHp / Math.max(10, a.effective.maxHp) : 0,
      energy: board.reduce((n, m) => n + attached(m), 0),
      evolved: board.filter((m) => m.stack.length > 1).length,
      ready: board.filter((m) => bestDamage(m, d) > 0).length,
      liability: board.reduce((n, m) => n + prizeCount(m), 0),
      hand: Math.min(8, Array.isArray(p.hand) ? p.hand.length : p.hand.count),
      noBench: p.bench.length === 0 ? 1 : 0,
      deckLow: Math.max(0, 6 - p.deckCount),
      toMove: view.current === i ? 1 : 0,
    };
  }
  // Features where more is worse for its owner count the other way round.
  const WORSE = new Set(['prizesLeft', 'liability', 'noBench', 'deckLow']);
  /** The feature vector for `me` (each "good for me" minus "good for them"). */
  function vector(view, me) {
    const a = side(view, me), b = side(view, 1 - me);
    return FEATURES.map((k) => (WORSE.has(k) ? b[k] - a[k] : a[k] - b[k]));
  }
  /** P(win) for `me`. */
  function evaluate(view, me) {
    if (view.result) return view.result.draw ? 0.5 : view.result.winner === me ? 1 : 0;
    const x = vector(view, me);
    return sigmoid(x.reduce((n, v, i) => n + v * weights[i], 0));
  }
  return { evaluate, vector };
}
