// Synthetic definitions only. 「查看自己牌库上方N张卡牌，选择其中…。将剩余的卡牌放于弃牌区／加入手牌／（以任意顺序重新排列）
// 放回牌库上方／下方／全部翻到反面重洗，放回牌库下方」: the looked-at cards not chosen go where printed, without shuffling the
// rest of the deck. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertDeckEnergyAction } from '../../public/rules/deck-energy.js';
import { fixture, binding, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers();
const look = (extra) => ({ from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
  reveal: false, lookTop: 3, shuffleAfter: false, ...extra });
const energy = (extra) => ({ op: 'attachDeckEnergy', lookTop: 3, selector: { kind: 'energy', category: 'basic', types: ['Water'] },
  quantity: { kind: 'any' }, recipient: { position: 'active', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient',
  remainder: 'hand', reveal: false, ...extra });
const item = (handlerId, parameters) => fixture((defs) => {
  defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding(handlerId, parameters, 'look')];
});
// The listed cards become the top of the own deck, the first uppermost; returns their instance IDs top first.
function stack(s, topFirst) {
  const ids = topFirst.map((id) => { const card = hand(s, 0, id); s.players[0].hand.pop(); return card; });
  s.players[0].deck.push(...[...ids].reverse());
  return ids;
}
function play(f, topFirst) {
  let card, ids;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); ids = stack(s, topFirst); });
  command(g, { type: 'playTrainer', cardId: card });
  return { g, ids };
}

test('cn.cards@1 remainder: parameters', () => {
  const valid = (p) => handlers.get('cn.cards@1').validateParameters(clone(p));
  for (const remainder of ['discard', 'hand', 'deckTop', 'deckBottom', 'lost'])
    assert.equal(valid(look({ remainder, to: remainder === 'hand' ? 'discard' : 'hand' })), true, remainder);
  for (const bad of [look({ remainder: 'discard', lookTop: null, shuffleAfter: true }), look({ remainder: 'discard', shuffleAfter: true }),
    look({ remainder: 'discard', to: 'discard' }), look({ remainder: 'hand' }), look({ remainder: 'prizes' }),
    look({ remainder: 'deckTop', from: 'discard', lookTop: null }), look({ remainder: 'deckTop', to: 'bench', shuffleAfter: true })])
    assert.equal(valid(bad), false, JSON.stringify(bad));
});

test('「将剩余的卡牌放于弃牌区」 and 「将剩余的卡牌加入手牌」, also when nothing matches', async () => {
  let { g, ids } = play(await item('cn.cards@1', look({ remainder: 'discard' })), ['water', 'research', 'double']);
  assert.deepEqual(g.snapshot().pending.options, [...ids].reverse());
  answer(g, [ids[0]]); settle(g);
  let p = g.snapshot().players[0];
  assert(p.hand.includes(ids[0]) && ids.slice(1).every((id) => p.discard.includes(id) && !p.deck.includes(id)));
  ({ g, ids } = play(await item('cn.cards@1', look({ remainder: 'hand', to: 'discard', quantity: { kind: 'upTo', count: 1 } })),
    ['water', 'research', 'double']));
  answer(g, [ids[0]]); settle(g);
  p = g.snapshot().players[0];
  assert(p.discard.includes(ids[0]) && ids.slice(1).every((id) => p.hand.includes(id)));
  ({ g, ids } = play(await item('cn.cards@1', look({ remainder: 'discard', selector: { kind: 'trainer', categories: ['stadium'] } })),
    ['water', 'research', 'double']));
  assert.equal(g.snapshot().pending.kind, 'view-cards');
  answer(g, ['confirm']); settle(g);
  assert(ids.every((id) => g.snapshot().players[0].discard.includes(id)), 'Nothing chosen: all three are the rest.');
});

test('「将剩余的卡牌以任意顺序重新排列，放回牌库下方／上方」: the user orders several; one stays where it is', async () => {
  const f = await item('cn.cards@1', look({ remainder: 'deckBottom' }));
  const { g, ids } = play(f, ['water', 'research', 'double']);
  answer(g, [ids[0]]);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'order-cards'); assert.deepEqual([...q.options].sort(), [ids[1], ids[2]].sort());
  assert.deepEqual([q.minimum, q.maximum], [2, 2]);
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  const moved = clone(g.snapshot()); moved.players[0].hand.push(moved.players[0].deck.pop());
  assert.throws(() => OfficialGame.restore(moved, { catalog: f.catalog }), /top of the deck/);
  assert.throws(() => answer(g, [ids[1], ids[1]]));
  answer(g, [ids[2], ids[1]]); settle(g);
  assert.deepEqual(g.snapshot().players[0].deck.slice(0, 2), [ids[1], ids[2]], 'The first chosen ends uppermost.');
  const top = play(await item('cn.cards@1', look({ remainder: 'deckTop', lookTop: 2 })), ['water', 'research']);
  answer(top.g, [top.ids[0]]);
  assert.equal(top.g.snapshot().pending, null, 'One card has one order.');
  assert.equal(top.g.snapshot().players[0].deck.at(-1), top.ids[1]);
});

test('cn.attachDeckEnergy@1 remainder: hand, discard or shuffled to the bottom; only for a bounded window', async () => {
  assert.equal(handlers.get('cn.attachDeckEnergy@1').validateParameters(energy({ lookTop: null })), false);
  assert.throws(() => assertDeckEnergyAction(energy({ lookTop: null })));
  assert.throws(() => assertDeckEnergyAction(energy({ remainder: 'lost' })));
  for (const remainder of ['hand', 'discard', 'shuffleToBottom']) {
    assert.equal(handlers.get('cn.attachDeckEnergy@1').validateParameters(energy({ remainder })), true);
    const { g, ids } = play(await item('cn.attachDeckEnergy@1', energy({ remainder })), ['water', 'research', 'tool']);
    answer(g, [ids[0]]); settle(g);
    const s = g.snapshot(), p = s.players[0];
    assert(p.active.energy.includes(ids[0]));
    const rest = ids.slice(1);
    if (remainder === 'hand') assert(rest.every((id) => p.hand.includes(id)));
    if (remainder === 'discard') assert(rest.every((id) => p.discard.includes(id)));
    if (remainder === 'shuffleToBottom') assert.deepEqual([...p.deck.slice(0, 2)].sort(), [...rest].sort());
    assert(!s.events.some((e) => e.ruleId === 'effects.shuffle' && e.data.effectId === 'fixture:look' && !e.data.subset), 'The deck is not shuffled.');
  }
  const { g, ids } = play(await item('cn.attachDeckEnergy@1', energy({ remainder: 'discard' })), ['research', 'tool', 'double']);
  assert.equal(g.snapshot().pending.kind, 'inspect-deck');
  answer(g, []); settle(g);
  assert(ids.every((id) => g.snapshot().players[0].discard.includes(id)), 'No Energy chosen: all three are the rest.');
});
