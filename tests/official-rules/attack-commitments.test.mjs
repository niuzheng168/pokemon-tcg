import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  ATTACK_COMMITMENT_RULE_IDS, assertAttackCommitment, attackCommitmentPool,
  canPayAttackCommitment, resolveAttackCommitment,
} from '../../public/rules/attack-commitments.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { deepFreeze, requireRule } from '../../public/rules/registry.js';

// Entirely synthetic card content; valid structure is NOT independent approval.
const EVIDENCE = [{
  sourceId: 'fixture:hand-commitment', kind: 'official-card', url: 'https://www.pokemon.cn/',
  locator: 'TEST ONLY: fictitious card, not official card approval',
}];
const base = (definitionId, kind, mechanics) => ({
  schemaVersion: '1.0.0', definitionId, ruleset: { region: 'CN', version: 'V20261019' },
  name: `测试${definitionId}`, nameKey: definitionId, kind,
  sourceOfTruth: structuredClone(EVIDENCE), implementation: { status: 'verified', testIds: ['fixture:commitment'] },
  deckLimits: { sameName: 4, groups: [] }, mechanics,
});
const pokemon = (id = 'base') => base(id, 'pokemon', {
  stage: 'basic', evolvesFrom: null, hp: 100, types: ['Water'], weakness: null, resistance: null,
  retreatCost: 1, attacks: [{
    attackId: 'printed:move', name: '测试卡面招式', cost: [],
    printedDamage: null, effects: [], sourceOfTruth: structuredClone(EVIDENCE),
  }], abilities: [], ruleBox: false, prizeCount: 1, tags: ['fixture-tag'], effects: [],
});
const energy = (id, type = 'Water', category = 'basic', units = [[type]]) =>
  base(id, 'energy', { category, baseUnits: units, effects: [] });
const trainer = (id = 'item') => base(id, 'trainer', { category: 'item', effects: [] });
const card = (instanceId, definition = energy('water')) => ({ instanceId, definition });
const spec = (count = 2, selector = { kind: 'energy', category: 'basic', types: ['Water'] }) =>
  ({ op: 'discardHand', count, selector });
const clone = (value) => structuredClone(value);

// Compile schemas in memory only. This does NOT invoke or rewrite generators.
const directory = new URL('../../schemas/', import.meta.url);
const schemas = await Promise.all((await readdir(directory)).filter((name) => name.endsWith('.schema.json'))
  .map(async (name) => JSON.parse(await readFile(new URL(name, directory), 'utf8'))));
const schema = schemas.find((s) => s.$id === 'urn:pokemon-tcg:attack-commitments:1.0.0');
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const s of schemas) ajv.addSchema(s);
const validateSpec = ajv.getSchema(schema.$id);

function* tuples(values, length, prefix = []) {
  if (!length) { yield prefix; return; }
  for (const value of values) yield* tuples(values, length - 1, [...prefix, value]);
}
// Exhaustive subsets are independent of the production count/set checks.
function* subsets(ids) {
  for (let bits = 0; bits < 2 ** ids.length; bits++)
    yield ids.filter((_id, index) => Math.floor(bits / 2 ** index) % 2 === 1);
}

test('E-33 FAQ3 commitments cite CN rules with the exact p72–73 hand-selection source, not activation costs', () => {
  assert.deepEqual(ATTACK_COMMITMENT_RULE_IDS, ['selection.hand', 'attack.failure.self']);
  for (const id of ATTACK_COMMITMENT_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  const hand = requireRule(CN_V20261019, 'selection.hand');
  assert(hand.sourceOfTruth.some((s) => s.documentId === 'CN-advanced-3.1.0' &&
    s.section === 'II.E-33' && JSON.stringify(s.pdfPages) === '[72,73]'));
  assert.equal(CN_V20261019.documents.find((d) => d.id === 'CN-advanced-3.1.0').sha256,
    '27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419');
  assert.match(schema.$comment, /II\.E-33 FAQ3.*72.*73/);
  assert.equal(schema.$defs.handPayment.properties.count.maximum, Number.MAX_SAFE_INTEGER);
});

test('strict descriptor and JSON schema agree on positive safe physical-card counts and every supported selector shape', () => {
  const selectors = [
    { kind: 'any' }, { kind: 'energy' }, { kind: 'energy', category: 'special' },
    { kind: 'energy', category: 'basic', types: ['Water'] },
    { kind: 'pokemon', stages: ['basic'], types: ['Water'], ruleBox: false,
      printedHpAtMost: 100, tagsAll: ['fixture-tag'], attackIds: ['printed:move'] },
    { kind: 'trainer', categories: ['item'], nameContains: '测试' },
    { anyOf: [{ kind: 'pokemon' }, { kind: 'energy', category: 'basic' }] },
  ];
  for (const count of [1, 2, 3, 60, Number.MAX_SAFE_INTEGER]) for (const selector of selectors) {
    const value = spec(count, selector), before = clone(value);
    assert.equal(assertAttackCommitment(value), value);
    assert(validateSpec(value), JSON.stringify(validateSpec.errors));
    assert.deepEqual(value, before);
  }
  const nullPrototype = Object.assign(Object.create(null), spec());
  assert.equal(assertAttackCommitment(nullPrototype), nullPrototype);
});

test('pool uses only supplied hand-card instances and printed predicates, preserving hand order and distinct copies of one definition', () => {
  const shared = energy('water'), cards = [
    card('water:2', shared), card('fire', energy('fire', 'Fire')),
    card('pokemon', pokemon()), card('item', trainer()), card('water:1', shared),
  ];
  assert.deepEqual(attackCommitmentPool(cards, spec()), ['water:2', 'water:1']);
  assert.deepEqual(attackCommitmentPool(cards, spec(2, { kind: 'any' })), cards.map((c) => c.instanceId));
  assert.deepEqual(attackCommitmentPool(cards, spec(1, { kind: 'pokemon', attackIds: ['printed:move'] })), ['pokemon']);
  assert.deepEqual(attackCommitmentPool(cards, spec(1, { kind: 'trainer', categories: ['item'] })), ['item']);
  assert.deepEqual(attackCommitmentPool(cards, spec(1, { anyOf: [{ kind: 'pokemon' }, { kind: 'trainer' }] })), ['pokemon', 'item']);
  assert.deepEqual(attackCommitmentPool([], spec()), []);
  assert.deepEqual(attackCommitmentPool(cards, spec(1, { kind: 'energy', nameKeys: ['fire'] })), ['fire']);
});

test('insufficient resources still give a valid zero-selection failure, never a declaration gate or partial payment', () => {
  for (const cards of [[], [card('water')], [card('fire', energy('fire', 'Fire'))]]) {
    assert.equal(canPayAttackCommitment(cards, spec()), false);
    assert.deepEqual(resolveAttackCommitment(cards, spec(), []), { passed: false, selected: [] });
  }
  const one = [card('water')], before = clone(one);
  assert.throws(() => resolveAttackCommitment(one, spec(), ['water']), TypeError);
  assert.deepEqual(one, before);
  const huge = spec(Number.MAX_SAFE_INTEGER);
  assert.equal(canPayAttackCommitment(one, huge), false, 'Never expand or allocate the stated count.');
  assert.deepEqual(resolveAttackCommitment(one, huge, []), { passed: false, selected: [] });
});

test('with enough eligible cards, full payment succeeds and voluntary zero still fails the already-used attack', () => {
  const cards = [card('a'), card('b'), card('c')], before = clone(cards), p = spec();
  assert.equal(canPayAttackCommitment(cards, p), true);
  assert.deepEqual(resolveAttackCommitment(cards, p, []), { passed: false, selected: [] });
  assert.deepEqual(resolveAttackCommitment(cards, p, ['c', 'a']), { passed: true, selected: ['c', 'a'] });
  assert.deepEqual(resolveAttackCommitment(cards, spec(1), ['b']), { passed: true, selected: ['b'] });
  assert.deepEqual(cards, before, 'Helper does not perform any discard, quota or turn action.');
  for (const selected of [['a'], ['a', 'b', 'c'], ['a', 'a'], ['a', 'missing']])
    assert.throws(() => resolveAttackCommitment(cards, p, selected), TypeError);
});

test('all small hand compositions, hand permutations, counts and selection subsets agree with an independent exhaustive oracle', () => {
  const definitions = [
    energy('water'), energy('fire', 'Fire'), energy('double', 'Colorless', 'special', [['Colorless'], ['Colorless']]),
  ];
  const filters = [
    { kind: 'any' }, { kind: 'energy' }, { kind: 'energy', category: 'basic', types: ['Water'] },
    { kind: 'energy', category: 'special' },
  ];
  let checked = 0;
  for (let n = 0; n <= 4; n++) for (const kinds of tuples([0, 1, 2], n)) {
    const original = kinds.map((kind, i) => card(`c${i}`, definitions[kind]));
    for (const cards of [original, [...original].reverse()]) for (let filter = 0; filter < filters.length; filter++) {
      const eligible = cards.filter((c) => {
        const kind = kinds[Number(c.instanceId.slice(1))];
        return filter < 2 || filter === 2 && kind === 0 || filter === 3 && kind === 2;
      }).map((c) => c.instanceId);
      for (const count of [1, 2, 3, 5]) {
        const p = spec(count, filters[filter]), before = clone({ cards, p });
        assert.deepEqual(attackCommitmentPool(cards, p), eligible);
        // Feasibility oracle enumerates candidate subsets instead of using
        // the tested pool size or the production selector implementation.
        const feasible = [...subsets(eligible)].some((selected) => selected.length === count);
        assert.equal(canPayAttackCommitment(cards, p), feasible);
        for (const selected of subsets(cards.map((c) => c.instanceId))) {
          const valid = selected.length === 0 || selected.length === count && selected.every((id) => eligible.includes(id));
          if (!valid) assert.throws(() => resolveAttackCommitment(cards, p, selected), TypeError);
          else assert.deepEqual(resolveAttackCommitment(cards, p, selected),
            { passed: selected.length > 0, selected });
          checked++;
        }
        assert.deepEqual({ cards, p }, before);
      }
    }
  }
  assert.equal(checked, 49760);
});

test('physical cards are never Energy units: a multi-unit or all-attribute Special Energy remains one card with its printed identity', () => {
  const double = energy('double', 'Colorless', 'special', [['Colorless'], ['Colorless']]);
  const allTypes = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Colorless'];
  const rainbow = energy('rainbow', 'Colorless', 'special', [allTypes]);
  const cards = [card('double', double), card('rainbow', rainbow), card('water', energy('water'))];
  assert.equal(canPayAttackCommitment([cards[0]], spec(2, { kind: 'energy' })), false);
  assert.deepEqual(resolveAttackCommitment(cards, spec(2, { kind: 'energy' }), ['double', 'rainbow']),
    { passed: true, selected: ['double', 'rainbow'] });
  assert.deepEqual(attackCommitmentPool(cards, spec()), ['water'],
    'Attached all-attribute provision must not make a hand Special Energy a Basic Water Energy.');
  assert.equal(canPayAttackCommitment(cards, spec()), false);
  assert.throws(() => resolveAttackCommitment(cards, spec(), ['rainbow', 'water']), TypeError);
  assert.deepEqual(attackCommitmentPool(cards, spec(1, { kind: 'energy', category: 'special' })), ['double', 'rainbow']);
});

test('immutable inputs and shared immutable definitions remain untouched; every pool and selected result is detached', () => {
  const shared = energy('water'), input = [card('a', shared), card('b', shared)], p = spec(), selected = ['b', 'a'];
  const before = clone({ input, p, selected }), result = resolveAttackCommitment(input, p, selected);
  const pool = attackCommitmentPool(input, p);
  assert.deepEqual({ input, p, selected }, before);
  assert(!Object.isFrozen(input)); assert(!Object.isFrozen(shared)); assert(!Object.isFrozen(selected));
  assert.notEqual(pool, selected);
  assert.notEqual(result.selected, selected);
  result.selected.pop(); pool.pop();
  assert.deepEqual(selected, ['b', 'a']);
  assert.deepEqual(input, before.input);
  assert.deepEqual(resolveAttackCommitment(deepFreeze(input), deepFreeze(p), deepFreeze(selected)),
    { passed: true, selected: ['b', 'a'] });
  const zero = [], failed = resolveAttackCommitment(input, p, zero);
  assert.notEqual(failed.selected, zero); assert.deepEqual(failed, { passed: false, selected: [] });
});

test('descriptor rejects unknown properties, unit substitution, nested costs and malformed selectors instead of silently ignoring them', () => {
  const noSelector = spec(); delete noSelector.selector;
  const invalid = [null, false, 2, 'discardHand', [], {}, noSelector,
    { ...spec(), op: 'discardEnergy' }, { ...spec(), kind: 'discardHand' },
    { ...spec(), measure: 'units' }, { ...spec(), quantity: { kind: 'upTo', count: 2 } },
    { ...spec(), optional: true }, { ...spec(), sourceOfTruth: EVIDENCE },
    { ...spec(), zone: 'discard' }, { ...spec(), costId: 'fee' },
    spec(2, { kind: 'any', unknown: true }), spec(2, { kind: 'energy', providedTypes: ['Water'] }),
    spec(2, { kind: 'energy', types: ['Water'] }), spec(2, { kind: 'energy', category: 'special', types: ['Water'] }),
    spec(2, { kind: 'pokemon', effectiveTypes: ['Water'] }), spec(2, { kind: 'pokemon', printedHpAtMost: -1 }),
    spec(2, { kind: 'energy', category: 'basic', types: ['Unknown'] }),
  ];
  for (const value of invalid) {
    assert.throws(() => assertAttackCommitment(value), TypeError);
    assert(!validateSpec(value));
  }
  for (const count of [0, -1, 0.5, '2', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1n]) {
    const value = { ...spec(), count };
    assert.throws(() => assertAttackCommitment(value), TypeError);
    assert(!validateSpec(value));
  }
});

test('candidate and selection validation reject duplicate IDs, malformed definitions, out-of-pool answers and non-array values', () => {
  const good = [card('a'), card('b')];
  const malformedDefinition = energy('water'); malformedDefinition.mechanics.baseUnits = [];
  const unknownDefinition = energy('water'); unknownDefinition.currentHp = 80;
  const invalidPools = [
    null, 'hand', {}, [null], [false], [card('')], [card(1)],
    [good[0], good[0]], [card('a'), card('a', trainer())],
    [{ instanceId: 'a' }], [{ instanceId: 'a', definition: [] }],
    [{ instanceId: 'a', definition: {} }], [card('a', malformedDefinition)], [card('a', unknownDefinition)],
    [{ ...card('a'), effectiveUnits: [['Water'], ['Water']] }],
  ];
  for (const cards of invalidPools) {
    assert.throws(() => attackCommitmentPool(cards, spec()), TypeError);
    assert.throws(() => canPayAttackCommitment(cards, spec()), TypeError);
    assert.throws(() => resolveAttackCommitment(cards, spec(), []), TypeError);
  }
  for (const selected of [null, undefined, 0, '', {}, ['a'], ['a', 'a'], ['a', 'missing'], ['a', 1], ['a', null]])
    assert.throws(() => resolveAttackCommitment(good, spec(), selected), TypeError);
  const before = clone(good);
  assert.throws(() => resolveAttackCommitment(good, spec(), ['a', 'missing']), TypeError);
  assert.deepEqual(good, before, 'A rejected answer does not partly discard a card.');
});

test('plain-data gate rejects getters, hidden/symbol fields, inherited input, sparse arrays and cycles without executing getters', () => {
  let reads = 0;
  const getter = spec();
  Object.defineProperty(getter, 'selector', { enumerable: true, get() { reads++; return { kind: 'any' }; } });
  const nested = spec(); Object.defineProperty(nested.selector, 'category',
    { enumerable: true, get() { reads++; return 'basic'; } });
  const hidden = spec(); Object.defineProperty(hidden, 'count', { enumerable: false });
  const symbol = spec(); symbol[Symbol('hidden')] = 1;
  const circular = spec(); circular.selector = circular;
  for (const value of [getter, nested, hidden, symbol, circular,
    Object.assign(Object.create({ count: 2 }), spec()),
    Object.assign(new (class Imported {})(), spec()), spec(2, { kind: 'pokemon', ruleBox: undefined })])
    assert.throws(() => assertAttackCommitment(value), TypeError);
  assert.equal(reads, 0);
  const sparse = new Array(1), extra = [card('a')]; extra.metadata = true;
  const disguised = new Array(1); disguised.metadata = true;
  const arraySymbol = [card('a')]; arraySymbol[Symbol('hidden')] = true;
  const arrayGetter = [card('a')]; Object.defineProperty(arrayGetter, '0',
    { enumerable: true, get() { reads++; return card('a'); } });
  const nullPrototypeArray = [card('a')]; Object.setPrototypeOf(nullPrototypeArray, null);
  for (const cards of [sparse, extra, disguised, arraySymbol, arrayGetter, nullPrototypeArray])
    assert.throws(() => attackCommitmentPool(cards, spec()), TypeError);
  const badSelection = ['a', 'b']; badSelection.extra = 1;
  assert.throws(() => resolveAttackCommitment([card('a'), card('b')], spec(), badSelection), TypeError);
  assert.equal(reads, 0);
});
