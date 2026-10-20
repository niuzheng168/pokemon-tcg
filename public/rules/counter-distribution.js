/**
 * CN II.C-07 p30 / II.A p19 / II.D-04 p43–44: distribute a FIXED total of
 * new counters, not N per Pokemon, damage points, transfer or any/upTo.
 * C07 FAQ / C17 p37–39: protected Pokemon remain eligible; their allocated
 * share is prevented, not reassigned. Host freezes protection BEFORE commit.
 *
 * This pure public-state plan never queries protection, hidden zones, HP,
 * attachments, history, KO or RNG; it does not emit healing/damage facts.
 * Names/HP/stage are printed; only type matching uses explicit effective types.
 * Host authenticates the original window/action/choice and its blocked mask.
 */
import { validateCardDefinition, validateCardSelector } from './schema-validators.js';
import { matchesInPlaySelector } from './in-play-selection.js';

export const COUNTER_DISTRIBUTION_RULE_IDS = Object.freeze(['damage.counter-distribution']);
export const COUNTER_DISTRIBUTION_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.C-07', pdfPages: Object.freeze([30]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.A', pdfPages: Object.freeze([19]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.C-17', pdfPages: Object.freeze([37, 38, 39]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.D-04', pdfPages: Object.freeze([43, 44]) }),
]);
const COUNTER_MAX = 900719925474099;
const TARGETS = ['any', 'active', 'bench', 'self', 'event', 'attacker'];
const CONTEXT = 'invalid-counter-distribution-context';
const SELECTION = 'invalid-counter-allocation';
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value) => typeof value === 'string' && value.length > 0;
const counter = (value) => Number.isSafeInteger(value) && value >= 0 && value <= COUNTER_MAX;

export class CounterDistributionError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'CounterDistributionError'; this.code = code; this.ruleId = 'damage.counter-distribution';
  }
}
const fail = (code, message) => { throw new CounterDistributionError(code, message); };

function array(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1)
    fail(code, 'Counter arrays must be ordinary dense JSON without extra fields.');
  for (let i = 0; i < value.length; i++) {
    const p = Object.getOwnPropertyDescriptor(value, String(i));
    if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Counter arrays cannot contain holes, hidden items or accessors.');
  }
  return value;
}

// Do not invoke accessors/toJSON or accept inherited defaults, even in skipped
// selectors. Shared subtrees are fine; ancestor cycles/executable JSON are not.
function data(value, code, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || ancestors.has(value))
    fail(code, 'Counter descriptions require finite, acyclic plain JSON.');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    const items = array(value, code);
    result = [];
    for (let i = 0; i < items.length; i++)
      result.push(data(Object.getOwnPropertyDescriptor(items, String(i)).value, code, ancestors));
  } else {
    result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      const p = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !p.enumerable || !Object.hasOwn(p, 'value'))
        fail(code, 'Counter JSON fields must be enumerable own string data.');
      result[key] = data(p.value, code, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}

function record(value, keys, code) {
  if (!plain(value) || keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key)))
    fail(code, 'Counter records require exactly their declared own fields.');
}
function ids(value, code) {
  const copy = data(value, code);
  if (!Array.isArray(copy) || copy.some((id) => !text(id)) || new Set(copy).size !== copy.length)
    fail(code, 'Use unique nonempty Pokemon/card IDs, not duplicated targets or counter units.');
  return copy;
}
function field(value, key, optional = false) {
  if (!plain(value)) fail(CONTEXT, 'Requested counter context records must be plain data.');
  const p = Object.getOwnPropertyDescriptor(value, key);
  if (!p && optional) return undefined;
  if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
    fail(CONTEXT, 'Requested counter fields cannot be missing, inherited, hidden or executable.');
  return p.value;
}

/** Exact fixed-total action; no implicit side, selector, dynamic/any or transfer. */
export function assertCounterDistributionAction(action) {
  const code = 'invalid-counter-distribution-action', a = data(action, code);
  record(a, ['op', 'side', 'target', 'selector', 'count'], code);
  if (a.op !== 'distributeCounters' || !['own', 'opponent'].includes(a.side) ||
      !TARGETS.includes(a.target) || !counter(a.count))
    fail(code, 'Distribution needs an explicit side/target and bounded nonnegative total of counters.');
  if (!plain(a.selector) || a.selector.kind !== 'pokemon' || !validateCardSelector(a.selector))
    fail(code, 'Use the existing Pokemon selector; live types are supplied independently.');
  return action;
}

function targetId(ctx, source, target) {
  if (target === 'self') {
    const id = field(source, 'pokemonId', true);
    if (id === undefined || id === null) return null;
    if (!text(id)) fail(CONTEXT, 'Self must reference an actual Pokemon ID or explicit absence.');
    return id;
  }
  const event = field(ctx, 'event', true);
  if (event === undefined || event === null) return null;
  const copy = data(event, CONTEXT);
  if (!plain(copy)) fail(CONTEXT, 'Event targets need a plain event or explicit absence.');
  let id;
  if (target === 'event') id = copy.subjectId;
  else {
    const cause = copy.cause;
    if (cause === undefined || cause === null) return null;
    if (!plain(cause)) fail(CONTEXT, 'An attacker query needs a plain cause/source.');
    const actor = cause.source;
    if (actor === undefined || actor === null) return null;
    if (!plain(actor)) fail(CONTEXT, 'An attacker source must be plain data.');
    id = actor.pokemonId;
  }
  if (id === undefined || id === null) return null;
  if (!text(id)) fail(CONTEXT, 'Event/attacker Pokemon IDs cannot be inferred or coerced.');
  return id;
}
function physical(cards, id, owner) {
  const card = field(cards, id);
  if (field(card, 'instanceId') !== id || field(card, 'owner') !== owner || !text(field(card, 'definitionId')))
    fail(CONTEXT, 'Public stacks must retain physical identity, original owner and definition.');
  return card;
}

/** Protected, healthy and over-HP targets are NOT removed from this window. */
export function counterDistributionWindow(ctx, action) {
  assertCounterDistributionAction(action);
  const source = field(ctx, 'source'), sourceOwner = field(source, 'owner');
  if (![0, 1].includes(sourceOwner)) fail(CONTEXT, 'Use the actual source owner, not the current player.');
  const owner = action.side === 'own' ? sourceOwner : 1 - sourceOwner;
  const state = field(ctx, 'state'), players = array(field(state, 'players'), CONTEXT);
  const cards = field(state, 'cards'), definitions = field(ctx, 'definitions'), effective = field(ctx, 'effectivePokemon');
  if (players.length !== 2 || !plain(cards) || !plain(definitions) || !plain(effective))
    fail(CONTEXT, 'Use two real players and explicit physical/printed/effective maps.');
  const player = players[owner], active = field(player, 'active'), bench = array(field(player, 'bench'), CONTEXT);
  const mons = active === null ? [...bench] : [active, ...bench];
  const wanted = ['self', 'event', 'attacker'].includes(action.target) ? targetId(ctx, source, action.target) : null;
  const identities = new Set(), stackIds = new Set(), targets = [];
  const selector = data(action.selector, 'invalid-counter-distribution-action');
  for (const mon of mons) {
    const pokemonId = field(mon, 'id'), counters = field(mon, 'counters'), stack = ids(field(mon, 'stack'), CONTEXT);
    if (!text(pokemonId) || identities.has(pokemonId) || !counter(counters) || !stack.length)
      fail(CONTEXT, 'Targets need unique live Pokemon IDs, actual stacks and bounded runtime counters.');
    identities.add(pokemonId);
    for (const id of stack) {
      if (stackIds.has(id)) fail(CONTEXT, 'One physical card cannot belong to two live Pokemon stacks.');
      stackIds.add(id); physical(cards, id, owner);
    }
    if (action.target === 'active' && mon !== active || action.target === 'bench' && mon === active ||
        ['self', 'event', 'attacker'].includes(action.target) && pokemonId !== wanted) continue;
    const topCardId = stack.at(-1), card = physical(cards, topCardId, owner), definitionId = field(card, 'definitionId');
    const definition = data(field(definitions, definitionId), CONTEXT);
    if (!validateCardDefinition(definition) || definition.kind !== 'pokemon' || definition.definitionId !== definitionId)
      fail(CONTEXT, 'Selectors require the actual top card’s normalized printed Pokemon definition.');
    const types = data(field(field(effective, pokemonId), 'types'), CONTEXT);
    if (matchesInPlaySelector(definition, selector, types)) targets.push({ pokemonId, topCardId, counters });
  }
  return { owner, targets };
}

/** Candidate availability ONLY, not a whole-card/composite/protection use gate. */
export function canUseCounterDistribution(ctx, action) {
  const window = counterDistributionWindow(ctx, action);
  return action.count > 0 && window.targets.length > 0;
}

function allocationData(value) {
  const copy = data(value, SELECTION);
  array(copy, SELECTION);
  const seen = new Set();
  for (const item of copy) {
    record(item, ['pokemonId', 'count'], SELECTION);
    if (!text(item.pokemonId) || seen.has(item.pokemonId) || !counter(item.count) || item.count === 0)
      fail(SELECTION, 'Each allocation needs one unique Pokemon ID and a positive bounded counter count.');
    seen.add(item.pokemonId);
  }
  return copy;
}

/** Choice validation BEFORE protection: no addition or hypothetical overflow. */
export function assertCounterDistributionAllocation(ctx, action, allocations) {
  const window = counterDistributionWindow(ctx, action), selected = allocationData(allocations);
  if (selected.some((item) => !window.targets.some((target) => target.pokemonId === item.pokemonId)))
    fail(SELECTION, 'Allocations must name only targets in the original public eligible window.');
  const sum = selected.reduce((total, item) => total + BigInt(item.count), 0n);
  if (sum !== BigInt(window.targets.length === 0 ? 0 : action.count))
    fail(SELECTION, 'With eligible targets, allocate the ENTIRE fixed total, including prevented shares.');
  return allocations;
}

/** Host-frozen blocked IDs must be a unique SUBSET of allocated targets. */
export function planCounterDistribution(ctx, action, allocations, blocked = []) {
  assertCounterDistributionAllocation(ctx, action, allocations);
  const window = counterDistributionWindow(ctx, action), selected = allocationData(allocations), denied = ids(blocked, SELECTION);
  if (denied.some((id) => !selected.some((item) => item.pokemonId === id)))
    fail(SELECTION, 'The host blocked subset must contain only allocated targets.');
  const byId = new Map(window.targets.map((target) => [target.pokemonId, target]));
  const updates = selected.map(({ pokemonId, count }) => {
    const beforeCounters = byId.get(pokemonId).counters, placedCounters = denied.includes(pokemonId) ? 0 : count;
    if (beforeCounters > COUNTER_MAX - placedCounters)
      fail('counter-distribution-overflow', 'All actual afterCounters must fit the counter bound before any commit.');
    return { pokemonId, beforeCounters, afterCounters: beforeCounters + placedCounters, placedCounters };
  });
  const selectedTotal = selected.reduce((total, item) => total + item.count, 0);
  const placedTotal = updates.reduce((total, update) => total + update.placedCounters, 0);
  return {
    owner: window.owner,
    allocations: selected.map(({ pokemonId, count }) => ({ pokemonId, count })),
    updates, selectedTotal, placedTotal, preventedTotal: selectedTotal - placedTotal,
    noTargets: window.targets.length === 0, performed: placedTotal > 0,
  };
}

/** Recompute against original counters/types/action and the authoritative mask. */
export function assertCounterDistributionPlan(ctx, action, plan, blocked = []) {
  const code = 'invalid-counter-distribution-plan', copy = data(plan, code);
  const totals = ['selectedTotal', 'placedTotal', 'preventedTotal'];
  record(copy, ['owner', 'allocations', 'updates', ...totals, 'noTargets', 'performed'], code);
  if (![0, 1].includes(copy.owner) || typeof copy.noTargets !== 'boolean' || typeof copy.performed !== 'boolean' ||
      totals.some((key) => !counter(copy[key])))
    fail(code, 'Plans need the actual owner, bounded explicit totals and Boolean result/reason.');
  allocationData(copy.allocations); array(copy.updates, code);
  const keys = ['pokemonId', 'beforeCounters', 'afterCounters', 'placedCounters'];
  for (const update of copy.updates) {
    record(update, keys, code);
    if (!text(update.pokemonId) || keys.slice(1).some((key) => !counter(update[key])))
      fail(code, 'Updates require a real Pokemon ID and bounded before/after/placed counters.');
  }
  const expected = planCounterDistribution(ctx, action, copy.allocations, blocked);
  if (copy.owner !== expected.owner || copy.noTargets !== expected.noTargets || copy.performed !== expected.performed ||
      totals.some((key) => copy[key] !== expected[key]) || copy.updates.length !== expected.updates.length ||
      copy.updates.some((update, i) => keys.some((key) => update[key] !== expected.updates[i][key])))
    fail(code, 'Saved counter results differ from the original selection, counters, total or host mask.');
  return plan;
}
