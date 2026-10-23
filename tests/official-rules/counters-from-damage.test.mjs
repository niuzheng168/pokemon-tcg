// Synthetic definitions only. 「当这只宝可梦受到招式的伤害时，将与受到的伤害数值相同的伤害指示物，放置于使用了招式的宝可梦身上」
// (an Ability, or 「在下一个对手的回合，…」 after an attack): damage ÷ 10 counters, the damage after Weakness and Resistance.
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, attached } from './fixtures.mjs';

const back = { side: 'opponent', target: 'attacker' };
const trigger = { event: 'attackDamage', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global', cause: 'opponentAttackDamage' };

test('an Ability returns as many counters as the damage it received', async () => {
  const h = createCoreHandlers().get('cn.countersFromDamage@1');
  assert(h.validateParameters(back)); assert(!h.validateParameters({ ...back, count: 2 }));
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    defs.find((d) => d.definitionId === 'base').mechanics.abilities = [{ abilityId: 'base:mirror', name: '测试镜面', mode: 'triggered',
      usage: null, trigger: { ...trigger, activeOnly: true }, effects: [binding('cn.countersFromDamage@1', back, 'mirror')], sourceOfTruth: EVIDENCE }];
  });
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.equal(g.snapshot().players[0].active.counters, 2, '20 damage received, 2 counters back.');
});

test('after an attack: 「在下一个对手的回合，当这只宝可梦受到招式的伤害时，…」', async () => {
  const later = { side: 'own', target: 'self', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true, trigger,
    program: [{ op: 'counters', side: 'opponent', target: 'attacker', fromEventDamage: true }] };
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:mirror', name: '测试镜面', cost: ['Water'],
      printedDamage: null, effects: [binding('cn.delayedReaction@1', later, 'mirror')], sourceOfTruth: EVIDENCE });
  });
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); attached(s, 1, s.players[1].active, 'water'); });
  command(g, { type: 'attack', attackId: 'base:mirror' }); settle(g);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  const placed = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.countersFromDamage@1', back, 'misplaced')];
  });
  assert.throws(() => board(placed), (e) => e.code === 'unsupported-handler', 'Only an attack-damage trigger has received damage.');
});

test('a reaction that did not receive attack damage has no damage to return', async () => {
  const later = { side: 'own', target: 'self', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
    trigger: { event: 'turnEnd', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global' },
    program: [{ op: 'counters', side: 'opponent', target: 'active', fromEventDamage: true }] };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:late', name: '测试迟到', cost: ['Water'],
      printedDamage: null, effects: [binding('cn.delayedReaction@1', later, 'late')], sourceOfTruth: EVIDENCE });
  });
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  command(g, { type: 'attack', attackId: 'base:late' }); settle(g);
  assert.throws(() => { command(g, { type: 'endTurn' }); settle(g); }, (e) => e.code === 'invalid-trigger-event');
});
