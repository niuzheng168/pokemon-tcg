// Synthetic definitions only. 「将自己牌库中的1张基本能量，与附着于自己场上宝可梦身上的1张能量互换，将被换下的能量放回牌库并重洗牌库。」
// (effects.attach, effects.search; II.C-09, I.H, II.E-36). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertDeckEnergyAction } from '../../public/rules/deck-energy.js';
import { fixture, binding, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const brush = { op: 'attachDeckEnergy', lookTop: null, selector: { kind: 'energy', category: 'basic' }, quantity: { kind: 'exact', count: 1 },
  recipient: { position: 'any', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient', remainder: 'shuffleDeck', reveal: false, swap: true };
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);

test('schema: one Basic Energy from the whole deck, one recipient, the deck shuffled', () => {
  const v = (p) => handlers.get('cn.attachDeckEnergy@1').validateParameters(clone(p));
  assert(v(brush));
  for (const p of [{ ...brush, quantity: { kind: 'upTo', count: 1 } }, { ...brush, lookTop: 5 }, { ...brush, remainder: 'hand', lookTop: 5 },
    { ...brush, distribution: 'separateRecipients' }, { ...brush, toHand: 1, distribution: 'separateRecipients' }, { ...brush, recipientEffect: { heal: 30 } },
    { ...brush, swap: false }])
    assert(!v(p), JSON.stringify(p));
  assert.throws(() => assertDeckEnergyAction({ ...brush, swap: false }), /exact printed shape/);
  assert.throws(() => assertDeckEnergyAction({ ...brush, distribution: 'separateRecipients' }), /exact printed shape/);
});

test('the chosen Basic Energy is attached and the chosen attached Energy goes into the deck, then the deck is shuffled', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.attachDeckEnergy@1', brush, 'brush')]; });
  let card, double, water, bare, wet;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion'); double = attached(s, 0, s.players[0].active, 'double');
    wet = bench(s, 0, 'other'); attached(s, 0, wet, 'water'); bare = bench(s, 0, 'other');
  });
  command(g, { type: 'playTrainer', cardId: card });
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'inspect-deck');
  water = q.options[0];
  assert(q.options.every((id) => g.snapshot().cards[id].definitionId === 'water'), 'Basic Energy only.');
  answer(g, [water]);
  q = g.snapshot().pending;
  assert.equal(q.kind, 'deck-energy-recipient');
  assert.deepEqual(q.options, [g.snapshot().players[0].active.id, wet.id], 'Only a Pokémon holding an Energy card.');
  assert(!q.options.includes(bare.id));
  answer(g, [g.snapshot().players[0].active.id]);
  q = g.snapshot().pending;
  assert.deepEqual([q.kind, q.options, q.minimum, q.maximum], ['select-cards', [double], 1, 1]);
  assert(g.snapshot().players[0].deck.includes(water), 'Nothing moves before the swap is chosen.');
  restore(g, f);
  for (const mutate of [(c) => { c.chosen = []; c.assignments = []; }, (c) => { c.assignments = []; }]) {
    const t = g.snapshot(); mutate(t.pending.data.deckChoice);
    assert.throws(() => OfficialGame.restore(t, { catalog: f.catalog }), /receipts|request|deck prompt/);
  }
  answer(g, [double]); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players[0].active.energy, [water]);
  assert(s.players[0].deck.includes(double));
  assert(s.events.some((e) => e.ruleId === 'energy.return' && e.data.energyId === double && e.data.to === 'deckShuffle'));
  const at = (id) => s.events.findIndex((e) => e.ruleId === 'energy.return' && e.data.energyId === id);
  assert(s.events.findLastIndex((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0) > at(double), 'Shuffled after it went into the deck.');
});

test('nothing chosen from the deck: nothing is swapped; no Energy attached to the user\'s Pokémon: not playable', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.attachDeckEnergy@1', brush, 'brush')]; });
  let card, double;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); double = attached(s, 0, s.players[0].active, 'double'); });
  command(g, { type: 'playTrainer', cardId: card }); answer(g, []); settle(g);
  assert.deepEqual(g.snapshot().players[0].active.energy, [double]);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0));
  const dry = board(f, (s) => { card = hand(s, 0, 'potion'); attached(s, 1, s.players[1].active, 'water'); });
  assert.equal(playable(dry, card), false);
});
