// Synthetic definitions only. 「宝可梦 V-UNION 的放置方法：对战中有1次机会，在自己的回合，可将自己弃牌区中的4种X V-UNION 组合起来，放于备战区。」
// and 「V-UNION规则：当宝可梦 V-UNION 昏厥时，对手将拿取3张奖赏卡。」 (pokemon.v-union). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { validateDeck } from '../../public/rules/catalog.js';
import { fixture, EVIDENCE, board, command, settle, hand, attached, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const piece = (base, n) => ({ ...base, definitionId: `vu${n}`, name: '测试V-UNION', nameKey: 'vu',
  mechanics: { ...base.mechanics, stage: 'V-UNION', hp: 310, ruleBox: true, prizeCount: 3, tags: ['V', 'V-UNION'],
    attacks: base.mechanics.attacks.map((a) => ({ ...a, attackId: `vu${n}:strike` })), vUnion: { piece: n, sourceOfTruth: EVIDENCE } } });
async function withUnion(more = () => {}) {
  const f = await fixture((defs) => { defs.push(...[1, 2, 3, 4].map((n) => piece(def(defs, 'base'), n))); more(defs); });
  f.deck.splice(20, 8, 'printing:vu1', 'printing:vu2', 'printing:vu3', 'printing:vu4', 'printing:base', 'printing:base', 'printing:other', 'printing:other');
  return f;
}
const toDiscard = (s, owner, id) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner].discard.push(card); return card; };
const unions = (g) => g.view(g.snapshot().current).legalActions.filter((a) => a.type === 'vUnion');

test('pokemon.v-union: the four pieces from the discard pile onto the Bench as one Pokémon, once per game', async () => {
  const f = await withUnion();
  let pieces;
  const g = board(f, (s) => { pieces = [3, 1, 4, 2].map((n) => toDiscard(s, 0, `vu${n}`)); });
  const order = [1, 2, 3, 4].map((n) => pieces[[3, 1, 4, 2].indexOf(n)]);
  assert.deepEqual(unions(g), [{ type: 'vUnion', cardIds: order }], 'In printed piece order.');
  command(g, unions(g)[0]); settle(g);
  let s = g.snapshot();
  const m = s.players[0].bench[0];
  assert.deepEqual(m.stack, order); assert.equal(s.players[0].discard.filter((id) => order.includes(id)).length, 0);
  const v = g.view(0).players[0].bench[0];
  assert.equal(v.effective.maxHp, 310);
  assert(s.events.some((e) => e.ruleId === 'pokemon.v-union' && e.data.nameKey === 'vu'));
  restore(g, f);
  // Knocked Out: three Prize cards, all four pieces to the discard pile; no second assembly in this game.
  s = g.snapshot(); const p = s.players[0]; [p.active, p.bench[0]] = [p.bench[0], p.active]; p.active.counters = 31;
  s.current = 0;
  const h = OfficialGame.restore(s, { catalog: f.catalog });
  command(h, { type: 'endTurn' }); settle(h);
  s = h.snapshot();
  assert.equal(s.players[1].prizes.length, 3);
  assert(order.every((id) => s.players[0].discard.includes(id)));
  command(h, { type: 'endTurn' }); settle(h);
  assert.deepEqual(unions(h), [], 'Once per game.');
});

test('pokemon.v-union: never from the hand or at setup, not with three pieces or a full Bench; no Basic Pokémon card', async () => {
  const f = await withUnion();
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'vu1'); [2, 3, 4].forEach((n) => toDiscard(s, 0, `vu${n}`)); });
  assert(!g.view(0).legalActions.some((a) => a.cardId === card));
  assert.deepEqual(unions(g), []);
  const full = board(f, (s) => { [1, 2, 3, 4].forEach((n) => toDiscard(s, 0, `vu${n}`)); for (let i = 0; i < 5; i++) bench(s, 0, i % 2 ? 'other' : 'base'); });
  assert.deepEqual(unions(full), []);
  assert.throws(() => validateDeck(f.catalog, ['printing:vu1', ...Array(59).fill('printing:water')]), /Basic Pokémon/);
  await assert.rejects(fixture((defs) => { const d = piece(def(defs, 'base'), 1); delete d.mechanics.vUnion; defs.push(d); }));
});

test('pokemon.v-union: its attack from the combined Pokémon, as any Benched-then-Active Pokémon', async () => {
  const f = await withUnion();
  const g = board(f, (s) => { [1, 2, 3, 4].forEach((n) => toDiscard(s, 0, `vu${n}`)); });
  command(g, unions(g)[0]); settle(g);
  const s = g.snapshot(), p = s.players[0]; [p.active, p.bench[0]] = [p.bench[0], p.active];
  attached(s, 0, p.active, 'water');
  const h = OfficialGame.restore(s, { catalog: f.catalog });
  command(h, { type: 'attack', attackId: 'vu4:strike' }); settle(h);
  assert.equal(h.snapshot().players[1].active.counters, 2);
});
