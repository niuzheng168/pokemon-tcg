/**
 * CN/V20261019 advanced rules II.B-01..03, PDF p19–20: printed + / × / −
 * arithmetic belongs to base attack damage, not a later damage modifier.
 * II.D-15..17, PDF p50–51: effective maximum/remaining HP and effect-time Prize
 * counts. The host derives these facts; this module never edits printed cards,
 * computes source availability, moves cards, or decides KO/Prize awards.
 * B-01/B-02's coin arithmetic reads only counts projected for this exact attack
 * execution. The host prepares/authenticates rolls and namespaces copied
 * executions; this reader never rolls, consumes RNG or borrows another scope.
 * II.B-02 / II.D-02 文例1 (p20, p42): effectCards reads how many cards an
 * earlier counted effect of this same execution actually moved.
 */
import { assertBattlePredicate, evaluateBattlePredicate } from './battle-predicate.js';
import { validateCardSelector } from './schema-validators.js';
import { isKindSelector } from './card-selection.js';
import { ENERGY_TYPES } from './damage.js';

export const BATTLE_VALUE_RULE_IDS = Object.freeze(['damage.expression', 'damage.coins']);
export const BATTLE_VALUE_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.B-01..03', pdfPages: Object.freeze([19, 20]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.D-15..17', pdfPages: Object.freeze([50, 51]) }),
]);
const WHO = ['self', 'ownActive', 'opponentActive', 'target'];
const FIELDS = ['damageCounters', 'maximumHp', 'remainingHp', 'retreatEnergy', 'energyCards', 'energyUnits', 'specialConditions'];
const COUNTS = ['damageCounters', 'retreatEnergy', 'energyCards', 'energyUnits', 'specialConditions'];
const COIN_FIELDS = ['heads', 'tails', 'flips'];
// Board and zone queries (II.A; II.B-01..03): the host answers each exact
// query node once per fact projection, under facts.queries[battleQueryKey(node)].
export const BATTLE_VALUE_QUERY_KINDS = Object.freeze(['pokemonCount', 'pokemonSum', 'zoneCount', 'movedCards', 'extraEnergy', 'previousOpponentTurn']);
const SIDES = ['own', 'opponent', 'both'];
const SET_ZONES = ['field', 'bench'];
const SUM_FIELDS = ['damageCounters', 'energyCards', 'energyUnits', 'tools'];
const CARD_ZONES = ['hand', 'deck', 'discard', 'lostZone', 'prizes'];
const CONDITIONS = ['asleep', 'paralyzed', 'confused', 'poisoned', 'burned'];
// The final negative lookahead makes the ASCII match absolute: JavaScript's
// bare $ also matches before a trailing line terminator.
const COIN_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$(?![\s\S])/u;
const MAX_SAFE = 9007199254740991n;
const MIN_SAFE = -9007199254740991n;

export class BattleValueError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'BattleValueError';
    this.code = code;
    this.ruleId = 'damage.expression';
    this.needsRuling = code === 'needs-ruling';
  }
}
const fail = (code, message) => { throw new BattleValueError(code, message); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Scan the ENTIRE static description, including unchosen branches/predicates,
// before reading a kind/value. Descriptors, never getters. Reused subtrees are
// valid JSON data; only a back-edge on the current path is a cycle.
function json(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)))
    fail('invalid-battle-value', 'Battle expressions must contain only plain JSON data.');
  if (ancestors.has(value)) fail('invalid-battle-value', 'Cyclic battle expressions are not JSON.');
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1)
      fail('invalid-battle-value', 'Battle expression arrays must be dense plain arrays without extra properties.');
    for (let i = 0; i < value.length; i++) {
      const p = Object.getOwnPropertyDescriptor(value, String(i));
      if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
        fail('invalid-battle-value', 'Battle expression arrays cannot have holes, hidden items or accessors.');
      json(p.value, ancestors);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      const p = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !p.enumerable || !Object.hasOwn(p, 'value'))
        fail('invalid-battle-value', 'Battle expression fields must be enumerable own string data.');
      json(p.value, ancestors);
    }
  }
  ancestors.delete(value);
}

function record(value, keys, optional = []) {
  if (Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key)) ||
      keys.some((key) => !Object.hasOwn(value, key)))
    fail('invalid-battle-value', 'Battle expression fields must match their explicit kind exactly.');
}

/** Canonical identity of one query node: sorted-key JSON of the validated node. */
export function battleQueryKey(node) {
  return JSON.stringify((function sort(v) {
    return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ?
      Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  })(node));
}
const uniqueList = (value, allowed) => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length &&
  value.every((v) => allowed.includes(v));
/** A selector of one card kind (or alternatives all of that kind, never any), as the shared CardSelector schema defines it. */
export function assertKindSelector(selector, kind, failWith = fail, code = 'invalid-battle-value') {
  if (!plain(selector) || !isKindSelector(selector, kind))
    failWith(code, `A ${kind} selector must be one reviewed ${kind} CardSelector.`);
}
/** Current in-play state filter: damaged (or undamaged), carrying a Tool, with an Ability in effect, affected by any listed Special Condition. */
export function assertPokemonState(state, failWith = fail, code = 'invalid-battle-value') {
  if (!plain(state) || !Object.keys(state).length ||
      Object.keys(state).some((k) => !['damaged', 'undamaged', 'hasTool', 'hasAbility', 'conditions', 'energy'].includes(k)) ||
      ['damaged', 'undamaged', 'hasTool', 'hasAbility'].some((k) => Object.hasOwn(state, k) && state[k] !== true) ||
      state.damaged && state.undamaged ||
      Object.hasOwn(state, 'conditions') && !uniqueList(state.conditions, CONDITIONS))
    failWith(code, 'A Pokémon state filter needs damaged/undamaged/hasTool/hasAbility true, a unique Special Condition list or an Energy filter.');
  if (Object.hasOwn(state, 'energy')) energyFilter(state.energy, failWith, code);
}
function pokemonSet(expr) {
  if (!SIDES.includes(expr.side) || !SET_ZONES.includes(expr.zone) ||
      Object.hasOwn(expr, 'excludeSelf') && expr.excludeSelf !== true)
    fail('invalid-battle-value', 'In-play queries need a side, a field/bench zone and only excludeSelf:true.');
  if (Object.hasOwn(expr, 'selector')) assertKindSelector(expr.selector, 'pokemon');
  if (Object.hasOwn(expr, 'state')) assertPokemonState(expr.state);
}
function energyFilter(filter, failWith = fail, code = 'invalid-battle-value') {
  if (!plain(filter) || !Object.keys(filter).length || Object.keys(filter).some((k) => !['selector', 'providedTypes'].includes(k)) ||
      Object.hasOwn(filter, 'providedTypes') && !uniqueList(filter.providedTypes, ENERGY_TYPES))
    failWith(code, 'An Energy filter needs an Energy selector and/or unique provided types.');
  if (Object.hasOwn(filter, 'selector')) assertKindSelector(filter.selector, 'energy', failWith, code);
}

function valueShape(expr) {
  if (!plain(expr)) fail('invalid-battle-value', 'A battle value must be an expression record.');
  switch (Object.getOwnPropertyDescriptor(expr, 'kind')?.value) {
    case 'literal':
      record(expr, ['kind', 'value']);
      if (!Number.isSafeInteger(expr.value))
        fail('invalid-battle-value', 'Literal values must be signed safe integers.');
      break;
    case 'add':
      record(expr, ['kind', 'terms']);
      if (!Array.isArray(expr.terms) || expr.terms.length === 0)
        fail('invalid-battle-value', 'Addition requires a nonempty expression array.');
      expr.terms.forEach(valueShape);
      break;
    case 'subtract':
    case 'multiply':
      record(expr, ['kind', 'left', 'right']);
      valueShape(expr.left);
      valueShape(expr.right);
      break;
    case 'pokemon':
      record(expr, ['kind', 'who', 'field']);
      if (!WHO.includes(expr.who) || !FIELDS.includes(expr.field))
        fail('invalid-battle-value', 'Pokémon queries need an explicit holder and normalized stat field.');
      break;
    case 'prizes':
      record(expr, ['kind', 'side']);
      if (!['own', 'opponent'].includes(expr.side))
        fail('invalid-battle-value', 'Prize queries need an explicit own/opponent side.');
      break;
    case 'coin':
      record(expr, ['kind', 'key', 'field']);
      if (typeof expr.key !== 'string' || expr.key.length > 200 || !COIN_KEY.test(expr.key) ||
          !COIN_FIELDS.includes(expr.field))
        fail('invalid-battle-value', 'Coin queries need an ASCII SourceId key and explicit heads/tails/flips field.');
      break;
    case 'effectCards':
      record(expr, ['kind', 'effectId']);
      if (typeof expr.effectId !== 'string' || expr.effectId.length > 200 || !COIN_KEY.test(expr.effectId))
        fail('invalid-battle-value', 'Effect-count queries need an ASCII effect identity.');
      break;
    case 'choose':
      record(expr, ['kind', 'condition', 'ifTrue', 'ifFalse']);
      assertBattlePredicate(expr.condition);
      valueShape(expr.ifTrue);
      valueShape(expr.ifFalse);
      break;
    case 'pokemonCount':
      record(expr, ['kind', 'side', 'zone'], ['selector', 'state', 'excludeSelf']);
      pokemonSet(expr);
      break;
    case 'pokemonSum':
      if (Object.hasOwn(expr, 'who')) {
        record(expr, ['kind', 'who', 'field'], ['energy', 'tool']);
        if (!WHO.includes(expr.who)) fail('invalid-battle-value', 'A one-Pokémon sum needs an explicit holder.');
      } else {
        record(expr, ['kind', 'side', 'zone', 'field'], ['selector', 'state', 'excludeSelf', 'energy', 'tool']);
        pokemonSet(expr);
      }
      if (!SUM_FIELDS.includes(expr.field) || Object.hasOwn(expr, 'energy') && !expr.field.startsWith('energy') ||
          Object.hasOwn(expr, 'tool') && expr.field !== 'tools')
        fail('invalid-battle-value', 'Sums read counters, Energy cards/units or Tools; only Energy reads take an Energy filter, only Tool reads a Tool filter.');
      if (Object.hasOwn(expr, 'energy')) energyFilter(expr.energy);
      if (Object.hasOwn(expr, 'tool')) assertKindSelector(expr.tool, 'trainer');
      break;
    case 'zoneCount':
      record(expr, ['kind', 'side', 'zone'], ['selector']);
      if (!['own', 'opponent'].includes(expr.side) || !CARD_ZONES.includes(expr.zone))
        fail('invalid-battle-value', 'Zone counts need an own/opponent side and a hand/deck/discard/lostZone/prizes zone.');
      // Only public zones and hands can be filtered by card identity; the game load
      // guard admits the opponent's hand only after a printed look at it.
      if (Object.hasOwn(expr, 'selector') && (!['discard', 'lostZone', 'hand'].includes(expr.zone) || !validateCardSelector(expr.selector)))
        fail('invalid-battle-value', 'Only discard, Lost Zone and hands take a reviewed card selector.');
      break;
    case 'movedCards':
      record(expr, ['kind', 'effectId', 'selector']);
      if (typeof expr.effectId !== 'string' || expr.effectId.length > 200 || !COIN_KEY.test(expr.effectId) || !validateCardSelector(expr.selector))
        fail('invalid-battle-value', 'Moved-card queries need an ASCII effect identity and a reviewed card selector.');
      break;
    case 'previousOpponentTurn':
      record(expr, ['kind', 'fact'], ['activeOnly']);
      if (!['damageTaken', 'prizesTaken'].includes(expr.fact) || Object.hasOwn(expr, 'activeOnly') && (expr.activeOnly !== true || expr.fact !== 'damageTaken'))
        fail('invalid-battle-value', 'A previous-opponent-turn read is the damage this Pokémon took (optionally only while Active) or the Prizes the opponent took.');
      break;
    case 'extraEnergy':
      // 「追加附有【超】能量和【恶】能量各1个」: energyTypes asks for one extra unit of each listed type at the same time.
      record(expr, ['kind', Object.hasOwn(expr, 'energyTypes') ? 'energyTypes' : 'energyType']);
      if (Object.hasOwn(expr, 'energyTypes') ? !Array.isArray(expr.energyTypes) || expr.energyTypes.length < 2 || expr.energyTypes.length > 4 ||
          new Set(expr.energyTypes).size !== expr.energyTypes.length || expr.energyTypes.some((t) => !ENERGY_TYPES.includes(t))
        : expr.energyType !== null && !ENERGY_TYPES.includes(expr.energyType))
        fail('invalid-battle-value', 'Extra Energy reads one Energy type, null for any Energy, or 2–4 distinct types each at once.');
      break;
    default:
      fail('invalid-battle-value', 'Unknown battle value kind.');
  }
}

/** Validate all syntax, but never inspect runtime facts or invoke predicates. */
export function assertBattleValue(expr) {
  json(expr);
  valueShape(expr);
  return expr;
}

// Facts are a trusted host projection, NOT an AST to traverse. Read only this
// requested own field. Do not scan unrelated holders, hidden cards, getters,
// private histories, unresolved Prizes or unchosen branches.
function field(record, key) {
  if (!plain(record)) fail('invalid-battle-facts', 'Battle queries require an explicit plain fact record.');
  const p = Object.getOwnPropertyDescriptor(record, key);
  if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
    fail('invalid-battle-facts', 'A requested fact is missing, inherited, hidden or executable.');
  return p.value;
}

function factInteger(value, nonnegative) {
  if (!Number.isSafeInteger(value) || (nonnegative && value < 0))
    fail('invalid-battle-facts', 'Requested battle facts must be safe integers in their explicit units.');
  return BigInt(value);
}

function integer(expr, facts) {
  switch (expr.kind) {
    case 'literal': return BigInt(expr.value);
    case 'add': return expr.terms.reduce((sum, term) => sum + integer(term, facts), 0n);
    case 'subtract': return integer(expr.left, facts) - integer(expr.right, facts);
    case 'multiply': return integer(expr.left, facts) * integer(expr.right, facts);
    case 'pokemon': {
      const stat = field(field(field(facts, 'pokemon'), expr.who), expr.field);
      // HP is signed (including pending KO boundaries). Counts are nonnegative.
      // No HP/counter/ten-point conversion or Energy-card/unit inference occurs.
      return factInteger(stat, COUNTS.includes(expr.field));
    }
    case 'prizes': {
      const result = field(field(facts, 'prizes'), expr.side);
      const status = field(result, 'status');
      if (status === 'needsRuling')
        fail('needs-ruling', 'Unresolved CN effect-time Prize counts cannot become a number.');
      if (status !== 'resolved') fail('invalid-battle-facts', 'Unknown Prize-count result status.');
      return factInteger(field(result, 'count'), true);
    }
    case 'coin': {
      const counts = field(field(facts, 'coins'), expr.key);
      if (!plain(counts) || Reflect.ownKeys(counts).length !== COIN_FIELDS.length)
        fail('invalid-battle-facts', 'Coin counts require exactly heads, tails and flips as own data.');
      const heads = factInteger(field(counts, 'heads'), true);
      const tails = factInteger(field(counts, 'tails'), true);
      const flips = factInteger(field(counts, 'flips'), true);
      if (heads + tails !== flips)
        fail('invalid-battle-facts', 'Coin heads plus tails must equal flips exactly.');
      return expr.field === 'heads' ? heads : expr.field === 'tails' ? tails : flips;
    }
    case 'effectCards':
      return factInteger(field(field(facts, 'effectCards'), expr.effectId), true);
    case 'choose':
      return integer(evaluateBattlePredicate(expr.condition, facts) ? expr.ifTrue : expr.ifFalse, facts);
    default: // The remaining prevalidated kinds are host-answered board/zone queries.
      return factInteger(field(field(facts, 'queries'), battleQueryKey(expr)), true);
  }
}

/** Exact signed intermediate arithmetic, without clamping or safe-Number loss. */
export function evaluateBattleInteger(expr, facts) {
  assertBattleValue(expr);
  return integer(expr, facts);
}

function safeNumber(value) {
  if (value < MIN_SAFE || value > MAX_SAFE)
    fail('numeric-overflow', 'The final battle value must fit a signed safe Number.');
  return Number(value);
}

export function evaluateBattleValue(expr, facts) {
  return safeNumber(evaluateBattleInteger(expr, facts));
}

/**
 * Only the FINAL base-damage expression is clamped to zero; intermediate
 * negative/large values remain exact. The host then applies the existing damage
 * pipeline, including B-02/B-03's zero-base stop before attacker modifiers.
 * Legacy numeric damage must ALREADY be nonnegative, safe and a multiple of ten.
 */
export function evaluateDamageValue(exprOrNumeric, facts) {
  let value;
  if (typeof exprOrNumeric === 'number') {
    if (!Number.isSafeInteger(exprOrNumeric) || exprOrNumeric < 0 || exprOrNumeric % 10 !== 0)
      fail('invalid-damage-value', 'Numeric base damage must be nonnegative safe ten-point units.');
    value = BigInt(exprOrNumeric);
  } else {
    value = evaluateBattleInteger(exprOrNumeric, facts);
  }
  if (value < 0n) value = 0n;
  const result = safeNumber(value);
  if (value % 10n !== 0n) fail('invalid-damage-value', 'Final base damage must be a multiple of ten.');
  return result;
}
