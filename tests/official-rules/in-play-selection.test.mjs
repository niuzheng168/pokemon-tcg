import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchesInPlaySelector } from '../../public/rules/in-play-selection.js';
import { matchesCardSelector } from '../../public/rules/card-selection.js';
import { POKEMON_TYPES, ENERGY_TYPES } from '../../public/rules/damage.js';

// Synthetic normalized mechanics, not production card/printing approval.
const pokemon = () => ({
  definitionId: 'fixture:printed-water', nameKey: 'fixture:printed-water', name: '测试打印水宝可梦', kind: 'pokemon',
  mechanics: {
    stage: 'stage1', evolvesFrom: 'fixture:basic', hp: 90, types: ['Water'],
    weakness: { type: 'Lightning', operation: 'multiply', value: 2 }, resistance: { type: 'Fighting', value: 30 },
    retreatCost: 2, ruleBox: true, tags: ['RapidStrike', 'fixture'],
    attacks: [{ attackId: 'fixture:native-attack', name: '测试原生招式', effects: [] }],
    abilities: [{ abilityId: 'fixture:printed-ability', name: '测试打印特性', mode: 'continuous', effects: [] }],
    effects: [], prizeCount: 2,
  },
});
const energy = (category = 'basic', baseUnits = [['Water']]) => ({
  definitionId: 'fixture:energy', nameKey: 'fixture:energy', name: '测试基本水能量', kind: 'energy',
  mechanics: { category, baseUnits, effects: [] },
});
const trainer = () => ({
  definitionId: 'fixture:trainer', nameKey: 'fixture:trainer', name: '测试支援者', kind: 'trainer',
  mechanics: { category: 'supporter', effects: [] },
});
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const p = (types) => ({ kind: 'pokemon', types });
const rejects = (fn) => assert.throws(fn, TypeError);

test('only the in-play Pokémon type predicate changes; the original printed selector/definition remains stable', () => {
  const definition = pokemon(), selector = p(['Lightning']), effective = ['Lightning'];
  const before = structuredClone({ definition, selector, effective });
  assert.equal(matchesCardSelector(definition, selector), false);
  assert.equal(matchesInPlaySelector(definition, selector, effective), true);
  assert.equal(matchesInPlaySelector(definition, p(['Water']), effective), false);
  assert.equal(matchesCardSelector(definition, p(['Water'])), true);
  assert.deepEqual({ definition, selector, effective }, before);
  assert.equal(Object.isFrozen(definition), false);
  assert.equal(Object.isFrozen(definition.mechanics), false);
  assert.equal(Object.isFrozen(definition.mechanics.types), false);
  assert.equal(Object.isFrozen(definition.mechanics.attacks), false);
  assert.equal(Object.isFrozen(effective), false);
  assert.equal(Object.isFrozen(selector), false);
});

test('all eleven Pokémon types, including Dragon/Fairy/Colorless, use exact normalized matching and OR within types', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/card-definition.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual([...POKEMON_TYPES], schema.$defs.pokemonType.enum);
  assert(POKEMON_TYPES.includes('Dragon')); assert(!ENERGY_TYPES.includes('Dragon'));
  const definition = freeze(pokemon());
  for (const actual of POKEMON_TYPES) for (const requested of POKEMON_TYPES)
    assert.equal(matchesInPlaySelector(definition, freeze(p([requested])), freeze([actual])), actual === requested);
  assert.equal(matchesInPlaySelector(definition, p(['Fire', 'Lightning']), ['Lightning', 'Metal']), true);
  assert.equal(matchesInPlaySelector(definition, p(['Water', 'Grass']), ['Lightning', 'Metal']), false);
  assert.equal(matchesInPlaySelector(definition, p(['Dragon', 'Fairy']), ['Dragon', 'Colorless']), true);
  assert.equal(matchesInPlaySelector(definition, { kind: 'pokemon' }, [...POKEMON_TYPES]), true);
});

test('name/stage/printed HP/Rule Box/tags/printed attack and Ability predicates remain printed identity', () => {
  const definition = pokemon(), types = ['Lightning'];
  const selectors = [
    [{ kind: 'any' }, true],
    [{ kind: 'pokemon' }, true],
    [{ kind: 'pokemon', types: ['Lightning'], nameKeys: ['fixture:printed-water'], stages: ['stage1'],
      printedHpAtMost: 90, ruleBox: true, tagsAll: ['fixture', 'RapidStrike'],
      attackIds: ['fixture:native-attack'], abilityIds: ['fixture:printed-ability'] }, true],
    [{ kind: 'pokemon', nameKeys: ['other'] }, false],
    [{ kind: 'pokemon', stages: ['basic'] }, false],
    [{ kind: 'pokemon', printedHpAtMost: 89 }, false],
    [{ kind: 'pokemon', ruleBox: false }, false],
    [{ kind: 'pokemon', tagsAll: ['SingleStrike'] }, false],
    [{ kind: 'pokemon', attackIds: ['fixture:granted-not-printed'] }, false],
    [{ kind: 'pokemon', abilityIds: ['fixture:granted-not-printed'] }, false],
    [{ kind: 'energy', category: 'basic', types: ['Lightning'] }, false],
    [{ kind: 'trainer', categories: ['supporter'] }, false],
  ];
  for (const [selector, expected] of selectors) {
    const before = structuredClone({ definition, selector, types });
    assert.equal(matchesInPlaySelector(definition, selector, types), expected);
    assert.deepEqual({ definition, selector, types }, before);
  }
  assert.deepEqual(definition.mechanics.weakness, { type: 'Lightning', operation: 'multiply', value: 2 });
  assert.deepEqual(definition.mechanics.resistance, { type: 'Fighting', value: 30 });
  assert.equal(definition.mechanics.retreatCost, 2);
});

test('anyOf preserves each branch kind and identity while applying live types only to Pokémon branches', () => {
  const definition = freeze(pokemon()), types = freeze(['Lightning']);
  const selectors = [
    [{ anyOf: [p(['Water']), p(['Lightning'])] }, true],
    [{ anyOf: [p(['Water']), p(['Grass'])] }, false],
    [{ anyOf: [{ kind: 'trainer', categories: ['supporter'] }, p(['Lightning'])] }, true],
    [{ anyOf: [{ kind: 'energy', category: 'basic', types: ['Lightning'] }, p(['Water'])] }, false],
    [{ anyOf: [{ kind: 'pokemon', types: ['Lightning'], stages: ['basic'] },
      { kind: 'pokemon', types: ['Water'], stages: ['stage1'] }] }, false],
    [{ anyOf: [{ kind: 'pokemon', types: ['Lightning'], nameKeys: ['other'] },
      { kind: 'pokemon', types: ['Lightning'], attackIds: ['fixture:native-attack'] }] }, true],
  ];
  for (const [selector, expected] of selectors)
    assert.equal(matchesInPlaySelector(definition, freeze(selector), types), expected);
});

test('Energy identity and unit provision are not replaced by the holder’s effective Pokémon types, including anyOf', () => {
  for (const definition of [energy(), energy('special', [['Lightning'], ['Lightning', 'Water']])]) {
    const before = structuredClone(definition);
    for (const selector of [
      { kind: 'any' }, { kind: 'energy' },
      { kind: 'energy', category: 'basic', types: ['Water'] },
      { kind: 'energy', category: 'basic', types: ['Lightning'] },
      { kind: 'energy', category: 'special' },
      { anyOf: [p(['Lightning']), { kind: 'energy', category: 'basic', types: ['Water'] }] },
      { anyOf: [p(['Water']), { kind: 'trainer', categories: ['item'] }] },
    ]) {
      const expected = matchesCardSelector(definition, selector);
      for (const types of [['Lightning'], ['Fire', 'Dragon'], ['Water']])
        assert.equal(matchesInPlaySelector(definition, selector, types), expected);
    }
    assert.deepEqual(definition, before);
    assert.equal(Object.hasOwn(definition.mechanics, 'types'), false);
  }
  const definition = trainer();
  for (const selector of [{ kind: 'any' }, { kind: 'trainer', categories: ['supporter'], nameContains: '支援' },
    { kind: 'trainer', categories: ['item'] }, p(['Lightning']),
    { anyOf: [p(['Lightning']), { kind: 'trainer', nameKeys: ['fixture:trainer'] }] }])
    assert.equal(matchesInPlaySelector(definition, selector, ['Lightning']), matchesCardSelector(definition, selector));
});

test('no implicit types fallback, even for any/no-type/mixed selectors or non-Pokémon definitions', () => {
  const invalid = [undefined, null, false, true, 0, 'Lightning', new Set(['Lightning']), [], ['Fake'], ['lightning'],
    ['L'], [1], [null], [['Lightning']], ['Water', 'Water'], ['Dragon', 'Dragon'], [NaN], [Infinity]];
  for (const definition of [pokemon(), energy(), trainer()]) for (const types of invalid) {
    for (const selector of [{ kind: 'any' }, { kind: 'pokemon' },
      { anyOf: [p(['Lightning']), { kind: 'energy', category: 'basic', types: ['Water'] }] }])
      rejects(() => matchesInPlaySelector(definition, selector, types));
  }
  rejects(() => matchesInPlaySelector(pokemon(), p(['Water'])));
});

test('sparse/extended/accessor/symbol/prototype-corrupt type arrays are rejected without executing getters or changing input', () => {
  const invalid = [Array(1), ['Water', , 'Lightning']];
  const extended = ['Water']; extended.extra = true; invalid.push(extended);
  const symbolic = ['Water']; symbolic[Symbol('hidden')] = 'Lightning'; invalid.push(symbolic);
  const hidden = ['Water']; Object.defineProperty(hidden, 'hidden', { value: 'Lightning' }); invalid.push(hidden);
  const fakeIndex = Array(1); fakeIndex['00'] = 'Water'; invalid.push(fakeIndex);
  const hiddenIndex = ['Water']; Object.defineProperty(hiddenIndex, '0', { enumerable: false }); invalid.push(hiddenIndex);
  const noPrototype = ['Water']; Object.setPrototypeOf(noPrototype, null); invalid.push(noPrototype);
  const customPrototype = ['Water']; Object.setPrototypeOf(customPrototype, {}); invalid.push(customPrototype);
  const arraySubclass = new (class extends Array {})('Water'); invalid.push(arraySubclass);
  const cycle = []; cycle.push(cycle); invalid.push(cycle);
  let reads = 0;
  const getter = []; Object.defineProperty(getter, '0', { enumerable: true, get() { reads++; return 'Water'; } }); invalid.push(getter);
  for (const types of invalid) rejects(() => matchesInPlaySelector(freeze(pokemon()), p(['Water']), types));
  assert.equal(reads, 0);
  const types = ['Lightning', 'Metal'], before = Object.getOwnPropertyDescriptors(types);
  assert.equal(matchesInPlaySelector(freeze(pokemon()), freeze(p(['Metal'])), types), true);
  assert.deepEqual(Object.getOwnPropertyDescriptors(types), before);
});

test('invalid CardSelector or definition shapes do not become successful matches when live types are valid', () => {
  const definition = pokemon(), types = freeze(['Lightning']);
  for (const selector of [
    null, undefined, [], {}, { kind: 'Pokemon' }, { kind: 'any', types: ['Lightning'] },
    p([]), p(['Fake']), p(['Lightning', 'Lightning']), { kind: 'pokemon', effectiveTypes: ['Lightning'] },
    { anyOf: [] }, { anyOf: [p(['Lightning'])] },
    { anyOf: [p(['Lightning']), { kind: 'any' }] },
    { anyOf: [p(['Lightning']), { anyOf: [p(['Water']), p(['Grass'])] }] },
    { kind: 'pokemon', printedHpAtMost: -1 }, { kind: 'pokemon', nameKeys: [] },
  ]) rejects(() => matchesInPlaySelector(definition, selector, types));
  for (const invalid of [null, undefined, false, 1, [], {}, { kind: 'unknown', mechanics: {} },
    { kind: 'pokemon' }, { kind: 'pokemon', mechanics: null }, { kind: 'pokemon', mechanics: false },
    { kind: 'pokemon', mechanics: [] }])
    rejects(() => matchesInPlaySelector(invalid, { kind: 'any' }, types));
});

test('a frozen original with unrelated shared references remains identical across repeated independent live-type views', () => {
  const original = pokemon(), shared = [{ opaque: 'metadata-not-a-battle-property' }];
  original.metadataRefs = shared; original.sourceOfTruth = shared;
  const before = structuredClone(original); freeze(original);
  for (const types of [['Lightning'], ['Metal', 'Dragon'], ['Water'], ['Fire'], ['Lightning']]) {
    const supplied = freeze(types), selector = freeze({ kind: 'pokemon', types: ['Lightning'], printedHpAtMost: 90 });
    assert.equal(matchesInPlaySelector(original, selector, supplied), types.includes('Lightning'));
    assert.deepEqual(original, before);
    assert.equal(original.metadataRefs, shared); assert.equal(original.sourceOfTruth, shared);
  }
  assert.equal(matchesCardSelector(original, p(['Lightning'])), false);
  assert.equal(matchesCardSelector(original, p(['Water'])), true);
});

// Independent truth table: no production selector helper or reconstructed
// mechanics view is used to calculate expectations.
test('independent oracle exhausts all type subsets and mixed selectors without changing printed identity predicates', () => {
  const definition = freeze(pokemon()), universe = ['Water', 'Lightning', 'Fire', 'Dragon'];
  const subsets = [];
  for (let mask = 1; mask < 2 ** universe.length; mask++)
    subsets.push(universe.filter((_type, index) => mask >> index & 1));
  let checks = 0;
  for (const actual of subsets) for (const requested of subsets) {
    for (const correctName of [false, true]) for (const correctStage of [false, true]) {
      const typed = {
        kind: 'pokemon', types: requested,
        nameKeys: [correctName ? 'fixture:printed-water' : 'other'],
        stages: [correctStage ? 'stage1' : 'basic'],
      };
      const intersects = actual.reduce((match, type) => match || requested.indexOf(type) !== -1, false);
      const expected = intersects && correctName && correctStage;
      assert.equal(matchesInPlaySelector(definition, typed, actual), expected);
      const energyBranch = { kind: 'energy', category: 'basic', types: ['Water'] };
      assert.equal(matchesInPlaySelector(definition, { anyOf: [energyBranch, typed] }, actual), expected);
      const printedBranch = { kind: 'pokemon', printedHpAtMost: 90, attackIds: ['fixture:native-attack'] };
      assert.equal(matchesInPlaySelector(definition, { anyOf: [typed, printedBranch] }, actual), true);
      checks += 3;
    }
  }
  assert.equal(checks, 2700);
});
