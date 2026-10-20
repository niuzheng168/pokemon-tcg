// Synthetic printed cards/public runtime facts only; no real-card approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  CounterDistributionError, COUNTER_DISTRIBUTION_RULE_IDS, COUNTER_DISTRIBUTION_SOURCES,
  assertCounterDistributionAction, counterDistributionWindow, canUseCounterDistribution,
  assertCounterDistributionAllocation, planCounterDistribution, assertCounterDistributionPlan,
} from '../../public/rules/counter-distribution.js';
import * as generated from '../../public/rules/schema-validators.js';

const MAX = 900719925474099;
const clone = (value) => structuredClone(value);
const action = (extra = {}) => ({
  op: 'distributeCounters', side: 'own', target: 'any', selector: { kind: 'pokemon' }, count: 5, ...extra,
});
const evidence = [{
  sourceId: 'fixture:distribution', kind: 'official-rule', url: 'https://www.pokemon.cn/',
  locator: 'TEST ONLY: synthetic public Pokemon, no real-card approval.',
}];
const printed = (i) => ({
  schemaVersion: '1.0.0', definitionId: `fixture:face${i}`, ruleset: { region: 'CN', version: 'V20261019' },
  name: `测试宝可梦${i}`, nameKey: `fixture:face${i}`, kind: 'pokemon',
  mechanics: {
    stage: i === 0 ? 'basic' : 'stage1', evolvesFrom: i === 0 ? null : 'fixture:face0',
    hp: [60, 120, 140][i], types: [['Water'], ['Fire'], ['Grass']][i],
    weakness: null, resistance: null, retreatCost: 1, attacks: [], abilities: [],
    ruleBox: false, prizeCount: 1, tags: [], effects: [],
  },
  sourceOfTruth: clone(evidence), implementation: { status: 'verified', testIds: ['fixture:test'] },
  deckLimits: { sameName: 4, groups: [] },
});
function context(counts = [0, 2, 7], owner = 0) {
  const cards = {}, effectivePokemon = {};
  const players = [0, 1].map((holder) => {
    const mons = counts.map((counters, i) => {
      const id = `m${holder}:${i}`, face = i % 3;
      const stack = face === 0 ? [`c${holder}:${i}:top`] : [`c${holder}:${i}:base`, `c${holder}:${i}:top`];
      stack.forEach((instanceId, index) => {
        cards[instanceId] = {
          instanceId, owner: holder, printingId: `printing:${instanceId}`,
          definitionId: `fixture:face${index === stack.length - 1 ? face : 0}`,
        };
      });
      effectivePokemon[id] = { types: [['Lightning'], ['Water'], ['Water', 'Metal']][face] };
      return { id, stack, counters, energy: [], tools: [], facts: {}, conditions: {} };
    });
    return { active: mons[0] ?? null, bench: mons.slice(1), hand: [], deck: [], prizes: [], discard: [] };
  });
  return {
    source: { owner, category: 'attack', instanceId: 'source', pokemonId: players[owner].active?.id ?? null },
    state: { current: 1 - owner, cards, players, rng: [1, 2, 3, 4], battleHistory: {} },
    definitions: Object.fromEntries([0, 1, 2].map((i) => [`fixture:face${i}`, printed(i)])),
    effectivePokemon,
    event: { subjectId: `m${owner}:1`, cause: { source: { pokemonId: `m${owner}:2` } } },
  };
}
const allocation = (i, count, owner = 0) => ({ pokemonId: `m${owner}:${i}`, count });
const live = (ctx, owner = ctx.source.owner) => [ctx.state.players[owner].active, ...ctx.state.players[owner].bench].filter(Boolean);
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const rejects = (fn) => assert.throws(fn, TypeError);
const getAt = (root, path) => path.reduce((current, key) => current[key], root);
const setAt = (root, path, value) => { getAt(root, path.slice(0, -1))[path.at(-1)] = value; };

// Standalone transitive schema loading is read-only, not a shared generator.
const ajv = new Ajv2020({ strict: true, allErrors: true }), loaded = new Map();
async function register(name) {
  const doc = JSON.parse(await readFile(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
  if (loaded.has(doc.$id)) return;
  loaded.set(doc.$id, doc); ajv.addSchema(doc);
  const pending = [doc];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node.$ref === 'string' && node.$ref.startsWith('urn:pokemon-tcg:')) {
      const uri = node.$ref.split('#')[0], key = uri.split(':')[2];
      if (!loaded.has(uri)) await register(key === 'core-handler-parameters' ? 'handler-parameters' : key);
    }
    pending.push(...Object.values(node));
  }
}
await register('counter-distribution');
const schema = loaded.get('urn:pokemon-tcg:counter-distribution:1.0.0');
const schemaAction = ajv.getSchema(schema.$id);
const schemaAllocation = ajv.getSchema(`${schema.$id}#/$defs/allocation`);
const schemaAllocations = ajv.getSchema(`${schema.$id}#/$defs/allocations`);
const schemaPlan = ajv.getSchema(`${schema.$id}#/$defs/plan`);
function checkAction(a, expected) {
  assert.equal(schemaAction(a), expected);
  if (expected) assert.equal(assertCounterDistributionAction(a), a);
  else rejects(() => assertCounterDistributionAction(a));
}

// Independent weak compositions: choose each recipient's token count, rather
// than reproducing production sum validation or treating Pokemon as inventory.
function* partitions(total, targets, prefix = []) {
  if (targets === 0) { if (total === 0) yield prefix; return; }
  for (let count = 0; count <= total; count++) yield* partitions(total - count, targets - 1, [...prefix, count]);
}
function* permutations(items, prefix = []) {
  if (!items.length) { yield prefix; return; }
  for (let i = 0; i < items.length; i++)
    yield* permutations([...items.slice(0, i), ...items.slice(i + 1)], [...prefix, items[i]]);
}
function oracle(before, allocations, denied, targetCount) {
  let selectedTotal = 0, placedTotal = 0, preventedTotal = 0;
  const updates = allocations.map(({ pokemonId, count }) => {
    const index = Number(pokemonId.split(':')[1]);
    let afterCounters = before[index], placedCounters = 0;
    for (let token = 0; token < count; token++) {
      selectedTotal++;
      if (denied.includes(pokemonId)) preventedTotal++;
      else { afterCounters++; placedCounters++; placedTotal++; }
    }
    return { pokemonId, beforeCounters: before[index], afterCounters, placedCounters };
  });
  return {
    owner: 0, allocations: clone(allocations), updates, selectedTotal, placedTotal, preventedTotal,
    noTargets: targetCount === 0, performed: placedTotal !== 0,
  };
}

test('schema pins the fixed C07 subset, shared selectors/targets, bounded counters and explicit software responsibility', () => {
  assert.equal(schema.$id, 'urn:pokemon-tcg:counter-distribution:1.0.0');
  assert.equal(schema.$ref, '#/$defs/action');
  assert.equal(schema.$defs.action.properties.target.$ref, 'urn:pokemon-tcg:effect-program:1.0.0#/$defs/target');
  assert.equal(schema.$defs.action.properties.selector.$ref, 'urn:pokemon-tcg:energy-mechanics:1.0.0#/$defs/pokemonSelector');
  assert.equal(schema.$defs.allocations.items.$ref, '#/$defs/allocation');
  assert.match(schema.$comment, /II\.C-07.*p30.*II\.A p19.*II\.C-17 p37–39.*II\.D-04 p43–44/);
  assert.match(schema.$comment, /not damage points.*transfer.*dynamic/);
  assert.match(schema.$comment, /NOT client authorization/);
  assert.deepEqual(COUNTER_DISTRIBUTION_RULE_IDS, ['damage.counter-distribution']);
  assert.deepEqual(COUNTER_DISTRIBUTION_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.C-07', pdfPages: [30] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.A', pdfPages: [19] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.C-17', pdfPages: [37, 38, 39] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.D-04', pdfPages: [43, 44] },
  ]);
  assert(Object.isFrozen(COUNTER_DISTRIBUTION_RULE_IDS)); assert(Object.isFrozen(COUNTER_DISTRIBUTION_SOURCES));
  for (const source of COUNTER_DISTRIBUTION_SOURCES) { assert(Object.isFrozen(source)); assert(Object.isFrozen(source.pdfPages)); }
  const error = new CounterDistributionError('fixture', 'test');
  assert(error instanceof TypeError); assert.equal(error.name, 'CounterDistributionError');
  assert.equal(error.code, 'fixture'); assert.equal(error.ruleId, 'damage.counter-distribution');
});

test('independent integer partitions N=0..5, targets=0..3, every allocation order and every target protection mask', (t) => {
  let configurations = 0, plans = 0, deniedMasks = 0, orders = 0;
  const started = performance.now();
  for (let count = 0; count <= 5; count++) for (let targets = 0; targets <= 3; targets++) {
    configurations++;
    const counters = [0, 2, 7].slice(0, targets), ctx = freeze(context(counters)), a = freeze(action({ count }));
    const original = clone({ ctx, a }), vectors = targets === 0 ? [[]] : [...partitions(count, targets)];
    assert.equal(canUseCounterDistribution(ctx, a), count > 0 && targets > 0);
    for (const vector of vectors) for (const selected of permutations(
      vector.map((n, i) => allocation(i, n)).filter((item) => item.count > 0),
    )) {
      orders++;
      freeze(selected);
      assert.equal(assertCounterDistributionAllocation(ctx, a, selected), selected);
      for (let mask = 0; mask < 2 ** targets; mask++) {
        const blocked = freeze(vector.map((_n, i) => `m0:${i}`).filter((_id, i) => mask & (1 << i)));
        if (blocked.some((id) => !selected.some((item) => item.pokemonId === id))) {
          rejects(() => planCounterDistribution(ctx, a, selected, blocked)); deniedMasks++; continue;
        }
        const expected = oracle(counters, selected, blocked, targets);
        const plan = planCounterDistribution(ctx, a, selected, blocked);
        assert.deepEqual(plan, expected);
        assert.equal(assertCounterDistributionPlan(ctx, a, freeze(plan), blocked), plan);
        assert.equal(schemaPlan(plan), true);
        assert.equal(plan.selectedTotal, targets === 0 ? 0 : count);
        assert.equal(plan.placedTotal + plan.preventedTotal, plan.selectedTotal);
        plans++;
      }
    }
    assert.deepEqual({ ctx, a }, original);
    if (count > 0 && targets > 0) rejects(() => assertCounterDistributionAllocation(ctx, a, []));
  }
  assert.equal(configurations, 24);
  assert.equal(orders, 179); assert.equal(plans, 869); assert.equal(deniedMasks, 361);
  t.diagnostic(`${configurations} configurations, ${orders} allocation orders, ${plans} mask plans, ${deniedMasks} invalid masks; ${(performance.now() - started).toFixed(1)}ms.`);
});

test('one fixed total is neither per-Pokemon nor HP-limited; prevention consumes its original share without reassignment', () => {
  const ctx = context([5, 0, 7]), a = action(), selected = [allocation(2, 2), allocation(0, 3)];
  const plan = planCounterDistribution(ctx, a, selected, ['m0:0']);
  assert.deepEqual(plan, {
    owner: 0, allocations: selected,
    updates: [
      { pokemonId: 'm0:2', beforeCounters: 7, afterCounters: 9, placedCounters: 2 },
      { pokemonId: 'm0:0', beforeCounters: 5, afterCounters: 5, placedCounters: 0 },
    ],
    selectedTotal: 5, placedTotal: 2, preventedTotal: 3, noTargets: false, performed: true,
  });
  const all = planCounterDistribution(ctx, a, [allocation(0, 5)]);
  assert.equal(all.updates[0].afterCounters, 10, 'Exceed printed HP 60 without clipping or immediate KO.');
  assert.equal(all.selectedTotal, 5, 'Target count is not the counter budget.');
  for (const amount of [4, 6]) rejects(() => planCounterDistribution(ctx, a, [allocation(0, amount)]));
  const blocked = planCounterDistribution(ctx, a, selected, selected.map((item) => item.pokemonId));
  assert.equal(blocked.placedTotal, 0); assert.equal(blocked.preventedTotal, 5); assert.equal(blocked.performed, false);
  assert.equal(canUseCounterDistribution(ctx, a), true, 'Candidate availability never prefilters protection.');
  assert.equal(assertCounterDistributionPlan(ctx, a, blocked, ['m0:2', 'm0:0']), blocked);
});

test('zero and empty windows are distinct zero-results, never permission for under-allocation when targets exist', () => {
  for (const counters of [[], [0], [3, 0]]) for (const count of [0, 5]) {
    const ctx = context(counters), a = action({ count });
    if (count > 0 && counters.length) { rejects(() => planCounterDistribution(ctx, a, [])); continue; }
    const plan = planCounterDistribution(ctx, a, []);
    assert.deepEqual(plan, {
      owner: 0, allocations: [], updates: [], selectedTotal: 0, placedTotal: 0, preventedTotal: 0,
      noTargets: counters.length === 0, performed: false,
    });
    assert.equal(assertCounterDistributionPlan(ctx, a, plan), plan);
    rejects(() => planCounterDistribution(ctx, a, [allocation(0, 1)]));
  }
  const ctx = context([0, 0, 0]);
  for (const category of ['trainer', 'ability', 'attack', 'energy', 'rule']) {
    ctx.source.category = category;
    assert.equal(counterDistributionWindow(ctx, action()).targets.length, 3, 'Healthy Pokemon stay eligible in every source category.');
    assert.equal(canUseCounterDistribution(ctx, action({ count: 0 })), false);
  }
});

test('choice prevalidation does NOT assume unblocked placement; true after-overflow rejects the entire pure batch', () => {
  const ctx = freeze(context([0, MAX])), a = freeze(action({ count: 2 })), selected = freeze([allocation(0, 1), allocation(1, 1)]);
  const before = clone({ ctx, a, selected });
  assert.equal(assertCounterDistributionAllocation(ctx, a, selected), selected);
  rejects(() => planCounterDistribution(ctx, a, selected));
  const plan = planCounterDistribution(ctx, a, selected, ['m0:1']);
  assert.deepEqual(plan.updates, [
    { pokemonId: 'm0:0', beforeCounters: 0, afterCounters: 1, placedCounters: 1 },
    { pokemonId: 'm0:1', beforeCounters: MAX, afterCounters: MAX, placedCounters: 0 },
  ]);
  assert.deepEqual({ ctx, a, selected }, before, 'Failure cannot partly update the earlier target.');
  assert.equal(assertCounterDistributionPlan(ctx, a, plan, ['m0:1']), plan);
  rejects(() => assertCounterDistributionPlan(ctx, a, plan));
  const exact = planCounterDistribution(context([MAX - 1]), action({ count: 1 }), [allocation(0, 1)]);
  assert.equal(exact.updates[0].afterCounters, Number(BigInt(MAX - 1) + 1n));
  const maximum = action({ count: MAX }), all = [allocation(0, MAX)];
  assert.equal(planCounterDistribution(context([0]), maximum, all).updates[0].afterCounters, MAX);
  assert.equal(assertCounterDistributionAllocation(context([MAX]), maximum, all), all);
  const prevented = planCounterDistribution(context([MAX]), maximum, all, ['m0:0']);
  assert.equal(prevented.preventedTotal, MAX); assert.equal(prevented.updates[0].afterCounters, MAX);
  rejects(() => planCounterDistribution(context([1]), maximum, all));
  rejects(() => assertCounterDistributionAllocation(context([0, 0]), maximum, [allocation(0, MAX), allocation(1, MAX)]));
});

test('all six target modes intersect side and selector relative to source owner, never current player', () => {
  for (const sourceOwner of [0, 1]) for (const side of ['own', 'opponent']) {
    const owner = side === 'own' ? sourceOwner : 1 - sourceOwner, ctx = context([0, 2, 3], sourceOwner);
    ctx.event = { subjectId: `m${owner}:1`, cause: { source: { pokemonId: `m${owner}:2` } } };
    for (const [target, expected] of [
      ['any', [`m${owner}:0`, `m${owner}:1`, `m${owner}:2`]], ['active', [`m${owner}:0`]],
      ['bench', [`m${owner}:1`, `m${owner}:2`]], ['self', owner === sourceOwner ? [`m${owner}:0`] : []],
      ['event', [`m${owner}:1`]], ['attacker', [`m${owner}:2`]],
    ]) {
      const a = action({ side, target }), window = counterDistributionWindow(ctx, a);
      assert.equal(window.owner, owner);
      assert.deepEqual(window.targets.map((entry) => entry.pokemonId), expected);
      const plan = planCounterDistribution(ctx, a, expected.length ? [{ pokemonId: expected[0], count: 5 }] : []);
      assert.equal(plan.owner, owner); assert.equal(plan.noTargets, expected.length === 0);
    }
  }
  const ctx = context(), a = action({ target: 'bench', selector: { kind: 'pokemon', nameKeys: ['fixture:face0'] } });
  assert.deepEqual(counterDistributionWindow(ctx, a).targets, [], 'Position and selector both constrain the pool.');
  const benchOnly = context(); benchOnly.state.players[0].active = null;
  assert.equal(counterDistributionWindow(benchOnly, action({ target: 'bench' })).targets.length, 2);
});

test('printed names/HP/stage remain static; effective types must be explicitly supplied and never fall back to printed types', () => {
  const ctx = context(), expected = [
    [{ kind: 'pokemon', nameKeys: ['fixture:face1'] }, ['m0:1']],
    [{ kind: 'pokemon', stages: ['stage1'] }, ['m0:1', 'm0:2']],
    [{ kind: 'pokemon', printedHpAtMost: 60 }, ['m0:0']],
    [{ kind: 'pokemon', types: ['Water'] }, ['m0:1', 'm0:2']],
    [{ kind: 'pokemon', types: ['Lightning'] }, ['m0:0']],
    [{ kind: 'pokemon', types: ['Fire'] }, []],
    [{ kind: 'pokemon', printedHpAtMost: 60, types: ['Water'] }, []],
  ];
  const before = clone(ctx);
  for (const [selector, ids] of expected)
    assert.deepEqual(counterDistributionWindow(ctx, action({ selector })).targets.map((target) => target.pokemonId), ids);
  assert.deepEqual(ctx, before);
  for (const types of [undefined, null, [], ['Bogus'], ['Water', 'Water']]) {
    const bad = context(); bad.effectivePokemon['m0:0'].types = types;
    rejects(() => counterDistributionWindow(bad, action()));
  }
  const missing = context(); delete missing.effectivePokemon['m0:0'];
  rejects(() => counterDistributionWindow(missing, action()));
});

test('self/event/attacker references distinguish absence from malformed requested identities and reject event cycles/getters', () => {
  for (const target of ['event', 'attacker']) for (const event of [
    undefined, null, {}, { subjectId: null }, { cause: null }, { cause: {} },
    { cause: { source: null } }, { cause: { source: {} } }, { cause: { source: { pokemonId: null } } },
  ]) {
    const ctx = context(); if (event === undefined) delete ctx.event; else ctx.event = event;
    assert.deepEqual(counterDistributionWindow(ctx, action({ target })).targets, []);
  }
  for (const id of [undefined, null]) {
    const ctx = context(); if (id === undefined) delete ctx.source.pokemonId; else ctx.source.pokemonId = id;
    assert.deepEqual(counterDistributionWindow(ctx, action({ target: 'self' })).targets, []);
  }
  for (const [target, event] of [
    ['event', false], ['event', []], ['event', { subjectId: 0 }],
    ['attacker', { cause: true }], ['attacker', { cause: { source: false } }],
    ['attacker', { cause: { source: { pokemonId: [] } } }],
  ]) {
    const ctx = context(); ctx.event = event;
    rejects(() => counterDistributionWindow(ctx, action({ target })));
  }
  const bad = context(); bad.source.pokemonId = false;
  rejects(() => counterDistributionWindow(bad, action({ target: 'self' })));
  const cycle = context(); cycle.event.cause.source = cycle.event;
  rejects(() => counterDistributionWindow(cycle, action({ target: 'attacker' })));
  let calls = 0;
  const ctx = context();
  Object.defineProperty(ctx.event, 'subjectId', { enumerable: true, get() { calls++; throw Error('getter'); } });
  rejects(() => counterDistributionWindow(ctx, action({ target: 'event' })));
  assert.equal(calls, 0);
});

test('no hidden zones, HP caches, attachments, protection, history, unrequested event/source category or RNG are inspected', () => {
  const ctx = context(), a = action(), selected = [allocation(0, 2), allocation(1, 3)];
  let calls = 0;
  const poison = (record, key) => Object.defineProperty(record, key, {
    enumerable: true, configurable: true, get() { calls++; throw Error(`Unrequested ${key}`); },
  });
  for (const key of ['current', 'rng', 'battleHistory']) poison(ctx.state, key);
  for (const player of ctx.state.players) for (const key of ['hand', 'deck', 'prizes', 'discard']) poison(player, key);
  poison(ctx, 'event'); poison(ctx.source, 'pokemonId'); poison(ctx.source, 'category');
  poison(ctx.state.cards, 'hidden:physical'); poison(ctx.definitions, 'hidden:face');
  for (const mon of live(ctx)) {
    for (const key of ['currentHp', 'maximumHp', 'energy', 'tools', 'conditions', 'facts', 'protection']) poison(mon, key);
    for (const key of ['currentHp', 'maximumHp']) poison(ctx.effectivePokemon[mon.id], key);
  }
  assert.equal(assertCounterDistributionAllocation(ctx, a, selected), selected);
  const plan = planCounterDistribution(ctx, a, selected, ['m0:1']);
  assert.equal(plan.placedTotal, 2); assert.equal(assertCounterDistributionPlan(ctx, a, plan, ['m0:1']), plan);
  assert.equal(calls, 0);
});

test('allocations are exact positive-counter records with unique eligible Pokemon IDs; blocked is only an allocated subset', () => {
  const ctx = context(), a = action(), valid = [allocation(0, 2), allocation(1, 3)];
  const invalid = [
    undefined, null, false, 'allocations', {}, [null], [{}], [{ pokemonId: 'm0:0' }],
    [{ count: 5 }], [{ ...allocation(0, 5), extra: true }],
    ...[-1, 0, 0.5, MAX + 1, null, false, '5'].map((count) => [allocation(0, count)]),
    [{ pokemonId: '', count: 5 }], [{ pokemonId: 0, count: 5 }],
    [allocation(0, 2), allocation(0, 3)], [allocation(0, 5), allocation(0, 5)],
    [allocation(0, 4)], [allocation(0, 6)], [],
    [{ pokemonId: 'c0:0:top', count: 5 }], [allocation(0, 5, 1)], [{ pokemonId: 'missing', count: 5 }],
  ];
  for (const value of invalid) {
    rejects(() => assertCounterDistributionAllocation(ctx, a, value));
    rejects(() => planCounterDistribution(ctx, a, value));
  }
  for (const blocked of [null, false, 'm0:0', {}, [1], [''], ['m0:0', 'm0:0'], ['m1:0'], ['missing'], ['m0:2']])
    rejects(() => planCounterDistribution(ctx, a, valid, blocked));
  assert.equal(assertCounterDistributionAllocation(ctx, a, valid), valid);
  assert.equal(planCounterDistribution(ctx, action({ count: 3 }), [allocation(0, 3)]).placedTotal, 3,
    'Counts are counters, not damage points or multiples of ten.');
});

test('requested context rejects missing/foreign/duplicate identities, malformed stacks and invalid counter/printed data', () => {
  const paths = [
    [['source'], null], [['source', 'owner'], 2], [['source', 'owner'], '0'],
    [['state', 'players'], []], [['state', 'cards'], null], [['definitions'], []], [['effectivePokemon'], null],
    [['state', 'players', 0, 'active'], false], [['state', 'players', 0, 'bench'], null],
    [['state', 'players', 0, 'active', 'id'], ''], [['state', 'players', 0, 'active', 'stack'], []],
    [['state', 'cards', 'c0:0:top', 'instanceId'], 'alias'], [['state', 'cards', 'c0:0:top', 'owner'], 1],
    [['state', 'cards', 'c0:0:top', 'definitionId'], ''],
    [['definitions', 'fixture:face0'], null], [['definitions', 'fixture:face0', 'mechanics', 'hp'], 61],
  ];
  for (const [path, value] of paths) {
    const ctx = context(); setAt(ctx, path, value);
    rejects(() => counterDistributionWindow(ctx, action()));
  }
  for (const counters of [-1, 0.5, MAX + 1, Number.MAX_SAFE_INTEGER, NaN, Infinity, null, false, '1', 1n]) {
    const ctx = context(); ctx.state.players[0].active.counters = counters;
    rejects(() => counterDistributionWindow(ctx, action()));
  }
  const duplicate = context(); duplicate.state.players[0].bench[0].id = 'm0:0';
  rejects(() => counterDistributionWindow(duplicate, action()));
  const crossStack = context(); crossStack.state.players[0].bench[0].stack[0] = 'c0:0:top';
  rejects(() => counterDistributionWindow(crossStack, action()));
  const doubleStack = context(); doubleStack.state.players[0].active.stack.push('c0:0:top');
  rejects(() => counterDistributionWindow(doubleStack, action()));
  const nonPokemon = context(); nonPokemon.definitions['fixture:face0'] = {
    ...printed(0), kind: 'trainer', mechanics: { category: 'item', effects: [] },
  };
  rejects(() => counterDistributionWindow(nonPokemon, action()));
  const alias = context(); alias.definitions['fixture:face0'].definitionId = 'fixture:alias';
  rejects(() => counterDistributionWindow(alias, action()));
});

test('required context fields are own enumerable data, never getters/hidden/inherited values; null prototypes work', () => {
  let calls = 0;
  for (const path of [
    ['source'], ['source', 'owner'], ['state'], ['state', 'players'], ['state', 'cards'], ['definitions'], ['effectivePokemon'],
    ['state', 'players', 0, 'active'], ['state', 'players', 0, 'bench'],
    ['state', 'players', 0, 'active', 'counters'], ['state', 'players', 0, 'active', 'stack'],
    ['state', 'cards', 'c0:0:top'], ['state', 'cards', 'c0:0:top', 'definitionId'],
    ['definitions', 'fixture:face0', 'mechanics', 'types'], ['effectivePokemon', 'm0:0', 'types'],
  ]) for (const mode of ['getter', 'hidden', 'missing', 'inherited']) {
    const ctx = context(), parentPath = path.slice(0, -1), parent = getAt(ctx, parentPath), key = path.at(-1), value = parent[key];
    if (mode === 'getter') Object.defineProperty(parent, key, { enumerable: true, get() { calls++; throw Error('getter'); } });
    else if (mode === 'hidden') Object.defineProperty(parent, key, { value, enumerable: false });
    else if (mode === 'missing') delete parent[key];
    else {
      const inherited = Object.assign(Object.create({ [key]: value }), parent); delete inherited[key];
      if (parentPath.length) setAt(ctx, parentPath, inherited);
      else { Object.setPrototypeOf(ctx, { [key]: value }); delete ctx[key]; }
    }
    rejects(() => counterDistributionWindow(ctx, action()));
  }
  assert.equal(calls, 0);
  const ctx = context();
  ctx.source = Object.assign(Object.create(null), ctx.source);
  ctx.state.cards = Object.assign(Object.create(null), ctx.state.cards);
  ctx.effectivePokemon = Object.assign(Object.create(null), ctx.effectivePokemon);
  const a = Object.assign(Object.create(null), action());
  assert.equal(assertCounterDistributionAction(a), a);
  assert.equal(planCounterDistribution(ctx, a, [allocation(0, 5)]).placedTotal, 5);
});

test('saved plans revalidate actual counters/types/total/order/mask, not coherent-looking result claims or property order', () => {
  const ctx = context(), a = action(), selected = [allocation(1, 3), allocation(0, 2)], blocked = ['m0:0'];
  const plan = planCounterDistribution(ctx, a, selected, blocked), before = clone({ ctx, a, plan });
  assert.equal(assertCounterDistributionPlan(ctx, a, plan, blocked), plan);
  for (const change of [
    (p) => { p.owner = 1; }, (p) => { p.noTargets = true; }, (p) => { p.performed = false; },
    (p) => { p.selectedTotal++; }, (p) => { p.placedTotal++; }, (p) => { p.preventedTotal++; },
    (p) => { p.updates.pop(); }, (p) => { p.updates.reverse(); }, (p) => { p.allocations.reverse(); },
    (p) => { p.updates[0].beforeCounters++; }, (p) => { p.updates[0].afterCounters++; },
    (p) => { p.updates[0].placedCounters++; }, (p) => { p.updates[0].pokemonId = 'm0:0'; },
  ]) {
    const forged = clone(plan); change(forged);
    assert.equal(schemaPlan(forged), true, 'Cross-record proof requires pure semantic revalidation.');
    rejects(() => assertCounterDistributionPlan(ctx, a, forged, blocked));
  }
  rejects(() => assertCounterDistributionPlan(ctx, a, plan));
  const changed = clone(ctx); changed.state.players[0].bench[0].counters++;
  rejects(() => assertCounterDistributionPlan(changed, a, plan, blocked));
  rejects(() => assertCounterDistributionPlan(ctx, action({ count: 4 }), plan, blocked));
  const typed = action({ selector: { kind: 'pokemon', types: ['Water'] } });
  const typedPlan = planCounterDistribution(ctx, typed, [allocation(1, 5)]);
  const changedTypes = clone(ctx); changedTypes.effectivePokemon['m0:1'].types = ['Fire'];
  rejects(() => assertCounterDistributionPlan(changedTypes, typed, typedPlan));
  const reordered = clone(plan);
  reordered.updates = reordered.updates.map((u) => ({
    placedCounters: u.placedCounters, afterCounters: u.afterCounters, pokemonId: u.pokemonId, beforeCounters: u.beforeCounters,
  }));
  assert.equal(assertCounterDistributionPlan(ctx, a, reordered, blocked), reordered);
  assert.deepEqual({ ctx, a, plan }, before);
});

test('action/plan schemas and strict pure shapes reject unsupported modes, mixed units, unknown fields and bad bounds', () => {
  const invalid = [
    null, false, 0, '', [], {}, action({ op: 'transferCounters' }), action({ side: 'both' }), action({ target: 'all' }),
    action({ selector: null }), action({ selector: { kind: 'any' } }), action({ selector: { kind: 'energy' } }),
    action({ selector: { kind: 'pokemon', currentHpAtMost: 30 } }), action({ selector: { kind: 'pokemon', types: [] } }),
    action({ selector: { anyOf: [{ kind: 'pokemon' }, { kind: 'pokemon', stages: ['basic'] }] } }),
    ...[-1, 0.5, MAX + 1, Number.MAX_SAFE_INTEGER, null, false, '5', 'any', { kind: 'literal', value: 5 }]
      .map((count) => action({ count })),
    ...['quantity', 'amount', 'perPokemon', 'blocked', 'source', 'damage', 'currentHp', 'approved']
      .map((key) => action({ [key]: 1 })),
    ...Object.keys(action()).map((key) => { const a = action(); delete a[key]; return a; }),
  ];
  for (const a of invalid) checkAction(a, false);
  for (const count of [0, 1, 5, 10, MAX]) checkAction(freeze(action({ count })), true);
  for (const count of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('counter'), () => 5])
    rejects(() => assertCounterDistributionAction(action({ count })));
  const ctx = context(), a = action(), plan = planCounterDistribution(ctx, a, [allocation(0, 5)]);
  for (const candidate of [
    null, [], {}, { ...plan, owner: 2 }, { ...plan, noTargets: 0 }, { ...plan, performed: 1 },
    { ...plan, allocations: null }, { ...plan, updates: null }, { ...plan, updates: [null] },
    { ...plan, updates: [{ ...plan.updates[0], pokemonId: '' }] },
    { ...plan, updates: [{ ...plan.updates[0], extra: true }] },
    ...Object.keys(plan).map((key) => { const p = clone(plan); delete p[key]; return p; }),
    ...['blocked', 'currentHp', 'damageHistory', 'approved'].map((key) => ({ ...plan, [key]: true })),
    ...['selectedTotal', 'placedTotal', 'preventedTotal'].flatMap((key) =>
      [-1, 0.5, MAX + 1, null, false, '1'].map((value) => ({ ...plan, [key]: value }))),
    ...['beforeCounters', 'afterCounters', 'placedCounters'].flatMap((key) =>
      [-1, 0.5, MAX + 1, null, false, '1'].map((value) => {
        const p = clone(plan); p.updates[0][key] = value; return p;
      })),
  ]) {
    assert.equal(schemaPlan(candidate), false); rejects(() => assertCounterDistributionPlan(ctx, a, candidate));
  }
  const missingUpdate = clone(plan); delete missingUpdate.updates[0].afterCounters;
  assert.equal(schemaPlan(missingUpdate), false); rejects(() => assertCounterDistributionPlan(ctx, a, missingUpdate));
});

test('strict requested JSON rejects accessors/prototype defaults, hidden/symbol fields, sparse/custom arrays, instances and cycles without execution', () => {
  let calls = 0;
  const getter = () => { calls++; throw Error('Getter/toJSON must never execute.'); };
  const invalid = [new Date(), new Map(), Object.create(action()), Object.assign(new (class Action {})(), action())];
  for (const key of ['op', 'selector', 'count', 'unknown']) {
    const a = action(); Object.defineProperty(a, key, { enumerable: true, get: getter }); invalid.push(a);
    const hidden = action(); Object.defineProperty(hidden, key, { value: 1, enumerable: false }); invalid.push(hidden);
  }
  const symbol = action(); symbol[Symbol('approval')] = true; invalid.push(symbol);
  const cycle = action(); cycle.selector = cycle; invalid.push(cycle);
  const toJSON = action(); toJSON.toJSON = getter; invalid.push(toJSON);
  const inherited = action(); delete inherited.op;
  Object.setPrototypeOf(inherited, Object.defineProperty({}, 'op', { get: getter })); invalid.push(inherited);
  for (const value of invalid) rejects(() => assertCounterDistributionAction(value));
  const arrays = [new Array(1), new (class Entries extends Array {})()];
  const fakeDense = new Array(1); fakeDense.extra = true; arrays.push(fakeDense);
  const access = [allocation(0, 5)]; Object.defineProperty(access, '0', { enumerable: true, get: getter }); arrays.push(access);
  const hidden = [allocation(0, 5)]; Object.defineProperty(hidden, '0', { enumerable: false }); arrays.push(hidden);
  const symbolic = []; symbolic[Symbol('extra')] = true; arrays.push(symbolic);
  const withExtra = []; withExtra.extra = true; arrays.push(withExtra);
  const nullArray = []; Object.setPrototypeOf(nullArray, null); arrays.push(nullArray);
  const arrayCycle = []; arrayCycle.push(arrayCycle); arrays.push(arrayCycle);
  const ctx = context(), a = action(), valid = [allocation(0, 5)];
  for (const value of arrays) {
    rejects(() => assertCounterDistributionAction(action({ selector: { kind: 'pokemon', types: value } })));
    rejects(() => assertCounterDistributionAllocation(ctx, a, value));
    rejects(() => planCounterDistribution(ctx, a, valid, value));
  }
  const selected = [allocation(0, 5)]; Object.defineProperty(selected[0], 'count', { enumerable: true, get: getter });
  rejects(() => assertCounterDistributionAllocation(ctx, a, selected));
  const cyclicPlan = planCounterDistribution(ctx, a, valid); cyclicPlan.updates = cyclicPlan;
  rejects(() => assertCounterDistributionPlan(ctx, a, cyclicPlan));
  assert.equal(calls, 0);
});

test('plans/windows/allocations detach inputs without freezing them, moving cards, producing facts or sampling RNG', () => {
  const ctx = context(), a = action(), selected = [allocation(1, 3), allocation(0, 2)], blocked = ['m0:0'];
  const before = clone({ ctx, a, selected, blocked }), originalRandom = Math.random;
  Math.random = () => { throw Error('No counter-distribution randomness.'); };
  let window, plan;
  try {
    window = counterDistributionWindow(ctx, a); plan = planCounterDistribution(ctx, a, selected, blocked);
    assert.equal(assertCounterDistributionPlan(ctx, a, plan, blocked), plan);
  } finally { Math.random = originalRandom; }
  assert.deepEqual({ ctx, a, selected, blocked }, before);
  for (const value of [ctx, a, selected, blocked, plan, plan.allocations, plan.updates]) assert(!Object.isFrozen(value));
  window.targets[0].counters = 77; plan.allocations[0].count = 99; plan.updates[0].afterCounters = 77;
  assert.deepEqual({ ctx, a, selected, blocked }, before);
  const nullProto = Object.assign(Object.create(null), planCounterDistribution(ctx, a, selected, blocked));
  assert.equal(assertCounterDistributionPlan(ctx, a, nullProto, blocked), nullProto);
});

test('schema generated action/parameters/allocation validators match standalone exact descriptors without generating files', () => {
  for (const key of ['validateCounterDistributionAction', 'validateCounterDistributionParameters', 'validateCounterAllocation'])
    assert.equal(typeof generated[key], 'function', 'Run this schema parity test after the parent-owned build.');
  for (const count of [0, 1, 5, MAX, -1, 0.5, MAX + 1, 'any', null]) {
    const a = action({ count }), expected = schemaAction(a);
    assert.equal(generated.validateCounterDistributionAction(a), expected);
    assert.equal(generated.validateCounterDistributionParameters(a), expected);
  }
  for (const item of [allocation(0, 1), allocation(0, MAX), allocation(0, 0), allocation(0, MAX + 1),
    { ...allocation(0, 1), extra: true }, { pokemonId: 'm0:0' }, null]) {
    assert.equal(schemaAllocations([item]), schemaAllocation(item));
    assert.equal(generated.validateCounterAllocation([item]), schemaAllocations([item]));
  }
  for (const value of [[], [allocation(0, 1), allocation(1, 2)], [allocation(0, 1), allocation(0, 1)], null, {}])
    assert.equal(generated.validateCounterAllocation(value), schemaAllocations(value));
  assert.equal(schemaAllocations([allocation(0, 1), allocation(0, 2)]), true,
    'Different amounts with the same ID require the pure identity gate, not JSON uniqueItems.');
});
