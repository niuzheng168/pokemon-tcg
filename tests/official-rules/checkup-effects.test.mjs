import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  CHECKUP_EFFECTS_RULE_IDS, DEFAULT_BURN_COUNTERS, MAX_BURN_COUNTERS,
  assertBurnCountersEffect, validateBurnCountersEffect, resolveBurnCounters,
} from '../../public/rules/checkup-effects.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule, deepFreeze } from '../../public/rules/registry.js';
import { emptyConditions, applyCondition, checkConditions } from '../../public/rules/conditions.js';

// Synthetic evidence only. These tests do not approve actual printed cards.
const EVIDENCE = [{
  sourceId: 'fixture:burn-counts', kind: 'official-card', url: 'https://www.pokemon.cn/',
  locator: 'TEST ONLY: fictitious source, not actual card approval',
}];
const effect = (extra = {}) => ({ op: 'burnCounters', scope: 'opponent', count: 6, ...extra });
const change = (id, count, extra = {}) => ({ id, count, sourceOfTruth: structuredClone(EVIDENCE), ...extra });
const schema = JSON.parse(await readFile(new URL('../../schemas/checkup-effects.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
// The card evidence list lives in card-definition, which refers to the other schemas: load them all.
for (const name of (await readdir(new URL('../../schemas/', import.meta.url))).filter((n) => n.endsWith('.schema.json') && n !== 'checkup-effects.schema.json'))
  ajv.addSchema(JSON.parse(await readFile(new URL(`../../schemas/${name}`, import.meta.url), 'utf8')));
ajv.addSchema(schema);
const schemaEffect = ajv.getSchema(schema.$id);
const schemaChanges = ajv.compile({ $ref: `${schema.$id}#/$defs/changes` });
const clone = (v) => structuredClone(v);

// Independent oracle: select maximal elements by pairwise comparison, not the
// production max fold or a default inserted into a numeric replacement set.
const oracle = (counts) => counts.length === 0 ? 2 :
  counts.find((candidate) => counts.every((other) => candidate >= other));
function* tuples(values, length, prefix = []) {
  if (!length) { yield prefix; return; }
  for (const value of values) yield* tuples(values, length - 1, [...prefix, value]);
}

test('E-28 uses the pinned CN PDF page 68, FAQ maximum semantics, and the existing Burn rule identity', () => {
  assert.deepEqual(CHECKUP_EFFECTS_RULE_IDS, ['status.burn']);
  assert.equal(DEFAULT_BURN_COUNTERS, 2);
  assert.equal(MAX_BURN_COUNTERS, 900719925474099);
  assert(Number.isSafeInteger(MAX_BURN_COUNTERS * 10));
  const rule = requireRule(CN_V20261019, 'status.burn');
  assert(rule.sourceOfTruth.some((s) => s.documentId === 'CN-advanced-3.1.0' &&
    s.section === 'II.E-28' && s.pdfPages.length === 1 && s.pdfPages[0] === 68));
  assert.equal(CN_V20261019.documents.find((d) => d.id === 'CN-advanced-3.1.0').sha256,
    '27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419');
  assert.match(schema.$comment, /II\.E-28.*68/);
  assert.deepEqual(schema.$defs.pokemonType.enum,
    ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless']);
  assert.equal(schema.$defs.counterCount.maximum, MAX_BURN_COUNTERS);
});

test('strict standalone schema and pure descriptor validation agree on all scopes, types and explicit boolean filters', () => {
  for (const scope of ['self', 'own', 'opponent', 'all']) {
    for (const type of ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless']) {
      for (const sourceActive of [true, false]) for (const activeOnly of [true, false]) {
        const spec = effect({ scope, type, sourceActive, activeOnly });
        const before = clone(spec);
        assert.equal(assertBurnCountersEffect(spec), spec);
        assert(validateBurnCountersEffect(spec));
        assert(schemaEffect(spec), JSON.stringify(schemaEffect.errors));
        assert.deepEqual(spec, before);
      }
    }
  }
  assert(validateBurnCountersEffect(effect()));
  const plainNull = Object.assign(Object.create(null), effect({ count: 0 }));
  assert.equal(assertBurnCountersEffect(plainNull), plainNull);
  assert(validateBurnCountersEffect(deepFreeze(effect())));
});

test('a replacement count is bounded counter quantity, including zero, not damage points or a card multiplier', () => {
  for (const count of [0, 1, 2, 4, 6, 11, MAX_BURN_COUNTERS - 1, MAX_BURN_COUNTERS]) {
    assert(schemaEffect(effect({ count })));
    assert(validateBurnCountersEffect(effect({ count })));
    const result = resolveBurnCounters([change('count', count)]);
    assert.equal(result.count, count);
    assert.equal(result.trace[0].unit, 'damageCounters');
  }
  for (const count of [-1, 0.5, '6', null, undefined, NaN, Infinity, -Infinity,
    MAX_BURN_COUNTERS + 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1n]) {
    assert(!validateBurnCountersEffect(effect({ count })));
    assert.throws(() => assertBurnCountersEffect(effect({ count })), TypeError);
    assert.throws(() => resolveBurnCounters([change('bad', count)]), TypeError);
    // BigInt/undefined/nonfinite values are not JSON, and are still rejected
    // by the stricter runtime gate rather than coerced.
    assert(!schemaEffect(effect({ count })));
  }
});

test('unknown properties, statuses, coins, groups and display types cannot enter a Burn-count descriptor', () => {
  const missing = effect(); delete missing.count;
  const invalid = [null, [], true, 'burnCounters', 6, {}, missing,
    effect({ op: 'condition' }), effect({ scope: 'opponentActive' }), effect({ count: null }),
    effect({ type: '火' }), effect({ type: 'Unknown' }), effect({ type: null }),
    effect({ sourceActive: 1 }), effect({ activeOnly: 'true' }),
    effect({ group: 'same-ability' }), effect({ stacking: 'sum' }),
    effect({ burned: true }), effect({ preventBurn: true }), effect({ cureBurn: true }),
    effect({ damage: 60 }), effect({ cardCount: 2 }), effect({ flip: true }),
    effect({ chance: 0.5 }), effect({ duration: 'untilNextOwnTurnEnd' }),
  ];
  for (const spec of invalid) {
    assert(!validateBurnCountersEffect(spec));
    assert.throws(() => assertBurnCountersEffect(spec), TypeError);
    assert(!schemaEffect(spec));
  }
});

test('descriptor validation rejects inherited, hidden, symbol and getter properties without executing imported code', () => {
  let reads = 0;
  const getter = effect();
  Object.defineProperty(getter, 'count', { enumerable: true, get() { reads++; return 6; } });
  const hidden = effect(); Object.defineProperty(hidden, 'count', { value: 6, enumerable: false });
  const symbol = effect(); symbol[Symbol('invisible')] = true;
  const inherited = Object.assign(Object.create({ scope: 'opponent' }), effect());
  const instance = Object.assign(new (class Imported {})(), effect());
  // Explicit undefined is not JSON. AJV treats an optional undefined property
  // as absent, so the pure boundary intentionally adds a stricter data gate.
  for (const spec of [getter, hidden, symbol, inherited, instance, new Map(), () => effect(),
    effect({ sourceActive: undefined }), effect({ type: undefined })]) {
    assert(!validateBurnCountersEffect(spec));
    assert.throws(() => assertBurnCountersEffect(spec), TypeError);
  }
  assert.equal(reads, 0);
});

test('default two is used only for an absent replacement set; explicit zero/one never inherit a floor of two', () => {
  assert.equal(resolveBurnCounters().count, 2);
  assert.equal(resolveBurnCounters([]).count, 2);
  assert.equal(resolveBurnCounters([change('zero', 0)]).count, 0);
  assert.equal(resolveBurnCounters([change('one', 1)]).count, 1);
  const zeroes = resolveBurnCounters([change('a', 0), change('b', 0)]);
  assert.equal(zeroes.count, 0);
  assert.equal(zeroes.trace[0].usedDefault, false);
  assert.deepEqual(zeroes.trace[0].selectedIds, ['a', 'b']);
  const ordinary = resolveBurnCounters([]);
  assert.equal(ordinary.trace[0].usedDefault, true);
  assert.deepEqual(ordinary.trace[0].replacements, []);
  assert.deepEqual(ordinary.trace[0].selectedIds, []);
});

test('E-28 aggregation agrees with an independent exhaustive oracle for 0..5 sources and every small count/order', () => {
  let cases = 0;
  for (let n = 0; n <= 5; n++) for (const counts of tuples([0, 1, 2, 4, 6], n)) {
    const changes = counts.map((count, i) => change(`source:${i}`, count));
    const before = clone(changes);
    const result = resolveBurnCounters(changes);
    assert.equal(result.count, oracle(counts));
    assert.deepEqual(result, resolveBurnCounters([...changes].reverse()));
    assert.deepEqual(result, resolveBurnCounters([...changes.slice(1), ...changes.slice(0, 1)]));
    const selectedIds = changes.filter((c) => counts.every((count) => c.count >= count)).map((c) => c.id).sort();
    assert.deepEqual(result.trace[0].selectedIds, selectedIds);
    assert.deepEqual(changes, before);
    cases++;
  }
  assert.equal(cases, 3906);
});

test('six and four yield six once; equal sources and multiple bindings from one card never multiply counters', () => {
  const six = change('six', 6), four = change('four', 4);
  assert.equal(resolveBurnCounters([six, four]).count, 6);
  assert.equal(resolveBurnCounters([change('copy:1', 6), change('copy:2', 6), change('copy:3', 6)]).count, 6);
  // Distinct binding IDs may have the same card evidence. Identity is not a
  // reason to multiply or silently discard one otherwise applicable change.
  const result = resolveBurnCounters([
    change('[\"binding\", \"same-physical-card\", 0]', 4),
    change('[\"binding\", \"same-physical-card\", 1]', 6),
  ]);
  assert.equal(result.count, 6);
  assert.equal(result.trace[0].replacements.length, 2);
  const many = Array.from({ length: 20000 }, (_, i) => change(`many:${i}`, i === 19999 ? 6 : 4));
  assert.equal(resolveBurnCounters(many).count, 6, 'No sum or argument-spread stack limit.');
});

test('trace includes all considered card evidence, all tied maxima and exact official rule evidence; never picks a timing winner', () => {
  const changes = [change('z', 4), change('b', 6), change('a', 6)];
  const result = resolveBurnCounters(changes), t = result.trace[0];
  assert.equal(t.rulesetId, 'CN/V20261019');
  assert.equal(t.ruleId, 'status.burn');
  assert.equal(t.aggregation, 'maximum');
  assert.deepEqual(t.sourceOfTruth, requireRule(CN_V20261019, 'status.burn').sourceOfTruth);
  assert.deepEqual(t.replacements.map((r) => [r.id, r.count]), [['a', 6], ['b', 6], ['z', 4]]);
  assert.deepEqual(t.selectedIds, ['a', 'b']);
  assert.deepEqual(t.replacements[0].sourceOfTruth, EVIDENCE);
  assert(!Object.hasOwn(t, 'winner'));
});

test('aggregation accepts frozen inputs, never freezes/mutates caller objects, and protects detached trace evidence', () => {
  const input = [change('source', 6)], before = clone(input), result = resolveBurnCounters(input);
  assert.deepEqual(input, before);
  assert(!Object.isFrozen(input));
  assert(!Object.isFrozen(input[0]));
  assert(!Object.isFrozen(input[0].sourceOfTruth));
  input[0].count = 4;
  input[0].sourceOfTruth[0].locator = 'changed after calculation';
  assert.equal(result.count, 6);
  assert.equal(result.trace[0].replacements[0].count, 6);
  assert.equal(result.trace[0].replacements[0].sourceOfTruth[0].locator, EVIDENCE[0].locator);
  assert.throws(() => { result.trace[0].count = 8; }, TypeError);
  assert.throws(() => { result.trace[0].replacements[0].sourceOfTruth[0].locator = 'tampered'; }, TypeError);
  assert.equal(resolveBurnCounters(deepFreeze(before)).count, 6);
});

test('change schema/pure validation reject malformed counts, duplicate identities, extra fields and absent provenance atomically', () => {
  const noCount = change('missing', 6); delete noCount.count;
  const invalid = [
    null, 'changes', {}, [null], [effect()], [noCount],
    [change('', 6)], [change(1, 6)], [change('x', -1)], [change('x', MAX_BURN_COUNTERS + 1)],
    [change('x', 6, { cards: 2 })], [change('x', 6, { sourceOfTruth: [] })],
    [change('x', 6, { sourceOfTruth: null })], [change('x', 6, { sourceOfTruth: [{}] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], sourceId: 1 }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], sourceId: '' }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], sourceId: 'bad ID' }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], sourceId: 'a'.repeat(201) }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], kind: '52poke' }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], url: 'https://wiki.52poke.com/' }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], url: 1 }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], locator: '' }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], locator: 1 }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], textSha256: 'bad' }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], textSha256: 1 }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], observedOn: 'today' }] })],
    [change('x', 6, { sourceOfTruth: [{ ...EVIDENCE[0], observedOn: 1 }] })],
    // A machine-implemented card's library record: its exact fields, a library host and no text digest.
    [change('x', 6, { sourceOfTruth: [{ ...{ sourceId: 'library:TEST/001_010', kind: 'card-library', url: 'https://tcg.mik.moe/cards/TEST/001', locator: 'TEST ONLY: fictitious library record' }, textSha256: 'a'.repeat(64) }] })],
    [change('x', 6, { sourceOfTruth: [{ ...{ sourceId: 'library:TEST/001_010', kind: 'card-library', url: 'https://tcg.mik.moe/cards/TEST/001', locator: 'TEST ONLY: fictitious library record' }, url: 'https://www.pokemon.cn/' }] })],
    [change('x', 6, { sourceOfTruth: [{ ...{ sourceId: 'library:TEST/001_010', kind: 'card-library', url: 'https://tcg.mik.moe/cards/TEST/001', locator: 'TEST ONLY: fictitious library record' }, url: 'https://tcg.mik.moe.evil/' }] })],
  ];
  for (const changes of invalid) {
    const before = clone(changes);
    assert.throws(() => resolveBurnCounters(changes), TypeError);
    assert(!schemaChanges(changes));
    assert.deepEqual(changes, before);
  }
  const duplicate = [change('same', 6), change('same', 4)];
  assert.throws(() => resolveBurnCounters(duplicate), /unique/);
  assert(schemaChanges(duplicate), 'Cross-entry ID uniqueness is an additional runtime invariant, explicitly documented by schema.');
  for (const kind of ['official-card', 'official-erratum', 'official-rule']) {
    const changes = [change('valid', 6, { sourceOfTruth: [{ ...EVIDENCE[0], kind,
      textSha256: 'a'.repeat(64), observedOn: '2026-10-19' }] })];
    assert(schemaChanges(changes));
    assert.equal(resolveBurnCounters(changes).count, 6);
  }
  for (const url of ['https://tcg.mik.moe/cards/TEST/001', 'https://wiki.52poke.com/index.php?curid=1']) {
    const changes = [change('library', 6, { sourceOfTruth: [{ ...{ sourceId: 'library:TEST/001_010', kind: 'card-library', url: 'https://tcg.mik.moe/cards/TEST/001', locator: 'TEST ONLY: fictitious library record' }, url, observedOn: '2026-10-21' }] })];
    assert(schemaChanges(changes));
    assert.equal(resolveBurnCounters(changes).count, 6);
  }
});

test('aggregation rejects sparse/custom arrays, executable/hidden fields and class instances without reading getters', () => {
  let reads = 0;
  const sparse = new Array(1), extra = [change('x', 6)]; extra.metadata = true;
  const disguisedSparse = new Array(1); disguisedSparse.metadata = true;
  const withSymbol = [change('x', 6)]; withSymbol[Symbol('hidden')] = true;
  const accessor = [change('x', 6)];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return change('x', 6); } });
  const hidden = [change('x', 6)]; Object.defineProperty(hidden, '0', { enumerable: false });
  const getter = change('x', 6);
  Object.defineProperty(getter, 'sourceOfTruth', { enumerable: true, get() { reads++; return EVIDENCE; } });
  const hiddenEvidence = clone(EVIDENCE);
  Object.defineProperty(hiddenEvidence[0], 'locator', { enumerable: false });
  const symbolEvidence = clone(EVIDENCE); symbolEvidence[0][Symbol('extra')] = true;
  const customArray = [change('x', 6)]; Object.setPrototypeOf(customArray, null);
  const classChange = Object.assign(new (class Imported {})(), change('x', 6));
  for (const values of [sparse, disguisedSparse, extra, withSymbol, accessor, hidden, [getter], customArray, [classChange],
    [change('x', 6, { sourceOfTruth: hiddenEvidence })], [change('x', 6, { sourceOfTruth: symbolEvidence })]]) {
    assert.throws(() => resolveBurnCounters(values), TypeError);
  }
  assert.equal(reads, 0);
});

test('counter replacement does not apply/prevent/cure Burn, skip its coin or execute a Knock Out', () => {
  // This composes existing pure functions, NOT OfficialGame integration. The
  // shared state machine must still collect/filter live continuous descriptors.
  const fresh = emptyConditions(), burned = applyCondition(fresh, 'burned').conditions;
  const before = clone(burned), rng = { calls: 0 };
  const zero = resolveBurnCounters([change('zero', 0)]), six = resolveBurnCounters([change('six', 6)]);
  assert.deepEqual(burned, before);
  assert.deepEqual(fresh, emptyConditions());
  const afterZero = checkConditions(burned, {
    ownerTurn: 1, ownerIsEndingPlayer: true, step: 'burn',
    burnCounterChanges: [zero.count], flip: () => { rng.calls++; return false; },
  });
  assert.equal(afterZero.counters, 0);
  assert(afterZero.conditions.burned, 'Explicit zero counters is not Burn prevention or recovery.');
  assert.equal(rng.calls, 1, 'Still perform Burn recovery after placing zero counters.');
  const afterSix = checkConditions(burned, {
    ownerTurn: 1, ownerIsEndingPlayer: true, step: 'burn',
    burnCounterChanges: [six.count], flip: () => { rng.calls++; return true; },
  });
  assert.equal(afterSix.counters, 6, 'Place the full count before the recovery result.');
  assert.equal(afterSix.conditions.burned, false);
  assert.equal(rng.calls, 2);
  const unburned = checkConditions(fresh, {
    ownerTurn: 1, ownerIsEndingPlayer: true, step: 'burn',
    burnCounterChanges: [six.count], flip: () => { throw new Error('Unburned Pokémon must not flip.'); },
  });
  assert.equal(unburned.counters, 0);
  assert.equal(unburned.conditions.burned, false);
  assert.deepEqual(burned, before);
  assert.equal(resolveBurnCounters([change('upper', MAX_BURN_COUNTERS)]).count, MAX_BURN_COUNTERS);
  assert(!Object.hasOwn(six, 'winner'));
});
