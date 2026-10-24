// Synthetic definitions only. 「数过自己的奖赏卡后，将其全部加入手牌。然后，从牌库上方，抽取与加入手牌数量相同张数的卡牌，作为奖赏卡放置。
// 如果无法放置与数过的卡牌数量相同张数的奖赏卡的话，则这个招式失败。」, 「将自己的1张奖赏卡放于弃牌区，如果该奖赏卡是能量的话，则将其附着于
// 自己的宝可梦身上。」 and 「将自己的1张反面朝上的奖赏卡翻为正面。如果该卡牌是【火】能量的话，则追加造成50点伤害。（在对战结束前，一直保持
// 正面朝上状态。）」 (prizes.zone, prizes.face-up, cards.prism-star). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, start, command, answer, settle, attached, bench, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const lit = (value) => ({ kind: 'literal', value });
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const zone = (p) => ({ handlerId: 'cn.prizeZone@1', parameters: p });
// 「当从反面朝上的自己的奖赏卡中拿取了这张卡牌时」: never offered for Prize cards put into the hand or the discard pile by an effect.
const incoming = { abilityId: 'incoming', name: '测试奖赏入手前', mode: 'triggered', usage: null,
  trigger: { event: 'beforeHand', origin: 'prizes', turn: 'own', drawReason: 'any', optional: true, afterUse: 'hand' },
  effects: [binding('cn.draw@1', { count: 1 }, 'incoming-draw')], sourceOfTruth: EVIDENCE };

async function make(attack, { printedDamage = null, failureCheck, transform = () => {}, deck = (d) => d } = {}) {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; }
    def(defs, 'other').mechanics.abilities.push(incoming);
    Object.assign(def(defs, 'base').mechanics.attacks[0], { printedDamage, effects: attack, ...(failureCheck ? { failureCheck } : {}) });
    transform(defs);
  });
  f.deck = deck(f.deck);
  return f;
}
// A known card into the given Prize position.
function toPrize(s, owner, id, slot = 0) {
  const card = hand(s, owner, id), p = s.players[owner];
  p.hand.pop(); p.deck.push(p.prizes[slot]); p.prizes[slot] = card;
  return card;
}
const attack = (f, mutate = () => {}) => {
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mutate(s); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  return g;
};

// 「如果无法放置与数过的卡牌数量相同张数的奖赏卡的话，则这个招式失败」: the deck holds fewer cards than the Prizes counted.
const short = { predicate: { kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'deck' }, relation: 'lt',
  right: { kind: 'zoneCount', side: 'own', zone: 'prizes' } }, sourceOfTruth: EVIDENCE };
const discovery = [binding('cn.prizeZone@1', { op: 'resetPrizes', side: 'own', to: 'hand', count: 'same' }, 'discovery')];

test('「数过自己的奖赏卡后，将其全部加入手牌。然后，…作为奖赏卡放置」: not taking them; the attack fails on a short deck', async () => {
  const valid = (p) => handlers.get('cn.prizeZone@1').validateParameters(p);
  assert(valid({ op: 'resetPrizes', side: 'own', to: 'hand', count: 'same' }));
  assert(!valid({ op: 'resetPrizes', side: 'both', to: 'hand', count: 'same' }));
  const f = await make(discovery, { failureCheck: short });
  let before, lucky;
  const g = attack(f, (s) => {
    lucky = toPrize(s, 0, 'other'); s.players[0].faceUpPrizes = [s.players[0].prizes[1]];
    before = { prizes: [...s.players[0].prizes], top: s.players[0].deck.slice(-6), hand: s.players[0].hand.length };
  });
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  settle(g);
  const s = g.snapshot(), p = s.players[0];
  assert(before.prizes.every((id) => p.hand.includes(id)), 'All six into the hand.');
  assert.deepEqual([...p.prizes].sort(), [...before.top].sort(), 'Six new Prize cards from the top of the deck.');
  assert.equal(p.faceUpPrizes, undefined); assert(p.hand.includes(lucky));
  assert(!s.events.some((e) => e.ruleId === 'trigger.before-hand'), 'Not taken (JP Q&A テッカグヤGX「ディスカバリーGX」).');
  assert(!s.battleHistory.events.some((e) => e.kind === 'prizeTaken'));
  // Five cards in the deck, six Prize cards: the attack fails and nothing moves.
  const h = attack(f, (s) => { const p = s.players[0]; p.discard.push(...p.deck.splice(0, p.deck.length - 5)); before = [...p.prizes]; });
  settle(h);
  assert.equal(h.snapshot().events.find((e) => e.ruleId === 'attack.failure.self').data.receipt.passed, false);
  assert.deepEqual(h.snapshot().players[0].prizes, before);
});

// 「将自己的1张奖赏卡放于弃牌区，如果该奖赏卡是能量的话，则将其附着于自己的宝可梦身上」.
const burst = { first: zone({ op: 'discardPrizes', count: 1 }),
  next: { handlerId: 'cn.attachDiscard@1', parameters: { type: null, category: 'any', count: 1, benchOnly: false, optional: false } }, use: 'cards' };
const prism = (defs) => { const d = def(defs, 'double'); d.prismStar = { sourceOfTruth: clone(EVIDENCE) }; d.deckLimits.sameName = 1; };

test('「将自己的1张奖赏卡放于弃牌区，如果该奖赏卡是能量的话，则将其附着于自己的宝可梦身上」', async () => {
  const thenMoved = (p) => handlers.get('cn.thenMoved@1').validateParameters(p);
  assert(thenMoved(clone(burst))); assert(thenMoved({ ...clone(burst), next: { handlerId: 'cn.draw@1', parameters: { count: 1 } }, use: 'count' }));
  assert(!thenMoved({ ...clone(burst), first: zone({ op: 'flipPrizes', count: 1 }) }), 'Only a discarded Prize is moved anywhere.');
  assert(!handlers.get('cn.prizeZone@1').validateParameters({ op: 'discardPrizes', count: 0 }));
  const f = await make([binding('cn.thenMoved@1', burst, 'burst')], { transform: prism });
  // A Basic Energy: discarded, then attached.
  let energy;
  let g = attack(f, (s) => { energy = toPrize(s, 0, 'water', 3); s.players[0].faceUpPrizes = [s.players[0].prizes[5]]; bench(s, 0, 'other'); });
  let q = g.view(0).pending;
  assert.equal(q.kind, 'prize-slot'); assert.deepEqual(q.options, ['0', '1', '2', '3', '4', '5'], 'Any of them, face up too.');
  assert.deepEqual(Object.keys(q.faceUpSlots), ['5']);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  answer(g, ['3']);
  q = g.view(0).pending;
  assert.equal(q.kind, 'discard-energy'); assert.deepEqual(q.options, [energy], 'Only that card.');
  answer(g, [energy]);
  assert.equal(g.view(0).pending.kind, 'energy-recipient');
  answer(g, [g.snapshot().players[0].bench[0].id]); settle(g);
  let s = g.snapshot();
  assert.deepEqual(s.players[0].bench[0].energy, [energy]); assert.equal(s.players[0].prizes.length, 5);
  assert(s.events.some((e) => e.ruleId === 'prizes.zone' && e.data.discarded === 1 && e.data.cards[0].instanceId === energy));
  assert(!s.battleHistory.events.some((e) => e.kind === 'prizeTaken'), 'Not taking it.');
  // Not an Energy: it stays in the discard pile; a 「拿取时」 card's effect is not offered (JP Q&A ズガドーンGX「バーストGX」).
  let lucky;
  g = attack(f, (s) => { lucky = toPrize(s, 0, 'other'); });
  answer(g, ['0']); settle(g);
  s = g.snapshot();
  assert(s.players[0].discard.includes(lucky)); assert(!s.events.some((e) => e.ruleId === 'trigger.before-hand'));
  // A Prism Star Energy goes to the Lost Zone instead, and is still the card attached (JP Q&A ズガドーンGX×ビーストエネルギー◇).
  let star;
  g = attack(f, (s) => { star = toPrize(s, 0, 'double', 2); });
  answer(g, ['2']);
  assert(g.snapshot().players[0].lost.includes(star));
  assert.deepEqual(g.view(0).pending.options, [star]);
  settle(g);
  s = g.snapshot();
  assert(s.players[0].active.energy.includes(star)); assert(!s.players[0].lost.includes(star));
  // The last Prize card: whether discarding it takes them all is not settled.
  assert.throws(() => attack(f, (s) => { const p = s.players[0]; p.hand.push(...p.prizes.splice(1)); }), (e) => e.code === 'unresolved-last-prize');
});

// 「将自己的1张反面朝上的奖赏卡翻为正面。如果该卡牌是【火】能量的话，则追加造成50点伤害」 (printed 「10+」).
const fireFlip = [binding('cn.countedPrizes@1', { op: 'flipPrizes', count: 1 }, 'flip'),
  binding('cn.damageValue@1', { expression: { kind: 'choose', condition: { kind: 'compare', left: { kind: 'movedCards', effectId: 'fixture:flip',
    selector: { kind: 'energy', category: 'basic', types: ['Fire'] } }, relation: 'gt', right: lit(0) }, ifTrue: lit(60), ifFalse: lit(10) } }, 'formula')];

test('「将自己的1张反面朝上的奖赏卡翻为正面。如果该卡牌是【火】能量的话，则追加造成50点伤害」: cn.countedPrizes@1', async () => {
  const valid = (p) => handlers.get('cn.countedPrizes@1').validateParameters(p);
  assert(valid({ op: 'flipPrizes', count: 1 })); assert(valid({ op: 'flipPrizes', count: 'all' }));
  assert(!valid({ op: 'lookPrizes', side: 'own', count: 'all' })); assert(!valid({ op: 'discardPrizes', count: 1 }));
  const f = await make(fireFlip, { printedDamage: { value: 10, operator: 'plus' }, deck: (d) => d.map((id, i) => i === 59 ? 'printing:fire' : id) });
  for (const [card, counters] of [['fire', 6], ['water', 1]]) {
    let flipped;
    const g = attack(f, (s) => { flipped = toPrize(s, 0, card, 4); s.players[0].faceUpPrizes = [s.players[0].prizes[0]]; });
    const q = g.view(0).pending;
    assert.equal(q.kind, 'prize-slot'); assert.deepEqual(q.options, ['1', '2', '3', '4', '5'], 'Face down only, by position.');
    assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
    answer(g, ['4']); settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, counters);
    assert.deepEqual(s.players[0].faceUpPrizes.slice(-1), [flipped], 'Face up until it leaves the Prizes.');
  }
  // Every Prize card already face up: nothing to flip, no bonus (JP Q&A ズガドーン「ブレイザー」×タウンマップ).
  const g = attack(f, (s) => { s.players[0].faceUpPrizes = [...s.players[0].prizes]; });
  settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 1);
  const item = await make([], { transform: (defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.countedPrizes@1', { op: 'flipPrizes', count: 1 }, 'flip')]; } });
  assert.throws(() => start(item), /counted effect/);
});
