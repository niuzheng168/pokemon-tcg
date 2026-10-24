// Synthetic definitions only. Deck order (effects.deck-order; I.H; II.C-20; II.D-04): 「在自己的回合可以使用1次。查看对手牌库上方2张卡牌，
// 选择其中1张卡牌，放回牌库上方。将剩余的卡牌，放回牌库下方。」 and 「在自己的回合可以使用1次。在不看正面的前提下，将对手牌库上方的1张卡牌，
// 放回对手的牌库下方。」 No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.arrangeDeck@1').validateParameters(clone(p));
const stargaze = { side: 'opponent', from: 'top', count: 2, to: 'top', choose: 1, rest: 'bottom' };
const tail = { side: 'opponent', from: 'top', count: 1, to: 'bottom', unseen: true };
const ability = (effect) => (defs) => {
  defs[0].mechanics.abilities = [{ abilityId: 'peek', name: '测试观星', mode: 'activated', usage: { period: 'turn', scope: 'pokemon', key: 'peek', limit: 1 },
    effects: [binding('cn.arrangeDeck@1', effect, 'peek')], sourceOfTruth: EVIDENCE }];
};
const use = (g) => command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'peek' }, 0);
const usable = (g) => g.view(0).legalActions.some((a) => a.abilityId === 'peek');
// Stack named fixture cards on the top of a player's deck: the last name ends on top.
function stack(s, owner, names) { const p = s.players[owner]; return names.map((n) => { const id = hand(s, owner, n); p.hand.pop(); p.deck.push(id); return id; }); }
const deck = (g, owner) => g.snapshot().players[owner].deck;

test('schema: one looked-at card to one end and the rest to the other; one unseen card to the other end', () => {
  assert(requireRule(CN_V20261019, 'effects.deck-order').summary.includes('在不看正面的前提下'));
  for (const p of [stargaze, { ...stargaze, to: 'bottom', rest: 'top', count: 3, side: 'own' }, tail, { ...tail, from: 'bottom', to: 'top', side: 'own' }])
    assert(valid(p), JSON.stringify(p));
  const { rest: _r, ...chooseOnly } = stargaze, { choose: _c, ...restOnly } = stargaze;
  for (const p of [chooseOnly, restOnly, { ...stargaze, rest: 'top' }, { ...stargaze, to: 'same' }, { ...stargaze, count: 1 }, { ...stargaze, choose: 2 },
    { ...stargaze, otherwise: 'shuffle' }, { ...stargaze, unseen: true }, { ...tail, count: 2 }, { ...tail, to: 'top' }, { ...tail, to: 'same' },
    { ...tail, side: 'either' }, { ...tail, otherwise: 'shuffle' }, { ...tail, from: 'bottom' }])
    assert(!valid(p), JSON.stringify(p));
});

test('「查看对手牌库上方2张卡牌，选择其中1张卡牌，放回牌库上方。将剩余的卡牌，放回牌库下方」', async () => {
  const f = await fixture(ability(stargaze));
  let top, second;
  const g = board(f, (s) => { [second, top] = stack(s, 1, ['research', 'poison']); });
  assert(usable(g));
  use(g);
  const q = g.view(0).pending;
  assert.deepEqual([q.kind, q.options, q.minimum, q.maximum], ['select-cards', [top, second], 1, 1]);
  assert.deepEqual(q.lookedAt.map((c) => c.instanceId), [top, second]);
  assert(!g.view(1).events.some((e) => e.ruleId === 'effects.deck-order' && e.data.cards), 'Only the user looks.');
  restore(g, f);
  assert.throws(() => answer(restore(g, f), [top, second]), /quantity/);
  answer(g, [second]); settle(g);
  assert.equal(deck(g, 1).at(-1), second); assert.equal(deck(g, 1)[0], top);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.deck-order' && e.data.rest === 'bottom'));
  // A deck of one card: that card is the one chosen, back on top.
  const lone = board(f, (s) => { s.players[1].discard.push(...s.players[1].deck.splice(0, s.players[1].deck.length - 1)); });
  const only = deck(lone, 1)[0];
  use(lone);
  assert.equal(lone.view(0).pending.kind, 'view-cards');
  settle(lone, () => ['confirm']);
  assert.deepEqual(deck(lone, 1), [only]);
});

test('several cards go back to the other end in the user\'s order (the chosen one to the bottom, the rest on top)', async () => {
  const f = await fixture(ability({ ...stargaze, side: 'own', count: 3, to: 'bottom', rest: 'top' }));
  let x, y, z;
  const g = board(f, (s) => { [z, y, x] = stack(s, 0, ['research', 'poison', 'double']); });
  use(g); answer(g, [x]);
  const q = g.view(0).pending;
  assert.deepEqual([q.kind, q.options, q.minimum, q.maximum], ['order-cards', [y, z], 2, 2]);
  restore(g, f);
  // A saved rest order must keep the chosen card among the looked-at ones.
  for (const chosen of [[], [y, z], ['missing']]) {
    const t = g.snapshot(); t.pending.data.chosen = chosen;
    assert.throws(() => OfficialGame.restore(t, { catalog: f.catalog }), /no longer match/, JSON.stringify(chosen));
  }
  answer(g, [z, y]); settle(g);
  assert.deepEqual(deck(g, 0).slice(-2), [y, z], 'The first chosen ends on top.');
  assert.equal(deck(g, 0)[0], x);
});

test('「在不看正面的前提下，将对手牌库上方的1张卡牌，放回对手的牌库下方」: nobody looks; a deck of one card cannot change', async () => {
  const f = await fixture(ability(tail));
  let top;
  const g = board(f, (s) => { [top] = stack(s, 1, ['research']); });
  const below = deck(g, 1).at(-2);
  use(g);
  assert.equal(g.snapshot().pending, null, 'No choice and no look.');
  assert.equal(deck(g, 1)[0], top); assert.equal(deck(g, 1).at(-1), below);
  assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.deck-order' && e.data.cards));
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.deck-order' && e.data.unseen === true));
  restore(g, f);
  assert(!usable(board(f, (s) => { s.players[1].discard.push(...s.players[1].deck.splice(0, s.players[1].deck.length - 1)); })));
  // The other way: the bottom card of the user's own deck to its top.
  const up = await fixture(ability({ ...tail, side: 'own', from: 'bottom', to: 'top' }));
  const h = board(up, () => {});
  const bottom = deck(h, 0)[0];
  use(h);
  assert.equal(deck(h, 0).at(-1), bottom);
});
