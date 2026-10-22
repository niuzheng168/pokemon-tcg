// Synthetic printed cards and public battle facts only; no card approvals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  PokemonHealingError, HEALING_RULE_IDS, HEALING_SOURCES,
  assertPokemonHealingAction, healingWindow, canUsePokemonHealing, planPokemonHealing, assertPokemonHealingPlan,
} from '../../public/rules/healing.js';
import { validatePokemonHealingAction, validatePokemonHealingParameters } from '../../public/rules/schema-validators.js';

const MAX_COUNTERS = 900719925474099, MAX_HP = 9007199254740990;
const clone = (value) => structuredClone(value);
const action = (extra = {}) => ({
  op: 'healPokemon', side: 'own', target: 'any', selector: { kind: 'pokemon' },
  selection: { kind: 'all' }, amount: 20, discardHealedEnergy: false, ...extra,
});
const evidence = [{
  sourceId: 'fixture:healing', kind: 'official-card', url: 'https://www.pokemon.cn/',
  locator: 'TEST ONLY: synthetic printed definition, not real-card approval.',
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
function context(counts = [0, 1, 3], owner = 0, category = 'trainer') {
  const cards = {}, effectivePokemon = {};
  const players = [0, 1].map((holder) => {
    const mons = counts.map((counters, i) => {
      const id = `m${holder}:${i}`, face = i % 3;
      const stack = face === 0 ? [`c${holder}:${i}:top`] : [`c${holder}:${i}:base`, `c${holder}:${i}:top`];
      for (const [index, instanceId] of stack.entries()) cards[instanceId] = {
        instanceId, owner: holder, printingId: `printing:${instanceId}`,
        definitionId: `fixture:face${index === stack.length - 1 ? face : 0}`,
      };
      effectivePokemon[id] = { types: [['Lightning'], ['Water'], ['Water', 'Metal']][face] };
      return { id, stack, counters, energy: [], tools: [], facts: {}, conditions: {} };
    });
    return { active: mons[0] ?? null, bench: mons.slice(1), hand: [], deck: [], prizes: [], discard: [] };
  });
  return {
    source: { owner, category, instanceId: 'source', pokemonId: players[owner].active?.id ?? null },
    state: { current: 1 - owner, cards, players, rng: [1, 2, 3, 4], battleHistory: {} },
    definitions: Object.fromEntries([0, 1, 2].map((i) => [`fixture:face${i}`, printed(i)])),
    effectivePokemon,
    event: { subjectId: `m${owner}:1`, cause: { source: { pokemonId: `m${owner}:2` } } },
  };
}
const mons = (ctx, owner = ctx.source.owner) => [ctx.state.players[owner].active, ...ctx.state.players[owner].bench].filter(Boolean);
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const rejects = (fn) => assert.throws(fn, TypeError);
const getAt = (root, path) => path.reduce((current, key) => current[key], root);
const setAt = (root, path, value) => { getAt(root, path.slice(0, -1))[path.at(-1)] = value; };

// Only transitive standalone schema references; never run a shared generator.
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
await register('healing');
const schema = loaded.get('urn:pokemon-tcg:healing:1.0.0');
const schemaAction = ajv.getSchema(schema.$id);
const schemaTarget = ajv.getSchema(`${schema.$id}#/$defs/target`);
const schemaUpdate = ajv.getSchema(`${schema.$id}#/$defs/update`);
const schemaPlan = ajv.getSchema(`${schema.$id}#/$defs/plan`);
function checkActionSchemas(a, expected) {
  for (const validator of [schemaAction, validatePokemonHealingAction, validatePokemonHealingParameters])
    assert.equal(validator(a), expected, 'Standalone schema and parent-generated root/handler schemas must agree.');
}

function* orderedSubsets(values, prefix = []) {
  yield prefix;
  for (let i = 0; i < values.length; i++) {
    const rest = [...values]; const [next] = rest.splice(i, 1);
    yield* orderedSubsets(rest, [...prefix, next]);
  }
}
function subsets(values) {
  return Array.from({ length: 2 ** values.length }, (_v, mask) => values.filter((_id, i) => mask & (1 << i)));
}
const selections = [
  ...[1, 2, 3].map((count) => ({ kind: 'exact', count })),
  ...[1, 2, 3].map((count) => ({ kind: 'upTo', count })), { kind: 'all' },
];
function oracleWindow(counts, category, selection) {
  let indices = counts.map((_count, i) => i);
  const originalMaximum = selection.kind === 'all' ? counts.length : Math.min(counts.length, selection.count);
  if (category !== 'attack' && originalMaximum === 1) indices = indices.filter((i) => counts[i] > 0);
  const maximum = selection.kind === 'all' ? indices.length : Math.min(indices.length, selection.count);
  const minimum = selection.kind === 'upTo' ? (maximum ? 1 : 0) : maximum;
  return { indices, minimum, maximum };
}
// Independent healing oracle: remove one counter at a time, not production's
// Math.min/subtraction path. Inputs in the exhaustive domain have only 0..3.
function oraclePlan(counts, chosen, denied, amount) {
  const budget = { 10: 1, 20: 2, 30: 3, all: Infinity }[amount];
  const updates = chosen.map((i) => {
    let after = counts[i], removed = 0;
    if (!denied.includes(i)) while (after > 0 && removed < budget) { after--; removed++; }
    return { pokemonId: `m0:${i}`, beforeCounters: counts[i], afterCounters: after, removedCounters: removed };
  });
  return {
    owner: 0, selected: chosen.map((i) => `m0:${i}`), updates,
    healed: updates.filter((entry) => entry.removedCounters > 0).map((entry) => entry.pokemonId),
    performed: updates.some((entry) => entry.removedCounters > 0),
  };
}

test('schema reuses existing target/Pokémon selector/damageSelection and pins exact CN C06/E19/C17 evidence without approval', () => {
  assert.equal(schema.$id, 'urn:pokemon-tcg:healing:1.0.0');
  assert.equal(schema.$ref, '#/$defs/action');
  assert.equal(schema.$defs.action.properties.target.$ref, 'urn:pokemon-tcg:effect-program:1.0.0#/$defs/target');
  assert.equal(schema.$defs.action.properties.selection.$ref, 'urn:pokemon-tcg:effect-program:1.0.0#/$defs/damageSelection');
  assert.equal(schema.$defs.action.properties.selector.$ref, 'urn:pokemon-tcg:energy-mechanics:1.0.0#/$defs/pokemonSelector');
  assert.deepEqual(HEALING_RULE_IDS, ['effects.heal-results']);
  assert.deepEqual(HEALING_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.C-06', pdfPages: [29] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-19 FAQ3', pdfPages: [63] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-19', pdfPages: [62, 63] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.C-17', pdfPages: [37, 38, 39] },
  ]);
  assert(Object.isFrozen(HEALING_RULE_IDS)); assert(Object.isFrozen(HEALING_SOURCES));
  for (const source of HEALING_SOURCES) { assert(Object.isFrozen(source)); assert(Object.isFrozen(source.pdfPages)); }
  assert.match(schema.$comment, /II\.C-06.*29.*II\.E-19 FAQ3.*63.*II\.E-19 general.*62–63.*II\.C-17.*37–39/);
});

test('independent bounded oracle exhausts counter pairs, ordered selections, all/fixed amounts, masks and explicit compound flags', (t) => {
  let configurations = 0, accepted = 0, rejected = 0;
  for (const first of [0, 1, 2, 3]) for (const second of [0, 1, 2, 3])
    for (const category of ['attack', 'trainer']) {
      const counts = [first, second], ctx = freeze(context(counts, 0, category)), before = clone(ctx);
      for (const selection of selections) for (const amount of [10, 20, 30, 'all'])
        for (const discardHealedEnergy of [false, true]) {
          const a = freeze(action({ selection, amount, discardHealedEnergy })), expectedWindow = oracleWindow(counts, category, selection);
          const window = healingWindow(ctx, a);
          assert.equal(assertPokemonHealingAction(a), a); checkActionSchemas(a, true);
          assert.equal(window.owner, 0);
          assert.deepEqual(window.targets, expectedWindow.indices.map((i) => ({
            pokemonId: `m0:${i}`, topCardId: `c0:${i}:top`, counters: counts[i],
          })));
          assert(window.targets.every((target) => schemaTarget(target)));
          assert.equal(window.bounds.minimum, expectedWindow.minimum);
          assert.equal(window.bounds.maximum, expectedWindow.maximum);
          assert.equal(window.bounds.allowZero, expectedWindow.minimum === 0);
          assert.equal(canUsePokemonHealing(ctx, a), expectedWindow.indices.some((i) => counts[i] > 0));
          for (const chosen of orderedSubsets([0, 1])) {
            const hurtExists = expectedWindow.indices.some((i) => counts[i] > 0);
            const legal = chosen.length >= expectedWindow.minimum && chosen.length <= expectedWindow.maximum &&
              chosen.every((i) => expectedWindow.indices.includes(i)) &&
              !(category !== 'attack' && chosen.length && hurtExists && !chosen.some((i) => counts[i] > 0));
            const selected = chosen.map((i) => `m0:${i}`);
            if (!legal) { rejects(() => planPokemonHealing(ctx, a, selected)); rejected++; continue; }
            for (const denied of subsets(chosen)) {
              const blocked = denied.map((i) => `m0:${i}`);
              const expected = oraclePlan(counts, chosen, denied, amount);
              const plan = planPokemonHealing(ctx, a, freeze(selected), freeze(blocked));
              assert.deepEqual(plan, expected);
              assert.equal(schemaPlan(plan), true); assert(plan.updates.every((update) => schemaUpdate(update)));
              for (const update of plan.updates)
                assert.equal(update.beforeCounters, update.afterCounters + update.removedCounters);
              const saved = freeze(JSON.parse(JSON.stringify(plan)));
              assert.equal(assertPokemonHealingPlan(ctx, a, saved, blocked), saved);
              assert.deepEqual(planPokemonHealing(ctx, a, selected, [...blocked].reverse()), expected);
              accepted++;
            }
          }
          configurations++;
        }
      assert.deepEqual(ctx, before);
    }
  assert.equal(configurations, 1_792); assert(accepted > 0 && rejected > 0);
  t.diagnostic(JSON.stringify({ configurations, acceptedMaskPlans: accepted, rejectedSelections: rejected }));
});

test('C06 single-target filtering distinguishes every non-attack category from attacks; multi-target windows retain healthy Pokémon', () => {
  for (const category of ['trainer', 'ability', 'energy', 'rule', 'attack']) {
    const ctx = context([0, 2, 0], 0, category);
    for (const selection of [{ kind: 'exact', count: 1 }, { kind: 'upTo', count: 1 }]) {
      const a = action({ selection }), window = healingWindow(ctx, a);
      assert.deepEqual(window.targets.map((target) => target.pokemonId),
        category === 'attack' ? ['m0:0', 'm0:1', 'm0:2'] : ['m0:1']);
    }
    const all = action();
    assert.deepEqual(healingWindow(ctx, all).targets.map((target) => target.counters), [0, 2, 0]);
    assert.equal(canUsePokemonHealing(ctx, all), true);
    const plan = planPokemonHealing(ctx, all, ['m0:0', 'm0:1', 'm0:2'], ['m0:1']);
    assert.deepEqual(plan.healed, []); assert.equal(plan.performed, false);
    assert.equal(plan.updates.length, 3, 'Keep blocked and healthy zero-removal receipts.');
  }
  const ctx = context([0, 1]);
  const a = action({ selection: { kind: 'upTo', count: 2 } });
  rejects(() => planPokemonHealing(ctx, a, ['m0:0']));
  assert.equal(planPokemonHealing(ctx, a, ['m0:1'], ['m0:1']).performed, false,
    'Selection requires a damaged target, not a guaranteed unblocked result.');
});

test('all-healthy attacks can execute false results; empty/single-filtered leaves yield zero updates without inventing healing', () => {
  const attack = context([0, 0], 0, 'attack'), a = action();
  assert.equal(canUsePokemonHealing(attack, a), false);
  assert.deepEqual(planPokemonHealing(attack, a, ['m0:1', 'm0:0']), {
    owner: 0, selected: ['m0:1', 'm0:0'],
    updates: [
      { pokemonId: 'm0:1', beforeCounters: 0, afterCounters: 0, removedCounters: 0 },
      { pokemonId: 'm0:0', beforeCounters: 0, afterCounters: 0, removedCounters: 0 },
    ], healed: [], performed: false,
  });
  for (const ctx of [context([]), context([0])]) {
    assert.equal(canUsePokemonHealing(ctx, a), false);
    assert.deepEqual(planPokemonHealing(ctx, a, []), { owner: 0, selected: [], updates: [], healed: [], performed: false });
  }
  const multi = context([0, 0]);
  assert.equal(canUsePokemonHealing(multi, a), false);
  assert.equal(planPokemonHealing(multi, a, ['m0:0', 'm0:1']).performed, false,
    'Host skips an unusable leaf; this pure result does not grant declaration permission.');
});

test('all HP means all runtime counters, not maximum/current HP; exact boundary amounts/counters remain representable', () => {
  const ctx = context([MAX_COUNTERS, 3]), selected = ['m0:0', 'm0:1'];
  const a = action({ amount: 'all', discardHealedEnergy: true });
  const plan = planPokemonHealing(ctx, a, selected);
  assert.deepEqual(plan.updates.map((update) => update.afterCounters), [0, 0]);
  assert.deepEqual(plan.updates.map((update) => update.removedCounters), [MAX_COUNTERS, 3]);
  assert.equal(assertPokemonHealingPlan(ctx, a, plan), plan);
  assert.equal(planPokemonHealing(ctx, action({ amount: MAX_HP }), selected).updates[0].afterCounters, 0);
  const last = planPokemonHealing(ctx, action({ amount: 10 }), selected).updates[0];
  assert.equal(last.afterCounters, Number(BigInt(MAX_COUNTERS) - 1n));
  assert.equal(last.removedCounters, 1);
  const lesser = context([1, 3]);
  assert.deepEqual(planPokemonHealing(lesser, action({ amount: 30 }), selected).updates.map((u) => u.removedCounters), [1, 3]);
  checkActionSchemas(action({ amount: MAX_HP }), true);
  rejects(() => healingWindow(context([MAX_COUNTERS + 1]), a));
});

test('target owner is source-relative; all six target modes use exact live Pokémon identities for either side/actor', () => {
  for (const sourceOwner of [0, 1]) for (const side of ['own', 'opponent']) {
    const holder = side === 'own' ? sourceOwner : 1 - sourceOwner;
    const ctx = context([1, 2, 3], sourceOwner, 'attack');
    ctx.event = { subjectId: `m${holder}:1`, cause: { source: { pokemonId: `m${holder}:2` } } };
    for (const [target, expected] of [
      ['any', [`m${holder}:0`, `m${holder}:1`, `m${holder}:2`]],
      ['active', [`m${holder}:0`]], ['bench', [`m${holder}:1`, `m${holder}:2`]],
      ['self', holder === sourceOwner ? [`m${holder}:0`] : []],
      ['event', [`m${holder}:1`]], ['attacker', [`m${holder}:2`]],
    ]) {
      const a = action({ side, target }), window = healingWindow(ctx, a);
      assert.equal(window.owner, holder);
      assert.deepEqual(window.targets.map((entry) => entry.pokemonId), expected);
      assert.equal(planPokemonHealing(ctx, a, expected).owner, holder);
    }
  }
});

test('event/self/attacker absence is explicit no target; malformed requested references do not coerce or run getters', () => {
  for (const target of ['event', 'attacker']) {
    for (const event of [undefined, null, {}, { subjectId: null }, { cause: null }, { cause: {} }, { cause: { source: null } }]) {
      const ctx = context([1, 2, 3]);
      if (event === undefined) delete ctx.event; else ctx.event = event;
      assert.deepEqual(healingWindow(ctx, action({ target })).targets, []);
    }
  }
  for (const pokemonId of [undefined, null]) {
    const ctx = context([1]);
    if (pokemonId === undefined) delete ctx.source.pokemonId; else ctx.source.pokemonId = pokemonId;
    assert.deepEqual(healingWindow(ctx, action({ target: 'self' })).targets, []);
  }
  for (const [target, event] of [
    ['event', false], ['event', 1], ['event', { subjectId: 0 }], ['attacker', { cause: true }],
    ['attacker', { cause: { source: false } }], ['attacker', { cause: { source: {} } }],
    ['attacker', { cause: { source: { pokemonId: null } } }],
    ['attacker', { cause: { source: { pokemonId: [] } } }],
  ]) {
    const ctx = context([1]); ctx.event = event;
    if (target === 'attacker' && event.cause?.source && [undefined, null].includes(event.cause.source.pokemonId))
      assert.deepEqual(healingWindow(ctx, action({ target })).targets, []);
    else rejects(() => healingWindow(ctx, action({ target })));
  }
  const badSelf = context([1]); badSelf.source.pokemonId = false;
  rejects(() => healingWindow(badSelf, action({ target: 'self' })));
  let calls = 0;
  const ctx = context([1]);
  Object.defineProperty(ctx.event, 'subjectId', { enumerable: true, get() { calls++; throw new Error('event getter'); } });
  rejects(() => healingWindow(ctx, action({ target: 'event' })));
  const cycle = context([1]); cycle.event.cause.source = cycle.event;
  rejects(() => healingWindow(cycle, action({ target: 'attacker' })));
  assert.equal(calls, 0);
});

test('selector name/stage/HP stay printed, but type filters require CURRENT explicit types with no printed fallback', () => {
  const ctx = context([1, 2, 3], 0, 'attack');
  const expected = [
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
    assert.deepEqual(healingWindow(ctx, action({ selector })).targets.map((entry) => entry.pokemonId), ids);
  assert.deepEqual(ctx, before);
  for (const types of [undefined, null, [], ['Bogus'], ['Water', 'Water']]) {
    const bad = context([1]); bad.effectivePokemon['m0:0'].types = types;
    rejects(() => healingWindow(bad, action()));
  }
  const missing = context([1]); delete missing.effectivePokemon['m0:0'];
  rejects(() => healingWindow(missing, action()));
});

test('does not inspect hidden zones, unrequested actor/event facts, HP caches, attachments or protection, even for all/compound healing', () => {
  const ctx = context([2, 3]), a = action({ amount: 'all', discardHealedEnergy: true });
  let calls = 0;
  const poison = (record, key) => Object.defineProperty(record, key, {
    enumerable: true, configurable: true, get() { calls++; throw new Error(`Unrequested ${key}`); },
  });
  for (const key of ['current', 'rng', 'battleHistory']) poison(ctx.state, key);
  for (const player of ctx.state.players) for (const key of ['hand', 'deck', 'prizes', 'discard']) poison(player, key);
  poison(ctx, 'event'); poison(ctx.source, 'pokemonId');
  poison(ctx.definitions, 'unused:private-card');
  poison(ctx.state.cards, 'unused:hidden-card');
  for (const mon of mons(ctx)) {
    for (const key of ['currentHp', 'maximumHp', 'energy', 'tools', 'conditions', 'facts']) poison(mon, key);
    poison(ctx.effectivePokemon[mon.id], 'maximumHp');
    poison(ctx.effectivePokemon[mon.id], 'currentHp');
    if (mon.stack.length > 1) poison(ctx.definitions, 'unused:base-face');
  }
  const plan = planPokemonHealing(ctx, a, ['m0:0', 'm0:1']);
  assert.deepEqual(plan.healed, ['m0:0', 'm0:1']); assert.equal(plan.performed, true);
  assert.equal(calls, 0);
});

test('blocked must be a unique subset of unique eligible chosen Pokémon; it is not an eligibility or use-permission override', () => {
  const ctx = context([1, 2]), a = action();
  for (const chosen of [undefined, null, false, 'm0:0', {}, [1], [''], ['c0:0:top'], ['m1:0'],
    ['m0:0', 'm0:0'], ['m0:0', 'missing']])
    rejects(() => planPokemonHealing(ctx, a, chosen));
  for (const blocked of [null, false, 'm0:0', {}, [1], [''], ['m0:0', 'm0:0'], ['m1:0'], ['missing']])
    rejects(() => planPokemonHealing(ctx, a, ['m0:0', 'm0:1'], blocked));
  rejects(() => planPokemonHealing(ctx, action({ selection: { kind: 'exact', count: 1 } }), ['m0:0'], ['m0:1']));
  assert.equal(planPokemonHealing(ctx, a, ['m0:0', 'm0:1'], ['m0:0', 'm0:1']).performed, false);
  assert.equal(canUsePokemonHealing(ctx, a), true);
});

test('context rejects missing/foreign identities, duplicate Pokémon/physical stacks, empty stacks and unsafe runtime counters', () => {
  const paths = [
    [['source'], null], [['source', 'owner'], 2], [['source', 'owner'], '0'],
    [['source', 'category'], 'unknown'], [['state', 'players'], []], [['state', 'cards'], null],
    [['definitions'], []], [['effectivePokemon'], null], [['state', 'players', 0, 'active'], false],
    [['state', 'players', 0, 'bench'], null], [['state', 'players', 0, 'active', 'id'], ''],
    [['state', 'players', 0, 'active', 'stack'], []],
    [['state', 'cards', 'c0:0:top', 'instanceId'], 'alias'], [['state', 'cards', 'c0:0:top', 'owner'], 1],
    [['state', 'cards', 'c0:0:top', 'definitionId'], ''],
    [['definitions', 'fixture:face0'], null], [['definitions', 'fixture:face0', 'mechanics', 'hp'], 61],
  ];
  for (const [path, value] of paths) {
    const ctx = context([1, 2]); setAt(ctx, path, value);
    rejects(() => healingWindow(ctx, action()));
  }
  for (const counters of [-1, 0.5, Number.MAX_SAFE_INTEGER, MAX_COUNTERS + 1, NaN, Infinity, null, false, '2', 1n]) {
    const ctx = context([1]); ctx.state.players[0].active.counters = counters;
    rejects(() => healingWindow(ctx, action()));
  }
  const duplicate = context([1, 2]); duplicate.state.players[0].bench[0].id = 'm0:0';
  rejects(() => healingWindow(duplicate, action()));
  const crossStack = context([1, 2]); crossStack.state.players[0].bench[0].stack[0] = 'c0:0:top';
  rejects(() => healingWindow(crossStack, action()));
  const doubleStack = context([1]); doubleStack.state.players[0].active.stack.push('c0:0:top');
  rejects(() => healingWindow(doubleStack, action()));
  const nonPokemon = context([1]); nonPokemon.definitions['fixture:face0'] = {
    ...printed(0), kind: 'trainer', mechanics: { category: 'item', effects: [] },
  };
  rejects(() => healingWindow(nonPokemon, action()));
  const alias = context([1]); alias.definitions['fixture:face0'].definitionId = 'fixture:alias';
  rejects(() => healingWindow(alias, action()));
});

test('required context fields are own enumerable plain data; null-prototype records work without inherited/getter defaults', () => {
  let calls = 0;
  const paths = [
    ['source'], ['source', 'owner'], ['source', 'category'], ['state'], ['state', 'players'], ['definitions'],
    ['effectivePokemon'], ['state', 'players', 0, 'active'], ['state', 'players', 0, 'bench'],
    ['state', 'players', 0, 'active', 'counters'], ['state', 'players', 0, 'active', 'stack'],
    ['state', 'cards', 'c0:0:top'], ['state', 'cards', 'c0:0:top', 'definitionId'],
    ['definitions', 'fixture:face0', 'mechanics', 'types'], ['effectivePokemon', 'm0:0', 'types'],
  ];
  for (const path of paths) for (const mode of ['getter', 'hidden', 'missing', 'inherited']) {
    const ctx = context([1]), parentPath = path.slice(0, -1), parent = getAt(ctx, parentPath), key = path.at(-1);
    const value = parent[key];
    if (mode === 'getter') Object.defineProperty(parent, key, { enumerable: true, get() { calls++; throw new Error('getter'); } });
    else if (mode === 'hidden') Object.defineProperty(parent, key, { value, enumerable: false });
    else if (mode === 'missing') delete parent[key];
    else {
      const inherited = Object.assign(Object.create({ [key]: value }), parent); delete inherited[key];
      if (parentPath.length) setAt(ctx, parentPath, inherited); else Object.setPrototypeOf(ctx, { [key]: value }), delete ctx[key];
    }
    rejects(() => healingWindow(ctx, action()));
  }
  assert.equal(calls, 0);
  const ctx = context([1]);
  ctx.source = Object.assign(Object.create(null), ctx.source);
  ctx.state.cards = Object.assign(Object.create(null), ctx.state.cards);
  ctx.effectivePokemon = Object.assign(Object.create(null), ctx.effectivePokemon);
  const a = Object.assign(Object.create(null), action());
  assert.equal(assertPokemonHealingAction(a), a);
  assert.equal(planPokemonHealing(ctx, a, ['m0:0']).performed, true);
});

test('saved plans validate exact original counters, selected order, actual removals and protection masks, not claimed results', () => {
  const ctx = context([1, 3]), a = action(), plan = planPokemonHealing(ctx, a, ['m0:1', 'm0:0'], ['m0:0']);
  const before = clone({ ctx, a, plan });
  assert.equal(assertPokemonHealingPlan(ctx, a, plan, ['m0:0']), plan);
  const changes = [
    (p) => { p.owner = 1; }, (p) => { p.performed = false; }, (p) => { p.healed = []; },
    (p) => { p.healed = ['m0:0']; }, (p) => { p.updates.pop(); },
    (p) => { p.updates.reverse(); }, (p) => { p.updates[0].beforeCounters = 2; },
    (p) => { p.updates[0].afterCounters = 0; }, (p) => { p.updates[0].removedCounters = 3; },
    (p) => { p.updates[0].pokemonId = 'm0:0'; }, (p) => { p.selected.reverse(); },
  ];
  for (const change of changes) {
    const forged = clone(plan); change(forged);
    rejects(() => assertPokemonHealingPlan(ctx, a, forged, ['m0:0']));
  }
  rejects(() => assertPokemonHealingPlan(ctx, a, plan, []));
  const changed = clone(ctx); changed.state.players[0].bench[0].counters++;
  rejects(() => assertPokemonHealingPlan(changed, a, plan, ['m0:0']));
  const typed = action({ selector: { kind: 'pokemon', types: ['Water'] } });
  const typedPlan = planPokemonHealing(ctx, typed, ['m0:1']);
  const changedTypes = clone(ctx); changedTypes.effectivePokemon['m0:1'].types = ['Fire'];
  rejects(() => assertPokemonHealingPlan(changedTypes, typed, typedPlan));
  const reordered = clone(plan);
  reordered.updates = reordered.updates.map((u) => ({
    removedCounters: u.removedCounters, pokemonId: u.pokemonId,
    afterCounters: u.afterCounters, beforeCounters: u.beforeCounters,
  }));
  assert.equal(assertPokemonHealingPlan(ctx, a, reordered, ['m0:0']), reordered, 'JSON property order is not a game rule.');
  assert.deepEqual({ ctx, a, plan }, before);
});

test('action schema and pure validation reject missing/extra fields, unsafe amounts, unit aliases and unsupported selection/selector forms', () => {
  const invalid = [
    null, false, 0, '', [], {}, { ...action(), op: 'heal' }, action({ side: 'both' }), action({ target: 'opponent' }),
    action({ discardHealedEnergy: 1 }), action({ selector: null }), action({ selector: { kind: 'any' } }),
    action({ selector: { kind: 'energy' } }), action({ selector: { kind: 'pokemon', currentHpAtMost: 10 } }),
    action({ selector: { anyOf: [{ kind: 'pokemon' }, { kind: 'energy' }] } }),
    action({ selector: { anyOf: [{ kind: 'pokemon', stages: ['basic'] }, { kind: 'pokemon', stages: ['basic'] }] } }),
    action({ selection: null }), action({ selection: [] }), action({ selection: {} }),
    action({ selection: { kind: 'all', count: 1 } }), action({ selection: { kind: 'any' } }),
    action({ selection: { kind: 'exact' } }), action({ selection: { kind: 'unknown', count: 1 } }),
    ...[0, -1, 0.5, '1', false, null, Number.MAX_SAFE_INTEGER + 1].map((count) => action({ selection: { kind: 'upTo', count } })),
    ...[0, -10, 1, 11, 10.5, MAX_HP + 1, MAX_HP + 10, 'ALL', false, null].map((amount) => action({ amount })),
    ...['count', 'counterCount', 'currentHp', 'maximumHp', 'energy', 'blocked', 'approved']
      .map((key) => action({ [key]: 1 })),
    ...Object.keys(action()).map((key) => { const a = action(); delete a[key]; return a; }),
  ];
  for (const a of invalid) {
    checkActionSchemas(a, false);
    rejects(() => assertPokemonHealingAction(a));
  }
  for (const amount of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('amount'), () => 10])
    rejects(() => assertPokemonHealingAction(action({ amount })));
  for (const count of [undefined, NaN, Infinity, 1n])
    rejects(() => assertPokemonHealingAction(action({ selection: { kind: 'exact', count } })));
  for (const selection of selections) for (const amount of [10, MAX_HP, 'all']) {
    const a = freeze(action({ selection, amount }));
    checkActionSchemas(a, true); assert.equal(assertPokemonHealingAction(a), a);
  }
  // Printed alternatives of Pokémon (「宝可梦GX・EX」) are one Pokémon selector.
  const either = freeze(action({ selector: { anyOf: [{ kind: 'pokemon', tagsAll: ['GX'] }, { kind: 'pokemon', tagsAll: ['EX'] }] } }));
  checkActionSchemas(either, true); assert.equal(assertPokemonHealingAction(either), either);
});

test('plan schema/shape and semantic gate reject unknown fields, invalid IDs/updates/counts and lying healed/performed claims', () => {
  const ctx = context([1]), a = action(), valid = planPokemonHealing(ctx, a, ['m0:0']);
  const invalid = [
    null, false, 0, '', [], {}, { ...valid, owner: 2 }, { ...valid, performed: 1 },
    { ...valid, selected: ['m0:0', 'm0:0'] }, { ...valid, healed: ['m0:0', 'm0:0'] },
    { ...valid, updates: null }, { ...valid, updates: [null] }, { ...valid, updates: [{ pokemonId: 'm0:0' }] },
    ...Object.keys(valid).map((key) => { const p = clone(valid); delete p[key]; return p; }),
    ...['blocked', 'energyIds', 'topCardId', 'history', 'approved'].map((key) => ({ ...clone(valid), [key]: true })),
    ...['beforeCounters', 'afterCounters', 'removedCounters'].flatMap((key) =>
      [-1, 0.5, null, false, '1', MAX_COUNTERS + 1].map((value) => {
        const p = clone(valid); p.updates[0][key] = value; return p;
      })),
    { ...valid, updates: [{ ...valid.updates[0], pokemonId: '' }] },
  ];
  for (const plan of invalid) {
    assert.equal(schemaPlan(plan), false);
    rejects(() => assertPokemonHealingPlan(ctx, a, plan));
  }
  const nullProto = Object.assign(Object.create(null), valid);
  assert.equal(assertPokemonHealingPlan(ctx, a, nullProto), nullProto);
});

test('strict JSON rejects getter/hidden/symbol fields, sparse/custom arrays, instances and cycles without invoking code', () => {
  let calls = 0;
  const invalid = [new Date(), new Map(), Object.create(action()), Object.assign(new (class Action {})(), action())];
  for (const key of ['op', 'selector', 'selection', 'amount', 'unknown']) {
    const getter = action(); Object.defineProperty(getter, key, {
      enumerable: true, get() { calls++; throw new Error('AST getter'); },
    }); invalid.push(getter);
    const hidden = action(); Object.defineProperty(hidden, key, { value: 10, enumerable: false }); invalid.push(hidden);
  }
  const symbol = action(); symbol[Symbol('approval')] = true; invalid.push(symbol);
  const cycle = action(); cycle.selector = cycle; invalid.push(cycle);
  const sparse = new Array(1); invalid.push(action({ selector: { kind: 'pokemon', types: sparse } }));
  const fakeDense = new Array(1); fakeDense.extra = 'Water';
  invalid.push(action({ selector: { kind: 'pokemon', types: fakeDense } }));
  const getter = ['Water']; Object.defineProperty(getter, '0', {
    enumerable: true, get() { calls++; throw new Error('index getter'); },
  }); invalid.push(action({ selector: { kind: 'pokemon', types: getter } }));
  const hiddenIndex = ['Water']; Object.defineProperty(hiddenIndex, '0', { value: 'Water', enumerable: false });
  invalid.push(action({ selector: { kind: 'pokemon', types: hiddenIndex } }));
  invalid.push(action({ selector: { kind: 'pokemon', types: new (class Types extends Array {})('Water') } }));
  for (const a of invalid) rejects(() => assertPokemonHealingAction(a));
  const ctx = context([1]);
  const selected = ['m0:0']; selected[Symbol('extra')] = true;
  rejects(() => planPokemonHealing(ctx, action(), selected));
  const chosenCycle = []; chosenCycle.push(chosenCycle);
  rejects(() => planPokemonHealing(ctx, action(), chosenCycle));
  const planCycle = planPokemonHealing(ctx, action(), ['m0:0']); planCycle.updates = planCycle;
  rejects(() => assertPokemonHealingPlan(ctx, action(), planCycle));
  assert.equal(calls, 0);
});

test('results are detached without moving/freezing inputs, recording history, reading Energy or sampling RNG', () => {
  const ctx = context([1, 3]), a = action({ discardHealedEnergy: true });
  const chosen = ['m0:1', 'm0:0'], blocked = ['m0:0'], before = clone({ ctx, a, chosen, blocked });
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('No healing randomness.'); };
  let plan, window;
  try { window = healingWindow(ctx, a); plan = planPokemonHealing(ctx, a, chosen, blocked); }
  finally { Math.random = originalRandom; }
  assert.deepEqual({ ctx, a, chosen, blocked }, before);
  assert(!Object.isFrozen(ctx)); assert(!Object.isFrozen(a)); assert(!Object.isFrozen(chosen));
  assert(!Object.isFrozen(plan)); assert(!Object.isFrozen(plan.updates));
  window.targets[0].counters = 77; plan.selected.reverse(); plan.updates[0].afterCounters = 77; plan.healed.pop();
  assert.deepEqual({ ctx, a, chosen, blocked }, before);
  const plain = planPokemonHealing(ctx, action(), chosen, blocked);
  const compound = planPokemonHealing(ctx, a, chosen, blocked);
  assert.deepEqual(compound, plain, 'Energy-stage flag cannot change counter results.');
  assert.deepEqual(Object.keys(compound).sort(), ['healed', 'owner', 'performed', 'selected', 'updates']);
  assert.equal(new PokemonHealingError('test', 'test').ruleId, 'effects.heal-results');
});
