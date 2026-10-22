// Synthetic definitions only. Deck order (I.H; II.C-02 文例3; II.C-20; II.E-35—36): 「查看…牌库上方N张卡牌，以任意顺序重新排列，
// 放回牌库上方」, 「再放回原处」, 「自己或者对手」, 「或者，放回牌库后重洗」, and cards or Energy put on the top or bottom of a deck.
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, answer, settle, hand, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const arrange = (extra) => ({ side: 'own', from: 'top', count: 3, to: 'top', ...extra });
const item = (effects) => (defs) => { def(defs, 'potion').mechanics.effects = effects; };
// Stack named fixture cards on the top of a player's deck: the last name ends on top.
function stack(s, owner, names) { const p = s.players[owner]; return names.map((n) => { const id = hand(s, owner, n); p.hand.pop(); p.deck.push(id); return id; }); }
const top = (g, owner, n) => g.snapshot().players[owner].deck.slice(-n).reverse();
function play(f, mutate) {
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); mutate(s); });
  command(g, { type: 'playTrainer', cardId: card });
  return g;
}

test('schemas and rule: look at an end of the deck and arrange; deck top/bottom destinations', () => {
  assert(requireRule(CN_V20261019, 'effects.deck-order').sourceOfTruth.some((s) => s.section.includes('II.C-20')));
  for (const p of [arrange(), arrange({ side: 'either', count: 4 }), arrange({ from: 'bottom' }), arrange({ otherwise: 'shuffle' }),
    arrange({ side: 'opponent', count: 1 }), arrange({ to: 'bottom' }), arrange({ to: 'same', count: 2 })])
    assert(valid('cn.arrangeDeck@1', p), JSON.stringify(p));
  const { to: _, ...unplaced } = arrange();
  for (const p of [arrange({ count: 0 }), arrange({ side: 'both' }), arrange({ to: 'middle' }), unplaced, arrange({ to: 'same', otherwise: 'shuffle' }),
    { op: 'arrangeDeck', ...arrange() }])
    assert(!valid('cn.arrangeDeck@1', p), JSON.stringify(p));
  const cards = (extra) => ({ from: 'deck', to: 'deckTop', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 2 }, reveal: false,
    lookTop: null, shuffleAfter: true, ...extra });
  for (const p of [cards(), cards({ lookTop: 5, quantity: { kind: 'exact', count: 1 } }), cards({ from: 'hand', to: 'deckBottom', shuffleAfter: false }),
    cards({ from: 'discard', to: 'deckTop', shuffleAfter: false, reveal: true })])
    assert(valid('cn.cards@1', p), JSON.stringify(p));
  for (const p of [cards({ shuffleAfter: false }), cards({ to: 'deckBottom' }), cards({ from: 'hand', to: 'deckTop', shuffleAfter: true })])
    assert(!valid('cn.cards@1', p), JSON.stringify(p));
  assert(valid('cn.attachedEnergy@1', { op: 'returnEnergy', side: 'opponent', from: 'active', to: 'deckTop', selector: { kind: 'energy' },
    providedTypes: null, measure: 'cards', quantity: { kind: 'exact', count: 1 }, chooser: 'source' }));
});

test('「查看自己牌库上方3张卡牌，以任意顺序重新排列，放回牌库上方」: the user\'s order, first chosen on top', async () => {
  const f = await fixture(item([binding('cn.arrangeDeck@1', arrange(), 'arrange')]));
  let cards;
  const g = play(f, (s) => { cards = stack(s, 0, ['research', 'poison', 'double']); });
  const q = g.view(0).pending;
  assert.deepEqual([q.kind, q.options, q.minimum, q.maximum], ['order-cards', [...cards].reverse(), 3, 3]);
  assert.deepEqual(q.lookedAt.map((c) => c.instanceId), [...cards].reverse());
  assert(g.view(0).events.some((e) => e.ruleId === 'effects.deck-order' && e.data.cards?.length === 3));
  assert(!g.view(1).events.some((e) => e.ruleId === 'effects.deck-order' && e.data.cards));
  restore(g, f);
  answer(g, cards); settle(g);
  assert.deepEqual(top(g, 0, 3), cards);
});

test('the opponent\'s deck, the bottom of a deck, 「再放回原处」, and 「自己或者对手」', async () => {
  const theirs = await fixture(item([binding('cn.arrangeDeck@1', arrange({ side: 'opponent', count: 2 }), 'theirs')]));
  let cards;
  const g = play(theirs, (s) => { cards = stack(s, 1, ['research', 'poison']); });
  assert.equal(g.view(1).pending, null);
  answer(g, cards); settle(g);
  assert.deepEqual(top(g, 1, 2), cards);
  // 「查看自己牌库下方3张卡牌，以任意顺序重新排列，放回牌库下方／上方」: shown from the top down, placed at the printed end.
  for (const to of ['bottom', 'top']) {
    const low = await fixture(item([binding('cn.arrangeDeck@1', arrange({ from: 'bottom', count: 3, to }), 'low')]));
    const h = play(low, () => {});
    const deck = h.snapshot().players[0].deck, bottom = deck.slice(0, 3).reverse(), rest = deck.slice(3);
    assert.deepEqual(h.view(0).pending.options, bottom);
    const picks = [bottom[1], bottom[2], bottom[0]];
    answer(h, picks); settle(h);
    assert.deepEqual(h.snapshot().players[0].deck, to === 'top' ? [...rest, ...[...picks].reverse()] : [...[...picks].reverse(), ...rest]);
  }
  for (const count of [1, 3]) {
    const peek = await fixture(item([binding('cn.arrangeDeck@1', arrange({ count, to: count === 1 ? 'top' : 'same' }), 'peek')]));
    const k = play(peek, () => {});
    const before = clone(k.snapshot().players[0].deck);
    assert.deepEqual([k.view(0).pending.kind, k.view(0).pending.lookedAt.length], ['view-cards', count]);
    settle(k);
    assert.deepEqual(k.snapshot().players[0].deck, before);
  }
  const either = await fixture(item([binding('cn.arrangeDeck@1', arrange({ side: 'either', count: 2 }), 'either')]));
  const e = play(either, (s) => { cards = stack(s, 1, ['research', 'poison']); });
  assert.deepEqual([e.view(0).pending.kind, e.view(0).pending.options], ['choose-deck', ['own', 'opponent']]);
  answer(e, ['opponent']);
  assert.deepEqual(e.view(0).pending.options, [...cards].reverse());
  restore(e, either);
  answer(e, cards); settle(e);
  assert.deepEqual(top(e, 1, 2), cards);
});

test('「或者，放回牌库后重洗牌库」 and 「或者，将那些卡牌全部翻到反面重洗，放回牌库下方」 chosen after looking', async () => {
  for (const otherwise of ['shuffle', 'shuffleBottom']) {
    const f = await fixture(item([binding('cn.arrangeDeck@1', arrange({ otherwise }), 'either-way')]));
    let cards;
    const g = play(f, (s) => { cards = stack(s, 0, ['research', 'poison', 'double']); });
    const q = g.view(0).pending;
    assert.deepEqual([q.kind, q.options, q.lookedAt.length], ['arrange-choice', ['arrange', otherwise], 3]);
    restore(g, f);
    const size = g.snapshot().players[0].deck.length;
    answer(g, [otherwise]); settle(g);
    const deck = g.snapshot().players[0].deck;
    assert.equal(deck.length, size);
    if (otherwise === 'shuffleBottom') assert.deepEqual([...deck.slice(0, 3)].sort(), [...cards].sort());
    assert(g.snapshot().events.some((e) => e.ruleId === 'effects.deck-order' && e.data.result === otherwise));
    const again = play(f, (s) => { cards = stack(s, 0, ['research', 'poison', 'double']); });
    answer(again, ['arrange']);
    assert.equal(again.view(0).pending.kind, 'order-cards');
    answer(again, cards); settle(again);
    assert.deepEqual(top(again, 0, 3), cards);
  }
  const f = await fixture(item([binding('cn.arrangeDeck@1', arrange(), 'arrange')]));
  const g = play(f, () => {});
  const forged = clone(g.snapshot()); forged.players[0].deck.reverse();
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-card-selection');
});

test('「选择自己牌库中任意2张卡牌。将剩余的牌库重洗，将选择的卡牌以任意顺序重新排列，放回牌库上方」; hand and discard to an end', async () => {
  const f = await fixture(item([binding('cn.cards@1', { from: 'deck', to: 'deckTop', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 2 },
    reveal: false, lookTop: null, shuffleAfter: true }, 'tutor')]));
  const g = play(f, () => {});
  const q = g.view(0).pending;
  assert.deepEqual([q.kind, q.minimum, q.maximum], ['order-cards', 2, 2]);
  const picks = [q.options.at(-1), q.options[0]];
  answer(g, picks); settle(g);
  assert.deepEqual(top(g, 0, 2), picks);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0));
  const bottom = await fixture(item([binding('cn.cards@1', { from: 'hand', to: 'deckBottom', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
    reveal: false, lookTop: null, shuffleAfter: false }, 'tuck')]));
  let card;
  const h = play(bottom, (s) => { card = hand(s, 0, 'research'); });
  assert.equal(h.view(0).pending.kind, 'select-cards');
  answer(h, [card]); settle(h);
  assert.equal(h.snapshot().players[0].deck[0], card);
  const back = await fixture(item([binding('cn.cards@1', { from: 'discard', to: 'deckTop', selector: { kind: 'trainer', categories: ['supporter'] },
    quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false }, 'recall')]));
  const k = play(back, (s) => { card = hand(s, 0, 'research'); s.players[0].hand.pop(); s.players[0].discard.push(card); });
  answer(k, [card]); settle(k);
  assert.equal(top(k, 0, 1)[0], card);
});

test('「选择对手战斗宝可梦身上附着的1个能量，放回对手的牌库上方」 and to the bottom', async () => {
  for (const to of ['deckTop', 'deckBottom']) {
    const f = await fixture(item([binding('cn.attachedEnergy@1', { op: 'returnEnergy', side: 'opponent', from: 'active', to,
      selector: { kind: 'energy' }, providedTypes: null, measure: 'cards', quantity: { kind: 'exact', count: 1 }, chooser: 'source' }, 'bounce')]));
    let energy;
    const g = play(f, (s) => { energy = attached(s, 1, s.players[1].active, 'water'); attached(s, 1, s.players[1].active, 'double'); });
    settle(g, (q) => q.kind === 'attached-energy' ? [energy] : q.options.slice(0, q.minimum));
    const deck = g.snapshot().players[1].deck;
    assert.equal(to === 'deckTop' ? deck.at(-1) : deck[0], energy);
  }
});
