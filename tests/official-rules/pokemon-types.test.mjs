import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  POKEMON_TYPES_RULE_IDS, POKEMON_TYPES_SOURCES, assertPokemonTypesEffect, resolvePokemonTypes,
} from '../../public/rules/pokemon-types.js';
import { POKEMON_TYPES } from '../../public/rules/damage.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { deepFreeze, requireRule, CN_OFFICIAL_EVIDENCE_URL_PATTERN } from '../../public/rules/registry.js';

const EXPECTED_TYPES = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting',
  'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless'];
// Synthetic evidence only, never approval of the official Hoopa example.
const EVIDENCE = [{
  sourceId: 'fixture:types', kind: 'official-card', url: 'https://www.pokemon.cn/',
  locator: 'TEST ONLY: fictitious card text, not actual official-card approval',
}];
const effect = (extra = {}) => ({ op: 'pokemonTypes', types: ['Psychic', 'Darkness'], scope: 'self', ...extra });
const replacement = (id, types, extra = {}) => ({ id, types, sourceOfTruth: structuredClone(EVIDENCE), ...extra });
const clone = (value) => structuredClone(value);
const schema = JSON.parse(await readFile(new URL('../../schemas/pokemon-types.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
// The card evidence list lives in card-definition, which refers to the other schemas: load them all.
for (const name of (await readdir(new URL('../../schemas/', import.meta.url))).filter((n) => n.endsWith('.schema.json') && n !== 'pokemon-types.schema.json'))
  ajv.addSchema(JSON.parse(await readFile(new URL(`../../schemas/${name}`, import.meta.url), 'utf8')));
ajv.addSchema(schema);
const schemaEffect = ajv.getSchema(schema.$id);
const schemaReplacements = ajv.compile({ $ref: `${schema.$id}#/$defs/replacements` });

function* tuples(values, length, prefix = []) {
  if (!length) { yield prefix; return; }
  for (const value of values) yield* tuples(values, length - 1, [...prefix, value]);
}
// Independent bit-mask oracle. Production uses neither bit arithmetic nor this
// test's independently listed enumeration. A type array denotes one SET.
const mask = (types) => types.reduce((bits, type) => bits | 2 ** EXPECTED_TYPES.indexOf(type), 0);
const fromMask = (bits) => EXPECTED_TYPES.filter((_t, index) => (bits & 2 ** index) !== 0);
const oracle = (printed, replacements) => {
  if (!replacements.length) return { types: [...printed], conflict: false };
  const sets = replacements.map((r) => mask(r.types));
  return { types: fromMask(sets[0]), conflict: sets.some((bits) => bits !== sets[0]) };
};
const needsRuling = (error) => error instanceof TypeError && error.code === 'needs-ruling' &&
  error.needsRuling === true && error.ruleId === 'pokemon.types';

test('CN type replacement pins D-07 p45 and E-13 p59–60, with registered pokemon.types and no self-issued approval', () => {
  assert.deepEqual(POKEMON_TYPES_RULE_IDS, ['pokemon.types']);
  assert.deepEqual(POKEMON_TYPES_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.D-07', pdfPages: [45] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-13', pdfPages: [59, 60] },
  ]);
  const rule = requireRule(CN_V20261019, 'pokemon.types');
  assert(rule.sourceOfTruth.some((s) => s.documentId === 'CN-advanced-3.1.0' && s.pdfPages.includes(45)));
  assert(rule.sourceOfTruth.some((s) => s.documentId === 'CN-advanced-3.1.0' && s.pdfPages.includes(59) && s.pdfPages.includes(60)));
  assert.equal(CN_V20261019.documents.find((d) => d.id === 'CN-advanced-3.1.0').sha256,
    '27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419');
  assert.match(schema.$comment, /II\.D-07.*45.*II\.E-13.*59.*60/);
  assert.deepEqual(schema.$defs.pokemonType.enum, EXPECTED_TYPES);
  assert.deepEqual(POKEMON_TYPES, EXPECTED_TYPES);
  // Card-specific evidence, as a definition's own (official, or a machine-implemented card's library record).
  assert.equal(schema.$defs.replacement.properties.sourceOfTruth.$ref, 'urn:pokemon-tcg:card-definition:1.0.0#/$defs/cardEvidenceList');
  const result = resolvePokemonTypes(['Water'], [replacement('one', ['Psychic', 'Darkness'])]);
  assert(!Object.hasOwn(result, 'approval'));
  assert(!Object.hasOwn(result.trace[0], 'approved'));
});

test('strict standalone effect schema and pure validation agree for every scope, position flag and normalized Pokémon type', () => {
  for (const scope of ['self', 'own', 'opponent', 'all']) for (const activeOnly of [true, false])
    for (const sourceActive of [true, false]) for (const type of EXPECTED_TYPES) {
      const spec = effect({ scope, activeOnly, sourceActive, types: [type] }), before = clone(spec);
      assert.equal(assertPokemonTypesEffect(spec), spec);
      assert(schemaEffect(spec), JSON.stringify(schemaEffect.errors));
      assert.deepEqual(spec, before);
    }
  assert.equal(assertPokemonTypesEffect(effect()).scope, 'self');
  const plainNull = Object.assign(Object.create(null), effect());
  assert.equal(assertPokemonTypesEffect(plainNull), plainNull);
});

test('all 2047 nonempty PokémonType sets are accepted; no replacement preserves printed order and replacement order is canonical only', () => {
  let checked = 0;
  for (let bits = 1; bits < 2 ** EXPECTED_TYPES.length; bits++) {
    const canonical = fromMask(bits), reversed = [...canonical].reverse();
    assert(schemaEffect(effect({ types: reversed })));
    assert.equal(assertPokemonTypesEffect(effect({ types: reversed })).types.length, canonical.length);
    assert.deepEqual(resolvePokemonTypes(reversed).types, reversed);
    const result = resolvePokemonTypes(['Water'], [replacement('one', reversed)]);
    assert.deepEqual(result.types, canonical);
    assert.deepEqual(result.types, oracle(['Water'], [replacement('one', reversed)]).types);
    checked++;
  }
  assert.equal(checked, 2047);
  assert.deepEqual(resolvePokemonTypes(['Darkness', 'Psychic'], []).types, ['Darkness', 'Psychic']);
});

test('independent exhaustive oracle covers 0..3 replacement sources, every small set/array order, source order and conflicts', () => {
  const smallSets = Array.from({ length: 7 }, (_, index) => fromMask(index + 1));
  let checked = 0;
  for (const printed of smallSets) for (let length = 0; length <= 3; length++)
    for (const values of tuples(smallSets, length)) {
      const entries = values.map((types, index) => replacement(`source:${index}`, index % 2 ? [...types].reverse() : [...types]));
      const expected = oracle(printed, entries), before = clone({ printed, entries });
      for (const order of [entries, [...entries].reverse()]) {
        if (expected.conflict) assert.throws(() => resolvePokemonTypes(printed, order), needsRuling);
        else {
          const result = resolvePokemonTypes(printed, order);
          assert.deepEqual(result.types, expected.types);
          assert.deepEqual(result, resolvePokemonTypes(printed, entries));
          assert.equal(result.trace[0].usedPrinted, entries.length === 0);
        }
        checked++;
      }
      assert.deepEqual({ printed, entries }, before);
    }
  assert.equal(checked, 5600);
});

test('dual-type replacement is not additive; equivalent reordered sets keep all sources and different sets never pick a first/last winner', () => {
  const a = replacement('z', ['Darkness', 'Psychic']), b = replacement('a', ['Psychic', 'Darkness']);
  const result = resolvePokemonTypes(['Water', 'Fire'], [a, b]);
  assert.deepEqual(result.types, ['Psychic', 'Darkness']);
  assert.deepEqual(result.trace[0].replacements.map((r) => r.id), ['a', 'z']);
  assert.deepEqual(result.trace[0].replacements.map((r) => r.types), [
    ['Psychic', 'Darkness'], ['Psychic', 'Darkness'],
  ]);
  assert.deepEqual(result, resolvePokemonTypes(['Water', 'Fire'], [b, a]));
  for (const entries of [
    [replacement('one', ['Water']), replacement('two', ['Fire'])],
    [replacement('one', ['Water']), replacement('two', ['Water', 'Fire'])],
    [replacement('one', ['Psychic']), replacement('two', ['Psychic', 'Darkness'])],
  ]) {
    for (const order of [entries, [...entries].reverse()]) {
      assert.throws(() => resolvePokemonTypes(['Water'], order), (error) => {
        assert(needsRuling(error));
        assert(error.sourceOfTruth.length);
        assert.equal(error.trace[0].outcome, 'needs-ruling');
        assert.equal(error.trace[0].replacements.length, 2);
        return true;
      });
    }
  }
});

test('removing all applicable sources returns printed types, with no retained effective type, weakness mutation or Energy conversion', () => {
  const printed = ['Water'], entries = [replacement('live-source', ['Psychic', 'Darkness'])];
  const before = clone({ printed, entries });
  const changed = resolvePokemonTypes(printed, entries), restored = resolvePokemonTypes(printed, []);
  assert.deepEqual(changed.types, ['Psychic', 'Darkness']);
  assert.deepEqual(restored.types, ['Water']);
  assert(restored.trace[0].usedPrinted);
  assert.deepEqual(restored.trace[0].replacements, []);
  assert.deepEqual({ printed, entries }, before);
  assert.deepEqual(resolvePokemonTypes(['Dragon'], [replacement('colorless', ['Colorless'])]).types, ['Colorless']);
  assert(!Object.hasOwn(changed, 'weakness'));
  assert(!Object.hasOwn(changed, 'units'));
});

test('trace binds the registered CN rule and detached original/effective/source values without mutating or freezing caller data', () => {
  const printed = ['Water', 'Fire'], entries = [replacement('source', ['Darkness', 'Psychic'])];
  const before = clone({ printed, entries }), result = resolvePokemonTypes(printed, entries), t = result.trace[0];
  assert.deepEqual({ printed, entries }, before);
  assert(!Object.isFrozen(printed)); assert(!Object.isFrozen(entries)); assert(!Object.isFrozen(entries[0].types));
  assert.equal(t.rulesetId, 'CN/V20261019');
  assert.equal(t.ruleId, 'pokemon.types');
  assert.deepEqual(t.sourceOfTruth, requireRule(CN_V20261019, 'pokemon.types').sourceOfTruth);
  assert.deepEqual(t.printedTypes, printed); assert.deepEqual(t.types, result.types);
  assert.deepEqual(t.replacements[0].sourceOfTruth, EVIDENCE);
  printed[0] = 'Grass'; entries[0].types[0] = 'Metal'; entries[0].sourceOfTruth[0].locator = 'mutated';
  result.types[0] = 'Dragon';
  assert.deepEqual(t.printedTypes, ['Water', 'Fire']);
  assert.deepEqual(t.types, ['Psychic', 'Darkness']);
  assert.deepEqual(t.replacements[0].types, ['Psychic', 'Darkness']);
  assert.equal(t.replacements[0].sourceOfTruth[0].locator, EVIDENCE[0].locator);
  assert.throws(() => { t.replacements[0].sourceOfTruth[0].locator = 'tamper'; }, TypeError);
  assert.throws(() => { t.types.push('Fire'); }, TypeError);
  assert.deepEqual(resolvePokemonTypes(deepFreeze(before.printed), deepFreeze(before.entries)).types, ['Psychic', 'Darkness']);
});

test('unknown effect properties, implied type filters, modes, defaults and nonboolean position predicates are rejected', () => {
  const missing = effect(); delete missing.types;
  for (const spec of [null, [], 'pokemonTypes', false, {}, missing,
    effect({ op: 'property' }), effect({ scope: 'default' }), effect({ type: 'Water' }),
    effect({ mode: 'add' }), effect({ add: ['Water'] }), effect({ remove: ['Darkness'] }),
    effect({ group: 'same' }), effect({ priority: 1 }), effect({ sourceOfTruth: EVIDENCE }),
    effect({ activeOnly: 1 }), effect({ sourceActive: 'true' })]) {
    assert.throws(() => assertPokemonTypesEffect(spec), TypeError);
    assert(!schemaEffect(spec));
  }
  for (const bad of [undefined, null, 'Water', [], ['Water', 'Water'], ['Unknown'], ['水'], [0], [null], [false], [{}]]) {
    assert.throws(() => assertPokemonTypesEffect(effect({ types: bad })), TypeError);
    assert(!schemaEffect(effect({ types: bad })));
    assert.throws(() => resolvePokemonTypes(bad), TypeError);
    assert.throws(() => resolvePokemonTypes(['Water'], [replacement('bad', bad)]), TypeError);
  }
  for (const spec of [effect({ activeOnly: undefined }), effect({ sourceActive: undefined })])
    assert.throws(() => assertPokemonTypesEffect(spec), TypeError, 'Explicit undefined is non-JSON, not an absent optional flag.');
});

test('malformed replacements, missing/duplicate IDs and nonofficial/malformed provenance fail before resolution', () => {
  const missing = replacement('one', ['Water']); delete missing.types;
  const invalid = [null, {}, 'replacements', [null], [[]], [missing],
    [replacement('', ['Water'])], [replacement(1, ['Water'])],
    [replacement('one', ['Water']), replacement('one', ['Water'])],
    [replacement('one', ['Water'], { mode: 'add' })],
    [replacement('one', ['Water'], { scope: 'self' })],
    [replacement('one', ['Water'], { sourceOfTruth: [] })],
    [replacement('one', ['Water'], { sourceOfTruth: null })],
    [replacement('one', ['Water'], { sourceOfTruth: [{}] })],
  ];
  for (const value of invalid) assert.throws(() => resolvePokemonTypes(['Water'], value), TypeError);
  for (const extra of [
    { sourceId: '' }, { sourceId: 1 }, { sourceId: 'bad ID' }, { sourceId: 'x'.repeat(201) },
    { kind: '52poke' }, { url: 'https://wiki.52poke.com/wiki/card' }, { url: 1 },
    { url: 'https://www.pokemon.cn.evil.invalid/' }, { url: 'https://evil@www.pokemon.cn/' },
    { url: 'https://www.pokemon.cn:443/' }, { locator: '' }, { locator: false },
    { textSha256: 'bad' }, { textSha256: 1 }, { observedOn: 'today' }, { observedOn: 1 }, { approved: true },
    { kind: 'card-library' }, { kind: 'card-library', url: 'https://tcg.mik.moe/cards/TEST/001', textSha256: 'a'.repeat(64) },
  ]) {
    const value = [replacement('bad', ['Water'], { sourceOfTruth: [{ ...EVIDENCE[0], ...extra }] })];
    assert.throws(() => resolvePokemonTypes(['Water'], value), TypeError);
    assert(!schemaReplacements(value));
  }
  for (const kind of ['official-card', 'official-erratum', 'official-rule'])
    for (const url of ['https://www.pokemon.cn/', 'https://image.pokemon.com.cn/card.png', 'https://special.pokemon.cn/151/']) {
      const value = [replacement('valid', ['Water'], {
        sourceOfTruth: [{ ...EVIDENCE[0], kind, url, textSha256: 'a'.repeat(64), observedOn: '2026-10-19' }],
      })];
      assert(schemaReplacements(value));
      assert.deepEqual(resolvePokemonTypes(['Fire'], value).types, ['Water']);
    }
  for (const url of ['https://tcg.mik.moe/cards/TEST/001', 'https://wiki.52poke.com/index.php?curid=1']) {
    const value = [replacement('library', ['Water'], { sourceOfTruth: [{ ...{ sourceId: 'library:TEST/001_010', kind: 'card-library', url: 'https://tcg.mik.moe/cards/TEST/001', locator: 'TEST ONLY: fictitious library record' }, url, observedOn: '2026-10-21' }] })];
    assert(schemaReplacements(value));
    assert.deepEqual(resolvePokemonTypes(['Fire'], value).types, ['Water']);
  }
});

test('plain-data boundaries reject getters, hidden/symbol props, prototype inheritance and cycles without executing imported code', () => {
  let reads = 0;
  const getter = effect(); Object.defineProperty(getter, 'types', { enumerable: true, get() { reads++; return ['Water']; } });
  const hidden = effect(); Object.defineProperty(hidden, 'scope', { enumerable: false });
  const symbol = effect(); symbol[Symbol('hidden')] = 'Water';
  const circular = effect(); circular.types = [circular];
  const selfArray = []; selfArray.push(selfArray);
  for (const value of [getter, hidden, symbol, circular, effect({ types: selfArray }),
    Object.assign(Object.create({ scope: 'self' }), effect()), Object.assign(new (class Imported {})(), effect())])
    assert.throws(() => assertPokemonTypesEffect(value), TypeError);
  const badEvidence = clone(EVIDENCE);
  Object.defineProperty(badEvidence[0], 'locator', { enumerable: true, get() { reads++; return 'getter'; } });
  assert.throws(() => resolvePokemonTypes(['Water'], [replacement('one', ['Fire'], { sourceOfTruth: badEvidence })]), TypeError);
  const cyclicReplacement = replacement('cycle', ['Fire']); cyclicReplacement.sourceOfTruth = [cyclicReplacement];
  assert.throws(() => resolvePokemonTypes(['Water'], [cyclicReplacement]), TypeError);
  assert.equal(reads, 0);
});

test('dense-array validation rejects sparse, disguised-sparse, extended, accessor and class arrays at every types/replacement boundary', () => {
  const sparse = new Array(1), disguised = new Array(1); disguised.extra = true;
  const extra = ['Water']; extra.extra = true;
  const symbol = ['Water']; symbol[Symbol('hidden')] = true;
  const hidden = ['Water']; Object.defineProperty(hidden, '0', { enumerable: false });
  let reads = 0;
  const getter = ['Water']; Object.defineProperty(getter, '0', { enumerable: true, get() { reads++; return 'Water'; } });
  const custom = ['Water']; Object.setPrototypeOf(custom, null);
  class Imported extends Array {}
  for (const value of [sparse, disguised, extra, symbol, hidden, getter, custom, new Imported('Water')]) {
    assert.throws(() => assertPokemonTypesEffect(effect({ types: value })), TypeError);
    assert.throws(() => resolvePokemonTypes(value), TypeError);
    assert.throws(() => resolvePokemonTypes(['Water'], value), TypeError);
    assert.throws(() => resolvePokemonTypes(['Water'], [replacement('one', ['Water'], { sourceOfTruth: value })]), TypeError);
  }
  assert.equal(reads, 0);
});
