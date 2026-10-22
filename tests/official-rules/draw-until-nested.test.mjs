// Synthetic definitions only. 「（若希望，可）从牌库上方抽取卡牌，直到自己的手牌变为N张为止」 (I.H; II.A): the hand is counted
// when the draw begins, so under 「若希望」, after the first part of 「然后」 or on a coin it reads the hand that part left.
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { validateOptionalEffect, validateThenEffect, validateCoinEffect } from '../../public/rules/handlers.js';
import { validateEffectProgram } from '../../public/rules/schema-validators.js';
import { randomIndex } from '../../public/rules/random.js';
import { fixture, binding, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const nested = (handlerId, parameters) => ({ handlerId, parameters });
const until = (count) => nested('cn.drawUntil@1', { count });
const discardOne = nested('cn.cards@1', { from: 'hand', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
  reveal: false, lookTop: null, shuffleAfter: false });
const item = (handlerId, parameters) => (defs) => { def(defs, 'potion').mechanics.effects = [binding(handlerId, parameters, 'draw')]; };
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
// Only the played card and `extra` more in hand.
function handOf(s, extra) {
  const p = s.players[0];
  p.discard.push(...p.hand.splice(0));
  const card = hand(s, 0, 'potion');
  for (let i = 0; i < extra; i++) hand(s, 0, 'water');
  return card;
}
function forceCoin(s, result) {
  for (let k = 1; ; k++) {
    const rng = [k, k * 7 + 1, k * 13 + 2, k * 31 + 3];
    if (randomIndex([...rng], 2) === (result === 'heads' ? 0 : 1)) { s.rng = rng; return; }
  }
}

test('validators and program: a draw-until leaf nests like any static leaf', () => {
  assert(validateOptionalEffect({ effect: until(6) }));
  assert(validateThenEffect({ first: discardOne, next: until(5) }));
  assert(validateCoinEffect({ outcome: 'heads', effect: until(4) }));
  assert(validateEffectProgram([{ op: 'optional', effect: { op: 'sequence', steps: [{ op: 'draw', untilHand: 6 }] } }]));
  assert(!validateEffectProgram([{ op: 'draw', untilHand: 6, count: 1 }]));
  assert(!validateEffectProgram([{ op: 'draw', untilHand: -1 }]));
});

test('「若希望，可从牌库上方抽取卡牌，直到自己的手牌变为6张为止」: declined draws nothing; with 6 cards it cannot be played', async () => {
  const f = await fixture(item('cn.optional@1', { effect: until(6) }));
  for (const perform of [false, true]) {
    let card;
    const g = board(f, (s) => { card = handOf(s, 2); });
    command(g, { type: 'playTrainer', cardId: card });
    assert.equal(g.view(0).pending.kind, 'optional-effect');
    OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
    answer(g, [perform ? 'perform' : 'skip']); settle(g);
    assert.equal(g.snapshot().players[0].hand.length, perform ? 6 : 2);
    OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  }
  let card;
  assert(!playable(board(f, (s) => { card = handOf(s, 6); }), card), 'Nothing would change.');
});

test('「将1张手牌放于弃牌区。然后，抽取卡牌，直到自己的手牌变为5张为止」 counts the hand after the discard', async () => {
  const f = await fixture(item('cn.then@1', { first: discardOne, next: until(5) }));
  let card;
  const g = board(f, (s) => { card = handOf(s, 3); });
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.view(0).pending, discarded = q.options[0];
  answer(g, [discarded]); settle(g);
  const p = g.snapshot().players[0];
  assert.equal(p.hand.length, 5, 'Three cards, one discarded: three drawn.');
  assert(p.discard.includes(discarded));
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.draw' && e.data.count === 3));
});

test('a coin: 「如果为正面，则抽取卡牌，直到自己的手牌变为4张为止」', async () => {
  const f = await fixture(item('cn.coin@1', { outcome: 'heads', effect: until(4) }));
  for (const result of ['heads', 'tails']) {
    let card;
    const g = board(f, (s) => { card = handOf(s, 1); forceCoin(s, result); });
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    assert.equal(g.snapshot().players[0].hand.length, result === 'heads' ? 4 : 1);
  }
});
