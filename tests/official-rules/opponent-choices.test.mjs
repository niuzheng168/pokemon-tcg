// Synthetic definitions only. Texts where the OTHER player decides or is protected:
// 「在自己的回合，当将这张卡牌从手牌使出并进行进化时，可使用1次。双方玩家，各选择自己弃牌区中的1张【基础】宝可梦，放于自己的备战区。（由对手开始
// 放于备战区。）」 (effects.holder-choice);
// 「只要这只宝可梦在场上，当对手的战斗宝可梦【昏厥】时，自己抛掷1次硬币。如果为正面，则下一只被放于对手战斗场的备战宝可梦，由这只宝可梦的持有者
// 选择。」 (ko.promotion-chooser);
// 「在对手的回合，当这张卡牌因为对手的招式、特性、物品、支援者的效果而从手牌被放于弃牌区时，将对手的手牌全部放于弃牌区。」 (trigger.discarded).
// 「选择自己弃牌区中的1张训练家，在给对手看过之后，询问对手是否可以加入手牌。如果对手允许，则将选择的卡牌加入手牌。如果对手不允许，则将选择的卡牌
// 放回弃牌区，从自己的牌库上方抽取3张卡牌。」 (effects.consent). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const roundTrip = (g, f) => assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const toDiscard = (s, owner, id) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner].discard.push(card); return card; };
const deploys = (s) => s.events.filter((e) => e.ruleId === 'effects.deploy' && e.data.cardId).map((e) => [e.data.player, e.data.cardId]);

// 「双方玩家，各选择自己弃牌区中的1张【基础】宝可梦，放于自己的备战区。（由对手开始放于备战区。）」
const revive = { from: 'discard', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] }, quantity: { kind: 'exact', count: 1 },
  reveal: false, lookTop: null, shuffleAfter: false };
const theirs = { ...revive, side: 'opponent', chooser: 'opponent' };
const lifeboat = (defs) => {
  def(defs, 'evolution').mechanics.abilities = [{ abilityId: 'evolution:lifeboat', name: '测试救生船', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
    trigger: { event: 'evolve', origin: 'hand', subject: 'self', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true },
    effects: [binding('cn.cards@1', theirs, 'lifeboat-opponent'), binding('cn.cards@1', revive, 'lifeboat-own')] }];
};
// Four of each Basic Pokémon in each deck.
const crowded = (f) => { f.deck.splice(-4, 4, 'printing:base', 'printing:base', 'printing:other', 'printing:other'); return f; };
const evolve = (g, card) => command(g, g.view(0).legalActions.find((a) => a.type === 'evolve' && a.cardId === card));

test('effects.holder-choice schema: the opponent chooses from the opponent\'s own discard pile, onto the Bench or into the hand', () => {
  assert(valid('cn.cards@1', theirs));
  assert(valid('cn.cards@1', { ...theirs, to: 'hand', selector: { kind: 'any' }, reveal: true }));
  assert(!valid('cn.cards@1', { ...theirs, to: 'deck', shuffleAfter: true }));
  assert(!valid('cn.cards@1', { ...revive, chooser: 'opponent' }), 'Without side the opponent chooses only among the user\'s revealed deck cards.');
  assert(!valid('cn.cards@1', { ...theirs, from: 'deck', lookTop: 5, reveal: true, shuffleAfter: true }));
  assert(valid('cn.cards@1', { from: 'deck', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 2 }, reveal: true, lookTop: 5,
    shuffleAfter: false, remainder: 'hand', chooser: 'opponent' }));
});

test('「双方玩家，各选择自己弃牌区中的1张【基础】宝可梦…（由对手开始放于备战区。）」: the opponent first, each from their own pile', async () => {
  const f = await fixture((defs) => {
    lifeboat(defs);
    // A 「当将这张卡牌从手牌使出放于备战区时」 Ability does not start from the discard pile (JP Q&A ミロカロス × ギラティナ).
    def(defs, 'other').mechanics.abilities = [{ abilityId: 'other:gate', name: '测试破损之门', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'bench', origin: 'hand', subject: 'self', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true },
      effects: [binding('cn.counters@1', { side: 'opponent', target: 'any', count: 1 }, 'gate')] }];
  });
  let card, foeBase, foeOther, mine;
  const g = board(f, (s) => {
    card = hand(s, 0, 'evolution'); s.players[0].active.enteredTurn = 1;
    foeBase = toDiscard(s, 1, 'base'); foeOther = toDiscard(s, 1, 'other'); toDiscard(s, 1, 'evolution'); toDiscard(s, 1, 'water');
    mine = toDiscard(s, 0, 'other');
  });
  evolve(g, card);
  assert.equal(g.snapshot().pending.kind, 'trigger-optional');
  answer(g, ['perform']);
  let q = g.snapshot().pending;
  assert.equal(q.player, 1, 'The opponent chooses first, from the opponent\'s own discard pile.');
  assert.equal(q.kind, 'select-cards');
  assert.deepEqual(q.options, [foeBase, foeOther]);
  assert.deepEqual([q.minimum, q.maximum], [1, 1], 'A public pile: the printed 1 card must be chosen (II.D-04).');
  roundTrip(g, f);
  answer(g, [foeOther]);
  q = g.snapshot().pending;
  assert.equal(q.player, 0); assert.deepEqual(q.options, [mine]);
  answer(g, [mine]);
  const s = g.snapshot();
  assert.equal(s.pending, null);
  assert.deepEqual(deploys(s), [[1, foeOther], [0, mine]]);
  assert.deepEqual(s.players[1].bench.map((m) => m.stack[0]), [foeOther]);
  assert.deepEqual(s.players[0].bench.map((m) => m.stack[0]), [mine]);
  assert.equal(s.players[0].active.counters, 0, 'Not put onto the Bench from the hand.');
  assert(s.events.some((e) => e.ruleId === 'selection.request' && e.data.request?.ruleId === 'effects.holder-choice'));
});

test('effects.holder-choice: a full Bench or an empty pile skips that player only; when neither can, nothing is offered', async () => {
  const f = crowded(await fixture(lifeboat));
  // JP Q&A ミロカロス「たすけぶね」: with no Bench space of its own, only the opponent does it.
  let card, foe;
  const g = board(f, (s) => {
    card = hand(s, 0, 'evolution'); s.players[0].active.enteredTurn = 1;
    for (const id of ['base', 'base', 'base', 'other', 'other']) bench(s, 0, id);
    toDiscard(s, 0, 'other'); foe = toDiscard(s, 1, 'base');
  });
  evolve(g, card); answer(g, ['perform']);
  assert.equal(g.snapshot().pending.player, 1);
  answer(g, [foe]);
  assert.equal(g.snapshot().pending, null);
  assert.equal(g.snapshot().players[0].bench.length, 5);
  assert.deepEqual(g.snapshot().players[1].bench.map((m) => m.stack[0]), [foe]);
  // Only the user's own pile has a Basic Pokémon.
  let mine;
  const h = board(f, (s) => { card = hand(s, 0, 'evolution'); s.players[0].active.enteredTurn = 1; mine = toDiscard(s, 0, 'base'); });
  evolve(h, card); answer(h, ['perform']);
  assert.equal(h.snapshot().pending.player, 0);
  answer(h, [mine]);
  assert.deepEqual(h.snapshot().players[1].bench, []);
  // Neither player has one: the Ability could change nothing.
  const k = board(f, (s) => { card = hand(s, 0, 'evolution'); s.players[0].active.enteredTurn = 1; toDiscard(s, 1, 'evolution'); });
  evolve(k, card);
  assert.equal(k.snapshot().pending, null);
  settle(k);
});

// 「只要这只宝可梦在场上，当对手的战斗宝可梦【昏厥】时，自己抛掷1次硬币。如果为正面，则下一只被放于对手战斗场的备战宝可梦，由这只宝可梦的持有者选择。」
const TAILS_FIRST = [1, 33554432, 2, 3];
const HEADS_FIRST = [123, 456, 789, 10];
const pendulum = (abilityId) => ({ abilityId, name: '测试诱导钟摆', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
  trigger: { event: 'knockout', subject: 'opponent', activeOnly: true, optional: false, choiceOwner: 'source', scope: 'global' },
  effects: [binding('cn.coin@1', { outcome: 'heads', effect: { handlerId: 'cn.promotionChooser@1', parameters: {} } }, 'pendulum')] });
const hypno = async (transform = () => {}) => crowded(await fixture((defs) => { def(defs, 'other').mechanics.abilities = [pendulum('other:pendulum')]; transform(defs); }));
// Default answers (a Prize card, the printed target) until the promotion prompt.
const untilPromote = (g) => { while (g.snapshot().pending && g.snapshot().pending.kind !== 'promote') answer(g, g.snapshot().pending.options.slice(0, 1)); };
const coins = (s) => s.events.filter((e) => e.ruleId === 'effects.coin').map((e) => e.data.result);
// The Active Pokémon becomes a fresh one of that card; one Water Energy on player 0's Active pays its attack.
const activate = (s, owner, id) => { const p = s.players[owner], m = bench(s, owner, id); p.bench.pop(); p.hand.push(...p.active.stack); p.active = m; return m; };
const charge = (s) => { const e = hand(s, 0, 'water'); s.players[0].hand.pop(); s.players[0].active.energy.push(e); };

test('ko.promotion-chooser schema: a static leaf, alone or as a coin\'s result', () => {
  assert(valid('cn.promotionChooser@1', {}));
  assert(!valid('cn.promotionChooser@1', { side: 'opponent' }));
  assert(valid('cn.coin@1', { outcome: 'heads', effect: { handlerId: 'cn.promotionChooser@1', parameters: {} } }));
});

test('「如果为正面，则下一只被放于对手战斗场的备战宝可梦，由这只宝可梦的持有者选择」: heads — the holder picks the opponent\'s new Active', async () => {
  const f = await hypno();
  let one, two;
  const g = board(f, (s) => {
    charge(s); bench(s, 0, 'other'); s.players[1].active.counters = 9; one = bench(s, 1, 'base'); two = bench(s, 1, 'base'); s.rng = [...HEADS_FIRST];
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); untilPromote(g);
  const q = g.snapshot().pending;
  assert.deepEqual(coins(g.snapshot()), ['heads']);
  assert.equal(q.kind, 'promote'); assert.equal(q.player, 0, 'This Pokémon\'s holder chooses (JP Q&A スリーパー「さそうふりこ」).');
  assert.equal(q.ruleId, 'ko.promotion-chooser');
  assert.deepEqual(q.options, [one.id, two.id]);
  assert.deepEqual([q.minimum, q.maximum, q.allowZero], [1, 1, false], 'Not choosing is not allowed.');
  assert.equal(g.snapshot().players[1].promotedBy.owner, 0);
  roundTrip(g, f);
  const forged = clone(g.snapshot()); forged.pending.player = 1;
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-promotion');
  const wrong = clone(g.snapshot()); wrong.players[1].promotedBy.owner = 1;
  assert.throws(() => OfficialGame.restore(wrong, { catalog: f.catalog }), (e) => e.code === 'invalid-promotion');
  answer(g, [two.id]);
  const s = g.snapshot();
  assert.equal(s.players[1].active.id, two.id);
  assert.equal(s.players[1].promotedBy, undefined, 'Only the next promotion.');
  assert.deepEqual(s.events.filter((e) => e.ruleId === 'ko.promote').map((e) => [e.data.player, e.data.chooser]), [[1, 0]]);
  assert.equal(s.pending, null);
});

test('ko.promotion-chooser: tails, an Ability made ineffective by the Knocked Out Pokémon, or no Bench — the ordinary promotion', async () => {
  // Tails: the opponent promotes as usual.
  const f = await hypno();
  let one;
  const g = board(f, (s) => { charge(s); bench(s, 0, 'other'); s.players[1].active.counters = 9; one = bench(s, 1, 'base'); bench(s, 1, 'base'); s.rng = [...TAILS_FIRST]; });
  command(g, { type: 'attack', attackId: 'base:strike' }); untilPromote(g);
  assert.deepEqual(coins(g.snapshot()), ['tails']);
  const q = g.snapshot().pending;
  assert.equal(q.player, 1); assert.equal(q.ruleId, 'ko.promote');
  answer(g, [one.id]);
  assert.deepEqual(g.snapshot().events.filter((e) => e.ruleId === 'ko.promote').map((e) => e.data.chooser), [undefined]);
  // JP Q&A スリーパー × ガラル マタドガス／ケッキング: the Knocked Out Active's own Ability-removing effect still applies at that time.
  const gas = await hypno((defs) => {
    def(defs, 'evolution').mechanics.abilities = [pendulum('evolution:pendulum')];
    def(defs, 'other').mechanics.abilities = [{ abilityId: 'other:gas', name: '测试化学变化气体', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'abilities', scope: 'all', stage: 'stage1' } }, 'gas')] }];
  });
  const h = board(gas, (s) => {
    charge(s); const m = bench(s, 0, 'base'); m.stack.push(hand(s, 0, 'evolution')); s.players[0].hand.pop();
    activate(s, 1, 'other').counters = 9; bench(s, 1, 'base'); s.rng = [...HEADS_FIRST];
  });
  command(h, { type: 'attack', attackId: 'base:strike' }); untilPromote(h);
  assert.deepEqual(coins(h.snapshot()), [], 'No coin: the Ability was not in effect when the Active was Knocked Out.');
  assert.equal(h.snapshot().pending.player, 1);
  // The same Hypno without that Active: it flips.
  const plain = board(gas, (s) => {
    charge(s); const m = bench(s, 0, 'base'); m.stack.push(hand(s, 0, 'evolution')); s.players[0].hand.pop();
    s.players[1].active.counters = 9; bench(s, 1, 'base'); s.rng = [...HEADS_FIRST];
  });
  command(plain, { type: 'attack', attackId: 'base:strike' });
  assert.deepEqual(coins(plain.snapshot()), ['heads']);
  // No Benched Pokémon: the opponent loses; nothing to choose, no coin.
  const k = board(f, (s) => { charge(s); bench(s, 0, 'other'); s.players[1].active.counters = 9; s.rng = [...HEADS_FIRST]; });
  command(k, { type: 'attack', attackId: 'base:strike' }); untilPromote(k);
  assert.deepEqual(coins(k.snapshot()), []);
  assert.equal(k.snapshot().result.winner, 0);
});

test('ko.promotion-chooser: Knocked Out together with the opponent\'s Active, it still flips; the next-turn player\'s promotion comes first', async () => {
  const f = await hypno((defs) => {
    def(defs, 'other').mechanics.attacks[0].effects = [binding('cn.counters@1', { side: 'own', target: 'self', count: 10 }, 'self-ko')];
  });
  let foe, mine;
  const g = board(f, (s) => {
    activate(s, 0, 'other'); charge(s); mine = bench(s, 0, 'base');
    s.players[1].active.counters = 9; foe = bench(s, 1, 'base'); bench(s, 1, 'base'); s.rng = [...HEADS_FIRST];
  });
  command(g, { type: 'attack', attackId: 'other:strike' }); untilPromote(g);
  assert.deepEqual(coins(g.snapshot()), ['heads']);
  let q = g.snapshot().pending;
  assert.equal(q.player, 0); assert.equal(q.ruleId, 'ko.promotion-chooser');
  assert(q.options.includes(foe.id) && !q.options.includes(mine.id));
  answer(g, [foe.id]);
  q = g.snapshot().pending;
  assert.equal(q.player, 0); assert.equal(q.ruleId, 'ko.promote'); assert.deepEqual(q.options, [mine.id]);
  answer(g, [mine.id]);
  assert.equal(g.snapshot().players[1].active.id, foe.id);
});

// 「在对手的回合，当这张卡牌因为对手的招式、特性、物品、支援者的效果而从手牌被放于弃牌区时，将对手的手牌全部放于弃牌区。」
const SPORE = { event: 'discarded', from: 'hand', turn: 'opponent', optional: false,
  causeSource: { side: 'opponent', categories: ['attack', 'ability', 'item', 'supporter'] } };
const spore = { abilityId: 'other:spore', name: '测试整蛊孢子', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE, trigger: SPORE,
  effects: [binding('cn.discardHand@1', { side: 'opponent' }, 'spore')] };
const foeChooses = (count = 1) => binding('cn.opponentHand@1', { mode: 'opponentChooses', selector: { kind: 'any' }, quantity: { kind: 'exact', count }, to: 'discard' }, 'trim');
const look = (count) => binding('cn.opponentHand@1', { mode: 'look', selector: { kind: 'pokemon' }, quantity: { kind: 'upTo', count }, to: 'discard' }, 'pluck');
const sporeUses = (s) => s.events.filter((e) => e.ruleId === 'trigger.discarded' && e.data.kind === 'used').map((e) => e.data.cardId);
const amoonguss = async (transform = () => {}) => crowded(await fixture((defs) => { def(defs, 'other').mechanics.abilities = [spore]; transform(defs); }));

test('trigger.discarded schema: the opponent\'s attack, Ability, Item or Supporter, from the hand; cn.discardHand@1 side opponent', async () => {
  await amoonguss();
  assert(valid('cn.discardHand@1', { side: 'opponent' })); assert(valid('cn.discardHand@1', {}));
  assert(!valid('cn.discardHand@1', { side: 'own' }));
  const reject = (trigger) => assert.rejects(amoonguss((defs) => { def(defs, 'other').mechanics.abilities = [{ ...spore, trigger }]; }), /Invalid normalized card definition/);
  await reject({ ...SPORE, from: 'field' });
  await reject({ ...SPORE, causeSource: { side: 'own', categories: ['attack'] } });
  await reject({ ...SPORE, causeSource: { side: 'opponent', categories: ['stadium'] } });
  await reject({ ...SPORE, turn: 'own' });
});

test('「…因为对手的…支援者的效果而从手牌被放于弃牌区时」: after the whole Supporter, the user\'s own discarded cards first (JP Q&A ムサシとコジロウ × マタドガス × モロバレル)', async () => {
  const f = await amoonguss((defs) => {
    // 「双方玩家，各…放于弃牌区」 written as two parts; the user's own discarded 'base' then draws a card (its own trigger, the Supporter named).
    def(defs, 'research').mechanics.effects = [foeChooses(), binding('cn.cards@1', { from: 'hand', to: 'discard', selector: { kind: 'pokemon' },
      quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: null, shuffleAfter: false }, 'own')];
    def(defs, 'base').mechanics.abilities = [{ abilityId: 'base:hole', name: '测试白洞', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'discarded', from: 'hand', optional: false, causeSource: { side: 'own', categories: ['supporter'], card: { kind: 'trainer', nameKeys: ['research'] } } },
      effects: [binding('cn.draw@1', { count: 1 }, 'hole')] }];
  });
  let supporter, mine, theirs, kept;
  const g = board(f, (s) => {
    supporter = hand(s, 0, 'research'); mine = hand(s, 0, 'base'); hand(s, 0, 'other');
    s.players[1].deck.push(...s.players[1].hand.splice(0)); theirs = hand(s, 1, 'other'); kept = hand(s, 1, 'water');
  });
  command(g, { type: 'playTrainer', cardId: supporter });
  let q = g.snapshot().pending;
  assert.equal(q.player, 1);
  // JP Q&A モロバレル × クセロシキのたくらみ: chosen by its own holder, it is still discarded by the opponent's Supporter.
  answer(g, [theirs]);
  q = g.snapshot().pending;
  assert.equal(q.player, 0);
  const finish = g.snapshot().queue.find((t) => t.op === 'finish-trainer');
  assert.deepEqual(finish.data.discarded.map((u) => u.cardId), [theirs]);
  roundTrip(g, f);
  answer(g, [mine]);
  const s = g.snapshot();
  assert.equal(s.pending, null);
  assert.deepEqual(sporeUses(s), [mine, theirs], 'The Supporter user\'s discarded card first, then the opponent\'s.');
  const at = (rule, test) => s.events.findIndex((e) => e.ruleId === rule && test(e.data));
  assert(at('turn.trainer', (d) => d.kind === 'trainer-finished') < at('trigger.discarded', (d) => d.kind === 'used'));
  assert.deepEqual(s.players[0].hand, [], 'Its whole hand, the card just drawn included; its own copy does not start on its own turn.');
  assert.deepEqual(s.players[1].hand, [kept]);
  assert(s.players[0].discard.includes(supporter));
});

test('「…因为对手的招式…的效果…」: once the attack is done, before its Knock Outs; not by its owner\'s own effects', async () => {
  const f = await amoonguss((defs) => {
    def(defs, 'base').mechanics.attacks[0].effects = [look(1), binding('cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'any' },
      quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: null, shuffleAfter: true }, 'search')];
  });
  let theirs;
  const g = board(f, (s) => { charge(s); s.players[1].active.counters = 9; bench(s, 1, 'base'); theirs = hand(s, 1, 'other'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  answer(g, [theirs]);
  assert.equal(g.snapshot().pending.kind, 'select-cards', 'The attack is not done yet.');
  const finish = g.snapshot().queue.find((t) => t.op === 'finish-attack');
  assert.deepEqual(finish.data.discarded.map((u) => u.cardId), [theirs]);
  roundTrip(g, f);
  const forged = clone(g.snapshot()); forged.queue.find((t) => t.op === 'finish-attack').data.discarded[0].abilityId = 'other:none';
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-discard-trigger');
  answer(g, g.snapshot().pending.options.slice(0, 1));
  const s = g.snapshot();
  assert.deepEqual(sporeUses(s), [theirs]);
  assert.deepEqual(s.players[0].hand, []);
  assert(s.events.findIndex((e) => e.ruleId === 'trigger.discarded' && e.data.kind === 'used') <
    s.events.findIndex((e) => e.ruleId === 'ko.boundary' && e.data.kind === 'latched'), 'Before the Knock Out.');
  // Its owner's own Supporter on its own turn: no trigger.
  const own = await amoonguss();
  let supporter;
  const h = board(own, (s) => { supporter = hand(s, 0, 'research'); hand(s, 0, 'other'); });
  command(h, { type: 'playTrainer', cardId: supporter }); settle(h);
  assert.deepEqual(sporeUses(h.snapshot()), []);
  assert.equal(h.snapshot().players[1].hand.length > 0, true);
});

test('「…因为对手的…特性的效果…」: after that Ability\'s own entries; two at once are ordered by their holder; a Checkup is no turn', async () => {
  const f = await amoonguss((defs) => {
    def(defs, 'base').mechanics.abilities = [{ abilityId: 'base:pluck', name: '测试拔取', mode: 'activated', sourceOfTruth: EVIDENCE,
      usage: { period: 'turn', scope: 'pokemon', key: 'cn:ability:pluck', limit: 1 }, effects: [look(2), binding('cn.draw@1', { count: 1 }, 'draw')] }];
  });
  let one, two;
  const g = board(f, (s) => { s.players[1].deck.push(...s.players[1].hand.splice(0)); one = hand(s, 1, 'other'); two = hand(s, 1, 'other'); hand(s, 1, 'water'); });
  command(g, { type: 'useAbility', abilityId: 'base:pluck', pokemonId: g.snapshot().players[0].active.id });
  answer(g, [one, two]);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'trigger-order'); assert.equal(q.player, 1);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.draw' && e.data.player === 0 && e.data.count === 1), 'The Ability finished first.');
  roundTrip(g, f);
  answer(g, [q.options[1]]);
  const s = g.snapshot();
  assert.deepEqual(sporeUses(s), [two, one]);
  assert.deepEqual(s.players[0].hand, []);
  // 「在对手的回合」: a Pokémon Checkup belongs to no turn (II.F), so a discard then starts nothing.
  const checkup = await amoonguss((defs) => {
    def(defs, 'other').mechanics.abilities.push({ abilityId: 'other:night', name: '测试夜袭', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'checkup', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global', sourceActive: true },
      effects: [binding('cn.opponentHand@1', { mode: 'faceDown', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, to: 'discard' }, 'night')] });
  });
  let card;
  const h = board(checkup, (s) => { activate(s, 0, 'other'); s.players[1].deck.push(...s.players[1].hand.splice(0)); card = hand(s, 1, 'other'); });
  command(h, { type: 'endTurn' }); settle(h);
  assert(h.snapshot().players[1].discard.includes(card));
  assert.deepEqual(sporeUses(h.snapshot()), []);
});

// 「选择自己弃牌区中的1张训练家，在给对手看过之后，询问对手是否可以加入手牌。如果对手允许，则将选择的卡牌加入手牌。如果对手不允许，则将选择的卡牌放回
// 弃牌区，从自己的牌库上方抽取3张卡牌。」
const recover = { handlerId: 'cn.cards@1', parameters: { from: 'discard', to: 'hand', selector: { kind: 'trainer' }, quantity: { kind: 'exact', count: 1 },
  reveal: true, lookTop: null, shuffleAfter: false } };
const draw3 = { handlerId: 'cn.draw@1', parameters: { count: 3 } };
const ASK = { first: recover, otherwise: draw3, consent: true };
const sordward = (transform = () => {}) => fixture((defs) => { def(defs, 'research').mechanics.effects = [binding('cn.orElse@1', ASK, 'ask')]; transform(defs); });

test('effects.consent schema: a shown discard-pile→hand move asked of the opponent; never written on cn.cards@1 itself', () => {
  assert(valid('cn.orElse@1', ASK));
  assert(valid('cn.orElse@1', { first: recover, otherwise: draw3 }));
  assert(!valid('cn.orElse@1', { ...ASK, first: draw3 }));
  assert(!valid('cn.orElse@1', { ...ASK, first: { ...recover, parameters: { ...recover.parameters, reveal: false } } }));
  assert(!valid('cn.orElse@1', { ...ASK, first: { ...recover, parameters: { ...recover.parameters, to: 'deck', shuffleAfter: true } } }));
  assert(!valid('cn.orElse@1', { ...ASK, first: { ...recover, parameters: { ...recover.parameters, quantity: { kind: 'upTo', count: 1 } } } }));
  assert(!valid('cn.orElse@1', { ...ASK, consent: false }));
  assert(!valid('cn.cards@1', { ...recover.parameters, consent: true }));
});

test('「询问对手是否可以加入手牌。如果对手允许，则…加入手牌」: shown, then the opponent answers; allowed, it joins the hand and nothing is drawn', async () => {
  const f = await sordward();
  let supporter, potion, poison;
  const g = board(f, (s) => { supporter = hand(s, 0, 'research'); potion = toDiscard(s, 0, 'potion'); poison = toDiscard(s, 0, 'poison'); });
  const deck = g.snapshot().players[0].deck.length;
  command(g, { type: 'playTrainer', cardId: supporter });
  let q = g.snapshot().pending;
  assert.equal(q.player, 0); assert.deepEqual(q.options, [potion, poison]);
  answer(g, [potion]);
  q = g.snapshot().pending;
  assert.equal(q.kind, 'consent'); assert.equal(q.player, 1); assert.deepEqual(q.options, ['allow', 'refuse']);
  assert.equal(q.ruleId, 'effects.consent');
  assert.deepEqual(g.snapshot().events.filter((e) => e.ruleId === 'effects.reveal').at(-1).data.cardIds, [potion], 'Shown before the question.');
  assert(g.snapshot().players[0].discard.includes(potion));
  roundTrip(g, f);
  // The shown card must still be where it was chosen.
  const forged = clone(g.snapshot()), p0 = forged.players[0];
  p0.discard.splice(p0.discard.indexOf(potion), 1); p0.hand.push(potion);
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-card-selection');
  answer(g, ['allow']);
  const s = g.snapshot();
  assert(s.players[0].hand.includes(potion));
  assert.equal(s.players[0].deck.length, deck);
  assert(s.players[0].discard.includes(supporter));
  assert.deepEqual(s.events.filter((e) => e.ruleId === 'effects.consent').map((e) => [e.data.player, e.data.allowed]), [[1, true]]);
});

test('effects.consent: refused, the card stays and its user draws 3 (none from an empty deck); without a Trainer the card cannot be played', async () => {
  const f = await sordward();
  let supporter, potion;
  const g = board(f, (s) => { supporter = hand(s, 0, 'research'); potion = toDiscard(s, 0, 'potion'); });
  const before = g.snapshot().players[0];
  command(g, { type: 'playTrainer', cardId: supporter });
  answer(g, [potion]); answer(g, ['refuse']);
  let s = g.snapshot();
  assert(s.players[0].discard.includes(potion) && !s.players[0].hand.includes(potion));
  assert.equal(s.players[0].deck.length, before.deck.length - 3);
  assert.equal(s.players[0].hand.length, before.hand.length - 1 + 3);
  // An empty deck: the opponent may still refuse; nothing is drawn and the game goes on.
  const h = board(f, (s) => { supporter = hand(s, 0, 'research'); potion = toDiscard(s, 0, 'potion'); s.players[0].lost.push(...s.players[0].deck.splice(0)); });
  command(h, { type: 'playTrainer', cardId: supporter });
  answer(h, [potion]); answer(h, ['refuse']);
  s = h.snapshot();
  assert.equal(s.result, null); assert(s.players[0].discard.includes(potion));
  // No Trainer in the discard pile: nothing to choose or ask (II.D-04), even with cards to draw.
  const k = board(f, (s) => { supporter = hand(s, 0, 'research'); toDiscard(s, 0, 'base'); });
  assert(!k.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === supporter));
});

test('effects.consent: allowed, a card that cannot be put into the hand stays, and the refused part does not run', async () => {
  const f = await sordward((defs) => { def(defs, 'potion').mechanics.discardPileLock = { to: ['hand'] }; });
  let supporter, potion;
  const g = board(f, (s) => { supporter = hand(s, 0, 'research'); potion = toDiscard(s, 0, 'potion'); });
  const deck = g.snapshot().players[0].deck.length;
  command(g, { type: 'playTrainer', cardId: supporter });
  answer(g, [potion]); answer(g, ['allow']);
  const s = g.snapshot();
  assert(s.players[0].discard.includes(potion));
  assert.equal(s.players[0].deck.length, deck);
});
