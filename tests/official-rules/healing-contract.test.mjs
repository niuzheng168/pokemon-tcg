import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertEffectProgram, beginEffectProgram } from '../../public/rules/effects.js';
import {
  validatePokemonHealingAction, validatePokemonHealingParameters, validateEffectProgram,
  validateEffectResolution, validateHealingChoice,
} from '../../public/rules/schema-validators.js';
import { EVIDENCE } from './fixtures.mjs';

const action = (extra = {}) => ({
  op: 'healPokemon', side: 'own', target: 'any', selector: { kind: 'pokemon' },
  selection: { kind: 'all' }, amount: 'all', discardHealedEnergy: false, ...extra,
});
const clone = (v) => structuredClone(v);
const source = {
  instanceId: 'source', owner: 0, cardOwner: 0, category: 'trainer', origin: 'hand',
  pokemonId: null, attackId: null, effectId: 'fixture:healing', sourceOfTruth: EVIDENCE,
};

test('native healing parameters are the complete strict action, and every accepted amount/selection emits a schema-valid program', () => {
  const h = createCoreHandlers().get('cn.healPokemon@1');
  assert.deepEqual(h.operations, ['healPokemon', 'discardEnergy']);
  assert.equal(h.parameterSchemaRef, 'urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/pokemonHealing');
  assert(h.sourceOfTruth.some((s) => s.documentId === 'CN-advanced-3.1.0' && s.pdfPages.includes(29)));
  for (const amount of [10, 30, 9007199254740990, 'all']) for (const discardHealedEnergy of [false, true])
    for (const selection of [{ kind: 'all' }, { kind: 'exact', count: 1 }, { kind: 'upTo', count: 2 }]) {
      const a = action({ amount, discardHealedEnergy, selection }), original = clone(a);
      assert.equal(validatePokemonHealingAction(a), true);
      assert.equal(validatePokemonHealingParameters(a), true);
      assert.equal(h.validateParameters(a), true);
      const program = h.execute({}, a);
      assert.deepEqual(program, [a]);
      assert.equal(validateEffectProgram(program), true);
      assertEffectProgram(program, h.operations);
      assert.deepEqual(a, original);
    }
});

test('healing rejects implicit policies, forged result sets, runtime HP fields and malformed numeric/selection parameters', () => {
  const h = createCoreHandlers().get('cn.healPokemon@1');
  const invalid = [
    ...[0, 1, -10, 11, 9007199254740991, NaN, Infinity, null, 'maximumHp', { kind: 'all' }]
      .map((amount) => action({ amount })),
    action({ discardHealedEnergy: 'true' }), action({ discardHealedEnergy: undefined }),
    action({ healedIds: ['other'] }), action({ currentHp: 100 }), action({ maximumHp: 100 }),
    action({ blocked: ['other'] }), action({ sourceOwner: 1 }), action({ side: 'both' }),
    action({ selector: { kind: 'any' } }), action({ selector: { kind: 'pokemon', currentHpAtMost: 20 } }),
    action({ selection: { kind: 'any' } }), action({ selection: { kind: 'exact', count: 0 } }),
    action({ selection: { kind: 'all', count: 2 } }), { effect: action() }, { ...action(), op: 'heal' },
  ];
  for (const a of invalid) {
    assert.equal(validatePokemonHealingAction(a), false);
    assert.equal(h.validateParameters(a), false);
    assert.throws(() => assertEffectProgram([a], h.operations));
  }
});

test('correlated Energy discard is an explicit declared permission, including in a branch that would never execute', () => {
  const healOnly = action(), withDiscard = action({ discardHealedEnergy: true });
  assertEffectProgram([healOnly], ['healPokemon']);
  assert.throws(() => assertEffectProgram([withDiscard], ['healPokemon']), /declare the discardEnergy/);
  assert.throws(() => assertEffectProgram([{
    op: 'then', first: { op: 'sequence', steps: [] }, next: { op: 'optional', effect: withDiscard },
  }], ['sequence', 'then', 'optional', 'healPokemon']), /declare the discardEnergy/);
  const program = [withDiscard];
  assertEffectProgram(program, ['healPokemon', 'discardEnergy']);
  assert.equal(beginEffectProgram(program).action.steps[0].discardHealedEnergy, true);
});

test('healing continuation schema binds only a healPokemon action and stores bounded original counters, never an editable healed set', () => {
  const choice = { id: 'heal1', turn: 3, sourceId: 'source',
    targets: [{ pokemonId: 'm1', topCardId: 'p1', counters: 2 }] };
  const resolution = { action: action(), frames: [], source, healingChoice: choice };
  assert.equal(validateHealingChoice(choice), true);
  assert.equal(validateEffectResolution(resolution), true);
  assert.equal(validateEffectResolution({ ...resolution, action: { op: 'draw', count: 1 } }), false);
  for (const mutate of [
    (c) => { c.healed = ['m2']; }, (c) => { c.targets[0].currentHp = 100; },
    (c) => { c.targets[0].counters = 900719925474100; }, (c) => { c.targets[0].counters = -1; },
    (c) => { c.turn = 0; }, (c) => { delete c.sourceId; },
  ]) {
    const c = clone(choice); mutate(c);
    assert.equal(validateHealingChoice(c), false);
    assert.equal(validateEffectResolution({ ...resolution, healingChoice: c }), false);
  }
});
