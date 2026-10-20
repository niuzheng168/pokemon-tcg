// Synthetic Boolean sources only: no real card/catalog approval or RNG binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  DamageCoinError, DAMAGE_COIN_RULE_IDS, DAMAGE_COIN_SOURCES,
  assertDamageCoinSpec, rollDamageCoin, assertDamageCoinReceipt,
} from '../../public/rules/damage-coins.js';
import { randomUint32 } from '../../public/rules/random.js';

const fixed = (count) => ({ kind: 'fixed', count });
const until = () => ({ kind: 'untilTails' });
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
    assert(error instanceof DamageCoinError);
    assert.equal(error.name, 'DamageCoinError');
    assert.equal(error.ruleId, 'damage.coins');
    if (code) assert.equal(error.code, code);
    return true;
  });
}
const schema = JSON.parse(await readFile(new URL('../../schemas/damage-coins.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
const schemaSpec = ajv.getSchema(schema.$id);
const schemaReceipt = ajv.getSchema(`${schema.$id}#/$defs/receipt`);

// Independent oracle: derive counts by bit population / first-zero position,
// not the implementation's outcome scan or running heads/tails counters.
function popcount(mask) {
  let count = 0;
  for (let bits = mask; bits; bits &= bits - 1) count++;
  return count;
}
function fixedOracle(count, mask) {
  const heads = popcount(mask);
  return {
    spec: fixed(count),
    results: Array.from({ length: count }, (_v, i) => mask & (1 << i) ? 'heads' : 'tails'),
    heads, tails: count - heads, flips: count,
  };
}
function untilOracle(mask) {
  let firstZero = 0;
  while (mask & (1 << firstZero)) firstZero++;
  return {
    spec: until(), results: [...Array(firstZero).fill('heads'), 'tails'],
    heads: firstZero, tails: 1, flips: firstZero + 1,
  };
}
function streamSource(stream) {
  let calls = 0;
  return {
    flip() {
      assert(calls < stream.length, 'The helper consumed a flip after the exact stopping point.');
      return stream[calls++];
    },
    calls: () => calls,
  };
}
function receiptFor(spec, results) {
  const heads = results.reduce((count, outcome) => count + Number(outcome === 'heads'), 0);
  return { spec: clone(spec), results, heads, tails: results.length - heads, flips: results.length };
}

test('spec/receipt schema and source references pin CN B-01 p19 and B-02 p20, separate from failure checks', () => {
  assert.equal(schema.$id, 'urn:pokemon-tcg:damage-coins:1.0.0');
  assert.equal(schema.$ref, '#/$defs/spec');
  assert.deepEqual(DAMAGE_COIN_RULE_IDS, ['damage.coins']);
  assert.deepEqual(DAMAGE_COIN_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.B-01', pdfPages: [19] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.B-02', pdfPages: [20] },
  ]);
  assert(Object.isFrozen(DAMAGE_COIN_RULE_IDS));
  assert(Object.isFrozen(DAMAGE_COIN_SOURCES));
  for (const source of DAMAGE_COIN_SOURCES) {
    assert(Object.isFrozen(source));
    assert(Object.isFrozen(source.pdfPages));
  }
  assert.match(schema.$comment, /II\.B-01.*19.*II\.B-02.*20/);
  assert.deepEqual(Object.keys(schema.$defs.receipt.properties).sort(), ['flips', 'heads', 'results', 'spec', 'tails']);
});

test('strict specs accept zero, safe boundaries and explicit untilTails without defaults, caps or mutation', () => {
  for (const spec of [fixed(-0), fixed(0), fixed(1), fixed(20), fixed(21), fixed(256),
    fixed(Number.MAX_SAFE_INTEGER), until()]) {
    freeze(spec);
    const before = clone(spec);
    assert.equal(schemaSpec(spec), true);
    assert.equal(assertDamageCoinSpec(spec), spec);
    assert.deepEqual(spec, before);
  }
  for (const spec of [fixed(0), until()]) {
    const nullProto = Object.assign(Object.create(null), spec);
    assert.equal(schemaSpec(nullProto), true);
    assert.equal(assertDamageCoinSpec(nullProto), nullProto);
    const result = rollDamageCoin(nullProto, () => false);
    assert.deepEqual(result.spec, spec);
    assert.notEqual(result.spec, nullProto);
    assert.equal(assertDamageCoinReceipt(nullProto, result), result);
  }
});

test('fixed zero calls no RNG and returns a detached exact zero receipt, unlike an untilTails first tails', () => {
  const spec = freeze(fixed(0));
  let calls = 0;
  const result = rollDamageCoin(spec, () => { calls++; throw new Error('fixed zero must not flip'); });
  assert.deepEqual(result, { spec: fixed(0), results: [], heads: 0, tails: 0, flips: 0 });
  assert.equal(calls, 0);
  assert.notEqual(result.spec, spec);
  assert.equal(schemaReceipt(result), true);
  assert.equal(assertDamageCoinReceipt(spec, result), result);
  const immediate = rollDamageCoin(until(), () => { calls++; return false; });
  assert.deepEqual(immediate, { spec: until(), results: ['tails'], heads: 0, tails: 1, flips: 1 });
  assert.equal(calls, 1);
  assert(!Object.hasOwn(result, 'passed'));
  assert(!Object.hasOwn(immediate, 'passed'));
});

test('complete bit oracle enumerates all 8,191 fixed outcome words of lengths zero through twelve', (t) => {
  let checked = 0;
  for (let count = 0; count <= 12; count++) {
    for (let mask = 0; mask < 2 ** count; mask++) {
      const spec = freeze(fixed(count)), before = clone(spec);
      const stream = freeze(Array.from({ length: count }, (_v, i) => Boolean(mask & (1 << i))));
      const source = streamSource(stream), expected = fixedOracle(count, mask);
      const actual = rollDamageCoin(spec, source.flip);
      assert.deepEqual(actual, expected);
      assert.equal(source.calls(), count);
      assert.equal(schemaReceipt(actual), true);
      const saved = freeze(clone(expected)), savedBefore = clone(saved);
      assert.equal(assertDamageCoinReceipt(spec, saved), saved);
      assert.deepEqual(saved, savedBefore);
      assert.deepEqual(spec, before);
      assert.notEqual(actual.spec, spec);
      checked++;
    }
  }
  assert.equal(checked, 8_191);
  t.diagnostic(`${checked} complete fixed bit words; independent population-count oracle.`);
});

test('complete first-zero oracle enumerates all 4,096 twelve-bit sources and ignores every post-tail suffix', (t) => {
  let checked = 0;
  for (let mask = 0; mask < 2 ** 12; mask++) {
    const stream = freeze([...Array.from({ length: 12 }, (_v, i) => Boolean(mask & (1 << i))), false]);
    const source = streamSource(stream), spec = freeze(until()), expected = untilOracle(mask);
    const actual = rollDamageCoin(spec, source.flip);
    assert.deepEqual(actual, expected);
    assert.equal(source.calls(), expected.flips);
    assert.equal(schemaReceipt(actual), true);
    const saved = freeze(clone(expected));
    assert.equal(assertDamageCoinReceipt(spec, saved), saved);
    assert.deepEqual(saved, expected);
    checked++;
  }
  assert.equal(checked, 4_096);
  t.diagnostic(`${checked} complete twelve-bit sources + a final sentinel tails; no post-tail consumption.`);
});

test('neither mode has a twenty-flip cap; large valid counts are not rejected by an invented limit', () => {
  const spec = freeze(until()), stream = freeze([...Array(512).fill(true), false, true]);
  const source = streamSource(stream), actual = rollDamageCoin(spec, source.flip);
  assert.equal(source.calls(), 513);
  assert.equal(actual.heads, 512);
  assert.equal(actual.tails, 1);
  assert.equal(actual.flips, 513);
  assert.equal(assertDamageCoinReceipt(spec, actual), actual);
  const fixedSource = streamSource(Array.from({ length: 2048 }, (_v, i) => i % 2 === 0));
  const fixedResult = rollDamageCoin(fixed(2048), fixedSource.flip);
  assert.equal(fixedSource.calls(), 2048);
  assert.equal(fixedResult.heads, 1024);
  assert.equal(fixedResult.tails, 1024);
  assert.equal(assertDamageCoinReceipt(fixed(2048), fixedResult), fixedResult);
  const sentinel = new Error('Abort an impractically large caller-requested roll, not a helper count cap.');
  let calls = 0;
  assert.throws(() => rollDamageCoin(fixed(Number.MAX_SAFE_INTEGER), () => { calls++; throw sentinel; }),
    (error) => error === sentinel);
  assert.equal(calls, 1);
});

test('all 511 short saved outcome words enforce exact fixed length or the first-and-only terminal tails', (t) => {
  let checked = 0;
  for (let length = 0; length <= 8; length++) for (let mask = 0; mask < 2 ** length; mask++) {
    const word = fixedOracle(length, mask).results;
    for (let requested = 0; requested <= 8; requested++) {
      const spec = fixed(requested), saved = freeze(receiptFor(spec, [...word]));
      if (length === requested) assert.equal(assertDamageCoinReceipt(spec, saved), saved);
      else rejects(() => assertDamageCoinReceipt(spec, saved), 'invalid-damage-coin-receipt');
    }
    const saved = freeze(receiptFor(until(), [...word]));
    // Independent bit identity: a legal untilTails word is (length−1) heads
    // followed by tails. No filtering/scanning or stopping logic from production.
    const legal = length > 0 && mask === 2 ** (length - 1) - 1;
    if (legal) assert.equal(assertDamageCoinReceipt(until(), saved), saved);
    else rejects(() => assertDamageCoinReceipt(until(), saved), 'invalid-damage-coin-receipt');
    checked++;
  }
  assert.equal(checked, 511);
  t.diagnostic(`${checked} words × ten requested stopping policies, including empty/late/extra tails.`);
});

test('saved counts are recomputed independently: every wrong heads/tails/flips tuple is rejected', () => {
  const spec = fixed(3);
  let accepted = 0;
  for (let heads = 0; heads <= 4; heads++) for (let tails = 0; tails <= 4; tails++)
    for (let flips = 0; flips <= 4; flips++) {
      const saved = freeze({ spec: fixed(3), results: ['heads', 'tails', 'heads'], heads, tails, flips });
      if (heads === 2 && tails === 1 && flips === 3) {
        assert.equal(assertDamageCoinReceipt(spec, saved), saved);
        accepted++;
      } else rejects(() => assertDamageCoinReceipt(spec, saved), 'invalid-damage-coin-receipt');
    }
  assert.equal(accepted, 1);
  for (const key of ['heads', 'tails', 'flips']) for (const value of [-1, 0.5, '1', false, null,
    undefined, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 1n, new Number(1)]) {
    const saved = { ...receiptFor(spec, ['heads', 'tails', 'heads']), [key]: value };
    rejects(() => assertDamageCoinReceipt(spec, saved), 'invalid-damage-coin-receipt');
  }
  for (const key of ['heads', 'tails', 'flips']) {
    const saved = { ...receiptFor(spec, ['heads', 'tails', 'heads']), [key]: Number.MAX_SAFE_INTEGER };
    assert.equal(schemaReceipt(saved), true, 'Shape does not prove the saved arithmetic.');
    rejects(() => assertDamageCoinReceipt(spec, saved), 'invalid-damage-coin-receipt');
  }
});

test('saved specs must equal the requested exact spec, not merely have matching outcome totals', () => {
  for (const [expected, saved] of [
    [fixed(1), receiptFor(fixed(2), ['heads', 'tails'])],
    [fixed(1), receiptFor(until(), ['tails'])],
    [until(), receiptFor(fixed(1), ['tails'])],
    [fixed(0), receiptFor(fixed(1), ['heads'])],
  ]) {
    assert.equal(schemaReceipt(saved), true);
    rejects(() => assertDamageCoinReceipt(expected, saved), 'invalid-damage-coin-receipt');
  }
  for (const spec of [null, {}, { kind: 'fixed' }, { ...until(), count: 1 }, { ...fixed(1), approved: true }])
    rejects(() => assertDamageCoinReceipt(fixed(1), { ...receiptFor(fixed(1), ['heads']), spec }));
  const receipt = receiptFor(fixed(1), ['heads']);
  const nullProto = Object.assign(Object.create(null), receipt);
  nullProto.spec = Object.assign(Object.create(null), receipt.spec);
  assert.equal(assertDamageCoinReceipt(fixed(1), nullProto), nullProto);
});

test('the helper uses only host Boolean flips, never coercion, its own RNG, retries or swallowed source errors', () => {
  for (const source of [undefined, null, false, 1, 'flip', {}, []])
    rejects(() => rollDamageCoin(fixed(0), source), 'invalid-damage-coin-source');
  let calls = 0;
  const poisoned = Object.defineProperty({}, Symbol.toPrimitive, {
    get() { calls++; throw new Error('must not coerce callback output'); },
  });
  for (const value of [undefined, null, 0, 1, 'heads', 'tails', 'true', [], {}, new Boolean(true),
    1n, Symbol('heads'), () => true, Promise.resolve(true), poisoned]) {
    let flips = 0;
    rejects(() => rollDamageCoin(fixed(1), () => { flips++; return value; }), 'invalid-damage-coin-source');
    assert.equal(flips, 1);
  }
  assert.equal(calls, 0);
  const sentinel = new Error('host RNG failure');
  let flips = 0;
  assert.throws(() => rollDamageCoin(until(), () => {
    if (flips++ === 40) throw sentinel;
    return true;
  }), (error) => error === sentinel);
  assert.equal(flips, 41);
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('No internal randomness is permitted.'); };
  try {
    assert.deepEqual(rollDamageCoin(fixed(2), streamSource([true, false]).flip),
      fixedOracle(2, 1));
  } finally { Math.random = originalRandom; }
});

test('roll snapshots the spec before callbacks and returns independent mutable data without changing or freezing input', () => {
  const spec = fixed(3), before = clone(spec);
  const actual = rollDamageCoin(spec, streamSource([true, false, true]).flip);
  assert.deepEqual(spec, before);
  assert(!Object.isFrozen(spec));
  assert(!Object.isFrozen(actual));
  assert(!Object.isFrozen(actual.spec));
  assert(!Object.isFrozen(actual.results));
  actual.spec.count = 99; actual.results[0] = 'tails';
  assert.deepEqual(spec, before);

  const callbackMutated = fixed(3);
  let calls = 0;
  const locked = rollDamageCoin(callbackMutated, () => {
    calls++;
    // This is the external callback's mutation, NOT a permitted helper write.
    callbackMutated.kind = 'untilTails';
    delete callbackMutated.count;
    return false;
  });
  assert.equal(calls, 3);
  assert.deepEqual(locked, { spec: fixed(3), results: ['tails', 'tails', 'tails'], heads: 0, tails: 3, flips: 3 });
  const untilMutated = until();
  calls = 0;
  const stillUntil = rollDamageCoin(untilMutated, () => {
    untilMutated.kind = 'fixed'; untilMutated.count = 0;
    return ++calls < 3;
  });
  assert.deepEqual(stillUntil, { spec: until(), results: ['heads', 'heads', 'tails'], heads: 2, tails: 1, flips: 3 });
});

test('saved receipt validation never consumes actual host RNG, normalizes state, freezes input or appends metadata', () => {
  const actualRng = [1, 2, 3, 4], spec = fixed(24);
  let calls = 0;
  const result = rollDamageCoin(spec, () => { calls++; return Boolean(randomUint32(actualRng) & 1); });
  const rngAfterRoll = clone(actualRng), saved = JSON.parse(JSON.stringify(result)), before = clone(saved);
  for (let i = 0; i < 20; i++) assert.equal(assertDamageCoinReceipt(spec, saved), saved);
  assert.equal(calls, 24);
  assert.deepEqual(actualRng, rngAfterRoll);
  assert.deepEqual(saved, before);
  assert(!Object.isFrozen(saved));
  assert(!Object.isFrozen(saved.spec));
  assert(!Object.isFrozen(saved.results));
  assert.deepEqual(Object.keys(saved).sort(), ['flips', 'heads', 'results', 'spec', 'tails']);
});

test('schema and pure specs reject every missing/extra field, count alias, unsafe scalar and unsupported mode', () => {
  const invalid = [
    null, false, true, 0, '', 'fixed', [], {}, { kind: 'fixed' }, { count: 1 },
    { kind: 'untilTails', count: 0 }, { kind: 'untilHeads' }, { kind: 'fixed', count: 1, passed: true },
    { mode: 'fixed', count: 1 }, { kind: 'untilTails', maximum: 20 },
    ...['minimumHeads', 'countExpr', 'plan', 'actor', 'source', 'rng', 'rngBinding', 'cap', 'approved']
      .map((key) => ({ ...fixed(1), [key]: 1 })),
    ...[-1, 0.1, null, false, true, '1', [], {}, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER]
      .map((count) => fixed(count)),
  ];
  for (const spec of invalid) {
    assert.equal(schemaSpec(spec), false);
    rejects(() => assertDamageCoinSpec(spec), 'invalid-damage-coin-spec');
    rejects(() => rollDamageCoin(spec, () => { throw new Error('Invalid spec must not reach RNG.'); }),
      'invalid-damage-coin-spec');
    rejects(() => assertDamageCoinReceipt(spec, null), 'invalid-damage-coin-spec');
  }
  for (const count of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('count'), () => 1, new Number(1)])
    rejects(() => assertDamageCoinSpec(fixed(count)), 'invalid-damage-coin-spec');
});

test('schema receipt shape rejects missing fields, failure-check passed, host metadata and non-normalized saved outcomes', () => {
  const valid = receiptFor(fixed(2), ['heads', 'tails']);
  const invalid = [
    null, false, 0, '', [], {},
    ...Object.keys(valid).map((key) => { const copy = clone(valid); delete copy[key]; return copy; }),
    ...['passed', 'minimumHeads', 'actor', 'plan', 'source', 'rngBinding', 'approved']
      .map((key) => ({ ...clone(valid), [key]: true })),
    ...[null, false, 'heads', {}, ['HEADS'], [true], [0], [[]], [{ outcome: 'heads' }]]
      .map((results) => ({ ...clone(valid), results })),
    ...['heads', 'tails', 'flips'].flatMap((key) =>
      [-1, 0.5, null, false, '2', Number.MAX_SAFE_INTEGER + 1].map((value) => ({ ...clone(valid), [key]: value }))),
  ];
  for (const saved of invalid) {
    assert.equal(schemaReceipt(saved), false);
    rejects(() => assertDamageCoinReceipt(fixed(2), saved));
  }
});

test('plain-data gates reject accessors, hidden/symbol fields, class/prototype cycles and JSON data cycles without execution', () => {
  let calls = 0;
  const specs = [new Date(), new Map(), new Number(1), Object.create(fixed(1)),
    Object.assign(new (class Spec {})(), fixed(1))];
  for (const key of ['kind', 'count', 'unknown']) {
    for (const accessor of ['getter', 'setter', 'hidden']) {
      const spec = fixed(1);
      Object.defineProperty(spec, key, accessor === 'getter' ? {
        enumerable: true, get() { calls++; throw new Error('spec getter'); },
      } : accessor === 'setter' ? {
        enumerable: true, set() { calls++; throw new Error('spec setter'); },
      } : { value: 1, enumerable: false });
      specs.push(spec);
    }
  }
  const symbol = fixed(1); symbol[Symbol('approval')] = true; specs.push(symbol);
  const countCycle = fixed(1); countCycle.count = countCycle; specs.push(countCycle);
  const kindCycle = {}; kindCycle.kind = kindCycle; specs.push(kindCycle);
  const proto = {}, protoCycle = Object.assign(Object.create(proto), fixed(1));
  proto.back = protoCycle; specs.push(protoCycle);
  for (const spec of specs) rejects(() => assertDamageCoinSpec(spec), 'invalid-damage-coin-spec');

  const saved = receiptFor(fixed(1), ['heads']);
  const receipts = [Object.create(saved), Object.assign(new (class Receipt {})(), saved)];
  for (const key of [...Object.keys(saved), 'unknown']) {
    const getter = clone(saved);
    Object.defineProperty(getter, key, { enumerable: true, get() { calls++; throw new Error('receipt getter'); } });
    receipts.push(getter);
    const hidden = clone(saved); Object.defineProperty(hidden, key, { value: 1, enumerable: false });
    receipts.push(hidden);
  }
  const receiptSymbol = clone(saved); receiptSymbol[Symbol('hidden')] = 1; receipts.push(receiptSymbol);
  for (const key of ['spec', 'heads', 'results']) {
    const cycle = clone(saved); cycle[key] = cycle; receipts.push(cycle);
  }
  const arrayCycle = []; arrayCycle.push(arrayCycle); receipts.push({ ...saved, results: arrayCycle });
  for (const receipt of receipts) rejects(() => assertDamageCoinReceipt(fixed(1), receipt));
  assert.equal(calls, 0);
});

test('outcome arrays reject sparse replacements, inherited indices, accessors, symbols and custom prototypes', () => {
  let calls = 0;
  const arrays = [new Array(1), new (class Results extends Array {})('heads'), new Uint8Array([1])];
  const sparseWithExtra = new Array(1); sparseWithExtra.extra = 'heads'; arrays.push(sparseWithExtra);
  const getter = ['heads'];
  Object.defineProperty(getter, '0', { enumerable: true, get() { calls++; throw new Error('index getter'); } });
  arrays.push(getter);
  const hidden = ['heads']; Object.defineProperty(hidden, '0', { value: 'heads', enumerable: false }); arrays.push(hidden);
  const extra = ['heads']; extra.extra = true; arrays.push(extra);
  const symbol = ['heads']; symbol[Symbol('extra')] = true; arrays.push(symbol);
  const inherited = new Array(1), prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, '0', { get() { calls++; throw new Error('inherited index getter'); } });
  Object.setPrototypeOf(inherited, prototype); arrays.push(inherited);
  const nullProto = ['heads']; Object.setPrototypeOf(nullProto, null); arrays.push(nullProto);
  for (const results of arrays)
    rejects(() => assertDamageCoinReceipt(fixed(1), { spec: fixed(1), results, heads: 1, tails: 0, flips: 1 }),
      'invalid-damage-coin-receipt');
  assert.equal(calls, 0);
});

test('missing own kind never invokes an Object.prototype getter, including embedded saved specifications', () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'kind');
  let calls = 0, directError, savedError, rollError;
  Object.defineProperty(Object.prototype, 'kind', {
    configurable: true, get() { calls++; throw new Error('Do not inherit kind.'); },
  });
  try {
    try { assertDamageCoinSpec({ count: 1 }); } catch (error) { directError = error; }
    try { assertDamageCoinReceipt(fixed(1), { spec: {}, results: ['heads'], heads: 1, tails: 0, flips: 1 }); }
    catch (error) { savedError = error; }
    try { rollDamageCoin({}, () => { calls++; return true; }); } catch (error) { rollError = error; }
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'kind', original);
    else delete Object.prototype.kind;
  }
  assert.equal(calls, 0);
  for (const error of [directError, savedError, rollError]) {
    assert(error instanceof DamageCoinError);
    assert.equal(error.code, 'invalid-damage-coin-spec');
  }
});
