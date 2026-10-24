// Synthetic definitions only. 「身上放有这张卡牌的宝可梦，受到对手宝可梦的招式的伤害而【昏厥】时，因该宝可梦【昏厥】而导致对手拿取的奖赏卡，
// 不会被加入手牌，而是被放于弃牌区。」 and 「只要这只宝可梦在场上，对手拿取的奖赏卡，不会被加入手牌，而会被放入放逐区。」
// (ko.prize-destination). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, attached, bench, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const smoke = { effect: { op: 'prizeModifier', scope: 'self', byOpponentAttack: true, to: 'discard' } };
const lostBlock = { abilityId: 'lost-block', name: '测试放逐拦截', mode: 'continuous', usage: null,
  effects: [binding('cn.prizeDestination@1', { effect: { op: 'prizeDestination', side: 'opponent', to: 'lost' } }, 'lost-block')], sourceOfTruth: EVIDENCE };
const incoming = { abilityId: 'incoming', name: '测试奖赏入手前', mode: 'triggered', usage: null,
  trigger: { event: 'beforeHand', origin: 'prizes', turn: 'own', drawReason: 'any', optional: true, afterUse: 'hand' },
  effects: [binding('cn.draw@1', { count: 1 }, 'incoming-draw')], sourceOfTruth: EVIDENCE };

async function make({ attack = [], transform = () => {} } = {}) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    def(defs, 'base').mechanics.attacks.push({ attackId: 'base:bite', name: '测试咬碎', cost: ['Water'],
      printedDamage: { value: 100, operator: 'fixed' }, effects: attack, sourceOfTruth: EVIDENCE });
    def(defs, 'tool').mechanics.effects = [binding('cn.prizeModifier@1', smoke, 'smoke')];
    def(defs, 'evolution').mechanics.abilities.push(lostBlock);
    def(defs, 'other').mechanics.abilities.push(incoming);
    def(defs, 'poison').mechanics.effects = [binding('cn.takePrizes@1', { count: 1 }, 'take')];
    transform(defs);
  });
}
const equip = (s, owner, m) => { const card = hand(s, owner, 'tool'); s.players[owner].hand.pop(); m.tools.push(card); return card; };
function toPrize(s, owner, id, slot = 0) {
  const card = hand(s, owner, id), p = s.players[owner];
  p.hand.pop(); p.deck.push(p.prizes[slot]); p.prizes[slot] = card;
  return card;
}
function knockOut(f, mutate = () => {}) {
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'base'); mutate(s); });
  command(g, { type: 'attack', attackId: 'base:bite' });
  return g;
}
const zones = (g) => { const p = g.snapshot().players[0]; return { prizes: p.prizes.length, hand: p.hand.length, discard: p.discard.length, lost: p.lost.length }; };

test('schemas: 「…放于弃牌区」 at the Knock Out, 「…放入放逐区」 while in play; neither a lasting effect', () => {
  const modifier = (p) => handlers.get('cn.prizeModifier@1').validateParameters(p);
  assert(modifier(smoke));
  for (const extra of [{ amount: -1 }, { coin: true }, { group: 'x' }, { oncePerGame: 'x' }, { to: 'lost' }])
    assert(!modifier({ effect: { ...smoke.effect, ...extra } }), JSON.stringify(extra));
  const destination = (p) => handlers.get('cn.prizeDestination@1').validateParameters(p);
  assert(destination(lostBlock.effects[0].parameters));
  assert(!destination({ effect: { op: 'prizeDestination', side: 'own', to: 'lost' } }));
  assert(!destination({ effect: { op: 'prizeDestination', side: 'opponent', to: 'discard' } }));
  assert(!handlers.get('cn.lasting@1').validateParameters({ side: 'own', target: 'self', effect: { op: 'prizeDestination', side: 'opponent', to: 'lost' },
    duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true }));
});

test('「因该宝可梦【昏厥】而导致对手拿取的奖赏卡，不会被加入手牌，而是被放于弃牌区」: still taken, never into the hand', async () => {
  const f = await make();
  let lucky;
  const g = knockOut(f, (s) => { equip(s, 1, s.players[1].active); lucky = toPrize(s, 0, 'other', 2); s.players[0].faceUpPrizes = [s.players[0].prizes[4]]; });
  const before = zones(g);
  assert.equal(g.view(0).pending.kind, 'prize');
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  answer(g, ['2']);
  const s = g.snapshot();
  assert(s.players[0].discard.includes(lucky)); assert.notEqual(s.pending?.kind, 'before-hand-optional', 'No 「拿取时」 effect (JP Q&A もくもくスモーク×ラッキー).');
  assert.deepEqual(zones(g), { ...before, prizes: 5, discard: before.discard + 1 });
  assert(s.battleHistory.events.some((e) => e.kind === 'prizeTaken' && e.cardId === lucky), 'Still a Prize card taken.');
  // Taken face up: the same.
  const h = knockOut(f, (s) => { equip(s, 1, s.players[1].active); s.players[0].faceUpPrizes = [s.players[0].prizes[4]]; });
  answer(h, ['4']); settle(h);
  assert.equal(h.snapshot().players[0].faceUpPrizes, undefined); assert.equal(zones(h).discard, before.discard + 1);
  // Knocked Out in the checkup, not by the opponent's attack: into the hand as usual.
  const k = board(f, (s) => { equip(s, 1, s.players[1].active); bench(s, 1, 'base'); s.players[1].active.counters = 9; s.players[1].active.conditions.poison = 1; });
  const hand0 = zones(k).hand;
  command(k, { type: 'endTurn' }); settle(k);
  assert.equal(zones(k).discard, 0); assert.equal(zones(k).hand, hand0 + 1);
});

test('「只要这只宝可梦在场上，对手拿取的奖赏卡…放入放逐区」: read when taken, also for Prize cards taken by an effect', async () => {
  const f = await make();
  let g = knockOut(f, (s) => { bench(s, 1, 'evolution'); });
  answer(g, ['0']); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].lost.length, 1); assert.equal(s.players[0].prizes.length, 5);
  assert(s.events.some((e) => e.ruleId === 'ko.prize-destination' && e.visibility === 'public' && e.data.lost.length === 1), 'Face up (JP Q&A ガメノデス).');
  // This Pokémon Knocked Out itself: gone before the Prize card is taken (JP Q&A ガメノデス).
  g = knockOut(f, (s) => {
    const p = s.players[1], m = bench(s, 1, 'evolution'); p.bench.splice(p.bench.indexOf(m), 1); p.bench.push(p.active); p.active = m; m.counters = 5;
  });
  settle(g);
  assert.equal(g.snapshot().players[0].lost.length, 0); assert.equal(g.snapshot().players[0].prizes.length, 5);
  // 「拿取1张自己的奖赏卡」 by an effect (JP Q&A ガメノデス×ヤドラン「たそがれのひらめき」).
  let item;
  g = board(f, (s) => { bench(s, 1, 'evolution'); item = hand(s, 0, 'poison'); });
  command(g, { type: 'playTrainer', cardId: item }); settle(g);
  assert.equal(g.snapshot().players[0].lost.length, 1);
  // Only the opponent's: the Ability's own player takes Prize cards into the hand as usual.
  g = board(f, (s) => { bench(s, 0, 'evolution'); item = hand(s, 0, 'poison'); });
  command(g, { type: 'playTrainer', cardId: item }); settle(g);
  assert.equal(g.snapshot().players[0].lost.length, 0); assert.equal(g.snapshot().players[0].prizes.length, 5);
});

test('both apply: the taker sees every card taken, then picks which go to the discard pile (JP Q&A ガメノデス×もくもくスモーク)', async () => {
  const f = await make({ transform: (defs) => { Object.assign(def(defs, 'base').mechanics, { prizeCount: 2, ruleBox: true }); } });
  const g = knockOut(f, (s) => { equip(s, 1, s.players[1].active); bench(s, 1, 'evolution'); });
  const picked = [g.snapshot().players[0].prizes[0], g.snapshot().players[0].prizes[1]];
  answer(g, ['0']);
  assert(g.snapshot().players[0].resolving.includes(picked[0]));
  assert(g.view(0).events.some((e) => e.ruleId === 'ko.prize-destination' && e.data.cards?.[0].instanceId === picked[0]), 'Seen by the taker.');
  assert(!g.view(1).events.some((e) => e.ruleId === 'ko.prize-destination' && e.data.cards));
  answer(g, ['0']);
  const q = g.view(0).pending;
  assert.equal(q.kind, 'prize-destination'); assert.deepEqual([q.minimum, q.maximum], [0, 2]);
  assert.deepEqual(q.cards.map((c) => c.instanceId), picked);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  const bad = clone(g.snapshot()); bad.players[0].resolving = []; bad.players[0].hand.push(...picked);
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), (e) => e.code === 'invalid-prize-choice');
  answer(g, [picked[1]]); settle(g);
  const s = g.snapshot();
  assert(s.players[0].discard.includes(picked[1])); assert(s.players[0].lost.includes(picked[0])); assert.equal(s.players[0].resolving.length, 0);
});

test('one Knock Out\'s Prize cards to the discard pile, another\'s to the hand: the taker picks, having seen them all', async () => {
  const f = await make({ attack: [binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 100, selection: { kind: 'all' }, options: {} })] });
  for (const faceUp of [true, false]) {
    let lucky, other;
    const g = knockOut(f, (s) => {
      equip(s, 1, s.players[1].active);
      lucky = toPrize(s, 0, 'other', 0); other = s.players[0].prizes[1];
      if (faceUp) s.players[0].faceUpPrizes = [lucky];
    });
    answer(g, ['0']); answer(g, ['0']);
    const q = g.view(0).pending;
    assert.equal(q.kind, 'prize-destination'); assert.deepEqual([q.minimum, q.maximum], [1, 1]);
    answer(g, [other]);
    const s = g.snapshot();
    assert(s.players[0].discard.includes(other));
    if (faceUp) { settle(g); assert(g.snapshot().players[0].hand.includes(lucky)); assert(!g.snapshot().events.some((e) => e.ruleId === 'trigger.before-hand')); }
    else assert.equal(s.pending.kind, 'before-hand-optional', 'Into the hand, taken face down: its own effect may be used.');
  }
});
