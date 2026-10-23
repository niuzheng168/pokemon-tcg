// Synthetic definitions only. 「如果追加附有1个【水】能量的话，则…」 / 「如果追加附有2个能量的话，则…」 (energy.extra): Energy beyond the
// attack's current cost, counted in units, in the best payment. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnergyRequirements, surplusEnergy } from '../../public/rules/energy-mechanics.js';
import { assertBattleValue } from '../../public/rules/battle-value.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, start, command, settle, hand, attached } from './fixtures.mjs';

const extra = (energyType, count) => ({ kind: 'compare', left: { kind: 'extraEnergy', energyType }, relation: 'gte',
  right: { kind: 'literal', value: count } });
const when = (condition) => binding('cn.when@1', { condition, effect: { handlerId: 'cn.draw@1', parameters: { count: 2 } } }, 'gx');
const ALL = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Colorless'];

test('surplus Energy: units, typed extras, multi-type units pay or count, never both', () => {
  assert(requireRule(CN_V20261019, 'energy.extra').sourceOfTruth.some((r) => r.documentId === 'CN-advanced-3.1.0'));
  const [route] = resolveEnergyRequirements({ printed: ['Water', 'Colorless'] });
  const water = ['Water'], fire = ['Fire'], dce = ['Colorless'], rainbow = ALL.filter((t) => t !== 'Colorless');
  assert.equal(surplusEnergy([water, water, water], route, 'Water'), 1);
  assert.equal(surplusEnergy([water, water, water], route), 1);
  assert.equal(surplusEnergy([water, fire], route, 'Water'), 0, 'The Water pays the Water cost.');
  assert.equal(surplusEnergy([water, fire, water], route, 'Water'), 1, 'The Fire pays the Colorless cost.');
  assert.equal(surplusEnergy([dce, dce, water], route), 1);
  assert.equal(surplusEnergy([dce, dce, water], route, 'Water'), 0, 'A Colorless unit never counts as Water.');
  assert.equal(surplusEnergy([rainbow, fire, water], route, 'Water'), 1, 'Either Water-able unit may be the extra one.');
  assert.equal(surplusEnergy([water], route), 0, 'The cost itself is not met.');
  assert.throws(() => surplusEnergy(Array(17).fill(water), route), RangeError);
  assertBattleValue({ kind: 'extraEnergy', energyType: null });
  for (const bad of [{ kind: 'extraEnergy' }, { kind: 'extraEnergy', energyType: 'Ice' }, { kind: 'extraEnergy', energyType: 'Water', count: 1 }])
    assert.throws(() => assertBattleValue(bad), (e) => e.code === 'invalid-battle-value');
});

test('the attack reads its own user\'s Energy when the instruction is reached', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:gx', name: '测试GX', cost: ['Water'],
      printedDamage: null, effects: [when(extra('Water', 1))], sourceOfTruth: EVIDENCE });
  });
  const run = (energies) => {
    const g = board(f, (s) => energies.forEach((id) => attached(s, 0, s.players[0].active, id)));
    const before = g.snapshot().players[0].hand.length;
    command(g, { type: 'attack', attackId: 'base:gx' }); settle(g);
    return g.snapshot().players[0].hand.length - before;
  };
  assert.equal(run(['water', 'water']), 2);
  assert.equal(run(['water', 'double']), 0, 'Two Colorless units are not Water.');
  assert.equal(run(['water']), 0);
  const trainer = await fixture((defs) => { defs.find((d) => d.definitionId === 'potion').mechanics.effects = [when(extra(null, 1))]; });
  assert.throws(() => start(trainer), (e) => e.code === 'unsupported-condition');
});

test('a cost increase raises the baseline (ヌメラ「ねばるねんまく」)', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:gx', name: '测试GX', cost: ['Water'],
      printedDamage: null, effects: [when(extra(null, 1))], sourceOfTruth: EVIDENCE });
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.energyRequirement@1', { effect: {
      op: 'energyRequirement', action: 'attack', mode: 'adjust', scope: 'all', energyType: 'Colorless', amount: 1 } }, 'goomy')];
  });
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); attached(s, 0, s.players[0].active, 'water');
    const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id;
  });
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'attack', attackId: 'base:gx' }); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, before, 'Two units pay the raised cost; none is extra.');
});
