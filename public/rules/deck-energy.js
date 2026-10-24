import { matchesCardSelector, selectorQuantityClass, isKindSelector } from './card-selection.js';
import { matchesInPlaySelector } from './in-play-selection.js';
import { selectionBounds, canSelectCount } from './selection.js';

/**
 * Own-deck -> own-Pokémon planning only. Never changes zones, counters, flags,
 * RNG, source identity or attachment triggers. Deck arrays are bottom -> top.
 *
 * CN sources: I.H (p18), II.C-09 (p31-32), II.D-02/04/05 (p42-44),
 * II.E-18 (p62), II.E-35/36 (p73-74), II.E-39 (p76).
 * The reviewed Chinese Generator face specifies top 5 / up to 2 Basic Lightning
 * cards / own Benched Lightning Pokémon / arbitrary distribution. Pikachu 151C
 * 025 specifies one Basic Lightning card from the deck attached to the user.
 * These are instructions parameterized by the reviewed action, not card names
 * interpreted here and not approval of either printing.
 *
 * Recipient CardSelectors use explicit host-derived effective Pokémon types;
 * their other identity predicates and out-of-play Energy selection stay printed.
 * This module does not invent effective-type transformations or printed fallback.
 * Protection, actual effect application, triggers and Special Energy retention
 * remain the host's responsibility. handAttachTo is NOT a deck-attachment gate.
 *
 * No-recipient ruling boundary: C-09 forbids foreign recipients but does not
 * explicitly settle whether a look/attach/shuffle card with no eligible receiver
 * may still inspect. C-11's pre-inspection Bench-full rule concerns deployment,
 * not Energy attachment. Do not import that rule or an international default:
 * return needsRuling without inspecting/revealing a window.
 *
 * assertDeckEnergyPlan validates a PRE-COMMIT plan against the original deck
 * window. A resumable host that escrows/removes selected cards must separately
 * journal the original plan and validate its applied prefix/escrow; it must not
 * pretend a partially mutated board is this original planning context.
 */
export const DECK_ENERGY_RULE_IDS = Object.freeze([
  'effects.attach', 'effects.search', 'effects.shuffle', 'energy.units',
  'selection.hidden', 'selection.exact', 'selection.up-to', 'selection.any',
]);
export const DECK_ENERGY_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'I.H; II.D-02/04/05', pdfPages: Object.freeze([18, 42, 43, 44]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.C-09', pdfPages: Object.freeze([31, 32]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-18; II.E-35/36', pdfPages: Object.freeze([62, 73, 74]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-39', pdfPages: Object.freeze([76]) }),
]);

// Reserved allocation target: the chosen card goes to its owner's hand, not a Pokémon.
export const DECK_ENERGY_HAND = '@hand';

export class DeckEnergyError extends TypeError {
  constructor(code, message) { super(message); this.name = 'DeckEnergyError'; this.code = code; this.needsRuling = code === 'needs-ruling'; }
}
const fail = (code, message) => { throw new DeckEnergyError(code, message); };
const text = (value) => typeof value === 'string' && value.length > 0;
const player = (value) => value === 0 || value === 1;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertJSON(value) {
  const pending = [{ value }], ancestors = new Set();
  while (pending.length) {
    const entry = pending.pop(), current = entry.value;
    if (entry.exit) { ancestors.delete(current); continue; }
    if (current === null || ['string', 'boolean'].includes(typeof current) ||
        typeof current === 'number' && Number.isFinite(current)) continue;
    if (!current || typeof current !== 'object' || ancestors.has(current) ||
        (Array.isArray(current) ? Object.getPrototypeOf(current) !== Array.prototype :
          ![Object.prototype, null].includes(Object.getPrototypeOf(current))))
      fail('invalid-deck-energy-json', 'Actions and plans must be finite, acyclic plain JSON.');
    const array = Array.isArray(current), keys = Reflect.ownKeys(current);
    if (array && keys.length !== current.length + 1)
      fail('invalid-deck-energy-json', 'Sparse/extended arrays are not planning JSON.');
    ancestors.add(current); pending.push({ value: current, exit: true });
    for (const key of keys) {
      if (array && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(current, key);
      if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value') ||
          array && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= current.length))
        fail('invalid-deck-energy-json', 'Accessors, hidden fields and symbols cannot influence a plan.');
      pending.push({ value: d.value });
    }
  }
}
function fields(value, keys, code) {
  if (!record(value) || keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key)))
    fail(code, 'A planning record needs exactly its declared fields.');
}
function ids(value, code) {
  if (!Array.isArray(value) || value.some((id) => !text(id)) || new Set(value).size !== value.length)
    fail(code, 'Use unique physical card/Pokémon IDs, never units or duplicate aliases.');
}

/** Strict handwritten bridge until the host registers the new schema exports. */
export function assertDeckEnergyAction(action) {
  const code = 'invalid-deck-energy-action';
  assertJSON(action);
  fields(action, ['op', 'lookTop', 'selector', 'quantity', 'recipient', 'distribution', 'remainder', 'reveal',
    ...['distinctTypes', 'toHand', 'recipientEffect'].filter((key) => record(action) && Object.hasOwn(action, key))], code);
  if (Object.hasOwn(action, 'distinctTypes') && (action.distinctTypes !== true || action.selector?.category !== 'basic') ||
      Object.hasOwn(action, 'toHand') && (action.toHand !== 1 || action.distribution !== 'separateRecipients'))
    fail(code, 'Distinct Basic Energy types and one-to-hand splits need their exact printed shape.');
  if (action.op !== 'attachDeckEnergy' ||
      action.lookTop !== null && (!Number.isSafeInteger(action.lookTop) || action.lookTop < 1) ||
      !['singleRecipient', 'separateRecipients', 'distinctRecipients'].includes(action.distribution) ||
      !['shuffleDeck', 'hand', 'discard', 'shuffleToBottom'].includes(action.remainder) ||
      action.remainder !== 'shuffleDeck' && action.lookTop === null || typeof action.reveal !== 'boolean')
    fail(code, 'Own-deck attachment needs an explicit bounded/full window, distribution and shuffle/reveal instructions.');
  fields(action.recipient, ['position', 'selector'], code);
  if (!['self', 'active', 'bench', 'any'].includes(action.recipient.position))
    fail(code, 'Unknown own-Pokémon recipient position.');
  for (const [selector, kind] of [[action.selector, 'energy'], [action.recipient.selector, 'pokemon']]) {
    if (!record(selector) || !isKindSelector(selector, kind)) fail(code, `A ${kind} CardSelector is required; arbitrary-card selectors are not attachment instructions.`);
    try { selectorQuantityClass(selector); } catch { fail(code, 'Malformed reviewed CardSelector.'); }
  }
  fields(action.quantity, action.quantity?.kind === 'any' ? ['kind'] : ['kind', 'count'], code);
  if (!['exact', 'upTo', 'any'].includes(action.quantity.kind) ||
      action.quantity.kind !== 'any' && (!Number.isSafeInteger(action.quantity.count) || action.quantity.count < 1))
    fail(code, 'Choose exact/upTo positive physical card counts, or any number; not Energy units.');
  return action;
}

function context(ctx) {
  if (!record(ctx) || !record(ctx.source) || !player(ctx.source.owner) || !record(ctx.state) ||
      !Array.isArray(ctx.state.players) || ctx.state.players.length !== 2 ||
      !record(ctx.state.cards) || !record(ctx.definitions))
    fail('invalid-deck-energy-context', 'Use the real effect context, actual reference player and approved definitions.');
  const owner = ctx.source.owner, own = ctx.state.players[owner];
  if (!record(own) || !Array.isArray(own.bench) || !Array.isArray(own.deck) ||
      own.active !== null && !record(own.active) || own.bench.some((mon) => !record(mon)))
    fail('invalid-deck-energy-context', 'The own deck and actual in-play Pokémon must be explicit.');
  ids(own.deck, 'invalid-deck-energy-context');
  const mons = [own.active, ...own.bench].filter(Boolean);
  ids(mons.map((m) => m.id), 'invalid-deck-energy-context');
  for (const mon of mons) if (!Array.isArray(mon.stack) || !mon.stack.length)
    fail('invalid-deck-energy-context', 'Recipients need an actual current Pokémon stack.');
  return { owner, own, mons };
}
function definition(ctx, id, owner) {
  const card = ctx.state.cards[id], def = card && ctx.definitions[card.definitionId];
  if (!text(id) || !record(card) || card.instanceId !== id || card.owner !== owner ||
      !record(def) || !['pokemon', 'energy', 'trainer'].includes(def.kind) || !record(def.mechanics))
    fail('invalid-deck-energy-context', 'Every inspected/target card must retain its actual holder and approved definition.');
  return def;
}
// ctx.boundPokemon: a thenMoved next part's bound Pokémon (「附着于进化后的宝可梦身上」), the only possible recipients.
function recipients(ctx, action, info) {
  return info.mons.filter((mon) => {
    const def = definition(ctx, mon.stack.at(-1), info.owner);
    if (def.kind !== 'pokemon') fail('invalid-deck-energy-context', 'A live recipient must really be a Pokémon.');
    const position = action.recipient.position;
    return (position !== 'self' || mon.id === ctx.source.pokemonId) && (!ctx.boundPokemon || ctx.boundPokemon.includes(mon.id)) &&
      (position !== 'active' || mon.id === info.own.active?.id) &&
      (position !== 'bench' || mon.id !== info.own.active?.id) &&
      matchesInPlaySelector(def, action.recipient.selector, ctx.effectivePokemon[mon.id].types);
  }).map((mon) => mon.id);
}

/**
 * Private IDs in original deck-array order (last is top). ready depends only on
 * a nonempty deck and public receivers, never on whether hidden matches exist.
 * A needsRuling result has empty lookedAt/candidates and null bounds: no peek.
 */
export function deckEnergyWindow(ctx, action) {
  assertDeckEnergyAction(action);
  const info = context(ctx), recipientIds = recipients(ctx, action, info);
  if (info.own.deck.length && !recipientIds.length) return {
    status: 'needsRuling', owner: info.owner, lookedAt: [], candidates: [], recipientIds, bounds: null,
  };
  const lookedAt = action.lookTop === null ? [...info.own.deck] : info.own.deck.slice(-action.lookTop);
  const candidates = lookedAt.filter((id) => matchesCardSelector(definition(ctx, id, info.owner), action.selector));
  // 「各附着1张」: one card per eligible Pokémon at most.
  const available = action.distribution === 'distinctRecipients' ? Math.min(candidates.length, recipientIds.length) : candidates.length;
  const bounds = selectionBounds({ ...action.quantity, available,
    zone: 'deck', filter: selectorQuantityClass(action.selector) });
  const types = action.distinctTypes ?
    Object.fromEntries(candidates.map((id) => [id, definition(ctx, id, info.owner).mechanics.baseUnits[0][0]])) : null;
  return { status: lookedAt.length ? 'ready' : 'emptyDeck', owner: info.owner, lookedAt, candidates, recipientIds, bounds,
    ...(types ? { types } : {}) };
}

function assertChosen(window, chosen) {
  const code = 'invalid-deck-energy-selection';
  assertJSON(chosen); ids(chosen, code);
  if (window.status === 'needsRuling')
    fail('needs-ruling', 'No legal receiver: CN evidence for inspecting/using this look-attach-shuffle instruction is still required.');
  if (!canSelectCount(window.bounds, chosen.length) || chosen.some((id) => !window.candidates.includes(id)))
    fail(code, 'Selected physical cards must match the original own-deck window, predicate and CN quantity bounds.');
  if (window.types && new Set(chosen.map((id) => window.types[id])).size !== chosen.length)
    fail(code, 'The printed instruction requires Basic Energy cards of mutually different types.');
}

/** All eligible own battle IDs; selected is an optional physical-card-ID array. */
export function deckEnergyRecipients(ctx, action, selected = []) {
  assertDeckEnergyAction(action);
  assertJSON(selected); ids(selected, 'invalid-deck-energy-selection');
  // An empty argument asks for public receiver candidates before selecting cards.
  // Do not inspect any hidden Energy definitions merely to query public targets.
  if (selected.length) assertChosen(deckEnergyWindow(ctx, action), selected);
  return recipients(ctx, action, context(ctx));
}

/**
 * Allowed targets for the next allocated card (chosen[assignments.length]).
 * With toHand, exactly min(toHand, chosen) cards go to DECK_ENERGY_HAND.
 */
export function deckEnergyDestinations(ctx, action, chosen, assignments) {
  const recipients = deckEnergyRecipients(ctx, action, chosen)
    .filter((id) => action.distribution !== 'distinctRecipients' || !assignments.some((a) => a.targetId === id));
  if (!action.toHand) return recipients;
  const slots = Math.min(action.toHand, chosen.length) - assignments.filter((a) => a.targetId === DECK_ENERGY_HAND).length;
  if (slots <= 0) return recipients;
  return chosen.length - assignments.length <= slots ? [DECK_ENERGY_HAND] : [...recipients, DECK_ENERGY_HAND];
}

/**
 * Atomic pre-commit plan. assignments = [{instanceId,targetId}].
 * separateRecipients means per-card allocation, NOT distinct targets; distinctRecipients means distinct targets.
 * Returned assignments are normalized to chosen order, not a claim about trigger
 * priority. The host owns real attachment/trigger timing and no-op finalization.
 */
export function validateDeckEnergyPlan(ctx, action, chosen, assignments) {
  const window = deckEnergyWindow(ctx, action);
  assertChosen(window, chosen); assertJSON(assignments);
  const code = 'invalid-deck-energy-assignment';
  if (!Array.isArray(assignments)) fail(code, 'Assignments must be an explicit physical-card allocation array.');
  const byCard = new Map();
  for (const assignment of assignments) {
    fields(assignment, ['instanceId', 'targetId'], code);
    if (!text(assignment.instanceId) || !text(assignment.targetId) || !chosen.includes(assignment.instanceId) ||
        !(window.recipientIds.includes(assignment.targetId) || action.toHand && assignment.targetId === DECK_ENERGY_HAND) ||
        byCard.has(assignment.instanceId))
      fail(code, 'Allocate each selected physical card once to a real eligible own Pokémon.');
    byCard.set(assignment.instanceId, assignment.targetId);
  }
  if (byCard.size !== chosen.length ||
      action.distribution === 'singleRecipient' && new Set(byCard.values()).size > 1 ||
      action.distribution === 'distinctRecipients' && new Set(byCard.values()).size !== byCard.size ||
      action.toHand && [...byCard.values()].filter((id) => id === DECK_ENERGY_HAND).length !== Math.min(action.toHand, chosen.length))
    fail(code, 'Every chosen card needs a recipient; singleRecipient cannot split across Pokémon, distinctRecipients cannot share one.');
  return {
    owner: window.owner, lookedAt: [...window.lookedAt], chosen: [...chosen],
    assignments: chosen.map((instanceId) => ({ instanceId, targetId: byCard.get(instanceId) })),
    remainder: window.lookedAt.filter((id) => !byCard.has(id)),
    shuffleDeck: action.remainder === 'shuffleDeck' && ctx.state.players[window.owner].deck.length > chosen.length,
  };
}

/** Recompute a saved PRE-COMMIT plan after JSON restoration; no trusted claims. */
export function assertDeckEnergyPlan(ctx, action, plan) {
  const code = 'invalid-deck-energy-plan';
  assertJSON(plan);
  fields(plan, ['owner', 'lookedAt', 'chosen', 'assignments', 'remainder', 'shuffleDeck'], code);
  ids(plan.lookedAt, code); ids(plan.remainder, code);
  const expected = validateDeckEnergyPlan(ctx, action, plan.chosen, plan.assignments);
  if (plan.owner !== expected.owner || plan.shuffleDeck !== expected.shuffleDeck ||
      JSON.stringify(plan.lookedAt) !== JSON.stringify(expected.lookedAt) ||
      JSON.stringify(plan.remainder) !== JSON.stringify(expected.remainder) ||
      plan.assignments.some((assignment, index) => assignment.instanceId !== expected.assignments[index].instanceId ||
        assignment.targetId !== expected.assignments[index].targetId))
    fail(code, 'The saved plan contradicts its actual owner, original inspected window, allocation or remaining-deck shuffle.');
  return plan;
}
