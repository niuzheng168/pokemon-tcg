// Synthetic definitions only. Numbers computed from what an attack did or saw (damage.counted-picks, damage.counted-types,
// damage.counted-attach, effects.deck-top-count, effects.count-value-target):
// 「将附着于这只宝可梦身上的任意数量的【雷】能量放于弃牌区，选择与其相同数量的对手的宝可梦（同1只宝可梦可以选择多次）。然后，给所有被选择的宝可梦，
// 在不计算弱点、抗性的情况下，造成被选择次数×30点伤害」 (and 「选择与其张数相同数量的」); 「若希望，可将自己牌库上方最多5张卡牌放于弃牌区。然后，
// 追加造成其张数×40点伤害」; 「将自己牌库上方最多6张卡牌放于弃牌区。然后，造成因这个效果而放于弃牌区的张数×30点伤害」; 「将自己的牌库从上方开始
// 放于弃牌区直到剩余张数变为1张为止，追加造成放于弃牌区的卡牌中能量张数×30点伤害」; 「造成这只宝可梦身上附着的【水】能量数量×30伤害。若希望，
// 可以在造成伤害前，选择自己手牌中任意数量的「基本【水】能量」，附着于这只宝可梦身上」; 「将附着于自己备战宝可梦身上的任意数量的【雷】能量，转附于
// 这只宝可梦身上，造成其张数×20点伤害」; 「将附着于这只宝可梦身上的所有基本能量放于弃牌区，造成放于弃牌区的基本能量的属性种类数量×80点伤害」;
// 「将自己手牌中任意数量的基本能量给对手查看，追加造成给对手查看过的基本能量的属性种类数量×30点伤害」; 「将自己牌库上方6张卡牌翻到正面，给对手的
// 1只宝可梦造成其中的能量张数×60伤害。将翻到正面的能量放于弃牌区，剩余的卡牌放回牌库并重洗牌库。[备战宝可梦不计算弱点、抗性。]」; 「选择自己的1只
// 备战宝可梦。然后，将与这只宝可梦身上附着的「水」能量数量相同数量的伤害指示物从选择的宝可梦身上移除。（当自己没有备战宝可梦时，这个招式失败。）」;
// 「查看对手的手牌，选择其中最多与这只宝可梦身上附着的超能量数量相同数量的宝可梦，放于放逐区」; 「给对手的所有宝可梦身上放置伤害指示物，直到其各自
// 身上放置有的伤害指示物数量变为原来的2倍为止」; 「选择自己的1只备战宝可梦，将与被选择的宝可梦身上放置的伤害指示物数量相同的伤害指示物，放置于对手的
// 战斗宝可梦身上」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertBattleValue } from '../../public/rules/battle-value.js';
import { validateEffectResolution } from '../../public/rules/schema-validators.js';
import { fixture, binding, board, command, answer, settle, hand, bench, attached, EVIDENCE } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const strike = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const formula = (expression) => binding('cn.damageValue@1', { expression }, 'formula');
const times = (n, value) => ({ kind: 'multiply', left: lit(n), right: value });
const plus = (base, n, value) => ({ kind: 'add', terms: [lit(base), times(n, value)] });
const cards = (key) => ({ kind: 'effectCards', effectId: `fixture:${key}` });
const moved = (key, selector, extra = {}) => ({ kind: 'movedCards', effectId: `fixture:${key}`, selector, ...extra });
const BASIC = { kind: 'energy', category: 'basic' };
const ownWater = { kind: 'pokemonSum', who: 'self', field: 'energyUnits', energy: { providedTypes: ['Water'] } };
const targetCounters = { kind: 'pokemon', who: 'target', field: 'damageCounters' };
const records = (g) => g.snapshot().events.filter((e) => e.ruleId === 'damage.effect-count').map((e) => e.data);
// The packets that dealt damage (an attack printing no damage still runs its empty main step).
const damages = (g) => g.snapshot().events.filter((e) => e.ruleId === 'attack.order' && e.data.damage > 0).map((e) => e.data.damage);
// The fixture Pokémon: 500 HP, no Weakness, so damage counters show every packet; the attack is replaced by the printed text under test.
async function attackWith(effects, printedDamage = null, mutate = () => {}) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; }
    const a = defs[0].mechanics.attacks[0]; a.printedDamage = printedDamage; a.effects = effects;
    mutate(defs, a);
  });
}
// Moves the named cards (from the deck, hand or discard pile, never one already moved) to the top of a deck, first named lowest.
const onTop = (s, owner, ids) => {
  const p = s.players[owner], placed = [], free = (c, id) => !placed.includes(c) && s.cards[c].definitionId === id;
  for (const id of ids) {
    const zone = ['deck', 'hand', 'discard'].find((z) => p[z].some((c) => free(c, id)));
    const [c] = p[zone].splice(p[zone].findIndex((x) => free(x, id)), 1);
    p.deck.push(c); placed.push(c);
  }
  return placed;
};
const program = (s, op) => s.events.findLast((e) => e.ruleId === 'effects.execution' && Array.isArray(e.data.program) && e.data.program[0]?.op === op);

test('schemas: computed picks, deck-top counts, counted attachments and moves, type counts, per-Pokémon counter counts', () => {
  const packet = (count) => ({ side: 'opponent', target: 'any', amount: 30, selection: { kind: 'repeat', count }, options: {} });
  assert(valid('cn.damage@1', packet(4)));
  assert(valid('cn.damage@1', packet(cards('discard'))));
  for (const bad of [packet(1), packet(11), packet({ kind: 'nothing' }), { ...packet(cards('discard')), amount: lit(30) }])
    assert(!valid('cn.damage@1', bad), JSON.stringify(bad));
  assert(valid('cn.recoilDamage@1', { ...packet(2), side: 'own', target: 'self' }) && !valid('cn.recoilDamage@1', { ...packet(cards('discard')), side: 'own', target: 'self' }));
  const op = (count) => ({ action: { op: 'damage', ...packet(count) }, frames: [], source: { instanceId: 'c1', owner: 0, cardOwner: 0, category: 'attack',
    pokemonId: 'm1', attackId: 'base:strike', effectId: 'fixture:picks', sourceOfTruth: EVIDENCE } });
  assert.deepEqual([1, 120, 121, 0].map((n) => validateEffectResolution(op(n))), [true, true, false, false], 'A program holds the number of picks read.');
  assert(valid('cn.discardDeckTop@1', { side: 'own', count: 5, upTo: true }));
  assert(!valid('cn.discardDeckTop@1', { side: 'own', count: 5, upTo: false }));
  assert(!valid('cn.discardDeckTop@1', { side: 'own', leave: 1 }), 'A deck left at N cards is a counted form only.');
  for (const p of [{ side: 'own', count: 6, upTo: true }, { side: 'opponent', count: 6, upTo: true }, { side: 'own', leave: 1 }, { side: 'own', leave: 0 }])
    assert(valid('cn.countedDeckTop@1', p), JSON.stringify(p));
  for (const p of [{ side: 'both', count: 1, upTo: true }, { side: 'opponent', leave: 1 }, { side: 'own', leave: 1, count: 3 }, { side: 'own', leave: 1, upTo: true },
    { side: 'own' }, { side: 'own', leave: 60 }]) assert(!valid('cn.countedDeckTop@1', p), JSON.stringify(p));
  const optional = (handlerId, parameters) => valid('cn.optionalCounted@1', { effect: { handlerId, parameters } });
  assert(optional('cn.discardDeckTop@1', { side: 'own', count: 5, upTo: true }));
  assert(!optional('cn.discardDeckTop@1', { side: 'opponent', count: 1, to: 'lost' }));
  assert(optional('cn.attachHand@1', { type: 'Water', count: 60, benchOnly: false, optional: false, target: 'self', anyNumber: true }));
  assert(!optional('cn.attachDiscard@1', { type: 'Water', count: 1, benchOnly: false, optional: false, target: 'self' }));
  const value = (handlerId, parameters) => valid('cn.countValue@1', { effect: { handlerId, parameters }, count: ownWater });
  assert(value('cn.heal@1', { target: 'bench', amount: 10 }));
  assert(value('cn.opponentHand@1', { mode: 'look', selector: { kind: 'pokemon' }, quantity: { kind: 'upTo', count: 1 }, to: 'lost' }));
  for (const [id, p] of [['cn.heal@1', { target: 'bench', amount: 20 }], ['cn.heal@1', { target: 'bench', amount: 10, cureAll: true }],
    ['cn.opponentHand@1', { mode: 'look' }], ['cn.opponentHand@1', { mode: 'opponentChooses', selector: { kind: 'any' }, quantity: { kind: 'leave', count: 1 }, to: 'discard' }]])
    assert(!value(id, p), JSON.stringify(p));
  const counters = (extra, count = targetCounters) => valid('cn.countersValue@1', { side: 'opponent', target: 'any', count, ...extra });
  assert(counters({ all: true }));
  assert(counters({ countFrom: { side: 'own', target: 'bench' } }));
  for (const bad of [{}, { all: true, target: 'active' }, { all: true, countFrom: { side: 'own', target: 'bench' } }, { countFrom: { side: 'own', target: 'self' } }])
    assert(!counters(bad), JSON.stringify(bad));
  assert(!counters({ all: true }, ownWater), 'A count for each Pokémon reads that Pokémon.');
  assert.equal(assertBattleValue(moved('x', BASIC, { distinct: 'types' })).distinct, 'types');
  assert.throws(() => assertBattleValue(moved('x', BASIC, { distinct: 'names' })), /distinct types/);
});

test('「…放于弃牌区，选择与其相同数量的对手的宝可梦」: the units discarded (「与其张数相同数量」: the cards), then that many picks', async () => {
  const discard = (measure) => binding('cn.countedEnergyDiscard@1', { op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' },
    providedTypes: ['Water'], measure, quantity: { kind: 'any' }, chooser: 'source' }, 'discard');
  const picks = binding('cn.damage@1', { side: 'opponent', target: 'any', amount: 30, selection: { kind: 'repeat', count: cards('discard') },
    options: { ignoreWeakness: true, ignoreResistance: true } }, 'picks');
  // A Special Energy as 2 Water units: 1 card, 2 units (JP Q&A アローラライチュウ「エレキレイン」 / スターミー「れんだんスター」).
  const twoUnits = (defs) => { def(defs, 'double').mechanics.baseUnits = [['Water'], ['Water']]; };
  for (const [measure, expected] of [['units', 3], ['cards', 2]]) {
    const f = await attackWith([discard(measure), picks], null, twoUnits);
    let water, double, foe, theirs;
    const g = board(f, (s) => {
      const a = s.players[0].active; water = attached(s, 0, a, 'water'); attached(s, 0, a, 'water'); double = attached(s, 0, a, 'double');
      foe = s.players[1].active.id; theirs = bench(s, 1, 'other').id;
    });
    strike(g);
    assert.equal(g.snapshot().pending.kind, 'attached-energy');
    answer(g, [water, double]);
    const record = records(g)[0];
    assert.deepEqual(record.cards, [water, double]);
    assert.equal(record.count, measure === 'units' ? 3 : undefined);
    const order = [foe, theirs, foe].slice(0, expected);
    for (const id of order) {
      const q = g.snapshot().pending;
      assert.equal(q.kind, 'damage-targets'); assert.deepEqual([q.minimum, q.maximum], [1, 1]);
      if (id === order.at(-1)) {
        const mid = g.snapshot();
        assert.deepEqual(restore(g, f).snapshot(), mid);
        // The number of picks is the opened program's receipt; a counted units record keeps its count.
        for (const edit of [(p) => { p[0].amount = 60; }, (p) => { p.push(clone(p[0])); }, (p) => { p[0].selection = { kind: 'all' }; }]) {
          const s = clone(mid); edit(program(s, 'damage').data.program);
          assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /native departure or damage packet of a positive count/);
        }
        if (measure === 'units') {
          const s = clone(mid);
          delete s.attack.execution.effectCards[0].count; delete s.events.findLast((e) => e.ruleId === 'damage.effect-count').data.count;
          assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-count');
        }
      }
      answer(g, [id]);
    }
    settle(g);
    const s = g.snapshot(), counters = (id) => [s.players[1].active, ...s.players[1].bench].find((m) => m.id === id).counters;
    assert.deepEqual([counters(foe), counters(theirs)], measure === 'units' ? [6, 3] : [3, 3], 'One packet of 30 × its picks per picked Pokémon.');
    assert.deepEqual(damages(g), measure === 'units' ? [60, 30] : [30, 30]);
    assert.deepEqual(restore(g, f).snapshot(), s);
  }
  // None discarded: no pick and no damage.
  const f = await attackWith([discard('units'), picks], null, twoUnits);
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); });
  strike(g); answer(g, []);
  assert.equal(g.snapshot().pending, null);
  assert.deepEqual(records(g).map((r) => [r.cards, r.count]), [[[], 0]]);
  assert.deepEqual(damages(g), []);
});

test('「将自己牌库上方6张卡牌翻到正面，给对手的1只宝可梦造成其中的能量张数×60伤害。将翻到正面的能量放于弃牌区…」: a chosen Pokémon', async () => {
  const f = await attackWith([binding('cn.countedReveal@1', { from: 'deck', lookTop: 3 }, 'reveal'),
    binding('cn.damage@1', { side: 'opponent', target: 'any', amount: times(60, moved('reveal', { kind: 'energy' })), selection: { kind: 'exact', count: 1 },
      options: {} }, 'shot'),
    binding('cn.revealedCards@1', { effectId: 'fixture:reveal', to: 'discard', selector: { kind: 'energy' }, rest: 'deck' }, 'route')],
  null, (defs) => { def(defs, 'other').mechanics.weakness = { type: 'Water', operation: 'multiply', value: 2 }; });
  let top, foe;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); top = onTop(s, 0, ['potion', 'water', 'double']); foe = bench(s, 1, 'other').id; });
  strike(g);
  assert.equal(g.snapshot().pending.kind, 'damage-targets');
  answer(g, [foe]); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].bench[0].counters, 12, '2 Energy × 60 to a Benched Pokémon, without Weakness.');
  assert(s.players[0].discard.includes(top[1]) && s.players[0].discard.includes(top[2]) && s.players[0].deck.includes(top[0]));
  assert.deepEqual(restore(g, f).snapshot(), s);
});

test('「（若希望，可将）自己牌库上方最多N张卡牌放于弃牌区…其张数×N」 and 「…直到剩余张数变为1张为止…其中能量张数×30」', async () => {
  const most = await attackWith([binding('cn.countedDeckTop@1', { side: 'own', count: 6, upTo: true }, 'mill'), formula(times(30, cards('mill')))],
    { value: 30, operator: 'times' });
  let deck;
  const g = board(most, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  strike(g);
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'deck-top-count'); assert.deepEqual(q.options, ['1', '2', '3', '4', '5', '6'], '「最多6张」: 1 to 6 (II.D-05).');
  deck = [...g.snapshot().players[0].deck];
  answer(g, ['4']); settle(g);
  assert.deepEqual(records(g)[0].cards, deck.slice(-4).reverse(), 'The top four, at once.');
  assert.equal(g.snapshot().players[1].active.counters, 12);
  assert.deepEqual(restore(g, most).snapshot(), g.snapshot());
  const short = board(most, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].discard.push(...s.players[0].deck.splice(2)); });
  strike(short);
  assert.deepEqual(short.snapshot().pending.options, ['1', '2'], 'At most as many as the deck holds.');
  const empty = board(most, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  strike(empty);
  assert.equal(empty.snapshot().pending, null, 'An empty deck: nothing to choose.');
  assert.deepEqual(records(empty)[0].cards, []);
  // 「若希望，可将…最多5张…。然后，追加造成其张数×40点伤害」 (printed 「40+」): declining discards nothing.
  const wish = await attackWith([binding('cn.optionalCounted@1', { effect: { handlerId: 'cn.discardDeckTop@1',
    parameters: { side: 'own', count: 5, upTo: true } } }, 'mill'), formula(plus(40, 40, cards('mill')))], { value: 40, operator: 'plus' });
  for (const [choice, expected] of [['skip', 4], ['perform', 12]]) {
    const w = board(wish, (s) => { attached(s, 0, s.players[0].active, 'water'); });
    strike(w);
    assert.equal(w.snapshot().pending.kind, 'optional-effect');
    answer(w, [choice]);
    if (choice === 'perform') { q = w.snapshot().pending; assert.deepEqual(q.options, ['1', '2', '3', '4', '5']); answer(w, ['2']); }
    settle(w);
    assert.equal(w.snapshot().players[1].active.counters, expected);
    assert.equal(records(w)[0].cards.length, choice === 'perform' ? 2 : 0);
    assert.deepEqual(restore(w, wish).snapshot(), w.snapshot());
  }
  // 「将自己的牌库从上方开始放于弃牌区直到剩余张数变为1张为止」 (printed 「60+」): all but the bottom card, at once (JP Q&A かがやくハガネール).
  const leave = await attackWith([binding('cn.countedDeckTop@1', { side: 'own', leave: 1 }, 'mill'),
    formula(plus(60, 30, moved('mill', { kind: 'energy' })))], { value: 60, operator: 'plus' });
  let pile;
  const l = board(leave, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].discard.push(...s.players[0].deck.splice(0));
    pile = onTop(s, 0, ['potion', 'water', 'double', 'research', 'water']); });
  strike(l); settle(l);
  const ls = l.snapshot();
  assert.deepEqual(ls.players[0].deck, [pile[0]], 'One card stays.');
  assert.deepEqual(records(l)[0].cards, pile.slice(1).reverse());
  assert.equal(ls.players[1].active.counters, 15, '60 + 3 Energy × 30.');
  assert.deepEqual(restore(l, leave).snapshot(), ls);
  const one = board(leave, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].discard.push(...s.players[0].deck.splice(1)); });
  strike(one); settle(one);
  assert.equal(one.snapshot().players[0].deck.length, 1);
  assert.equal(one.snapshot().players[1].active.counters, 6, 'Already at one card: nothing discarded.');
});

test('「若希望，可以在造成伤害前，选择自己手牌中任意数量的「基本【水】能量」，附着于这只宝可梦身上」 and a counted move to this Pokémon', async () => {
  const attach = binding('cn.optionalCounted@1', { effect: { handlerId: 'cn.attachHand@1',
    parameters: { type: 'Water', count: 60, benchOnly: false, optional: false, target: 'self', anyNumber: true } } }, 'attach');
  const f = await attackWith([attach, formula(times(30, ownWater))], { value: 30, operator: 'times' });
  for (const choice of ['perform', 'skip']) {
    let inHand;
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].deck.push(...s.players[0].hand.splice(0));
      inHand = [hand(s, 0, 'water'), hand(s, 0, 'water')]; hand(s, 0, 'double'); });
    strike(g); answer(g, [choice]);
    if (choice === 'perform') {
      const q = g.snapshot().pending;
      assert.equal(q.kind, 'hand-energy'); assert.deepEqual([...q.options].sort(), [...inHand].sort(), 'Basic Water Energy only.');
      answer(g, inHand);
    }
    settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, choice === 'perform' ? 9 : 3, 'The Water Energy on it when the damage is calculated (JP Q&A サクラビス).');
    assert.deepEqual(records(g)[0].cards, choice === 'perform' ? inHand : []);
    assert.deepEqual(restore(g, f).snapshot(), s);
  }
  // A saved attachment record names Energy cards only.
  const paused = await attackWith([attach, formula(times(30, ownWater)), binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 10,
    selection: { kind: 'exact', count: 1 }, options: {} }, 'snipe')], { value: 30, operator: 'times' });
  const p = board(paused, (s) => { attached(s, 0, s.players[0].active, 'water'); hand(s, 0, 'water'); hand(s, 0, 'potion'); bench(s, 1, 'other'); bench(s, 1, 'other'); });
  strike(p); answer(p, ['perform']); answer(p, [...p.snapshot().pending.options]);
  const mid = p.snapshot();
  assert.equal(mid.pending.kind, 'damage-targets');
  const forged = clone(mid), potion = forged.players[0].hand.find((id) => forged.cards[id].definitionId === 'potion');
  forged.attack.execution.effectCards[0].cards = [potion]; forged.events.findLast((e) => e.ruleId === 'damage.effect-count').data.cards = [potion];
  for (const model of [...forged.attack.damageModels, ...forged.events.find((e) => e.ruleId === 'damage.expression' && e.data.kind === 'stage-snapshot').data.models])
    model.battleValues.effectCards['fixture:attach'] = 1;
  assert.throws(() => OfficialGame.restore(forged, { catalog: paused.catalog }), (e) => e.code === 'invalid-effect-count');
  // 「将附着于自己备战宝可梦身上的任意数量的【雷】能量，转附于这只宝可梦身上，造成其张数×20点伤害」: a 2-unit card is one card (JP Q&A アローラゴローニャ).
  const move = await attackWith([binding('cn.countedEnergyDiscard@1', { op: 'moveEnergy', side: 'own', from: 'bench', selector: { kind: 'energy' },
    providedTypes: ['Water'], measure: 'cards', quantity: { kind: 'any' }, chooser: 'source', recipient: { position: 'self', selector: { kind: 'pokemon' } },
    distribution: 'singleRecipient' }, 'move'), formula(times(20, cards('move')))], { value: 20, operator: 'times' },
  (defs) => { def(defs, 'double').mechanics.baseUnits = [['Water'], ['Water']]; });
  let benched, active;
  const g = board(move, (s) => { active = s.players[0].active; attached(s, 0, active, 'water'); const b = bench(s, 0, 'other');
    benched = [attached(s, 0, b, 'water'), attached(s, 0, b, 'double')]; });
  strike(g);
  assert.deepEqual([...g.snapshot().pending.options].sort(), [...benched].sort());
  answer(g, benched);
  assert.equal(g.snapshot().pending.kind, 'energy-destination');
  answer(g, [active.id]); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.counters, 4, '2 cards × 20.');
  assert(benched.every((id) => s.players[0].active.energy.includes(id)));
  assert.deepEqual(records(g)[0].cards, benched);
  assert.deepEqual(restore(g, move).snapshot(), s);
});

test('「…的属性种类数量×N」: different types among the discarded or shown Basic Energy (II.D-02 文例2)', async () => {
  const withFire = (f) => { f.deck = [...f.deck.slice(0, 50), ...Array(10).fill('printing:fire')]; return f; };
  const burst = withFire(await attackWith([binding('cn.countedEnergyDiscard@1', { op: 'discardEnergy', side: 'own', from: 'self', selector: BASIC,
    providedTypes: null, measure: 'cards', quantity: { kind: 'all' }, chooser: 'source' }, 'discard'),
  formula(times(80, moved('discard', BASIC, { distinct: 'types' })))], { value: 80, operator: 'times' }));
  let special;
  const g = board(burst, (s) => { const a = s.players[0].active; attached(s, 0, a, 'water'); attached(s, 0, a, 'water'); attached(s, 0, a, 'fire');
    special = attached(s, 0, a, 'double'); });
  strike(g); settle(g, (q) => q.options.slice(0, q.minimum));
  assert.equal(g.snapshot().players[1].active.counters, 16, 'Water and Fire: 2 types × 80.');
  assert.deepEqual(g.snapshot().players[0].active.energy, [special]);
  assert.deepEqual(restore(g, burst).snapshot(), g.snapshot());
  const paint = withFire(await attackWith([binding('cn.countedReveal@1', { from: 'hand', selector: BASIC, quantity: { kind: 'any' } }, 'reveal'),
    formula(plus(30, 30, moved('reveal', BASIC, { distinct: 'types' })))], { value: 30, operator: 'plus' }));
  for (const [show, expected] of [[3, 9], [1, 6], [0, 3]]) {
    let shown;
    const p = board(paint, (s) => { attached(s, 0, s.players[0].active, 'water'); shown = [hand(s, 0, 'water'), hand(s, 0, 'fire'), hand(s, 0, 'water')]; });
    strike(p); answer(p, show === 1 ? [shown[0]] : shown.slice(0, show)); settle(p);
    assert.equal(p.snapshot().players[1].active.counters, expected);
  }
});

test('「…从选择的宝可梦身上移除」「查看对手的手牌，选择其中最多与…相同数量的宝可梦，放于放逐区」: computed heal and hand counts', async () => {
  const heal = await attackWith([binding('cn.countValue@1', { effect: { handlerId: 'cn.heal@1', parameters: { target: 'bench', amount: 10 } }, count: ownWater },
    'heal')], null, (defs, a) => {
    a.cost = [];
    a.failureCheck = { predicate: { kind: 'compare', left: { kind: 'pokemonCount', side: 'own', zone: 'bench' }, relation: 'eq', right: lit(0) },
      sourceOfTruth: EVIDENCE };
  });
  let hurt;
  const g = board(heal, (s) => { const a = s.players[0].active; attached(s, 0, a, 'water'); attached(s, 0, a, 'water');
    hurt = bench(s, 0, 'other'); hurt.counters = 5; bench(s, 0, 'base'); });
  strike(g);
  assert.deepEqual(g.snapshot().pending.options, [hurt.id], 'Only a damaged Benched Pokémon changes.');
  answer(g, [hurt.id]); settle(g);
  assert.equal(g.snapshot().players[0].bench[0].counters, 3, '2 Water Energy: 2 counters removed (II.C-06).');
  assert.deepEqual(restore(g, heal).snapshot(), g.snapshot());
  const alone = board(heal, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  strike(alone); settle(alone);
  assert(alone.snapshot().events.some((e) => e.ruleId === 'attack.failure.self' && !e.data.receipt.passed), '「当自己没有备战宝可梦时，这个招式失败」.');
  const dry = board(heal, (s) => { bench(s, 0, 'other').counters = 5; });
  strike(dry); settle(dry);
  assert.equal(dry.snapshot().players[0].bench[0].counters, 5, 'No Water Energy: nothing removed.');
  const look = await attackWith([binding('cn.countValue@1', { effect: { handlerId: 'cn.opponentHand@1', parameters: { mode: 'look',
    selector: { kind: 'pokemon' }, quantity: { kind: 'upTo', count: 1 }, to: 'lost' } }, count: ownWater }, 'look')], null, (defs, a) => { a.cost = []; });
  for (const water of [2, 0]) {
    let mons;
    const l = board(look, (s) => { for (let i = 0; i < water; i++) attached(s, 0, s.players[0].active, 'water');
      s.players[1].discard.push(...s.players[1].hand.splice(0)); mons = [hand(s, 1, 'other'), hand(s, 1, 'base'), hand(s, 1, 'evolution')]; hand(s, 1, 'water'); });
    strike(l);
    const q = l.snapshot().pending;
    if (water) {
      assert.equal(q.kind, 'select-cards'); assert.deepEqual([q.minimum, q.maximum], [1, 2]);
      answer(l, mons.slice(0, 2)); settle(l);
      assert.deepEqual(l.snapshot().players[1].lost, mons.slice(0, 2));
    } else {
      assert.equal(q.kind, 'view-cards', 'No Psychic Energy: the hand is still looked at.');
      assert(l.snapshot().events.some((e) => e.ruleId === 'effects.opponent-hand' && e.data.looked === 4));
      const mid = l.snapshot();
      assert.deepEqual(restore(l, look).snapshot(), mid);
      const forged = clone(mid), opened = program(forged, 'opponentHand').data.program; opened.push(clone(opened[0]));
      assert.throws(() => OfficialGame.restore(forged, { catalog: look.catalog }), /computed count/);
      settle(l);
      assert.deepEqual(l.snapshot().players[1].lost, []);
    }
    assert.deepEqual(restore(l, look).snapshot(), l.snapshot());
  }
  // An Item: 「查看对手的手牌，选择其中最多与自己弃牌区中宝可梦张数相同数量的宝可梦，放于放逐区」 is usable while there is a hand to look at.
  const item = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.countValue@1', { effect: { handlerId: 'cn.opponentHand@1', parameters: { mode: 'look',
      selector: { kind: 'pokemon' }, quantity: { kind: 'upTo', count: 1 }, to: 'lost' } }, count: { kind: 'zoneCount', side: 'own', zone: 'discard',
      selector: { kind: 'pokemon' } } }, 'item')];
  });
  let card;
  const playable = (g) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
  assert(playable(board(item, (s) => { card = hand(s, 0, 'potion'); })));
  assert(!playable(board(item, (s) => { card = hand(s, 0, 'potion'); s.players[1].discard.push(...s.players[1].hand.splice(0)); })));
  assert(!playable(board(await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.countValue@1', { effect: { handlerId: 'cn.heal@1',
    parameters: { target: 'any', amount: 10 } }, count: { kind: 'zoneCount', side: 'own', zone: 'discard', selector: { kind: 'pokemon' } } }, 'item')]; }),
  (s) => { card = hand(s, 0, 'potion'); s.players[0].active.counters = 3; })), 'A heal of zero counters changes nothing.');
});

test('「直到其各自身上…变为原来的2倍为止」「将与被选择的宝可梦身上放置的伤害指示物数量相同的伤害指示物」: a count for one Pokémon', async () => {
  const double = await attackWith([binding('cn.countersValue@1', { side: 'opponent', target: 'any', all: true, count: targetCounters }, 'double')]);
  let foes;
  const g = board(double, (s) => { s.players[1].active.counters = 3; const a = bench(s, 1, 'other'), b = bench(s, 1, 'base'); a.counters = 2;
    foes = [s.players[1].active.id, a.id, b.id]; attached(s, 0, s.players[0].active, 'water'); });
  strike(g); settle(g);
  const s = g.snapshot(), counters = (id) => [s.players[1].active, ...s.players[1].bench].find((m) => m.id === id).counters;
  assert.deepEqual(foes.map(counters), [6, 4, 0], 'Each its own original count; none on an undamaged one.');
  assert.deepEqual(restore(g, double).snapshot(), s);
  const mirror = await attackWith([binding('cn.countersValue@1', { side: 'opponent', target: 'active', count: targetCounters,
    countFrom: { side: 'own', target: 'bench' } }, 'mirror')]);
  let mine;
  for (const pick of [0, 1]) {
    const m = board(mirror, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = 7;
      mine = [bench(s, 0, 'other'), bench(s, 0, 'base')]; mine[0].counters = 4; });
    strike(m);
    const q = m.snapshot().pending;
    assert.equal(q.kind, 'count-source'); assert.deepEqual(q.options, mine.map((x) => x.id), 'Own Benched Pokémon only, damaged or not.');
    assert.deepEqual(restore(m, mirror).snapshot(), m.snapshot());
    answer(m, [mine[pick].id]);
    if (!pick) { assert.equal(m.snapshot().pending.kind, 'effect-target'); answer(m, [m.snapshot().pending.options[0]]); }
    settle(m);
    assert.equal(m.snapshot().players[1].active.counters, pick ? 0 : 4);
    assert.equal(m.snapshot().players[0].bench[0].counters, 4, 'The chosen Pokémon keeps its counters.');
    assert.deepEqual(restore(m, mirror).snapshot(), m.snapshot());
  }
  const none = board(mirror, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  strike(none);
  assert.equal(none.snapshot().pending, null, 'No Benched Pokémon: nothing to read.');
  const forged = board(mirror, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); });
  strike(forged);
  assert.throws(() => answer(forged, [forged.snapshot().players[1].active.id]));
  // Only an attack reads a Pokémon for the count; a Trainer has none.
  const item = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.countersValue@1',
    { side: 'opponent', target: 'any', all: true, count: targetCounters }, 'item')]; });
  assert.throws(() => assertSupportedDefinition(item.catalog, def(item.definitions, 'potion')), (e) => e.code === 'unsupported-condition');
  const h = handlers.get('cn.countersValue@1');
  const ctx = (bench) => ({ source: { owner: 0 }, state: { players: [{ active: { id: 'a' }, bench: [] }, { active: null, bench }] } });
  for (const p of [{ all: true, target: 'bench' }, { countFrom: { side: 'own', target: 'bench' }, target: 'any' }])
    assert.deepEqual([h.canUse(ctx([{ id: 'b' }]), { side: 'opponent', count: targetCounters, ...p }), h.canUse(ctx([]), { side: 'opponent', count: targetCounters, ...p })],
      [true, false]);
});
