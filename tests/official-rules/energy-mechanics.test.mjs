import test from 'node:test';
import assert from 'node:assert/strict';
import { ENERGY_TYPES } from '../../public/rules/damage.js';
import { resolveEnergyRequirements, meetsEnergyRequirement, resolveEnergyProvision, matchingEnergyUnits,
  attachedEnergySelection, ENERGY_MECHANICS_RULE_IDS } from '../../public/rules/energy-mechanics.js';
import { attachedEnergyPool, energyRecipients, canUseAttachedEnergy } from '../../public/rules/energy-selection.js';
import { validateEnergyRequirementEffect, validateEnergyProvisionEffect, validateEnergyOption,
  validateAttachedEnergyParameters, validateTriggerDescriptor } from '../../public/rules/schema-validators.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertDefinitionShape } from '../../public/rules/card-schema.js';
import { fixture, binding, EVIDENCE, board, start, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const change = (id, extra = {}) => ({ id, sourceOfTruth: EVIDENCE, ...extra });
const req = (extra = {}) => ({ op: 'energyRequirement', action: 'attack', mode: 'adjust', scope: 'self',
  energyType: 'Colorless', amount: 1, ...extra });
const erase = (extra = {}) => ({ op: 'energyRequirement', action: 'attack', mode: 'erase', scope: 'self', ...extra });
const provision = (extra = {}) => ({ op: 'energyProvision', scope: 'own', cardSelf: false,
  selector: { kind: 'energy', category: 'basic', types: ['Water'] }, units: [['Water'], ['Water']], ...extra });
const action = (extra = {}) => ({ op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' },
  providedTypes: null, measure: 'units', quantity: { kind: 'exact', count: 1 }, chooser: 'source', ...extra });
const move = (extra = {}) => action({ op: 'moveEnergy', recipient: { position: 'bench', selector: { kind: 'pokemon' } },
  distribution: 'singleRecipient', ...extra });
const ability = (id, effects, mode = 'activated') => ({
  abilityId: id, name: `测试能量${id}`, mode, usage: mode === 'continuous' ? null :
    { period: 'unlimited', scope: 'pokemon', key: id, limit: null }, effects, sourceOfTruth: EVIDENCE,
});
const use = (g, id = 'energy') => command(g, { type: 'useAbility', abilityId: id, pokemonId: g.snapshot().players[0].active.id });
const has = (g, type) => g.view(0).legalActions.some((a) => a.type === type);
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const effective = (g) => g.view(0).players[0].active.effective;
const attachTool = (s, owner, m, definitionId = 'tool') => {
  const id = hand(s, owner, definitionId); s.players[owner].hand.pop(); m.tools.push(id); return id;
};
const setStadium = (s) => {
  const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id; return id;
};
const descriptor = (event, extra = {}) => ({
  event, subject: 'own', optional: false, choiceOwner: 'source', scope: 'subject', ...extra,
});
const reviewed = (extra) => ({ rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
  validateParameters: (p) => Object.keys(p).length === 0, ...extra });

test('D-09..13 aggregate typed increases/decreases before clamping; erasure wins and E-32 is a literal alternate route', () => {
  for (const id of ENERGY_MECHANICS_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  const adjustments = [
    change('less', { energyType: 'Water', amount: -4 }), change('more', { energyType: 'Water', amount: 2 }),
    change('color', { energyType: 'Colorless', amount: 2 }), change('other', { energyType: 'Fire', amount: 1 }),
  ];
  const input = { printed: ['Water', 'Colorless'], adjustments,
    alternatives: [change('literal', { cost: ['Lightning'] })] };
  const before = structuredClone(input), routes = resolveEnergyRequirements(input);
  assert.equal(routes[0].counts.Water, 0); assert.equal(routes[0].counts.Colorless, 3);
  assert.equal(routes[0].counts.Fire, 1); assert.equal(routes[0].total, 4);
  assert.equal(routes[1].total, 1); assert.equal(routes[1].counts.Lightning, 1);
  assert(!meetsEnergyRequirement([['Water'], ['Fire'], ['Water']], routes[0]));
  assert(meetsEnergyRequirement([['Lightning']], routes[1]));
  assert(!meetsEnergyRequirement([['Water']], routes[1]));
  assert(routes.every((r) => r.trace[0].sourceOfTruth.length));
  assert.deepEqual(resolveEnergyRequirements({ ...input, adjustments: [...adjustments].reverse() }).map((r) => r.counts),
    routes.map((r) => r.counts), 'Input order cannot change effective requirements; evidence retains its original order.');
  assert.deepEqual(input, before);
});

test('requirements reject unsafe counts, malformed attributes, duplicate/unsourced changes and corrupt totals', () => {
  const erased = resolveEnergyRequirements({ printed: { Water: 1 }, adjustments: [change('a', { energyType: 'Water', amount: 4 })],
    erasures: [change('erase')], alternatives: [change('still', { cost: ['Fire'] })] });
  assert.equal(erased[0].total, 0); assert.equal(erased[1].total, 1);
  assert(meetsEnergyRequirement([], erased[0]));
  for (const printed of [null, 'Water', { Unknown: 1 }, { Fire: -1 }, { Water: 0.5 }, ['Unknown']])
    assert.throws(() => resolveEnergyRequirements({ printed }), TypeError);
  for (const changes of [
    [change('a'), change('a')], [{ id: 'a', sourceOfTruth: [] }], [{ sourceOfTruth: EVIDENCE }],
    [change('a', { energyType: 'Fake', amount: 1 })], [change('a', { energyType: 'Water', amount: 1.5 })],
  ]) assert.throws(() => resolveEnergyRequirements({ printed: [], adjustments: changes }), TypeError);
  assert.throws(() => resolveEnergyRequirements({ printed: { Water: Number.MAX_SAFE_INTEGER },
    adjustments: [change('a', { energyType: 'Water', amount: 1 })] }), RangeError);
  assert.throws(() => resolveEnergyRequirements({ printed: { Water: Number.MAX_SAFE_INTEGER, Fire: 1 } }), RangeError);
  assert.throws(() => meetsEnergyRequirement([], { counts: {}, total: 1 }), /Corrupt/);
  assert(!meetsEnergyRequirement([], { counts: { Water: Number.MAX_SAFE_INTEGER }, total: Number.MAX_SAFE_INTEGER }));
});

test('E-39 provision replaces rather than multiplies; equal unit/type multisets agree and conflicting replacements fail closed', () => {
  const base = [['Water']], replacements = [
    change('a', { units: [['Fire', 'Water'], ['Grass']] }), change('b', { units: [['Grass'], ['Water', 'Fire']] }),
  ];
  const copy = structuredClone(replacements), result = resolveEnergyProvision(base, replacements);
  assert.deepEqual(result.units, [['Fire', 'Water'], ['Grass']]);
  assert.deepEqual(replacements, copy); assert.deepEqual(base, [['Water']]);
  assert.deepEqual(resolveEnergyProvision(base).units, base);
  assert.throws(() => resolveEnergyProvision(base, [change('a', { units: [['Water']] }), change('b', { units: [['Water'], ['Water']] })]),
    (e) => e.code === 'unresolved-energy-provision');
  for (const units of [null, [[]], [['Water', 'Water']], [['Fake']]])
    assert.throws(() => resolveEnergyProvision(units), TypeError);
  assert.equal(matchingEnergyUnits([ENERGY_TYPES], ['Fire', 'Water']), 1);
  assert.equal(matchingEnergyUnits([['Water'], ['Fire']], null), 2);
  assert.equal(matchingEnergyUnits([['Water']], ['Colorless']), 0,
    'Paying a Colorless requirement is different from actually providing Colorless Energy.');
  for (const types of [[], ['Fake'], ['Water', 'Water'], 'Water', undefined])
    assert.throws(() => matchingEnergyUnits(base, types), TypeError);
});

test('C-01/C-10 quantities distinguish Energy units, physical cards, indivisible excess and still-unsourced redundant excess', () => {
  const cards = [
    { instanceId: 'double', units: [['Colorless'], ['Colorless']] },
    { instanceId: 'water', units: [['Water']] }, { instanceId: 'zero', units: [] },
    { instanceId: 'aurora', units: [ENERGY_TYPES] },
  ];
  const valid = (extra, selected, pool = cards) => attachedEnergySelection(pool, action(extra), selected);
  assert(valid({}, ['double']).valid, 'One indivisible two-unit card can discard one Energy.');
  assert(valid({ quantity: { kind: 'exact', count: 2 } }, ['double']).valid);
  assert(!valid({ measure: 'cards', quantity: { kind: 'exact', count: 2 } }, ['double']).valid);
  assert(valid({ measure: 'cards', quantity: { kind: 'exact', count: 2 } }, ['double', 'zero']).valid);
  assert(valid({ quantity: { kind: 'exact', count: 9 } }, ['double', 'water', 'aurora']).valid, 'Perform as many as possible.');
  assert(valid({ quantity: { kind: 'upTo', count: 1 } }, ['double']).valid);
  assert(!valid({ quantity: { kind: 'upTo', count: 1 } }, []).valid);
  assert(valid({ quantity: { kind: 'any' } }, []).valid);
  assert(valid({ quantity: { kind: 'any' } }, ['double', 'water']).valid);
  assert(!valid({ quantity: { kind: 'all' } }, ['double']).valid);
  assert(valid({ quantity: { kind: 'all' } }, ['double', 'water', 'aurora']).valid);
  assert(valid({ providedTypes: ['Fire', 'Water'], quantity: { kind: 'all' } }, ['water', 'aurora']).valid);
  assert(!valid({ providedTypes: ['Fire'] }, ['water']).valid);
  assert.deepEqual(valid({}, ['double', 'water']).unsupported, true, 'Not a fabricated CN illegality ruling.');
  const singleUnits = [{ instanceId: 'a', units: [['Water']] }, { instanceId: 'b', units: [['Water']] }];
  assert(!valid({}, ['a', 'b'], singleUnits).valid);
  assert(!valid({}, ['a', 'b'], singleUnits).unsupported, 'Two one-unit cards for exactly one unit is ordinary excessive quantity.');
  for (const selected of [null, ['missing'], ['water', 'water']]) assert(!valid({}, selected).valid);
  for (const pool of [null, [null], [{ instanceId: '' }], [cards[0], cards[0]]])
    assert.throws(() => valid({}, [], pool), TypeError);
  assert.throws(() => valid({ measure: 'count' }, []), TypeError);
  assert(valid({ quantity: { kind: 'exact', count: 1 } }, [], []).valid);
});

test('Energy schemas strictly separate requirement/provision/selection/retention and transfer-trigger meanings', () => {
  assert.deepEqual(createCoreHandlers().get('cn.energyOptions@1').execute({}, { cost: [] }), []);
  for (const good of [req(), erase(), erase({ action: 'retreat' }), req({ attackIds: ['attack'], group: 'g', amount: -1 })])
    assert(validateEnergyRequirementEffect(good));
  for (const bad of [req({ action: 'retreat' }), erase({ amount: 1 }), req({ energyType: 'Fake' }), req({ amount: null }),
    erase({ action: 'retreat', attackIds: ['a'] }), req({ currentCost: 0 })]) assert(!validateEnergyRequirementEffect(bad));
  assert(validateEnergyProvisionEffect(provision()));
  for (const bad of [provision({ units: [[]] }), provision({ selector: { kind: 'pokemon' } }), provision({ multiplier: 2 })])
    assert(!validateEnergyProvisionEffect(bad));
  assert(validateEnergyOption({ cost: [] })); assert(!validateEnergyOption({ cost: ['Water'], increase: 1 }));
  for (const good of [action(), move(), move({ distribution: 'separateRecipients', quantity: { kind: 'all' } })])
    assert(validateAttachedEnergyParameters(good));
  for (const bad of [action({ recipient: { position: 'any', selector: { kind: 'pokemon' } } }), move({ recipient: null }),
    action({ selector: { kind: 'any' } }), action({ providedTypes: [] }), action({ measure: 'energy' })])
    assert(!validateAttachedEnergyParameters(bad));
  assert(validateTriggerDescriptor(descriptor('energyAttached', { includeTransfers: true, origin: 'field' })));
  assert(validateTriggerDescriptor(descriptor('energyMoved')));
  assert(!validateTriggerDescriptor(descriptor('energyMoved', { includeTransfers: true })));
});

test('effective attack requirements aggregate live and timed changes without rewriting or spending printed Energy', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].cost = ['Water', 'Colorless'];
    defs[0].mechanics.effects = [
      binding('cn.energyRequirement@1', { effect: req({ amount: -2 }) }, 'less'),
      binding('cn.energyRequirement@1', { effect: req({ amount: 1 }) }, 'more'),
    ];
    defs[0].mechanics.abilities = [ability('energy', [binding('cn.lasting@1', {
      side: 'own', target: 'self', effect: req({ scope: 'all', energyType: 'Water', amount: -1 }),
      duration: 'untilNextOwnTurnEnd', clearOnBench: true, clearOnEvolution: true,
    })])];
  });
  let energy;
  const g = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'double'); });
  const printed = structuredClone(f.catalog.definition('base'));
  assert.equal(effective(g).attackRequirements[0].routes[0].total, 1); assert(!has(g, 'attack'));
  use(g); settle(g);
  assert.equal(effective(g).attackRequirements[0].routes[0].total, 0); assert(has(g, 'attack'));
  const r = restore(g, f); assert.deepEqual(r.view(0), g.view(0));
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  assert(g.snapshot().events.some((e) => e.ruleId === 'energy.requirement'));
  assert.deepEqual(f.catalog.definition('base'), printed);
  assert.deepEqual(g.snapshot().players[0].active.energy, [energy], 'Attack requirements do not spend attached Energy.');
});

test('D-13 erasure overrides increases but never overrides action locks or Sleep', async () => {
  const f = await fixture((defs) => defs[0].mechanics.effects = [
    binding('cn.energyRequirement@1', { effect: erase() }),
    binding('cn.energyRequirement@1', { effect: req({ amount: 3 }) }, 'more'),
    binding('cn.energyRequirement@1', { effect: erase({ action: 'retreat' }) }, 'retreat-erase'),
    binding('cn.modifier@1', { field: 'retreat', amount: 4, scope: 'self' }),
  ]);
  const g = board(f, (s) => bench(s, 0, 'other'));
  assert.equal(effective(g).retreatCost, 0); assert(has(g, 'attack')); assert(has(g, 'retreat'));
  command(g, { type: 'retreat' }); settle(g);
  assert.equal(g.snapshot().players[0].flags.retreat, true); assert.equal(g.snapshot().players[0].discard.length, 0);
  const sleeping = board(f, (s) => { bench(s, 0, 'other'); s.players[0].active.conditions.rotation = 'asleep'; });
  assert(!has(sleeping, 'attack')); assert(!has(sleeping, 'retreat'));
  const locked = await fixture((defs) => defs[0].mechanics.effects = [
    binding('cn.energyRequirement@1', { effect: erase() }),
    binding('cn.restriction@1', { effect: { op: 'restriction', scope: 'self', actions: ['attack'] } }),
  ]);
  assert(!has(board(locked), 'attack'));
});

test('E-32 conditional literal cost is independent of ordinary changes, including on a Tool-granted attack source', async () => {
  const option = reviewed({ timing: 'energyOptions', operations: [], execute: () => [],
    energyOptions: (ctx) => {
      const m = ctx.state.players[ctx.source.owner].active;
      return m.counters > 0 || m.facts.movedActiveTurn === ctx.state.turn ? { cost: ['Water'] } : null;
    } });
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].cost = ['Water', 'Colorless', 'Colorless'];
    defs[0].mechanics.attacks[0].effects = [binding('fixture:conditional-energy', {})];
    defs[0].mechanics.effects = [binding('cn.energyRequirement@1', { effect: req({ amount: 2 }) })];
    const tool = defs.find((d) => d.definitionId === 'tool');
    tool.mechanics.grantedAttacks = [{
      ...structuredClone(defs[0].mechanics.attacks[0]), attackId: 'tool:attack',
      effects: [binding('fixture:tool-energy', {})],
    }];
  }, new Map([
    ['fixture:conditional-energy', option],
    ['fixture:tool-energy', reviewed({ timing: 'energyOptions', operations: [], execute: () => [],
      energyOptions: (ctx) => {
        assert.equal(ctx.definitions[ctx.state.cards[ctx.source.instanceId].definitionId].mechanics.category, 'tool');
        return { cost: [] };
      } })],
  ]));
  for (const condition of ['none', 'damage', 'moved']) {
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water');
      if (condition === 'damage') s.players[0].active.counters = 1;
      if (condition === 'moved') s.players[0].active.facts.movedActiveTurn = s.turn;
    });
    assert.equal(has(g, 'attack'), condition !== 'none');
    assert.equal(effective(g).attackRequirements[0].routes[0].total, 5);
    assert.equal(effective(g).attackRequirements[0].routes.length, condition === 'none' ? 1 : 2);
  }
  const g = board(f, (s) => attachTool(s, 0, s.players[0].active));
  assert(g.view(0).legalActions.some((a) => a.attackId === 'tool:attack'));
  assert.equal(effective(g).attackRequirements[1].routes[1].total, 0);
  command(g, { type: 'attack', attackId: 'tool:attack' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 5);
  const fixed = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('cn.energyOptions@1', { cost: [] })]);
  assert(has(board(fixed), 'attack'), 'Core literal option executes the same route contract.');
});

test('E-39 Basic Energy replacement is live, nonstacking and removed by Ability suppression; printed units remain immutable', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('totem', [binding('cn.energyProvision@1', { effect: provision() })], 'continuous')];
    defs[0].mechanics.attacks[0].cost = ['Water', 'Water'];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.suppression@1', {
      effect: { op: 'suppression', channel: 'abilities', scope: 'all' },
    })];
  });
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'base'); });
  assert(has(g, 'attack')); assert.equal(effective(g).energies[0].units.length, 2);
  assert.equal(effective(g).energies[0].trace[0].replacements.length, 2);
  assert.deepEqual(f.catalog.definition('water').mechanics.baseUnits, [['Water']]);
  const s = g.snapshot(); setStadium(s);
  const suppressed = OfficialGame.restore(s, { catalog: f.catalog });
  assert(!has(suppressed, 'attack')); assert.equal(effective(suppressed).energies[0].units.length, 1);
  assert.deepEqual(restore(g, f).view(0), g.view(0));
});

test('attached Special Energy, Tools and Stadiums provide separate reviewed replacement sources and predicates', async () => {
  for (const origin of ['energy', 'tool', 'stadium']) {
    const f = await fixture((defs) => {
      const d = defs.find((d) => d.definitionId === { energy: 'double', tool: 'tool', stadium: 'stadium' }[origin]);
      d.mechanics.effects = [binding('cn.energyProvision@1', { effect: provision({
        scope: origin === 'stadium' ? 'all' : 'self', selector: { kind: 'energy', category: origin === 'energy' ? 'special' : 'basic' },
        cardSelf: origin === 'energy', units: [['Water'], ['Water']], type: 'Water', activeOnly: true,
        ...(origin !== 'stadium' ? { sourceActive: true } : {}),
      }) })];
      defs[0].mechanics.attacks[0].cost = ['Water', 'Water'];
    });
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, origin === 'energy' ? 'double' : 'water');
      if (origin === 'tool') attachTool(s, 0, s.players[0].active);
      if (origin === 'stadium') setStadium(s);
    });
    assert(has(g, 'attack'), origin); assert.equal(effective(g).energies[0].units.length, 2);
  }
});

test('setup never evaluates hidden Energy-provision or attack-option hooks to derive the other player’s prepared information', async () => {
  let provisionCalls = 0, optionCalls = 0;
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('totem', [binding('fixture:setup-provision', {})], 'continuous')];
    defs[0].mechanics.attacks[0].effects = [binding('fixture:setup-option', {})];
  }, new Map([
    ['fixture:setup-provision', reviewed({ timing: 'energyProvision', operations: ['energyProvision'],
      execute: (ctx) => { assert.notEqual(ctx.state.phase, 'setup'); provisionCalls++; return [provision()]; } })],
    ['fixture:setup-option', reviewed({ timing: 'energyOptions', operations: [], execute: () => [],
      energyOptions: (ctx) => { assert.notEqual(ctx.state.phase, 'setup'); optionCalls++; return { cost: [] }; } })],
  ]));
  const g = new OfficialGame({ ruleset: f.ruleset, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed });
  while (!g.snapshot().players[0].active) answer(g, g.snapshot().pending.options.slice(0, g.snapshot().pending.minimum));
  assert.equal(g.snapshot().phase, 'setup');
  assert.equal(effective(g).attackRequirements[0].routes.length, 1);
  assert.equal(provisionCalls, 0); assert.equal(optionCalls, 0);
  for (const m of [g.view(0).players[1].active, ...g.view(0).players[1].bench].filter(Boolean))
    assert.deepEqual(m, { faceDown: true });
  settle(g); assert.equal(g.snapshot().phase, 'main');
  assert(provisionCalls > 0); assert(optionCalls > 0);
});

test('Retreat pays with effective provision, discards the whole selected card, and never mutates the Basic Energy definition', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.retreatCost = 2;
    defs[0].mechanics.abilities = [ability('totem', [binding('cn.energyProvision@1', { effect: provision() })], 'continuous')];
  });
  let energy, target;
  const g = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'water'); target = bench(s, 0, 'other').id; });
  assert(has(g, 'retreat')); command(g, { type: 'retreat' });
  assert.equal(g.snapshot().pending.kind, 'retreat-energy'); answer(g, [energy]);
  assert.deepEqual(restore(g, f).view(0), g.view(0)); answer(g, [target]); settle(g);
  assert.equal(g.snapshot().players[0].active.id, target); assert(g.snapshot().players[0].discard.includes(energy));
  assert.equal(f.catalog.definition('water').mechanics.baseUnits.length, 1);
});

test('nonstacking requirement groups agree only on identical semantics; attack identities and type filters do not bleed into another attack', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks.push({ ...structuredClone(defs[0].mechanics.attacks[0]), attackId: 'base:second', effects: [] });
    defs[0].mechanics.effects = [
      binding('cn.energyRequirement@1', { effect: req({ group: 'one', attackIds: ['base:strike'] }) }, 'a'),
      binding('cn.energyRequirement@1', { effect: req({ group: 'one', attackIds: ['base:strike'] }) }, 'b'),
      binding('cn.energyRequirement@1', { effect: req({ amount: 9, type: 'Fire' }) }, 'type'),
    ];
  });
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  assert.deepEqual(effective(g).attackRequirements.map((a) => a.routes[0].total), [2, 1]);
  assert(!g.view(0).legalActions.some((a) => a.attackId === 'base:strike'));
  assert(g.view(0).legalActions.some((a) => a.attackId === 'base:second'));
  const conflict = await fixture((defs) => defs[0].mechanics.effects = [
    binding('cn.energyRequirement@1', { effect: req({ group: 'one' }) }, 'a'),
    binding('cn.energyRequirement@1', { effect: req({ group: 'one', amount: 2 }) }, 'b'),
  ]);
  assert.throws(() => board(conflict), (e) => e.code === 'unsupported-modifier-conflict');
});

test('C-01 discards a whole multi-unit card for one or two units; printed data and turn attachment quota do not change', async () => {
  for (const count of [1, 2]) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [
      ability('energy', [binding('cn.attachedEnergy@1', action({ quantity: { kind: 'exact', count } }))]),
    ]);
    let energy;
    const g = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'double'); });
    use(g); assert.equal(g.snapshot().pending.kind, 'attached-energy');
    assert.deepEqual(g.view(0).pending.energy[0].units, [['Colorless'], ['Colorless']]);
    assert.deepEqual(restore(g, f).view(0), g.view(0));
    answer(g, [energy]); settle(g);
    assert.deepEqual(g.snapshot().players[0].active.energy, []); assert(g.snapshot().players[0].discard.includes(energy));
    assert.equal(g.snapshot().players[0].flags.energy, false); assert(!has(g, 'useAbility'));
    assert.equal(f.catalog.definition('double').mechanics.baseUnits.length, 2);
  }
});

test('D-08 all-attribute Energy is included in every matching discard-all filter, counted once and not treated as Basic Energy', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'double').mechanics.baseUnits = [ENERGY_TYPES];
    defs[0].mechanics.abilities = [
      ability('energy', [binding('cn.attachedEnergy@1', action({ providedTypes: ['Fire', 'Water'], quantity: { kind: 'all' } }))]),
      ability('basic', [binding('cn.attachedEnergy@1', action({ selector: { kind: 'energy', category: 'basic' } }), 'basic')]),
    ];
  });
  let aurora, water;
  const g = board(f, (s) => { aurora = attached(s, 0, s.players[0].active, 'double'); water = attached(s, 0, s.players[0].active, 'water'); });
  use(g);
  assert.equal(g.snapshot().pending.minimum, 2);
  const before = g.snapshot(); assert.throws(() => answer(g, [water]), /quantity/); assert.deepEqual(g.snapshot(), before);
  answer(g, [aurora, water]); settle(g);
  assert(g.snapshot().players[0].discard.includes(aurora));
  const specialOnly = board(f, (s) => attached(s, 0, s.players[0].active, 'double'));
  assert(!specialOnly.view(0).legalActions.some((a) => a.abilityId === 'basic'));
});

test('C-10 transfer keeps holder ownership, chooses an eligible different recipient, and restores without moving cards early', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('energy', [binding('cn.attachedEnergy@1', move())])]);
  let energy, target;
  const g = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'double'); target = bench(s, 0, 'other').id; });
  use(g); answer(g, [energy]);
  assert.equal(g.snapshot().pending.kind, 'energy-destination');
  assert(g.snapshot().players[0].active.energy.includes(energy), 'Choice is a plan, not an early destructive move.');
  const r = restore(g, f); assert.deepEqual(r.view(0), g.view(0));
  for (const h of [g, r]) { answer(h, [target]); settle(h); }
  assert.deepEqual(r.snapshot(), g.snapshot());
  assert.deepEqual(g.snapshot().players[0].bench[0].energy, [energy]); assert.equal(g.snapshot().cards[energy].owner, 0);
  assert.equal(g.snapshot().players[0].flags.energy, false); assert(!has(g, 'useAbility'));
  assert(g.snapshot().events.some((e) => e.ruleId === 'energy.move' && e.data.to === target));
  assert(!has(board(f, (s) => attached(s, 0, s.players[0].active, 'double')), 'useAbility'));
});

test('separate-recipient transfer collects all choices before applying the batch; selectors and physical-card counts remain exact', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('energy', [binding('cn.attachedEnergy@1',
    move({ distribution: 'separateRecipients', measure: 'cards', quantity: { kind: 'exact', count: 2 } }))])]);
  let first, second, target1, target2;
  const g = board(f, (s) => {
    first = attached(s, 0, s.players[0].active, 'double'); second = attached(s, 0, s.players[0].active, 'water');
    target1 = bench(s, 0, 'other').id; target2 = bench(s, 0, 'other').id;
  });
  use(g); answer(g, [first, second]); answer(g, [target1]);
  assert.equal(g.snapshot().players[0].active.energy.length, 2);
  assert.deepEqual(g.snapshot().players[0].bench.map((m) => m.energy), [[], []]);
  const r = restore(g, f); answer(g, [target2]); answer(r, [target2]); settle(g); settle(r);
  assert.deepEqual(r.snapshot(), g.snapshot()); assert.deepEqual(g.snapshot().players[0].bench.map((m) => m.energy), [[first], [second]]);
});

test('opponent holder can choose its own discarded Energy; the effect source cannot receive an opponent transfer', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('energy', [
    binding('cn.attachedEnergy@1', move({ side: 'opponent', from: 'active', chooser: 'holder' })),
  ])]);
  let energy, target;
  const g = board(f, (s) => { energy = attached(s, 1, s.players[1].active, 'water'); target = bench(s, 1, 'other').id; });
  use(g); assert.equal(g.snapshot().pending.player, 1); assert.equal(g.view(0).pending, null);
  answer(g, [energy]); assert.equal(g.snapshot().pending.player, 1);
  assert(!g.snapshot().pending.options.includes(g.snapshot().players[0].active.id));
  answer(g, [target]); settle(g); assert.deepEqual(g.snapshot().players[1].bench[0].energy, [energy]);
  assert.equal(g.snapshot().players[0].discard.includes(energy), false);
});

test('effect protection on either transfer endpoint blocks movement, not target selection; blocked first effect does not unlock then', async () => {
  for (const endpoint of ['origin', 'target']) {
    const transfer = move({ side: 'opponent', from: 'active' });
    const f = await fixture((defs) => {
      defs[0].mechanics.abilities = [ability('energy', [binding('fixture:transfer-then', {})])];
      defs.find((d) => d.definitionId === (endpoint === 'origin' ? 'base' : 'other')).mechanics.effects.push(
        binding('cn.protection@1', { effect: { op: 'protection', useRule: 'ordinary', scope: 'self', from: 'opponent', channel: 'effects', categories: ['ability'] } }));
    }, new Map([['fixture:transfer-then', reviewed({ operations: ['then', 'moveEnergy', 'heal'],
      canUse: (ctx) => canUseAttachedEnergy(ctx, transfer), execute: () => [
        { op: 'then', first: transfer, next: { op: 'heal', side: 'own', target: 'self', count: 1 } },
      ] })]]));
    let energy, target;
    const g = board(f, (s) => {
      energy = attached(s, 1, s.players[1].active, 'water'); target = bench(s, 1, 'other').id; s.players[0].active.counters = 2;
    });
    assert(has(g, 'useAbility')); use(g); answer(g, [energy]); answer(g, [target]); settle(g);
    assert(g.snapshot().players[1].active.energy.includes(energy)); assert.equal(g.snapshot().players[1].bench[0].energy.length, 0);
    assert.equal(g.snapshot().players[0].active.counters, 2);
    assert(g.snapshot().events.some((e) => e.ruleId === 'effects.protection'));
  }
});

test('Energy movement determines the entire chosen batch before removals can change a conditional protection source', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('energy', [binding('cn.attachedEnergy@1', move({
      measure: 'cards', quantity: { kind: 'all' },
    }))])];
    defs.find((d) => d.definitionId === 'double').mechanics.effects = [binding('fixture:conditional-energy-shield', {})];
  }, new Map([['fixture:conditional-energy-shield', reviewed({ timing: 'continuous', operations: ['protection'],
    execute: (ctx) => {
      const m = [ctx.state.players[ctx.source.owner].active, ...ctx.state.players[ctx.source.owner].bench].find((m) => m.id === ctx.source.pokemonId);
      return m.energy.length === 1 ? [{ op: 'protection', useRule: 'ordinary', scope: 'self', from: 'own', channel: 'effects', categories: ['ability'] }] : [];
    } })]]));
  let water, special, target;
  const g = board(f, (s) => {
    water = attached(s, 0, s.players[0].active, 'water'); special = attached(s, 0, s.players[0].active, 'double');
    target = bench(s, 0, 'other').id;
  });
  use(g); answer(g, [water, special]); answer(g, [target]); settle(g);
  assert.deepEqual(g.snapshot().players[0].active.energy, []);
  assert.deepEqual(g.snapshot().players[0].bench[0].energy, [water, special],
    'The second card is not blocked by a protection that existed only in an intermediate, partially moved batch.');
});

test('C-10 Special Energy may move to a forbidden holder and is then discarded; hand-only attachment eligibility remains separate', async () => {
  const f = await fixture((defs) => {
    const e = defs.find((d) => d.definitionId === 'double').mechanics;
    e.handAttachTo = { kind: 'pokemon', nameKeys: ['base'] };
    e.remainOn = { kind: 'pokemon', nameKeys: ['base'] };
    defs[0].mechanics.abilities = [ability('energy', [binding('cn.attachedEnergy@1', move())])];
  });
  let energy, target;
  const g = board(f, (s) => { energy = hand(s, 0, 'double'); target = bench(s, 0, 'other').id; });
  assert(!g.view(0).legalActions.some((a) => a.type === 'attachEnergy' && a.cardId === energy && a.pokemonId === target));
  command(g, { type: 'attachEnergy', cardId: energy, pokemonId: g.snapshot().players[0].active.id });
  use(g); answer(g, [energy]); assert(g.snapshot().pending.options.includes(target)); answer(g, [target]); settle(g);
  assert(g.snapshot().players[0].discard.includes(energy)); assert.equal(g.snapshot().players[0].bench[0].energy.length, 0);
  assert(g.snapshot().events.some((e) => e.data.discarded === 'attachment-condition'));
  const evolved = board(f, (s) => { attached(s, 0, s.players[0].active, 'double'); hand(s, 0, 'evolution'); });
  command(evolved, evolved.view(0).legalActions.find((a) => a.type === 'evolve')); settle(evolved);
  assert.equal(evolved.snapshot().players[0].active.energy.length, 0);
  for (const key of ['handAttachTo', 'remainOn']) {
    const d = structuredClone(f.catalog.definition('water')); d.mechanics[key] = { kind: 'pokemon' };
    assert.throws(() => assertDefinitionShape(d), /Invalid normalized/);
  }
});

test('before-hand Energy placement ignores hand-only eligibility but still enforces retention, without consuming ordinary attachment', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('draw', [binding('cn.draw@1', { count: 1 })])];
    const e = defs.find((d) => d.definitionId === 'double').mechanics;
    e.handAttachTo = { kind: 'pokemon', nameKeys: ['base'] }; e.remainOn = { kind: 'pokemon', nameKeys: ['base'] };
    e.effects = [{ ...binding('cn.attachIncoming@1', { target: 'bench' }), trigger: {
      event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'effect', optional: false, afterUse: 'hand',
    } }];
  });
  let energy, target;
  const g = board(f, (s) => {
    target = bench(s, 0, 'other').id; energy = hand(s, 0, 'double'); s.players[0].hand.pop(); s.players[0].deck.push(energy);
  });
  use(g, 'draw'); assert.equal(g.snapshot().pending.kind, 'incoming-energy-recipient');
  answer(g, [target]); settle(g);
  assert.equal(g.snapshot().players[0].bench[0].energy.length, 0); assert(g.snapshot().players[0].discard.includes(energy));
  assert(!g.snapshot().players[0].hand.includes(energy)); assert.equal(g.snapshot().players[0].flags.energy, false);
});

test('transfer reactions are explicit: neither ordinary attachment nor hand-only attachment text is accidentally fired', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('energy', [binding('cn.attachedEnergy@1', move())])];
    const m = defs.find((d) => d.definitionId === 'other').mechanics;
    m.effects = [
      { ...binding('cn.counters@1', { side: 'own', target: 'event', count: 1 }, 'moved'), trigger: descriptor('energyMoved') },
      { ...binding('cn.counters@1', { side: 'own', target: 'event', count: 2 }, 'inclusive'), trigger: descriptor('energyAttached', { includeTransfers: true }) },
      { ...binding('cn.counters@1', { side: 'own', target: 'event', count: 4 }, 'ordinary'), trigger: descriptor('energyAttached') },
      { ...binding('cn.counters@1', { side: 'own', target: 'event', count: 5 }, 'hand'), trigger: descriptor('energyAttached', { origin: 'hand', includeTransfers: true }) },
    ];
  });
  let energy, target;
  const g = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'double'); target = bench(s, 0, 'other').id; });
  use(g); answer(g, [energy]); answer(g, [target]); settle(g);
  assert.equal(g.snapshot().players[0].bench[0].counters, 3);
  const events = g.snapshot().events.filter((e) => e.ruleId === 'energy.move');
  assert(events.length);
});

test('invalid or unresolved Energy quantities reject atomically; any-number zero and an absent attack-effect pool are genuine no-ops', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('energy', [binding('cn.attachedEnergy@1', action({ quantity: { kind: 'exact', count: 2 } }))])];
    defs[0].mechanics.attacks[0].cost = [];
    defs[0].mechanics.attacks[0].effects = [binding('cn.attachedEnergy@1', action({ quantity: { kind: 'any' } }), 'attack')];
  });
  let double, water;
  const g = board(f, (s) => { double = attached(s, 0, s.players[0].active, 'double'); water = attached(s, 0, s.players[0].active, 'water'); });
  use(g); const before = g.snapshot();
  assert.throws(() => answer(g, [water]), (e) => e.code === 'invalid-energy-selection'); assert.deepEqual(g.snapshot(), before);
  assert.throws(() => answer(g, [double, water]), (e) => e.code === 'unresolved-energy-quantity'); assert.deepEqual(g.snapshot(), before);
  answer(g, [double]); settle(g);
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, []); settle(g);
  assert(g.snapshot().players[0].active.energy.includes(water));
  const noPool = board(f); command(noPool, { type: 'attack', attackId: 'base:strike' }); settle(noPool);
  assert.equal(noPool.snapshot().players[1].active.counters, 2);
});

test('unit prompts do not silently translate a missing multi-card over-selection ruling into a physical-card count limit', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('energy', [binding('cn.attachedEnergy@1', action())])]);
  let double, water;
  const g = board(f, (s) => { double = attached(s, 0, s.players[0].active, 'double'); water = attached(s, 0, s.players[0].active, 'water'); });
  use(g); assert.equal(g.snapshot().pending.maximum, 2);
  const before = g.snapshot();
  assert.throws(() => answer(g, [double, water]), (e) => e.code === 'unresolved-energy-quantity');
  assert.deepEqual(g.snapshot(), before);
  answer(g, [double]); settle(g);
});

test('saved Energy selection plans reject tampering with origins, duplicate cards, foreign recipients and distribution cursors', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('energy', [binding('cn.attachedEnergy@1',
    move({ measure: 'cards', quantity: { kind: 'exact', count: 2 }, distribution: 'separateRecipients' }))])]);
  let a, b, target;
  const g = board(f, (s) => {
    a = attached(s, 0, s.players[0].active, 'water'); b = attached(s, 0, s.players[0].active, 'double'); target = bench(s, 0, 'other').id;
  });
  use(g); answer(g, [a, b]); answer(g, [target]);
  const tamper = (mutate) => { const s = g.snapshot(); mutate(s.pending.data, s); assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /Energy|Transfer|Saved|Snapshot|recipients|Corrupt/); };
  tamper((d) => { d.energyPlan.chosen[0].originId = target; });
  tamper((d) => { d.energyPlan.chosen[1] = { ...d.energyPlan.chosen[0] }; });
  tamper((d) => { d.energyPlan.assignments.push({ ...d.energyPlan.assignments[0] }); });
  tamper((d) => { d.energyPlan.assignments[0].instanceId = 'missing'; });
  tamper((d, s) => { d.energyPlan.assignments[0].targetId = s.players[1].active.id; });
  tamper((d) => { d.stage = 'energy-apply'; });
  tamper((d) => { delete d.stage; });
  assert.deepEqual(restore(g, f).view(0), g.view(0));
});

test('one-recipient plans and discard plans cannot acquire extra destinations, empty eligibility or unrelated resolution stages', async () => {
  for (const op of ['moveEnergy', 'discardEnergy']) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('energy', [binding('cn.attachedEnergy@1',
      op === 'moveEnergy' ? move({ measure: 'cards', quantity: { kind: 'all' } }) :
        action({ measure: 'cards', quantity: { kind: 'all' } }))])]);
    let a, b, target1, target2;
    const g = board(f, (s) => {
      a = attached(s, 0, s.players[0].active, 'water'); b = attached(s, 0, s.players[0].active, 'double');
      target1 = bench(s, 0, 'other').id; target2 = bench(s, 0, 'other').id;
    });
    use(g);
    if (op === 'moveEnergy') {
      answer(g, [a, b]);
      const s = g.snapshot(); s.pending.data.stage = 'energy-apply';
      s.pending.data.energyPlan.assignments = [{ instanceId: a, targetId: target1 }, { instanceId: b, targetId: target2 }];
      assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /one common recipient/);
      const bad = g.snapshot(); bad.pending.data.energyPlan.chosen.push({ instanceId: a, originId: target1 });
      assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /Saved Energy/);
      const impossible = g.snapshot(); impossible.pending.data.action.from = 'any';
      impossible.pending.data.energyPlan.chosen[1].originId = target1;
      impossible.players[0].active.energy.pop(); impossible.players[0].bench[0].energy.push(b);
      impossible.pending.data.action.recipient.position = 'any';
      impossible.players[0].hand.push(...impossible.players[0].bench.pop().stack);
      assert.throws(() => OfficialGame.restore(impossible, { catalog: f.catalog }), /common eligible/);
      answer(g, [target1]); settle(g);
    } else {
      const bad = g.snapshot(), d = bad.pending.data;
      d.stage = 'energy-apply'; d.energyPlan = { chosen: [{ instanceId: a, originId: bad.players[0].active.id },
        { instanceId: b, originId: bad.players[0].active.id }], assignments: [{ instanceId: a, targetId: target1 }] };
      assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /Discarding has no/);
      answer(g, [a, b]); settle(g);
    }
  }
});

test('one continuous binding may return multiple requirement changes, each with its own evidence identity', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.effects = [binding('fixture:multi-requirement', {})];
    defs[0].mechanics.attacks[0].cost = ['Water', 'Colorless'];
  }, new Map([['fixture:multi-requirement', reviewed({ timing: 'continuous', operations: ['energyRequirement'],
    execute: () => [req({ amount: -1 }), req({ energyType: 'Water', amount: -1 })] })]]));
  const g = board(f);
  assert(has(g, 'attack'));
  const changes = effective(g).attackRequirements[0].routes[0].trace[0].adjustments;
  assert.equal(new Set(changes.map((c) => c.id)).size, 2);
});

test('invalid Energy handler placements, output descriptors and options fail closed rather than becoming ignored card text', async () => {
  for (const h of [
    reviewed({ timing: 'energyOptions', operations: [], execute: () => [] }),
    reviewed({ timing: 'energyOptions', operations: ['draw'], energyOptions: () => ({ cost: [] }), execute: () => [] }),
    reviewed({ timing: 'resolve', operations: ['energyProvision'], execute: () => [] }),
    reviewed({ timing: 'energyProvision', operations: ['draw'], execute: () => [] }),
  ]) {
    const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('fixture:invalid', {})], new Map([['fixture:invalid', h]]));
    assert.throws(() => start(f), /timing\/operations/);
  }
  for (const output of [undefined, {}, [{ op: 'draw', count: 1 }], [provision({ units: [[]] })]]) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('bad', [binding('fixture:provision', {})], 'continuous')],
      new Map([['fixture:provision', reviewed({ timing: 'energyProvision', operations: ['energyProvision'], execute: () => output })]]));
    assert.throws(() => board(f), /Energy provision|Non-serializable/);
  }
  for (const option of [undefined, {}, { cost: ['Fake'] }]) {
    const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('fixture:option', {})],
      new Map([['fixture:option', reviewed({ timing: 'energyOptions', operations: [], execute: () => [], energyOptions: () => option })]]));
    assert.throws(() => board(f), /Conditional Energy/);
  }
});

test('derived provision conflicts introduced by a dispatch reject before committing either state, revision or RNG', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('totem', [binding('cn.energyProvision@1', { effect: provision() })], 'continuous')];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
      binding('cn.energyProvision@1', { effect: provision({ scope: 'all', units: [['Water'], ['Water'], ['Water']] }) }),
    ];
  });
  const g = board(f, (s) => { hand(s, 0, 'stadium'); attached(s, 0, s.players[0].active, 'water'); });
  const before = g.snapshot(), play = g.view(0).legalActions.find((a) => a.type === 'playTrainer' && before.cards[a.cardId].definitionId === 'stadium');
  assert.throws(() => command(g, play), (e) => e.code === 'unresolved-energy-provision');
  assert.deepEqual(g.snapshot(), before);
});

test('a projection-only Energy-option failure rolls back the dispatch, not merely errors after committing the next state', async () => {
  const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('fixture:projection-option', {})],
    new Map([['fixture:projection-option', reviewed({ timing: 'energyOptions', operations: [], execute: () => [],
      energyOptions: (ctx) => ctx.state.stadium ? { cost: ['Unknown'] } : null })]]));
  const g = board(f, (s) => hand(s, 0, 'stadium')), before = g.snapshot();
  const play = g.view(0).legalActions.find((a) => a.type === 'playTrainer' && before.cards[a.cardId].definitionId === 'stadium');
  assert.throws(() => command(g, play), (e) => e.code === 'invalid-energy-option');
  assert.deepEqual(g.snapshot(), before);
  const oldProtocol = g.snapshot(); oldProtocol.protocol = 'CN-game-dev-7';
  assert.throws(() => OfficialGame.restore(oldProtocol, { catalog: f.catalog }), /Snapshot schema mismatch/);
});

test('Energy selection context uses effective units, source/event/attacker positions and common-recipient availability, not printed-unit guesses', async () => {
  const f = await fixture(), definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  const state = { players: [
    { active: { id: 'a', stack: ['pa'], energy: ['ea'] }, bench: [{ id: 'b', stack: ['pb'], energy: ['eb'] }] },
    { active: null, bench: [] },
  ], cards: { pa: { definitionId: 'base' }, pb: { definitionId: 'other' }, ea: { definitionId: 'water' }, eb: { definitionId: 'double' } } };
  const ctx = { state, definitions, source: { owner: 0, pokemonId: 'a' }, event: { subjectId: 'b', cause: { source: { pokemonId: 'a' } } },
    effectivePokemon: { a: { types: ['Water'], energies: [{ instanceId: 'ea', units: [['Water'], ['Water']] }] },
      b: { types: ['Water'], energies: [{ instanceId: 'eb', units: [['Colorless'], ['Colorless']] }] } } };
  assert.equal(attachedEnergyPool(ctx, action())[0].amount, 2);
  for (const [from, expected] of [['active', 'a'], ['bench', 'b'], ['event', 'b'], ['attacker', 'a']])
    assert.equal(attachedEnergyPool(ctx, action({ from }))[0].originId, expected);
  assert.equal(attachedEnergyPool({ ...ctx, event: null }, action({ from: 'event' })).length, 0);
  assert.equal(attachedEnergyPool({ ...ctx, event: null }, action({ from: 'attacker' })).length, 0);
  assert.equal(attachedEnergyPool(ctx, action({ from: 'any', providedTypes: ['Water'] })).length, 1);
  assert.equal(attachedEnergyPool(ctx, action({ measure: 'cards' }))[0].amount, 1);
  assert.deepEqual(energyRecipients(ctx, move({ recipient: { position: 'self', selector: { kind: 'pokemon' } } })).map((m) => m.id), ['a']);
  assert.deepEqual(energyRecipients(ctx, move({ recipient: { position: 'active', selector: { kind: 'pokemon' } } })).map((m) => m.id), ['a']);
  assert(canUseAttachedEnergy(ctx, move({ quantity: { kind: 'upTo', count: 1 } })));
  assert(canUseAttachedEnergy(ctx, move({ quantity: { kind: 'any' } })));
  assert(canUseAttachedEnergy(ctx, move({ distribution: 'separateRecipients' })));
  assert(canUseAttachedEnergy(ctx, move({ quantity: { kind: 'all' } })));
  assert(!canUseAttachedEnergy(ctx, move({ from: 'any', recipient: { position: 'any', selector: { kind: 'pokemon' } }, quantity: { kind: 'all' } })));
  assert(!canUseAttachedEnergy(ctx, move({ recipient: { position: 'bench', selector: { kind: 'pokemon', nameKeys: ['base'] } } })));
  assert(!canUseAttachedEnergy(ctx, move({ from: 'any', recipient: { position: 'any', selector: { kind: 'pokemon' } }, quantity: { kind: 'exact', count: 4 } })));
});

test('Energy recipients use explicit live types without changing physical Energy identity or effective provision', async () => {
  const f = await fixture(), definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  const ctx = {
    source: { owner: 0, pokemonId: 'a' }, definitions,
    state: { players: [
      { active: { id: 'a', stack: ['pa'], energy: ['ea'] }, bench: [{ id: 'b', stack: ['pb'], energy: [] }] },
      { active: { id: 'o', stack: ['po'], energy: [] }, bench: [] },
    ], cards: { pa: { definitionId: 'base' }, pb: { definitionId: 'other' }, po: { definitionId: 'base' }, ea: { definitionId: 'water' } } },
    effectivePokemon: {
      a: { types: ['Lightning', 'Metal'], energies: [{ instanceId: 'ea', units: [['Fire'], ['Fire']] }] },
      b: { types: ['Fire'], energies: [] }, o: { types: ['Dragon'], energies: [] },
    },
  };
  const before = structuredClone(ctx);
  for (const [side, types, expected] of [
    ['own', ['Water'], []], ['own', ['Lightning'], ['a']], ['own', ['Metal'], ['a']],
    ['own', ['Fire'], ['b']], ['own', ['Metal', 'Fire'], ['a', 'b']], ['opponent', ['Dragon'], ['o']],
    ['opponent', ['Water'], []],
  ]) assert.deepEqual(energyRecipients(ctx, move({ side, recipient: { position: 'any', selector: { kind: 'pokemon', types } } }))
    .map((m) => m.id), expected);
  assert(canUseAttachedEnergy(ctx, move({ recipient: { position: 'bench', selector: { kind: 'pokemon', types: ['Fire'] } } })));
  assert(!canUseAttachedEnergy(ctx, move({ recipient: { position: 'bench', selector: { kind: 'pokemon', types: ['Water'] } } })));
  assert.deepEqual(attachedEnergyPool(ctx, action({
    selector: { kind: 'energy', category: 'basic', types: ['Water'] }, providedTypes: ['Fire'],
  })).map(({ instanceId, amount }) => ({ instanceId, amount })), [{ instanceId: 'ea', amount: 2 }]);
  assert.deepEqual(attachedEnergyPool(ctx, action({ selector: { kind: 'energy', category: 'basic', types: ['Fire'] } })), []);
  assert.deepEqual(energyRecipients(ctx, move({ recipient: {
    position: 'any', selector: { kind: 'pokemon', types: ['Lightning'], nameKeys: ['other'] },
  } })), [], 'Live typing must not substitute another Pokémon’s printed name.');
  assert.deepEqual(ctx, before);
  const recipient = move({ recipient: { position: 'self', selector: { kind: 'pokemon' } } });
  for (const mutate of [
    (c) => { delete c.effectivePokemon; }, (c) => { c.effectivePokemon = {}; },
    (c) => { delete c.effectivePokemon.a.types; }, (c) => { c.effectivePokemon.a.types = null; },
    (c) => { c.effectivePokemon.a.types = []; }, (c) => { c.effectivePokemon.a.types = ['Fake']; },
    (c) => { c.effectivePokemon.a.types = ['Water', 'Water']; },
  ]) {
    const invalid = structuredClone(ctx); mutate(invalid);
    assert.throws(() => energyRecipients(invalid, recipient), TypeError, 'Missing/invalid live types cannot fall back to Water.');
  }
});
