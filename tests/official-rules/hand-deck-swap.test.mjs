// Synthetic definitions only. 「选择自己的1张手牌，将其与牌库上方的卡牌互换」 (effects.hand-deck-swap) and
// 「…。然后，抛掷1次硬币如果为正面，则不将这张卡放于弃牌区，而是放回手牌」 (effects.return-self, effects.partial). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { randomIndex } from '../../public/rules/random.js';
import { fixture, binding, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const handlers = createCoreHandlers();
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const item = (...effects) => fixture((defs) => { defs.find((d) => d.definitionId === 'potion').mechanics.effects = effects; });
const seedFor = (heads) => {
  for (let i = 1; i <= 8192; i++) {
    const seed = [Math.imul(i, 8000009) >>> 0, Math.imul(i, 333333331) >>> 0, Math.imul(i, 17) >>> 0, Math.imul(i, 37) >>> 0], rng = [...seed];
    if ((randomIndex(rng, 2) === 0) === heads) return seed;
  }
  throw new Error('No fixture seed.');
};
const setup = (f, mutate = () => {}) => {
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); mutate(s); });
  return { g, card };
};
const playable = (f, mutate) => { const { g, card } = setup(f, mutate); return g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card); };
const back = leaf('cn.coin@1', { outcome: 'heads', effect: leaf('cn.returnSelf@1', {}) });

test('schema', () => {
  assert(handlers.get('cn.handDeckSwap@1').validateParameters({}));
  assert(!handlers.get('cn.handDeckSwap@1').validateParameters({ count: 1 }));
  const then = (p) => handlers.get('cn.then@1').validateParameters(p);
  assert(then({ first: leaf('cn.draw@1', { count: 1 }), next: back }));
  assert(!then({ first: leaf('cn.draw@1', { count: 1 }), next: leaf('cn.coin@1', { outcome: 'heads' }) }));
  assert(!then({ first: leaf('cn.coin@1', { outcome: 'heads', effect: leaf('cn.returnSelf@1', {}) }), next: back }));
});

test('a hand card swaps with the top card of the deck; only its owner sees which', async () => {
  const f = await item(binding('cn.handDeckSwap@1', {}, 'swap'));
  const { g, card } = setup(f);
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'select-cards'); assert.equal(q.minimum, 1); assert(!q.options.includes(card));
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  const chosen = q.options[0], top = g.snapshot().players[0].deck.at(-1);
  answer(g, [chosen]); settle(g);
  const p = g.snapshot().players[0];
  assert.equal(p.deck.at(-1), chosen); assert(p.hand.includes(top)); assert(!p.hand.includes(chosen));
  assert(g.view(0).events.some((e) => e.ruleId === 'effects.hand-deck-swap' && e.data.toDeck === chosen));
  assert(!g.view(1).events.some((e) => e.ruleId === 'effects.hand-deck-swap' && e.data.toDeck));
  assert.equal(playable(f, (s) => { s.players[0].discard.push(...s.players[0].hand.splice(0, s.players[0].hand.length - 1)); }), false, 'Nothing else in hand to swap.');
  assert.equal(playable(f, (s) => { s.players[0].discard.push(...s.players[0].deck.splice(0)); }), false, 'No deck to swap with.');
});

test('「然后，抛掷1次硬币如果为正面，则将这张卡加入手牌」: heads returns the used card to hand; tails discards it', async () => {
  const f = await item(binding('cn.then@1', { first: leaf('cn.draw@1', { count: 1 }), next: back }, 'draw-then-back'));
  for (const heads of [true, false]) {
    const { g, card } = setup(f, (s) => { s.rng = seedFor(heads); });
    const before = g.snapshot().players[0].hand.length;
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    const s = g.snapshot(), p = s.players[0];
    assert.equal(p.hand.includes(card), heads); assert.equal(p.discard.includes(card), !heads);
    assert.equal(p.hand.length, before - 1 + 1 + (heads ? 1 : 0));
    assert.equal(s.events.filter((e) => e.ruleId === 'effects.return-self').length, heads ? 1 : 0);
    assert.deepEqual(restore(g, f).snapshot(), s);
  }
  // Nothing drawn (an empty deck): the 「然后」 part is not reached, so the card cannot be played at all.
  assert.equal(playable(f, (s) => { s.players[0].discard.push(...s.players[0].deck.splice(0)); }), false);
});

test('outside a Trainer in use, returning "this card" does nothing', async () => {
  const f = await fixture((defs) => {
    const base = defs.find((d) => d.definitionId === 'base');
    base.mechanics.attacks[0].effects = [binding('cn.returnSelf@1', {}, 'nothing')];
  });
  const g = board(f, (s) => { const p = s.players[0]; const i = p.deck.findIndex((id) => s.cards[id].definitionId === 'water'); p.active.energy.push(p.deck.splice(i, 1)[0]); });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.return-self'));
});

test('a returning card is itself a change: a Trainer whose only effect is the coin may be played', async () => {
  const f = await item(binding('cn.coin@1', { outcome: 'heads', effect: leaf('cn.returnSelf@1', {}) }, 'lucky'));
  assert(playable(f));
});
