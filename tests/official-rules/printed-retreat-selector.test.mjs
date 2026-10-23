// Synthetic definitions only. 「【撤退】所需能量为4个的宝可梦」「没有【撤退】所需能量的宝可梦」 (printed Retreat Cost) and
// 「选择自己手牌中的1张【水】或【斗】能量，附着于…」 (either Basic Energy type). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesCardSelector } from '../../public/rules/card-selection.js';
import { effectAttachable } from '../../public/rules/energy-selection.js';
import { fixture, binding, board, command, settle, hand } from './fixtures.mjs';

test('printed Retreat Cost: exactly that many', async () => {
  const f = await fixture();
  const base = f.definitions.find((d) => d.definitionId === 'base');
  assert(matchesCardSelector(base, { kind: 'pokemon', printedRetreatCost: 1 }));
  assert(!matchesCardSelector(base, { kind: 'pokemon', printedRetreatCost: 0 }));
  assert(!matchesCardSelector(f.definitions.find((d) => d.definitionId === 'potion'), { kind: 'pokemon', printedRetreatCost: 1 }));
  assert.throws(() => matchesCardSelector(base, { kind: 'trainer', printedRetreatCost: 1 }), TypeError);
  assert.throws(() => matchesCardSelector(base, { kind: 'pokemon', printedRetreatCost: 10 }), TypeError);
});

test('「【水】或【斗】能量」: a Basic Energy of either type', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.attachHand@1',
      { type: null, types: ['Water', 'Fighting'], count: 1, benchOnly: false, optional: false }, 'attach')];
  });
  const def = (id) => f.definitions.find((d) => d.definitionId === id);
  const p = { type: null, types: ['Fire', 'Fighting'], count: 1, benchOnly: false, optional: false };
  assert(effectAttachable(def('fire'), p, 'hand'));
  assert(!effectAttachable(def('water'), p, 'hand'));
  assert(!effectAttachable(def('double'), p, 'hand'));
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); hand(s, 0, 'water'); hand(s, 0, 'double'); });
  command(g, { type: 'playTrainer', cardId: card });
  const offered = g.snapshot().pending.options.map((id) => g.snapshot().cards[id].definitionId);
  assert(offered.length && offered.every((id) => id === 'water'), 'The Special Energy in hand is not offered.');
  settle(g, (q) => q.options.slice(0, 1));
  const s = g.snapshot();
  assert.equal(s.cards[s.players[0].active.energy.at(-1)].definitionId, 'water');
});
