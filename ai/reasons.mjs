// Why a move scores as it does, from what its rollouts saw (search.mjs facts, averaged over the worlds): a win or a loss
// inside the horizon, Knock Outs and Prizes on both sides, the hand and deck left. Each reason is a code with numbers;
// the table words it (public/i18n). Comparisons are with the best move found; the most telling reasons come first.
const MAX_REASONS = 3;
/** Every reason code (the table has a sentence for each, public/i18n 'adv.<code>'); 'concede' is the service's own. */
export const REASON_CODES = Object.freeze(['wins', 'loses', 'ko', 'takes', 'ko-risk', 'gives', 'fewer-prizes', 'more-risk', 'deck-low',
  'hand-low', 'close', 'board', 'concede']);

export function reasonsFor(move, best) {
  const f = move.facts, b = best?.facts;
  if (!f) return [];
  const out = [];
  const add = (code, values = {}) => out.push({ code, ...values });
  if (f.won >= 0.1) add('wins', { p: f.won });
  if (f.lostGame >= 0.1) add('loses', { p: f.lostGame });
  if (f.koThem >= 0.2) add('ko', { p: f.koThem });
  if (f.took >= 0.1) add('takes', { n: f.took });
  if (f.koUs >= 0.5 || (b && f.koUs - b.koUs >= 0.25)) add('ko-risk', { p: f.koUs });
  if (f.lost >= 0.1) add('gives', { n: f.lost });
  if (b && move !== best) {
    if (b.took - f.took >= 0.3) add('fewer-prizes', { n: b.took - f.took });
    if (f.lost - b.lost >= 0.3) add('more-risk', { n: f.lost - b.lost });
  }
  if (f.deck <= 6 && (!b || b.deck - f.deck >= 1 || f.deck <= 3)) add('deck-low', { n: f.deck });
  if (b && f.hand <= 1 && b.hand - f.hand >= 2) add('hand-low', { n: f.hand });
  if (!out.length && b && move !== best && move.value != null && best.value != null)
    add(best.value - move.value < 0.02 ? 'close' : 'board', { d: best.value - move.value });
  return out.slice(0, MAX_REASONS);
}
