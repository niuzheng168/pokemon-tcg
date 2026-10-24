// Synthetic definitions only. 「「X」可以使用1张或者同时使用4张，根据使用的张数不同效果也不同。◆如果使用1张，则查看自己牌库上方1张卡牌后，
// 放回原处。◆如果同时使用4张，则拿取1张自己的奖赏卡。（这个效果，4张卡牌发动1次。）」, 「「X」必须同时使用2张。（这个效果，2张卡牌只发动1次。）
// 选择对手的1只备战宝可梦，将其与战斗宝可梦互换。然后，将自己的战斗宝可梦与备战宝可梦互换。」, 「「X」，可以使用1张或者2张同时使用，…◆如果使用1张，
// 则从牌库上方抽取卡牌，直到自己的手牌变为3张为止。◆如果同时使用2张卡牌，则选择对手的1只备战宝可梦，将其与战斗宝可梦互换。」, 「…◆如果使用1张，
// 则回复自己的战斗宝可梦「10」点HP。◆如果同时使用4张，则将自己所有宝可梦的HP，全部回复。」, 「…◆如果使用1张，则恢复自己战斗宝可梦1个特殊状态。
// ◆如果同时使用2张，回复自己战斗宝可梦「90」点HP，并恢复所有特殊状态。」 (trainer.joint-play). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { createPlayerOngoingEffect } from '../../public/rules/ongoing.js';
import { fixture, binding, EVIDENCE, board, start, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const together = (b, playCount) => ({ ...b, playCount });
const opponentSwitch = { side: 'opponent', chooser: 'self', affected: 'selected' };
const CARDS = {
  catcher: [binding('cn.drawUntil@1', { count: 3 }, 'catcher:draw'), together(binding('cn.switch@1', opponentSwitch, 'catcher:gust'), 2)],
  switcher: [together(binding('cn.then@1', { first: { handlerId: 'cn.switch@1', parameters: opponentSwitch },
    next: { handlerId: 'cn.switch@1', parameters: { side: 'own', chooser: 'self', affected: 'active' } } }, 'switcher:both'), 2)],
  herbs: [binding('cn.cure@1', { side: 'own', target: 'active', count: 1 }, 'herbs:cure'),
    together(binding('cn.heal@1', { target: 'active', amount: 90, cureAll: true }, 'herbs:heal'), 2)],
  stone: [binding('cn.heal@1', { target: 'active', amount: 10 }, 'stone:heal'), together(binding('cn.healPokemon@1', { op: 'healPokemon',
    side: 'own', target: 'any', selector: { kind: 'pokemon' }, selection: { kind: 'all' }, amount: 'all', discardHealedEnergy: false }, 'stone:all'), 4)],
  clover: [binding('cn.arrangeDeck@1', { side: 'own', from: 'top', count: 1, to: 'same' }, 'clover:peek'),
    together(binding('cn.takePrizes@1', { count: 1 }, 'clover:take'), 4)],
  puzzle: [together(binding('cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
    reveal: true, lookTop: null, shuffleAfter: false }, 'puzzle:recover'), 2)],
  refill: [together(binding('cn.drawUntil@1', { count: 4 }, 'refill:draw'), 2)],
};
function items(defs, cards = CARDS) {
  for (const [id, effects] of Object.entries(cards)) {
    const d = clone(def(defs, 'potion'));
    Object.assign(d, { definitionId: id, nameKey: id, name: `测试${id}` }); d.mechanics.effects = clone(effects); defs.push(d);
  }
}
async function cards(more = () => {}, extraHandlers) {
  const f = await fixture((defs) => { items(defs); more(defs); }, extraHandlers);
  f.deck.splice(12, 28, ...Object.keys(CARDS).flatMap((id) => Array(4).fill(`printing:${id}`)));
  return f;
}
// The hand holds exactly these cards (by definition), in this order; wanted Prize cards are swapped back into the deck first.
function setHand(s, names, owner = 0) {
  const p = s.players[owner], wanted = (id) => names.includes(s.cards[id].definitionId);
  p.deck.push(...p.hand.splice(0));
  p.prizes = p.prizes.map((id) => (wanted(id) ? p.deck.splice(p.deck.findIndex((d) => !wanted(d)), 1, id)[0] : id));
  return names.map((name) => hand(s, owner, name));
}
const plays = (g, player = 0) => g.view(player).legalActions.filter((a) => a.type === 'playTrainer');
const opens = (s) => s.events.filter((e) => e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-open');

test('trainer.joint-play is sourced: the CN Item steps and the official Q&A on cards played together', () => {
  const rule = requireRule(CN_V20261019, 'trainer.joint-play');
  assert(rule.sourceOfTruth.some((s) => s.documentId === 'CN-advanced-3.1.0' && s.section === 'I.B-01'));
  assert(rule.sourceOfTruth.some((s) => s.documentId === 'JP-official-qa' && s.section.includes('コインは何回投げますか？→1回投げます。')));
});

test('playCount is an Item\'s own resolving entry: one count per card, no costs or triggers, never 「这张卡牌」 alone', async () => {
  const rejected = async (transform) => {
    const f = await fixture((defs) => { items(defs, { catcher: CARDS.catcher }); transform(defs); });
    f.deck.splice(12, 1, 'printing:catcher');
    assert.throws(() => start(f), { code: 'unsupported-joint-play' });
  };
  await rejected((defs) => { def(defs, 'research').mechanics.effects[1].playCount = 2; });
  await rejected((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [together(binding('cn.draw@1', { count: 1 }), 2)]; });
  await rejected((defs) => { def(defs, 'base').mechanics.effects = [together(binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'self' }), 2)]; });
  await rejected((defs) => { def(defs, 'catcher').mechanics.playCosts = [{ costId: 'fee', kind: 'discardHand', count: 1, selector: { kind: 'any' }, sourceOfTruth: EVIDENCE }]; });
  await rejected((defs) => { def(defs, 'catcher').mechanics.effects.push(together(binding('cn.draw@1', { count: 1 }, 'catcher:four'), 4)); });
  await rejected((defs) => { def(defs, 'catcher').mechanics.effects.push(together(binding('cn.returnSelf@1', {}, 'catcher:back'), 2)); });
  await rejected((defs) => {
    def(defs, 'catcher').mechanics.effects.push(together({ ...binding('cn.draw@1', { count: 1 }, 'catcher:drawn'),
      trigger: { event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'any', optional: false, afterUse: 'hand' } }, 2));
  });
  for (const playCount of [1, 5])
    await assert.rejects(fixture((defs) => { items(defs, { catcher: CARDS.catcher }); def(defs, 'catcher').mechanics.effects[1].playCount = playCount; }));
});

test('「可以使用1张或者2张同时使用」: one alone, or two together as one use whose effect happens once; both go to the discard pile after it', async () => {
  const f = await cards();
  let first, second, other, target;
  let g = board(f, (s) => { [first, second, other] = setHand(s, ['catcher', 'catcher', 'water']); target = bench(s, 1, 'other').id; });
  assert.deepEqual(plays(g), [{ type: 'playTrainer', cardId: first, jointCardIds: [second] },
    { type: 'playTrainer', cardId: first }, { type: 'playTrainer', cardId: second }], 'Together once per name, from its first card; or each alone.');
  assert.throws(() => command(g, { type: 'playTrainer', cardId: second, jointCardIds: [first] }), { code: 'illegal-action' });
  command(g, { type: 'playTrainer', cardId: first, jointCardIds: [second] });
  let s = g.snapshot();
  assert.deepEqual(s.players[0].resolving, [first, second], 'Both are played from the hand; neither is in the discard pile yet.');
  assert.deepEqual(s.players[0].hand, [other]);
  assert.equal(opens(s).length, 1, 'One use of an Item.');
  assert.deepEqual(opens(s)[0].data.jointCardIds, [second]);
  assert.equal(s.pending.kind, 'effect-target'); assert.deepEqual(s.pending.options, [target]);
  g = restore(g, f); answer(g, [target]); settle(g);
  s = g.snapshot();
  assert.equal(s.players[1].active.id, target, 'The two-card effect, once.');
  assert.deepEqual(s.players[0].hand, [other], 'Not the one-card draw.');
  assert.deepEqual(s.players[0].resolving, []);
  assert.deepEqual(s.players[0].discard.slice(-2), [first, second]);
  assert(s.events.some((e) => e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-finished'));
  restore(g, f);
  // One alone: its own one-card effect.
  g = board(f, (s) => { [first, second] = setHand(s, ['catcher', 'catcher']); bench(s, 1, 'other'); });
  command(g, { type: 'playTrainer', cardId: second }); settle(g);
  s = g.snapshot();
  assert.equal(s.players[0].hand.length, 3); assert(s.players[0].hand.includes(first)); assert(s.players[0].discard.includes(second));
  assert(!opens(s).at(-1).data.jointCardIds);
});

test('official Q&A: 「手札が5枚あるとき…1枚で使うことは…できません」「相手のベンチにポケモンがいないとき…2枚同時に使うことは…できません」', async () => {
  const f = await cards();
  let first, second;
  const g = board(f, (s) => { [first, second] = setHand(s, ['catcher', 'catcher', 'water', 'water', 'water']); });
  assert.deepEqual(plays(g), [], 'After playing one, four cards remain; with no Benched Pokémon the pair changes nothing.');
  const two = board(f, (s) => { [first, second] = setHand(s, ['catcher', 'catcher', 'water']); });
  assert.deepEqual(plays(two), [{ type: 'playTrainer', cardId: first }, { type: 'playTrainer', cardId: second }]);
});

test('「必须同时使用2张」: never one alone; two of three are offered together; their switch then the user\'s own switch', async () => {
  const f = await cards();
  let a, b, c, theirs, mine;
  const one = board(f, (s) => { [a] = setHand(s, ['switcher']); bench(s, 1, 'other'); bench(s, 0, 'other'); });
  assert.deepEqual(plays(one), []);
  let g = board(f, (s) => {
    [a, b, c] = setHand(s, ['switcher', 'switcher', 'switcher']); theirs = bench(s, 1, 'other').id; mine = bench(s, 0, 'other').id;
  });
  assert.deepEqual(plays(g), [{ type: 'playTrainer', cardId: a, jointCardIds: [b] }]);
  command(g, { type: 'playTrainer', cardId: a, jointCardIds: [b] });
  answer(g, [theirs]); g = restore(g, f); answer(g, [mine]); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.id, theirs); assert.equal(s.players[0].active.id, mine);
  assert.deepEqual(s.players[0].hand, [c]); assert.deepEqual(s.players[0].discard.slice(-2), [a, b]);
  assert.deepEqual(plays(g), [], 'The third cannot be played alone.');
});

test('official Q&A: 「マヒになっていて、ダメカンがのっていないとき…「ミックスハーブ」を2枚同時に使うことは…できます」', async () => {
  const f = await cards();
  let first, second;
  let g = board(f, (s) => {
    [first, second] = setHand(s, ['herbs', 'herbs']);
    Object.assign(s.players[0].active.conditions, { rotation: 'paralyzed', paralysisRecoverTurn: s.turn + 1 });
  });
  assert.equal(plays(g).length, 3);
  command(g, { type: 'playTrainer', cardId: first, jointCardIds: [second] }); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].active.conditions.rotation, null); assert.equal(s.players[0].active.counters, 0);
  // Damaged without a Special Condition: the pair heals 90; one alone cures nothing and cannot be played.
  g = board(f, (s) => { [first, second] = setHand(s, ['herbs', 'herbs']); s.players[0].active.counters = 5; });
  assert.deepEqual(plays(g), [{ type: 'playTrainer', cardId: first, jointCardIds: [second] }]);
  command(g, { type: 'playTrainer', cardId: first, jointCardIds: [second] }); settle(g);
  s = g.snapshot();
  assert.equal(s.players[0].active.counters, 0);
});

test('「同时使用4张」: three are not enough; four heal every own Pokémon fully, once; an Item lock stops the four as one Item', async () => {
  const f = await cards();
  let ids, mon;
  const three = board(f, (s) => { ids = setHand(s, ['stone', 'stone', 'stone']); mon = bench(s, 0, 'other'); mon.counters = 6; });
  assert.deepEqual(plays(three), [], 'Only the Benched Pokémon is damaged; one alone heals the Active.');
  let g = board(f, (s) => { ids = setHand(s, ['stone', 'stone', 'water', 'stone', 'stone']); mon = bench(s, 0, 'other'); mon.counters = 6;
    s.players[0].active.counters = 3; });
  assert.deepEqual(plays(g)[0], { type: 'playTrainer', cardId: ids[0], jointCardIds: [ids[1], ids[3], ids[4]] });
  command(g, { type: 'playTrainer', cardId: ids[0], jointCardIds: [ids[1], ids[3], ids[4]] });
  g = restore(g, f); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[0].active.counters, 0); assert.equal(s.players[0].bench[0].counters, 0);
  assert.deepEqual(s.players[0].hand, [ids[2]]); assert.deepEqual(s.players[0].discard.slice(-4), [ids[0], ids[1], ids[3], ids[4]]);
  const locked = board(f, (s) => {
    ids = setHand(s, ['stone', 'stone', 'stone', 'stone']); s.players[0].active.counters = 3;
    s.playerOngoing.push(createPlayerOngoingEffect({ id: `e${++s.serial}`, player: 0,
      source: { instanceId: s.players[1].active.stack[0], owner: 1, cardOwner: 1, category: 'attack', pokemonId: s.players[1].active.id,
        attackId: 'base:strike', effectId: 'fixture:item-lock', sourceOfTruth: EVIDENCE, origin: 'field' },
      effect: { op: 'playerRestriction', scope: 'all', actions: ['playItem'] }, duration: 'untilNextOwnTurnEnd' }, s));
  });
  assert.deepEqual(plays(locked), []);
});

test('「同时使用4张，则拿取1张自己的奖赏卡」: one Prize for the four; one alone looks at the top card and puts it back', async () => {
  const f = await cards();
  let ids;
  let g = board(f, (s) => { ids = setHand(s, ['clover', 'clover', 'clover', 'clover']); });
  assert.equal(plays(g).length, 5);
  command(g, { type: 'playTrainer', cardId: ids[0], jointCardIds: ids.slice(1) });
  assert.equal(g.snapshot().pending.kind, 'prize'); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].prizes.length, 5); assert.equal(s.players[0].hand.length, 1);
  assert(s.events.some((e) => e.ruleId === 'prizes.take-effect'));
  g = board(f, (s) => { ids = setHand(s, ['clover']); });
  const top = g.snapshot().players[0].deck.at(-1);
  command(g, { type: 'playTrainer', cardId: ids[0] }); settle(g);
  s = g.snapshot();
  assert.equal(s.players[0].deck.at(-1), top); assert.equal(s.players[0].prizes.length, 6);
});

test('official Q&A 「時のパズル」: the cards just played together are not in the discard pile while their effect resolves', async () => {
  const f = await cards();
  let a, b, old;
  const g = board(f, (s) => { [a, b] = setHand(s, ['puzzle', 'puzzle']); old = s.players[0].deck.pop(); s.players[0].discard.push(old); });
  command(g, { type: 'playTrainer', cardId: a, jointCardIds: [b] });
  const q = g.snapshot().pending;
  assert(!q.options.includes(a) && !q.options.includes(b));
  settle(g, (q) => q.options.slice(0, q.minimum));
  const s = g.snapshot();
  assert(s.players[0].hand.includes(old)); assert.deepEqual(s.players[0].discard.slice(-2), [a, b]);
});

test('what the cards played together change is judged with all of them out of the hand', async () => {
  const f = await cards();
  let a, b;
  // Five in hand: after both leave, three remain and the pair draws one (judged with only one gone, four would remain).
  const g = board(f, (s) => { [a, b] = setHand(s, ['refill', 'refill', 'water', 'water', 'water']); });
  assert.deepEqual(plays(g), [{ type: 'playTrainer', cardId: a, jointCardIds: [b] }]);
  command(g, { type: 'playTrainer', cardId: a, jointCardIds: [b] }); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 4);
  const full = board(f, (s) => { setHand(s, ['refill', 'refill', 'water', 'water', 'water', 'water']); });
  assert.deepEqual(plays(full), []);
});

test('a field effect that depends on the hand sees both cards gone in the prospective body of a joint play', async () => {
  const FIELD = 'fixture:joint-field';
  const provider = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'continuous', operations: ['protection'],
    validateParameters: (p) => Object.keys(p).length === 0,
    // Shields its holder's side from its own Trainers while a 「herbs」 is in that hand.
    execute: (ctx) => ctx.state.players[ctx.source.owner].hand.some((id) => ctx.state.cards[id].definitionId === 'herbs') ?
      [{ op: 'protection', useRule: 'ordinary', channel: 'effects', scope: 'own', from: 'own', categories: ['trainer', 'ability'] }] : [] };
  const f = await cards((defs) => { def(defs, 'base').mechanics.effects.push(binding(FIELD, {})); }, new Map([[FIELD, provider]]));
  let a, b;
  // Only the pair heals (one alone cures a Special Condition, and there is none): it is judged with both out of the hand, unshielded.
  let g = board(f, (s) => { [a, b] = setHand(s, ['herbs', 'herbs']); s.players[0].active.counters = 3; });
  const before = g.snapshot();
  assert.deepEqual(plays(g), [{ type: 'playTrainer', cardId: a, jointCardIds: [b] }]);
  assert.deepEqual(g.snapshot(), before, 'The prospective body never escapes the read-only proof.');
  command(g, { type: 'playTrainer', cardId: a, jointCardIds: [b] }); g = restore(g, f); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 0);
  // A third in the hand stays there: the pair would heal under the shield, so it cannot be played.
  g = board(f, (s) => { setHand(s, ['herbs', 'herbs', 'herbs']); s.players[0].active.counters = 3; });
  assert.deepEqual(plays(g), []);
});

test('the joint finalizer keeps the cards played together in the resolution zone and in its public use record', async () => {
  const f = await cards();
  let a, b, target;
  const g = board(f, (s) => { [a, b] = setHand(s, ['catcher', 'catcher']); target = bench(s, 1, 'other').id; });
  command(g, { type: 'playTrainer', cardId: a, jointCardIds: [b] });
  const moved = clone(g.snapshot()), p = moved.players[0];
  p.resolving.splice(p.resolving.indexOf(b), 1); p.discard.push(b);
  assert.throws(() => OfficialGame.restore(moved, { catalog: f.catalog }), { code: 'invalid-trainer-finish' });
  const relabelled = clone(g.snapshot());
  delete relabelled.events.find((e) => e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-open' && e.data.cardId === a).data.jointCardIds;
  assert.throws(() => OfficialGame.restore(relabelled, { catalog: f.catalog }), { code: 'invalid-trainer-finish' });
  answer(g, [target]); settle(g);
  assert.deepEqual(g.snapshot().players[0].discard.slice(-2), [a, b]);
});
