// Entirely synthetic predicates/facts. No real-card approval or trustpin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerSharedSchemas } from './schema-set.mjs';
import { execFileSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  BattlePredicateError, BATTLE_PREDICATE_SOURCES,
  assertBattlePredicate, evaluateBattlePredicate,
} from '../../public/rules/battle-predicate.js';
import { BattleValueError, assertBattleValue, evaluateBattleInteger } from '../../public/rules/battle-value.js';
import { queryPrizesTaken } from '../../public/rules/prize-count.js';
import { CN_V20261019 } from '../../public/rules/zh-CN/V20261019.js';

const literal = (value) => ({ kind: 'literal', value });
const compare = (left, relation = 'eq', right = literal(0)) => ({ kind: 'compare', left, relation, right });
const constant = (value) => compare(literal(0), value ? 'eq' : 'neq');
const all = (...conditions) => ({ kind: 'all', conditions });
const any = (...conditions) => ({ kind: 'any', conditions });
const not = (condition) => ({ kind: 'not', condition });
const exists = (who = 'self') => ({ kind: 'exists', who });
const pokemon = (who, field) => ({ kind: 'pokemon', who, field });
const prizes = (side = 'own') => ({ kind: 'prizes', side });
const choose = (condition, ifTrue, ifFalse) => ({ kind: 'choose', condition, ifTrue, ifFalse });
const binary = (kind, left, right) => ({ kind, left, right });
const clone = (value) => structuredClone(value);
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const prizeResult = (remainingPrizes = 6, matchMode = 'normal') => queryPrizesTaken({
  ruleset: { region: 'CN', version: 'V20261019' }, deckSize: 60, remainingPrizes, matchMode,
});
const stats = (extra = {}) => ({
  damageCounters: 3, maximumHp: 130, remainingHp: 100,
  retreatEnergy: 2, energyCards: 2, energyUnits: 5, ...extra,
});
const facts = () => ({
  pokemon: { self: stats(), ownActive: stats({ remainingHp: 50 }),
    opponentActive: stats({ remainingHp: 70 }), target: null },
  prizes: { own: prizeResult(4), opponent: prizeResult(1) },
});
const invalid = (fn, code) => assert.throws(fn, (error) => {
  assert(error instanceof TypeError);
  if (code !== undefined) {
    assert(error instanceof BattlePredicateError); assert.equal(error.name, 'BattlePredicateError');
    assert.equal(error.code, code);
  }
  return true;
});
const invalidPredicate = (predicate) => {
  invalid(() => assertBattlePredicate(predicate));
  invalid(() => evaluateBattlePredicate(predicate, facts()));
};

// Mutual schema references are registered before compilation. No shared
// generator, runtime registration, schema-validators or kernel stamps touched.
const predicateSchema = JSON.parse(await readFile(new URL('../../schemas/battle-predicate.schema.json', import.meta.url), 'utf8'));
const valueSchema = JSON.parse(await readFile(new URL('../../schemas/battle-value.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(predicateSchema); ajv.addSchema(valueSchema);
await registerSharedSchemas(ajv, [predicateSchema.$id, valueSchema.$id]);
const validate = ajv.getSchema(predicateSchema.$id);

test('source scope pins CN II.A/B01–03/D15–17 without approving conditions or changing card definitions', async () => {
  assert.equal(predicateSchema.$id, 'urn:pokemon-tcg:battle-predicate:1.0.0');
  assert.deepEqual(BATTLE_PREDICATE_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.A', pdfPages: [19] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.B-01..03', pdfPages: [19, 20] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.D-15..17', pdfPages: [50, 51] },
  ]);
  const document = CN_V20261019.documents.find((entry) => entry.id === 'CN-advanced-3.1.0');
  assert.equal(document.sha256, '27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419');
  assert(predicateSchema.$comment.includes(document.sha256));
  assert.match(predicateSchema.$comment, /reviewed card binding/);
  assert(Object.isFrozen(BATTLE_PREDICATE_SOURCES));
  for (const source of BATTLE_PREDICATE_SOURCES) {
    assert(source.pdfPages.every((page) => page >= 1 && page <= document.pages));
    assert(Object.isFrozen(source)); assert(Object.isFrozen(source.pdfPages));
  }
  assert.throws(() => BATTLE_PREDICATE_SOURCES[0].pdfPages.push(20), TypeError);
  const source = await readFile(new URL('../../public/rules/battle-predicate.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\s*\(|\bMath\.random\s*\(/);
});

test('all six relations match an independent ordered-integer truth table, including equal and signed endpoints', () => {
  const expected = {
    less: { eq: false, neq: true, lt: true, lte: true, gt: false, gte: false },
    equal: { eq: true, neq: false, lt: false, lte: true, gt: false, gte: true },
    greater: { eq: false, neq: true, lt: false, lte: false, gt: true, gte: true },
  };
  const ordered = [-Number.MAX_SAFE_INTEGER, -5, -0, 5, Number.MAX_SAFE_INTEGER];
  for (let i = 0; i < ordered.length; i++) for (let j = 0; j < ordered.length; j++) {
    const row = expected[i < j ? 'less' : i === j ? 'equal' : 'greater'];
    for (const [relation, want] of Object.entries(row)) {
      const predicate = compare(literal(ordered[i]), relation, literal(ordered[j]));
      assert.equal(validate(predicate), true); assert.equal(assertBattlePredicate(predicate), predicate);
      assert.equal(evaluateBattlePredicate(predicate), want);
      assert.equal(typeof evaluateBattlePredicate(predicate), 'boolean');
    }
  }
});

test('BigInt intermediate comparisons retain one-unit differences far beyond safe Number limits and never clamp negatives', () => {
  const max = literal(Number.MAX_SAFE_INTEGER), square = binary('multiply', max, max);
  const next = { kind: 'add', terms: [square, literal(1)] };
  for (const [relation, want] of [['eq', false], ['neq', true], ['lt', true],
    ['lte', true], ['gt', false], ['gte', false]]) {
    assert.equal(evaluateBattlePredicate(compare(square, relation, next)), want);
  }
  const negative = binary('subtract', literal(10), literal(100));
  assert.equal(evaluateBattlePredicate(compare(negative, 'lt', literal(0))), true);
  assert.equal(evaluateBattlePredicate(compare(negative, 'eq', literal(-90))), true);
  assert.equal(evaluateBattlePredicate(compare(binary('multiply', negative, literal(-2)), 'eq', literal(180))), true);
});

test('Boolean composition matches an independent truth-mask oracle, not numeric truthiness or mutable defaults', () => {
  for (let bits = 0; bits < 8; bits++) {
    const a = !!(bits & 1), b = !!(bits & 2), c = !!(bits & 4);
    for (const [predicate, want] of [
      [all(constant(a), constant(b), constant(c)), bits === 7],
      [any(constant(a), constant(b), constant(c)), bits !== 0],
      [not(constant(a)), !a],
      [all(constant(a), any(constant(b), not(constant(c)))), a && (b || !c)],
      [not(any(not(constant(a)), all(constant(b), constant(c)))), a && !(b && c)],
    ]) {
      assert.equal(validate(predicate), true);
      assert.equal(evaluateBattlePredicate(predicate), want);
    }
  }
  assert.equal(evaluateBattlePredicate(all(constant(true))), true);
  assert.equal(evaluateBattlePredicate(any(constant(false))), false);
});

test('all normalized holder/stat queries use explicit host units, signed remaining HP and source-relative Prize results', () => {
  const context = facts();
  const rows = [
    ['self', 'damageCounters', 3], ['self', 'maximumHp', 130], ['self', 'remainingHp', 100],
    ['self', 'retreatEnergy', 2], ['self', 'energyCards', 2], ['self', 'energyUnits', 5],
    ['ownActive', 'remainingHp', 50], ['opponentActive', 'remainingHp', 70],
  ];
  for (const [who, field, want] of rows)
    assert.equal(evaluateBattlePredicate(compare(pokemon(who, field), 'eq', literal(want)), context), true);
  context.pokemon.target = stats({ remainingHp: -20 });
  assert.equal(evaluateBattlePredicate(compare(pokemon('target', 'remainingHp'), 'lt', literal(0)), context), true);
  assert.equal(evaluateBattlePredicate(compare(prizes('own'), 'lt', prizes('opponent')), context), true);
  assert.equal(evaluateBattlePredicate(compare(prizes(), 'eq', literal(2)), context), true);
  assert.equal(evaluateBattlePredicate(compare(pokemon('self', 'energyCards'), 'eq',
    pokemon('self', 'energyUnits')), context), false);
  assert.equal(evaluateBattlePredicate(compare(pokemon('self', 'damageCounters'), 'eq', literal(30)), context), false);
});

test('exists returns false only for explicit null and true for each normalized plain holder record', () => {
  for (const who of ['self', 'ownActive', 'opponentActive', 'target']) {
    const context = facts(); context.pokemon[who] = null;
    assert.equal(validate(exists(who)), true);
    assert.equal(evaluateBattlePredicate(exists(who), context), false);
    assert.equal(evaluateBattlePredicate(not(exists(who)), context), true);
    context.pokemon[who] = stats();
    assert.equal(evaluateBattlePredicate(exists(who), context), true);
    // Existence does not read or invent a missing stat; the host authenticates
    // the projection. A later actual stat query must still require that field.
    context.pokemon[who] = Object.create(null);
    assert.equal(evaluateBattlePredicate(exists(who), context), true);
    invalid(() => evaluateBattlePredicate(compare(pokemon(who, 'maximumHp')), context));
  }
  const context = Object.assign(Object.create(null), facts());
  context.pokemon = Object.assign(Object.create(null), context.pokemon);
  context.pokemon.self = Object.assign(Object.create(null), stats());
  const predicate = Object.assign(Object.create(null), exists());
  assert.equal(assertBattlePredicate(predicate), predicate);
  assert.equal(evaluateBattlePredicate(predicate, context), true);
});

test('exists rejects absent, inherited, hidden, getter and malformed requested fact paths without invoking getters', () => {
  let calls = 0;
  const getter = { enumerable: true, get() { calls++; throw new Error('must not execute'); } };
  const contexts = [
    undefined, null, false, 0, '', [], new Date(), Object.create(facts()), {},
    { pokemon: null }, { pokemon: [] }, { pokemon: false }, { pokemon: Object.create(facts().pokemon) },
    { pokemon: {} },
  ];
  for (const value of [undefined, false, true, 0, '', [], new Date(),
    new (class {})(), Object.create({ maximumHp: 100 })])
    contexts.push({ pokemon: { self: value } });
  for (const [container, key] of [['facts', 'pokemon'], ['pokemon', 'self']]) {
    for (const descriptor of [getter, { value: null, enumerable: false }]) {
      const context = facts();
      Object.defineProperty(container === 'facts' ? context : context.pokemon, key, descriptor);
      contexts.push(context);
    }
  }
  for (const context of contexts)
    invalid(() => evaluateBattlePredicate(exists(), context), 'invalid-battle-facts');
  assert.equal(calls, 0);
});

test('existence reads neither unrequested holders nor stat getters, hidden cards, histories or Prize queries', () => {
  let calls = 0;
  const context = facts();
  const getter = { enumerable: true, get() { calls++; throw new Error('unrequested'); } };
  for (const key of ['prizes', 'cards', 'history']) Object.defineProperty(context, key, getter);
  Object.defineProperty(context.pokemon, 'opponentActive', getter);
  Object.defineProperty(context.pokemon.self, 'maximumHp', getter);
  assert.equal(evaluateBattlePredicate(exists('self'), context), true);
  assert.equal(calls, 0);
});

test('needsRuling propagates from either operand and through not/all/any/choose instead of becoming false or zero', () => {
  for (const result of [prizeResult(1, 'tiebreak'), prizeResult(7)]) {
    const context = facts(); context.prizes.own = result;
    const check = compare(prizes(), 'eq', literal(0));
    for (const predicate of [
      check, compare(literal(0), 'eq', prizes()), not(check),
      all(constant(true), check), any(constant(false), check),
      compare(choose(check, literal(10), literal(20)), 'eq', literal(20)),
    ]) assert.throws(() => evaluateBattlePredicate(predicate, context), (error) => {
      assert(error instanceof BattleValueError); assert.equal(error.code, 'needs-ruling');
      assert.equal(error.needsRuling, true); return true;
    });
    assert.equal(result.count, null);
  }
});

test('runtime all/any short circuit without touching missing/getter/unresolved tail facts, in declared order', () => {
  let calls = 0;
  const context = facts(); context.prizes.own = prizeResult(1, 'tiebreak');
  Object.defineProperty(context.pokemon, 'target', {
    enumerable: true, get() { calls++; throw new Error('must remain skipped'); },
  });
  for (const tail of [exists('target'), compare(prizes()), compare(pokemon('target', 'maximumHp'))]) {
    assert.equal(evaluateBattlePredicate(all(constant(false), tail), context), false);
    assert.equal(evaluateBattlePredicate(any(constant(true), tail), context), true);
  }
  assert.equal(evaluateBattlePredicate(all(constant(false), exists()), undefined), false);
  assert.equal(evaluateBattlePredicate(any(constant(true), exists()), undefined), true);
  invalid(() => evaluateBattlePredicate(all(exists('target'), constant(false)), context), 'invalid-battle-facts');
  invalid(() => evaluateBattlePredicate(any(exists('target'), constant(true)), context), 'invalid-battle-facts');
  assert.equal(calls, 0);
});

test('mutual Value.choose and Predicate comparisons import in either ESM order and evaluate only selected runtime branches', () => {
  const context = facts(), predicate = compare(choose(exists('target'), pokemon('target', 'remainingHp'),
    choose(all(compare(prizes(), 'eq', literal(2)), not(exists('target'))), literal(70), prizes('opponent'))),
  'eq', literal(70));
  assert.equal(validate(predicate), true);
  assert.equal(evaluateBattlePredicate(predicate, context), true);
  assert.equal(evaluateBattleInteger(choose(predicate, literal(130), pokemon('target', 'remainingHp')), context), 130n);
  context.pokemon.target = stats({ remainingHp: 50 });
  assert.equal(evaluateBattlePredicate(predicate, context), false);
  for (const first of ['battle-value', 'battle-predicate']) {
    const second = first === 'battle-value' ? 'battle-predicate' : 'battle-value';
    const script = `
      const a = await import(${JSON.stringify(new URL(`../../public/rules/${first}.js`, import.meta.url).href)});
      const b = await import(${JSON.stringify(new URL(`../../public/rules/${second}.js`, import.meta.url).href)});
      const both = {...a,...b};
      if (both.evaluateBattlePredicate(${JSON.stringify(compare(literal(7), 'gt', literal(2)))}) !== true) throw Error('bad cycle');
    `;
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }), '');
  }
});

test('short-circuit decisions cannot conceal unknown predicates or malformed Value/choose syntax anywhere in the AST', () => {
  const bad = [
    null, true, 0, [], {}, { kind: 'truthy', value: 1 },
    { kind: 'exists', who: 'self', op: 'exists' }, { kind: 'not', condition: null },
    compare({ kind: 'literal', value: '1' }),
    compare({ kind: 'add', terms: [] }),
    compare({ kind: 'pokemon', who: 'self', field: 'hp' }),
    compare(choose(constant(true), literal(10), { kind: 'unknown' })),
    compare(choose({ kind: 'unknown' }, literal(10), literal(20))),
  ];
  for (const invalidBranch of bad) for (const predicate of [
    all(constant(false), invalidBranch), any(constant(true), invalidBranch),
    compare(choose(constant(true), literal(1), choose(invalidBranch, literal(1), literal(2)))),
  ]) invalidPredicate(predicate);
});

test('schema and assertion reject every missing/extra field and all unspecified kinds, relations and holders', () => {
  const templates = [compare(literal(1)), all(constant(true)), any(constant(false)), not(constant(true)), exists()];
  const bad = [
    undefined, null, false, 0, 1, '', 'true', [], {}, { kind: null }, { kind: 'literal', value: true },
    ...['and', 'or', 'xor', 'if', 'eval', '__proto__', 'constructor'].map((kind) => ({ kind })),
    ...['=', '==', '===', '!=', '<', '>', 'EQ', '', null, false, 0, [], {}].map((relation) =>
      compare(literal(1), relation)),
    ...['own', 'opponent', 'active', '', null, false, 0, [], {}].map((who) => exists(who)),
    ...[null, false, 0, '', {}, []].flatMap((conditions) =>
      [{ kind: 'all', conditions }, { kind: 'any', conditions }]),
    not([]), not(literal(1)), compare(1), compare(literal(0), 'eq', 0),
  ];
  for (const template of templates) {
    for (const key of Object.keys(template)) {
      const predicate = clone(template); delete predicate[key]; bad.push(predicate);
    }
    for (const key of ['op', 'approved', 'sourceOfTruth', 'default', 'value', 'script']) {
      bad.push({ ...template, [key]: 'globalThis.__battlePredicateExecuted = true' });
    }
  }
  delete globalThis.__battlePredicateExecuted;
  for (const predicate of bad) {
    assert.equal(validate(predicate), false, JSON.stringify(predicate));
    invalidPredicate(predicate);
  }
  assert.equal(globalThis.__battlePredicateExecuted, undefined);
});

test('Value syntax never accepts unsafe numbers, truthy coercions, executable values or unapproved fact names', () => {
  const badValues = [
    undefined, null, false, '10', 10, 1n, () => 1, Symbol('1'), new Number(1),
    ...[Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, 0.1, NaN, Infinity, -Infinity,
      '1', false, null, undefined, 1n].map(literal),
    { kind: 'pokemon', who: 'player0', field: 'maximumHp' },
    { kind: 'pokemon', who: 'self', field: 'printedHp' },
    { kind: 'prizes', side: 'current' }, { kind: 'javascript', expression: '1 + 1' },
    { kind: 'literal', value: 1, toJSON() { throw new Error('not called'); } },
  ];
  for (const value of badValues) {
    invalidPredicate(compare(value));
    invalidPredicate({ kind: 'compare', left: literal(0), relation: 'eq', right: value });
  }
});

test('entire AST descriptor validation rejects inherited/class, symbolic, hidden and getter properties without execution', () => {
  let calls = 0;
  const bad = [
    Object.create(exists()), Object.assign(Object.create({}), exists()),
    new (class { constructor() { Object.assign(this, exists()); } })(),
    Object.assign(new Date(), exists()),
  ];
  for (const key of ['kind', 'left', 'relation', 'right', 'unknown']) {
    const predicate = compare(literal(1));
    Object.defineProperty(predicate, key, { enumerable: true, get() { calls++; throw new Error('not called'); } });
    bad.push(predicate);
  }
  for (const key of ['who', 'hidden']) {
    const predicate = exists(); Object.defineProperty(predicate, key, { value: 'self', enumerable: false });
    bad.push(predicate);
  }
  const symbolic = exists(); symbolic[Symbol('kind')] = 'exists'; bad.push(symbolic);
  const nested = all(constant(false), exists());
  Object.defineProperty(nested.conditions[1], 'who', { enumerable: true, get() { calls++; return 'self'; } });
  bad.push(nested);
  const left = compare(literal(1));
  Object.defineProperty(left.left, 'value', { enumerable: true, get() { calls++; return 1; } }); bad.push(left);
  for (const predicate of bad) invalidPredicate(predicate);
  assert.equal(calls, 0);

  // Ordinary JSON records still inherit Object.prototype. A missing own kind
  // must reject without reading an inherited accessor, even in an unchosen
  // Value.choose branch. Always restore the exact original descriptor.
  const previousKind = Object.getOwnPropertyDescriptor(Object.prototype, 'kind');
  try {
    Object.defineProperty(Object.prototype, 'kind', {
      configurable: true, get() { calls++; throw new Error('inherited kind must not execute'); },
    });
    invalid(() => assertBattlePredicate({}), 'invalid-battle-predicate');
    invalid(() => evaluateBattlePredicate({}, facts()), 'invalid-battle-predicate');
    for (const expression of [
      choose(constant(true), literal(10), choose({}, literal(20), literal(30))),
      choose(constant(false), choose({}, literal(20), literal(30)), literal(10)),
    ]) {
      invalid(() => assertBattleValue(expression), 'invalid-battle-predicate');
      invalid(() => evaluateBattleInteger(expression, facts()), 'invalid-battle-predicate');
    }
    assert.equal(calls, 0);
  } finally {
    if (previousKind) Object.defineProperty(Object.prototype, 'kind', previousKind);
    else delete Object.prototype.kind;
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'kind'), previousKind);
});

test('condition arrays must be ordinary dense own-data arrays, including crafted sparse replacements and index accessors', () => {
  let calls = 0;
  const arrays = [new Array(1), [constant(true), , constant(false)], Object.assign([constant(true)], { extra: 1 })];
  const inherited = [constant(true)]; Object.setPrototypeOf(inherited, null); arrays.push(inherited);
  const hidden = [constant(true)]; Object.defineProperty(hidden, '0', { value: constant(true), enumerable: false });
  arrays.push(hidden);
  const getter = [constant(true)]; Object.defineProperty(getter, '0', {
    enumerable: true, get() { calls++; throw new Error('not called'); },
  }); arrays.push(getter);
  // Keep the own-key count deceptively dense while replacing a real index.
  for (const key of ['x', '01', '-1', '4294967295', Symbol('0')]) {
    const value = new Array(1); value[key] = constant(true); arrays.push(value);
  }
  for (const conditions of arrays) {
    invalidPredicate({ kind: 'all', conditions });
    invalidPredicate({ kind: 'any', conditions });
  }
  assert.equal(calls, 0);
});

test('cyclic predicate/value graphs are rejected but shared subtrees and long finite logical descriptions remain valid', () => {
  const self = not(null); self.condition = self;
  const logic = all(constant(true)); logic.conditions.push(logic);
  const mixed = compare(null); mixed.left = choose(mixed, literal(1), literal(0));
  for (const predicate of [self, logic, mixed]) invalidPredicate(predicate);
  const leaf = compare(literal(2), 'lt', literal(3));
  assert.equal(evaluateBattlePredicate(all(leaf, leaf, not(not(leaf)))), true);
  assert.equal(validate(all(leaf, leaf)), true);
  assert.equal(evaluateBattlePredicate(all(...Array.from({ length: 64 }, () => leaf))), true);
  let nested = constant(true);
  for (let i = 0; i < 128; i++) nested = not(nested);
  assert.equal(evaluateBattlePredicate(nested), true);
});

test('queried Value facts reject invalid/missing numbers, null holders and unknown Prize states rather than defaulting', () => {
  for (const value of [undefined, null, false, '0', 0.1, NaN, Infinity, -Infinity, 1n,
    Number.MAX_SAFE_INTEGER + 1, new Number(0)]) {
    const context = facts(); context.pokemon.self.damageCounters = value;
    invalid(() => evaluateBattlePredicate(compare(pokemon('self', 'damageCounters')), context));
  }
  const context = facts(); context.pokemon.self.damageCounters = -1;
  invalid(() => evaluateBattlePredicate(compare(pokemon('self', 'damageCounters')), context));
  invalid(() => evaluateBattlePredicate(compare(pokemon('target', 'remainingHp')), context));
  for (const result of [null, {}, { status: 'unknown', count: 0 }, { status: 'resolved', count: null },
    { status: 'resolved', count: false }, { status: 'resolved', count: -1 }]) {
    const current = facts(); current.prizes.own = result;
    invalid(() => evaluateBattlePredicate(compare(prizes()), current));
  }
  for (const field of ['pokemon', 'prizes']) {
    const current = facts(); delete current[field];
    invalid(() => evaluateBattlePredicate(field === 'pokemon' ? exists() : compare(prizes()), current));
  }
});

test('assertion and repeated evaluation do not mutate, freeze, normalize, replace or consume any AST/fact input', () => {
  const context = facts(), predicate = all(exists(), not(exists('target')),
    compare(choose(compare(prizes(), 'gt', literal(0)), pokemon('self', 'remainingHp'), literal(0)),
      'eq', literal(100)));
  const before = clone({ predicate, context });
  assert.equal(Object.isFrozen(predicate), false); assert.equal(Object.isFrozen(context), false);
  assert.equal(assertBattlePredicate(predicate), predicate);
  assert.equal(evaluateBattlePredicate(predicate, context), true);
  assert.equal(Object.isFrozen(predicate), false); assert.equal(Object.isFrozen(context), false);
  assert.deepEqual({ predicate, context }, before);
  freeze(predicate); freeze(context);
  assert.equal(evaluateBattlePredicate(predicate, context), true);
  assert.equal(evaluateBattlePredicate(JSON.parse(JSON.stringify(predicate)), JSON.parse(JSON.stringify(context))), true);
  assert.deepEqual({ predicate, context }, before);
});
