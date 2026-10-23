// Synthetic definitions only. II.E-20 「使用了这张卡牌的回合结束时，从自己的牌库上方抽取卡牌，直到自己的手牌张数为8张为止」
// 「从自己牌库上方抽取4张卡牌。在使用了这张卡牌的回合结束时，如果自己的手牌数量为5张及以上的话，则将自己的手牌全部放于弃牌区」
// (effects.turn-end). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, settle, hand, EVIDENCE } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const handlers = createCoreHandlers();
const plan = binding('cn.turnEndEffect@1', { effect: leaf('cn.drawUntil@1', { count: 8 }) }, 'plan');
const fiveOrMore = { kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'hand' }, relation: 'gte', right: { kind: 'literal', value: 5 } };
const supporter = (...effects) => fixture((defs) => { defs.find((d) => d.definitionId === 'research').mechanics.effects = effects; });
const setup = (f, handSize) => {
  let card;
  const g = board(f, (s) => {
    const p = s.players[0]; p.discard.push(...p.hand.splice(0)); card = hand(s, 0, 'research');
    while (p.hand.length < handSize) p.hand.push(p.deck.pop());
  });
  return { g, card };
};
const endTurn = (g) => { command(g, { type: 'endTurn' }); settle(g); };

test('schema', () => {
  const valid = handlers.get('cn.turnEndEffect@1').validateParameters;
  assert(valid({ effect: leaf('cn.drawUntil@1', { count: 8 }) }));
  assert(valid({ effect: leaf('cn.discardHand@1', {}), condition: fiveOrMore }));
  assert(!valid({ effect: leaf('cn.discardHand@1', { count: 1 }) }));
  assert(!valid({ effect: leaf('cn.heal@1', { target: 'any', amount: 30 }) }));
});

test('「回合结束时」: drawn up to 8 when the turn ends, before the checkup and the next turn', async () => {
  const f = await supporter(plan);
  const { g, card } = setup(f, 3);
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].hand.length, 2, 'Nothing is drawn yet.');
  assert(s.events.some((e) => e.ruleId === 'effects.turn-end' && e.data.recorded));
  assert.deepEqual(restore(g, f).snapshot(), s);
  endTurn(g);
  s = g.snapshot();
  assert.equal(s.players[0].hand.length, 8); assert.equal(s.current, 1);
  const at = (rule) => s.events.findIndex((e) => e.ruleId === rule && !e.data.recorded);
  assert(at('turn.end') < at('effects.turn-end') && at('effects.turn-end') < at('checkup.order'));
  assert.deepEqual(restore(g, f).snapshot(), s);
  // Only once, in the turn it was used.
  endTurn(g); endTurn(g);
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'effects.turn-end' && !e.data.recorded).length, 1);
});

test('「如果自己的手牌数量为5张及以上的话」 is judged when the turn ends', async () => {
  const f = await supporter(binding('cn.draw@1', { count: 4 }, 'draw'),
    binding('cn.turnEndEffect@1', { effect: leaf('cn.discardHand@1', {}), condition: fiveOrMore }, 'tidy'));
  // 1 other card + 4 drawn = 5 (discarded); none + 4 drawn = 4 (kept).
  for (const [size, discarded] of [[2, true], [1, false]]) {
    const { g, card } = setup(f, size);
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    endTurn(g);
    const s = g.snapshot();
    assert.equal(s.players[0].hand.length, discarded ? 0 : 4);
    assert.equal(s.events.some((e) => e.ruleId === 'effects.condition' && e.data.met), discarded);
  }
});

test('only on an Item or Supporter; a forged turn-end program is refused', async () => {
  for (const transform of [
    (defs) => { defs.find((d) => d.definitionId === 'base').mechanics.abilities = [{ abilityId: 'base:plan', name: '计划', mode: 'activated',
      usage: { key: 'plan', scope: 'pokemon', period: 'turn', limit: 1 }, effects: [plan], sourceOfTruth: EVIDENCE }]; },
    (defs) => { defs.find((d) => d.definitionId === 'base').mechanics.attacks[0].effects = [plan]; },
    (defs) => { defs.find((d) => d.definitionId === 'tool').mechanics.effects = [plan]; },
  ]) {
    const f = await fixture(transform);
    assert.throws(() => board(f), /cn.turnEndEffect@1/);
  }
  const t = await supporter(plan);
  const { g, card } = setup(t, 3);
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  const s = clone(g.snapshot());
  s.playerOngoing.find((e) => e.effect.op === 'turnEndEffect').effect.program = [{ op: 'draw', untilHand: 20 }];
  const forged = OfficialGame.restore(s, { catalog: t.catalog });
  assert.throws(() => endTurn(forged), /turn-end program/);
});
