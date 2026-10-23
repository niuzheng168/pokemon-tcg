// Synthetic definitions only. 「选择…能量，附着于自己的备战宝可梦身上。然后，回复那只宝可梦「120」点HP」 and 「…附着于…身上。然后，
// 在被附着的宝可梦身上放置2个伤害指示物。（对会被【昏厥】的宝可梦，无法使用这个特性。）」: the recipient of each attached card,
// and no recipient whose remaining HP (II.D-16) those counters would use up. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const handlers = createCoreHandlers();
const attach = (extra) => ({ type: 'Water', count: 1, benchOnly: false, optional: false, ...extra });
const item = (handlerId, parameters) => fixture((defs) => {
  defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding(handlerId, parameters, 'attach')];
});
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
function toDiscard(s, id) { const c = hand(s, 0, id); s.players[0].hand.pop(); s.players[0].discard.push(c); return c; }

test('recipient effects: parameters', () => {
  const valid = (p) => handlers.get('cn.attachDiscard@1').validateParameters(p);
  assert(valid(attach({ recipientEffect: { counters: 2 }, spareKnockOut: true })));
  assert(valid(attach({ recipientEffect: { heal: 120 } })));
  for (const bad of [attach({ spareKnockOut: true }), attach({ recipientEffect: { heal: 120 }, spareKnockOut: true }),
    attach({ recipientEffect: { heal: 120, counters: 2 } }), attach({ recipientEffect: { heal: 125 } }), attach({ recipientEffect: {} })])
    assert(!valid(bad), JSON.stringify(bad));
});

test('「然后，在被附着的宝可梦身上放置2个伤害指示物」 spares a Pokémon those counters would Knock Out', async () => {
  const f = await item('cn.attachDiscard@1', attach({ recipientEffect: { counters: 2 }, spareKnockOut: true }));
  let card, energy, spared;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion'); energy = toDiscard(s, 'water'); s.players[0].active.counters = 8; spared = bench(s, 0, 'other');
  });
  command(g, { type: 'playTrainer', cardId: card });
  answer(g, [energy]);
  assert.deepEqual(g.snapshot().pending.options, [spared.id], 'The Active has 20 HP left: 2 counters would Knock It Out.');
  answer(g, [spared.id]); settle(g);
  const m = g.snapshot().players[0].bench.find((x) => x.id === spared.id);
  assert(m.energy.includes(energy)); assert.equal(m.counters, 2);
  const none = board(f, (s) => { card = hand(s, 0, 'potion'); toDiscard(s, 'water'); s.players[0].active.counters = 8; });
  assert(!playable(none, card), 'Every own Pokémon would be Knocked Out.');
});

test('「然后，回复那只宝可梦「120」点HP」 heals the Pokémon the card was attached to', async () => {
  const f = await item('cn.attachHand@1', attach({ type: null, category: 'any', benchOnly: true, recipientEffect: { heal: 120 } }));
  let card, energy, hurt;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); energy = hand(s, 0, 'water'); hurt = bench(s, 0, 'other'); hurt.counters = 5; });
  command(g, { type: 'playTrainer', cardId: card });
  answer(g, [energy]); settle(g);
  const m = g.snapshot().players[0].bench.find((x) => x.id === hurt.id);
  assert(m.energy.includes(energy)); assert.equal(m.counters, 0);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.heal' && e.data.effectId === 'fixture:attach'));
});
