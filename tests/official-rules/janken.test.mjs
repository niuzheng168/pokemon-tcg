// Synthetic definitions only. 「从自己的牌库上方抽取2张卡牌。与对手玩家猜拳，如果自己赢了，则额外抽取2张卡牌。」,
// 「与对手玩家猜拳，如果自己赢了则追加造成60点伤害。」 and 「和对手玩家猜拳，如果自己获胜的话，则在下一个对手的回合，这只宝可梦不受到
// 招式的伤害和效果影响。」 (effects.janken): both players choose a hand in secret, a tie is played again until one wins, and only the
// user's win runs the printed result (or, before damage, is recorded for the formula). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const draw = (count) => leaf('cn.draw@1', { count });
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  for (const viewer of [0, 1]) assert.deepEqual(r.view(viewer), g.view(viewer));
  return r;
};
const results = (g) => g.snapshot().events.filter((e) => e.ruleId === 'effects.janken').map((e) => e.data.result);
// One round: the user's hand, then the opponent's, each answered by its own player.
function round(g, f, user, other) {
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'janken'); assert.deepEqual(q.options, ['rock', 'paper', 'scissors']);
  restore(g, f); answer(g, [user]);
  const next = g.snapshot().pending;
  assert.equal(next.kind, 'janken'); assert.equal(next.player, 1 - q.player);
  // The opponent's request never shows the committed hand; the user has nothing to answer meanwhile.
  assert.equal(g.view(q.player).pending, null);
  assert.deepEqual(g.view(next.player).pending.janken, { round: next.data.janken.round });
  assert(!JSON.stringify(g.view(next.player)).includes('"user"'));
  assert(!g.view(next.player).events.some((e) => e.ruleId === 'effects.janken' && e.data.round === next.data.janken.round));
  restore(g, f); answer(g, [other]);
}

test('schemas and rule: one printed result or several, and the counted form takes no parameters', () => {
  assert(requireRule(CN_V20261019, 'effects.janken').sourceOfTruth.some((s) => s.documentId === 'JP-official-qa'));
  assert(valid('cn.janken@1', { effect: draw(2) }));
  assert(valid('cn.janken@1', { effects: [draw(1), leaf('cn.heal@1', { target: 'self', amount: 30 })] }));
  for (const p of [{}, { effect: draw(2), effects: [draw(1), draw(1)] }, { effects: [draw(1)] }, { effect: draw(0) }])
    assert(!valid('cn.janken@1', p), JSON.stringify(p));
  assert(valid('cn.countedJanken@1', {}));
  assert(!valid('cn.countedJanken@1', { effect: draw(2) }));
});

test('「…抽取2张卡牌。与对手玩家猜拳，如果自己赢了，则额外抽取2张卡牌」: a tie is played again; only a win draws more', async () => {
  const f = await fixture((defs) => {
    def(defs, 'research').mechanics.effects = [binding('cn.draw@1', { count: 2 }, 'draw'),
      binding('cn.janken@1', { effect: draw(2) }, 'janken')];
  });
  const play = (rounds) => {
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'research'); }), before = g.snapshot().players[0].hand.length;
    command(g, { type: 'playTrainer', cardId: card });
    assert.equal(g.snapshot().players[0].hand.length, before + 1, 'The first two cards are drawn before the janken.');
    for (const [user, other] of rounds) round(g, f, user, other);
    settle(g);
    return { g, drawn: g.snapshot().players[0].hand.length - before + 1 };
  };
  let { g, drawn } = play([['rock', 'rock'], ['paper', 'paper'], ['paper', 'rock']]);
  assert.deepEqual(results(g), ['tie', 'tie', 'win']); assert.equal(drawn, 4);
  const event = g.view(1).events.findLast((e) => e.ruleId === 'effects.janken');
  assert.deepEqual([event.data.hands[0], event.data.hands[1], event.data.round], ['paper', 'rock', 3]);
  ({ g, drawn } = play([['scissors', 'rock']]));
  assert.deepEqual(results(g), ['lose']); assert.equal(drawn, 2);
  ({ g, drawn } = play([['scissors', 'paper']]));
  assert.deepEqual(results(g), ['win']); assert.equal(drawn, 4);
});

test('「…如果自己赢了则追加造成60点伤害」: played before damage; the formula reads the recorded win', async () => {
  const won = { kind: 'compare', left: { kind: 'effectCards', effectId: 'fixture:janken' }, relation: 'gt', right: { kind: 'literal', value: 0 } };
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.weakness = null; d.mechanics.hp = 300; }
    def(defs, 'base').mechanics.attacks.push({ attackId: 'base:punch', name: '测试猜拳', cost: [], printedDamage: { value: 60, operator: 'plus' },
      effects: [binding('cn.countedJanken@1', {}, 'janken'), binding('cn.damageValue@1', { expression: { kind: 'choose', condition: won,
        ifTrue: { kind: 'literal', value: 120 }, ifFalse: { kind: 'literal', value: 60 } } }, 'damage')], sourceOfTruth: EVIDENCE });
  });
  for (const [hands, counters] of [[[['rock', 'rock'], ['rock', 'scissors']], 12], [[['paper', 'scissors']], 6]]) {
    const g = board(f);
    command(g, { type: 'attack', attackId: 'base:punch' });
    assert.equal(g.snapshot().players[1].active.counters, 0, 'No damage before the janken is decided.');
    for (const [user, other] of hands) round(g, f, user, other);
    settle(g);
    assert.equal(g.snapshot().players[1].active.counters, counters);
    const count = g.snapshot().events.find((e) => e.ruleId === 'damage.effect-count');
    assert.deepEqual(count.data.cards.length, counters === 12 ? 1 : 0);
  }
  // A counted janken is an attack's own before-damage record.
  const catalog = { handler: (id) => handlers.get(id) }, potion = clone(def(f.definitions, 'potion'));
  potion.mechanics.effects = [binding('cn.countedJanken@1', {}, 'janken')];
  assert.throws(() => assertSupportedDefinition(catalog, potion), (e) => e.code === 'unsupported-effect-count');
});

test('「和对手玩家猜拳，如果自己获胜的话，则在下一个对手的回合，这只宝可梦不受到招式的伤害和效果影响」: after the damage, the user\'s win only', async () => {
  const lasting = (channel) => leaf('cn.lasting@1', { side: 'own', target: 'self', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
    effect: { op: 'protection', channel, useRule: 'ordinary', scope: 'all', from: 'opponent', categories: ['attack'] } });
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.weakness = null; d.mechanics.hp = 300; }
    def(defs, 'base').mechanics.attacks.push({ attackId: 'base:trick', name: '测试戏法', cost: [], printedDamage: { value: 90, operator: 'fixed' },
      effects: [binding('cn.janken@1', { effects: [lasting('damage'), lasting('effects')] }, 'trick')], sourceOfTruth: EVIDENCE });
  });
  for (const [other, shields] of [['scissors', 2], ['paper', 0]]) {
    const g = board(f);
    command(g, { type: 'attack', attackId: 'base:trick' });
    assert.equal(g.snapshot().players[1].active.counters, 9, 'The printed damage comes first.');
    round(g, f, 'rock', other); settle(g);
    const s = g.snapshot();
    assert.equal(s.ongoing.filter((e) => e.targetId === s.players[0].active.id && e.effect.op === 'protection').length, shields);
  }
});

test('a Supporter whose janken could change nothing is not playable; restore rejects an edited hidden hand', async () => {
  const f = await fixture((defs) => {
    def(defs, 'research').mechanics.effects = [binding('cn.janken@1', { effects: [draw(1), draw(1)] }, 'janken')];
  });
  let card;
  const empty = board(f, (s) => { card = hand(s, 0, 'research'); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert(!empty.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card));
  const g = board(f, (s) => { card = hand(s, 0, 'research'); attached(s, 0, s.players[0].active, 'water'); });
  command(g, { type: 'playTrainer', cardId: card });
  answer(g, ['rock']);
  const bad = g.snapshot(); bad.pending.data.janken.user = 'paper';
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), (e) => e.code === 'invalid-selection-request');
  answer(g, ['scissors']); settle(g);
  assert.deepEqual(results(g), ['win']);
});
