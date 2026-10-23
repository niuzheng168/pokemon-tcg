// Synthetic definitions only. 「回复这只宝可梦与给对手战斗宝可梦造成的伤害相同数值的HP」: the attack's own damage to the opponent's
// Active Pokémon after Weakness and Resistance (attack steps 4–5, I.A-01). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, attached } from './fixtures.mjs';

const drain = (weakness) => fixture((defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = weakness;
  defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:drain', name: '测试吸取', cost: ['Water'],
    printedDamage: { value: 30, operator: 'fixed' }, effects: [binding('cn.drainHeal@1', {}, 'drain')], sourceOfTruth: EVIDENCE });
});
const run = (f, counters) => {
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = counters; });
  command(g, { type: 'attack', attackId: 'base:drain' }); settle(g);
  return g.snapshot();
};

test('「回复这只宝可梦与给对手战斗宝可梦造成的伤害相同数值的HP」', async () => {
  assert(createCoreHandlers().get('cn.drainHeal@1').validateParameters({}));
  assert(!createCoreHandlers().get('cn.drainHeal@1').validateParameters({ amount: 30 }));
  let s = run(await drain(null), 5);
  assert.equal(s.players[0].active.counters, 2, '30 damage dealt, 30 HP healed.');
  s = run(await drain({ type: 'Water', operation: 'multiply', value: 2 }), 8);
  assert.equal(s.players[0].active.counters, 2, 'Weakness doubles it to 60.');
  s = run(await drain(null), 0);
  assert(!s.events.some((e) => e.ruleId === 'effects.heal'), 'Nothing to heal.');
});

test('cn.drainHeal@1 is printed on attacks only', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.drainHeal@1', {}, 'drain')];
  });
  assert.throws(() => board(f), (e) => e.code === 'unsupported-handler');
});

test('only the resolving attack reads the damage it dealt', async () => {
  const later = { side: 'own', target: 'self', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
    trigger: { event: 'turnEnd', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global' },
    program: [{ op: 'heal', side: 'own', target: 'self', fromAttackDamage: true }] };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:later', name: '测试稍后', cost: ['Water'],
      printedDamage: null, effects: [binding('cn.delayedReaction@1', later, 'later')], sourceOfTruth: EVIDENCE });
  });
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = 2; });
  command(g, { type: 'attack', attackId: 'base:later' }); settle(g);
  assert.throws(() => { command(g, { type: 'endTurn' }); settle(g); }, (e) => e.code === 'invalid-damage-source');
});
