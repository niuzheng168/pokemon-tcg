// Synthetic definitions only. Shapes follow printed CN Special Energy and protection text:
// 「如果身上附着了这张卡牌的宝可梦，身上还附着了除这张卡牌以外的特殊能量的话，则这张卡牌被视作1个【无】能量」,
// 「如果被附着于2阶进化宝可梦身上的话，则被视作2个所有属性的能量」 and
// 「自己所有备战宝可梦（除「拥有规则的宝可梦」外）不会受到对手招式的伤害」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { ENERGY_TYPES } from '../../public/rules/damage.js';
import { fixture, binding, EVIDENCE, board, command, settle, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const provision = (extra) => binding('cn.energyProvision@1', { effect: { op: 'energyProvision', scope: 'self',
  selector: { kind: 'energy', category: 'special' }, cardSelf: true, ...extra } }, 'provision');
const special = (baseUnits, effect) => (defs) => {
  const d = defs.find((d) => d.definitionId === 'double');
  d.mechanics.baseUnits = baseUnits; d.mechanics.effects = [effect];
};
const units = (g, owner, id) => {
  const p = g.view(owner).players[owner];
  return [p.active, ...p.bench].find((m) => m.id === id).effective.energies.map((e) => e.units);
};

test('energy provision accepts printed stage and other-attached conditions only as reviewed selectors', () => {
  const v = createCoreHandlers().get('cn.energyProvision@1');
  assert.doesNotThrow(() => v.validateParameters({ effect: { op: 'energyProvision', scope: 'self', selector: { kind: 'energy' },
    cardSelf: true, units: [['Colorless']], otherAttached: { kind: 'energy', category: 'special' }, stages: ['stage2'] } }) ||
    (() => { throw new Error('no'); })());
  assert.throws(() => v.validateParameters({ effect: { op: 'energyProvision', scope: 'self', selector: { kind: 'energy' },
    cardSelf: true, units: [['Colorless']], otherAttached: { kind: 'pokemon' } } }) || (() => { throw new Error('no'); })());
});

test('「还附着了除这张卡牌以外的特殊能量的话」: all-type Energy becomes 1 Colorless only beside another Special Energy', async () => {
  const f = await fixture(special([ENERGY_TYPES], provision({ units: [['Colorless']], otherAttached: { kind: 'energy', category: 'special' } })));
  f.deck.splice(20, 1, 'printing:double');
  let mon;
  const alone = board(f, (s) => { mon = s.players[0].active; attached(s, 0, mon, 'double'); attached(s, 0, mon, 'water'); });
  assert.deepEqual(units(alone, 0, mon.id), [[ENERGY_TYPES], [['Water']]]);
  const pair = board(f, (s) => { mon = s.players[0].active; attached(s, 0, mon, 'double'); attached(s, 0, mon, 'double'); });
  assert.deepEqual(units(pair, 0, mon.id), [[['Colorless']], [['Colorless']]], 'Each sees the other Special Energy.');
  assert.deepEqual(OfficialGame.restore(clone(pair.snapshot()), { catalog: f.catalog }).view(0), pair.view(0));
});

test('「被附着于2阶进化宝可梦身上的话」 (stage-gated): 1 Colorless elsewhere, 2 all-type units on the printed stage', async () => {
  const f = await fixture(special([['Colorless']], provision({ units: [ENERGY_TYPES, ENERGY_TYPES], stages: ['stage1'] })));
  let basic, evolved;
  const g = board(f, (s) => {
    basic = s.players[0].active; attached(s, 0, basic, 'double');
    evolved = bench(s, 0, 'evolution');
  });
  assert.deepEqual(units(g, 0, basic.id), [[['Colorless']]]);
  const h = board(f, (s) => { evolved = bench(s, 0, 'evolution'); attached(s, 0, evolved, 'double'); });
  assert.deepEqual(units(h, 0, evolved.id), [[ENERGY_TYPES, ENERGY_TYPES]]);
});

test('「除「拥有规则的宝可梦」外」: Bench protection skips Pokémon with a Rule Box and the Active', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{ abilityId: 'fixture:curtain', name: '测试花纱', mode: 'continuous',
      usage: null, sourceOfTruth: EVIDENCE, effects: [binding('cn.protection@1', { effect: { op: 'protection', channel: 'damage',
        useRule: 'ordinary', scope: 'own', from: 'opponent', categories: ['attack'], benchOnly: true, ruleBox: false } }, 'curtain')] }];
    Object.assign(defs.find((d) => d.definitionId === 'evolution').mechanics, { ruleBox: true, prizeCount: 2 });
    defs.find((d) => d.definitionId === 'base').mechanics.attacks[0].effects = [
      binding('cn.damage@1', { side: 'opponent', target: 'any', amount: 30, selection: { kind: 'all' }, options: {} }, 'spread')];
  });
  let curtain, plain, boxed;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    curtain = bench(s, 1, 'other'); plain = bench(s, 1, 'base'); boxed = bench(s, 1, 'evolution');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot(), counters = (id) => s.players[1].bench.find((m) => m.id === id).counters;
  assert.deepEqual([counters(curtain.id), counters(plain.id), counters(boxed.id)], [0, 0, 3]);
  assert.equal(s.players[1].active.counters, 5, 'The Active takes the printed 20 plus 30.');
});
