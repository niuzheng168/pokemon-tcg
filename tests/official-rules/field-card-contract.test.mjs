import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCardDefinition, validateEffectProgram, validateContinuousEffect,
  validateProtectionParameters, validateLastingParameters, validateOngoingEffect,
} from '../../public/rules/schema-validators.js';
import {
  canonicalDefinition, canonicalPrinting, assertDefinitionShape, assertPrintingShape,
  assertExecutableDefinition, CardSchemaError,
} from '../../public/rules/card-schema.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { createOngoingEffect, assertOngoingEffect } from '../../public/rules/ongoing.js';
import { createCardCatalog, canonicalJSON, sha256 } from '../../public/rules/catalog.js';
import { catalogCandidateFacts, loadReviewedCatalogRelease, CatalogReleaseError } from '../../public/rules/catalog-release.js';
import { fixture, board, hand, binding, RULESET, EVIDENCE } from './fixtures.mjs';

// Synthetic contracts only. No real cards, production approvals, trust pins or I/O.
// Runtime ownership/disposal is tested elsewhere; callers cannot supply its destination here.
const without = (value, ...keys) => {
  const result = structuredClone(value);
  for (const key of keys) delete result[key];
  return result;
};
const discard = (extra = {}) => ({
  op: 'discardStadium', side: 'either', selector: { kind: 'trainer', categories: ['stadium'] }, ...extra,
});
const shield = (extra = {}) => ({
  op: 'stadiumProtection', scope: 'self', channel: 'effects', useRule: 'ordinary',
  from: 'opponent', categories: ['trainer'], ...extra,
});
const handShield = (extra = {}) => shield({
  useRule: 'CN.E29', trainerOrigins: ['hand'], trainerCategories: ['item', 'supporter'], ...extra,
});
const definition = (kind = 'trainer', category = 'stadium', prism = false) => structuredClone({
  schemaVersion: '1.0.0', definitionId: `fixture:field-contract:${kind}:${category}`, ruleset: RULESET,
  name: `测试用虚构卡${kind}${category}`, nameKey: `fixture:field-contract:${kind}:${category}`, kind,
  sourceOfTruth: EVIDENCE, ...(prism ? { prismStar: { sourceOfTruth: EVIDENCE } } : {}),
  implementation: { status: 'verified', testIds: ['fixture:field-card-contract'] },
  deckLimits: { sameName: prism ? 1 : 4, groups: [] },
  mechanics: kind === 'pokemon' ? {
    stage: 'basic', evolvesFrom: null, hp: 100, types: ['Water'], weakness: null, resistance: null,
    retreatCost: 1, attacks: [], abilities: [], ruleBox: true, prizeCount: 1, tags: [], effects: [],
  } : kind === 'energy' ? { category: 'special', baseUnits: [['Water']], effects: [] } :
    { category, effects: [] },
});
const approval = (card, handlers = createCoreHandlers()) => ({
  ruleset: RULESET, handlers, approvedDefinitions: new Map([[card.definitionId, canonicalDefinition(card)]]),
});
const releaseError = (code) => (error) => error instanceof CatalogReleaseError && error.code === code;
async function releaseFixture() {
  const handlers = createCoreHandlers(), pokemon = definition('pokemon'), stadium = definition('trainer', 'stadium', true);
  stadium.mechanics.effects = [binding('cn.stadiumProtection@1', { effect: handShield({ useRule: 'ordinary' }) })];
  const definitions = [pokemon, stadium], printings = definitions.map((card, index) => ({
    schemaVersion: '1.0.0', printingId: `printing:${card.definitionId}`, game: 'tcg', language: 'zh-Hans',
    setCode: 'TEST-NOT-A-REAL-SET', number: `${index + 1}/999`, regulationMark: 'G', identityReview: 'verified',
    definitionBindings: [{ ruleset: RULESET, definitionId: card.definitionId, sourceOfTruth: EVIDENCE }], metadataRefs: [],
  }));
  const facts = await catalogCandidateFacts({ ruleset: RULESET, definitions, printings, handlers });
  const manifest = { schemaVersion: '1.0.0', releaseId: 'fixture:field-card-release', ...facts, review: {
    reviewId: 'fixture:review', reviewerId: 'fixture:synthetic-reviewer', reviewedOn: '2026-10-20',
    testIds: ['fixture:field-card-contract'], sourceOfTruth: EVIDENCE,
  } };
  return { data: structuredClone({ manifest, definitions, printings }), handlers,
    trustedReleases: new Map([[manifest.releaseId, await sha256(canonicalJSON(manifest))]]) };
}
const load = (data, { handlers, trustedReleases }) =>
  loadReviewedCatalogRelease({ json: JSON.stringify(data), handlers, trustedReleases });

test('Prism Star is an explicit optional printed rule, never inferred from the name diamond', () => {
  for (const kind of ['pokemon', 'trainer', 'energy']) {
    const plain = definition(kind), before = structuredClone(plain);
    plain.name += '◇';
    assert.equal(validateCardDefinition(plain), true);
    assert.equal(Object.hasOwn(plain, 'prismStar'), false);
    assert.equal(plain.deckLimits.sameName, 4);
    assert.deepEqual(without(plain, 'name'), without(before, 'name'));
    assert.equal(validateCardDefinition(definition(kind, 'stadium', true)), true);
  }
});

test('Prism Star requires strict evidence, same-name one, Basic Rule-Box Pokemon or Special Energy', () => {
  for (const value of [true, false, null, {}, { sourceOfTruth: [] },
    { sourceOfTruth: EVIDENCE, approved: true }, { sourceOfTruth: EVIDENCE, destination: 'lost' }]) {
    const card = definition('trainer', 'stadium', true); card.prismStar = value;
    assert.equal(validateCardDefinition(card), false, JSON.stringify(value));
  }
  for (const kind of ['pokemon', 'trainer', 'energy']) for (const sameName of [null, 2, 4]) {
    const card = definition(kind, 'stadium', true); card.deckLimits.sameName = sameName;
    assert.equal(validateCardDefinition(card), false, `${kind}: sameName ${sameName}`);
  }
  for (const extra of [{ stage: 'stage1', evolvesFrom: 'fixture:parent' }, { ruleBox: false }]) {
    const card = definition('pokemon', 'stadium', true); Object.assign(card.mechanics, extra);
    assert.equal(validateCardDefinition(card), false);
  }
  const energy = definition('energy', 'stadium', true); energy.mechanics.category = 'basic';
  assert.equal(validateCardDefinition(energy), false);
  const nested = definition(); nested.mechanics.prismStar = { sourceOfTruth: EVIDENCE };
  assert.equal(validateCardDefinition(nested), false, 'classification belongs at the definition root');
});

test('Prism Star addition/removal changes independent content approval and still needs card-specific evidence', () => {
  for (const prism of [false, true]) {
    const card = definition('trainer', 'stadium', prism); card.deckLimits.sameName = 1;
    const context = approval(card), accepted = assertExecutableDefinition(card, context);
    const changed = structuredClone(card);
    if (prism) delete changed.prismStar;
    else changed.prismStar = { sourceOfTruth: structuredClone(EVIDENCE) };
    assert.equal(validateCardDefinition(changed), true);
    assert.notEqual(canonicalDefinition(changed), canonicalDefinition(card));
    assert.throws(() => assertExecutableDefinition(changed, context), /independent approval|changed since review/);
    assert.equal(Object.hasOwn(accepted, 'prismStar'), prism);
    if (prism) assert(Object.isFrozen(accepted.prismStar));
  }
  const general = definition('trainer', 'stadium', true);
  general.prismStar.sourceOfTruth = EVIDENCE.map((source) => ({ ...source, kind: 'official-rule' }));
  assert.equal(validateCardDefinition(general), true, 'shape is not classification approval');
  assert.throws(() => assertExecutableDefinition(general, approval(general)),
    (error) => error instanceof CardSchemaError && /Prism Star.*card-specific/i.test(error.message));
});

test('strict JSON gates reject pin-invisible definition/printing changes without getters, while null-prototype JSON keeps old pins', async () => {
  const f = await fixture(), printings = f.catalog.printings();
  const context = {
    ruleset: RULESET, handlers: f.handlers,
    approvedDefinitions: new Map(f.definitions.map((card) => [card.definitionId, canonicalDefinition(card)])),
    approvedPrintings: new Map(printings.map((printing) => [printing.printingId, canonicalPrinting(printing)])),
  };
  const card = f.definitions.find((value) => value.definitionId === 'stadium');
  const printing = printings.find((value) => value.printingId === 'printing:stadium');
  const catalog = (changedCard = card, changedPrinting = printing) => createCardCatalog({
    ...context,
    definitions: f.definitions.map((value) => value.definitionId === card.definitionId ? changedCard : value),
    printings: printings.map((value) => value.printingId === printing.printingId ? changedPrinting : value),
  });
  assert.equal((await catalog()).id, f.catalog.id, 'the unchanged old-pin catalog is a valid control');
  let getterReads = 0;
  for (const [kind, original, optional, evidence, shape, canonical] of [
    ['definition', card, 'prismStar', (value) => value.sourceOfTruth[0], assertDefinitionShape, canonicalDefinition],
    ['printing', printing, 'releasedOn', (value) => value.definitionBindings[0].sourceOfTruth[0], assertPrintingShape, canonicalPrinting],
  ]) {
    const originalPin = canonical(original);
    const mutations = [
      ['optional undefined', (value) => { value[optional] = undefined; }],
      ['nested undefined', (value) => { evidence(value).observedOn = undefined; }],
      ['getter', (value) => Object.defineProperty(value, optional, {
        enumerable: true, get() { getterReads++; return undefined; },
      })],
      ['nested getter', (value) => Object.defineProperty(evidence(value), 'observedOn', {
        enumerable: true, get() { getterReads++; return '2026-10-20'; },
      })],
      ['hidden field', (value) => Object.defineProperty(value, optional, { value: undefined })],
      ['symbol field', (value) => { value[Symbol('fixture:hidden')] = true; }],
      ['sparse array', (value) => { value.metadataRefs = Array(1); }],
      ['cyclic field', (value) => { evidence(value).observedOn = value; }],
      ['NaN', (value) => { evidence(value).observedOn = NaN; }],
      ['Infinity', (value) => { evidence(value).observedOn = Infinity; }],
    ];
    for (const [label, mutate] of mutations) {
      const changed = structuredClone(original); mutate(changed);
      if (label === 'optional undefined') {
        assert(Object.hasOwn(changed, optional));
        assert.equal(Object.getOwnPropertyDescriptor(changed, optional).value, undefined);
      }
      assert.throws(() => shape(changed), CardSchemaError, `${kind}: ${label} shape`);
      assert.throws(() => canonical(changed), CardSchemaError, `${kind}: ${label} cannot reuse a canonical pin`);
      if (kind === 'definition')
        assert.throws(() => assertExecutableDefinition(changed, context), CardSchemaError, label);
      await assert.rejects(kind === 'definition' ? catalog(changed) : catalog(card, changed),
        CardSchemaError, `${kind}: ${label} must fail the complete old-pin catalog path`);
      assert.equal(getterReads, 0, 'reject before validators, cloning or canonicalization can invoke a getter');
      assert.equal(canonical(original), originalPin, 'the original approved value is not mutated');
    }
  }
  const nullRecords = (value) => Array.isArray(value) ? value.map(nullRecords) :
    value && typeof value === 'object' ?
      Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nullRecords(item)]))) : value;
  const nullCard = nullRecords(card), nullPrinting = nullRecords(printing);
  assert.equal(Object.getPrototypeOf(nullCard), null);
  assert.equal(Object.getPrototypeOf(nullPrinting.definitionBindings[0]), null);
  assert.equal(assertDefinitionShape(nullCard), nullCard);
  assert.equal(assertPrintingShape(nullPrinting), nullPrinting);
  assert.equal(canonicalDefinition(nullCard), context.approvedDefinitions.get(card.definitionId));
  assert.equal(canonicalPrinting(nullPrinting), context.approvedPrintings.get(printing.printingId));
  assertExecutableDefinition(nullCard, context);
  assert.equal((await catalog(nullCard, nullPrinting)).id, f.catalog.id);
  assert.equal(getterReads, 0);
});

test('discardStadium is a complete native action with explicit side and printed Stadium-only selector', () => {
  const handler = createCoreHandlers().get('cn.discardStadium@1');
  for (const side of ['either', 'own', 'opponent']) {
    const action = discard({ side }), before = structuredClone(action);
    assert.equal(validateEffectProgram([action]), true);
    assert.equal(handler.validateParameters(action), true);
    assert.deepEqual(handler.execute(null, action), [action]);
    assert.deepEqual(action, before);
  }
  assert.equal(validateEffectProgram([{ op: 'optional', effect: discard() }]), true);
});

test('discardStadium rejects missing fields, broad selectors and Pokemon or non-Stadium predicates', () => {
  const handler = createCoreHandlers().get('cn.discardStadium@1');
  const invalid = ['op', 'side', 'selector'].map((key) => without(discard(), key));
  for (const side of ['both', 'all', 0, null]) invalid.push(discard({ side }));
  for (const selector of [{ kind: 'any' }, { kind: 'pokemon' }, { kind: 'energy' },
    { kind: 'trainer' }, { kind: 'trainer', categories: [] }, { kind: 'trainer', categories: ['tool'] },
    { kind: 'trainer', categories: ['stadium', 'item'] }, { kind: 'trainer', categories: ['stadium', 'stadium'] },
    { anyOf: [{ kind: 'trainer', categories: ['stadium'] }, { kind: 'trainer', categories: ['item'] }] },
    { kind: 'trainer', categories: ['stadium'], currentHpAtMost: 10 }])
    invalid.push(discard({ selector }));
  for (const action of invalid) {
    assert.equal(validateEffectProgram([action]), false, JSON.stringify(action));
    assert.equal(handler.validateParameters(action), false);
  }
});

test('discardStadium cannot accept client destinations, actors, live Pokemon state, RNG or field bypasses', () => {
  const handler = createCoreHandlers().get('cn.discardStadium@1');
  for (const extra of [{ destination: 'lost' }, { dest: 'discard' }, { to: 'opponentDiscard' },
    { owner: 1 }, { actor: 0 }, { targetPokemon: 'fixture:mon' }, { target: 'active' },
    { currentHp: 0 }, { rng: [1, 2, 3, 4] }, { stadiumId: 'fixture:chosen-by-client' },
    { ignoreProtection: true }, { approved: true }]) {
    const action = discard(extra);
    assert.equal(validateEffectProgram([action]), false);
    assert.equal(handler.validateParameters(action), false);
  }
});

test('native field handlers bind exact operations, timing, strict parameters and versioned schema contracts', () => {
  const handlers = createCoreHandlers();
  for (const [id, op, timing, parameters, emitted] of [
    ['cn.discardStadium@1', 'discardStadium', 'resolve', discard(), discard()],
    ['cn.stadiumProtection@1', 'stadiumProtection', 'continuous', { effect: shield() }, shield()],
  ]) {
    const handler = handlers.get(id);
    assert(handler && Object.isFrozen(handler));
    assert.equal(handler.rulesetId, 'CN/V20261019');
    assert.equal(handler.timing, timing); assert.deepEqual(handler.operations, [op]);
    assert.equal(handler.parameterSchemaRef, `urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/${op}`);
    assert.equal(typeof handler.implementationVersion, 'string'); assert(handler.implementationVersion.length);
    assert(handler.sourceOfTruth.length);
    assert.equal(handler.validateParameters(parameters), true);
    assert.deepEqual(handler.execute(null, parameters), [emitted]);
    assert.equal(handler.validateParameters({ ...parameters, ignored: true }), false);
  }
  assert.equal(handlers.get('cn.discardStadium@1').validateParameters({ action: discard() }), false);
  assert.equal(handlers.get('cn.stadiumProtection@1').validateParameters(shield()), false);
  assert.equal(handlers.get('cn.stadiumProtection@1').validateParameters({ effect: discard() }), false);
});

test('Stadium self protection separates ordinary and CN.E29 without inferring a special rule from hand filters', () => {
  const handler = createCoreHandlers().get('cn.stadiumProtection@1');
  for (const useRule of ['ordinary', 'CN.E29']) for (const from of ['own', 'opponent', 'all']) {
    const effect = handShield({ useRule, from }), before = structuredClone(effect);
    assert.equal(validateContinuousEffect(effect), true);
    assert.equal(handler.validateParameters({ effect }), true);
    assert.deepEqual(handler.execute(null, { effect }), [effect]);
    assert.deepEqual(effect, before);
    assert.equal(validateEffectProgram([effect]), false, 'continuous descriptions are not executable actions');
  }
  assert.equal(handler.validateParameters({ effect: shield() }), true, 'ordinary may omit Trainer filters');
  for (const trainerCategories of [['item'], ['supporter'], ['item', 'supporter'], ['supporter', 'item']])
    assert.equal(handler.validateParameters({ effect: handShield({ trainerCategories }) }), true);
});

test('Stadium protection rejects wrong subjects, channels, labels, special categories/origins and substitute operations', () => {
  const handler = createCoreHandlers().get('cn.stadiumProtection@1');
  const invalid = ['op', 'scope', 'channel', 'useRule', 'from', 'categories',
    'trainerOrigins', 'trainerCategories'].map((key) => without(handShield(), key));
  for (const extra of [{ scope: 'own' }, { scope: 'all' }, { scope: 'pokemon' }, { channel: 'damage' },
    { useRule: 'CN.E-29' }, { useRule: null }, { from: 'hand' }, { categories: ['attack'] },
    { categories: ['trainer', 'ability'] }, { trainerOrigins: ['field'] }, { trainerOrigins: ['hand', 'field'] },
    { trainerOrigins: ['hand', 'hand'] }, { trainerCategories: [] }, { trainerCategories: ['tool'] },
    { trainerCategories: ['item', 'stadium'] }, { trainerCategories: ['item', 'item'] },
    { pokemonId: 'fixture:mon' }, { ignoreProtection: true }, { ruleId: 'effects.trainer-hand-use' }])
    invalid.push(handShield(extra));
  for (const effect of invalid) {
    assert.equal(validateContinuousEffect(effect), false, JSON.stringify(effect));
    assert.equal(handler.validateParameters({ effect }), false);
  }
  const pokemonSelf = shield({ op: 'protection' });
  assert.equal(validateProtectionParameters({ effect: pokemonSelf }), true);
  assert.equal(handler.validateParameters({ effect: pokemonSelf }), false, 'Pokemon self is not a source-card subject');
  assert.equal(validateProtectionParameters({ effect: shield() }), false);
  assert.equal(handler.validateParameters({ effect: { op: 'playerRestriction', scope: 'self', actions: ['playItem'] } }), false);
});

test('neither ordinary nor CN.E29 Stadium protection can be forged into timed programs or ongoing ledgers', () => {
  const state = { current: 0, phase: 'main', players: [{ turns: 3 }, { turns: 2 }] };
  const source = { instanceId: 'fixture:stadium', owner: 0, category: 'trainer', origin: 'field',
    pokemonId: null, attackId: null, effectId: 'fixture:field-shield', sourceOfTruth: EVIDENCE };
  const parameters = { side: 'own', target: 'self', duration: 'untilNextOpponentTurnEnd',
    clearOnBench: true, clearOnEvolution: true };
  const valid = createOngoingEffect({ ...parameters, id: 'fixture:ledger', targetId: 'fixture:mon', source,
    effect: { op: 'modifier', field: 'defenseDamage', amount: -10, scope: 'all' } }, state);
  assert.equal(validateOngoingEffect(valid), true);
  for (const useRule of ['ordinary', 'CN.E29']) {
    const effect = handShield({ useRule }), before = structuredClone(state);
    const action = { op: 'lasting', ...parameters, effect };
    assert.equal(validateLastingParameters(without(action, 'op')), false);
    assert.equal(validateEffectProgram([action]), false);
    assert.equal(validateEffectProgram([{ op: 'optional', effect: action }]), false);
    const forged = { ...structuredClone(valid), targetId: source.instanceId, effect };
    assert.equal(validateOngoingEffect(forged), false);
    assert.throws(() => assertOngoingEffect(forged, state), /Invalid ongoing effect/);
    assert.throws(() => createOngoingEffect(forged, state), /Invalid ongoing effect/);
    assert.deepEqual(state, before);
  }
});

test('native source-card protection belongs only to the Stadium definition, not Pokemon, Tool or Energy slots', async () => {
  for (const useRule of ['ordinary', 'CN.E29']) {
    const f = await fixture((defs) => {
      defs.find((card) => card.definitionId === 'stadium').mechanics.effects =
        [binding('cn.stadiumProtection@1', { effect: handShield({ useRule }) })];
    });
    let stadiumId;
    const game = board(f, (state) => {
      stadiumId = hand(state, 0, 'stadium'); state.players[0].hand.pop(); state.stadium = stadiumId;
    });
    assert.equal(game.snapshot().stadium, stadiumId);
    for (const holder of ['base', 'tool', 'double']) {
      await assert.rejects(async () => {
        const invalid = await fixture((defs) => {
          defs.find((card) => card.definitionId === holder).mechanics.effects =
            [binding('cn.stadiumProtection@1', { effect: handShield({ useRule }) })];
        });
        return board(invalid, (state) => {
          if (holder === 'base') return;
          const id = hand(state, 0, holder); state.players[0].hand.pop();
          state.players[0].active[holder === 'tool' ? 'tools' : 'energy'].push(id);
        });
      }, /stadium|field.?card|protection.*source|source.*protection|placement|timing/i);
    }
  }
});

test('release definition pins bind the Prism Star rule/evidence and the Stadium use-rule label', async () => {
  const f = await releaseFixture(), original = structuredClone(f.data);
  await load(f.data, f);
  for (const mutate of [
    (card) => { delete card.prismStar; },
    (card) => { card.prismStar.sourceOfTruth[0].locator = 'fixture:changed-classification-evidence'; },
    (card) => { card.mechanics.effects[0].parameters.effect.useRule = 'CN.E29'; },
  ]) {
    const changed = structuredClone(f.data); mutate(changed.definitions[1]);
    await assert.rejects(load(changed, f), releaseError('release-content-mismatch'));
    Object.assign(changed.manifest, await catalogCandidateFacts({
      ruleset: RULESET, definitions: changed.definitions, printings: changed.printings, handlers: f.handlers,
    }));
    await assert.rejects(load(changed, f), releaseError('unapproved-release'));
  }
  assert.deepEqual(f.data, original, 'candidate recalculation cannot refresh the independent original pin');
});

test('release handler pins reject Stadium operation, timing or execution drift', async () => {
  const f = await releaseFixture();
  for (const [id, extra] of [
    ['cn.stadiumProtection@1', { operations: ['protection'] }],
    ['cn.stadiumProtection@1', { timing: 'resolve' }],
    ['cn.discardStadium@1', { execute: () => [{ ...discard(), destination: 'lost' }] }],
  ]) {
    const handlers = new Map(f.handlers); handlers.set(id, { ...handlers.get(id), ...extra });
    await assert.rejects(load(f.data, { ...f, handlers }), releaseError('release-content-mismatch'));
  }
});
