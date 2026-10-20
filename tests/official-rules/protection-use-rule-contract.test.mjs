import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateContinuousEffect, validateProtectionParameters, validateEffectProgram,
  validateLastingParameters, validateOngoingEffect,
} from '../../public/rules/schema-validators.js';
import { createOngoingEffect, assertOngoingEffect } from '../../public/rules/ongoing.js';
import { canonicalDefinition, assertExecutableDefinition, CardSchemaError } from '../../public/rules/card-schema.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/zh-CN/V20261019.js';
import { requireRule } from '../../public/rules/registry.js';
import { EVIDENCE, RULESET, binding } from './fixtures.mjs';

// Synthetic contracts only: neither these labels nor fixture approvals classify an actual card.
// Import the production validators; do not replace stale generated code with test-local schemas.
const protection = (extra = {}) => ({
  op: 'protection', useRule: 'ordinary', channel: 'effects', scope: 'self',
  from: 'opponent', categories: ['trainer'], ...extra,
});
const handProtection = (extra = {}) => protection({
  useRule: 'CN.E29', trainerOrigins: ['hand'], trainerCategories: ['item', 'supporter'], ...extra,
});
const without = (value, ...keys) => {
  const result = structuredClone(value);
  for (const key of keys) delete result[key];
  return result;
};
const checkProtection = (effect, expected, label) => {
  const before = structuredClone(effect);
  assert.equal(validateContinuousEffect(effect), expected, `${label}: continuous`);
  assert.equal(validateProtectionParameters({ effect }), expected, `${label}: handler parameters`);
  assert.deepEqual(effect, before, `${label}: validation must not infer or insert a use rule`);
};
const durations = ['nextOwnTurn', 'nextOpponentTurn', 'untilNextOwnTurnEnd', 'untilNextOpponentTurnEnd'];
const lasting = (effect, duration = durations[0]) => ({
  op: 'lasting', side: 'own', target: 'self', effect, duration,
  clearOnBench: true, clearOnEvolution: true,
});
const clock = () => ({ current: 0, phase: 'main', players: [{ turns: 3 }, { turns: 2 }] });
const ongoing = (effect, duration = durations[0]) => ({
  id: 'fixture:shield', targetId: 'fixture:protected-pokemon', effect, duration,
  source: {
    instanceId: 'fixture:source', owner: 0, category: 'attack', origin: 'field',
    pokemonId: 'fixture:attacker', attackId: 'fixture:attack',
    effectId: 'fixture:shield-effect', sourceOfTruth: EVIDENCE,
  },
  clearOnBench: true, clearOnEvolution: true,
});
const printedCardDefinition = (useRule) => ({
  schemaVersion: '1.0.0', definitionId: 'fixture:use-rule-contract', ruleset: RULESET,
  name: '测试用虚构连续保护宝可梦', nameKey: 'fixture:use-rule-contract', kind: 'pokemon',
  sourceOfTruth: EVIDENCE,
  implementation: { status: 'verified', testIds: ['fixture:protection-use-rule-contract'] },
  deckLimits: { sameName: 4, groups: [] },
  mechanics: {
    stage: 'basic', evolvesFrom: null, hp: 100, types: ['Water'],
    weakness: null, resistance: null, retreatCost: 1, attacks: [],
    abilities: [{
      abilityId: 'fixture:shield', name: '测试用虚构连续保护', mode: 'continuous', usage: null,
      effects: [binding('cn.protection@1', { effect: handProtection({ useRule }) })],
      sourceOfTruth: EVIDENCE,
    }],
    ruleBox: false, prizeCount: 1, tags: [], effects: [],
  },
});

test('registered hand-Trainer use rule cites CN E-29 at PDF pages 68–69', () => {
  const rule = requireRule(CN_V20261019, 'effects.trainer-hand-use');
  assert.equal(rule.id, 'effects.trainer-hand-use');
  assert(rule.sourceOfTruth.some((source) => source.documentId === 'CN-advanced-3.1.0' &&
    source.section.includes('II.E-29') && [68, 69].every((page) => source.pdfPages?.includes(page))));
});

test('every channel requires explicit classification fields and rejects missing or unknown useRule', () => {
  for (const channel of ['damage', 'effects']) {
    const ordinary = protection({ channel, categories: ['attack'] });
    checkProtection(ordinary, true, `${channel}: ordinary without Trainer filters`);
    checkProtection(without(ordinary, 'useRule'), false, `${channel}: missing useRule`);
  }
  checkProtection(without(handProtection(), 'useRule'), false, 'hand filters cannot supply the label');
  for (const field of ['op', 'channel', 'scope', 'from', 'categories', 'useRule',
    'trainerOrigins', 'trainerCategories'])
    checkProtection(without(handProtection(), field), false, `CN.E29 missing ${field}`);
  for (const field of ['op', 'channel', 'scope', 'from', 'categories', 'useRule'])
    checkProtection(without(protection(), field), false, `ordinary missing ${field}`);
  for (const useRule of ['', 'CN.E-29', 'cn.e29', 'CN.E30', 'ordinary ', null, true, 29, ['CN.E29']])
    checkProtection(handProtection({ useRule }), false, `unknown label ${JSON.stringify(useRule)}`);
});

test('scope/from stay explicit and hand origin filters do not automatically promote ordinary to CN.E29', () => {
  for (const useRule of ['ordinary', 'CN.E29'])
    for (const scope of ['self', 'own', 'opponent', 'all'])
      for (const from of ['own', 'opponent', 'all'])
        checkProtection(handProtection({ useRule, scope, from }), true, `${useRule}/${scope}/${from}`);
  const ordinary = handProtection({ useRule: 'ordinary' }), special = handProtection();
  checkProtection(ordinary, true, 'explicit ordinary with identical hand filters');
  checkProtection(special, true, 'explicit CN.E29');
  assert.deepEqual(without(ordinary, 'useRule'), without(special, 'useRule'));
  assert.equal(ordinary.useRule, 'ordinary');
  assert.equal(special.useRule, 'CN.E29');
  for (const trainerCategories of [['item'], ['supporter'], ['item', 'supporter'], ['supporter', 'item']])
    checkProtection(handProtection({ trainerCategories }), true, trainerCategories.join('/'));
  checkProtection(protection({ trainerOrigins: ['field'], trainerCategories: ['tool', 'stadium'] }),
    true, 'ordinary retains its broader reviewed Trainer filter domain');
});

test('CN.E29 is effects-only and exactly Trainer-category protection, not a different role or op', () => {
  for (const channel of ['damage', 'all', 'trainer', null])
    checkProtection(handProtection({ channel }), false, `wrong channel ${channel}`);
  for (const categories of [[], ['attack'], ['ability'], ['energy'], ['rule'],
    ['trainer', 'attack'], ['trainer', 'ability'], ['trainer', 'energy'], ['trainer', 'trainer'], 'trainer'])
    checkProtection(handProtection({ categories }), false, `wrong role ${JSON.stringify(categories)}`);
  for (const useRule of ['ordinary', 'CN.E29']) {
    checkProtection(handProtection({ useRule, scope: 'player' }), false, `${useRule}: invalid scope`);
    checkProtection(handProtection({ useRule, from: 'hand' }), false, `${useRule}: origin is not a side`);
    checkProtection(handProtection({ useRule, op: 'playerRestriction' }), false, `${useRule}: wrong op`);
  }
  checkProtection(protection({ categories: ['ability'], trainerOrigins: ['hand'] }), false,
    'ordinary Trainer origin filters still require a Trainer category');
  checkProtection(protection({ categories: ['attack'], trainerCategories: ['item'] }), false,
    'ordinary Trainer category filters cannot describe attacks');
});

test('CN.E29 requires exactly hand origin and a nonempty unique Item/Supporter subset', () => {
  for (const trainerOrigins of [[], ['field'], ['draw'], ['prizes'], ['hand', 'field'],
    ['hand', 'hand'], ['unknown'], 'hand', null])
    checkProtection(handProtection({ trainerOrigins }), false, `origins ${JSON.stringify(trainerOrigins)}`);
  for (const trainerCategories of [[], ['tool'], ['stadium'], ['item', 'tool'], ['supporter', 'stadium'],
    ['item', 'item'], ['supporter', 'supporter'], ['trainer'], 'item', null])
    checkProtection(handProtection({ trainerCategories }), false, `subtypes ${JSON.stringify(trainerCategories)}`);
});

test('unknown effect or parameter fields cannot smuggle a use-permission override', () => {
  for (const useRule of ['ordinary', 'CN.E29']) {
    const effect = handProtection({ useRule });
    for (const extra of [{ ruleId: 'effects.trainer-hand-use' }, { ignoreProtection: true }, { canUse: true }])
      checkProtection({ ...effect, ...extra }, false, `${useRule}: unknown effect field`);
    assert.equal(validateProtectionParameters({ effect, useRule }), false, 'label belongs inside effect');
    assert.equal(validateProtectionParameters({ effect, approved: true }), false, 'no imported approval flags');
    assert.equal(validateEffectProgram([effect]), false, 'a continuous description is not an executable action');
  }
});

test('ordinary timed protection remains valid through program, parameters and ongoing creation', () => {
  for (const channel of ['damage', 'effects']) for (const duration of durations) {
    const effect = protection({ channel, scope: 'all', categories: ['attack'] });
    const action = lasting(effect, duration), state = clock(), before = structuredClone(state);
    assert.equal(validateLastingParameters(without(action, 'op')), true);
    assert.equal(validateEffectProgram([action]), true);
    const entry = createOngoingEffect(ongoing(effect, duration), state);
    assert.equal(validateOngoingEffect(entry), true);
    assert.equal(assertOngoingEffect(JSON.parse(JSON.stringify(entry)), state).effect.useRule, 'ordinary');
    assert.deepEqual(state, before);
    assert.deepEqual(entry.effect, effect);
    const unlabeled = without(effect, 'useRule'), legacyAction = lasting(unlabeled, duration);
    assert.equal(validateLastingParameters(without(legacyAction, 'op')), false);
    assert.equal(validateEffectProgram([legacyAction]), false);
    assert.throws(() => createOngoingEffect(ongoing(unlabeled, duration), state), /Invalid ongoing effect/);
    assert.deepEqual(state, before, 'Rejected legacy shields must not alter the ledger clock.');
  }
});

test('CN.E29 cannot enter lastingSpec, including otherwise unexecuted nested program branches', () => {
  const effect = handProtection({ scope: 'all' });
  checkProtection(effect, true, 'standalone continuous description is well formed');
  for (const duration of durations) {
    const action = lasting(effect, duration);
    assert.equal(validateLastingParameters(without(action, 'op')), false);
    for (const program of [[action], [{ op: 'sequence', steps: [action] }],
      [{ op: 'optional', effect: action }], [{ op: 'then', first: { op: 'sequence', steps: [] }, next: action }]])
      assert.equal(validateEffectProgram(program), false, `${duration}: no hidden timed CN.E29 grant`);
    const state = clock(), before = structuredClone(state);
    assert.throws(() => createOngoingEffect(ongoing(effect, duration), state), /Invalid ongoing effect/);
    assert.deepEqual(state, before);
  }
});

test('forged ongoing CN.E29 is rejected even with a valid ordinary ledger, clock and hand filters', () => {
  for (const duration of durations) {
    const state = clock(), before = structuredClone(state);
    const ordinary = createOngoingEffect(ongoing(handProtection({ useRule: 'ordinary', scope: 'all' }), duration), state);
    assert.equal(validateOngoingEffect(ordinary), true);
    const forged = JSON.parse(JSON.stringify(ordinary));
    forged.effect.useRule = 'CN.E29';
    checkProtection(forged.effect, true, 'forgery differs only in the independently classified rule');
    assert.deepEqual(without(forged.effect, 'useRule'), without(ordinary.effect, 'useRule'));
    assert.equal(validateOngoingEffect(forged), false);
    assert.throws(() => assertOngoingEffect(forged, state), /Invalid ongoing effect/);
    assert.throws(() => createOngoingEffect(forged, state), /Invalid ongoing effect/);
    assert.equal(ordinary.effect.useRule, 'ordinary');
    assert.deepEqual(state, before);
  }
});

test('changing only printed useRule invalidates an existing independent definition approval', () => {
  const handlers = createCoreHandlers();
  for (const initial of ['ordinary', 'CN.E29']) {
    const printed = printedCardDefinition(initial), originalPin = canonicalDefinition(printed);
    const context = { ruleset: RULESET, handlers,
      approvedDefinitions: new Map([[printed.definitionId, originalPin]]) };
    const accepted = assertExecutableDefinition(printed, context);
    const changed = structuredClone(printed);
    const changedEffect = changed.mechanics.abilities[0].effects[0].parameters.effect;
    changedEffect.useRule = initial === 'ordinary' ? 'CN.E29' : 'ordinary';
    checkProtection(changedEffect, true, 'edited classification is shape-valid, not independently approved');
    assert.notEqual(canonicalDefinition(changed), originalPin);
    assert.throws(() => assertExecutableDefinition(changed, context),
      (error) => error instanceof CardSchemaError && /independent approval|changed since review/.test(error.message));
    assert.equal(context.approvedDefinitions.get(printed.definitionId), originalPin);
    assert.equal(canonicalDefinition(printed), originalPin);
    assert.equal(accepted.mechanics.abilities[0].effects[0].parameters.effect.useRule, initial);
    assert(Object.isFrozen(accepted.mechanics.abilities[0].effects[0].parameters.effect));
  }
});
