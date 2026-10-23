// Synthetic definitions only. Prize cards as a zone (prizes.zone, prizes.face-up): 「查看所有反面朝上的自己的奖赏卡，再放回原处」
// 「选择1张反面朝上的对手的奖赏卡，查看过该卡牌正面后，放回原处」「将自己的奖赏卡全部正面朝上」「若希望，可选择反面朝上的自己的1张奖赏卡，
// 将其翻到正面。在这种情况下，追加造成80伤害」「选择1张反面朝上的对手的奖赏卡，将其与对手牌库最上方的卡牌，在反面朝上的状态下互换」
// 「数过自己的奖赏卡后，将其全部放回牌库并重洗牌库。然后，从牌库上方，抽取与被放回牌库的奖赏卡数量相同数量的卡牌，作为奖赏卡放置」
// 「选择最多3张自己的奖赏卡，加入手牌。然后，选择与加入手牌张数相同张数的手牌，反面朝上作为奖赏卡放置」「将对手牌库上方2张卡牌，作为对手的
// 奖赏卡放置」「查看对手的手牌，将其中1张卡牌，反面朝上作为对手的奖赏卡放置」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand, attached, EVIDENCE } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.prizeZone@1').validateParameters(p);
const zone = (p, key = p.op) => binding('cn.prizeZone@1', p, key);
const item = (...effects) => fixture((defs) => { defs.find((d) => d.definitionId === 'potion').mechanics.effects = effects; });
const setup = (f, mutate = () => {}) => {
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); mutate(s); });
  return { g, card };
};
const play = (f, mutate) => { const { g, card } = setup(f, mutate); command(g, { type: 'playTrainer', cardId: card }); return g; };
const playable = (f, mutate) => { const { g, card } = setup(f, mutate); return g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card); };

test('schema: the printed forms only', () => {
  for (const p of [{ op: 'lookPrizes', side: 'own', count: 'all' }, { op: 'lookPrizes', side: 'opponent', count: 1 },
    { op: 'flipPrizes', count: 'all' }, { op: 'flipPrizes', count: 1 }, { op: 'swapPrizeDeck', side: 'opponent' },
    { op: 'resetPrizes', side: 'own', to: 'deckBottom', count: 'same' }, { op: 'resetPrizes', side: 'both', to: 'deck', count: 3 },
    { op: 'prizeHandSwap', count: 3 }, { op: 'deckTopToPrizes', side: 'opponent', count: 2 }]) assert(valid(p), JSON.stringify(p));
  for (const p of [{ op: 'lookPrizes', side: 'own', count: 1 }, { op: 'lookPrizes', side: 'opponent', count: 'all' }, { op: 'flipPrizes', count: 2 },
    { op: 'resetPrizes', side: 'opponent', to: 'deck', count: 'same' }, { op: 'deckTopToPrizes', side: 'own', count: 2 },
    { op: 'prizeHandSwap', count: 0 }, { op: 'swapPrizeDeck', side: 'both' }]) assert(!valid(p), JSON.stringify(p));
  const look = (p) => handlers.get('cn.opponentHand@1').validateParameters({ mode: 'look', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, to: 'prizes', ...p });
  assert(look({})); assert(!look({ mode: 'faceDown' })); assert(!look({ quantity: { kind: 'upTo', count: 2 } }));
  const cards = (p) => handlers.get('cn.cards@1').validateParameters({ from: 'discard', to: 'prizes', selector: { kind: 'any' },
    quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false, ...p });
  assert(cards({ side: 'opponent' })); assert(!cards({})); assert(!cards({ side: 'opponent', from: 'deck', lookTop: 1 }));
  const counted = (e) => handlers.get('cn.optionalCounted@1').validateParameters({ effect: { handlerId: 'cn.prizeZone@1', parameters: e } });
  assert(counted({ op: 'flipPrizes', count: 1 })); assert(!counted({ op: 'flipPrizes', count: 'all' }));
});

test('「查看所有反面朝上的自己的奖赏卡，再放回原处」: only the user sees them; face-up Prizes are not looked at', async () => {
  const f = await item(binding('cn.draw@1', { count: 2 }, 'draw'), zone({ op: 'lookPrizes', side: 'own', count: 'all' }));
  let g = play(f);
  const prizes = g.snapshot().players[0].prizes;
  assert.equal(g.snapshot().pending.kind, 'view-cards');
  assert.deepEqual(g.view(0).pending.lookedAt.map((c) => c.instanceId), prizes);
  assert(g.view(0).events.some((e) => e.ruleId === 'prizes.zone' && e.data.cards?.length === 6));
  assert(!g.view(1).events.some((e) => e.ruleId === 'prizes.zone' && e.data.cards));
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  answer(g, ['confirm']); settle(g);
  assert.deepEqual(g.snapshot().players[0].prizes, prizes, 'Put back where they were.');
  g = play(f, (s) => { s.players[0].faceUpPrizes = s.players[0].prizes.slice(0, 2); });
  assert.equal(g.view(0).pending.lookedAt.length, 4);
  assert.deepEqual(g.view(1).players[0].prizes.faceUp.map((x) => x.index), [0, 1]);
  const bad = clone(g.snapshot()); bad.queue.at(-1).data.lookedAt = [bad.players[0].hand[0]];
  bad.pending = null;
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
  const only = await item(zone({ op: 'lookPrizes', side: 'own', count: 'all' }));
  assert.equal(playable(only), true);
  assert.equal(playable(only, (s) => { s.players[0].faceUpPrizes = [...s.players[0].prizes]; }), false, 'Nothing face down to look at.');
});

test('「选择1张反面朝上的对手的奖赏卡，查看…后，放回原处」: a position first, then that face', async () => {
  const f = await item(zone({ op: 'lookPrizes', side: 'opponent', count: 1 }));
  const g = play(f, (s) => { s.players[1].faceUpPrizes = [s.players[1].prizes[0]]; });
  let q = g.view(0).pending;
  assert.equal(q.kind, 'prize-slot'); assert.deepEqual(q.options, ['1', '2', '3', '4', '5']);
  assert.equal(q.lookedAt, undefined); assert.deepEqual(q.faceUpSlots, {});
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  const target = g.snapshot().players[1].prizes[3];
  answer(g, ['3']);
  q = g.view(0).pending;
  assert.equal(q.kind, 'view-cards'); assert.deepEqual(q.lookedAt.map((c) => c.instanceId), [target]);
  assert(!g.view(1).events.some((e) => JSON.stringify(e.data).includes(target)));
  settle(g);
  assert.equal(g.snapshot().players[1].prizes[3], target);
});

test('「将自己的奖赏卡全部正面朝上」: public until taken, and a face-up Prize taken is not one taken face down', async () => {
  const incoming = { abilityId: 'incoming', name: '测试奖赏入手前', mode: 'triggered', usage: null,
    trigger: { event: 'beforeHand', origin: 'prizes', turn: 'own', drawReason: 'any', optional: true, afterUse: 'hand' },
    effects: [binding('cn.draw@1', { count: 1 }, 'incoming-draw')], sourceOfTruth: EVIDENCE };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [zone({ op: 'flipPrizes', count: 'all' })];
    defs.find((d) => d.definitionId === 'poison').mechanics.effects = [binding('cn.takePrizes@1', { count: 1 }, 'take')];
    defs.find((d) => d.definitionId === 'other').mechanics.abilities.push(incoming);
  });
  for (const flip of [true, false]) {
    let other, take, flipper;
    const g = board(f, (s) => {
      const p = s.players[0];
      other = hand(s, 0, 'other'); p.hand.pop(); p.deck.push(p.prizes[0]); p.prizes[0] = other;
      take = hand(s, 0, 'poison'); flipper = hand(s, 0, 'potion');
    });
    if (flip) {
      command(g, { type: 'playTrainer', cardId: flipper }); settle(g);
      const s = g.snapshot();
      assert.deepEqual(s.players[0].faceUpPrizes, s.players[0].prizes);
      assert.deepEqual(g.view(1).players[0].prizes.faceUp.map((x) => x.card.instanceId), s.players[0].prizes);
      assert(s.events.some((e) => e.ruleId === 'prizes.face-up' && e.visibility === 'public' && e.data.cards.length === 6));
      assert.deepEqual(restore(g, f).snapshot(), s);
    }
    command(g, { type: 'playTrainer', cardId: take });
    const q = g.view(0).pending;
    assert.equal(q.kind, 'prize'); assert.equal(Object.keys(q.faceUpSlots).length, flip ? 6 : 0);
    if (flip) assert.equal(q.faceUpSlots['0'].instanceId, other);
    answer(g, ['0']);
    const s = g.snapshot();
    if (flip) {
      assert.notEqual(s.pending?.kind, 'before-hand-optional');
      settle(g);
      assert(g.snapshot().players[0].hand.includes(other)); assert.equal(g.snapshot().players[0].faceUpPrizes.length, 5);
      assert(!g.snapshot().events.some((e) => e.ruleId === 'trigger.before-hand'));
    } else assert.equal(s.pending?.kind, 'before-hand-optional', 'Taken face down: its own before-hand effect may be used.');
  }
  const bad = clone(board(f).snapshot()); bad.players[0].faceUpPrizes = [bad.players[0].hand[0]];
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /Face-up Prize/);
});

test('「若希望，可选择反面朝上的自己的1张奖赏卡，将其翻到正面。在这种情况下，追加造成80伤害」', async () => {
  const lit = (value) => ({ kind: 'literal', value });
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; }
    const a = defs.find((d) => d.definitionId === 'base').mechanics.attacks[0];
    a.printedDamage = null;
    a.effects = [binding('cn.optionalCounted@1', { effect: { handlerId: 'cn.prizeZone@1', parameters: { op: 'flipPrizes', count: 1 } } }, 'flip'),
      binding('cn.damageValue@1', { expression: { kind: 'choose', condition: { kind: 'compare', left: { kind: 'effectCards', effectId: 'fixture:flip' },
        relation: 'gt', right: lit(0) }, ifTrue: lit(100), ifFalse: lit(20) } }, 'formula')];
  });
  for (const [perform, counters, up] of [[true, 10, 1], [false, 2, 0]]) {
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); });
    command(g, { type: 'attack', attackId: 'base:strike' });
    settle(g, (q) => q.kind === 'optional-effect' ? [perform ? 'perform' : 'skip'] : q.options.slice(0, Math.max(q.minimum, 1)));
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, counters);
    assert.equal(s.players[0].faceUpPrizes?.length ?? 0, up);
  }
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].faceUpPrizes = [...s.players[0].prizes]; });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g, (q) => q.kind === 'optional-effect' ? ['perform'] : q.options.slice(0, 1));
  assert.equal(g.snapshot().players[1].active.counters, 2, 'Every Prize already face up: nothing to flip, no bonus.');
});

test('「选择1张反面朝上的对手的奖赏卡，将其与对手牌库最上方的卡牌，在反面朝上的状态下互换」', async () => {
  const f = await item(zone({ op: 'swapPrizeDeck', side: 'opponent' }));
  const g = play(f);
  const before = g.snapshot(), prize = before.players[1].prizes[2], top = before.players[1].deck.at(-1);
  assert.equal(before.pending.kind, 'prize-slot');
  answer(g, ['2']); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].prizes[2], top); assert.equal(s.players[1].deck.at(-1), prize);
  assert(!g.view(0).events.some((e) => JSON.stringify(e.data).includes(prize)) && !g.view(1).events.some((e) => JSON.stringify(e.data).includes(prize)),
    'Nobody sees either card.');
  assert.equal(playable(f, (s) => { s.players[1].faceUpPrizes = [...s.players[1].prizes]; }), false);
  assert.equal(playable(f, (s) => { s.players[1].discard.push(...s.players[1].deck.splice(0)); }), false, 'No deck to swap with.');
});

test('「将奖赏卡全部放回牌库并重洗牌库／反面朝上重洗，放回牌库下方。然后，…作为奖赏卡放置」, for one or both players', async () => {
  const same = await item(zone({ op: 'resetPrizes', side: 'own', to: 'deck', count: 'same' }));
  let g = play(same, (s) => { const p = s.players[0]; p.hand.push(...p.prizes.splice(0, 2)); p.faceUpPrizes = [p.prizes[0]]; });
  let s = g.snapshot();
  assert.equal(s.players[0].prizes.length, 4); assert.equal(s.players[0].faceUpPrizes, undefined, 'New Prizes are face down.');
  assert(s.events.some((e) => e.ruleId === 'effects.shuffle' && e.data.zone === 'deck'));
  const bottom = await item(zone({ op: 'resetPrizes', side: 'own', to: 'deckBottom', count: 'same' }));
  let old;
  g = play(bottom, (s) => { old = [...s.players[0].prizes]; });
  s = g.snapshot();
  assert.deepEqual([...s.players[0].deck.slice(0, 6)].sort(), [...old].sort(), 'Shuffled face down onto the bottom.');
  assert.equal(s.players[0].prizes.length, 6); assert(s.players[0].prizes.every((id) => !old.includes(id)));
  const both = await item(zone({ op: 'resetPrizes', side: 'both', to: 'deck', count: 3 }));
  g = play(both, (s) => { s.players[1].hand.push(...s.players[1].prizes.splice(0, 4)); });
  s = g.snapshot();
  assert.deepEqual(s.players.map((p) => p.prizes.length), [3, 3]);
  g = play(both, (s) => { s.players[1].discard.push(...s.players[1].deck.splice(0, s.players[1].deck.length - 1)); s.players[1].hand.push(...s.players[1].prizes.splice(0)); });
  assert.deepEqual(g.snapshot().players.map((p) => p.prizes.length), [3, 1], 'As many as the deck has.');
});

test('「选择最多3张自己的奖赏卡，加入手牌。然后，选择与加入手牌张数相同张数的手牌，反面朝上作为奖赏卡放置」', async () => {
  const f = await item(zone({ op: 'prizeHandSwap', count: 3 }));
  const g = play(f, (s) => { s.players[0].faceUpPrizes = [s.players[0].prizes[5]]; });
  let q = g.view(0).pending;
  assert.equal(q.kind, 'prize-slot'); assert.deepEqual([q.minimum, q.maximum], [1, 3], 'At least one (JP Q&A シャクヤ).');
  assert.deepEqual(Object.keys(q.faceUpSlots), ['5']);
  const before = g.snapshot(), taken = ['0', '5'].map((i) => before.players[0].prizes[Number(i)]);
  answer(g, ['0', '5']);
  q = g.view(0).pending;
  assert.equal(q.kind, 'select-cards'); assert.deepEqual([q.minimum, q.maximum], [2, 2]);
  assert(taken.every((id) => q.options.includes(id)));
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  const placed = g.snapshot().players[0].hand.filter((id) => !taken.includes(id)).slice(0, 2);
  answer(g, placed); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[0].prizes.length, 6); assert(placed.every((id) => s.players[0].prizes.includes(id)));
  assert(taken.every((id) => s.players[0].hand.includes(id))); assert.equal(s.players[0].faceUpPrizes, undefined);
  assert(!s.events.some((e) => e.ruleId === 'trigger.before-hand' || e.ruleId === 'ko.boundary' && e.data.taken));
  assert.equal(playable(f, (s) => { s.players[0].hand.push(...s.players[0].prizes.splice(0)); }), false);
});

test('「将对手牌库上方2张卡牌，作为对手的奖赏卡放置」 and Prize cards from the opponent\'s hand or discard pile', async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; }
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [zone({ op: 'deckTopToPrizes', side: 'opponent', count: 2 })];
    defs.find((d) => d.definitionId === 'poison').mechanics.effects = [binding('cn.opponentHand@1',
      { mode: 'look', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, to: 'prizes' }, 'pluck')];
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [binding('cn.cards@1', { from: 'discard', to: 'prizes', side: 'opponent',
      selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false }, 'recall')];
    // 「…造成对手已经获得的奖赏卡张数×40点伤害」 (II.D-17)
    const a = defs.find((d) => d.definitionId === 'other').mechanics.attacks[0];
    a.printedDamage = { value: 0, operator: 'plus' }; a.effects = [binding('cn.prizeDamage@1', { side: 'opponent', base: 10, perPrize: 40 }, 'count')];
  });
  let { g, card } = setup(f), top = g.snapshot().players[1].deck.slice(-2);
  command(g, { type: 'playTrainer', cardId: card });
  let s = g.snapshot();
  assert.equal(s.players[1].prizes.length, 8); assert(top.every((id) => s.players[1].prizes.slice(-2).includes(id)));
  // Eight Prizes, one taken: none taken counts (JP Q&A インジェクションGX).
  g = board(f, (s) => {
    const p = s.players[1]; p.prizes.push(p.deck.pop(), p.deck.pop()); p.hand.push(p.prizes.shift());
    const q = s.players[0]; q.hand.push(...q.active.stack); q.active.stack = [hand(s, 0, 'other')]; q.hand.pop(); attached(s, 0, q.active, 'water');
  });
  command(g, { type: 'attack', attackId: 'other:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 1, 'Seven remain of a six-card basis: none taken.');
  g = board(f, (s) => { card = hand(s, 0, 'poison'); });
  command(g, { type: 'playTrainer', cardId: card });
  const foe = g.snapshot().players[1].hand, pick = foe[0];
  assert.equal(g.snapshot().pending.kind, 'select-cards');
  answer(g, [pick]); settle(g);
  s = g.snapshot();
  assert(s.players[1].prizes.includes(pick) && !s.players[1].hand.includes(pick));
  assert(!g.view(1).events.some((e) => e.ruleId === 'effects.opponent-hand' && e.data.to === 'prizes' && e.data.cards), 'Placed face down.');
  g = board(f, (s) => { card = hand(s, 0, 'research'); s.players[1].discard.push(s.players[1].deck.pop()); });
  const gone = g.snapshot().players[1].discard[0];
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  s = g.snapshot();
  assert(s.players[1].prizes.includes(gone)); assert.equal(s.players[1].prizes.length, 7);
});
