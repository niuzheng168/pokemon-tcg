// Synthetic definitions only. 「双方玩家，各从牌库上方抽取2张卡牌」 and 「对手从牌库上方抽取1张卡牌」 (effects.draw): the effect user draws first,
// then the opponent; a player with too few cards draws what there is (II.A). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const valid = (p) => createCoreHandlers().get('cn.drawPlayers@1').validateParameters(clone(p));

test('「双方玩家，各从牌库上方抽取N张卡牌」: schema', () => {
  assert(valid({ own: 2, opponent: 2 }));
  assert(valid({ own: 0, opponent: 1 }));
  for (const bad of [{ own: 2, opponent: 0 }, { own: 2 }, { own: -1, opponent: 1 }, { own: 1, opponent: 1, extra: 1 }]) assert(!valid(bad));
});

test('both players draw, the user first; an empty deck draws nothing', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.drawPlayers@1', { own: 2, opponent: 2 }, 'both')];
  });
  let card;
  let g = board(f, (s) => { card = hand(s, 0, 'potion'); });
  const before = g.snapshot().players.map((p) => p.hand.length);
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  let s = g.snapshot();
  assert.deepEqual(s.players.map((p) => p.hand.length), [before[0] - 1 + 2, before[1] + 2]);
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
  assert.deepEqual(s.events.filter((e) => e.ruleId === 'effects.draw').slice(-2).map((e) => e.data), [{ player: 0, count: 2 }, { player: 1, count: 2 }]);
  g = board(f, (s) => { card = hand(s, 0, 'potion'); s.players[1].discard.push(...s.players[1].deck.splice(0, s.players[1].deck.length - 1)); });
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  s = g.snapshot();
  assert.equal(s.players[1].deck.length, 0); assert.equal(s.result, null, 'An effect draw from an empty deck is not a loss.');
  const foe = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.drawPlayers@1', { own: 0, opponent: 1 }, 'foe')];
  });
  g = board(foe, (s) => { card = hand(s, 0, 'potion'); s.players[1].discard.push(...s.players[1].deck.splice(0)); });
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card), 'Nothing to draw: the Item changes nothing.');
});
