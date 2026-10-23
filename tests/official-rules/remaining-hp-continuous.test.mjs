// Synthetic definitions only. 「身上放有这张卡牌的宝可梦，【撤退】所需能量减少1个。如果那只宝可梦的剩余HP在「30」及以下的话，则【撤退】所需能量，全部消除」,
// 「如果这只宝可梦的剩余HP在「100」点以下（包含100）的话，则这只宝可梦使用的招式，给对手的战斗宝可梦造成的伤害「+80」」, 「不会受到对手剩余HP在「40」点以下
// （包含40点）的宝可梦的招式的伤害」 and 「双方场上剩余HP在「40」点以下的宝可梦（包含40点），无法使用招式」 (II.D-16). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, settle, hand } from './fixtures.mjs';

const def = (defs, id) => defs.find((d) => d.definitionId === id);
const water = (s, owner) => {
  const p = s.players[owner], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'water');
  p.active.energy.push(p.deck.splice(i, 1)[0]);
};
const tool = (s, owner, m) => { const id = hand(s, owner, 'tool'); s.players[owner].hand.pop(); m.tools.push(id); };
const canAttack = (g, player) => g.view(player).legalActions.some((a) => a.type === 'attack');

test('schema: remaining HP filters, never on an HP modifier', () => {
  const valid = (id, effect) => createCoreHandlers().get(id).validateParameters({ effect });
  assert(valid('cn.modifier@1', { op: 'modifier', field: 'attackDamage', amount: 80, scope: 'self', targetRemainingHpAtMost: 100 }) ||
    createCoreHandlers().get('cn.modifier@1').validateParameters({ field: 'attackDamage', amount: 80, scope: 'self', targetRemainingHpAtMost: 100 }));
  const m = createCoreHandlers().get('cn.modifier@1').validateParameters;
  assert(!m({ field: 'hp', amount: 30, scope: 'self', targetRemainingHpAtMost: 100 }));
  assert(!m({ field: 'hp', amount: 30, scope: 'self', otherRemainingHpAtMost: 100 }));
  assert(!m({ field: 'attackDamage', amount: 30, scope: 'self', targetRemainingHpAtMost: 15 }));
});

test('a Tool erases the Retreat Cost at 30 HP or less; a self boost at 100 or less', async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.weakness = null; d.mechanics.retreatCost = 3; }
    def(defs, 'base').mechanics.hp = 200;
    def(defs, 'tool').mechanics.effects = [binding('cn.modifier@1', { field: 'retreat', amount: -1, scope: 'self' }, 'less'),
      binding('cn.energyRequirement@1', { effect: { op: 'energyRequirement', action: 'retreat', mode: 'erase', scope: 'self', targetRemainingHpAtMost: 30 } }, 'free')];
    def(defs, 'base').mechanics.effects.push(binding('cn.modifier@1', { field: 'attackDamage', amount: 80, scope: 'self', targetRemainingHpAtMost: 100,
      targetSide: 'opponent', targetPosition: 'active' }, 'desperate'));
  });
  const cost = (g) => g.view(0).players[0].active.effective.retreatCost;
  const g = board(f, (s) => { tool(s, 0, s.players[0].active); });
  assert.equal(cost(g), 2);
  const k = board(f, (s) => { tool(s, 0, s.players[0].active); s.players[0].active.counters = 17; });
  assert.equal(cost(k), 0, 'HP 200, 170 damage: 30 left.');
  const strike = (counters) => {
    const h = board(f, (s) => { water(s, 0); s.players[0].active.counters = counters; });
    command(h, { type: 'attack', attackId: 'base:strike' }); settle(h);
    return h.snapshot().players[1].active.counters;
  };
  assert.deepEqual([strike(9), strike(10)], [2, 10], '110 left: no boost; 100 left: +80.');
});

test("the attacker's remaining HP for a protection, and an attack lock by remaining HP", async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    def(defs, 'other').mechanics.effects.push(binding('cn.protection@1', { effect: { op: 'protection', channel: 'damage', useRule: 'ordinary', scope: 'self',
      from: 'opponent', categories: ['attack'], otherRemainingHpAtMost: 40 } }, 'mask'));
    def(defs, 'stadium').mechanics.effects = [binding('cn.restriction@1', { effect: { op: 'restriction', scope: 'all', actions: ['attack'], targetRemainingHpAtMost: 40 } }, 'blizzard')];
  });
  const hit = (counters) => {
    const g = board(f, (s) => {
      water(s, 0); s.players[0].active.counters = counters;
      const p = s.players[1], id = hand(s, 1, 'other'); p.hand.pop(); p.hand.push(...p.active.stack); p.active.stack = [id];
    });
    command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
    return g.snapshot().players[1].active.counters;
  };
  assert.deepEqual([hit(5), hit(6)], [2, 0], '50 left is hit; 40 left is not.');
  const lock = (counters) => board(f, (s) => {
    water(s, 0); s.players[0].active.counters = counters;
    const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id;
  });
  assert.deepEqual([canAttack(lock(5), 0), canAttack(lock(6), 0)], [true, false]);
});
