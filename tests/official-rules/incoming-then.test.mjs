// Synthetic definitions only. 「在自己的回合，当从反面朝上的自己的奖赏卡中拿取了这张卡牌时，如果自己的备战区有空位的话，则在加入手牌前可以使用。
// 将这只宝可梦放于自己的备战区。然后，抛掷1次硬币如果为正面，则额外拿取1张奖赏卡」 (trigger.before-hand, II.E-19). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { randomIndex } from '../../public/rules/random.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const handlers = createCoreHandlers();
const seedFor = (coins) => {
  for (let i = 1; i <= 8192; i++) {
    const seed = [Math.imul(i, 8000009) >>> 0, Math.imul(i, 333333331) >>> 0, Math.imul(i, 17) >>> 0, Math.imul(i, 37) >>> 0], rng = [...seed];
    if (coins.every((heads) => (randomIndex(rng, 2) === 0) === heads)) return seed;
  }
  throw new Error('No fixture seed.');
};
const lucky = { handlerId: 'cn.coin@1', parameters: { outcome: 'heads', effect: { handlerId: 'cn.takePrizes@1', parameters: { count: 1 } } } };

test('schema: a static leaf or one coin after the placement', () => {
  const valid = (p) => handlers.get('cn.deployIncomingThen@1').validateParameters(p);
  assert(valid({ next: lucky }));
  assert(valid({ next: { handlerId: 'cn.takePrizes@1', parameters: { count: 1 } } }));
  assert(!valid({ next: { handlerId: 'cn.coin@1', parameters: { outcome: 'heads' } } }));
  assert(!valid({ next: { handlerId: 'cn.then@1', parameters: {} } }));
  assert(!valid({}));
});

test('placed on the Bench, then the coin; a full Bench places nothing and flips nothing', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{ abilityId: 'incoming', name: '测试幸运', mode: 'triggered', usage: null,
      trigger: { event: 'beforeHand', origin: 'prizes', turn: 'own', drawReason: 'any', optional: true, afterUse: 'hand' },
      effects: [binding('cn.deployIncomingThen@1', { next: lucky }, 'lucky')], sourceOfTruth: EVIDENCE }];
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.takePrizes@1', { count: 1 }, 'take')];
  });
  f.deck.splice(f.deck.indexOf('printing:water'), 4, 'printing:base', 'printing:base', 'printing:other', 'printing:other');
  for (const [heads, full] of [[true, false], [false, false], [true, true]]) {
    let other, card;
    const g = board(f, (s) => {
      const p = s.players[0];
      other = hand(s, 0, 'other'); p.hand.pop(); p.deck.push(p.prizes[0]); p.prizes[0] = other;
      card = hand(s, 0, 'potion'); s.rng = seedFor([heads]);
      if (full) for (const id of ['base', 'base', 'base', 'other', 'other']) bench(s, 0, id);
    });
    command(g, { type: 'playTrainer', cardId: card });
    answer(g, ['0']);
    if (!full) { assert.equal(g.snapshot().pending.kind, 'before-hand-optional'); answer(g, ['perform']); }
    settle(g);
    const s = g.snapshot(), p = s.players[0];
    assert.equal(p.bench.some((m) => m.stack.includes(other)), !full);
    assert.equal(p.prizes.length, full ? 5 : heads ? 4 : 5, JSON.stringify({ heads, full }));
    assert.equal(s.events.some((e) => e.ruleId === 'effects.coin'), !full, 'The coin only after the placement.');
    if (full) assert(p.hand.includes(other), 'Not placed: it goes into the hand.');
    assert.deepEqual(OfficialGame.restore(JSON.parse(JSON.stringify(s)), { catalog: f.catalog }).snapshot(), s);
  }
});
