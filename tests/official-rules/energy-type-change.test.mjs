// Synthetic definitions only. Shapes follow printed CN text: 火暴兽 「燃烧能量 在自己的回合可以使用1次。在这个回合结束前，将自己场上宝可梦
// 身上附着的所有能量，都视作【火】能量。（也包括新出场的卡牌。）」 and 喷火龙 「能量烈焰 附着在喷火龙身上的「火」以外的能量，都视作「火」能量。
// 在「混乱」状态下不生效。」 (energy.provision-type), ordered against 「特殊能量的效果全部消除，被视作1个【无】能量」 and 「…所有基本【水】能量，
// 各被视作2个【水】能量」 by the moment each began (JP Q&A バクフーン×ヨノワール／フシギバナ). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { resolveEnergyTypeChanges, resolveEnergyProvision } from '../../public/rules/energy-mechanics.js';
import { ENERGY_TYPES } from '../../public/rules/damage.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const fire = { op: 'energyProvision', scope: 'own', selector: { kind: 'energy' }, cardSelf: false, asType: 'Fire' };
const notConfused = { kind: 'not', condition: { kind: 'pokemonIs', who: 'self', state: { conditions: ['confused'] } } };
const burn = (extra = {}) => ({ op: 'energyProvision', scope: 'self', selector: { kind: 'energy' }, cardSelf: false, asType: 'Fire',
  othersOnly: true, condition: notConfused, ...extra });
const ability = (abilityId, mode, effects) => ({ abilityId, name: '测试特性', mode, effects, sourceOfTruth: EVIDENCE,
  usage: mode === 'activated' ? { period: 'turn', scope: 'pokemon', key: `cn:ability:${abilityId}`, limit: 1 } : null });
// 「将自己场上宝可梦身上附着的所有能量，都视作【火】能量」 on 'base'; the Charizard text on 'other'; an all-type Special Energy.
const typhlosion = (defs) => {
  def(defs, 'base').mechanics.abilities = [ability('blaze', 'activated', [binding('cn.lastingPlayer@1',
    { side: 'own', duration: 'thisTurn', effect: fire }, 'blaze')])];
};
const charizard = (extra) => (defs) => {
  def(defs, 'other').mechanics.abilities = [ability('burn', 'continuous', [binding('cn.energyProvision@1', { effect: burn(extra) }, 'burn')])];
};
const rainbow = (defs) => { def(defs, 'double').mechanics.baseUnits = [ENERGY_TYPES]; };
const units = (g, owner, id) => {
  const p = g.view(owner).players[owner];
  return [p.active, ...p.bench].find((m) => m.id === id).effective.energies.map((e) => e.units);
};
const blaze = (g) => { command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'blaze' }); settle(g); };
const endTurn = (g) => { command(g, { type: 'endTurn' }); settle(g); };

test('energy.provision-type: an asType provision keeps the count and is validated as its own shape', () => {
  const v = handlers.get('cn.energyProvision@1').validateParameters, lasting = handlers.get('cn.lastingPlayer@1').validateParameters;
  assert(v({ effect: burn() }));
  assert(!v({ effect: { ...burn(), cardSelf: true } }), 'A card never changes its own type this way.');
  assert(!v({ effect: { ...burn(), units: [['Fire']] } }));
  assert(!v({ effect: { op: 'energyProvision', scope: 'self', selector: { kind: 'energy' }, cardSelf: false, units: [['Fire']], othersOnly: true } }));
  assert(lasting({ side: 'own', duration: 'thisTurn', effect: fire }));
  assert(!lasting({ side: 'opponent', duration: 'thisTurn', effect: fire }));
  assert(!lasting({ side: 'own', duration: 'thisTurn', effect: { ...fire, scope: 'opponent' } }));
  const provided = resolveEnergyProvision([['Water'], ['Water']], []);
  assert.deepEqual(resolveEnergyTypeChanges(provided, [{ id: 'x', asType: 'Fire', sourceOfTruth: EVIDENCE }]).units, [['Fire'], ['Fire']]);
  assert.deepEqual(resolveEnergyTypeChanges(resolveEnergyProvision([ENERGY_TYPES], []),
    [{ id: 'x', asType: 'Fire', othersOnly: true, sourceOfTruth: EVIDENCE }]).units, [ENERGY_TYPES], '「「火」以外的能量」 only.');
  assert.throws(() => resolveEnergyTypeChanges(provided, [{ id: 'x', asType: 'Dragon', sourceOfTruth: EVIDENCE }]), /type change/);
});

test('「在「混乱」状态下不生效」: an Energy provision condition reads only the holder\'s own Special Conditions besides zone counts', async () => {
  const f = await fixture(charizard());
  const card = f.catalog.definition('other');
  assert.doesNotThrow(() => assertSupportedDefinition(f.catalog, card));
  for (const condition of [{ kind: 'pokemonIs', who: 'opponentActive', state: { conditions: ['confused'] } },
    { kind: 'pokemonIs', who: 'self', state: { conditions: ['confused'], damaged: true } },
    { kind: 'pokemonIs', who: 'self', selector: { kind: 'pokemon' }, state: { conditions: ['confused'] } },
    { kind: 'pokemonIs', who: 'self', position: 'active' }]) {
    const changed = clone(card);
    changed.mechanics.abilities[0].effects[0].parameters.effect.condition = condition;
    assert.throws(() => assertSupportedDefinition(f.catalog, changed), /provision condition/);
  }
});

test('「附着在喷火龙身上的「火」以外的能量，都视作「火」能量。在「混乱」状态下不生效。」: on this Pokémon only, all-type Energy kept, not while Confused', async () => {
  const f = await fixture((defs) => {
    charizard()(defs); rainbow(defs);
    def(defs, 'other').mechanics.attacks[0].cost = ['Fire', 'Fire', 'Fire'];
  });
  f.deck.splice(20, 2, 'printing:fire', 'printing:double');
  let mon, plain;
  const g = board(f, (s) => {
    mon = bench(s, 0, 'other'); const p = s.players[0]; p.bench = [p.active]; plain = p.active; p.active = mon;
    attached(s, 0, mon, 'water'); attached(s, 0, mon, 'water'); attached(s, 0, mon, 'fire'); attached(s, 0, mon, 'double');
    attached(s, 0, plain, 'water');
  });
  assert.deepEqual(units(g, 0, mon.id), [[['Fire']], [['Fire']], [['Fire']], [ENERGY_TYPES]]);
  assert.deepEqual(units(g, 0, plain.id), [[['Water']]], 'Only Energy attached to this Pokémon.');
  assert(g.view(0).legalActions.some((a) => a.type === 'attack' && a.attackId === 'other:strike'), 'Two Water now pay 【火】.');
  const confused = board(f, (s) => {
    mon = bench(s, 0, 'other'); const p = s.players[0]; p.bench = [p.active]; p.active = mon;
    attached(s, 0, mon, 'water'); mon.conditions.rotation = 'confused';
  });
  assert.deepEqual(units(confused, 0, mon.id), [[['Water']]]);
});

test('「在这个回合结束前，将自己场上宝可梦身上附着的所有能量，都视作【火】能量。（也包括新出场的卡牌。）」: every own Energy, later ones too, this turn only', async () => {
  const f = await fixture((defs) => {
    typhlosion(defs); rainbow(defs);
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.attachedEnergy@1', { op: 'discardEnergy', side: 'own', from: 'self',
      selector: { kind: 'energy' }, providedTypes: ['Fire'], measure: 'cards', quantity: { kind: 'all' }, chooser: 'source' }, 'flare')];
    def(defs, 'base').mechanics.attacks[0].cost = ['Fire'];
  });
  f.deck.splice(20, 1, 'printing:double');
  let me, foe, card, extra, later;
  const g = board(f, (s) => {
    me = s.players[0].active; foe = s.players[1].active;
    attached(s, 0, me, 'water'); attached(s, 0, me, 'double'); attached(s, 1, foe, 'water');
    card = hand(s, 0, 'water'); extra = hand(s, 0, 'other');
  });
  blaze(g);
  assert.deepEqual(units(g, 0, me.id), [[['Fire']], [['Fire']]], 'An all-type Special Energy is then only Fire (JP Q&A レインボーエネルギー).');
  assert.deepEqual(units(g, 1, foe.id), [[['Water']]], 'Not the opponent\'s.');
  command(g, { type: 'bench', cardId: extra }); settle(g);
  later = g.snapshot().players[0].bench.at(-1).id;
  command(g, { type: 'attachEnergy', cardId: card, pokemonId: later }); settle(g);
  assert.deepEqual(units(g, 0, later), [[['Fire']]], 'Energy attached later, on a Pokémon put into play later, too.');
  const r = restore(g, f);
  assert.equal(r.snapshot().energyLayers.length, 1);
  assert.equal(r.view(0).players[0].active.effective.energies.length, 2);
  // 「【火】能量」 read by provided type: both cards are discarded by an attack discarding every 【火】 Energy.
  command(r, { type: 'attack', attackId: 'base:strike' }); settle(r);
  assert.equal(r.snapshot().players[0].active.energy.length, 0);
  endTurn(g);
  assert.deepEqual(units(g, 0, later), [[['Water']]], 'It ends with the turn.');
  assert(!('energyLayers' in g.snapshot()), 'Nothing left to order.');
});

test('「基本【水】能量」 stays the card it is: a type change changes only what it provides (II.E-39)', async () => {
  const f = await fixture((defs) => {
    typhlosion(defs);
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.attachedEnergy@1', { op: 'returnEnergy', side: 'own', from: 'self',
      selector: { kind: 'energy', category: 'basic', types: ['Water'] }, providedTypes: null, measure: 'cards', quantity: { kind: 'all' },
      chooser: 'source', to: 'hand' }, 'tide')];
    def(defs, 'base').mechanics.attacks[0].cost = ['Fire'];
  });
  let me;
  const g = board(f, (s) => { me = s.players[0].active; attached(s, 0, me, 'water'); attached(s, 0, me, 'water'); });
  assert(!g.view(0).legalActions.some((a) => a.type === 'attack'));
  blaze(g);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[0].active.energy.length, 0, 'Both Basic Water Energy cards are returned.');
});

test('JP Q&A バクフーン×ヨノワール: a Special Energy removal begun before the change is under it; one begun after it undoes it', async () => {
  const f = await fixture((defs) => {
    typhlosion(defs);
    def(defs, 'stadium').mechanics.effects = [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'specialEnergy', scope: 'all' } }, 'bleach')];
  });
  let me, stadium;
  // Removal first: the 2-Energy card provides 1 Colorless, then 1 Fire.
  const before = board(f, (s) => {
    me = s.players[0].active; attached(s, 0, me, 'double');
    const p = s.players[0], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'stadium');
    s.stadium = p.deck.splice(i, 1)[0];
  });
  assert.deepEqual(units(before, 0, me.id), [[['Colorless']]]);
  blaze(before);
  assert.deepEqual(units(before, 0, me.id), [[['Fire']]]);
  assert.equal(before.snapshot().energyLayers.length, 2);
  // The change first: the removal begun later makes it 1 Colorless again.
  const after = board(f, (s) => { me = s.players[0].active; attached(s, 0, me, 'double'); stadium = hand(s, 0, 'stadium'); });
  blaze(after);
  assert.deepEqual(units(after, 0, me.id), [[['Fire'], ['Fire']]]);
  command(after, { type: 'playTrainer', cardId: stadium }); settle(after);
  assert.deepEqual(units(after, 0, me.id), [[['Colorless']]]);
  // Begun at the same moment (nothing recorded which came first): no guess.
  const s = clone(after.snapshot());
  delete s.energyLayers;
  assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }).view(0), /same moment/);
});

test('JP Q&A バクフーン×フシギバナ: 「…基本【水】能量，各被视作2个【水】能量」 begun before is 2 Fire; begun after (evolving) is 2 Water again', async () => {
  const f = await fixture((defs) => {
    typhlosion(defs);
    def(defs, 'evolution').mechanics.abilities = [ability('totem', 'continuous', [binding('cn.energyProvision@1', { effect: { op: 'energyProvision',
      scope: 'own', selector: { kind: 'energy', category: 'basic', types: ['Water'] }, cardSelf: false, units: [['Water'], ['Water']] } }, 'totem')])];
  });
  let me, grown, card;
  const before = board(f, (s) => { me = s.players[0].active; attached(s, 0, me, 'water'); grown = bench(s, 0, 'evolution'); });
  blaze(before);
  assert.deepEqual(units(before, 0, me.id), [[['Fire'], ['Fire']]]);
  const after = board(f, (s) => { me = s.players[0].active; attached(s, 0, me, 'water'); grown = bench(s, 0, 'base'); card = hand(s, 0, 'evolution'); });
  blaze(after);
  assert.deepEqual(units(after, 0, me.id), [[['Fire']]]);
  command(after, { type: 'evolve', cardId: card, pokemonId: grown.id }); settle(after);
  assert.deepEqual(units(after, 0, me.id), [[['Water'], ['Water']]]);
});

test('energy.provision-type: changes begun together apply when their order cannot matter, and refuse when it would', async () => {
  const f = await fixture((defs) => {
    typhlosion(defs); charizard()(defs);
    def(defs, 'evolution').mechanics.abilities = [ability('tide', 'continuous', [binding('cn.energyProvision@1',
      { effect: { op: 'energyProvision', scope: 'self', selector: { kind: 'energy' }, cardSelf: false, asType: 'Water' } }, 'tide')])];
  });
  let mon, other;
  const g = board(f, (s) => {
    mon = s.players[0].active; attached(s, 0, mon, 'water');
    other = bench(s, 0, 'other'); attached(s, 0, other, 'water');
  });
  blaze(g);
  const s = clone(g.snapshot());
  delete s.energyLayers;
  const same = OfficialGame.restore(s, { catalog: f.catalog });
  assert.deepEqual(units(same, 0, other.id), [[['Fire']]], 'Two changes to Fire begun together: Fire either way.');
  const p = s.players[0], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'evolution');
  p.bench.find((m) => m.id === other.id).stack.push(p.deck.splice(i, 1)[0]);
  assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }).view(0), /same moment/, 'Fire and Water begun together.');
});

test('energy.provision-type: the record follows effects ending and beginning again (a Confused holder\'s change restarts)', async () => {
  const f = await fixture((defs) => {
    charizard()(defs);
    def(defs, 'stadium').mechanics.effects = [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'specialEnergy', scope: 'all' } }, 'bleach')];
    def(defs, 'potion').mechanics.effects = [binding('cn.cure@1', { side: 'own', target: 'active', count: 1 }, 'cure')];
  });
  let mon, potion;
  const g = board(f, (s) => {
    mon = bench(s, 0, 'other'); const p = s.players[0]; p.bench = [p.active]; p.active = mon;
    attached(s, 0, mon, 'double'); mon.conditions.rotation = 'confused'; potion = hand(s, 0, 'potion');
    const i = p.deck.findIndex((id) => s.cards[id].definitionId === 'stadium');
    s.stadium = p.deck.splice(i, 1)[0];
  });
  assert.deepEqual(units(g, 0, mon.id), [[['Colorless']]]);
  command(g, { type: 'playTrainer', cardId: potion }); settle(g);
  assert.deepEqual(units(g, 0, mon.id), [[['Fire']]], 'Cured after the removal began: its change is the later one.');
  assert.equal(restore(g, f).snapshot().energyLayers.length, 2);
});
