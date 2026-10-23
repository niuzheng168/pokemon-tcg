// Synthetic definitions only. 「选择自己手牌中任意数量的基本能量，以任意方式附着于自己的宝可梦身上」 and 「将自己弃牌区中任意数量的
// 【钢】能量，附着于这只宝可梦身上」 (II.D-02: any number, none included). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand } from './fixtures.mjs';

const handlers = createCoreHandlers();
const any = (extra = {}) => ({ type: null, count: 60, benchOnly: false, optional: false, anyNumber: true, ...extra });

test('anyNumber: schema', () => {
  assert(handlers.get('cn.attachHand@1').validateParameters(any()));
  assert(handlers.get('cn.attachDiscard@1').validateParameters(any({ type: 'Water', target: 'self' })));
  for (const bad of [any({ count: 5 }), any({ optional: true }), any({ exact: true }), any({ anyNumber: false })])
    assert(!handlers.get('cn.attachHand@1').validateParameters(bad), JSON.stringify(bad));
});

test('「任意数量」 from the discard pile: none, or every one of them', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.attachDiscard@1', any({ type: 'Water' }), 'any')];
  });
  const run = () => {
    let card;
    const g = board(f, (s) => {
      card = hand(s, 0, 'potion');
      for (let i = 0; i < 3; i++) { const id = hand(s, 0, 'water'); s.players[0].hand.pop(); s.players[0].discard.push(id); }
    });
    command(g, { type: 'playTrainer', cardId: card });
    return g;
  };
  let g = run(), q = g.snapshot().pending;
  assert.equal(q.minimum, 0); assert.equal(q.maximum, 3); assert(q.allowZero);
  answer(g, []); settle(g);
  assert.equal(g.snapshot().players[0].active.energy.length, 0);
  g = run(); q = g.snapshot().pending;
  answer(g, q.options); settle(g);
  assert.equal(g.snapshot().players[0].active.energy.length, 3);
});
