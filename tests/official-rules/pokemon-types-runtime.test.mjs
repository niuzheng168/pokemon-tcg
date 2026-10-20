// Real OfficialGame interaction tests. All cards below are synthetic fixtures,
// not approval of Hoopa V, another printing, or any metadata/evidence source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached,
} from './fixtures.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const typeEffect = (extra = {}) => ({ op: 'pokemonTypes', types: ['Psychic', 'Darkness'], scope: 'self', ...extra });
const continuous = (id, effects) => ({
  abilityId: id, name: `测试持续特性${id}`, mode: 'continuous', usage: null, effects, sourceOfTruth: EVIDENCE,
});
const activated = (id, effects) => ({
  abilityId: id, name: `测试可用特性${id}`, mode: 'activated',
  usage: { period: 'unlimited', scope: 'pokemon', key: id, limit: null }, effects, sourceOfTruth: EVIDENCE,
});
function dual(defs, name = 'base', extra = {}) {
  const d = defs.find((d) => d.definitionId === name);
  d.mechanics.types = ['Darkness'];
  d.mechanics.abilities.push(continuous('dual', [binding('cn.pokemonTypes@1', { effect: typeEffect(extra) }, `dual:${name}`)]));
  return d;
}
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const effective = (g, owner = 0) => g.view(0).players[owner].active.effective;
const currentTypes = (g, owner = 0) => effective(g, owner).types;
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const use = (g, abilityId) => command(g, { type: 'useAbility', abilityId, pokemonId: g.snapshot().players[0].active.id });
const attack = (g) => { command(g, { type: 'attack', attackId: 'base:strike' }); settle(g); };
function put(s, owner, name, zone) {
  const id = hand(s, owner, name); s.players[owner].hand.pop(); s.players[owner][zone].push(id); return id;
}
function stadium(s, name = 'stadium') {
  const id = hand(s, 0, name); s.players[0].hand.pop(); s.stadium = id; return id;
}
function otherActive(s, owner = 1) {
  const p = s.players[owner], old = p.active, replacement = bench(s, owner, 'other');
  p.bench.splice(p.bench.indexOf(replacement), 1); p.active = replacement; p.bench.push(old);
  return replacement;
}
function play(g, definitionId) {
  const s = g.snapshot(), action = g.view(s.current).legalActions.find((a) =>
    a.type === 'playTrainer' && s.cards[a.cardId].definitionId === definitionId);
  assert(action, `Expected playable ${definitionId}`);
  command(g, action); settle(g);
}
const discard = (extra = {}) => ({
  op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' },
  providedTypes: ['Psychic'], measure: 'units', quantity: { kind: 'exact', count: 1 },
  chooser: 'source', ...extra,
});

test('core pokemonTypes handler is a derived-type descriptor, not printed metadata mutation or a damage/Energy-type action', () => {
  const h = createCoreHandlers().get('cn.pokemonTypes@1'), parameters = { effect: typeEffect() };
  assert(h); assert.equal(h.timing, 'pokemonTypes');
  assert.deepEqual(h.operations, ['pokemonTypes']);
  assert(h.validateParameters(parameters)); assert.deepEqual(h.execute({}, parameters), [parameters.effect]);
  for (const invalid of [{}, parameters.effect, { ...parameters, verified: true },
    { effect: typeEffect({ types: [] }) }, { effect: typeEffect({ types: ['Psychic', 'Psychic'] }) },
    { effect: typeEffect({ types: ['Unknown'] }) }, { effect: typeEffect({ count: 2 }) }]) assert(!h.validateParameters(invalid));
});

test('Hoopa-V-shaped dual current types use either matching weakness once, then matching resistance, while printed type and costs stay unchanged', async () => {
  for (const [weakness, resistance, expectedCounters] of [
    ['Psychic', null, 4], ['Darkness', null, 4], ['Water', null, 2],
    ['Psychic', { type: 'Darkness', value: 30 }, 1],
  ]) {
    const f = await fixture((defs) => {
      dual(defs);
      defs[1].mechanics.hp = 300;
      defs[1].mechanics.weakness = { type: weakness, operation: 'multiply', value: 2 };
      defs[1].mechanics.resistance = resistance;
    });
    let g = board(f, (s) => { otherActive(s); attached(s, 0, s.players[0].active, 'water'); });
    const printed = clone(f.catalog.definition('base')), before = g.snapshot();
    assert.deepEqual(currentTypes(g), ['Psychic', 'Darkness']);
    assert.deepEqual(printed.mechanics.types, ['Darkness']);
    assert.deepEqual(printed.mechanics.attacks[0].cost, ['Water'], 'Pokémon type is not its attack Energy requirement');
    g = restore(g, f); assert.deepEqual(currentTypes(g), ['Psychic', 'Darkness']);
    attack(g);
    assert.equal(g.snapshot().players[1].active.counters, expectedCounters);
    assert.deepEqual(f.catalog.definition('base'), printed);
    assert.deepEqual(g.snapshot().cards, before.cards);
    assert.deepEqual(g.snapshot().rng, before.rng);
  }
});

test('typed attack/HP/retreat modifiers consume current types consistently, not only the printed Darkness type', async () => {
  const f = await fixture((defs) => {
    dual(defs);
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
      binding('cn.modifier@1', { field: 'attackDamage', amount: 10, scope: 'own', type: 'Psychic' }, 'typed-damage'),
      binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'own', type: 'Psychic' }, 'typed-hp'),
      binding('cn.modifier@1', { field: 'retreat', amount: -1, scope: 'own', type: 'Psychic' }, 'typed-retreat'),
    ];
  });
  const g = board(f, (s) => { stadium(s); otherActive(s); attached(s, 0, s.players[0].active, 'water'); });
  assert.equal(effective(g).maxHp, 150); assert.equal(effective(g).retreatCost, 0);
  assert.equal(f.catalog.definition('base').mechanics.hp, 100);
  assert.equal(f.catalog.definition('base').mechanics.retreatCost, 1);
  attack(g); assert.equal(g.snapshot().players[1].active.counters, 3);
});

test('typed damage/effect protection sees the defender current types and keeps damage separate from attack effects', async () => {
  for (const [channel, counters] of [['damage', 1], ['effects', 2]]) {
    const f = await fixture((defs) => {
      dual(defs, 'other');
      defs[0].mechanics.attacks[0].effects = [binding('cn.counters@1', { side: 'opponent', target: 'active', count: 1 })];
      defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.protection@1', { effect: {
        op: 'protection', useRule: 'ordinary', channel, scope: 'opponent', type: 'Psychic', from: 'opponent', categories: ['attack'],
      } })];
    });
    const g = board(f, (s) => { stadium(s); otherActive(s); attached(s, 0, s.players[0].active, 'water'); });
    assert.deepEqual(currentTypes(g, 1), ['Psychic', 'Darkness']);
    attack(g); assert.equal(g.snapshot().players[1].active.counters, counters);
  }
});

test('current-type retreat lock is real and atomic; sourceActive/activeOnly recalculate when the source returns to the Bench', async () => {
  const f = await fixture((defs) => {
    dual(defs, 'base', { scope: 'own', activeOnly: true, sourceActive: true });
    defs[0].mechanics.retreatCost = 0;
    defs[1].mechanics.retreatCost = 0;
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.restriction@1', { effect: {
      op: 'restriction', scope: 'own', type: 'Psychic', actions: ['retreat'],
    } })];
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [
      binding('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' }),
    ];
  });
  let target, baseBench;
  let g = board(f, (s) => {
    stadium(s); target = bench(s, 0, 'other').id; baseBench = bench(s, 0, 'base').id; hand(s, 0, 'potion');
  });
  assert.deepEqual(currentTypes(g), ['Psychic', 'Darkness']);
  assert.deepEqual(g.view(0).players[0].bench.find((m) => m.id === baseBench).effective.types, ['Darkness']);
  assert(!g.view(0).legalActions.some((a) => a.type === 'retreat'));
  const before = g.snapshot();
  assert.throws(() => command(g, { type: 'retreat' }), /not legal/); assert.deepEqual(g.snapshot(), before);
  const swap = g.view(0).legalActions.find((a) => a.type === 'playTrainer' && before.cards[a.cardId].definitionId === 'potion');
  command(g, swap); assert(g.snapshot().pending.options.includes(target));
  g = restore(g, f); answer(g, [target]); settle(g);
  assert.deepEqual(currentTypes(g), ['Water']);
  assert(g.view(0).players[0].bench.every((m) => m.effective.types.length === 1));
  assert(g.view(0).legalActions.some((a) => a.type === 'retreat'), 'Water is no longer caught by the Psychic retreat lock');
});

test('out-of-play deck selectors keep printed attributes even when the same definition has a type-changing Ability in play', async () => {
  const search = (type) => ({
    from: 'deck', to: 'hand', selector: { kind: 'pokemon', types: [type] },
    quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: true,
  });
  const f = await fixture((defs) => {
    dual(defs);
    defs[0].mechanics.abilities.push(
      activated('psychic-search', [binding('cn.cards@1', search('Psychic'), 'psychic-search')]),
      activated('dark-search', [binding('cn.cards@1', search('Darkness'), 'dark-search')]),
    );
  });
  let physical;
  let g = board(f, (s) => { physical = put(s, 0, 'base', 'deck'); });
  assert.deepEqual(currentTypes(g), ['Psychic', 'Darkness']);
  use(g, 'psychic-search');
  assert(!g.snapshot().pending.options.includes(physical));
  assert(g.view(0).pending.lookedAt.some((c) => c.instanceId === physical));
  g = restore(g, f); answer(g, ['confirm']); settle(g);
  use(g, 'dark-search'); assert(g.snapshot().pending.options.includes(physical));
  g = restore(g, f); answer(g, [physical]); settle(g);
  assert(g.snapshot().players[0].hand.includes(physical));
  assert.deepEqual(f.catalog.definition('base').mechanics.types, ['Darkness']);
});

test('in-play Pokémon selectors for an Energy recipient use current types, not the out-of-play printed predicate result', async () => {
  const move = {
    op: 'moveEnergy', side: 'own', from: 'self', selector: { kind: 'energy' }, providedTypes: null,
    measure: 'cards', quantity: { kind: 'exact', count: 1 }, chooser: 'source',
    recipient: { position: 'bench', selector: { kind: 'pokemon', types: ['Psychic'] } }, distribution: 'singleRecipient',
  };
  const f = await fixture((defs) => {
    dual(defs, 'other');
    defs[0].mechanics.abilities.push(activated('move', [binding('cn.attachedEnergy@1', move)]));
  });
  let energy, target;
  let g = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'water'); target = bench(s, 0, 'other').id; });
  assert.deepEqual(g.view(0).players[0].bench[0].effective.types, ['Psychic', 'Darkness']);
  assert.deepEqual(f.catalog.definition('other').mechanics.types, ['Darkness']);
  use(g, 'move'); answer(g, [energy]); assert.deepEqual(g.snapshot().pending.options, [target]);
  g = restore(g, f); answer(g, [target]); settle(g);
  assert.deepEqual(g.snapshot().players[0].bench[0].energy, [energy]);
  assert(!g.snapshot().players[0].flags.energy);
});

test('handAttachTo and Special Energy retention read current types; suppressing the type source discards a now-forbidden attachment', async () => {
  const f = await fixture((defs) => {
    dual(defs);
    const e = defs.find((d) => d.definitionId === 'double').mechanics;
    e.handAttachTo = { kind: 'pokemon', types: ['Psychic'] };
    e.remainOn = { kind: 'pokemon', types: ['Psychic'] };
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.suppression@1', {
      effect: { op: 'suppression', channel: 'abilities', scope: 'all' },
    })];
  });
  let energy, target;
  let g = board(f, (s) => { energy = hand(s, 0, 'double'); target = bench(s, 0, 'other').id; hand(s, 0, 'stadium'); });
  const source = g.snapshot().players[0].active.id;
  assert(g.view(0).legalActions.some((a) => a.type === 'attachEnergy' && a.cardId === energy && a.pokemonId === source));
  assert(!g.view(0).legalActions.some((a) => a.type === 'attachEnergy' && a.cardId === energy && a.pokemonId === target));
  command(g, { type: 'attachEnergy', cardId: energy, pokemonId: source }); settle(g);
  assert(g.snapshot().players[0].active.energy.includes(energy));
  g = restore(g, f); play(g, 'stadium');
  assert.deepEqual(currentTypes(g), ['Darkness']);
  assert(!g.snapshot().players[0].active.energy.includes(energy));
  assert(g.snapshot().players[0].discard.includes(energy));
  assert(g.snapshot().players[0].flags.energy, 'changing the holder type does not reset the ordinary attachment quota');
  assert.deepEqual(restore(g, f).view(0), g.view(0));
});

test('type-conditioned Energy provision and provided-unit selection agree; a provided Psychic unit is not a printed Basic Psychic card', async () => {
  const f = await fixture((defs) => {
    dual(defs);
    defs.find((d) => d.definitionId === 'double').mechanics.baseUnits = [['Colorless']];
    defs[0].mechanics.abilities.push(
      continuous('psychic-provision', [binding('cn.energyProvision@1', { effect: {
        op: 'energyProvision', scope: 'self', type: 'Psychic', cardSelf: false,
        selector: { kind: 'energy', category: 'special' }, units: [['Psychic'], ['Darkness']],
      } })]),
      activated('discard-psychic', [binding('cn.attachedEnergy@1', discard(), 'discard-current-unit')]),
      activated('basic-psychic', [binding('cn.attachedEnergy@1', discard({
        selector: { kind: 'energy', category: 'basic', types: ['Psychic'] },
      }), 'discard-printed-basic')]),
    );
  });
  let energy;
  let g = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'double'); });
  assert.deepEqual(effective(g).energies.find((e) => e.instanceId === energy).units, [['Darkness'], ['Psychic']]);
  assert(!g.view(0).legalActions.some((a) => a.abilityId === 'basic-psychic'));
  use(g, 'discard-psychic'); assert.deepEqual(g.snapshot().pending.options, [energy]);
  assert.equal(g.view(0).pending.energy[0].amount, 1);
  assert.deepEqual(g.view(0).pending.energy[0].units, [['Darkness'], ['Psychic']]);
  g = restore(g, f); answer(g, [energy]); settle(g);
  assert.equal(g.snapshot().players[0].active.energy.length, 0);
  assert.equal(g.snapshot().players[0].discard.filter((id) => id === energy).length, 1);
  assert.deepEqual(f.catalog.definition('double').mechanics.baseUnits, [['Colorless']]);
});

test('ordinary evolution replaces the type-changing top Ability with the evolved printed type, preserving identity and attachments', async () => {
  const f = await fixture((defs) => { dual(defs); defs[2].mechanics.types = ['Fire']; });
  let evolution, energy;
  const g = board(f, (s) => { evolution = hand(s, 0, 'evolution'); energy = attached(s, 0, s.players[0].active, 'water'); });
  const id = g.snapshot().players[0].active.id;
  assert.deepEqual(currentTypes(g), ['Psychic', 'Darkness']);
  const action = g.view(0).legalActions.find((a) => a.type === 'evolve' && a.cardId === evolution);
  assert(action); command(g, action); settle(g);
  assert.deepEqual(currentTypes(g), ['Fire']);
  assert.equal(g.snapshot().players[0].active.id, id);
  assert.deepEqual(g.snapshot().players[0].active.energy, [energy]);
  assert.deepEqual(restore(g, f).view(0), g.view(0));
  assert.deepEqual(f.catalog.definition('base').mechanics.types, ['Darkness']);
});

test('established duration type changes survive suppression of their original Ability, but expire or clear on Bench/evolution boundaries', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.types = ['Darkness']; defs[0].mechanics.retreatCost = 0;
    defs[0].mechanics.abilities.push(activated('paint', [binding('cn.lasting@1', {
      side: 'own', target: 'self', effect: typeEffect({ types: ['Psychic'], scope: 'all' }),
      duration: 'untilNextOpponentTurnEnd', clearOnBench: true, clearOnEvolution: true,
    })]));
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.suppression@1', {
      effect: { op: 'suppression', channel: 'abilities', scope: 'all' },
    })];
  });
  for (const boundary of ['duration', 'bench', 'evolve']) {
    let target, evolution;
    let g = board(f, (s) => { target = bench(s, 0, 'other').id; evolution = hand(s, 0, 'evolution'); hand(s, 0, 'stadium'); });
    use(g, 'paint'); settle(g);
    assert.deepEqual(currentTypes(g), ['Psychic']);
    g = restore(g, f); play(g, 'stadium');
    assert.deepEqual(currentTypes(g), ['Psychic'], 'fixed duration effect no longer depends on availability of the original Ability');
    if (boundary === 'duration') {
      end(g); assert.deepEqual(currentTypes(g), ['Psychic']); end(g);
      assert.deepEqual(currentTypes(g), ['Darkness']);
    } else if (boundary === 'bench') {
      command(g, { type: 'retreat' }); answer(g, [target]); settle(g);
      assert.deepEqual(g.view(0).players[0].bench[0].effective.types, ['Darkness']);
    } else {
      const action = g.view(0).legalActions.find((a) => a.type === 'evolve' && a.cardId === evolution);
      assert(action); command(g, action); settle(g); assert.deepEqual(currentTypes(g), ['Water']);
    }
    assert.equal(g.snapshot().ongoing.filter((e) => e.effect.op === 'pokemonTypes').length, 0);
    assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  }
});

test('type-dependent removal of its own type source is rejected as a dependency cycle, never resolved by timestamp; failed play is atomic', async () => {
  const f = await fixture((defs) => {
    dual(defs);
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.suppression@1', {
      effect: { op: 'suppression', channel: 'abilities', scope: 'all', type: 'Psychic' },
    })];
  });
  const g = board(f, (s) => hand(s, 0, 'stadium')), before = g.snapshot();
  assert.deepEqual(currentTypes(g), ['Psychic', 'Darkness']);
  const action = g.view(0).legalActions.find((a) => a.type === 'playTrainer' && before.cards[a.cardId].definitionId === 'stadium');
  assert(action);
  assert.throws(() => command(g, action), (e) => typeof e.code === 'string' && /cycle|dependency/.test(e.code));
  assert.deepEqual(g.snapshot(), before);
});

async function triggerFixture(mutate = () => {}) {
  const f = await fixture((defs) => {
    dual(defs, 'base', { activeOnly: true });
    // Water is deliberately REMOVED by the current type replacement: an
    // original-printing match is a decoy, not a second legitimate trigger.
    defs[0].mechanics.types = ['Water'];
    for (const [id, type, count] of [['psychic-now', 'Psychic', 1], ['printed-water', 'Water', 3]]) {
      defs[0].mechanics.abilities.push({
        abilityId: id, name: `测试事件属性${id}`, mode: 'triggered', usage: null,
        trigger: { event: 'energyAttached', subject: 'self', subjectTypes: [type], optional: true,
          choiceOwner: 'source', scope: 'global' },
        effects: [binding('cn.draw@1', { count }, id)], sourceOfTruth: EVIDENCE,
      });
    }
    mutate(defs);
  });
  let energy, target;
  const game = board(f, (s) => { energy = hand(s, 0, 'water'); target = bench(s, 0, 'other').id; });
  return { f, game, energy, target };
}

test('trigger matches occurrence-time effectiveTypes, not printed Water; its saved snapshot survives Bench type change and source departure', async () => {
  let { f, game: g, energy, target } = await triggerFixture();
  const before = g.snapshot(), sourceId = before.players[0].active.id;
  command(g, { type: 'attachEnergy', cardId: energy, pokemonId: sourceId });
  const saved = g.snapshot();
  assert.equal(saved.pending.kind, 'trigger-optional');
  assert.equal(saved.pending.data.unit.abilityId, 'psychic-now');
  const event = saved.pending.data.unit.event;
  assert.deepEqual(event.effectiveTypes, ['Psychic', 'Darkness']);
  assert.equal(event.definitionId, 'base'); assert.equal(event.wasActive, true);
  assert.deepEqual(f.catalog.definition(event.definitionId).mechanics.types, ['Water']);
  const receipt = saved.events.find((e) => e.ruleId === 'pokemon.types' &&
    e.data.kind === 'event-snapshot' && e.data.id === event.id);
  assert(receipt); assert.equal(receipt.visibility, 'public');
  assert.deepEqual(receipt.data.types, ['Psychic', 'Darkness']);
  assert.deepEqual(Object.keys(receipt.data).sort(), ['definitionId', 'id', 'kind', 'owner', 'subjectId', 'types']);
  // The snapshot is authoritative for the old event even if the source now
  // sits on the Bench and activeOnly no longer changes its present type.
  const changed = clone(saved), p = changed.players[0], at = p.bench.findIndex((m) => m.id === target);
  const [replacement] = p.bench.splice(at, 1); p.bench.push(p.active); p.active = replacement;
  g = OfficialGame.restore(changed, { catalog: f.catalog });
  assert.deepEqual(g.view(0).players[0].bench.find((m) => m.id === sourceId).effective.types, ['Water']);
  assert.deepEqual(g.snapshot().pending.data.unit.event.effectiveTypes, ['Psychic', 'Darkness']);
  g = restore(g, f); answer(g, ['perform']); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, before.players[0].hand.length,
    'one attached card and one drawn card; the printed-Water decoy must not draw three');
  assert.equal(g.snapshot().pending, null);
  assert.deepEqual(g.snapshot().rng, before.rng);
  // A second branch retires the actual source Pokémon, rather than only
  // changing its position. Model the complete return using conserved physical
  // cards in a valid restore fixture; never invent a new "current type" for a
  // retired Pokémon or overwrite the old event with printed Water.
  const departed = clone(saved), holder = departed.players[0], outgoing = holder.active;
  const replacementIndex = holder.bench.findIndex((m) => m.id === target);
  [holder.active] = holder.bench.splice(replacementIndex, 1);
  holder.hand.push(...outgoing.stack, ...outgoing.energy, ...outgoing.tools);
  const retired = OfficialGame.restore(departed, { catalog: f.catalog });
  assert.deepEqual(retired.snapshot().pending.data.unit.event.effectiveTypes, ['Psychic', 'Darkness']);
  assert(![retired.snapshot().players[0].active, ...retired.snapshot().players[0].bench]
    .some((m) => m.id === sourceId));
  const returnedHand = retired.snapshot().players[0].hand;
  answer(retired, ['perform']); settle(retired);
  assert.deepEqual(retired.snapshot().players[0].hand, returnedHand,
    'retaining an old event snapshot does not revive the departed source or declare its Ability');
  const retained = retired.snapshot().events.find((e) => e.ruleId === 'pokemon.types' &&
    e.data.kind === 'event-snapshot' && e.data.id === event.id);
  assert.deepEqual(retained, receipt);
  assert.deepEqual(restore(retired, f).snapshot(), retired.snapshot());
});

test('restoring a typed trigger rejects missing/changed effectiveTypes or mismatched occurrence-time snapshot receipts', async () => {
  const { f, game: g, energy } = await triggerFixture();
  command(g, { type: 'attachEnergy', cardId: energy, pokemonId: g.snapshot().players[0].active.id });
  const saved = g.snapshot(), receiptIndex = saved.events.findIndex((e) => e.ruleId === 'pokemon.types' &&
    e.data.kind === 'event-snapshot' && e.data.id === saved.pending.data.unit.event.id);
  assert(receiptIndex >= 0);
  assert.deepEqual(restore(g, f).snapshot(), saved);
  for (const [mutate, code] of [
    [(s) => { delete s.pending.data.unit.event.effectiveTypes; }, null],
    [(s) => { s.pending.data.unit.event.effectiveTypes = ['Water']; }, 'invalid-trigger-types'],
    [(s) => { s.events[receiptIndex].data.types = ['Water']; }, 'invalid-trigger-types'],
    [(s) => { s.events.splice(receiptIndex, 1); }, 'invalid-trigger-types'],
    [(s) => { s.events.push(clone(s.events[receiptIndex])); }, 'invalid-trigger-types'],
  ]) {
    const broken = clone(saved); mutate(broken);
    assert.throws(() => OfficialGame.restore(broken, { catalog: f.catalog }), code ? { code } : undefined);
    assert.deepEqual(g.snapshot(), saved);
  }
});

test('a lasting type change settles illegal Special Energy before the next instruction opens its private choice', async () => {
  const inspectWindow = {
    op: 'inspectDeck', lookTop: 4, selector: { kind: 'any' }, quantity: { kind: 'exact', count: 2 },
    revealSelected: false, remainder: { mode: 'shuffleToBottom' },
  };
  const f = await fixture((defs) => {
    defs[0].mechanics.types = ['Psychic'];
    defs.find((d) => d.definitionId === 'double').mechanics.remainOn = { kind: 'pokemon', types: ['Psychic'] };
    defs[0].mechanics.abilities.push(activated('change-then-inspect', [
      binding('cn.lasting@1', {
        side: 'own', target: 'self', effect: typeEffect({ types: ['Darkness'], scope: 'all' }),
        duration: 'untilNextOpponentTurnEnd', clearOnBench: true, clearOnEvolution: true,
      }),
      binding('cn.inspectDeck@1', inspectWindow),
    ]));
  });
  let energy;
  let g = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'double'); });
  const before = g.snapshot(), sourceId = before.players[0].active.id;
  use(g, 'change-then-inspect');
  assert.equal(g.snapshot().pending.kind, 'effect-target');
  assert(g.snapshot().players[0].active.energy.includes(energy));
  answer(g, [sourceId]);
  const choosing = g.snapshot();
  assert.equal(choosing.pending.kind, 'inspect-deck', 'the next instruction has already opened its own prompt');
  assert.deepEqual(currentTypes(g), ['Darkness']);
  assert.deepEqual(choosing.players[0].active.energy, []);
  assert.equal(choosing.players[0].discard.filter((id) => id === energy).length, 1);
  assert(choosing.events.slice(before.events.length).some((e) =>
    e.ruleId === 'energy.move' && e.data.energyId === energy && e.data.discarded === 'attachment-condition'));
  assert.deepEqual(choosing.rng, before.rng, 'neither the type change nor its next inspection prompt shuffles yet');
  assert.equal(choosing.players[0].flags.energy, before.players[0].flags.energy);
  assert.equal(g.view(1).pending, null);
  g = restore(g, f); answer(g, choosing.pending.options.slice(0, 2)); settle(g);
  assert.equal(g.snapshot().players[0].discard.filter((id) => id === energy).length, 1);
  assert.deepEqual(g.snapshot().players[0].active.energy, []);
});

test('an attack-body pause cannot restore a tampered effectiveTypes in its not-yet-dispatched attack.events', async () => {
  const f = await fixture((defs) => {
    dual(defs, 'other');
    defs[0].mechanics.attacks[0].effects = [binding('cn.inspectDeck@1', {
      op: 'inspectDeck', lookTop: 4, selector: { kind: 'any' }, quantity: { kind: 'exact', count: 2 },
      revealSelected: false, remainder: { mode: 'shuffleToBottom' },
    })];
  });
  let g = board(f, (s) => { otherActive(s); attached(s, 0, s.players[0].active, 'water'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  const saved = g.snapshot();
  assert.equal(saved.pending.kind, 'inspect-deck');
  assert(saved.attack, 'attackDamage events are buffered until the attack body completes');
  const index = saved.attack.events.findIndex((e) => e.kind === 'attackDamage');
  assert(index >= 0);
  assert.deepEqual(saved.attack.events[index].effectiveTypes, ['Psychic', 'Darkness']);
  assert.deepEqual(restore(g, f).snapshot(), saved);
  const broken = clone(saved); broken.attack.events[index].effectiveTypes = ['Water'];
  assert.throws(() => OfficialGame.restore(broken, { catalog: f.catalog }), { code: 'invalid-trigger-types' });
  assert.deepEqual(g.snapshot(), saved, 'rejected restore cannot affect the original pending attack');
  g = restore(g, f); answer(g, saved.pending.options.slice(0, 2)); settle(g);
  assert.equal(g.snapshot().attack, null);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
});

test('E-31 acquisition pause binds the original typed trigger event inside draw-cards completion, rejecting tampered effectiveTypes atomically', async () => {
  let { f, game: g, energy } = await triggerFixture((defs) => {
    defs.find((d) => d.definitionId === 'evolution').mechanics.abilities.push({
      abilityId: 'incoming', name: '测试入手前可选窗口', mode: 'triggered', usage: null,
      trigger: { event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'effect', optional: true, afterUse: 'hand' },
      effects: [binding('cn.deployIncoming@1', {})], sourceOfTruth: EVIDENCE,
    });
  });
  const prepared = g.snapshot(), incoming = put(prepared, 0, 'evolution', 'deck');
  g = OfficialGame.restore(prepared, { catalog: f.catalog });
  command(g, { type: 'attachEnergy', cardId: energy, pokemonId: g.snapshot().players[0].active.id });
  assert.equal(g.snapshot().pending.data.unit.abilityId, 'psychic-now');
  answer(g, ['perform']);
  const saved = g.snapshot();
  assert.equal(saved.pending.kind, 'before-hand-optional');
  assert.equal(g.view(0).pending.acquisition.card.instanceId, incoming);
  const index = saved.queue.findIndex((task) => task.op === 'draw-cards' && task.data.completion?.event);
  assert(index >= 0, 'original trigger context must remain in the suspended draw completion');
  assert.deepEqual(saved.queue[index].data.completion.event.effectiveTypes, ['Psychic', 'Darkness']);
  assert.deepEqual(restore(g, f).snapshot(), saved);
  const broken = clone(saved);
  broken.queue[index].data.completion.event.effectiveTypes = ['Water'];
  assert.throws(() => OfficialGame.restore(broken, { catalog: f.catalog }), { code: 'invalid-trigger-types' });
  assert.deepEqual(g.snapshot(), saved, 'invalid nested restore cannot mutate pending acquisition, RNG, zones or revision');
  g = restore(g, f); answer(g, ['skip']); settle(g);
  assert(g.snapshot().players[0].hand.includes(incoming));
  assert.equal(g.snapshot().pending, null);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
});
