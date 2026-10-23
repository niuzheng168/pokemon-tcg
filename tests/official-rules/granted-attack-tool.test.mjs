// Synthetic definitions only. 「身上放有这张卡牌的「一击」宝可梦，可以使用这张卡牌上的招式。[需要满足使用招式所需能量。]」
// 「放于宝可梦身上的这张卡牌，将在自己的回合结束时被放于弃牌区。」 (tools.granted-attack). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const tm = (extra) => fixture((defs) => {
  const tool = def(defs, 'tool');
  tool.mechanics.effects = [];
  tool.mechanics.grantedAttacks = [{ attackId: 'tm:attack', name: '测试学习器招式', cost: ['Water'],
    printedDamage: { value: 50, operator: 'fixed' }, effects: [], sourceOfTruth: EVIDENCE }];
  Object.assign(tool.mechanics, extra);
  def(defs, 'other').mechanics.tags = ['Single Strike'];
  def(defs, 'stadium').mechanics.effects = [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'tools', scope: 'all' } }, 'jam')];
});
const equip = (s, owner = 0) => { const t = hand(s, owner, 'tool'); s.players[owner].hand.pop(); s.players[owner].active.tools.push(t); return t; };
const asActive = (s, owner, id) => { const p = s.players[owner]; p.hand.push(...p.active.stack); p.active.stack = [hand(s, owner, id)]; p.hand.pop(); };
const granted = (g) => g.view(0).legalActions.some((a) => a.type === 'attack' && a.attackId === 'tm:attack');

test('schema: a holder kind and the end-of-turn discard belong to a Tool that grants an attack', async () => {
  await assert.rejects(fixture((defs) => { def(defs, 'potion').mechanics.turnEndDiscard = true; }));
  await assert.rejects(fixture((defs) => { def(defs, 'tool').mechanics.grantedAttackHolder = { kind: 'pokemon', tagsAll: ['一击'] }; }));
});

test('「身上放有这张卡牌的「一击」宝可梦」: only that holder may use the attack', async () => {
  const f = await tm({ grantedAttackHolder: { kind: 'pokemon', tagsAll: ['Single Strike'] } });
  let g = board(f, (s) => { equip(s); attached(s, 0, s.players[0].active, 'water'); });
  assert.equal(granted(g), false, 'Not a 一击 Pokémon.');
  g = board(f, (s) => { asActive(s, 0, 'other'); equip(s); attached(s, 0, s.players[0].active, 'water'); });
  assert.equal(granted(g), true);
  command(g, { type: 'attack', attackId: 'tm:attack' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 5);
});

test('「将在自己的回合结束时被放于弃牌区」: at the end of its owner\'s turn, unless the Tool\'s effects are removed', async () => {
  const f = await tm({ turnEndDiscard: true });
  let tool;
  let g = board(f, (s) => { tool = equip(s); });
  assert.equal(granted(g), false, 'No Energy.');
  command(g, { type: 'endTurn' }); settle(g);
  let s = g.snapshot();
  assert.deepEqual(s.players[0].active.tools, []); assert(s.players[0].discard.includes(tool));
  assert(s.events.some((e) => e.ruleId === 'tools.granted-attack' && e.data.cardId === tool));
  assert.deepEqual(restore(g, f).snapshot(), s);
  // On the opponent's turn end it stays.
  g = board(f, (s) => { tool = equip(s, 1); });
  command(g, { type: 'endTurn' }); settle(g);
  assert.deepEqual(g.snapshot().players[1].active.tools, [tool]);
  // Tool effects removed (a Stadium): it stays.
  g = board(f, (s) => { tool = equip(s); const id = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = id; });
  command(g, { type: 'endTurn' }); settle(g);
  assert.deepEqual(g.snapshot().players[0].active.tools, [tool]);
});
