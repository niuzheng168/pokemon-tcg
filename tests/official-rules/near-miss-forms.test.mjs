// Synthetic definitions only. 「在自己的回合，如果将自己手牌中的1张【超】能量放于弃牌区的话，则可使用1次。使对手的战斗宝可梦陷入【灼伤】和
// 【混乱】状态。」 (status.no-change; JP Q&A ヒスイ バクフーン「あやかしだま」), 「在自己的回合可以使用1次。抛掷1次硬币如果为正面，则选择对手的
// 1只备战宝可梦，将其与战斗宝可梦互换。然后，使新出场的宝可梦陷入【中毒】和【睡眠】状态。」 (effects.coin-then; JP Q&A フシギバナ
// 「クラクラキャッチャー」), 「将这只宝可梦身上附着的所有【火】或者【雷】的基本能量放于弃牌区，造成放于弃牌区的能量张数×60伤害。」
// (energy.same-type-all), 「将自己牌库上方的1张卡牌翻到正面，如果该卡牌是【斗】能量的话，则附着于自己的备战宝可梦身上。如果不是【斗】能量的话，
// 则在给对手看过之后，加入手牌。」 (effects.face-up-attach; JP Q&A ガッツのつるはし), 「将自己弃牌区中，与对手场上宝可梦数量相同个数的【钢】
// 能量，以任意方式附着于自己的宝可梦身上。」 (effects.count-value, selection.exact) and 「抛掷2次硬币。如果出现正面的话，则查看对手的手牌，选择
// 其中与出现正面次数相同数量的卡牌，将选择的卡牌以任意顺序重新排列后，放回对手的牌库下方。」 (effects.opponent-hand). The fixture's Water and
// Fire Energy stand in for the printed types. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { emptyConditions, conditionChanges } from '../../public/rules/conditions.js';
import { attachedEnergyChoice } from '../../public/rules/energy-selection.js';
import { assertDeckEnergyAction } from '../../public/rules/deck-energy.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const condition = (c, extra = {}) => ({ ...emptyConditions(), ...c, ...extra });
const ability = (effects, costs = null) => ({ abilityId: 'fixture:use', name: '测试特性', mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: 'fixture:use', limit: 1 }, ...(costs ? { costs } : {}), effects, sourceOfTruth: EVIDENCE });
const usable = (g) => g.view(0).legalActions.some((a) => a.type === 'useAbility' && a.abilityId === 'fixture:use');
const use = (g) => command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'fixture:use' });
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
// The listed card becomes a zone's card (the deck's top when the zone is the deck).
const put = (s, owner, id, zone) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(card); return card; };
const immunity = (conditions) => binding('cn.conditionImmunity@1', { effect: { op: 'conditionImmunity', scope: 'self', ...(conditions ? { conditions } : {}) } },
  `immune${conditions ? `:${conditions.join(',')}` : ''}`);
const heads = (g, effectId) => g.snapshot().events.findLast((e) => e.ruleId === 'effects.coin' && e.data.effectId === effectId)?.data.result === 'heads';

test('status.no-change: a printed condition changes nothing on a Pokémon that already has exactly it', () => {
  for (const id of ['status.no-change', 'effects.coin-then', 'effects.face-up-attach'])
    assert(requireRule(CN_V20261019, id).sourceOfTruth.some((s) => s.documentId === 'JP-official-qa'), id);
  assert(requireRule(CN_V20261019, 'energy.same-type-all').sourceOfTruth.some((s) => s.section.includes('II.D-03')));
  const none = condition({});
  assert(conditionChanges(none, { condition: 'burned' }, 1));
  assert(!conditionChanges(condition({ burned: true }), { condition: 'burned' }, 1));
  assert(conditionChanges(condition({ burned: true }), { condition: 'confused' }, 1));
  assert(!conditionChanges(condition({ poison: 1 }), { condition: 'poisoned' }, 1));
  assert(conditionChanges(condition({ poison: 1 }), { condition: 'poisoned', poisonCounters: 4 }, 1), 'A new Poison replaces the old one, counters too.');
  assert(conditionChanges(condition({ poison: 4 }), { condition: 'poisoned' }, 1));
  const paralyzed = condition({ rotation: 'paralyzed', paralysisRecoverTurn: 3 });
  assert(!conditionChanges(paralyzed, { condition: 'paralyzed' }, 2));
  assert(conditionChanges(paralyzed, { condition: 'paralyzed' }, 3), 'It would last one more turn of its owner.');
  assert(conditionChanges(condition({ rotation: 'asleep', sleepCoins: 2 }), { condition: 'asleep' }, 1), 'An ordinary Sleep replaces the special one.');
  assert(!conditionChanges(condition({ rotation: 'asleep', sleepCoins: 2 }), { condition: 'asleep', sleepCoins: 2 }, 1));
  assert(conditionChanges(condition({ rotation: 'confused' }), { condition: 'confused', confusionCounters: 6 }, 1));
  assert(conditionChanges(condition({ rotation: 'confused' }), { condition: 'asleep' }, 1));
  // The handler's own candidate check: the printed side's Active Pokémon; the event side (and a subject-local lane) is the trigger's.
  const canUse = handlers.get('cn.condition@1').canUse;
  const ctx = (theirs, extra = {}) => ({ source: { owner: 0, pokemonId: 'mine' }, event: null, state: { players: [
    { active: { id: 'mine', conditions: none }, turns: 3 }, { active: theirs, turns: 2 }] }, ...extra });
  const foe = (c) => ({ id: 'theirs', conditions: condition(c) });
  assert(canUse(ctx(foe({})), { side: 'opponent', condition: 'burned' }));
  assert(!canUse(ctx(foe({ burned: true })), { side: 'opponent', condition: 'burned' }));
  assert(!canUse(ctx(null), { side: 'opponent', condition: 'burned' }), 'No Active Pokémon.');
  assert(canUse(ctx(null), { side: 'own', target: 'self', condition: 'asleep' }));
  assert(!canUse({ ...ctx(null), source: { owner: 0, pokemonId: 'benched' } }, { side: 'own', target: 'self', condition: 'asleep' }),
    'This Pokémon on the Bench: not the Active Pokémon.');
  assert(canUse(ctx(foe({}), { event: { subjectId: 'theirs' } }), { side: 'opponent', target: 'event', condition: 'poisoned' }));
  assert(!canUse(ctx(foe({}), { event: { subjectId: 'elsewhere' } }), { side: 'opponent', target: 'event', condition: 'poisoned' }));
  assert(canUse(ctx(foe({ poison: 1 })), { side: 'event', target: 'active', condition: 'poisoned', inherit: true }));
  assert(canUse({ source: { owner: 0 }, subject: { owner: 1 } }, { side: 'opponent', target: 'event', condition: 'burned' }));
});

test('「如果将…放于弃牌区的话，则可使用1次。使对手的战斗宝可梦陷入【灼伤】和【混乱】状态」: usable while either still changes something', async () => {
  const fee = [{ costId: 'fee', kind: 'discardHand', count: 1, selector: { kind: 'energy', category: 'basic', types: ['Water'] }, sourceOfTruth: EVIDENCE }];
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.abilities = [ability([binding('cn.condition@1', { side: 'opponent', condition: 'burned' }, 'burn'),
      binding('cn.condition@1', { side: 'opponent', condition: 'confused' }, 'confuse')], fee)];
    def(defs, 'tool').mechanics.effects = [immunity()];
    def(defs, 'hp-tool').mechanics.effects = [immunity(['burned'])];
  });
  let water;
  const make = (c = {}, tool = null, energy = true) => board(f, (s) => {
    const p = s.players[0]; p.deck.push(...p.hand); p.hand = [];
    if (energy) water = hand(s, 0, 'water'); else hand(s, 0, 'potion');
    Object.assign(s.players[1].active.conditions, c);
    if (tool) { const t = hand(s, 1, tool); s.players[1].hand.pop(); s.players[1].active.tools.push(t); }
  });
  const g = make();
  assert(usable(g));
  use(g);
  assert.equal(g.snapshot().pending.kind, 'activation-cost');
  restore(g, f);
  answer(g, [paymentOptionId('fee', water)]); settle(g);
  const s = g.snapshot();
  assert.deepEqual([s.players[1].active.conditions.burned, s.players[1].active.conditions.rotation], [true, 'confused']);
  assert(s.players[0].discard.includes(water));
  assert(usable(make({ burned: true })), 'JP Q&A: burned only — it can still be Confused.');
  assert(!usable(make({ burned: true, rotation: 'confused' })), 'JP Q&A: already burned and confused — nothing would change.');
  assert(!usable(make({}, 'tool')), 'It cannot be affected by Special Conditions.');
  assert(usable(make({}, 'hp-tool')), 'It cannot be burned, but can be Confused.');
  assert(!usable(make({ rotation: 'confused' }, 'hp-tool')));
  assert(!usable(make({}, null, false)), 'Nothing to pay.');
});

test('a condition-only Item or choice: only what would change something', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.chooseOne@1', { options: ['poisoned', 'asleep', 'confused']
      .map((c) => leaf('cn.condition@1', { side: 'opponent', condition: c })) }, 'choose')];
  });
  let card;
  // 'poison' is 「使对手的战斗宝可梦陷入【中毒】状态（放置4个伤害指示物）」.
  assert(!playable(board(f, (s) => { card = hand(s, 0, 'poison'); s.players[1].active.conditions.poison = 4; }), card));
  const g = board(f, (s) => { card = hand(s, 0, 'poison'); s.players[1].active.conditions.poison = 1; });
  assert(playable(g, card));
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  assert.equal(g.snapshot().players[1].active.conditions.poison, 4);
  // 「选择1种特殊状态」: an option the Pokémon already has exactly cannot be picked (effects.choose-one).
  const h = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[1].active.conditions.rotation = 'asleep'; });
  attack(h);
  assert.deepEqual([h.snapshot().pending.kind, h.snapshot().pending.options], ['choose-effect', ['0', '2']]);
  answer(h, ['2']); settle(h);
  assert.equal(h.snapshot().players[1].active.conditions.rotation, 'confused');
});

const CATCH = (next) => ({ outcome: 'heads', effect: leaf('cn.then@1', {
  first: leaf('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected' }), next }) });
const DIZZY = CATCH([leaf('cn.condition@1', { side: 'opponent', condition: 'poisoned' }), leaf('cn.condition@1', { side: 'opponent', condition: 'asleep' })]);

test('schema: a coin\'s printed result may be one 「A。然后，B」', () => {
  const valid = (p) => handlers.get('cn.coin@1').validateParameters(clone(p));
  assert(valid(DIZZY)); assert(valid(CATCH(leaf('cn.condition@1', { side: 'opponent', condition: 'confused' }))));
  for (const bad of [{ ...DIZZY, otherwise: DIZZY.effect }, { outcome: 'heads', effects: [DIZZY.effect, DIZZY.effect] },
    CATCH(leaf('cn.chooseOne@1', { options: [leaf('cn.draw@1', { count: 1 }), leaf('cn.draw@1', { count: 2 })] })),
    { outcome: 'heads', effect: leaf('cn.then@1', { first: leaf('cn.drawPlayers@1', { own: 1, opponent: 1 }), next: leaf('cn.draw@1', { count: 1 }) }) },
    { ...DIZZY, pokemon: { side: 'opponent', target: 'any' } }])
    assert(!valid(bad), JSON.stringify(bad));
});

test('「抛掷1次硬币如果为正面，则选择对手的1只备战宝可梦，将其与战斗宝可梦互换。然后，使新出场的宝可梦陷入【中毒】和【睡眠】状态」', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.abilities = [ability([binding('cn.coin@1', DIZZY, 'dizzy')])];
    def(defs, 'evolution').mechanics.stage = 'basic'; def(defs, 'evolution').mechanics.evolvesFrom = null;
    def(defs, 'evolution').mechanics.abilities = [{ abilityId: 'evolution:immune', name: '测试免疫', mode: 'continuous', usage: null,
      sourceOfTruth: EVIDENCE, effects: [immunity()] }];
  });
  assert(!usable(board(f)), 'No Benched Pokémon to switch in: nothing could change.');
  const seen = new Set();
  for (const seed of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20], [21, 22, 23, 24]]) {
    let other, immune, before;
    const g = board({ ...f, seed }, (s) => { other = bench(s, 1, 'other'); immune = bench(s, 1, 'evolution'); before = s.players[1].active.id; });
    assert(usable(g));
    use(g);
    if (!heads(g, 'fixture:dizzy')) {
      seen.add('tails');
      assert.equal(g.snapshot().pending, null);
      assert.equal(g.snapshot().players[1].active.id, before, 'Tails: nothing happens.');
      continue;
    }
    const q = g.snapshot().pending;
    assert.deepEqual([q.player, q.kind, [...q.options].sort()], [0, 'effect-target', [other.id, immune.id].sort()]);
    restore(g, f);
    const pick = seen.has('heads') ? immune.id : other.id;
    answer(g, [pick]); settle(g);
    const s = g.snapshot(), active = s.players[1].active;
    assert.equal(active.id, pick);
    assert.equal(s.players[1].bench.find((m) => m.id === before).conditions.poison, null, 'The Pokémon switched out is not affected.');
    if (pick === other.id) assert.deepEqual([active.conditions.poison, active.conditions.rotation], [1, 'asleep']);
    else {
      assert.deepEqual([active.conditions.poison, active.conditions.rotation], [null, null], 'JP Q&A: switched in, but not poisoned or asleep.');
      assert(s.events.some((e) => e.ruleId === 'status.immunity'));
    }
    seen.add(pick === other.id ? 'heads' : 'immune');
  }
  assert.deepEqual([...seen].sort(), ['heads', 'immune', 'tails']);
});

const BURST = { op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy', category: 'basic', types: ['Fire', 'Water'] },
  providedTypes: null, measure: 'cards', quantity: { kind: 'all' }, chooser: 'source', sameType: true };

test('「将这只宝可梦身上附着的所有【火】或者【雷】的基本能量放于弃牌区，造成放于弃牌区的能量张数×60伤害」: all of the one type chosen', async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.hp = 500;
    Object.assign(def(defs, 'base').mechanics.attacks[0], { cost: ['Colorless'], printedDamage: { value: 60, operator: 'times' }, effects: [
      binding('cn.countedEnergyDiscard@1', BURST, 'burst'),
      binding('cn.damageValue@1', { expression: { kind: 'multiply', left: { kind: 'literal', value: 60 },
        right: { kind: 'effectCards', effectId: 'fixture:burst' } } }, 'damage')] });
  });
  f.deck.splice(20, 3, 'printing:fire', 'printing:fire', 'printing:fire');
  let fire, water, other;
  const g = board(f, (s) => {
    const a = s.players[0].active;
    fire = [attached(s, 0, a, 'fire'), attached(s, 0, a, 'fire')]; water = attached(s, 0, a, 'water'); other = attached(s, 0, a, 'double');
  });
  attack(g);
  const q = g.snapshot().pending;
  assert.deepEqual([q.kind, [...q.options].sort(), q.minimum, q.maximum], ['attached-energy', [...fire, water].sort(), 1, 2]);
  restore(g, f);
  for (const bad of [[fire[0]], [fire[0], water], [...fire, water]]) assert.throws(() => answer(g, bad), JSON.stringify(bad));
  answer(g, fire); settle(g);
  let s = g.snapshot();
  assert.deepEqual([s.players[0].active.energy.sort(), s.players[1].active.counters], [[water, other].sort(), 12]);
  // The other type alone; only one type attached; none at all.
  const h = board(f, (t) => { const a = t.players[0].active; attached(t, 0, a, 'fire'); attached(t, 0, a, 'fire'); water = attached(t, 0, a, 'water'); });
  attack(h); answer(h, [water]); settle(h);
  s = h.snapshot();
  assert.deepEqual([s.players[0].active.energy.length, s.players[1].active.counters], [2, 6]);
  const k = board(f, (t) => { const a = t.players[0].active; fire = [attached(t, 0, a, 'fire'), attached(t, 0, a, 'fire')]; });
  attack(k);
  assert.deepEqual([k.snapshot().pending.minimum, k.snapshot().pending.maximum], [2, 2]);
  answer(k, fire); settle(k);
  assert.equal(k.snapshot().players[1].active.counters, 12);
  const none = board(f, (t) => { attached(t, 0, t.players[0].active, 'double'); });
  attack(none); settle(none);
  assert.equal(none.snapshot().players[1].active.counters, 0, 'Nothing discarded: 0 × 60.');
  // The choice itself: one type, every card of it, from the pool.
  const pool = [{ instanceId: 'f1' }, { instanceId: 'f2' }, { instanceId: 'w1' }], typeOf = (id) => id.startsWith('f') ? 'Fire' : 'Water';
  assert(attachedEnergyChoice(pool, BURST, ['w1'], typeOf).valid && attachedEnergyChoice(pool, BURST, ['f2', 'f1'], typeOf).valid);
  for (const bad of [[], ['f1'], ['f1', 'f1'], ['f1', 'f2', 'w1'], ['w2']]) assert(!attachedEnergyChoice(pool, BURST, bad, typeOf).valid, JSON.stringify(bad));
});

const PICKAXE = { op: 'attachDeckEnergy', lookTop: 1, selector: { kind: 'energy', category: 'basic', types: ['Fire'] }, quantity: { kind: 'exact', count: 1 },
  recipient: { position: 'bench', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient', remainder: 'hand', reveal: true, faceUp: true };

test('schema: 「翻到正面」 is a bounded window and never a swap', () => {
  const valid = (p) => handlers.get('cn.attachDeckEnergy@1').validateParameters(clone(p));
  assert(valid(PICKAXE)); assertDeckEnergyAction(clone(PICKAXE));
  for (const bad of [{ ...PICKAXE, faceUp: false }, { ...PICKAXE, lookTop: null, remainder: 'shuffleDeck' },
    { ...PICKAXE, lookTop: null, remainder: 'shuffleDeck', swap: true, recipient: { position: 'any', selector: { kind: 'pokemon' } } }]) {
    assert(!valid(bad), JSON.stringify(bad));
    assert.throws(() => assertDeckEnergyAction(clone(bad)), /exact printed shape/);
  }
});

test('「将自己牌库上方的1张卡牌翻到正面，如果该卡牌是【斗】能量的话，则附着于自己的备战宝可梦身上。如果不是…，则…加入手牌」', async () => {
  const make = (action) => fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.attachDeckEnergy@1', action, 'pick')]; })
    .then((f) => { f.deck.splice(20, 2, 'printing:fire', 'printing:fire'); return f; });
  const f = await make(PICKAXE);
  let card, top, mons;
  const setup = (topId, benched = 2) => (s) => {
    card = hand(s, 0, 'potion'); top = put(s, 0, topId, 'deck');
    mons = Array.from({ length: benched }, () => bench(s, 0, 'other').id);
  };
  const reveals = (g) => g.snapshot().events.filter((e) => e.ruleId === 'effects.reveal' && e.data.effectId === 'fixture:pick');
  assert(!playable(board(f, setup('fire', 0)), card), 'JP Q&A: no Benched Pokémon — cannot be used.');
  assert(!playable(board(f, (s) => { setup('fire')(s); const p = s.players[0]; p.discard.push(...p.deck); p.deck = []; }), card),
    'JP Q&A: an empty deck — cannot be used.');
  const g = board(f, setup('fire'));
  command(g, { type: 'playTrainer', cardId: card });
  let q = g.snapshot().pending;
  assert.deepEqual([q.kind, q.options, q.minimum, q.maximum, q.allowZero], ['inspect-deck', [top], 1, 1, false]);
  assert.deepEqual(reveals(g).map((e) => [e.visibility, e.data.cardIds]), [['public', [top]]], 'JP Q&A: shown to the opponent.');
  restore(g, f);
  assert.throws(() => answer(g, []), 'JP Q&A: a basic Fighting Energy cannot be left unattached.');
  answer(g, [top]);
  q = g.snapshot().pending;
  assert.deepEqual([q.kind, [...q.options].sort()], ['deck-energy-recipient', [...mons].sort()]);
  restore(g, f);
  answer(g, [mons[1]]); settle(g);
  assert(g.snapshot().players[0].bench[1].energy.includes(top));
  // Not that Energy: shown, then into the hand.
  for (const other of ['water', 'double']) {
    const h = board(f, setup(other));
    command(h, { type: 'playTrainer', cardId: card });
    assert.deepEqual([h.snapshot().pending.options, h.snapshot().pending.allowZero], [[], true]);
    answer(h, []); settle(h);
    assert(h.snapshot().players[0].hand.includes(top) && !h.snapshot().players[0].deck.includes(top));
    assert.deepEqual(reveals(h).map((e) => e.data.cardIds), [[top]]);
  }
  // Without 「翻到正面」 the looked-at card is hidden: a matching one may be left (I.H), and nothing is shown.
  const hidden = await make((({ faceUp: _f, ...rest }) => rest)(PICKAXE));
  const k = board(hidden, setup('fire'));
  command(k, { type: 'playTrainer', cardId: card });
  assert.deepEqual([k.snapshot().pending.minimum, k.snapshot().pending.allowZero, reveals(k).length], [0, true, 0]);
});

test('an attack turning the top card of an empty deck face up shows nothing', async () => {
  const f = await fixture((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.attachDeckEnergy@1', PICKAXE, 'pick')]; });
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other');
    const p = s.players[0]; p.discard.push(...p.deck); p.deck = [];
  });
  attack(g); settle(g);
  assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.reveal'));
  assert.equal(g.snapshot().players[0].bench[0].energy.length, 0);
});

const STARS = (extra = { exact: true }) => ({ effect: leaf('cn.attachDiscard@1', { type: 'Water', count: 1, benchOnly: false, optional: false, ...extra }),
  count: { kind: 'pokemonCount', side: 'opponent', zone: 'field', selector: { kind: 'pokemon' } } });

test('「将自己弃牌区中，与对手场上宝可梦数量相同个数的【钢】能量，以任意方式附着于…」: exactly that many, or all there are', async () => {
  const valid = (p) => handlers.get('cn.countValue@1').validateParameters(clone(p));
  assert(valid(STARS()) && valid(STARS({})));
  for (const bad of [STARS({ exact: true, count: 2 }), STARS({ exact: true, optional: true }), STARS({ exact: true, anyNumber: true })])
    assert(!valid(bad), JSON.stringify(bad));
  assert(!handlers.get('cn.attachDiscard@1').validateParameters({ ...STARS().effect.parameters }), 'A leaf of its own still needs 2 or more for exact.');
  const run = async (parameters, inDiscard) => {
    const f = await fixture((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.countValue@1', parameters, 'stars')]; });
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); bench(s, 1, 'other'); bench(s, 1, 'other');
      const p = s.players[0]; p.deck.push(...p.discard); p.discard = [];
      for (let i = 0; i < inDiscard; i++) put(s, 0, 'water', 'discard');
    });
    attack(g);
    return { f, g };
  };
  let { f, g } = await run(STARS(), 4);
  const q = g.snapshot().pending;
  assert.deepEqual([q.kind, q.options.length, q.minimum, q.maximum, q.allowZero], ['discard-energy', 4, 3, 3, false]);
  restore(g, f);
  answer(g, q.options.slice(0, 3)); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[0].active.energy.length + s.players[0].bench[0].energy.length, 4, 'Three attached, in any way, besides the cost.');
  ({ g } = await run(STARS(), 2));
  assert.deepEqual([g.snapshot().pending.minimum, g.snapshot().pending.maximum], [2, 2], 'Fewer: all there are (II.D-04).');
  ({ g } = await run(STARS({}), 4));
  assert.deepEqual([g.snapshot().pending.minimum, g.snapshot().pending.maximum], [1, 3], 'Without exact: 1 to N.');
});

test('「与出现正面次数相同数量的卡牌」: a smaller hand gives all its cards', async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.hp = 500;
    Object.assign(def(defs, 'base').mechanics.attacks[0], { printedDamage: null, effects: [binding('cn.coins@1', { flips: { kind: 'fixed', count: 2 },
      face: 'heads', apply: { kind: 'scale' }, effect: leaf('cn.opponentHand@1', { mode: 'look', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
        to: 'deckBottom' }) }, 'snatch')] });
  });
  let found = false;
  for (let n = 1; n <= 20 && !found; n++) {
    let only;
    const g = board({ ...f, seed: [n, n + 1, n + 2, n + 3] }, (s) => {
      attached(s, 0, s.players[0].active, 'water');
      const p = s.players[1]; p.deck.push(...p.hand); p.hand = []; only = hand(s, 1, 'research');
    });
    attack(g);
    if (g.snapshot().events.findLast((e) => e.ruleId === 'effects.coin' && e.data.effectId === 'fixture:snatch').data.receipt.heads !== 2) continue;
    found = true;
    const q = g.snapshot().pending;
    assert.deepEqual([q.kind, q.options, q.minimum, q.maximum], ['select-cards', [only], 1, 1]);
    answer(g, [only]); settle(g);
    assert.equal(g.snapshot().players[1].deck[0], only);
  }
  assert(found, 'Two heads among these seeds.');
});
