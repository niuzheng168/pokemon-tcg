// Synthetic definitions only. 「查看自己牌库上方3张卡牌，选择其中任意数量的能量，附着于这只宝可梦身上。将剩余的卡牌以任意顺序重新排列，放回牌库上方。」
// (effects.attach, effects.deck-order; II.C-09, II.D-02, II.C-20): the rest of the look goes back on top in the user's order.
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const horoscope = { op: 'attachDeckEnergy', lookTop: 3, selector: { kind: 'energy' }, quantity: { kind: 'any' },
  recipient: { position: 'self', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient', remainder: 'deckTop', reveal: false };
function stack(s, owner, names) { const p = s.players[owner]; return names.map((n) => { const id = hand(s, owner, n); p.hand.pop(); p.deck.push(id); return id; }); }
const deck = (g) => g.snapshot().players[0].deck;
async function attack() {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
    defs[0].mechanics.attacks[0].printedDamage = null; defs[0].mechanics.attacks[0].cost = [];
    defs[0].mechanics.attacks[0].effects = [binding('cn.attachDeckEnergy@1', horoscope, 'horoscope')];
  });
  return f;
}

test('schema: a bounded look only', () => {
  const v = (p) => handlers.get('cn.attachDeckEnergy@1').validateParameters(clone(p));
  assert(v(horoscope)); assert(!v({ ...horoscope, lookTop: null })); assert(!v({ ...horoscope, remainder: 'deckBottom' }));
});

test('the Energy chosen is attached; the rest goes back on top in the user\'s order, the first uppermost', async () => {
  const f = await attack();
  let water, research, double;
  const g = board(f, (s) => { [water, research, double] = stack(s, 0, ['water', 'research', 'double']); });
  const below = deck(g).slice(0, -3);
  command(g, { type: 'attack', attackId: 'base:strike' });
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'inspect-deck'); assert.deepEqual([...q.options].sort(), [water, double].sort());
  answer(g, [water]);
  q = g.snapshot().pending;
  assert.equal(q.kind, 'deck-energy-recipient'); answer(g, [g.snapshot().players[0].active.id]);
  q = g.snapshot().pending;
  assert.deepEqual([q.kind, q.options, q.minimum, q.maximum, q.ruleId], ['order-cards', [double, research], 2, 2, 'effects.deck-order']);
  assert.deepEqual(deck(g).slice(-3), [water, research, double], 'Nothing moves before the order is chosen.');
  restore(g, f);
  // The saved receipt must keep its chosen cards and their recipients.
  for (const mutate of [(c) => { c.chosen = []; c.assignments = []; }, (c) => { c.assignments = []; }]) {
    const t = g.snapshot(); mutate(t.pending.data.deckChoice);
    assert.throws(() => OfficialGame.restore(t, { catalog: f.catalog }), /receipts|request|deck prompt/);
  }
  answer(g, [research, double]); settle(g);
  assert.deepEqual(deck(g).slice(-2), [double, research]); assert.deepEqual(deck(g).slice(0, -2), below, 'The rest of the deck is not shuffled.');
  assert(g.snapshot().players[0].active.energy.includes(water));
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.deck-order' && e.data.to === 'deckTop' && e.data.count === 2));
});

test('none chosen: all three are ordered; one left: no order to choose', async () => {
  const f = await attack();
  let water, research, double;
  const g = board(f, (s) => { [water, research, double] = stack(s, 0, ['water', 'research', 'double']); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  answer(g, []);
  const q = g.snapshot().pending;
  assert.deepEqual([q.kind, q.options], ['order-cards', [double, research, water]]);
  restore(g, f);
  answer(g, [water, double, research]); settle(g);
  assert.deepEqual(deck(g).slice(-3), [research, double, water]);
  const h = board(f, (s) => { [water, research, double] = stack(s, 0, ['water', 'research', 'double']); });
  command(h, { type: 'attack', attackId: 'base:strike' });
  answer(h, [water, double]); answer(h, [h.snapshot().players[0].active.id]); settle(h);
  assert.equal(deck(h).at(-1), research);
  assert.deepEqual([...h.snapshot().players[0].active.energy].sort(), [water, double].sort());
});
