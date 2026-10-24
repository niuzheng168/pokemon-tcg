// Synthetic definitions only. 「身上放有这张卡牌的宝可梦，不会陷入特殊状态，已经处于的特殊状态，也全部恢复」 (I.F): no Special
// Condition can be applied to the affected Pokémon, and any it has is recovered at the next rule boundary. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, answer, settle, hand, attached } from './fixtures.mjs';

const immunity = (extra = {}) => ({ effect: { op: 'conditionImmunity', scope: 'self', ...extra } });

test('the Tool holder cannot be poisoned, and a poisoned holder recovers once the Tool is attached', async () => {
  assert(requireRule(CN_V20261019, 'status.immunity').sourceOfTruth.length);
  const h = createCoreHandlers().get('cn.conditionImmunity@1');
  assert(h.validateParameters(immunity({ targetSelector: { kind: 'pokemon', tagsAll: ['Ancient'] } })));
  assert(!h.validateParameters(immunity({ conditions: ['frozen'] })));
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'tool').mechanics.effects = [binding('cn.conditionImmunity@1', immunity(), 'immune')];
    defs[0].mechanics.attacks[0].effects = [binding('cn.condition@1', { side: 'opponent', condition: 'poisoned' }, 'venom')];
  });
  let tool, poison;
  const g = board(f, (s) => {
    tool = hand(s, 0, 'tool'); s.players[0].active.conditions.poison = 1; s.players[0].active.conditions.rotation = 'confused';
  });
  command(g, { type: 'playTrainer', cardId: tool });
  if (g.snapshot().pending) answer(g, [g.snapshot().players[0].active.id]);
  settle(g);
  const active = g.snapshot().players[0].active;
  assert(active.tools.includes(tool));
  assert.equal(active.conditions.poison, null); assert.equal(active.conditions.rotation, null);
  assert(g.snapshot().events.some((e) => e.ruleId === 'status.immunity' && e.data.targetId === active.id));
  const k = board(f, (s) => {
    poison = hand(s, 0, 'poison'); attached(s, 0, s.players[0].active, 'water');
    const t = hand(s, 1, 'tool'); s.players[1].hand.pop(); s.players[1].active.tools.push(t);
  });
  // status.no-change: the Item could change nothing, so it cannot be played; an attack's Poison is not applied.
  assert(!k.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === poison));
  command(k, { type: 'attack', attackId: 'base:strike' }); settle(k);
  assert.equal(k.snapshot().players[1].active.conditions.poison, null, 'The holder cannot be poisoned.');
  assert(k.snapshot().events.some((e) => e.ruleId === 'status.immunity' && e.data.effectId === 'fixture:venom'));
});

test('「不会陷入【中毒】状态」: only the printed conditions; preventOnly recovers nothing already present', async () => {
  const h = createCoreHandlers().get('cn.conditionImmunity@1');
  assert(h.validateParameters(immunity({ conditions: ['poisoned'], preventOnly: true })));
  assert(!h.validateParameters(immunity({ conditions: [] })));
  assert(!h.validateParameters(immunity({ preventOnly: false })));
  const make = (extra) => fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.abilities = [{ abilityId: 'base:immune', name: '测试免疫', mode: 'continuous',
      usage: null, sourceOfTruth: defs[0].sourceOfTruth, effects: [binding('cn.conditionImmunity@1', immunity(extra), 'immune')] }];
  });
  const poisonPlay = (f, mutate = () => {}) => {
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'poison'); mutate(s); });
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    return g.snapshot().players[1].active.conditions;
  };
  const poisonOnly = await make({ conditions: ['poisoned'], preventOnly: true });
  // status.no-change: it cannot be poisoned, so the Item changes nothing and cannot be played.
  let card;
  const kept = board(poisonOnly, (s) => { card = hand(s, 0, 'poison'); s.players[1].active.conditions.rotation = 'confused'; });
  assert(!kept.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card), 'Cannot be poisoned.');
  command(kept, { type: 'endTurn' }); settle(kept);
  assert.equal(kept.snapshot().players[1].active.conditions.rotation, 'confused', 'Confusion is not covered.');
  const sleepOnly = await make({ conditions: ['asleep'] });
  assert.equal(poisonPlay(sleepOnly).poison, 4, 'Poison is not covered.');
  const g = board(sleepOnly, (s) => { s.players[1].active.conditions.rotation = 'asleep'; s.players[1].active.conditions.burned = true; });
  command(g, { type: 'endTurn' }); settle(g);
  assert.equal(g.snapshot().players[1].active.conditions.rotation, null, 'Already asleep: recovered.');
  assert.deepEqual(g.snapshot().events.filter((e) => e.ruleId === 'status.immunity').map((e) => e.data.conditions), [['asleep']]);
  const prevent = board(poisonOnly, (s) => { s.players[1].active.conditions.poison = 1; });
  command(prevent, { type: 'endTurn' }); settle(prevent);
  assert.notEqual(prevent.snapshot().players[1].active.conditions.poison, null, 'preventOnly: an existing poison stays.');
  assert(!prevent.snapshot().events.some((e) => e.ruleId === 'status.immunity'));
});
