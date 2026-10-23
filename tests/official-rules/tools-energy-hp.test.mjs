// Synthetic definitions only. 「（除◇（棱镜之星）外）」 (prismStar); 「这只宝可梦的最大HP，会因为每张对手已经获得的奖赏卡而「+50」」 and
// 「这只宝可梦身上每附有1个【钢】能量，这只宝可梦的最大HP就会增加「20」点」; 「放于宝可梦身上的这张卡牌，将在对手的回合结束时被放于弃牌区」
// (tools.turn-end-discard); 「给对手所有的备战宝可梦身上放置伤害指示物，直到其剩余HP均变为「100」为止」; 「双方所有宝可梦的弱点，均以「×4」
// 计算伤害」; 「当这张卡牌，要被从场上放于弃牌区时，不会被放于弃牌区，而是被放回手牌」 (effects.discard-to-hand); 「然后，将这张卡牌放于
// 弃牌区」 (effects.discard-self); 「双方场上宝可梦身上附有的特殊能量的效果全部消除，被视作1个【无】能量」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { matchesCardSelector } from '../../public/rules/card-selection.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const continuous = (abilityId, effects) => ({ abilityId, name: '测试特性', mode: 'continuous', usage: null, effects, sourceOfTruth: EVIDENCE });
const view = (g, owner, id) => { const p = g.view(owner).players[owner]; return [p.active, ...p.bench].find((m) => m.id === id); };
const strike = (s, owner = 0) => attached(s, owner, s.players[owner].active, 'water');
const attack = (g) => { command(g, { type: 'attack', attackId: 'base:strike' }); settle(g); };
const endTurn = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const toolOn = (s, owner, m, id = 'tool') => { const card = hand(s, owner, id); s.players[owner].hand.pop(); m.tools.push(card); return card; };

test('「（除◇（棱镜之星）外）」: the printed Prism Star rule', async () => {
  const f = await fixture();
  const base = f.catalog.definition('base'), prism = { ...base, prismStar: { sourceOfTruth: EVIDENCE } };
  assert(matchesCardSelector(base, { kind: 'pokemon', prismStar: false }));
  assert(!matchesCardSelector(prism, { kind: 'pokemon', prismStar: false }));
  assert(matchesCardSelector(prism, { kind: 'pokemon', prismStar: true }));
});

test('maximum HP 「因为每张对手已经获得的奖赏卡而「+50」」 and 「每附有1个【钢】能量…「20」点」', async () => {
  const valid = handlers.get('cn.modifier@1').validateParameters;
  const prizes = { field: 'hp', amount: 50, scope: 'self', perPrizesTaken: 'opponent' };
  const metal = { field: 'hp', amount: 20, scope: 'self', perEnergyType: 'Water' };
  assert(valid(prizes)); assert(valid(metal));
  assert(!valid({ ...metal, field: 'attackDamage' })); assert(!valid({ ...metal, perPrizesTaken: 'own' }));
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.abilities = [continuous('base:grow', [binding('cn.modifier@1', prizes, 'grow')])];
    def(defs, 'other').mechanics.abilities = [continuous('other:armor', [binding('cn.modifier@1', metal, 'armor')])];
  });
  f.deck.splice(20, 2, 'printing:double', 'printing:fire');
  let other;
  const g = board(f, (s) => {
    s.players[1].hand.push(...s.players[1].prizes.splice(0, 2));
    other = bench(s, 0, 'other'); attached(s, 0, other, 'water'); attached(s, 0, other, 'double'); attached(s, 0, other, 'fire');
  });
  assert.equal(view(g, 0, g.snapshot().players[0].active.id).effective.maxHp, 100 + 2 * 50);
  assert.equal(view(g, 0, other.id).effective.maxHp, 100 + 20, 'Only the Water unit can provide Water.');
});

test('「将在对手的回合结束时被放于弃牌区」: at the end of the opponent\'s turn, not its owner\'s', async () => {
  const f = await fixture((defs) => { def(defs, 'tool').mechanics.opponentTurnEndDiscard = true; });
  let card;
  const g = board(f, (s) => { card = toolOn(s, 0, s.players[0].active); });
  endTurn(g);
  assert(g.snapshot().players[0].active.tools.includes(card), 'Its owner\'s turn ended: still attached.');
  endTurn(g);
  const s = g.snapshot();
  assert(s.players[0].discard.includes(card));
  assert(s.events.some((e) => e.ruleId === 'tools.turn-end-discard'));
  restore(g, f);
  await assert.rejects(fixture((defs) => { def(defs, 'potion').mechanics.opponentTurnEndDiscard = true; }));
});

test('「…直到其剩余HP均变为「100」为止」: each Benched Pokémon to its own remaining HP', async () => {
  const until = { side: 'opponent', target: 'bench', remainingHp: 50, all: true };
  const valid = handlers.get('cn.countersUntil@1').validateParameters;
  assert(valid(until)); assert(!valid({ ...until, target: 'active' }));
  const f = await fixture((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.countersUntil@1', until, 'storm')]; });
  let a, b, c;
  const g = board(f, (s) => { strike(s); a = bench(s, 1, 'other'); b = bench(s, 1, 'other'); c = bench(s, 1, 'base'); b.counters = 2; c.counters = 7; });
  attack(g);
  const counters = (m) => g.snapshot().players[1].bench.find((x) => x.id === m.id).counters;
  assert.deepEqual([counters(a), counters(b), counters(c)], [5, 5, 7], 'One already below 50 HP left gets none.');
});

test('「双方所有宝可梦的弱点，均以「×4」计算伤害」', async () => {
  const valid = handlers.get('cn.property@1').validateParameters;
  const times = { op: 'property', field: 'weaknessMultiplier', value: 4, scope: 'all' };
  assert(valid({ effect: times })); assert(!valid({ effect: { ...times, value: 2 } }));
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.types = ['Fire']; def(defs, 'base').mechanics.attacks[0].cost = ['Fire'];
    def(defs, 'stadium').mechanics.effects = [binding('cn.property@1', { effect: times }, 'quad')];
  });
  f.deck.splice(20, 1, 'printing:fire');
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'fire');
    const o = bench(s, 1, 'other'), p = s.players[1]; p.bench = [p.active]; p.active = o;
    s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop();
  });
  attack(g);
  assert.equal(g.snapshot().players[1].active.counters, 8, '20 × 4.');
});

test('「当这张卡牌，要被从场上放于弃牌区时，…被放回手牌」: Knock Out, Retreat and effects; not while removed', async () => {
  const item = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.discardToHand@1', {}, 'back')]; });
  assert.throws(() => board(item), /Tool or Special Energy/);
  const f = await fixture((defs) => {
    def(defs, 'double').mechanics.effects = [binding('cn.discardToHand@1', {}, 'recycle')];
    def(defs, 'tool').mechanics.effects = [binding('cn.discardToHand@1', {}, 'u-turn')];
    def(defs, 'potion').mechanics.effects = [binding('cn.attachedEnergy@1', { op: 'discardEnergy', side: 'own', from: 'active',
      selector: { kind: 'energy' }, providedTypes: null, measure: 'cards', quantity: { kind: 'exact', count: 1 }, chooser: 'source' }, 'hammer')];
  });
  // A Knock Out: both attached cards go back to their owner's hand.
  let energy, tool;
  const ko = board(f, (s) => { strike(s); const foe = s.players[1].active; foe.counters = 9; energy = attached(s, 1, foe, 'double');
    tool = toolOn(s, 1, foe); bench(s, 1, 'other'); s.players[1].discard.splice(0); });
  attack(ko);
  let s = ko.snapshot();
  assert(s.players[1].hand.includes(energy) && s.players[1].hand.includes(tool));
  assert.equal(s.events.filter((e) => e.ruleId === 'effects.discard-to-hand').length, 2);
  restore(ko, f);
  // A Retreat cost and an effect.
  const retreat = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'double'); bench(s, 0, 'other'); });
  command(retreat, { type: 'retreat' }); settle(retreat, (q) => q.options.slice(0, Math.max(q.minimum, 1)));
  assert(retreat.snapshot().players[0].hand.includes(energy));
  let card;
  const hammer = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'double'); card = hand(s, 0, 'potion'); });
  command(hammer, { type: 'playTrainer', cardId: card }); settle(hammer);
  assert(hammer.snapshot().players[0].hand.includes(energy));
  // Its effect removed: the discard pile as usual.
  const removed = await fixture((defs) => {
    def(defs, 'tool').mechanics.effects = [binding('cn.discardToHand@1', {}, 'u-turn')];
    def(defs, 'stadium').mechanics.effects = [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'tools', scope: 'all' } }, 'jam')];
  });
  const jam = board(removed, (s) => { strike(s); const foe = s.players[1].active; foe.counters = 9; tool = toolOn(s, 1, foe); bench(s, 1, 'other');
    s.stadium = hand(s, 0, 'stadium'); s.players[0].hand.pop(); });
  attack(jam);
  assert(jam.snapshot().players[1].discard.includes(tool));
});

test('「在双方的回合结束时，…处于特殊状态的话，则恢复…。然后，将这张卡牌放于弃牌区」', async () => {
  const berry = binding('cn.when@1', { condition: { kind: 'pokemonIs', who: 'self', state: { conditions: ['asleep', 'paralyzed', 'confused', 'poisoned', 'burned'] } },
    effects: [{ handlerId: 'cn.cure@1', parameters: { side: 'own', target: 'self' } }, { handlerId: 'cn.discardSelf@1', parameters: {} }] }, 'berry');
  const trigger = { event: 'turnEnd', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global', endingPlayer: 'either' };
  const f = await fixture((defs) => { def(defs, 'tool').mechanics.effects = [{ ...berry, trigger }]; });
  let card;
  const g = board(f, (s) => { card = toolOn(s, 1, s.players[1].active); s.players[1].active.conditions.rotation = 'asleep'; });
  endTurn(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.conditions.rotation, null);
  assert(s.players[1].discard.includes(card));
  assert(s.events.some((e) => e.ruleId === 'effects.discard-self'));
  restore(g, f);
  const pokemon = await fixture((defs) => { def(defs, 'base').mechanics.effects = [binding('cn.discardSelf@1', {}, 'x')]; });
  assert.throws(() => board(pokemon), /discards itself/);
});

test('「特殊能量的效果全部消除，被视作1个【无】能量」', async () => {
  const off = { op: 'suppression', channel: 'specialEnergy', scope: 'all' };
  assert(handlers.get('cn.suppression@1').validateParameters({ effect: off }));
  const f = await fixture((defs) => {
    def(defs, 'double').mechanics.baseUnits = [['Water', 'Fire']];
    def(defs, 'stadium').mechanics.effects = [binding('cn.suppression@1', { effect: off }, 'shrine')];
  });
  let mon;
  const units = (g) => view(g, 0, mon.id).effective.energies.map((e) => e.units);
  const g = board(f, (s) => { mon = s.players[0].active; attached(s, 0, mon, 'double'); attached(s, 0, mon, 'water'); });
  assert.deepEqual(units(g), [[['Water', 'Fire']], [['Water']]]);
  const h = board(f, (s) => { mon = s.players[0].active; attached(s, 0, mon, 'double'); attached(s, 0, mon, 'water');
    s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop(); });
  assert.deepEqual(units(h), [[['Colorless']], [['Water']]], 'Basic Energy is unaffected.');
});
