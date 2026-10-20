import test from 'node:test';
import assert from 'node:assert/strict';
import jsonEqual from '../../public/rules/json-equal.js';
import { queryPrizesTaken } from '../../public/rules/prize-count.js';
import { validatePrizeCountResult } from '../../public/rules/schema-validators.js';

// Infrastructure tests, not Pokémon-rule/card approval. The equality oracle
// below serializes ONLY the explicitly constructed, finite, acyclic JSON corpus.
// It shares no comparison/descriptor/cycle code with jsonEqual and is never
// applied to hostile values (especially getters, toJSON, proxies or cycles).
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
}

function descriptorCopyNull(value) {
  if (value === null || typeof value !== 'object') return value;
  const result = Array.isArray(value) ? [] : Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.equal(typeof key, 'string');
    assert(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    Object.defineProperty(result, key, {
      value: descriptorCopyNull(descriptor.value), enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function unchangedInputs(...roots) {
  const visited = new Set(), saved = [];
  const remember = (value) => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    saved.push({ value, descriptors, prototype: Object.getPrototypeOf(value), extensible: Object.isExtensible(value) });
    for (const descriptor of Object.values(descriptors))
      if (Object.hasOwn(descriptor, 'value')) remember(descriptor.value);
  };
  roots.forEach(remember);
  return () => {
    for (const { value, descriptors, prototype, extensible } of saved) {
      assert.equal(Object.getPrototypeOf(value), prototype);
      assert.equal(Object.isExtensible(value), extensible);
      assert.deepEqual(Object.getOwnPropertyDescriptors(value), descriptors);
    }
  };
}

function rejected(value, counterpart = value) {
  assert.equal(jsonEqual(value, counterpart), false);
  assert.equal(jsonEqual(counterpart, value), false);
  assert.equal(jsonEqual(value, value), false, 'Identity alone cannot approve a non-JSON value.');
}

test('bounded independent JSON serialization oracle covers nested values, key order and null-prototype equivalents', () => {
  const corpus = [
    null, false, true, '', '水\\u0000"', 0, -0, 1, -1, 0.5,
    [], {}, [null, 1], { a: 1 }, { a: [1], b: null }, { b: null, a: [1] },
    { array: [false, { x: 'x' }], nested: { n: 2 } },
  ];
  const encoded = corpus.map(canonicalJSON);
  for (const [i, a] of corpus.entries()) for (const [j, b] of corpus.entries()) {
    const expected = encoded[i] === encoded[j];
    assert.equal(jsonEqual(a, b), expected, `${encoded[i]} vs ${encoded[j]}`);
    assert.equal(jsonEqual(descriptorCopyNull(a), b), expected);
    assert.equal(jsonEqual(a, descriptorCopyNull(b)), expected);
  }
});

test('finite JSON numbers compare exactly, including signed zero, small fractions and very large finite values', () => {
  for (const number of [Number.MIN_VALUE, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1, -1e250, Math.PI])
    assert.equal(jsonEqual(number, number), true);
  assert.equal(jsonEqual(-0, 0), true);
  for (const [a, b] of [[0, Number.MIN_VALUE], [1, 1.0000000000000002], [1e200, -1e200]])
    assert.equal(jsonEqual(a, b), false);
});

test('no scalar coercion occurs between null, booleans, numbers, strings, arrays and records', () => {
  for (const [a, b] of [[null, 0], [false, 0], [true, 1], [1, '1'], ['', []], [{}, []], [[], {}]]) {
    assert.equal(jsonEqual(a, b), false); assert.equal(jsonEqual(b, a), false);
  }
});

test('nested plain/null records and reordered own keys describe the same JSON value', () => {
  const a = { first: { x: 1, y: [null, { z: true }] }, second: 2 };
  const b = descriptorCopyNull({ second: 2, first: { y: [null, { z: true }], x: 1 } });
  const check = unchangedInputs(a, b);
  assert.equal(jsonEqual(a, b), true); assert.equal(jsonEqual(b, a), true);
  check();
});

test('constructor, valueOf, toString, toJSON and __proto__ are ordinary own JSON data keys, never methods to invoke', () => {
  const a = { constructor: { n: 1 }, valueOf: 0, toString: 'text', toJSON: null };
  Object.defineProperty(a, '__proto__', { value: ['own data'], enumerable: true });
  const b = descriptorCopyNull(a), check = unchangedInputs(a, b);
  assert.equal(jsonEqual(a, b), true); assert.equal(jsonEqual(b, a), true);
  assert.equal(canonicalJSON(a), canonicalJSON(b));
  check();
});

test('frozen/nonwritable/nonconfigurable data remains JSON; equality neither freezes nor rewrites operands', () => {
  const a = Object.freeze({ array: Object.freeze([Object.freeze({ n: 1 })]) });
  const b = descriptorCopyNull(a), check = unchangedInputs(a, b);
  assert.equal(jsonEqual(a, b), true);
  assert.equal(Object.isFrozen(b), false);
  assert.equal(Object.isFrozen(b.array), false);
  check();
});

test('sibling/shared-subtree aliases are not cycles, do not affect equality, and retain caller identities', () => {
  const shared = { leaf: [1, 2] }, a = { left: shared, right: shared };
  const b = { right: { leaf: [1, 2] }, left: shared }, check = unchangedInputs(a, b);
  assert.equal(jsonEqual(a, b), true);
  assert.equal(jsonEqual([shared, shared], [{ leaf: [1, 2] }, shared]), true);
  assert.equal(a.left, a.right); assert.equal(a.left, b.left);
  b.right.leaf[1] = 3;
  assert.equal(jsonEqual(a, b), false);
  b.right.leaf[1] = 2;
  check();
});

test('nested inequality, object-key absence and array order/length remain observable without input mutation', () => {
  for (const [a, b] of [
    [{ a: 1 }, { b: 1 }], [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: { b: 1 } }, { a: { b: 2 } }], [[1, 2], [2, 1]], [[1], [1, 2]],
  ]) {
    const check = unchangedInputs(a, b);
    assert.equal(jsonEqual(a, b), false); assert.equal(jsonEqual(b, a), false);
    check();
  }
});

test('non-JSON primitive/function values reject at roots and nested positions, even when identical', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, 0n, 1n, Symbol('x'), () => 1, function f() {}]) {
    rejected(value);
    rejected(value, {});
    rejected({ value });
    rejected([value]);
  }
});

test('class instances, boxed primitives and built-in collections are not plain JSON records', () => {
  class Record { constructor() { this.x = 1; } }
  for (const value of [
    new Record(), new Number(1), new String('x'), new Boolean(false), new Date(0), /x/,
    new Map([['x', 1]]), new Set([1]), new WeakMap(), new WeakSet(), new Error('x'),
    new Uint8Array([1]), new ArrayBuffer(1), Promise.resolve(1),
  ]) {
    rejected(value); rejected(value, {}); rejected({ value });
  }
});

test('inherited defaults and custom record prototypes are not silently normalized into JSON', () => {
  rejected(Object.create({ x: 1 }), { x: 1 });
  rejected(Object.assign(Object.create({ inherited: true }), { x: 1 }), { x: 1 });
  rejected(Object.create(Array.prototype), []);
});

test('array subclasses and null/custom array prototypes reject; plain records cannot masquerade as arrays', () => {
  class List extends Array {}
  rejected(new List(1, 2), [1, 2]);
  rejected(Object.setPrototypeOf([1], null), [1]);
  rejected(Object.setPrototypeOf([1], {}), [1]);
  assert.equal(jsonEqual({ 0: 1, length: 1 }, [1]), false);
  assert.equal(jsonEqual([1], { 0: 1, length: 1 }), false);
});

test('sparse arrays reject even when their holes/lengths are identical', () => {
  rejected(new Array(1));
  rejected([1, , 3]);
  rejected(Object.assign(new Array(2), { 0: 1 }), [1]);
});

test('an extra key cannot compensate for a missing array index or authorize missing descriptors on either side', () => {
  const counterfeit = new Array(1); counterfeit.extra = 1;
  rejected(counterfeit, [1]);
  const misleadingIndex = new Array(1); misleadingIndex['01'] = 1;
  rejected(misleadingIndex, [1]);
});

test('enumerable or hidden extra array properties, including symbols, are non-JSON', () => {
  for (const key of ['extra', 'constructor', Symbol('extra')]) for (const enumerable of [false, true]) {
    const value = [1];
    Object.defineProperty(value, key, { value: 1, enumerable });
    rejected(value, [1]);
  }
});

test('hidden record data rejects on either side rather than disappearing from the comparison', () => {
  const hidden = { x: 1 };
  Object.defineProperty(hidden, 'x', { value: 1, enumerable: false });
  rejected(hidden, { x: 1 });
  const extra = {};
  Object.defineProperty(extra, 'hidden', { value: null });
  rejected(extra, {});
});

test('symbol record keys reject regardless of enumerability or symbol identity', () => {
  for (const enumerable of [false, true]) {
    const value = {};
    Object.defineProperty(value, Symbol.for('json-equality-test'), { value: 1, enumerable });
    rejected(value);
  }
});

test('object accessors, including constructor and toJSON getters, execute zero reads or writes', () => {
  let reads = 0, writes = 0;
  for (const key of ['x', 'constructor', 'valueOf', 'toString', 'toJSON']) for (const enumerable of [false, true]) {
    const value = {};
    Object.defineProperty(value, key, {
      enumerable, get() { reads++; throw new Error('getter must not run'); },
      set() { writes++; throw new Error('setter must not run'); },
    });
    rejected(value);
    rejected(value, { [key]: 1 });
  }
  const setterOnly = {};
  Object.defineProperty(setterOnly, 'x', { enumerable: true, set() { writes++; } });
  rejected(setterOnly, { x: 1 });
  assert.equal(reads, 0); assert.equal(writes, 0);
});

test('array index getters/setters and hidden indexes execute zero reads or writes on either operand', () => {
  let reads = 0, writes = 0;
  for (const enumerable of [false, true]) {
    const value = [1];
    Object.defineProperty(value, '0', {
      enumerable, get() { reads++; throw new Error('array getter must not run'); }, set() { writes++; },
    });
    rejected(value, [1]);
  }
  const setterOnly = [1];
  Object.defineProperty(setterOnly, '0', { enumerable: true, set() { writes++; } });
  rejected(setterOnly, [1]);
  const hidden = [1];
  Object.defineProperty(hidden, '0', { value: 1, enumerable: false });
  rejected(hidden, [1]);
  assert.equal(reads, 0); assert.equal(writes, 0);
});

test('own toJSON/valueOf/toString functions and function-valued constructor are rejected without calling them', () => {
  let calls = 0;
  for (const key of ['toJSON', 'valueOf', 'toString', 'constructor']) {
    const value = { [key]() { calls++; throw new Error('conversion must not run'); } };
    rejected(value);
    rejected(value, {});
  }
  assert.equal(calls, 0);
});

for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
  test(`reflection failure in ${trap} returns false instead of escaping`, () => {
    const value = new Proxy({ x: 1 }, { [trap]() { throw new Error(`failed ${trap}`); } });
    rejected(value, { x: 1 });
  });
}

test('advertised object keys without descriptors are rejected on either side and do not escape the public gate', () => {
  const value = new Proxy({}, {
    ownKeys: () => ['x'], getOwnPropertyDescriptor: () => undefined,
  });
  rejected(value, { x: 1 });
});

test('revoked object and array proxies return false, including identical operands and nested references', () => {
  for (const target of [{ x: 1 }, [1]]) {
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    rejected(proxy); rejected(proxy, {}); rejected([proxy]);
  }
});

test('left/right ancestor cycles and direct/indirect array cycles are invalid, not sibling aliases', () => {
  const cyclic = {}; cyclic.self = cyclic;
  rejected(cyclic);
  rejected(cyclic, { self: {} });
  const array = []; array.push(array);
  rejected(array); rejected(array, [[]]);
  const indirect = { child: [] }; indirect.child.push(indirect);
  rejected(indirect); rejected(indirect, { child: [{}] });
});

test('real generated Prize-count source const accepts original and descriptor-copied null-prototype results', () => {
  for (const [matchMode, remainingPrizes] of [['normal', 4], ['normal', 7], ['tiebreak', 1], ['tiebreak', 7]]) {
    const result = queryPrizesTaken({
      ruleset: { region: 'CN', version: 'V20261019' }, deckSize: 60, matchMode, remainingPrizes,
    });
    const normal = JSON.parse(JSON.stringify(result)), nullProto = descriptorCopyNull(result);
    const check = unchangedInputs(result, normal, nullProto);
    assert.equal(Object.getPrototypeOf(nullProto), null);
    assert.equal(Object.getPrototypeOf(nullProto.sourceOfTruth[0]), null);
    assert.equal(Object.getPrototypeOf(nullProto.sourceOfTruth[0].pdfPages), Array.prototype);
    assert.equal(canonicalJSON(normal), canonicalJSON(nullProto));
    assert.equal(validatePrizeCountResult(result), true);
    assert.equal(validatePrizeCountResult(normal), true);
    assert.equal(validatePrizeCountResult(nullProto), true,
      'The generated const/enum helper must not compare constructors and reject this identical JSON source.');
    check();
  }
});

test('the generated const remains exact: altered/missing/extra source fields and changed PDF pages reject for either record prototype', () => {
  const result = queryPrizesTaken({
    ruleset: { region: 'CN', version: 'V20261019' }, deckSize: 60, matchMode: 'normal', remainingPrizes: 4,
  });
  for (const mutate of [
    (source) => { source.documentId = 'CN-unreviewed'; },
    (source) => { source.section = 'II.D-18'; },
    (source) => { source.pdfPages = [51, 50]; },
    (source) => { source.pdfPages[0] = 49; },
    (source) => { delete source.section; },
    (source) => { source.extra = true; },
  ]) for (const copy of [(v) => JSON.parse(JSON.stringify(v)), descriptorCopyNull]) {
    const altered = copy(result);
    mutate(altered.sourceOfTruth[0]);
    assert.equal(validatePrizeCountResult(altered), false, 'Null-prototype support must not weaken source const.');
  }
  assert.equal(validatePrizeCountResult(result), true);
});

test('descriptor copying is detached and equality/generated validation do not mutate or freeze either input graph', () => {
  const result = queryPrizesTaken({
    ruleset: { region: 'CN', version: 'V20261019' }, deckSize: 60, matchMode: 'normal', remainingPrizes: 4,
  });
  const copy = descriptorCopyNull(result), check = unchangedInputs(result, copy);
  assert.notEqual(copy, result);
  assert.notEqual(copy.sourceOfTruth, result.sourceOfTruth);
  assert.notEqual(copy.sourceOfTruth[0], result.sourceOfTruth[0]);
  assert.notEqual(copy.sourceOfTruth[0].pdfPages, result.sourceOfTruth[0].pdfPages);
  assert.equal(jsonEqual(copy, result), true);
  assert.equal(validatePrizeCountResult(copy), true);
  check();
  copy.sourceOfTruth[0].section = 'changed detached copy';
  assert.equal(result.sourceOfTruth[0].section, 'II.D-17');
  assert.equal(jsonEqual(copy, result), false);
  assert.equal(Object.isFrozen(copy), false);
});
