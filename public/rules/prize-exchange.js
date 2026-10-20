/**
 * CN/V20261019 advanced II.C-20 p41, II.E-34 p73 and II.E-35 p73–74.
 * PRIVATE inspection of all own face-down Prizes, followed by at most one
 * exchange with the actual resolving Item/Supporter. No move, hand-entry event,
 * Prize award/counting policy, disclosure, shuffle, RNG or catalog approval.
 *
 * ctx is the existing full {state, source, definitions} effect context.
 * Source/Prize physical identity and duplicate zone placement are checked here;
 * full game-state/catalog/source-binding admission remains the host's duty.
 * Only source and Prize DEFINITIONS are inspected, never a runtime Pokémon's
 * HP/types, another zone's card face, or an unrelated definition.
 *
 * Plan order is the pre-shuffle Prize-array order, NOT knowledge of the final
 * order. Host must independently shuffle ALL remaining/replaced Prizes face
 * down and hide that order from BOTH players, including the inspecting actor.
 * A zero choice leaves source outside Prizes, for normal Trainer finalization.
 * E-31/beforeHand interaction is deliberately NOT adjudicated by this planner.
 */
import { matchesCardSelector, selectorQuantityClass } from './card-selection.js';
import { validateCardDefinition } from './schema-validators.js';
import { selectionBounds, canSelectCount } from './selection.js';

export const PRIZE_EXCHANGE_RULE_IDS = Object.freeze([
  'effects.prize-exchange', 'selection.prizes', 'selection.exact', 'effects.shuffle',
]);
export const PRIZE_EXCHANGE_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.C-20', pdfPages: Object.freeze([41]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-34', pdfPages: Object.freeze([73]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-35', pdfPages: Object.freeze([73, 74]) }),
]);

export class PrizeExchangeError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'PrizeExchangeError';
    this.code = code;
    this.ruleId = 'effects.prize-exchange';
  }
}
const fail = (code, message) => { throw new PrizeExchangeError(code, message); };
const text = (value) => typeof value === 'string' && value.length > 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
const CONTEXT = 'invalid-prize-exchange-context';

function array(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1)
    fail(code, 'Prize-exchange arrays must be dense plain data without extra fields.');
  for (let i = 0; i < value.length; i++) {
    const p = Object.getOwnPropertyDescriptor(value, String(i));
    if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Prize-exchange arrays cannot contain holes, hidden items or accessors.');
  }
  return value;
}

// Validate before reading values; detach to null-prototype records internally.
// This also prevents shared selector/schema helpers from seeing inherited
// getters/defaults for missing optional/required fields. Shared subtrees are
// allowed; ancestor cycles are not. No input is modified or frozen.
function data(value, code, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || ancestors.has(value))
    fail(code, 'Prize-exchange descriptions require finite, acyclic plain JSON.');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = array(value, code).map((item) => data(item, code, ancestors));
  } else {
    result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      const p = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !p.enumerable || !Object.hasOwn(p, 'value'))
        fail(code, 'Prize-exchange fields cannot be hidden, symbolic or executable.');
      result[key] = data(p.value, code, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}

function record(value, required, optional, code) {
  if (!plain(value) || required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    fail(code, 'Prize-exchange records must contain exactly their declared fields.');
}

function ids(value, code) {
  const copy = data(value, code);
  if (!Array.isArray(copy) || copy.some((id) => !text(id)) || new Set(copy).size !== copy.length)
    fail(code, 'Use unique nonempty physical card IDs, not names, copies or Energy units.');
  return copy;
}

// Existing effect contexts contain unrelated private facts. Read required own
// fields by descriptor, without traversing unrelated history/effective caches.
function field(value, key) {
  if (!plain(value)) fail(CONTEXT, 'An explicit plain effect-context record is required.');
  const p = Object.getOwnPropertyDescriptor(value, key);
  if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
    fail(CONTEXT, 'A required context field is missing, inherited, hidden or executable.');
  return p.value;
}

export function assertPrizeExchangeAction(action) {
  const code = 'invalid-prize-exchange-action', copy = data(action, code);
  record(copy, ['op', 'selector', 'revealSelected'], [], code);
  if (copy.op !== 'exchangePrizes' || typeof copy.revealSelected !== 'boolean')
    fail(code, 'Use exchangePrizes with an explicit revealSelected Boolean.');
  // Existing printed CardSelector semantics, including special-Energy identity.
  selectorQuantityClass(copy.selector);
  return action;
}

function physical(cards, id, owner) {
  const card = data(field(cards, id), CONTEXT);
  record(card, ['instanceId', 'definitionId', 'owner'], ['printingId'], CONTEXT);
  if (card.instanceId !== id || !text(card.definitionId) || ![0, 1].includes(card.owner) ||
      owner !== null && card.owner !== owner ||
      Object.hasOwn(card, 'printingId') && !text(card.printingId))
    fail(CONTEXT, 'Physical cards must retain their own identity, original owner and definition.');
  return card;
}

function context(ctx) {
  const source = field(ctx, 'source'), state = field(ctx, 'state');
  const owner = field(source, 'owner'), sourceId = field(source, 'instanceId');
  if (![0, 1].includes(owner) || !text(sourceId))
    fail(CONTEXT, 'Use the actual source owner and nonempty physical source ID.');
  const cards = field(state, 'cards'), definitions = field(ctx, 'definitions');
  if (!plain(cards) || !plain(definitions)) fail(CONTEXT, 'Physical-card and definition maps must be plain records.');
  const players = array(field(state, 'players'), CONTEXT);
  if (players.length !== 2) fail(CONTEXT, 'Exactly two explicit player slots are required.');

  const occupied = new Set();
  const occupy = (id, holder) => {
    if (occupied.has(id)) fail(CONTEXT, 'A physical card cannot occur twice or in two zones.');
    physical(cards, id, holder);
    occupied.add(id);
  };
  let window, resolving;
  // Identity-only zone audit, not card-face inspection. Queue/history references
  // are not zones; in-play stack/Energy/Tool IDs and the shared Stadium are.
  for (let holder = 0; holder < 2; holder++) {
    const player = players[holder];
    for (const zone of ['deck', 'hand', 'discard', 'lost', 'prizes', 'resolving']) {
      const contents = ids(field(player, zone), CONTEXT);
      for (const id of contents) occupy(id, holder);
      if (holder === owner && zone === 'prizes') window = contents;
      if (holder === owner && zone === 'resolving') resolving = contents;
    }
    const active = field(player, 'active'), bench = array(field(player, 'bench'), CONTEXT);
    const mons = active === null ? bench : [active, ...bench];
    for (const mon of mons) for (const zone of ['stack', 'energy', 'tools']) {
      const contents = ids(field(mon, zone), CONTEXT);
      if (zone === 'stack' && !contents.length) fail(CONTEXT, 'An in-play Pokémon must have a physical stack.');
      for (const id of contents) occupy(id, holder);
    }
  }
  const stadium = field(state, 'stadium');
  if (stadium !== null) {
    if (!text(stadium)) fail(CONTEXT, 'Stadium must be an explicit physical ID or null.');
    occupy(stadium, null);
  }
  if (!resolving.includes(sourceId)) fail(CONTEXT, 'The exchanged Trainer itself must be in own resolving.');
  return { owner, sourceId, window, cards, definitions };
}

function definition(info, id) {
  const card = physical(info.cards, id, info.owner);
  const def = data(field(info.definitions, card.definitionId), CONTEXT);
  if (!validateCardDefinition(def) || def.definitionId !== card.definitionId)
    fail(CONTEXT, 'Source/Prize cards require their own normalized printed definitions, not live battle fields.');
  return def;
}

/** PRIVATE prompt material; no public/owner post-shuffle order is produced. */
export function prizeExchangeWindow(ctx, action) {
  assertPrizeExchangeAction(action);
  const info = context(ctx), source = definition(info, info.sourceId);
  if (source.kind !== 'trainer' || !['item', 'supporter'].includes(source.mechanics.category))
    fail(CONTEXT, 'Only the resolving physical Item/Supporter itself can be exchanged.');
  const selector = data(action.selector, 'invalid-prize-exchange-action');
  const eligible = info.window.filter((id) => matchesCardSelector(definition(info, id), selector));
  const bounds = selectionBounds({
    kind: 'exact', count: 1, available: eligible.length,
    zone: 'ownFaceDownPrizes', filter: selectorQuantityClass(selector),
  });
  return { owner: info.owner, sourceId: info.sourceId, window: [...info.window], eligible, bounds };
}

/** Pure PRE-COMMIT exchange. chosen is [] or [physicalId], never an auto-pick. */
export function planPrizeExchange(ctx, action, chosen) {
  const view = prizeExchangeWindow(ctx, action);
  const selected = ids(chosen, 'invalid-prize-exchange-selection');
  if (!canSelectCount(view.bounds, selected.length) || selected.some((id) => !view.eligible.includes(id)))
    fail('invalid-prize-exchange-selection', 'Choose within the original private Prize window and CN exact/hidden bounds.');
  const prizesAfter = view.window.map((id) => selected.includes(id) ? view.sourceId : id);
  return { owner: view.owner, sourceId: view.sourceId, window: [...view.window], selected, prizesAfter };
}

/**
 * Recompute against the authoritative ORIGINAL context, not a plan's own
 * asserted window or an already-applied/reshuffled board. Host must separately
 * bind the real answer/source and guard unresolved E-31/beforeHand interaction.
 * This validates a plan, not whether the selected card counts as a Prize award.
 */
export function assertPrizeExchangePlan(ctx, action, plan) {
  const code = 'invalid-prize-exchange-plan', copy = data(plan, code);
  record(copy, ['owner', 'sourceId', 'window', 'selected', 'prizesAfter'], [], code);
  if (![0, 1].includes(copy.owner) || !text(copy.sourceId)) fail(code, 'Plans require the actual source and owner.');
  for (const key of ['window', 'selected', 'prizesAfter']) ids(copy[key], code);
  const expected = planPrizeExchange(ctx, action, copy.selected);
  if (copy.owner !== expected.owner || copy.sourceId !== expected.sourceId ||
      !same(copy.window, expected.window) ||
      !same(copy.prizesAfter, expected.prizesAfter))
    fail(code, 'Saved exchange differs from the original private window, source or exact replacement.');
  return plan;
}
