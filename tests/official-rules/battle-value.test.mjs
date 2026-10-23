// Synthetic arithmetic/facts only. Nothing here approves a real card or printing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerSharedSchemas } from './schema-set.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  BattleValueError, BATTLE_VALUE_RULE_IDS, BATTLE_VALUE_SOURCES,
  assertBattleValue, evaluateBattleInteger, evaluateBattleValue, evaluateDamageValue,
} from '../../public/rules/battle-value.js';
import { queryPrizesTaken } from '../../public/rules/prize-count.js';

const MAX = Number.MAX_SAFE_INTEGER;
const MAX_BIG = 9007199254740991n;
const WHO = ['self', 'ownActive', 'opponentActive', 'target'];
const FIELDS = ['damageCounters', 'maximumHp', 'remainingHp', 'retreatEnergy', 'energyCards', 'energyUnits', 'specialConditions'];
const lit = (value) => ({ kind: 'literal', value });
const add = (...terms) => ({ kind: 'add', terms });
const sub = (left, right) => ({ kind: 'subtract', left, right });
const mul = (left, right) => ({ kind: 'multiply', left, right });
const mon = (field, who = 'self') => ({ kind: 'pokemon', who, field });
const prizes = (side = 'own') => ({ kind: 'prizes', side });
const coin = (key, field) => ({ kind: 'coin', key, field });
const compare = (left, relation, right) => ({ kind: 'compare', left, relation, right });
const choose = (condition, ifTrue, ifFalse) => ({ kind: 'choose', condition, ifTrue, ifFalse });
const always = () => compare(lit(1), 'eq', lit(1));
const never = () => compare(lit(1), 'eq', lit(0));
const clone = (value) => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function rejects(fn, code) {
  assert.throws(fn, (error) => {
    assert(error instanceof TypeError);
    assert(error instanceof BattleValueError);
    assert.equal(error.name, 'BattleValueError');
    assert.equal(error.code, code);
    assert.equal(error.ruleId, 'damage.expression');
    assert.equal(error.needsRuling, code === 'needs-ruling');
    return true;
  });
}
const query = (deckSize, remainingPrizes, matchMode = 'normal') => queryPrizesTaken({
  ruleset: { region: 'CN', version: 'V20261019' }, deckSize, remainingPrizes, matchMode,
});
const schema = JSON.parse(await readFile(new URL('../../schemas/battle-value.schema.json', import.meta.url), 'utf8'));
const predicateSchema = JSON.parse(await readFile(new URL('../../schemas/battle-predicate.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
ajv.addSchema(predicateSchema);
// Board queries reuse the shared selector schemas; register the rest of the schema set they refer to.
await registerSharedSchemas(ajv, [schema.$id, predicateSchema.$id]);
const schemaValue = ajv.getSchema(schema.$id);

// Independent reverse-Polish stack oracle. Expected programs are generated
// alongside, NOT by walking/compiling the production AST or importing its helper.
function rpn(tokens) {
  const stack = [];
  for (const token of tokens) {
    if (typeof token === 'number') stack.push(BigInt(token));
    else {
      const right = stack.pop(), left = stack.pop();
      assert.notEqual(left, undefined);
      assert.notEqual(right, undefined);
      const operators = {
        '+': (a, b) => a + b,
        '-': (a, b) => a - b,
        '*': (a, b) => a * b,
      };
      stack.push(operators[token](left, right));
    }
  }
  assert.equal(stack.length, 1);
  return stack[0];
}

test('battle-value root schema and immutable sources pin CN arithmetic/coin/HP/Prize scope without rolling or card approval', () => {
  assert.equal(schema.$id, 'urn:pokemon-tcg:battle-value:1.0.0');
  assert.equal(schema.$ref, '#/$defs/value');
  assert.equal(schema.$defs.choose.properties.condition.$ref, 'urn:pokemon-tcg:battle-predicate:1.0.0');
  assert.deepEqual(BATTLE_VALUE_RULE_IDS, ['damage.expression', 'damage.coins']);
  assert.deepEqual(BATTLE_VALUE_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.B-01..03', pdfPages: [19, 20] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.D-15..17', pdfPages: [50, 51] },
  ]);
  assert(Object.isFrozen(BATTLE_VALUE_RULE_IDS));
  assert(Object.isFrozen(BATTLE_VALUE_SOURCES));
  for (const source of BATTLE_VALUE_SOURCES) {
    assert(Object.isFrozen(source));
    assert(Object.isFrozen(source.pdfPages));
  }
  assert.match(schema.$comment, /II\.B-01\.\.03.*19–20.*II\.D-15\.\.17.*50–51/);
  assert.deepEqual(schema.$defs.who.enum, WHO);
  assert.deepEqual(schema.$defs.pokemonField.enum, FIELDS);
  assert.deepEqual(schema.$defs.coin.required, ['kind', 'key', 'field']);
  assert.deepEqual(schema.$defs.coin.properties.field.enum, ['heads', 'tails', 'flips']);
  assert.equal(schema.$defs.coin.additionalProperties, false);
  assert.match(schema.$comment, /damage\.coins/);
});

test('signed literals, singleton/n-ary sums and null-prototype descriptions preserve input and need no facts', () => {
  for (const value of [-MAX, -20, -1, -0, 0, 1, 20, MAX]) {
    const expr = freeze(lit(value)), before = clone(expr);
    assert.equal(assertBattleValue(expr), expr);
    assert.equal(schemaValue(expr), true);
    assert.equal(evaluateBattleInteger(expr), BigInt(value));
    assert.equal(evaluateBattleValue(expr), Number(BigInt(value)));
    assert.deepEqual(expr, before);
  }
  assert.equal(evaluateBattleValue(add(lit(30))), 30);
  assert.equal(evaluateBattleValue(add(lit(20), lit(-30), lit(40), lit(-10))), 20);
  const nullProto = Object.assign(Object.create(null), lit(10));
  assert.equal(assertBattleValue(nullProto), nullProto);
  assert.equal(schemaValue(nullProto), true);
  assert.equal(evaluateDamageValue(nullProto), 10);
  const shared = freeze(lit(10)), dag = freeze(add(shared, shared));
  assert.equal(evaluateBattleInteger(dag), 20n, 'Shared acyclic subtrees are not cycles.');
});

test('independent exhaustive RPN oracle checks every three-leaf small-domain tree and both associations', (t) => {
  const values = [-31, -20, -1, 0, 1, 9, 10, 20, 31];
  const operators = [
    ['+', (a, b) => add(a, b)], ['-', sub], ['*', mul],
  ];
  let checked = 0;
  for (const a of values) for (const b of values) for (const c of values)
    for (const [op1, build1] of operators) for (const [op2, build2] of operators) {
      for (const [expr, program] of [
        [build2(build1(lit(a), lit(b)), lit(c)), [a, b, op1, c, op2]],
        [build1(lit(a), build2(lit(b), lit(c))), [a, b, c, op2, op1]],
      ]) {
        const expected = rpn(program), before = clone(expr);
        assert.equal(schemaValue(expr), true);
        assert.equal(evaluateBattleInteger(expr), expected);
        assert.equal(evaluateBattleValue(expr), Number(expected));
        const damage = expected < 0n ? 0n : expected;
        if (damage % 10n === 0n) assert.equal(evaluateDamageValue(expr), Number(damage));
        else rejects(() => evaluateDamageValue(expr), 'invalid-damage-value');
        assert.deepEqual(expr, before);
        checked++;
      }
    }
  assert.equal(checked, 13_122);
  t.diagnostic(`${checked} complete small-domain AST/program pairs; no production oracle helper.`);
});

test('BigInt intermediates stay exact across unsafe cancellation, products, signs and final-only zero clamping', () => {
  const square = mul(lit(MAX), lit(MAX));
  assert.equal(evaluateBattleInteger(square), MAX_BIG * MAX_BIG);
  assert.notEqual(BigInt(MAX * MAX), MAX_BIG * MAX_BIG, 'This fixture must expose floating-point loss.');
  rejects(() => evaluateBattleValue(square), 'numeric-overflow');
  rejects(() => evaluateDamageValue(square), 'numeric-overflow');
  const exactTen = sub(square, sub(square, lit(10)));
  assert.equal(evaluateBattleInteger(exactTen), 10n);
  assert.equal(evaluateDamageValue(exactTen), 10);
  assert.equal(evaluateBattleValue(add(square, mul(lit(-MAX), lit(MAX)), lit(70))), 70);
  assert.equal(evaluateBattleValue(sub(mul(lit(MAX), lit(3)), mul(lit(MAX), lit(2)))), MAX);
  const belowRange = mul(lit(-MAX), lit(MAX));
  assert.equal(evaluateBattleInteger(belowRange), -MAX_BIG * MAX_BIG);
  rejects(() => evaluateBattleValue(belowRange), 'numeric-overflow');
  assert.equal(evaluateDamageValue(belowRange), 0, 'Clamp final negative BEFORE the safe-Number check.');
  assert.equal(evaluateDamageValue(add(sub(lit(20), lit(40)), lit(30))), 10, 'Never clamp a subexpression.');
  assert.equal(evaluateBattleValue(add(sub(lit(20), lit(40)), lit(30))), 10);
  for (const expr of [add(lit(MAX), lit(1)), sub(lit(-MAX), lit(1))])
    rejects(() => evaluateBattleValue(expr), 'numeric-overflow');
});

test('legacy numeric damage is stricter than expression damage; only final expressions may become zero', () => {
  for (const value of [0, -0, 10, 20, 9007199254740990])
    assert.equal(evaluateDamageValue(value), Number(BigInt(value)));
  for (const value of [-MAX, -10, -1, 1, 9, 11, 10.5, MAX, MAX + 1, Infinity, -Infinity, NaN])
    rejects(() => evaluateDamageValue(value), 'invalid-damage-value');
  for (const value of [-MAX, -10, -9, -1, 0])
    assert.equal(evaluateDamageValue(lit(value)), 0);
  for (const value of [1, 9, 11, MAX])
    rejects(() => evaluateDamageValue(lit(value)), 'invalid-damage-value');
  assert.equal(evaluateBattleValue(lit(-9)), -9, 'Non-damage expressions stay signed.');
  for (const value of [null, '10', 10n, true, false, undefined, new Number(10)])
    rejects(() => evaluateDamageValue(value), 'invalid-battle-value');
});

test('all explicit holder/stat combinations use effective facts and distinguish counters, HP, Energy cards and units', () => {
  const stats = {
    damageCounters: 3, maximumHp: 310, remainingHp: 280,
    retreatEnergy: 2, energyCards: 4, energyUnits: 7, specialConditions: 2,
  };
  const facts = freeze({
    pokemon: Object.fromEntries(WHO.map((who, index) => [who,
      Object.fromEntries(Object.entries(stats).map(([field, value]) => [field, value + index * 10])),
    ])),
    printed: { hp: 100, retreatCost: 0, types: ['Fire'] },
  });
  const before = clone(facts);
  for (const [index, who] of WHO.entries()) for (const field of FIELDS) {
    const expr = mon(field, who);
    assert.equal(schemaValue(expr), true);
    assert.equal(evaluateBattleInteger(expr, facts), BigInt(stats[field] + index * 10));
    assert.equal(evaluateBattleValue(expr, facts), stats[field] + index * 10);
  }
  assert.equal(evaluateDamageValue(mul(mon('damageCounters'), lit(20)), facts), 60);
  assert.equal(evaluateDamageValue(mul(mon('energyCards'), lit(20)), facts), 80);
  assert.equal(evaluateDamageValue(mul(mon('energyUnits'), lit(20)), facts), 140);
  assert.equal(evaluateDamageValue(mul(mon('retreatEnergy'), lit(30)), facts), 60);
  assert.equal(evaluateBattleValue(mon('maximumHp'), facts), 310);
  assert.equal(evaluateBattleValue(mon('remainingHp'), facts), 280);
  assert.deepEqual(facts, before);
  for (const field of ['maximumHp', 'remainingHp']) for (const value of [-MAX, -10, 0, MAX]) {
    assert.equal(evaluateBattleValue(mon(field), { pokemon: { self: { [field]: value } } }), value);
  }
  for (const field of ['damageCounters', 'retreatEnergy', 'energyCards', 'energyUnits', 'specialConditions'])
    for (const value of [0, 1, MAX])
      assert.equal(evaluateBattleInteger(mon(field), { pokemon: { self: { [field]: value } } }), BigInt(value));
});

test('requested facts must exist as own enumerable data; malformed or absent stats never become zero', () => {
  const invalidStat = [undefined, null, false, '', '3', [], {}, NaN, Infinity, -Infinity, 0.5, MAX + 1, 1n, new Number(3)];
  for (const field of FIELDS) for (const value of invalidStat)
    rejects(() => evaluateBattleInteger(mon(field), { pokemon: { self: { [field]: value } } }), 'invalid-battle-facts');
  for (const field of ['damageCounters', 'retreatEnergy', 'energyCards', 'energyUnits', 'specialConditions'])
    rejects(() => evaluateBattleValue(mon(field), { pokemon: { self: { [field]: -1 } } }), 'invalid-battle-facts');
  for (const facts of [undefined, null, [], {}, { pokemon: null }, { pokemon: [] },
    { pokemon: {} }, { pokemon: { self: null } }, { pokemon: { self: {} } },
    { pokemon: { target: { damageCounters: 9 } } },
    { printed: { damageCounters: 9 } },
  ]) rejects(() => evaluateBattleValue(mon('damageCounters'), facts), 'invalid-battle-facts');

  let calls = 0;
  const parts = [() => ({ pokemon: { self: { damageCounters: 3 } } }),
    () => ({ self: { damageCounters: 3 } }), () => ({ damageCounters: 3 })];
  const keys = ['pokemon', 'self', 'damageCounters'];
  for (let depth = 0; depth < 3; depth++) {
    for (const kind of ['accessor', 'hidden', 'inherited', 'nonplain']) {
      let part = parts[depth](), value = part[keys[depth]];
      if (kind === 'accessor') Object.defineProperty(part, keys[depth], {
        enumerable: true, get() { calls++; throw new Error('must not execute requested getter'); },
      });
      if (kind === 'hidden') Object.defineProperty(part, keys[depth], { value, enumerable: false });
      if (kind === 'inherited') part = Object.create({ [keys[depth]]: value });
      if (kind === 'nonplain') part = Object.assign(new (class Fact {})(), part);
      const facts = depth === 0 ? part : depth === 1 ? { pokemon: part } : { pokemon: { self: part } };
      rejects(() => evaluateBattleValue(mon('damageCounters'), facts), 'invalid-battle-facts');
    }
  }
  assert.equal(calls, 0);
  const stats = Object.assign(Object.create(null), { damageCounters: 3 });
  const pokemon = Object.assign(Object.create(null), { self: stats });
  assert.equal(evaluateBattleValue(mon('damageCounters'), Object.assign(Object.create(null), { pokemon })), 3);
});

test('fact queries never enumerate unrelated private fields, providers, sides or fallback cards', () => {
  let calls = 0;
  const poison = (record, key) => Object.defineProperty(record, key, {
    enumerable: true, get() { calls++; throw new Error(`unrequested ${key}`); },
  });
  const stats = poison({ damageCounters: 3 }, 'maximumHp');
  const pokemon = poison({ self: stats, target: null }, 'opponentActive');
  const facts = poison({ pokemon }, 'prizes');
  poison(facts, 'deck');
  assert.equal(evaluateBattleInteger(mon('damageCounters'), facts), 3n);
  assert.equal(evaluateDamageValue(mul(mon('damageCounters'), lit(20)), facts), 60);
  assert.equal(evaluateBattleValue(lit(10), facts), 10);
  assert.equal(evaluateDamageValue(10, facts), 10);
  assert.equal(calls, 0);
});

test('Prizes read original fixed-base query results by explicit side, never physical awards or current remaining cards', () => {
  for (const side of ['own', 'opponent']) for (const [deckSize, basis] of [[30, 3], [40, 4], [60, 6]])
    for (let remaining = 0; remaining <= basis; remaining++) {
      const result = query(deckSize, remaining);
      const facts = freeze({ prizes: { [side]: result } }), before = clone(facts);
      assert.equal(schemaValue(prizes(side)), true);
      assert.equal(evaluateBattleInteger(prizes(side), facts), BigInt(basis - remaining));
      assert.equal(evaluateDamageValue(mul(prizes(side), lit(40)), facts), (basis - remaining) * 40);
      assert.deepEqual(facts, before);
    }
  let calls = 0;
  const sides = { own: query(60, 4) };
  Object.defineProperty(sides, 'opponent', { enumerable: true, get() { calls++; throw new Error('private opposite side'); } });
  const result = { status: 'resolved', count: 2 };
  Object.defineProperty(result, 'sourceOfTruth', { enumerable: true, get() { calls++; throw new Error('not needed'); } });
  assert.equal(evaluateBattleValue(prizes(), { prizes: sides }), 2);
  assert.equal(evaluateBattleValue(prizes(), { prizes: { own: result } }), 2);
  assert.equal(calls, 0);
});

test('needsRuling Prize results are never coerced/clamped/multiplied to zero, and malformed results fail explicitly', () => {
  for (const result of [query(60, 0, 'tiebreak'), query(40, 5), query(30, MAX, 'tiebreak')]) {
    const facts = { prizes: { own: result } };
    for (const expr of [prizes(), mul(prizes(), lit(0)), sub(prizes(), prizes())])
      rejects(() => evaluateBattleInteger(expr, facts), 'needs-ruling');
    rejects(() => evaluateDamageValue(mul(lit(-10), prizes()), facts), 'needs-ruling');
  }
  let calls = 0;
  const unresolved = { status: 'needsRuling' };
  Object.defineProperty(unresolved, 'count', { enumerable: true, get() { calls++; throw new Error('not numeric'); } });
  rejects(() => evaluateBattleValue(prizes(), { prizes: { own: unresolved } }), 'needs-ruling');
  assert.equal(calls, 0);
  for (const own of [null, undefined, [], 2, {}, { status: 'unknown', count: 0 },
    { status: 'needs-ruling', count: 0 }, { status: 'resolved' },
    ...[-1, null, false, '2', 0.5, Infinity, NaN, MAX + 1, 1n].map((count) => ({ status: 'resolved', count })),
  ]) rejects(() => evaluateBattleInteger(prizes(), { prizes: { own } }), 'invalid-battle-facts');
  for (const key of ['status', 'count']) {
    const own = { status: 'resolved', count: 2 };
    Object.defineProperty(own, key, { enumerable: true, get() { calls++; throw new Error('not own data'); } });
    rejects(() => evaluateBattleValue(prizes(), { prizes: { own } }), 'invalid-battle-facts');
  }
  assert.equal(calls, 0);
});

test('choose validates all static branches but reads only selected runtime facts, including explicit null and unresolved Prizes', () => {
  let calls = 0;
  const facts = { pokemon: { self: null, target: null }, prizes: { own: query(60, 1, 'tiebreak') } };
  Object.defineProperty(facts.prizes, 'opponent', {
    enumerable: true, get() { calls++; throw new Error('unchosen opponent Prize getter'); },
  });
  for (const expr of [
    choose(always(), lit(10), prizes()),
    choose(never(), prizes(), lit(10)),
    choose(always(), lit(10), mon('damageCounters')),
    choose(never(), mon('remainingHp', 'target'), lit(10)),
    choose(always(), lit(10), prizes('opponent')),
    choose(never(), prizes('opponent'), lit(10)),
  ]) {
    const before = clone(expr);
    assert.equal(assertBattleValue(expr), expr);
    assert.equal(schemaValue(expr), true);
    assert.equal(evaluateBattleInteger(expr, facts), 10n);
    assert.equal(evaluateBattleValue(expr, facts), 10);
    assert.equal(evaluateDamageValue(expr, facts), 10);
    assert.deepEqual(expr, before);
  }
  assert.equal(calls, 0);
  const nullable = freeze(choose(
    { kind: 'exists', who: 'target' }, mul(mon('damageCounters', 'target'), lit(20)), lit(0),
  ));
  assert.equal(schemaValue(nullable), true);
  assert.equal(evaluateDamageValue(nullable, facts), 0);
  assert.equal(evaluateDamageValue(nullable, { pokemon: { target: { damageCounters: 3 } } }), 60);
  assert.throws(() => evaluateBattleValue(nullable, { pokemon: {} }), (error) => error.code === 'invalid-battle-facts');
  rejects(() => evaluateBattleValue(choose(always(), prizes(), lit(0)), facts), 'needs-ruling');
  rejects(() => evaluateBattleValue(choose(never(), lit(0), prizes()), facts), 'needs-ruling');
  rejects(() => evaluateBattleValue(choose(compare(prizes(), 'eq', lit(0)), lit(10), lit(20)), facts), 'needs-ruling');

  for (const invalid of [
    choose(always(), lit(10), { kind: 'unknown' }),
    choose(never(), { kind: 'unknown' }, lit(10)),
    choose(always(), lit(10), add()),
    choose(never(), lit(0.5), lit(10)),
    choose(always(), lit(10), { ...mon('damageCounters'), default: 0 }),
    { ...choose(always(), lit(10), lit(20)), extra: true },
    { kind: 'choose', condition: always(), ifTrue: lit(10) },
    { kind: 'choose', condition: always(), ifFalse: lit(10) },
    { kind: 'choose', ifTrue: lit(10), ifFalse: lit(20) },
  ]) {
    assert.equal(schemaValue(invalid), false);
    rejects(() => evaluateBattleInteger(invalid), 'invalid-battle-value');
  }
  for (const condition of [
    null, true, false, {}, { kind: 'unknown' },
    { ...always(), relation: '==' }, { ...always(), default: false },
    { kind: 'all', conditions: [] },
  ]) {
    const expr = choose(condition, lit(10), lit(20));
    assert.equal(schemaValue(expr), false);
    assert.throws(() => assertBattleValue(expr), (error) => error.code === 'invalid-battle-predicate');
  }
});

test('recursive Value/Predicate modules use exact integers in nested conditions, never Number rounding or an intermediate clamp', () => {
  const square = mul(lit(MAX), lit(MAX));
  const exactGreater = compare(square, 'gt', sub(square, lit(1)));
  const selected = choose(exactGreater, lit(10), lit(20));
  assert.equal(evaluateBattleValue(selected), 10);
  const signed = choose(compare(sub(lit(10), lit(20)), 'lt', lit(0)), lit(30), lit(40));
  assert.equal(evaluateDamageValue(signed), 30);
  const nested = freeze(choose(
    compare(choose(always(), sub(square, sub(square, lit(3))), lit(0)), 'eq', lit(3)),
    choose(never(), lit(20), choose(always(), lit(50), lit(60))),
    lit(70),
  ));
  const before = clone(nested);
  assert.equal(schemaValue(nested), true);
  assert.equal(evaluateBattleInteger(nested), 50n);
  assert.equal(evaluateDamageValue(nested), 50);
  assert.deepEqual(nested, before);
  const negative = choose(always(), mul(lit(-MAX), lit(MAX)), lit(10));
  assert.equal(evaluateDamageValue(negative), 0);
  rejects(() => evaluateBattleValue(negative), 'numeric-overflow');
  const crossCycle = choose(always(), lit(10), lit(20));
  crossCycle.condition.left = crossCycle;
  rejects(() => assertBattleValue(crossCycle), 'invalid-battle-value');
  const branchCycle = choose(always(), lit(10), lit(20));
  branchCycle.ifFalse = branchCycle;
  rejects(() => assertBattleValue(branchCycle), 'invalid-battle-value');
  let calls = 0;
  const getter = choose(always(), lit(10), lit(20));
  Object.defineProperty(getter.ifFalse, 'value', {
    enumerable: true, get() { calls++; throw new Error('even skipped AST getters must be rejected'); },
  });
  rejects(() => assertBattleValue(getter), 'invalid-battle-value');
  assert.equal(calls, 0);
});

test('schema and strict pure syntax reject unknown kinds/fields, missing operands, malformed scalars and unit aliases', () => {
  const valid = [lit(10), add(lit(10)), sub(lit(20), lit(10)), mul(lit(10), lit(2)), mon('damageCounters'), prizes(),
    coin('attack:roll', 'heads')];
  const invalid = [
    null, false, true, 0, 10, '', '10', [], {}, { kind: null }, { kind: 'divide', left: lit(10), right: lit(2) },
    ...valid.flatMap((expr) => [
      { ...expr, extra: 1 }, { ...expr, approved: true },
      ...Object.keys(expr).map((key) => { const copy = clone(expr); delete copy[key]; return copy; }),
    ]),
    ...[null, false, true, '10', 1.5, MAX + 1, -MAX - 1].map((value) => lit(value)),
    { kind: 'add', terms: [] }, { kind: 'add', terms: {} }, { kind: 'add', terms: null },
    { kind: 'add', terms: [0] }, sub(null, lit(10)), mul(lit(10), []),
    ...['attacker', 'defender', 'own', '', null].map((who) => mon('damageCounters', who)),
    ...['hp', 'printedHp', 'currentHp', 'counters', 'damage', 'energy', 'energyCardCount', null]
      .map((field) => mon(field)),
    ...[0, 1, 'self', 'other', '', null].map((side) => prizes(side)),
  ];
  for (const expr of invalid) {
    assert.equal(schemaValue(expr), false);
    rejects(() => assertBattleValue(expr), 'invalid-battle-value');
    rejects(() => evaluateBattleInteger(expr), 'invalid-battle-value');
  }
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('literal'), () => 10])
    rejects(() => assertBattleValue(lit(value)), 'invalid-battle-value');
});

test('all static data rejects getters, hidden/symbol fields, sparse/custom arrays, cycles and non-JSON instances without invoking code', () => {
  const invalid = [
    new Date(), new Map(), new Set(), /value/, new Number(10), new Uint8Array([1]),
    Object.create(lit(10)), Object.assign(new (class Expr {})(), lit(10)),
    add(new Date()), add(undefined), add(() => 10),
  ];
  let calls = 0;
  for (const key of ['kind', 'value', 'unknown']) {
    const expr = lit(10);
    Object.defineProperty(expr, key, { enumerable: true, get() { calls++; throw new Error('AST getter'); } });
    invalid.push(expr);
    const hidden = lit(10);
    Object.defineProperty(hidden, key, { value: 10, enumerable: false });
    invalid.push(hidden);
  }
  const symbol = lit(10); symbol[Symbol('approval')] = true; invalid.push(symbol);
  const cycle = add(); cycle.terms.push(cycle); invalid.push(cycle);
  const selfArray = []; selfArray.push(selfArray); invalid.push({ kind: 'add', terms: selfArray });
  const sparse = new Array(2); sparse[1] = lit(10); invalid.push({ kind: 'add', terms: sparse });
  const sparseWithExtra = new Array(1); sparseWithExtra.extra = lit(10);
  invalid.push({ kind: 'add', terms: sparseWithExtra });
  const getter = [lit(10)];
  Object.defineProperty(getter, '0', { enumerable: true, get() { calls++; throw new Error('array getter'); } });
  invalid.push({ kind: 'add', terms: getter });
  const hiddenIndex = [lit(10)]; Object.defineProperty(hiddenIndex, '0', { value: lit(10), enumerable: false });
  invalid.push({ kind: 'add', terms: hiddenIndex });
  const extra = [lit(10)]; extra.extra = 1; invalid.push({ kind: 'add', terms: extra });
  const symbolArray = [lit(10)]; symbolArray[Symbol('extra')] = true;
  invalid.push({ kind: 'add', terms: symbolArray });
  invalid.push({ kind: 'add', terms: new (class Terms extends Array {})(lit(10)) });
  for (const expr of invalid) rejects(() => assertBattleValue(expr), 'invalid-battle-value');
  assert.equal(calls, 0);
});

test('coin fields match independent count tables and damage products, including explicit zero and 32 consecutive heads', () => {
  const key = 'attack:damage/roll@1';
  for (let heads = 0; heads <= 5; heads++) for (let tails = 0; tails <= 5; tails++) {
    const facts = freeze({ coins: { [key]: { heads, tails, flips: heads + tails } } }), before = clone(facts);
    for (const [field, expected] of [['heads', heads], ['tails', tails], ['flips', heads + tails]]) {
      const expr = freeze(coin(key, field));
      assert.equal(assertBattleValue(expr), expr);
      assert.equal(schemaValue(expr), true);
      assert.equal(evaluateBattleInteger(expr, facts), BigInt(expected));
      assert.equal(evaluateBattleValue(expr, facts), expected);
      assert.equal(evaluateDamageValue(mul(expr, lit(30)), facts), expected * 30);
    }
    assert.equal(evaluateDamageValue(add(lit(20), mul(coin(key, 'heads'), lit(10))), facts), 20 + heads * 10);
    assert.deepEqual(facts, before);
  }
  const longRoll = freeze({ coins: { [key]: { heads: 32, tails: 1, flips: 33 } } });
  assert.equal(evaluateDamageValue(mul(coin(key, 'heads'), lit(30)), longRoll), 960);
  assert.equal(evaluateBattleInteger(coin(key, 'flips'), longRoll), 33n);
});

test('coin SourceIds admit exact ASCII boundaries, constructor/toString own keys and null-prototype projections', () => {
  const keys = ['0', 'a', 'Z9', 'A._:/@-09z', 'a'.repeat(200), 'constructor', 'toString'];
  for (const key of keys) {
    const counts = Object.assign(Object.create(null), { heads: 2, tails: 1, flips: 3 });
    const coins = Object.assign(Object.create(null), { [key]: counts });
    const facts = Object.assign(Object.create(null), { coins });
    const expr = Object.assign(Object.create(null), coin(key, 'heads'));
    assert.equal(schemaValue(expr), true);
    assert.equal(evaluateBattleValue(expr, facts), 2);
    assert.equal(evaluateBattleValue(coin(key, 'tails'), { coins: { [key]: { heads: 2, tails: 1, flips: 3 } } }), 1);
  }
  // Prototype methods are not receipts when no corresponding own key exists.
  for (const key of ['constructor', 'toString'])
    rejects(() => evaluateBattleInteger(coin(key, 'heads'), { coins: {} }), 'invalid-battle-facts');
});

test('coin static syntax rejects malformed SourceIds, field aliases and scope/receipt overrides even in unchosen branches', () => {
  const bad = [
    ...[undefined, null, false, true, 0, [], {}, new String('roll'), '', '__proto__',
      '_roll', '.roll', ':roll', '/roll', '@roll', '-roll', 'a'.repeat(201),
      'roll x', 'roll\\x', '宝可梦', 'aé', 'a\0', 'a\t', 'a\n', 'a\r', 'a\r\n', 'a\u2028', 'a\u2029',
    ].map((key) => coin(key, 'heads')),
    ...[undefined, null, false, 0, [], {}, 'head', 'tail', 'results', 'count', 'Heads', 'rng', 'passed']
      .map((field) => coin('roll', field)),
    ...['op', 'scope', 'side', 'owner', 'executionId', 'parent', 'source', 'receipt', 'rng', 'default', 'value']
      .map((key) => ({ ...coin('roll', 'heads'), [key]: 'untrusted' })),
    { kind: 'coin', field: 'heads' }, { kind: 'coin', key: 'roll' },
  ];
  for (const expr of bad) {
    // Ajv does not model non-JSON boxed objects; the descriptor gate does.
    if (!(expr.key instanceof String)) assert.equal(schemaValue(expr), false);
    rejects(() => assertBattleValue(expr), 'invalid-battle-value');
    rejects(() => evaluateBattleInteger(expr, { coins: {} }), 'invalid-battle-value');
    for (const hidden of [choose(always(), lit(10), expr), choose(never(), expr, lit(10)),
      choose(always(), lit(10), choose(compare(expr, 'eq', lit(0)), lit(20), lit(30)))])
      rejects(() => evaluateBattleInteger(hidden), 'invalid-battle-value');
  }
});

test('all three coin counts must be nonnegative safe own integers with an exact heads-plus-tails total', () => {
  const valid = [
    { heads: MAX, tails: 0, flips: MAX },
    { heads: 0, tails: MAX, flips: MAX },
    { heads: MAX - 1, tails: 1, flips: MAX },
  ];
  for (const counts of valid) for (const field of ['heads', 'tails', 'flips'])
    assert.equal(evaluateBattleInteger(coin('roll', field), { coins: { roll: counts } }), BigInt(counts[field]));
  const facts = { coins: { roll: valid[0] } };
  assert.equal(evaluateBattleInteger(mul(coin('roll', 'heads'), lit(MAX)), facts), MAX_BIG * MAX_BIG);
  assert.equal(evaluateDamageValue(sub(mul(coin('roll', 'heads'), lit(MAX)),
    sub(mul(coin('roll', 'heads'), lit(MAX)), lit(10))), facts), 10);
  rejects(() => evaluateBattleValue(mul(coin('roll', 'heads'), lit(MAX)), facts), 'numeric-overflow');

  const bad = [
    null, undefined, false, 0, '', [], new Date(), new (class Counts {})(),
    {}, { heads: 0, tails: 0 }, { heads: 1, tails: 1, flips: 1 },
    { heads: 0, tails: 0, flips: 1 }, { heads: 2, tails: 0, flips: 1 },
    { heads: MAX, tails: 1, flips: MAX },
    { heads: MAX, tails: MAX, flips: MAX },
    { heads: 1, tails: 0, flips: 1, passed: true },
    { heads: 1, tails: 0, flips: 1, results: ['heads'] },
    { heads: 1, tails: 0, flips: 1, rng: [1, 2, 3, 4] },
    { heads: 1, tails: 0, [Symbol('flips')]: 1 },
    Object.assign({ heads: 1, tails: 0, flips: 1 }, { [Symbol('receipt')]: [] }),
  ];
  for (const field of ['heads', 'tails', 'flips']) for (const value of [
    undefined, null, false, true, '0', -1, 0.5, NaN, Infinity, -Infinity, MAX + 1, 1n, new Number(1),
  ]) bad.push({ heads: 1, tails: 0, flips: 1, [field]: value });
  for (const counts of bad) for (const field of ['heads', 'tails', 'flips'])
    rejects(() => evaluateBattleInteger(coin('roll', field), { coins: { roll: counts } }), 'invalid-battle-facts');
});

test('coin paths and counts reject getters, hidden/inherited fields and extra executable data without invoking code', () => {
  let calls = 0;
  const get = { enumerable: true, get() { calls++; throw new Error('must not execute coin accessor'); } };
  const base = () => ({ coins: { roll: { heads: 1, tails: 0, flips: 1 } } });
  const invalid = [undefined, null, false, [], {}, { coins: null }, { coins: false }, { coins: [] },
    { coins: {} }, { coins: new (class Rolls {})() }];
  for (const depth of ['facts', 'coins', 'counts']) for (const key of
    depth === 'facts' ? ['coins'] : depth === 'coins' ? ['roll'] : ['heads', 'tails', 'flips']) {
    for (const mode of ['getter', 'hidden', 'inherited', 'class']) {
      const facts = base();
      let container = depth === 'facts' ? facts : depth === 'coins' ? facts.coins : facts.coins.roll;
      const value = container[key];
      if (mode === 'getter') Object.defineProperty(container, key, get);
      if (mode === 'hidden') Object.defineProperty(container, key, { value, enumerable: false });
      if (mode === 'inherited') {
        const own = { ...container }; delete own[key];
        container = Object.assign(Object.create({ [key]: value }), own);
      }
      if (mode === 'class') container = Object.assign(new (class Record {})(), container);
      invalid.push(depth === 'facts' ? container : depth === 'coins' ? { coins: container } : { coins: { roll: container } });
    }
  }
  for (const extra of ['receipt', 'rng', 'roll', Symbol('extra')]) {
    const facts = base(); Object.defineProperty(facts.coins.roll, extra, get); invalid.push(facts);
  }
  const hiddenExtra = base();
  Object.defineProperty(hiddenExtra.coins.roll, 'receipt', { value: [], enumerable: false }); invalid.push(hiddenExtra);
  // A three-key lookalike still cannot replace a required count with an extra.
  invalid.push({ coins: { roll: { heads: 1, tails: 0, extra: 1 } } });
  for (const facts of invalid) for (const field of ['heads', 'tails', 'flips'])
    rejects(() => evaluateBattleInteger(coin('roll', field), facts), 'invalid-battle-facts');
  assert.equal(calls, 0);
});

test('coin reads are repeatable, immutable and scope-local without scanning other keys or consuming RNG/receipts', () => {
  const key = 'shared-binding:damage';
  const facts = { coins: { [key]: { heads: 3, tails: 2, flips: 5 } }, rng: [11, 22, 33, 44],
    receipt: { results: ['heads', 'tails', 'heads', 'tails', 'heads'] } };
  const before = clone(facts);
  const expr = add(mul(coin(key, 'heads'), lit(30)), mul(coin(key, 'tails'), lit(10)),
    sub(coin(key, 'flips'), coin(key, 'flips')));
  freeze(facts); freeze(expr);
  for (let i = 0; i < 5; i++) {
    assert.equal(evaluateBattleInteger(expr, facts), 110n);
    assert.equal(evaluateDamageValue(expr, facts), 110);
    assert.equal(evaluateBattleValue(coin(key, 'heads'), facts), 3);
  }
  assert.deepEqual(facts, before);
  assert.equal(evaluateBattleInteger(JSON.parse(JSON.stringify(expr)), JSON.parse(JSON.stringify(facts))), 110n);

  let calls = 0;
  const getter = { enumerable: true, get() { calls++; throw new Error('unrequested private/scope fact'); } };
  const local = { coins: { [key]: { heads: 3, tails: 2, flips: 5 } } };
  for (const name of ['rng', 'receipt', 'execution', 'parent', 'copy', 'foreign', 'pokemon', 'prizes'])
    Object.defineProperty(local, name, getter);
  for (const other of ['unrequested-key', 'constructor', Symbol('other')])
    Object.defineProperty(local.coins, other, getter);
  assert.equal(evaluateBattleValue(coin(key, 'heads'), local), 3);
  const absent = { coins: {}, parent: { coins: { [key]: { heads: 9, tails: 0, flips: 9 } } },
    foreign: { coins: { [key]: { heads: 8, tails: 0, flips: 8 } } },
    execution: { coins: { [key]: { heads: 7, tails: 0, flips: 7 } } } };
  rejects(() => evaluateBattleInteger(coin(key, 'heads'), absent), 'invalid-battle-facts');
  assert.equal(evaluateBattleValue(coin(key, 'heads'), { coins: { [key]: { heads: 1, tails: 0, flips: 1 } } }), 1);
  assert.equal(evaluateBattleValue(coin(key, 'heads'), local), 3, 'Another execution never changes this projection.');
  assert.equal(calls, 0);
});

test('coin choose/predicate branches validate all syntax but demand counts only when their runtime path is read', () => {
  const read = coin('roll', 'heads'), selected = compare(read, 'gt', lit(0));
  const facts = { coins: { roll: { heads: 2, tails: 1, flips: 3 } } };
  const damage = choose(selected, mul(read, lit(30)), lit(0));
  assert.equal(schemaValue(damage), true);
  assert.equal(evaluateDamageValue(damage, facts), 60);
  assert.equal(evaluateDamageValue(damage, { coins: { roll: { heads: 0, tails: 3, flips: 3 } } }), 0);
  for (const expr of [choose(always(), lit(10), read), choose(never(), read, lit(10)),
    choose({ kind: 'any', conditions: [always(), selected] }, lit(10), lit(20)),
    choose({ kind: 'all', conditions: [never(), selected] }, lit(20), lit(10))])
    assert.equal(evaluateDamageValue(expr, {}), 10);
  for (const expr of [damage, choose(always(), read, lit(10)), choose(never(), lit(10), read),
    mul(lit(0), read), sub(read, read)])
    rejects(() => evaluateBattleInteger(expr, {}), 'invalid-battle-facts');
  rejects(() => evaluateBattleInteger(damage, { coins: { roll: { heads: 0, tails: 0, flips: 1 } } }), 'invalid-battle-facts');
});
