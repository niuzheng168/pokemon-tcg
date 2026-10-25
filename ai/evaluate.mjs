// How good a position is for `me`, as a chance of winning (0–1), from `me`'s view: a logistic model over differences
// between the two sides, fitted to self-play results (scripts/ai-fit-value.mjs writes value-weights.mjs). Every feature
// is "mine minus theirs", so the two players' chances always add up to 1. A finished game is 1, 0 or ½.
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

export function createEvaluator(catalog, weights = VALUE_WEIGHTS.weights) {
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
