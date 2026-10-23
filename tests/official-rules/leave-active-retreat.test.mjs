// Synthetic definitions only. 「如果使用了这个招式的话，则这只宝可梦，在离开战斗场之前无法使用「X」」 (effects.duration.leave-active, II.C-15);
// 「…即使处于【睡眠】或者【麻痹】状态，也可以撤退」「其【撤退】所需能量不会被放于弃牌区，而是会被放回手牌」 (retreat.rules). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertOngoingEffect } from '../../public/rules/ongoing.js';
import { applyCondition } from '../../public/rules/conditions.js';
import { fixture, binding, board, command, settle, bench, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const handlers = createCoreHandlers();
const lock = { side: 'own', target: 'self', effect: { op: 'restriction', scope: 'all', actions: ['attack'], attackIds: ['base:strike'] },
  duration: 'untilLeavesActive', clearOnBench: true, clearOnEvolution: true };
const water = (s, owner) => { const p = s.players[owner], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'water'); p.active.energy.push(p.deck.splice(i, 1)[0]); };
const canAttack = (g) => g.view(g.snapshot().current).legalActions.some((a) => a.type === 'attack');
const canRetreat = (g) => g.view(g.snapshot().current).legalActions.some((a) => a.type === 'retreat');
const endTurn = (g) => { command(g, { type: 'endTurn' }); settle(g); };

test('schema: a leave-the-Active-Spot lock clears on Bench and evolution', () => {
  const valid = handlers.get('cn.lasting@1').validateParameters;
  assert(valid(lock));
  assert(!valid({ ...lock, clearOnBench: false })); assert(!valid({ ...lock, clearOnEvolution: false }));
  assert(!handlers.get('cn.lastingPlayer@1').validateParameters({ side: 'own', duration: 'untilLeavesActive',
    effect: { op: 'playerRestriction', scope: 'all', actions: ['playItem'] } }));
});

test('「在离开战斗场之前」: the attack stays locked over turns until the Pokémon goes to the Bench', async () => {
  const f = await fixture((defs) => { defs.find((d) => d.definitionId === 'base').mechanics.attacks[0].effects = [binding('cn.lasting@1', lock, 'burst')]; });
  const g = board(f, (s) => { water(s, 0); water(s, 1); s.players[0].active.energy.push(s.players[0].deck.splice(s.players[0].deck.findIndex((id) => s.cards[id].definitionId === 'water'), 1)[0]); bench(s, 0, 'other'); });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const entry = g.snapshot().ongoing.find((e) => e.ruleId === 'effects.duration.leave-active');
  assert.equal(entry.deadline.boundary, 'game');
  for (const forged of [{ ...entry, ruleId: 'effects.duration.turn-only' }, { ...entry, duration: 'nextOwnTurn' }, { ...entry, deadline: { ...entry.deadline, player: 1 } }])
    assert.throws(() => assertOngoingEffect(forged, g.snapshot()), /duration\/deadline/);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  endTurn(g); // Opponent's turn passes.
  assert(!canAttack(g), 'Still locked in the next own turn.');
  endTurn(g); endTurn(g);
  assert(!canAttack(g), 'And the one after.');
  command(g, { type: 'retreat' }); settle(g);
  assert(!g.snapshot().ongoing.some((e) => e.ruleId === 'effects.duration.leave-active'), 'Moving to the Bench ends it.');
});

const tool = (...effects) => fixture((defs) => { defs.find((d) => d.definitionId === 'tool').mechanics.effects = effects; });
const holding = (f, mutate) => board(f, (s) => {
  const p = s.players[0], id = hand(s, 0, 'tool'); p.hand.pop();
  p.active.tools.push(id); water(s, 0); bench(s, 0, 'other'); mutate(s);
});

test('「即使处于【睡眠】或者【麻痹】状态，也可以撤退」', async () => {
  const free = await tool(binding('cn.modifier@1', { field: 'retreat', amount: -1, scope: 'self' }, 'lighter'),
    binding('cn.retreatRule@1', { effect: { op: 'retreatRule', scope: 'self', ignoreConditions: true } }, 'escape'));
  const plain = await fixture();
  for (const rotation of ['asleep', 'paralyzed']) {
    const affect = (s) => { const m = s.players[0].active; m.conditions = applyCondition(m.conditions, rotation, { ownerTurn: s.players[0].turns }).conditions; };
    const g = holding(free, affect);
    assert(canRetreat(g));
    command(g, { type: 'retreat' }); settle(g);
    const p = g.snapshot().players[0];
    assert.equal(p.active.stack.map((id) => g.snapshot().cards[id].definitionId)[0], 'other');
    assert.equal(p.bench[0].conditions.rotation, null, 'Back on the Bench, the condition is gone.');
    assert(!canRetreat(holding(plain, affect)));
  }
  assert(!handlers.get('cn.retreatRule@1').validateParameters({ effect: { op: 'retreatRule', scope: 'self' } }));
});

test('「其【撤退】所需能量…放回手牌」', async () => {
  const f = await tool(binding('cn.retreatRule@1', { effect: { op: 'retreatRule', scope: 'self', energyToHand: true } }, 'pouch'));
  const g = holding(f, () => {});
  const energy = g.snapshot().players[0].active.energy[0];
  command(g, { type: 'retreat' }); settle(g);
  const s = g.snapshot();
  assert(s.players[0].hand.includes(energy)); assert(!s.players[0].discard.includes(energy));
  assert(s.events.some((e) => e.ruleId === 'retreat.rules' && e.data.toHand.includes(energy)));
  assert.deepEqual(restore(g, f).snapshot(), s);
});
