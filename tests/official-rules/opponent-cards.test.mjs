// Synthetic definitions only. 「选择对手弃牌区中的1张【基础】宝可梦，放于对手的备战区」 and 「查看对手牌库上方5张卡牌，选择其中任意数量的物品，
// 放于弃牌区。将剩余的卡牌放回牌库并重洗牌库」: the opponent's cards go to the opponent's zones; the effect user chooses.
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const valid = (p) => createCoreHandlers().get('cn.cards@1').validateParameters(clone(p));
const revive = { from: 'discard', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] }, quantity: { kind: 'exact', count: 1 },
  reveal: false, lookTop: null, shuffleAfter: false, side: 'opponent' };
const mill = { from: 'deck', to: 'discard', selector: { kind: 'trainer', categories: ['item'] }, quantity: { kind: 'any' },
  reveal: false, lookTop: 5, shuffleAfter: true, side: 'opponent' };

test('the opponent\'s zones: schema', () => {
  assert(valid(revive)); assert(valid(mill));
  for (const bad of [{ ...revive, from: 'hand' }, { ...mill, remainder: 'hand', to: 'discard', shuffleAfter: false }, { ...revive, side: 'own' }])
    assert(!valid(bad), JSON.stringify(bad));
});

test('the opponent\'s discard pile to the opponent\'s Bench; the opponent\'s deck top to their discard pile', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.cards@1', revive, 'revive')];
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [binding('cn.cards@1', mill, 'mill')];
  });
  let card, gone;
  let g = board(f, (s) => { card = hand(s, 0, 'potion'); gone = hand(s, 1, 'other'); s.players[1].hand.pop(); s.players[1].discard.push(gone); });
  assert(!board(f, (s) => { card = hand(s, 0, 'potion'); }).view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card),
    'Nothing in the opponent\'s discard pile.');
  command(g, { type: 'playTrainer', cardId: card });
  assert.equal(g.snapshot().pending.player, 0);
  settle(g);
  let s = g.snapshot();
  assert.deepEqual(s.players[1].bench.map((m) => m.stack[0]), [gone]);
  assert.equal(s.players[0].bench.length, 0);
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
  g = board(f, (s) => {
    card = hand(s, 0, 'research');
    const p = s.players[1], item = p.deck.findIndex((id) => s.cards[id].definitionId === 'potion');
    p.deck.push(p.deck.splice(item, 1)[0]);
  });
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.snapshot().pending;
  assert.equal(q.player, 0);
  const items = q.options;
  assert(items.length && items.every((id) => ['potion', 'poison'].includes(g.snapshot().cards[id].definitionId) && g.snapshot().cards[id].owner === 1));
  settle(g, (q) => q.options);
  s = g.snapshot();
  assert(items.every((id) => s.players[1].discard.includes(id)), 'Into their owner\'s discard pile.');
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
});
