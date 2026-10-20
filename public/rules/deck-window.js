/**
 * CN/V20261019 fixed, private deck inspection -> own hand -> shuffled bottom.
 *
 * Host contract:
 * - ctx is the existing { state, source, definitions } effect context. The
 *   actual user is source.owner (0/1), NOT state.current or the card's author.
 * - state.players[owner].deck is BOTTOM FIRST, as in OfficialGame/pop(). All
 *   returned window/selected/remainder arrays are TOP FIRST. selected preserves
 *   the answer's order; remainder preserves its pre-shuffle window order.
 * - inspectDeckWindow returns PRIVATE prompt material, not a player view.
 *   Never publish the window to the opponent. revealSelected reveals only the
 *   chosen cards if the reviewed card says so; it never reveals the remainder.
 * - Save the exact original window AND uninspected deck in private escrow.
 *   Validate a restored plan against that original ctx before removing cards,
 *   or reconstruct that ctx from independently checked escrow/zone receipts.
 *   A plan is not authenticated by checking it against its own claimed window.
 * - After plan validation, the authoritative host calls its real shuffle on a
 *   COPY of plan.remainder. Treat that result as top first; prepend its reverse
 *   to the uninspected bottom-first deck. Only this subset is shuffled. Keep
 *   its order AND the RNG state private from BOTH players, including the user
 *   who saw the window. No public/private-to-owner shuffle-order event.
 * - remainder.length > 0 is a shuffle event, including length 1 (which may
 *   consume no random words); length 0 is not. This module never samples RNG,
 *   moves cards, dispatches events or determines whether a Trainer can be used.
 *
 * Definitions must already be normalized and independently admitted by the
 * host's catalog policy. This value protocol, physical cards, primary-image
 * observations and "verified"/"approved" flags issue NO approval or trustpins.
 * The permutation assertion proves conservation, NOT that RNG was really used.
 */
import { matchesCardSelector, selectorQuantityClass } from './card-selection.js';
import { selectionBounds, canSelectCount } from './selection.js';

export const DECK_WINDOW_RULE_IDS = Object.freeze([
  'effects.search', 'effects.partial', 'selection.hidden', 'selection.exact',
  'selection.up-to', 'selection.any', 'effects.shuffle', 'effects.return',
]);

const source = (section, pages) => Object.freeze({
  documentId: 'CN-advanced-3.1.0', section, pdfPages: Object.freeze(pages),
});
// One-based PDF pages, from the pinned Ver.3.1.0 bytes, not international rules.
export const DECK_WINDOW_SOURCES = Object.freeze({
  hiddenSelection: source('I.H', [18]),
  cardInstructionAndShortfall: source('II.A', [19]),
  inspection: source('II.C-20', [41]),
  exact: source('II.D-04', [43, 44]),
  upTo: source('II.D-05', [44]),
  anyQuantity: source('II.D-02', [42, 43]),
  shuffleRemainder: source('II.E-35', [73, 74]),
  // E-36 is the DISTINCT full-deck operation, not Rika's remainder operation.
  shuffleDistinction: source('II.E-35—36', [73, 74]),
});

/**
 * Reject non-JSON values without invoking getters or altering/freeze-marking
 * inputs. A separate strict shape check follows, so extra fields cannot act as
 * flags, future modes, implicit destinations or approval claims.
 */
function data(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value) ||
      typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || ancestors.has(value) ||
      (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype :
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))))
    throw new TypeError('Deck inspection requires finite, acyclic plain JSON.');
  const keys = Reflect.ownKeys(value), array = Array.isArray(value);
  if (array && keys.length !== value.length + 1)
    throw new TypeError('Deck inspection arrays must be dense data arrays.');
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value') ||
        array && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key ||
          Number(key) < 0 || Number(key) >= value.length))
      throw new TypeError('Deck inspection rejects executable, hidden or extra array properties.');
    data(property.value, ancestors);
  }
  ancestors.delete(value);
}

function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key)))
    throw new TypeError('Deck inspection records require exactly their declared fields.');
}
const text = (value) => typeof value === 'string' && value.length > 0;
const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
function ids(value) {
  data(value);
  if (!Array.isArray(value) || value.some((id) => !text(id)) || new Set(value).size !== value.length)
    throw new TypeError('Deck inspection requires an array of unique nonempty card IDs.');
  return value;
}

/** Standalone gate matching deck-window.schema.json; no shared generator edit. */
export function assertDeckInspectionAction(action) {
  data(action);
  record(action, ['op', 'lookTop', 'selector', 'quantity', 'revealSelected', 'remainder']);
  if (action.op !== 'inspectDeck' || !Number.isSafeInteger(action.lookTop) || action.lookTop <= 0 ||
      typeof action.revealSelected !== 'boolean')
    throw new TypeError('Deck inspection needs a positive safe lookTop and explicit revealSelected.');
  // Reuse the exact reviewed CardSelector schema and its literal any-card
  // classification. Never infer "any" from the contents of this particular deck.
  selectorQuantityClass(action.selector);
  const q = action.quantity;
  record(q, q?.kind === 'any' ? ['kind'] : ['kind', 'count']);
  if (!['exact', 'upTo', 'any'].includes(q.kind) ||
      q.kind !== 'any' && (!Number.isSafeInteger(q.count) || q.count <= 0))
    throw new TypeError('Deck inspection needs exact/upTo with a positive count, or any without count.');
  record(action.remainder, ['mode']);
  if (action.remainder.mode !== 'shuffleToBottom')
    throw new TypeError('Only remainder-only shuffleToBottom is supported.');
  return action;
}

export function validateDeckInspectionAction(action) {
  try { assertDeckInspectionAction(action); return true; } catch { return false; }
}

function ownDeck(ctx) {
  const owner = ctx?.source?.owner;
  if (owner !== 0 && owner !== 1)
    throw new TypeError('Deck inspection needs the actual source owner (0 or 1).');
  return ids(ctx.state?.players?.[owner]?.deck);
}

/** No access to an uninspected card's definition, or to any opponent zone. */
export function inspectDeckWindow(ctx, action) {
  assertDeckInspectionAction(action);
  const deck = ownDeck(ctx);
  const window = deck.slice(Math.max(0, deck.length - action.lookTop)).reverse();
  const eligible = window.filter((id) => {
    const cards = ctx.state.cards;
    const card = cards && Object.hasOwn(cards, id) ? cards[id] : null;
    if (!card || card.instanceId !== id || card.owner !== ctx.source.owner || !text(card.definitionId) ||
        !ctx.definitions || !Object.hasOwn(ctx.definitions, card.definitionId))
      throw new TypeError('Inspected cards need their own physical identity and a catalog definition.');
    const definition = ctx.definitions[card.definitionId];
    if (!definition || !['pokemon', 'trainer', 'energy'].includes(definition.kind))
      throw new TypeError('Inspected cards need a normalized card definition.');
    return matchesCardSelector(definition, action.selector);
  });
  const bounds = selectionBounds({
    ...action.quantity, available: eligible.length, zone: 'deck',
    filter: selectorQuantityClass(action.selector),
  });
  return { window, eligible, bounds };
}

/**
 * Pure, detached plan; chosen order is retained, no sorting or auto-selection.
 * For an any-card exact 2, choose min(2, window.length), never "fail to find".
 * A specific hidden selector has I.H's lower bound 0; upTo any-card is 1..N
 * when something is available; any QUANTITY is 0..available (II.D-02).
 */
export function planDeckInspection(ctx, action, chosen) {
  const { window, eligible, bounds } = inspectDeckWindow(ctx, action);
  ids(chosen);
  if (!canSelectCount(bounds, chosen.length) || chosen.some((id) => !eligible.includes(id)))
    throw new TypeError('Chosen cards violate the fixed window, selector or CN quantity bounds.');
  return {
    window, selected: [...chosen], remainder: window.filter((id) => !chosen.includes(id)),
  };
}

function planShape(plan) {
  data(plan);
  record(plan, ['window', 'selected', 'remainder']);
  for (const key of ['window', 'selected', 'remainder']) ids(plan[key]);
  if (plan.selected.some((id) => !plan.window.includes(id)) ||
      !same(plan.remainder, plan.window.filter((id) => !plan.selected.includes(id))))
    throw new TypeError('A plan must partition its exact window, with remainder still in original top order.');
}

/**
 * Validate saved JSON against authoritative ORIGINAL deck/definition context.
 * If a separate answer/escrow receipt exists, pass its chosen array too: this
 * also binds the exact selected IDs and their order instead of accepting any
 * other otherwise legal answer. Neither input alone authenticates the other.
 */
export function assertDeckInspectionPlan(ctx, action, plan, chosen = undefined) {
  planShape(plan);
  const expected = planDeckInspection(ctx, action, chosen === undefined ? plan.selected : chosen);
  if (!same(plan.window, expected.window) || !same(plan.selected, expected.selected) ||
      !same(plan.remainder, expected.remainder))
    throw new TypeError('Saved inspection does not match the exact original deck window.');
  return plan;
}

/** Event semantics, not a flag supplied by a caller or an RNG receipt. */
export function deckInspectionNeedsShuffle(plan) {
  planShape(plan);
  return plan.remainder.length > 0;
}

/**
 * Validate the host's private RNG result as an EXACT permutation of remainder.
 * Identity permutations are valid: real shuffling need not change the order.
 * Does not accept a deck, selected cards, an extra copy, or a partial remainder.
 */
export function assertDeckInspectionRemainder(plan, shuffledTopFirst) {
  planShape(plan);
  ids(shuffledTopFirst);
  if (shuffledTopFirst.length !== plan.remainder.length ||
      shuffledTopFirst.some((id) => !plan.remainder.includes(id)))
    throw new TypeError('Shuffled remainder must be an exact permutation of all and only the unselected window.');
  return shuffledTopFirst;
}

/**
 * Assert a proposed post-move deck, without moving cards. All deck arrays here
 * use the existing bottom-first representation; shuffledTopFirst does NOT.
 * This checks both the precise private shuffle result and the untouched suffix
 * (uninspected deck). The host separately checks hand/escrow physical receipts.
 */
export function assertDeckInspectionPlacement(ctx, action, plan, shuffledTopFirst, deckAfter) {
  assertDeckInspectionPlan(ctx, action, plan);
  assertDeckInspectionRemainder(plan, shuffledTopFirst);
  ids(deckAfter);
  const deck = ownDeck(ctx);
  const uninspected = deck.slice(0, deck.length - plan.window.length);
  const expected = [...shuffledTopFirst].reverse().concat(uninspected);
  if (!same(deckAfter, expected))
    throw new TypeError('Only the shuffled remainder may go below the unchanged uninspected deck.');
  return deckAfter;
}
