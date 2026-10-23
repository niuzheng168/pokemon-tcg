/**
 * CN/V20261019 II.A (PDF p19): conditions come from the actual reviewed card
 * binding, not an invented default. II.B-01..03 (p19–20) places printed damage
 * arithmetic in base damage; II.D-15..17 (p50–51) distinguishes effective HP
 * and effect-time Prize counts. This module interprets explicit conditions
 * only: it neither authenticates bindings nor projects facts from the board.
 */
import { assertBattleValue, evaluateBattleInteger, battleQueryKey, assertKindSelector, assertPokemonState } from './battle-value.js';

export const BATTLE_PREDICATE_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.A', pdfPages: Object.freeze([19]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.B-01..03', pdfPages: Object.freeze([19, 20]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.D-15..17', pdfPages: Object.freeze([50, 51]) }),
]);
const WHO = ['self', 'ownActive', 'opponentActive', 'target'];
// Host-answered board/history queries, read from facts.queries[battleQueryKey(node)] as booleans.
export const BATTLE_PREDICATE_QUERY_KINDS = Object.freeze(['pokemonIs', 'stadiumInPlay', 'historyFact', 'sharedType']);
// II.E-11 / II.E-23 / II.E-24 / II.E-25 / II.E-26 history facts of the effect user's turn; I.A-05 each player's first turn.
const HISTORY_FACTS = ['previousOpponentKnockout', 'movedToActive', 'supporterPlayed', 'healed', 'evolvedThisTurn',
  'firstOwnTurn', 'secondPlayerFirstTurn', 'previousOwnAttack'];
const RELATIONS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'];
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

export class BattlePredicateError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'BattlePredicateError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new BattlePredicateError(code, message); };
const invalid = (message) => fail('invalid-battle-predicate', message);

// Validate the entire description before dispatching, including skipped logic
// and Value.choose branches. Inspect descriptors, never accessors/toJSON.
// Shared subtrees are fine; only an ancestor back-edge is a cycle.
function json(root) {
  const work = [{ value: root }], ancestors = new Set();
  while (work.length) {
    const item = work.pop(), value = item.value;
    if (item.exit) { ancestors.delete(value); continue; }
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        typeof value === 'number' && Number.isSafeInteger(value)) continue;
    if (!value || typeof value !== 'object' || ancestors.has(value) ||
        (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value)))
      invalid('Predicates require acyclic plain JSON with safe integer values.');
    const array = Array.isArray(value), keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1)
      invalid('Predicate arrays must be dense plain arrays without extra fields.');
    ancestors.add(value); work.push({ value, exit: true });
    for (const key of keys) {
      if (array && key === 'length') continue;
      const p = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !p.enumerable || !Object.hasOwn(p, 'value') ||
          array && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key ||
            Number(key) < 0 || Number(key) >= value.length))
        invalid('Predicate fields must be enumerable own string data, without getters or hidden items.');
      work.push({ value: p.value });
    }
  }
}

function record(value, keys, optional = []) {
  if (!plain(value) || keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key)))
    invalid('Predicate records must contain exactly the fields declared by their kind.');
}

/** Full static validation, including every unexecuted branch; no fact reads. */
export function assertBattlePredicate(predicate) {
  json(predicate);
  const work = [predicate];
  while (work.length) {
    const node = work.pop();
    if (!plain(node)) invalid('A predicate must be an explicit record.');
    const kind = Object.getOwnPropertyDescriptor(node, 'kind');
    if (!kind) invalid('A predicate requires an own kind field.');
    switch (kind.value) {
      case 'compare':
        record(node, ['kind', 'left', 'relation', 'right']);
        if (!RELATIONS.includes(node.relation)) invalid('Unknown integer comparison relation.');
        assertBattleValue(node.left);
        assertBattleValue(node.right);
        break;
      case 'all':
      case 'any':
        record(node, ['kind', 'conditions']);
        if (!Array.isArray(node.conditions) || !node.conditions.length)
          invalid('Logical groups require a nonempty predicate array.');
        for (let i = node.conditions.length - 1; i >= 0; i--) work.push(node.conditions[i]);
        break;
      case 'not':
        record(node, ['kind', 'condition']);
        work.push(node.condition);
        break;
      case 'exists':
        record(node, ['kind', 'who']);
        if (!WHO.includes(node.who)) invalid('Existence requires an explicit normalized Pokémon holder.');
        break;
      case 'pokemonIs':
        record(node, ['kind', 'who'], ['selector', 'state', 'position']);
        if (!WHO.includes(node.who) || !['selector', 'state', 'position'].some((key) => Object.hasOwn(node, key)))
          invalid('A Pokémon trait test needs an explicit holder and a selector, state and/or position.');
        if (Object.hasOwn(node, 'position') && !['active', 'bench'].includes(node.position))
          invalid('A Pokémon position is the Active Spot or the Bench.');
        if (Object.hasOwn(node, 'selector')) assertKindSelector(node.selector, 'pokemon', fail, 'invalid-battle-predicate');
        if (Object.hasOwn(node, 'state')) assertPokemonState(node.state, fail, 'invalid-battle-predicate');
        break;
      case 'stadiumInPlay':
        record(node, ['kind', 'owner'], ['selector']);
        if (!['own', 'opponent', 'any'].includes(node.owner)) invalid('A Stadium test needs an own/opponent/any owner.');
        if (Object.hasOwn(node, 'selector')) assertKindSelector(node.selector, 'trainer', fail, 'invalid-battle-predicate');
        break;
      case 'historyFact':
        if (node.fact === 'previousOpponentKnockout') record(node, ['kind', 'fact', 'cause'], ['selector']);
        else if (node.fact === 'previousOwnAttack') {
          record(node, ['kind', 'fact', 'by'], ['selector', 'attackNames']);
          if (!['self', 'other', 'any'].includes(node.by) || Object.hasOwn(node, 'attackNames') && (!Array.isArray(node.attackNames) ||
              !node.attackNames.length || node.attackNames.some((n) => typeof n !== 'string' || !n) || new Set(node.attackNames).size !== node.attackNames.length))
            invalid('A previous-turn attack test needs who used it (self/other/any) and nonempty unique printed attack names.');
        } else record(node, ['kind', 'fact'], ['supporterPlayed', 'evolvedThisTurn'].includes(node.fact) ? ['selector'] : []);
        if (!HISTORY_FACTS.includes(node.fact) || Object.hasOwn(node, 'cause') && !['any', 'attackDamage'].includes(node.cause))
          invalid('A history test needs a known fact and, for a Knock Out, an any/attackDamage cause.');
        if (Object.hasOwn(node, 'selector'))
          assertKindSelector(node.selector, node.fact === 'supporterPlayed' ? 'trainer' : 'pokemon', fail, 'invalid-battle-predicate');
        break;
      case 'sharedType':
        record(node, ['kind', 'own', 'opponent']);
        if (![node.own, node.opponent].every((zone) => ['field', 'active'].includes(zone)))
          invalid('A shared-type test compares the field or the Active Spot of each side.');
        break;
      default:
        invalid('Unknown predicate kind.');
    }
  }
  return predicate;
}

// Only requested host-projected facts are read. Short-circuited predicates need
// no facts at all. Missing/inherited/getter facts are errors, not absent Pokémon.
function field(value, key) {
  if (!plain(value)) fail('invalid-battle-facts', 'Existence queries require plain fact records.');
  const p = Object.getOwnPropertyDescriptor(value, key);
  if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
    fail('invalid-battle-facts', 'A requested existence fact is missing, inherited, hidden or executable.');
  return p.value;
}

function evaluate(node, facts) {
  switch (node.kind) {
    case 'compare': {
      const left = evaluateBattleInteger(node.left, facts), right = evaluateBattleInteger(node.right, facts);
      if (node.relation === 'eq') return left === right;
      if (node.relation === 'neq') return left !== right;
      if (node.relation === 'lt') return left < right;
      if (node.relation === 'lte') return left <= right;
      if (node.relation === 'gt') return left > right;
      return left >= right; // The only remaining prevalidated relation is gte.
    }
    case 'all': return node.conditions.every((condition) => evaluate(condition, facts));
    case 'any': return node.conditions.some((condition) => evaluate(condition, facts));
    case 'not': return !evaluate(node.condition, facts);
    case 'exists': {
      const pokemon = field(field(facts, 'pokemon'), node.who);
      if (pokemon === null) return false;
      if (!plain(pokemon)) fail('invalid-battle-facts', 'A known Pokémon must be a plain stat record or explicit null.');
      return true;
    }
    default: { // The remaining prevalidated kinds are host-answered queries.
      const answer = field(field(facts, 'queries'), battleQueryKey(node));
      if (typeof answer !== 'boolean') fail('invalid-battle-facts', 'A query predicate needs an explicit boolean answer.');
      return answer;
    }
  }
}

/**
 * Boolean result, never truthiness or a default for unresolved values.
 * Value errors (including needs-ruling) propagate unchanged. Logical runtime
 * evaluation short-circuits in declared array order only AFTER full AST
 * validation. No mutation, RNG, executable strings, or module-init calls.
 */
export function evaluateBattlePredicate(predicate, facts) {
  assertBattlePredicate(predicate);
  return evaluate(predicate, facts);
}
