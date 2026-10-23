// Synthetic definitions only. 「在造成伤害前，选择附着于对手战斗宝可梦身上的1个特殊能量，放于弃牌区。」: attack step 3 (I.A-01,
// 「在造成伤害前」), before the damage of step 4. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, attached } from './fixtures.mjs';

const strip = { op: 'discardEnergy', side: 'opponent', from: 'active', selector: { kind: 'energy', category: 'special' }, providedTypes: null,
  measure: 'cards', quantity: { kind: 'exact', count: 1 }, chooser: 'source' };

test('「在造成伤害前，选择附着于对手战斗宝可梦身上的1个特殊能量，放于弃牌区」', async () => {
  assert(createCoreHandlers().get('cn.countedEnergyDiscard@1').validateParameters(strip));
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:strip', name: '测试剥离', cost: ['Water'],
      printedDamage: { value: 30, operator: 'fixed' }, effects: [binding('cn.countedEnergyDiscard@1', strip, 'strip')], sourceOfTruth: EVIDENCE });
  });
  let special;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); special = attached(s, 1, s.players[1].active, 'double'); });
  command(g, { type: 'attack', attackId: 'base:strip' }); settle(g);
  const s = g.snapshot();
  assert(s.players[1].discard.includes(special));
  const events = s.events.map((e) => e.ruleId);
  const discarded = s.events.findIndex((e) => JSON.stringify(e.data).includes(special) && e.ruleId !== 'turn.energy');
  const damaged = s.events.findIndex((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'));
  assert(discarded >= 0 && discarded < damaged, `discard before damage: ${events.slice(-12).join(',')}`);
  assert.equal(s.players[1].active.counters, 3);
});
