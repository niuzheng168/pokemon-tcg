// Synthetic definitions only. 「选择对手反面朝上的1张奖赏卡，以及在不看正面的前提下选择对手1张手牌，各查看其正面。若希望，可以令对手将被选择的
// 卡牌互换。（在对战结束前，那张奖赏卡一直保持正面朝上状态。）」 (prizes.zone, prizes.face-up; II.C-20, II.D-04 文例2; JP Q&A
// ロケット団のおじゃまロボ). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const bot = { op: 'lookPrizeHand', side: 'opponent' };
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const item = () => fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.prizeZone@1', bot, 'bot')]; });
const picked = (g) => g.view(0).events.filter((e) => e.ruleId === 'effects.opponent-hand' && e.data.picked).at(-1)?.data.picked[0];

test('schema and sources: the opponent\'s Prize and hand only', () => {
  const v = (p) => handlers.get('cn.prizeZone@1').validateParameters(clone(p));
  assert(v(bot)); assert(!v({ ...bot, side: 'own' })); assert(!v({ op: 'lookPrizeHand' })); assert(!v({ ...bot, count: 1 }));
  assert(requireRule(CN_V20261019, 'prizes.zone').sourceOfTruth.filter((x) => x.section.includes('ロケット団のおじゃまロボ')).length === 2);
});

test('a face-down Prize turned face up and a random hand card looked at; the user may have them switched', async () => {
  const f = await item();
  for (const choice of ['perform', 'skip']) {
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'potion'); for (const n of ['research', 'poison', 'stadium']) hand(s, 1, n); });
    assert(playable(g, card));
    command(g, { type: 'playTrainer', cardId: card });
    let q = g.snapshot().pending;
    assert.deepEqual([q.kind, q.player, q.options.length, q.minimum, q.maximum], ['prize-slot', 0, 6, 1, 1]);
    answer(g, ['2']);
    const prize = g.snapshot().players[1].prizes[2], seen = picked(g);
    assert(g.snapshot().players[1].hand.includes(seen));
    assert.deepEqual(g.snapshot().players[1].faceUpPrizes, [prize]);
    assert(g.view(1).events.some((e) => e.ruleId === 'prizes.face-up' && e.data.cards[0].instanceId === prize), 'Both players see the Prize.');
    assert(!g.view(1).events.some((e) => e.data.picked), 'The hand card is the user\'s look only.');
    q = g.view(0).pending;
    assert.equal(q.kind, 'optional-effect'); assert.deepEqual(q.lookedAt.map((c) => c.instanceId), [prize, seen]);
    restore(g, f);
    for (const mutate of [(d) => { d.chosen = [prize]; }, (d) => { d.lookedAt = [g.snapshot().players[1].prizes[0]]; }]) {
      const t = g.snapshot(); mutate(t.pending.data);
      assert.throws(() => OfficialGame.restore(t, { catalog: f.catalog }), /Prize choice/);
    }
    answer(g, [choice]); settle(g);
    const p = g.snapshot().players[1];
    if (choice === 'perform') {
      assert.equal(p.prizes[2], seen); assert(p.hand.includes(prize) && !p.hand.includes(seen));
      assert.equal(p.faceUpPrizes, undefined, 'The card put into the Prizes is placed face down.');
    } else {
      assert.equal(p.prizes[2], prize); assert.deepEqual(p.faceUpPrizes, [prize], 'That Prize stays face up.'); assert(p.hand.includes(seen));
    }
  }
});

test('JP Q&A: no hand card — the Prize is turned face up; every Prize face up — one hand card is looked at; neither — not playable', async () => {
  const f = await item();
  let card;
  const empty = board(f, (s) => { card = hand(s, 0, 'potion'); s.players[1].deck.push(...s.players[1].hand.splice(0)); });
  command(empty, { type: 'playTrainer', cardId: card }); answer(empty, ['0']);
  assert.equal(empty.snapshot().pending, null);
  assert.equal(empty.snapshot().players[1].faceUpPrizes.length, 1);
  const open = board(f, (s) => { card = hand(s, 0, 'potion'); hand(s, 1, 'research'); s.players[1].faceUpPrizes = [...s.players[1].prizes]; });
  const prizes = clone(open.snapshot().players[1].prizes);
  command(open, { type: 'playTrainer', cardId: card });
  const q = open.view(0).pending;
  assert.equal(q.kind, 'view-cards'); assert.deepEqual(q.lookedAt.map((c) => c.instanceId), [picked(open)]);
  restore(open, f);
  settle(open, () => ['confirm']);
  assert.deepEqual(open.snapshot().players[1].prizes, prizes, 'Nothing switched.');
  const neither = board(f, (s) => { card = hand(s, 0, 'potion'); s.players[1].deck.push(...s.players[1].hand.splice(0)); s.players[1].faceUpPrizes = [...s.players[1].prizes]; });
  assert.equal(playable(neither, card), false);
});
