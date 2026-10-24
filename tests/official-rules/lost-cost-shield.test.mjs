// Synthetic definitions only. 「每当双方的宝可梦昏厥时，不将该宝可梦放于弃牌区，而是放于放逐区。（除宝可梦以外的卡牌，全部放于弃牌区。）」
// and 「如果因这只宝可梦的招式的伤害，对手的宝可梦【昏厥】的话，则该【昏厥】的宝可梦，以及放于其身上的所有卡牌…放于放逐区」 (ko.lost-zone);
// 「这只宝可梦使用招式所需的无能量，全部消除」 (energy.requirement.erase); 「（除拥有特性的宝可梦外）」 (printedAbility);
// 「如果追加附有3个【火】能量的话，…。在这种情况下，这个招式的伤害不计算对手战斗宝可梦身上所附加的效果」; 「如果被附着于「宝可梦V・GX」
// 身上的话，则被视作1个【无】能量」 and 「如果自己的剩余奖赏卡张数比对手的剩余奖赏卡多的话」 (energy.provision); 「对手的宝可梦无法使用
// GX招式」; 「不会受到「60」点以下（包含60点）的招式的伤害」; 「将双方战斗宝可梦身上放置的伤害指示物，全部互换」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { matchesCardSelector } from '../../public/rules/card-selection.js';
import { resolveEnergyRequirements } from '../../public/rules/energy-mechanics.js';
import { calculateAttackDamage } from '../../public/rules/damage.js';
import { CN_V20261019 } from '../../public/rules/index.js';
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
const strike = (s, owner = 0) => attached(s, owner, s.players[owner].active, 'water');
const attack = (g, attackId = 'base:strike') => { command(g, { type: 'attack', attackId }); settle(g); };
const lostCity = binding('cn.knockoutZone@1', { effect: { op: 'knockoutZone', scope: 'all', cards: 'pokemon' } }, 'lost-city');
const zones = (s, owner) => ({ lost: s.players[owner].lost.map((id) => s.cards[id].definitionId).sort(),
  discard: s.players[owner].discard.map((id) => s.cards[id].definitionId).sort() });

test('「…放于放逐区。（除宝可梦以外的卡牌，全部放于弃牌区。）」: the Pokémon cards to the Lost Zone, still a Knock Out', async () => {
  const valid = handlers.get('cn.knockoutZone@1').validateParameters;
  assert(valid({ effect: { op: 'knockoutZone', scope: 'all', cards: 'pokemon' } }));
  assert(!valid({ effect: { op: 'knockoutZone', scope: 'self', cards: 'pokemon' } }));
  const f = await fixture((defs) => { def(defs, 'stadium').mechanics.effects = [lostCity]; });
  const g = board(f, (s) => {
    strike(s); s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop();
    const foe = s.players[1].active; foe.counters = 9; attached(s, 1, foe, 'double');
    s.players[1].discard.splice(0); bench(s, 1, 'other');
  });
  attack(g);
  const s = g.snapshot();
  assert.deepEqual(zones(s, 1), { lost: ['base'], discard: ['double'] });
  assert.equal(s.players[0].prizes.length, 5, 'Prize cards are taken as usual.');
  assert(s.events.some((e) => e.ruleId === 'ko.lost-zone' && e.data.cards === 'pokemon'));
  restore(g, f);
});

test('「因这只宝可梦的招式的伤害…昏厥的话，则该宝可梦以及放于其身上的所有卡牌…放于放逐区」', async () => {
  const lostOut = binding('cn.knockoutZone@1', { effect: { op: 'knockoutZone', scope: 'opponent', cards: 'all', byOwnAttack: true } }, 'lost-out');
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.abilities = [continuous('base:lost-out', [lostOut])];
    def(defs, 'stadium').mechanics.effects = [lostCity];
  });
  const setup = (stadium) => board(f, (s) => {
    strike(s); s.players[1].discard.splice(0); bench(s, 1, 'other');
    const foe = s.players[1].active; foe.counters = 9; attached(s, 1, foe, 'double');
    if (stadium) { s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop(); }
  });
  const g = setup(false);
  attack(g);
  assert.deepEqual(zones(g.snapshot(), 1), { lost: ['base', 'double'], discard: [] });
  // Both apply: the Knocked Out Pokémon's owner keeps the other cards in the discard pile.
  const both = setup(true);
  attack(both);
  assert.deepEqual(zones(both.snapshot(), 1), { lost: ['base'], discard: ['double'] });
  // Not by this Pokémon's attack damage: the discard pile as usual.
  const poison = board(f, (s) => { const foe = s.players[1].active; foe.counters = 9; foe.conditions.poison = 1; s.players[1].discard.splice(0);
    bench(s, 1, 'other'); });
  command(poison, { type: 'endTurn' }); settle(poison);
  assert.deepEqual(zones(poison.snapshot(), 1).lost, []);
  const stadium = await fixture((defs) => { def(defs, 'stadium').mechanics.effects = [lostOut]; });
  assert.throws(() => board(stadium), /这只宝可梦的招式/);
});

test('「这只宝可梦使用招式所需的无能量，全部消除」: only the Colorless part of the cost', async () => {
  const erase = { op: 'energyRequirement', action: 'attack', mode: 'erase', scope: 'self', energyType: 'Colorless' };
  const valid = handlers.get('cn.energyRequirement@1').validateParameters;
  assert(valid({ effect: erase })); assert(!valid({ effect: { ...erase, action: 'retreat' } }));
  assert(!valid({ effect: { ...erase, amount: -1 } }));
  const [route] = resolveEnergyRequirements({ printed: ['Water', 'Colorless', 'Colorless'],
    adjustments: [{ id: 'more', energyType: 'Colorless', amount: 2, sourceOfTruth: EVIDENCE }],
    erasures: [{ id: 'trio', energyType: 'Colorless', sourceOfTruth: EVIDENCE }] });
  assert.deepEqual([route.total, route.counts.Water, route.counts.Colorless], [1, 1, 0], 'Added Colorless is erased too.');
  assert.throws(() => resolveEnergyRequirements({ printed: ['Water'], erasures: [{ id: 'x', energyType: 'Ice', sourceOfTruth: EVIDENCE }] }), TypeError);
  const f = await fixture((defs) => {
    const m = def(defs, 'base').mechanics;
    m.attacks[0].cost = ['Water', 'Colorless', 'Colorless'];
    m.abilities = [continuous('base:trio', [binding('cn.energyRequirement@1', { effect: erase }, 'trio')])];
  });
  const g = board(f, (s) => strike(s));
  assert(g.view(0).legalActions.some((a) => a.type === 'attack' && a.attackId === 'base:strike'));
  const none = board(f);
  assert(!none.view(0).legalActions.some((a) => a.type === 'attack'), 'The Water is still needed.');
});

test('「（除拥有特性的宝可梦外）」: the printed card, out of play', async () => {
  const f = await fixture((defs) => { def(defs, 'evolution').mechanics.abilities = [continuous('evolution:x',
    [binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'self' }, 'x')])]; });
  const [base, evolution] = ['base', 'evolution'].map((id) => f.catalog.definition(id));
  const plain = { kind: 'pokemon', printedAbility: false };
  assert(matchesCardSelector(base, plain)); assert(!matchesCardSelector(evolution, plain));
  assert(matchesCardSelector(evolution, { kind: 'pokemon', printedAbility: true }));
});

test('「如果追加附有…的话…在这种情况下，这个招式的伤害不计算对手战斗宝可梦身上所附加的效果」', async () => {
  const extra = { kind: 'compare', left: { kind: 'extraEnergy', energyType: 'Water' }, relation: 'gte', right: { kind: 'literal', value: 1 } };
  const valid = handlers.get('cn.damageOptions@1').validateParameters;
  assert(valid({ ignoreDefenderEffects: true, condition: extra })); assert(!valid({ condition: extra }));
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.damageOptions@1', { ignoreDefenderEffects: true, condition: extra }, 'pierce')];
  });
  for (const [waters, damage] of [[1, 0], [2, 20]]) {
    const g = board(f, (s) => {
      for (let i = 0; i < waters; i++) strike(s);
      s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop();
    });
    attack(g);
    assert.equal(g.snapshot().players[1].active.counters, damage / 10, 'The Stadium\'s -20 applies unless the extra Water is attached.');
  }
  const trainer = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.damageOptions@1', { ignoreWeakness: true, condition: extra })]; });
  assert.throws(() => board(trainer));
});

test('「如果被附着于「宝可梦V・GX」身上的话」「如果自己的剩余奖赏卡张数比对手多的话」: read whenever the Energy is counted', async () => {
  const provision = (extra) => binding('cn.energyProvision@1', { effect: { op: 'energyProvision', scope: 'self',
    selector: { kind: 'energy', category: 'special' }, cardSelf: true, ...extra } }, 'provision');
  const behind = { kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'prizes' }, relation: 'gt',
    right: { kind: 'zoneCount', side: 'opponent', zone: 'prizes' } };
  const f = await fixture((defs) => {
    def(defs, 'double').mechanics.effects = [provision({ units: [['Colorless']], targetSelector: { kind: 'pokemon', tagsAll: ['V'] } })];
    def(defs, 'other').mechanics.tags = ['V'];
    def(defs, 'research').mechanics = { category: 'item', effects: [] };
  });
  f.deck.splice(20, 1, 'printing:double');
  const units = (g, id) => { const p = g.view(0).players[0]; return [p.active, ...p.bench].find((m) => m.id === id).effective.energies.map((e) => e.units); };
  let plain, v;
  const g = board(f, (s) => { plain = s.players[0].active; attached(s, 0, plain, 'double'); v = bench(s, 0, 'other'); attached(s, 0, v, 'double'); });
  assert.deepEqual(units(g, plain.id), [[['Colorless'], ['Colorless']]]);
  assert.deepEqual(units(g, v.id), [[['Colorless']]]);
  const counter = await fixture((defs) => { def(defs, 'double').mechanics.effects = [provision({ units: [['Fire'], ['Fire']], condition: behind })]; });
  for (const [taken, fire] of [[0, false], [1, true]]) {
    let mon;
    const h = board(counter, (s) => { mon = s.players[0].active; attached(s, 0, mon, 'double');
      for (let i = 0; i < taken; i++) s.players[1].hand.push(s.players[1].prizes.pop()); });
    assert.equal(units(h, mon.id)[0][0][0] === 'Fire', fire);
  }
  const reads = await fixture((defs) => { def(defs, 'double').mechanics.effects = [provision({ units: [['Fire']],
    condition: { kind: 'compare', left: { kind: 'pokemonCount', side: 'own', zone: 'field', state: { hasTool: true } }, relation: 'gte',
      right: { kind: 'literal', value: 2 } } })]; });
  assert.throws(() => board(reads), /zone counts/, 'A Pokémon count by kind only (energy.provision-conditions).');
});

test('「在这场对战结束前，对手的宝可梦无法使用GX招式」: only GX attacks, and not counted as used', async () => {
  const lock = { op: 'restriction', scope: 'opponent', actions: ['attack'], specialRules: ['GX'] };
  const valid = handlers.get('cn.restriction@1').validateParameters;
  assert(valid({ effect: lock })); assert(!valid({ effect: { ...lock, actions: ['retreat'] } }));
  const f = await fixture((defs) => {
    def(defs, 'research').mechanics.effects = [binding('cn.lastingPlayer@1', { side: 'own', effect: lock, duration: 'game' }, 'clear-vision')];
    def(defs, 'base').mechanics.attacks.push({ attackId: 'base:gx', name: '测试GX', cost: ['Water'], specialRule: 'GX',
      printedDamage: { value: 50, operator: 'fixed' }, effects: [], sourceOfTruth: EVIDENCE });
  });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'research'); strike(s, 1); });
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  command(g, { type: 'endTurn' }); settle(g);
  const attacks = g.view(1).legalActions.filter((a) => a.type === 'attack').map((a) => a.attackId);
  assert.deepEqual(attacks, ['base:strike']);
  assert.equal(g.snapshot().players[1].gxUsed, false);
  restore(g, f);
});

test('「不会受到「60」点以下（包含60点）的招式的伤害」: compared at the final damage', async () => {
  const shield = (damageAtMost) => ({ op: 'protection', channel: 'damage', useRule: 'ordinary', scope: 'self', from: 'opponent',
    categories: ['attack'], damageAtMost });
  const valid = handlers.get('cn.protection@1').validateParameters;
  assert(valid({ effect: shield(60) })); assert(!valid({ effect: { ...shield(60), channel: 'effects' } }));
  assert(!valid({ effect: { ...shield(60), coin: true } }));
  const f = await fixture((defs) => { def(defs, 'base').mechanics.abilities = [continuous('base:harden', [binding('cn.protection@1', { effect: shield(20) }, 'harden')])]; });
  for (const [tool, counters] of [[false, 0], [true, 5]]) {
    const g = board(f, (s) => { strike(s); if (tool) { const id = hand(s, 0, 'tool'); s.players[0].hand.pop(); s.players[0].active.tools.push(id); } });
    attack(g);
    assert.equal(g.snapshot().players[1].active.counters, counters, '20 is prevented; 20 + 30 is not.');
  }
  const ruleset = CN_V20261019, packet = { ruleset, amount: 60, attackerTypes: ['Fire'], weakness: { type: 'Fire', operation: 'multiply', value: 2 } };
  assert.equal(calculateAttackDamage({ ...packet, preventions: [{ id: 'p', sourceOfTruth: EVIDENCE, atMost: 60 }] }).damage, 120,
    'Weakness first: 120 is more than 60.');
  assert.throws(() => calculateAttackDamage({ ...packet, preventions: [{ id: 'p', sourceOfTruth: EVIDENCE, atMost: 65 }] }), TypeError);
});

test('「将双方战斗宝可梦身上放置的伤害指示物，全部互换」; a protected opponent keeps its counters and ours are removed', async () => {
  const f = await fixture((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.swapCounters@1', {}, 'swap')]; });
  const g = board(f, (s) => { strike(s); s.players[0].active.counters = 3; s.players[1].active.counters = 5; });
  attack(g);
  let s = g.snapshot();
  assert.deepEqual([s.players[0].active.counters, s.players[1].active.counters], [7, 3], 'The 20 damage comes first.');
  assert(s.events.some((e) => e.ruleId === 'damage.counters-swap'));
  restore(g, f);
  const shielded = await fixture((defs) => {
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.swapCounters@1', {}, 'swap')];
    def(defs, 'other').mechanics.abilities = [continuous('other:veil', [binding('cn.protection@1', { effect: { op: 'protection', channel: 'effects',
      useRule: 'ordinary', scope: 'self', from: 'opponent', categories: ['attack'] } }, 'veil')])];
  });
  const h = board(shielded, (s) => { strike(s); s.players[0].active.counters = 3;
    const o = bench(s, 1, 'other'), p = s.players[1]; p.bench = [p.active]; p.active = o; o.counters = 5; });
  attack(h);
  s = h.snapshot();
  assert.deepEqual([s.players[0].active.counters, s.players[1].active.counters], [0, 7]);
});
