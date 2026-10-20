/**
 * CN/V20261019 II.E-19 FAQ2 (PDF p63), II.E-35 (p73–74).
 * Entire targeted hands are independently shuffled face down, then put under
 * their owners' UNCHANGED decks. This is not E-36's full-deck shuffle.
 *
 * ctx is the true COMMITTED effect context: the host has already removed the
 * played Trainer and paid costs. Declaration eligibility is a separate host
 * projection; do not treat a pre-play hand containing only that Trainer as a
 * performed effect. Neither source.owner nor physical owners are current-player
 * defaults. This module reads identities/owners only, never card definitions.
 *
 * Windows/plans are detached PRIVATE JSON, not public/player-view events or
 * permissions. both uses actual-user-first serialization order, not a ruling
 * on simultaneous trigger priority. Empty windows are retained.
 *
 * The host independently shuffles COPIES of each whole hand, keeps the new
 * order private from BOTH players, sets deck=[...shuffledHandBottomFirst,
 * ...oldDeck], and clears that hand. Nonempty includes a singleton; an empty
 * hand does not constitute processing, even if its deck is nonempty. This
 * module never samples RNG, moves cards, draws, triggers, or approves cards.
 */

export const HAND_BOTTOM_RULE_IDS = Object.freeze(['effects.hand-bottom']);
export const HAND_BOTTOM_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-19 FAQ2', pdfPages: Object.freeze([63]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-35', pdfPages: Object.freeze([73, 74]) }),
]);

export class HandBottomError extends TypeError {
  constructor(code, message) { super(message); this.name = 'HandBottomError'; this.code = code; }
}
const fail = (code, message) => { throw new HandBottomError(code, message); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const player = (value) => value === 0 || value === 1;
const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

// Exact caller records and primitive leaves are validated without invoking
// accessors, toJSON, inherited defaults, or recursively scanning host context.
function record(value, keys, code) {
  if (!plain(value)) fail(code, 'A hand-bottom record must be plain data.');
  for (const key of Reflect.ownKeys(value)) {
    const p = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Unknown, hidden or executable hand-bottom fields are not allowed.');
  }
  if (keys.some((key) => !Object.hasOwn(value, key))) fail(code, 'Hand-bottom fields must be explicit.');
}

function field(value, key, code) {
  if (!plain(value)) fail(code, 'A requested hand-bottom context record must be plain data.');
  const p = Object.getOwnPropertyDescriptor(value, key);
  if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
    fail(code, 'A requested hand-bottom fact is missing, inherited, hidden or executable.');
  return p.value;
}

function array(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1)
    fail(code, 'Hand-bottom arrays must be ordinary dense data arrays.');
  for (let i = 0; i < value.length; i++) {
    const p = Object.getOwnPropertyDescriptor(value, String(i));
    if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Hand-bottom arrays cannot contain holes, hidden items or accessors.');
  }
  return value;
}

function ids(value, code) {
  array(value, code);
  if (value.some((id) => typeof id !== 'string' || id.length === 0) || new Set(value).size !== value.length)
    fail(code, 'Use unique nonempty physical card IDs without coercion.');
  return value;
}

/** Strict standalone action gate; no implicit side, selector or destination. */
export function assertHandBottomAction(action) {
  const code = 'invalid-hand-bottom-action';
  record(action, ['op', 'side'], code);
  if (action.op !== 'shuffleHandToBottom' || !['own', 'opponent', 'both'].includes(action.side))
    fail(code, 'Use shuffleHandToBottom with explicit own/opponent/both side.');
  return action;
}

/** Original hand order and original BOTTOM-FIRST deck order; detached arrays. */
export function handBottomWindows(ctx, action) {
  assertHandBottomAction(action);
  const code = 'invalid-hand-bottom-context';
  const owner = field(field(ctx, 'source', code), 'owner', code);
  if (!player(owner)) fail(code, 'A real source owner (0 or 1) is required.');
  const state = field(ctx, 'state', code), players = array(field(state, 'players', code), code);
  const cards = field(state, 'cards', code);
  if (players.length !== 2 || !plain(cards)) fail(code, 'Use two actual players and a plain physical-card map.');
  const owners = action.side === 'both' ? [owner, 1 - owner] : [action.side === 'own' ? owner : 1 - owner];
  const seen = new Set(), windows = [];
  for (const holder of owners) {
    const hand = ids(field(players[holder], 'hand', code), code);
    const deck = ids(field(players[holder], 'deck', code), code);
    for (const id of [...hand, ...deck]) {
      if (seen.has(id)) fail(code, 'A physical card cannot appear in multiple requested hand/deck zones.');
      seen.add(id);
      const card = field(cards, id, code);
      if (field(card, 'instanceId', code) !== id || field(card, 'owner', code) !== holder)
        fail(code, 'Every requested card must retain its exact physical identity and original owner.');
    }
    windows.push({ owner: holder, hand: [...hand], deck: [...deck] });
  }
  return windows;
}

/** Preparation only. A nonempty requested hand counts even if its deck is empty. */
export function planHandBottom(ctx, action) {
  const windows = handBottomWindows(ctx, action);
  return { windows, performed: windows.some((window) => window.hand.length > 0) };
}

function windowShape(window) {
  const code = 'invalid-hand-bottom-window';
  record(window, ['owner', 'hand', 'deck'], code);
  if (!player(window.owner)) fail(code, 'A window needs its absolute physical owner.');
  ids(window.hand, code); ids(window.deck, code);
  if (window.hand.some((id) => window.deck.includes(id)))
    fail(code, 'Original hand and original deck must be physically disjoint.');
}

/**
 * Conservation, NOT RNG provenance. The window must come from the host's
 * independently checked original context/escrow, never from the claimed answer.
 * Identity permutations, singletons and empty permutations are all valid.
 */
export function assertHandBottomPermutation(window, shuffledHandBottomFirst) {
  windowShape(window);
  const code = 'invalid-hand-bottom-permutation';
  ids(shuffledHandBottomFirst, code);
  if (shuffledHandBottomFirst.length !== window.hand.length ||
      shuffledHandBottomFirst.some((id) => !window.hand.includes(id)))
    fail(code, 'Shuffle exactly the whole original hand, without any old-deck cards.');
  return shuffledHandBottomFirst;
}

/** Pure post-move check: no reverse, unchanged old-deck suffix, emptied hand. */
export function assertHandBottomWindowPlacement(window, shuffledHandBottomFirst, handAfter, deckAfter) {
  assertHandBottomPermutation(window, shuffledHandBottomFirst);
  const code = 'invalid-hand-bottom-placement';
  ids(handAfter, code); ids(deckAfter, code);
  if (handAfter.length || !same(deckAfter, [...shuffledHandBottomFirst, ...window.deck]))
    fail(code, 'Place only the shuffled hand below the unchanged old deck, and clear the whole hand.');
  return deckAfter;
}
