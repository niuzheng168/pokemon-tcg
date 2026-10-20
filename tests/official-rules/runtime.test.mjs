import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCondition, checkConditions, resolveConfusion, validateConditions, emptyConditions, CONDITION_RULE_IDS } from '../../public/rules/conditions.js';
import { validateRandomState, randomUint32, randomIndex, shuffleIds } from '../../public/rules/random.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { createCardCatalog, validateDeck, assertCatalog, canonicalJSON, sha256 } from '../../public/rules/catalog.js';
import { canonicalDefinition, canonicalPrinting, assertExecutableDefinition } from '../../public/rules/card-schema.js';
import { fixture, RULESET, EVIDENCE } from './fixtures.mjs';

test('rotation conditions overwrite each other, not poison/burn, and a new poison replaces its intensity', () => {
  let c = emptyConditions();
  c = applyCondition(c, 'poisoned', { poisonCounters: 4 }).conditions;
  c = applyCondition(c, 'burned').conditions;
  for (const name of ['asleep', 'confused', 'paralyzed']) {
    c = applyCondition(c, name, { ownerTurn: 2 }).conditions;
    assert.equal(c.rotation, name); assert.equal(c.poison, 4); assert(c.burned);
  }
  assert.equal(c.paralysisRecoverTurn, 3);
  c = applyCondition(c, 'poisoned').conditions;
  assert.equal(c.poison, 1);
  for (const id of CONDITION_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
});

test('checkup status group order, damage before recovery, maximum burn change and delayed paralysis', () => {
  let c = applyCondition(emptyConditions(), 'poisoned', { poisonCounters: 4 }).conditions;
  c = applyCondition(c, 'burned').conditions;
  c = applyCondition(c, 'asleep').conditions;
  const before = structuredClone(c), coins = [true, false];
  const r = checkConditions(c, { ownerTurn: 3, ownerIsEndingPlayer: false, flip: () => coins.shift(), burnCounterChanges: [4, 6, 4] });
  assert.equal(r.counters, 10); assert(!r.conditions.burned); assert.equal(r.conditions.rotation, 'asleep');
  assert.deepEqual(c, before);
  assert.deepEqual(r.trace.map((e) => e.ruleId), ['status.poison', 'status.burn', 'status.sleep']);
  const awake = checkConditions(r.conditions, { ownerTurn: 3, ownerIsEndingPlayer: true, flip: () => true });
  assert.equal(awake.conditions.rotation, null);
  const p = applyCondition(emptyConditions(), 'paralyzed', { ownerTurn: 3 }).conditions;
  assert.equal(checkConditions(p, { ownerTurn: 3, ownerIsEndingPlayer: true, flip: () => false }).conditions.rotation, 'paralyzed');
  assert.equal(checkConditions(p, { ownerTurn: 4, ownerIsEndingPlayer: false, flip: () => false }).conditions.rotation, 'paralyzed');
  assert.equal(checkConditions(p, { ownerTurn: 4, ownerIsEndingPlayer: true, flip: () => false }).conditions.rotation, null);
  const burn = applyCondition(emptyConditions(), 'burned').conditions;
  assert.equal(checkConditions(burn, { ownerTurn: 1, ownerIsEndingPlayer: true, flip: () => false }).counters, 2);
  assert.equal(checkConditions(burn, { ownerTurn: 1, ownerIsEndingPlayer: true, flip: () => false, burnCounterChanges: [1] }).counters, 1);
});

test('confusion is not regular damage, and failed confusion is not a used attack', () => {
  const c = applyCondition(emptyConditions(), 'confused').conditions;
  const failed = resolveConfusion(c, false);
  assert.equal(failed.selfCounters, 3); assert(!failed.succeeded);
  assert.equal(failed.trace[0].countsAsUsed, false);
  assert(resolveConfusion(c, true).succeeded);
  assert.deepEqual(resolveConfusion(emptyConditions()), { succeeded: true, selfCounters: 0, trace: [] });
  assert.throws(() => resolveConfusion(c, 'heads'), TypeError);
});

test('condition boundaries reject malformed data instead of silently recovering it', () => {
  for (const changed of [null, { ...emptyConditions(), rotation: 'frozen' }, { ...emptyConditions(), poison: 0 },
    { ...emptyConditions(), burned: 1 }, { ...emptyConditions(), rotation: 'paralyzed' },
    { ...emptyConditions(), paralysisRecoverTurn: 1 }]) assert.throws(() => validateConditions(changed), TypeError);
  assert.throws(() => applyCondition(emptyConditions(), 'unknown'), TypeError);
  assert.throws(() => applyCondition(emptyConditions(), 'poisoned', { poisonCounters: 0 }), TypeError);
  assert.throws(() => applyCondition(emptyConditions(), 'paralyzed', { ownerTurn: -1 }), TypeError);
  assert.throws(() => checkConditions(emptyConditions(), { ownerTurn: -1, ownerIsEndingPlayer: true, flip: () => true }), TypeError);
  assert.throws(() => checkConditions(emptyConditions(), { ownerTurn: 0, ownerIsEndingPlayer: true, flip: () => true, burnCounterChanges: [-1] }), TypeError);
  assert.throws(() => checkConditions(applyCondition(emptyConditions(), 'burned').conditions, {
    ownerTurn: 1, ownerIsEndingPlayer: true, flip: () => 'heads',
  }), TypeError);
});

test('private local RNG has reproducible continuation, no out-of-range results and permutation conservation', () => {
  const a = [1, 2, 3, 4], b = [...a];
  for (let i = 0; i < 100; i++) assert.equal(randomUint32(a), randomUint32(b));
  const resumed = JSON.parse(JSON.stringify(a));
  assert.equal(randomUint32(a), randomUint32(resumed));
  for (const maximum of [1, 2, 3, 60, 65537, 0x100000000])
    for (let i = 0; i < 100; i++) { const v = randomIndex(a, maximum); assert(v >= 0 && v < maximum); }
  const ids = Array.from({ length: 60 }, (_, i) => `id${i}`), shuffled = shuffleIds(a, [...ids]);
  assert.equal(new Set(shuffled).size, 60); assert.deepEqual([...shuffled].sort(), [...ids].sort());
  assert.notDeepEqual(shuffled, ids);
  for (const state of [null, [], [0, 0, 0, 0], [-1, 2, 3, 4], [1.5, 2, 3, 4]]) assert.throws(() => validateRandomState(state), TypeError);
  for (const maximum of [0, -1, 1.5, Infinity, 0x100000001]) assert.throws(() => randomIndex(a, maximum), TypeError);
});

test('catalog identity is order independent and detachments do not mutate approved definitions or handlers', async () => {
  const f = await fixture();
  const defs = structuredClone(f.definitions).reverse(), printings = f.catalog.printings().reverse();
  const approvals = new Map(defs.map((d) => [d.definitionId, canonicalDefinition(d)]));
  const copy = await createCardCatalog({ ruleset: RULESET, definitions: defs, printings, approvedDefinitions: approvals,
    approvedPrintings: new Map(printings.map((p) => [p.printingId, canonicalPrinting(p)])), handlers: f.handlers });
  assert.equal(copy.id, f.catalog.id);
  defs[0].name = 'changed';
  f.handlers.clear();
  assert(copy.handler('cn.draw@1'));
  assert(copy.definitionFor('printing:base'));
  assert.equal(canonicalJSON({ b: 1, a: { z: 2, a: 1 } }), canonicalJSON({ a: { a: 1, z: 2 }, b: 1 }));
  assert.equal((await sha256('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(() => assertCatalog({}), TypeError);
  assert.throws(() => copy.definition('unknown'));
  assert.throws(() => copy.printing('unknown'));
  assert.throws(() => copy.definitionFor('unknown'));
  assert.throws(() => copy.handler('unknown'));
});

test('deck limits aggregate same names across printings, require a Basic and enforce groups', async () => {
  const f = await fixture();
  validateDeck(f.catalog, f.deck);
  assert.throws(() => validateDeck(f.catalog, f.deck.slice(1)), /exactly 60/);
  assert.throws(() => validateDeck(f.catalog, Array(60).fill('printing:water')), /Basic Pokémon/);
  const excessive = [...f.deck]; excessive.splice(0, 5, ...Array(5).fill('printing:base'));
  assert.throws(() => validateDeck(f.catalog, excessive), /Too many copies/);
  const grouped = await fixture((defs) => {
    for (const id of ['base', 'other']) defs.find((d) => d.definitionId === id).deckLimits.groups =
      [{ key: 'fixture:radiant', maximum: 1, sourceOfTruth: EVIDENCE }];
  });
  assert.throws(() => validateDeck(grouped.catalog, grouped.deck), /Grouped deck limit/);
  const conflicted = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').deckLimits.groups = [{ key: 'group', maximum: 1, sourceOfTruth: EVIDENCE }];
    defs.find((d) => d.definitionId === 'other').deckLimits.groups = [{ key: 'group', maximum: 2, sourceOfTruth: EVIDENCE }];
  });
  assert.throws(() => validateDeck(conflicted.catalog, conflicted.deck), /Conflicting grouped/);
});

test('same-name inconsistent limits and conflicting identity mappings do not enter normal play', async () => {
  const f = await fixture();
  const defs = structuredClone(f.definitions), other = structuredClone(defs.find((d) => d.definitionId === 'base'));
  other.definitionId = 'base-reprint'; other.deckLimits.sameName = 3; defs.push(other);
  const printings = f.catalog.printings();
  printings.push({ ...structuredClone(printings[0]), printingId: 'printing:base-reprint',
    definitionBindings: [{ ruleset: RULESET, definitionId: other.definitionId, sourceOfTruth: EVIDENCE }] });
  const make = () => createCardCatalog({ ruleset: RULESET, definitions: defs, printings,
    approvedDefinitions: new Map(defs.map((d) => [d.definitionId, canonicalDefinition(d)])),
    approvedPrintings: new Map(printings.map((p) => [p.printingId, canonicalPrinting(p)])), handlers: f.handlers });
  const c = await make(), deck = [...f.deck]; deck[1] = 'printing:base-reprint';
  assert.throws(() => validateDeck(c, deck), /Conflicting limits/);
  other.name = '不同名称仍共用同名key';
  await assert.rejects(make(), /conflicting name identities/);
  other.nameKey = 'different-name-key'; other.name = defs[0].name;
  await assert.rejects(make(), /conflicting name identities/);
});

test('catalog rejects duplicate identities and unknown definition links', async () => {
  const f = await fixture(), approvals = new Map(f.definitions.map((d) => [d.definitionId, canonicalDefinition(d)]));
  await assert.rejects(createCardCatalog({ ruleset: RULESET, definitions: [...f.definitions, f.definitions[0]], printings: [],
    approvedDefinitions: approvals, handlers: f.handlers }), /Duplicate definition/);
  const printings = f.catalog.printings();
  await assert.rejects(createCardCatalog({ ruleset: RULESET, definitions: f.definitions, printings: [printings[0], printings[0]],
    approvedDefinitions: approvals, approvedPrintings: new Map([[printings[0].printingId, canonicalPrinting(printings[0])]]),
    handlers: f.handlers }), /Duplicate printing/);
  const bad = structuredClone(printings[0]); bad.definitionBindings[0].definitionId = 'missing';
  await assert.rejects(createCardCatalog({ ruleset: RULESET, definitions: f.definitions, printings: [bad],
    approvedDefinitions: approvals, handlers: f.handlers }), /no executable definition/);
});
