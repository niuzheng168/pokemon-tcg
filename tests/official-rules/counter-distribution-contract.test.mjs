import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertEffectProgram } from '../../public/rules/effects.js';
import {
  validateCounterDistributionAction, validateCounterDistributionParameters, validateCounterAllocation,
  validateCounterChoice, validateEffectResolution, validateGameCommand,
} from '../../public/rules/schema-validators.js';
import { EVIDENCE } from './fixtures.mjs';

const action = (extra = {}) => ({
  op: 'distributeCounters', side: 'opponent', target: 'any', selector: { kind: 'pokemon' }, count: 5, ...extra,
});
const source = {
  instanceId: 'source', owner: 0, cardOwner: 0, category: 'trainer', origin: 'hand',
  pokemonId: null, attackId: null, effectId: 'fixture:allocation', sourceOfTruth: EVIDENCE,
};
const choice = () => ({ id: 'counter1', turn: 3, sourceId: 'source',
  targets: [{ pokemonId: 'm1', topCardId: 'p1', counters: 2 }] });

test('the native fixed-total handler emits exactly its strict action and declares the separately sourced operation', () => {
  const h = createCoreHandlers().get('cn.distributeCounters@1');
  assert.deepEqual(h.operations, ['distributeCounters']);
  assert.equal(h.parameterSchemaRef, 'urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/counterDistribution');
  assert(h.sourceOfTruth.some((s) => s.documentId === 'CN-advanced-3.1.0' && s.pdfPages.includes(30)));
  for (const count of [0, 1, 5, 900719925474099]) for (const side of ['own', 'opponent']) {
    const a = action({ count, side }), before = structuredClone(a);
    assert.equal(validateCounterDistributionAction(a), true);
    assert.equal(validateCounterDistributionParameters(a), true);
    assert.equal(h.validateParameters(a), true);
    assert.deepEqual(h.execute({}, a), [a]);
    assertEffectProgram(h.execute({}, a), h.operations);
    assert.deepEqual(a, before);
  }
});

test('fixed totals cannot smuggle dynamic counts, transfer sources, runtime attributes or optional defaults', () => {
  const h = createCoreHandlers().get('cn.distributeCounters@1');
  const invalid = [
    ...[-1, 0.5, 900719925474100, Infinity, NaN, '5', 'all', null, { kind: 'literal', value: 5 }]
      .map((count) => action({ count })),
    action({ side: 'both' }), action({ source: 'm1' }), action({ from: 'any' }),
    action({ optional: true }), action({ selection: { kind: 'upTo', count: 5 } }),
    action({ currentHp: 100 }), action({ healed: ['m1'] }), action({ blocked: ['m1'] }),
    action({ selector: { kind: 'pokemon', currentHpAtMost: 30 } }), { effect: action() },
    ...Object.keys(action()).map((key) => { const a = action(); delete a[key]; return a; }),
  ];
  for (const a of invalid) {
    assert.equal(validateCounterDistributionAction(a), false);
    assert.equal(h.validateParameters(a), false);
    assert.throws(() => assertEffectProgram([a], h.operations));
  }
  assert.throws(() => assertEffectProgram([{ op: 'optional', effect: action() }], ['optional']));
});

test('numeric allocation is a separate exact command; ordinary answers cannot carry numeric side effects', () => {
  const a = { type: 'allocateCounters', requestId: 'q1', allocations: [{ pokemonId: 'm1', count: 5 }] };
  const command = (action) => ({ player: 0, expectedRevision: 1, action });
  assert.equal(validateGameCommand(command(a)), true);
  assert.equal(validateCounterAllocation([]), true, 'Empty data shape is permitted; the actual window/total decides legality.');
  for (const allocations of [
    [{ pokemonId: 'm1', count: 0 }], [{ pokemonId: 'm1', count: -1 }], [{ pokemonId: 'm1', count: 0.5 }],
    [{ pokemonId: 'm1', count: '5' }], [{ pokemonId: 'm1', count: 900719925474100 }],
    [{ pokemonId: 'm1', count: 5, currentHp: 100 }], [{ targetId: 'm1', count: 5 }], null,
  ]) {
    assert.equal(validateCounterAllocation(allocations), false);
    assert.equal(validateGameCommand(command({ ...a, allocations })), false);
  }
  assert.equal(validateGameCommand(command({ ...a, selected: ['m1'] })), false);
  assert.equal(validateGameCommand(command({ type: 'answer', requestId: 'q1', selected: ['m1'], allocations: a.allocations })), false);
});

test('the saved allocation window and answer are typed to this operation, with no mixed healing/string-answer stage', () => {
  const c = choice(), resolution = { action: action(), frames: [], source, counterChoice: c };
  assert.equal(validateCounterChoice(c), true);
  assert.equal(validateEffectResolution(resolution), true);
  assert.equal(validateEffectResolution({ ...resolution, allocations: [{ pokemonId: 'm1', count: 5 }] }), true);
  for (const extra of [
    { selected: ['m1'] }, { healingChoice: c }, { prizeChoice: {} }, { stage: 'target' },
    { action: { op: 'draw', count: 1 } },
  ]) assert.equal(validateEffectResolution({ ...resolution, ...extra }), false);
  assert.equal(validateEffectResolution({ action: action(), frames: [], source, allocations: [] }), false);
  for (const mutate of [
    (c) => { c.targets[0].counters = -1; }, (c) => { c.targets[0].counters = 900719925474100; },
    (c) => { c.targets[0].currentHp = 10; }, (c) => { c.turn = 0; }, (c) => { c.placedTotal = 5; },
  ]) {
    const bad = choice(); mutate(bad); assert.equal(validateCounterChoice(bad), false);
  }
});
