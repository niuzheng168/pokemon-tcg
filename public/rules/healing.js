/**
 * CN/V20261019 advanced II.C-06 p29: healing removes damage counters, capped
 * by counters actually present; "all HP" removes ALL counters, not a HP cache.
 * II.E-19 p62–63 / FAQ3 p63 distinguish actual healing results from the later
 * Energy-discard stage. C-17 p37–39 protection is a HOST-supplied blocked mask.
 *
 * This is a pure simultaneous PRE-COMMIT plan. It never moves cards, looks up
 * protection, records heal history/KO causes, discards Energy or samples RNG.
 * Host commits the whole counter snapshot, then recomputes protection/current
 * attachments for the actual healed IDs if discardHealedEnergy is true.
 * That flag is the explicit FAQ3 compound instruction, not a generic then/set.
 * Inputs are already admitted effect context/catalog values, NOT card approval.
 */
import { validateCardDefinition } from './schema-validators.js';
import { isKindSelector } from './card-selection.js';
import { matchesInPlaySelector } from './in-play-selection.js';
import { selectionBounds, canSelectCount } from './selection.js';

export const HEALING_RULE_IDS = Object.freeze(['effects.heal-results']);
export const HEALING_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.C-06', pdfPages: Object.freeze([29]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-19 FAQ3', pdfPages: Object.freeze([63]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-19', pdfPages: Object.freeze([62, 63]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.C-17', pdfPages: Object.freeze([37, 38, 39]) }),
]);
const COUNTER_MAX = 900719925474099;
const AMOUNT_MAX = 9007199254740990;
const TARGETS = ['any', 'active', 'bench', 'self', 'event', 'attacker'];
const CATEGORIES = ['attack', 'ability', 'trainer', 'energy', 'rule'];
const CONTEXT = 'invalid-healing-context';
const text = (value) => typeof value === 'string' && value.length > 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const counter = (value) => Number.isSafeInteger(value) && value >= 0 && value <= COUNTER_MAX;
const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

export class PokemonHealingError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'PokemonHealingError'; this.code = code; this.ruleId = 'effects.heal-results';
  }
}
const fail = (code, message) => { throw new PokemonHealingError(code, message); };

function array(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1)
    fail(code, 'Healing arrays must be ordinary dense JSON without extra fields.');
  for (let i = 0; i < value.length; i++) {
    const p = Object.getOwnPropertyDescriptor(value, String(i));
    if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Healing arrays cannot contain holes, hidden items or accessors.');
  }
  return value;
}

// Strict JSON descriptions; null-prototype internal copies prevent inherited
// defaults/getters in downstream schema/selector helpers. Reused subtrees are
// allowed, but ancestor cycles and executable/hidden properties are not.
function data(value, code, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || ancestors.has(value))
    fail(code, 'Healing descriptions require finite, acyclic plain JSON.');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) result = array(value, code).map((item) => data(item, code, ancestors));
  else {
    result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      const p = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !p.enumerable || !Object.hasOwn(p, 'value'))
        fail(code, 'Healing JSON fields must be enumerable own string data.');
      result[key] = data(p.value, code, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}

function record(value, keys, code) {
  if (!plain(value) || keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key)))
    fail(code, 'Healing records require exactly the fields declared by their shape.');
}
function ids(value, code) {
  const copy = data(value, code);
  if (!Array.isArray(copy) || copy.some((id) => !text(id)) || new Set(copy).size !== copy.length)
    fail(code, 'Healing uses unique nonempty Pokémon/card IDs, not duplicated targets or units.');
  return copy;
}
function field(value, key, optional = false) {
  if (!plain(value)) fail(CONTEXT, 'A requested healing context record must be plain data.');
  const p = Object.getOwnPropertyDescriptor(value, key);
  if (!p && optional) return undefined;
  if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
    fail(CONTEXT, 'A requested healing field is missing, inherited, hidden or executable.');
  return p.value;
}

/** Exact action; no implicit selector/count, runtime HP or Energy instructions. */
export function assertPokemonHealingAction(action) {
  const code = 'invalid-healing-action', a = data(action, code);
  record(a, ['op', 'side', 'target', 'selector', 'selection', 'amount', 'discardHealedEnergy'], code);
  if (a.op !== 'healPokemon' || !['own', 'opponent'].includes(a.side) || !TARGETS.includes(a.target) ||
      typeof a.discardHealedEnergy !== 'boolean' ||
      a.amount !== 'all' && (!Number.isSafeInteger(a.amount) || a.amount <= 0 || a.amount > AMOUNT_MAX || a.amount % 10 !== 0))
    fail(code, 'Healing needs explicit side/target/discard policy and positive safe ten-point HP or all.');
  if (!plain(a.selector) || !isKindSelector(a.selector, 'pokemon'))
    fail(code, 'Use the existing printed Pokémon selector, with live types supplied separately.');
  record(a.selection, plain(a.selection) && a.selection.kind === 'all' ? ['kind'] : ['kind', 'count'], code);
  if (!['exact', 'upTo', 'all'].includes(a.selection.kind) ||
      a.selection.kind !== 'all' && (!Number.isSafeInteger(a.selection.count) || a.selection.count <= 0))
    fail(code, 'Use existing exact/upTo positive safe counts or all, without optional defaults.');
  return action;
}

function targetId(ctx, source, target) {
  if (target === 'self') {
    const id = field(source, 'pokemonId', true);
    if (id === undefined || id === null) return null;
    if (!text(id)) fail(CONTEXT, 'A self target must retain its real Pokémon ID or explicit absence.');
    return id;
  }
  const event = field(ctx, 'event', true);
  if (event === undefined || event === null) return null;
  const copy = data(event, CONTEXT);
  if (!plain(copy)) fail(CONTEXT, 'An event target needs a plain event or explicit absence.');
  let id;
  if (target === 'event') id = copy.subjectId;
  else {
    const cause = copy.cause;
    if (cause === undefined || cause === null) return null;
    if (!plain(cause)) fail(CONTEXT, 'An attacker query needs a plain cause/source or explicit absence.');
    const actor = cause.source;
    if (actor === undefined || actor === null) return null;
    if (!plain(actor)) fail(CONTEXT, 'An attacker source must be a plain record or explicit absence.');
    id = actor.pokemonId;
  }
  if (id === undefined || id === null) return null;
  if (!text(id)) fail(CONTEXT, 'Event/attacker Pokémon IDs cannot be coerced or inferred.');
  return id;
}

function physical(cards, id, owner) {
  const card = field(cards, id);
  if (field(card, 'instanceId') !== id || field(card, 'owner') !== owner || !text(field(card, 'definitionId')))
    fail(CONTEXT, 'A public Pokémon stack must retain its physical identity, original owner and definition.');
  return card;
}

/** Public in-play targets only: no hand, deck, Prizes, RNG, HP cache or history. */
export function healingWindow(ctx, action) {
  assertPokemonHealingAction(action);
  const source = field(ctx, 'source'), sourceOwner = field(source, 'owner'), category = field(source, 'category');
  if (![0, 1].includes(sourceOwner) || !CATEGORIES.includes(category))
    fail(CONTEXT, 'Healing requires the actual source owner/category, not current-player defaults.');
  const owner = action.side === 'own' ? sourceOwner : 1 - sourceOwner;
  const state = field(ctx, 'state'), players = array(field(state, 'players'), CONTEXT);
  const cards = field(state, 'cards'), definitions = field(ctx, 'definitions'), effective = field(ctx, 'effectivePokemon');
  if (players.length !== 2 || !plain(cards) || !plain(definitions) || !plain(effective))
    fail(CONTEXT, 'Use two real players and explicit physical/printed/effective maps.');
  const player = players[owner], active = field(player, 'active'), bench = array(field(player, 'bench'), CONTEXT);
  const mons = active === null ? [...bench] : [active, ...bench];
  const wanted = ['self', 'event', 'attacker'].includes(action.target) ? targetId(ctx, source, action.target) : null;
  const identities = new Set(), stackIds = new Set(), targets = [];
  const selector = data(action.selector, 'invalid-healing-action');
  for (const mon of mons) {
    const pokemonId = field(mon, 'id'), counters = field(mon, 'counters');
    const stack = ids(field(mon, 'stack'), CONTEXT);
    if (!text(pokemonId) || identities.has(pokemonId) || !counter(counters) || !stack.length)
      fail(CONTEXT, 'Targets need unique live Pokémon IDs, an actual stack and bounded runtime counters.');
    identities.add(pokemonId);
    for (const id of stack) {
      if (stackIds.has(id)) fail(CONTEXT, 'A physical stack card cannot belong to two live Pokémon.');
      stackIds.add(id); physical(cards, id, owner);
    }
    if (action.target === 'active' && mon !== active || action.target === 'bench' && mon === active ||
        ['self', 'event', 'attacker'].includes(action.target) && pokemonId !== wanted) continue;
    const topCardId = stack.at(-1), card = physical(cards, topCardId, owner);
    const definitionId = field(card, 'definitionId'), definition = data(field(definitions, definitionId), CONTEXT);
    if (!validateCardDefinition(definition) || definition.kind !== 'pokemon' || definition.definitionId !== definitionId)
      fail(CONTEXT, 'Healing selectors require the actual top card’s normalized printed Pokémon definition.');
    const types = data(field(field(effective, pokemonId), 'types'), CONTEXT);
    if (matchesInPlaySelector(definition, selector, types)) targets.push({ pokemonId, topCardId, counters });
  }
  const boundsFor = (available) => selectionBounds({ ...action.selection, available, zone: 'public' });
  let bounds = boundsFor(targets.length), eligible = targets;
  if (category !== 'attack' && bounds.maximum === 1) {
    eligible = targets.filter((target) => target.counters > 0);
    bounds = boundsFor(eligible.length);
  }
  return { owner, targets: eligible, bounds };
}

/** Availability only; attacks may still execute other contents without healing. */
export function canUsePokemonHealing(ctx, action) {
  return healingWindow(ctx, action).targets.some((target) => target.counters > 0);
}

/** blocked is a unique SUBSET of selected, computed independently by the host. */
export function planPokemonHealing(ctx, action, chosen, blocked = []) {
  const window = healingWindow(ctx, action), selected = ids(chosen, 'invalid-healing-selection');
  const denied = ids(blocked, 'invalid-healing-selection');
  if (!canSelectCount(window.bounds, selected.length) ||
      selected.some((id) => !window.targets.some((target) => target.pokemonId === id)) ||
      denied.some((id) => !selected.includes(id)))
    fail('invalid-healing-selection', 'Selected targets and blocked subset must match the original eligible window/bounds.');
  const byId = new Map(window.targets.map((target) => [target.pokemonId, target]));
  if (field(field(ctx, 'source'), 'category') !== 'attack' && selected.length &&
      window.targets.some((target) => target.counters > 0) && !selected.some((id) => byId.get(id).counters > 0))
    fail('invalid-healing-selection', 'A non-attack healing selection must include a damaged eligible Pokémon when one exists.');
  const updates = selected.map((pokemonId) => {
    const beforeCounters = byId.get(pokemonId).counters;
    const removedCounters = denied.includes(pokemonId) ? 0 :
      action.amount === 'all' ? beforeCounters : Math.min(beforeCounters, action.amount / 10);
    return { pokemonId, beforeCounters, afterCounters: beforeCounters - removedCounters, removedCounters };
  });
  const healed = updates.filter((update) => update.removedCounters > 0).map((update) => update.pokemonId);
  return { owner: window.owner, selected, updates, healed, performed: healed.length > 0 };
}

/** Recompute against authoritative PRE-COMMIT counters/types and host mask. */
export function assertPokemonHealingPlan(ctx, action, plan, blocked = []) {
  const code = 'invalid-healing-plan', copy = data(plan, code);
  record(copy, ['owner', 'selected', 'updates', 'healed', 'performed'], code);
  if (![0, 1].includes(copy.owner) || typeof copy.performed !== 'boolean')
    fail(code, 'Healing plans require the actual target owner and explicit performed Boolean.');
  ids(copy.selected, code); ids(copy.healed, code); array(copy.updates, code);
  const keys = ['pokemonId', 'beforeCounters', 'afterCounters', 'removedCounters'];
  for (const update of copy.updates) {
    record(update, keys, code);
    if (!text(update.pokemonId) || !counter(update.beforeCounters) || !counter(update.afterCounters) || !counter(update.removedCounters))
      fail(code, 'Healing updates require a real Pokémon ID and bounded counter values.');
  }
  const expected = planPokemonHealing(ctx, action, copy.selected, blocked);
  if (copy.owner !== expected.owner || copy.performed !== expected.performed ||
      !same(copy.healed, expected.healed) || copy.updates.length !== expected.updates.length ||
      copy.updates.some((update, i) => keys.some((key) => update[key] !== expected.updates[i][key])))
    fail(code, 'Saved healing results differ from actual selections, counters, amount or host protection mask.');
  return plan;
}
