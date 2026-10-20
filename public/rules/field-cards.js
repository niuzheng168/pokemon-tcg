/**
 * CN I.B-04 p12–13 / II.C-01 p25–26 / II.D-04 p43–44 /
 * II.E-29 p68–69: a Stadium is its own physical field-card subject.
 * It has no Pokemon HP/types/counters/Bench position or timed ledger here.
 *
 * Pure candidate/plan/matching only. Host computes other protection, whole-use
 * permission and commits any move. CN.E29 use permission is NOT performed.
 * Physical owner and an incoming shared Stadium's actual user are distinct.
 */
import { validateCardDefinition, validateCardSelector } from './schema-validators.js';
import { matchesCardSelector } from './card-selection.js';
import { discardDestination } from './discard-policy.js';

export const FIELD_CARD_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'I.B-04', pdfPages: Object.freeze([12, 13]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.C-01', pdfPages: Object.freeze([25, 26]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.D-04', pdfPages: Object.freeze([43, 44]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-29', pdfPages: Object.freeze([68, 69]) }),
]);
const SOURCE_CATEGORIES = ['attack', 'ability', 'trainer', 'energy'];
const TRAINER_CATEGORIES = ['item', 'supporter', 'tool', 'stadium'];
const ORIGINS = ['hand', 'field', 'draw', 'prizes'];
const CONTEXT = 'invalid-field-card-context';
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value) => typeof value === 'string' && value.length > 0;
const owner = (value) => value === 0 || value === 1;

export class FieldCardError extends TypeError {
  constructor(code, message) {
    super(message); this.name = 'FieldCardError'; this.code = code;
  }
}
const fail = (code, message) => { throw new FieldCardError(code, message); };

function array(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1)
    fail(code, 'Field-card arrays must be ordinary dense JSON without extra fields.');
  for (let i = 0; i < value.length; i++) {
    const p = Object.getOwnPropertyDescriptor(value, String(i));
    if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Field-card arrays cannot contain holes, hidden items or accessors.');
  }
  return value;
}
function data(value, code, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || ancestors.has(value))
    fail(code, 'Field-card descriptions require finite, acyclic plain JSON.');
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
        fail(code, 'Field-card JSON fields must be enumerable own string data.');
      result[key] = data(p.value, code, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}
function record(value, required, optional, code) {
  if (!plain(value) || required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    fail(code, 'Field-card records require only their declared own fields.');
}
function choices(value, allowed, code) {
  array(value, code);
  if (!value.length || value.some((entry) => !allowed.includes(entry)) || new Set(value).size !== value.length)
    fail(code, 'Field-card filters need nonempty unique values from their declared domain.');
}
function field(value, key) {
  if (!plain(value)) fail(CONTEXT, 'A requested field-card context record must be plain data.');
  const p = Object.getOwnPropertyDescriptor(value, key);
  if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
    fail(CONTEXT, 'Requested field-card values cannot be missing, inherited, hidden or executable.');
  return p.value;
}

export function assertDiscardStadiumAction(action) {
  const code = 'invalid-discard-stadium', a = data(action, code);
  record(a, ['op', 'side', 'selector'], [], code);
  if (a.op !== 'discardStadium' || !['either', 'own', 'opponent'].includes(a.side))
    fail(code, 'Use an explicit discardStadium action and owner-relative side.');
  if (!plain(a.selector) || a.selector.kind !== 'trainer' || !validateCardSelector(a.selector) ||
      !Array.isArray(a.selector.categories) || a.selector.categories.length !== 1 || a.selector.categories[0] !== 'stadium')
    fail(code, 'Use the existing printed Trainer selector with categories exactly [stadium].');
  return action;
}

export function assertStadiumProtection(effect) {
  const code = 'invalid-stadium-protection', e = data(effect, code);
  record(e, ['op', 'scope', 'channel', 'useRule', 'from', 'categories'], ['trainerOrigins', 'trainerCategories'], code);
  if (e.op !== 'stadiumProtection' || e.scope !== 'self' || e.channel !== 'effects' ||
      !['ordinary', 'CN.E29'].includes(e.useRule) || !['own', 'opponent', 'all'].includes(e.from))
    fail(code, 'Stadium protection is self/effects only, with explicit ordinary or CN.E29 use policy.');
  choices(e.categories, SOURCE_CATEGORIES, code);
  for (const [key, allowed] of [['trainerOrigins', ORIGINS], ['trainerCategories', TRAINER_CATEGORIES]]) {
    if (!Object.hasOwn(e, key)) continue;
    choices(e[key], allowed, code);
    if (!e.categories.includes('trainer')) fail(code, 'Trainer filters require a Trainer source category.');
  }
  if (e.useRule === 'CN.E29' && (e.categories.length !== 1 || e.categories[0] !== 'trainer' ||
      !Object.hasOwn(e, 'trainerOrigins') || e.trainerOrigins.length !== 1 || e.trainerOrigins[0] !== 'hand' ||
      !Object.hasOwn(e, 'trainerCategories') || e.trainerCategories.some((category) => !['item', 'supporter'].includes(category))))
    fail(code, 'CN.E29 is explicitly Trainer-only, hand-only and Item/Supporter-only.');
  return effect;
}

function physical(cards, instanceId) {
  const card = field(cards, instanceId);
  if (field(card, 'instanceId') !== instanceId || !owner(field(card, 'owner')) || !text(field(card, 'definitionId')))
    fail(CONTEXT, 'A field card must retain its actual physical ID, original owner and definition.');
  return card;
}
function definition(ctx, card) {
  const id = field(card, 'definitionId'), value = data(field(field(ctx, 'definitions'), id), CONTEXT);
  if (!validateCardDefinition(value) || value.definitionId !== id)
    fail(CONTEXT, 'Field cards require their actual normalized printed definition.');
  return value;
}
function stadium(ctx) {
  const state = field(ctx, 'state'), id = field(state, 'stadium');
  if (id === null) return null;
  if (!text(id)) fail(CONTEXT, 'The shared Stadium is an actual physical ID or explicit null.');
  const card = physical(field(state, 'cards'), id), printed = definition(ctx, card);
  if (printed.kind !== 'trainer' || printed.mechanics.category !== 'stadium')
    fail(CONTEXT, 'The current shared Stadium cannot be a Pokemon, Energy, Tool, Item or Supporter.');
  return {
    target: { kind: 'stadium', instanceId: id, owner: field(card, 'owner'), definitionId: printed.definitionId },
    definition: printed,
  };
}

export function stadiumWindow(ctx, action) {
  assertDiscardStadiumAction(action);
  const sourceOwner = field(field(ctx, 'source'), 'owner');
  if (!owner(sourceOwner)) fail(CONTEXT, 'Use the actual effect user, not current-player or provider-owner defaults.');
  const current = stadium(ctx);
  if (!current || action.side === 'own' && current.target.owner !== sourceOwner ||
      action.side === 'opponent' && current.target.owner === sourceOwner ||
      !matchesCardSelector(current.definition, data(action.selector, 'invalid-discard-stadium')))
    return { target: null };
  return { target: current.target };
}

/** Candidate only: no protection or whole-card/compound use permission query. */
export function canUseDiscardStadium(ctx, action) {
  return stadiumWindow(ctx, action).target !== null;
}

export function planDiscardStadium(ctx, action, blocked = false) {
  if (typeof blocked !== 'boolean') fail('invalid-stadium-plan', 'The independent host blocked flag must be Boolean.');
  const { target } = stadiumWindow(ctx, action);
  if (target === null || blocked) return { target, destination: null, performed: false };
  const printed = definition(ctx, physical(field(field(ctx, 'state'), 'cards'), target.instanceId));
  return { target, destination: discardDestination(printed), performed: true };
}

/** Actual provider/target only. useRule classifies use permission, not this match. */
export function matchesStadiumProtection(ctx, effect, incomingSource) {
  assertStadiumProtection(effect);
  const current = stadium(ctx), provider = field(ctx, 'source');
  if (!current || field(provider, 'instanceId') !== current.target.instanceId ||
      field(provider, 'owner') !== current.target.owner || field(provider, 'category') !== 'trainer' ||
      field(provider, 'origin') !== 'field')
    fail('invalid-stadium-provider', 'Stadium self protection must come from this actual owner-held field Stadium.');
  const user = field(incomingSource, 'owner'), category = field(incomingSource, 'category');
  if (!owner(user) || ![...SOURCE_CATEGORIES, 'rule'].includes(category))
    fail(CONTEXT, 'Incoming protection matching needs an actual effect user and source category.');
  if (!effect.categories.includes(category) || effect.from === 'own' && current.target.owner !== user ||
      effect.from === 'opponent' && current.target.owner === user) return false;
  if (category !== 'trainer') return true;
  // An incoming shared Stadium can belong to the OTHER player: owner here is
  // the actual effect user, while state.cards retains the physical card owner.
  const id = field(incomingSource, 'instanceId');
  if (!text(id)) fail(CONTEXT, 'Incoming Trainer effects need their actual physical card.');
  const printed = definition(ctx, physical(field(field(ctx, 'state'), 'cards'), id));
  if (printed.kind !== 'trainer') fail(CONTEXT, 'A Trainer source cannot spoof a Pokemon or Energy definition.');
  if (effect.trainerCategories && !effect.trainerCategories.includes(printed.mechanics.category)) return false;
  if (effect.trainerOrigins) {
    const origin = field(incomingSource, 'origin');
    if (!ORIGINS.includes(origin)) fail(CONTEXT, 'Trainer-origin filters require the explicit actual origin.');
    if (!effect.trainerOrigins.includes(origin)) return false;
  }
  return true;
}
