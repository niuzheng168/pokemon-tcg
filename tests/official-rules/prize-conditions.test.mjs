// Synthetic definitions only. Shapes follow printed CN Prize-dependent text:
// 「只有在自己的剩余奖赏卡张数，比对手的剩余奖赏卡张数多时才可使用」, draws equal to
// 「自己剩余奖赏卡张数」 or 「为6张的话，则抽取的张数变为8张」, and an attack cost reduced by
// 「对手已经获得的奖赏卡张数」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, settle, bench, hand, fixtureClock, RULESET } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const trainer = (id, category, effects, extra = {}) => (defs) => {
  const d = defs.find((d) => d.definitionId === id);
  d.mechanics = { category, effects, ...extra };
};
// Move Prize cards to the bottom of the deck so `remaining` stay in the Prize zone.
const leavePrizes = (s, owner, remaining) => { const p = s.players[owner]; p.deck.unshift(...p.prizes.splice(remaining)); };
const playable = (g, cardId) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === cardId);
const gust = binding('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected' }, 'gust');

test('Prize-dependent rules carry CN sources; malformed conditions and counts are rejected', async () => {
  for (const id of ['trainer.condition', 'prizes.remaining']) assert(requireRule(CN_V20261019, id).sourceOfTruth.length > 0);
  await assert.rejects(fixture(trainer('potion', 'item', [gust], { condition: { prizesRemaining: 'fewerThanOpponent' } })));
  await assert.rejects(fixture(trainer('research', 'supporter', [binding('cn.handDeckDraw@1',
    { side: 'own', ownDraw: { kind: 'remainingPrizes', equals: 6 }, opponentDraw: 0 })])));
  await assert.rejects(fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.abilities = [{ abilityId: 'fixture:cheap', name: '测试减费', mode: 'continuous',
      usage: null, sourceOfTruth: EVIDENCE, effects: [binding('cn.energyRequirement@1', { effect: { op: 'energyRequirement',
        action: 'retreat', mode: 'erase', scope: 'self', perPrizesTaken: 'opponent' } })] }];
  }));
});

test('I.B-01 step 1: 「剩余奖赏卡张数比对手多时才可使用」 is judged on the current Prize zones', async () => {
  const f = await fixture(trainer('potion', 'item', [gust], { condition: { prizesRemaining: 'moreThanOpponent' } }));
  let card, target;
  const even = board(f, (s) => { card = hand(s, 0, 'potion'); target = bench(s, 1, 'other'); });
  assert(!playable(even, card), 'Equal Prize counts do not satisfy 「比对手多」.');
  const behind = board(f, (s) => { card = hand(s, 0, 'potion'); target = bench(s, 1, 'other'); leavePrizes(s, 1, 4); });
  assert(playable(behind, card));
  command(behind, { type: 'playTrainer', cardId: card });
  settle(behind, (q) => [target.id]);
  assert.equal(behind.snapshot().players[1].active.id, target.id);
  const ahead = board(f, (s) => { card = hand(s, 0, 'potion'); bench(s, 1, 'other'); leavePrizes(s, 0, 3); });
  assert(!playable(ahead, card));
  assert.throws(() => command(ahead, { type: 'playTrainer', cardId: card }), (e) => e.code === 'illegal-action');
});

test('「抽取与自己剩余奖赏卡张数相同数量的卡牌」 draws each player\'s own Prize count after both hands go to the bottom', async () => {
  const f = await fixture(trainer('research', 'supporter', [binding('cn.handBottomDraw@1', {
    side: 'both', ownDraw: { kind: 'remainingPrizes' }, opponentDraw: { kind: 'remainingPrizes' } })]));
  let card;
  const g = board(f, (s) => {
    card = hand(s, 0, 'research'); hand(s, 0, 'water'); hand(s, 1, 'water'); hand(s, 1, 'water');
    leavePrizes(s, 0, 4); leavePrizes(s, 1, 2);
  });
  command(g, { type: 'playTrainer', cardId: card });
  settle(g);
  const s = g.snapshot();
  assert.deepEqual([s.players[0].hand.length, s.players[1].hand.length], [4, 2]);
  restore(g, f);
  // The counts are resolution receipts: a forged count beyond any Prize zone or a changed program is rejected.
  for (const edit of [(program) => { program[0].next.steps[1].count = 7; }, (program) => { program[0].first.side = 'own'; }]) {
    const forged = clone(s);
    edit(forged.events.find((e) => e.ruleId === 'effects.execution' && e.data.kind === 'opened' &&
      e.data.binding.handlerId === 'cn.handBottomDraw@1').data.program);
    assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-execution');
  }
});

test('「剩余奖赏卡张数为6张的话，则抽取的张数变为8张」 switches the draw count only at exactly 6 Prize cards', async () => {
  const f = await fixture(trainer('research', 'supporter', [binding('cn.handDeckDraw@1', {
    side: 'own', ownDraw: { kind: 'ifRemainingPrizes', equals: 6, then: 8, otherwise: 6 }, opponentDraw: 0 })]));
  for (const [remaining, drawn] of [[6, 8], [5, 6]]) {
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'research'); hand(s, 0, 'water'); leavePrizes(s, 0, remaining); });
    command(g, { type: 'playTrainer', cardId: card });
    settle(g);
    assert.equal(g.snapshot().players[0].hand.length, drawn);
    const forged = clone(g.snapshot());
    forged.events.find((e) => e.ruleId === 'effects.execution' && e.data.kind === 'opened' &&
      e.data.binding.handlerId === 'cn.handDeckDraw@1').data.program[0].next.steps[0].count = 7;
    assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-execution');
  }
});

test('II.D-17: an attack cost falls by the Prize cards the opponent has taken; an unresolved tiebreak count refuses the attack', async () => {
  const f = await fixture((defs) => {
    const d = defs.find((d) => d.definitionId === 'base');
    d.mechanics.attacks[0].cost = ['Colorless', 'Colorless', 'Colorless', 'Colorless', 'Colorless'];
    d.mechanics.abilities = [{ abilityId: 'fixture:seasoned', name: '测试老练', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.energyRequirement@1', { effect: { op: 'energyRequirement', action: 'attack', mode: 'adjust', scope: 'self',
        energyType: 'Colorless', amount: -1, perPrizesTaken: 'opponent', attackIds: ['base:strike'] } })] }];
  });
  const total = (g) => g.view(0).players[0].active.effective.attackRequirements[0].routes.map((r) => r.total);
  assert.deepEqual(total(board(f)), [5]);
  assert.deepEqual(total(board(f, (s) => leavePrizes(s, 1, 2))), [1], 'The opponent took 4 Prize cards.');
  assert.deepEqual(total(board(f, (s) => leavePrizes(s, 0, 1))), [5], 'Only the opponent\'s taken Prize cards count.');
  // A tiebreak match has no reviewed taken-Prize count: refuse rather than guess the cost.
  const tiebreak = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed, format: 'tiebreak60' });
  settle(tiebreak);
  const s = tiebreak.snapshot();
  for (const [owner, p] of s.players.entries()) {
    for (const m of [p.active, ...p.bench]) p.hand.push(...m.stack, ...m.energy, ...m.tools);
    p.bench = []; p.active = bench(s, owner, 'base'); p.bench.pop();
  }
  fixtureClock(s); s.phase = 'main';
  assert.deepEqual(OfficialGame.restore(s, { catalog: f.catalog }).view(0).players[0].active.effective.attackRequirements[0].routes, []);
});
