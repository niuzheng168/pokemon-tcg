// Synthetic definitions only. 「将对手牌库上方5张卡牌翻到正面，选择其中任意数量的【基础】宝可梦，放于对手的备战区。将剩余的卡牌放回牌库并重洗牌库。」
// (effects.reveal, II.C-11, II.D-02, II.E-36): every looked-at card is shown to both players. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const flute = { from: 'deck', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] }, quantity: { kind: 'any' }, reveal: false, lookTop: 5,
  shuffleAfter: true, side: 'opponent', revealAll: true };
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
function stack(s, owner, names) { const p = s.players[owner]; return names.map((n) => { const id = hand(s, owner, n); p.hand.pop(); p.deck.push(id); return id; }); }
const shown = (g, viewer) => g.view(viewer).events.filter((e) => e.ruleId === 'effects.reveal' && e.data.cards);

test('schema: every looked-at card shown, from a bounded look at a deck', () => {
  const v = (p) => handlers.get('cn.cards@1').validateParameters(clone(p));
  assert(v(flute)); assert(v({ ...flute, side: undefined, to: 'hand', quantity: { kind: 'exact', count: 1 } }));
  for (const p of [{ ...flute, lookTop: null }, { ...flute, reveal: true }, { ...flute, from: 'discard', lookTop: null, shuffleAfter: false }])
    assert(!v(p), JSON.stringify(p));
});

test('both players see the five cards; the user puts any number of the Basic Pokémon onto the opponent\'s Bench; the rest shuffled back', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.cards@1', flute, 'flute')]; });
  let card, five;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); five = stack(s, 1, ['research', 'water', 'evolution', 'other', 'base']); });
  assert(playable(g, card));
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'select-cards'); assert.equal(q.player, 0);
  assert.deepEqual(q.options, [five[3], five[4]], 'Only the Basic Pokémon among them.');
  assert.deepEqual([q.minimum, q.maximum], [0, 2]);
  for (const viewer of [0, 1]) assert.deepEqual(shown(g, viewer).at(-1).data.cardIds, [...five].reverse(), `player ${viewer} sees all five`);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  answer(g, [five[3]]); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].bench.length, 1); assert.equal(s.players[1].bench[0].stack[0], five[3]);
  assert(s.events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 1));
  assert.equal(shown(g, 0).length, 1, 'Shown once.');
});

test('no Basic Pokémon among them: still shown; a full opponent\'s Bench: cannot be played (II.C-11)', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.cards@1', flute, 'flute')]; });
  f.deck.splice(-4, 4, 'printing:base', 'printing:base', 'printing:other', 'printing:other');
  let card, five;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); five = stack(s, 1, ['research', 'water', 'evolution', 'water', 'poison']); });
  command(g, { type: 'playTrainer', cardId: card });
  assert.equal(g.snapshot().pending.kind, 'view-cards');
  assert.deepEqual(shown(g, 1).at(-1).data.cardIds, [...five].reverse());
  settle(g, () => ['confirm']);
  assert.equal(g.snapshot().players[1].bench.length, 0);
  const full = board(f, (s) => { card = hand(s, 0, 'potion'); for (let i = 0; i < 5; i++) bench(s, 1, i % 2 ? 'other' : 'base'); });
  assert.equal(playable(full, card), false);
});
