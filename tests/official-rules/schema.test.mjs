import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDefinitionShape, assertPrintingShape, assertExecutableDefinition, assertPrintingBinding,
  canonicalDefinition, CardSchemaError } from '../../public/rules/card-schema.js';

// All names, IDs, approval records and handlers in this test are SYNTHETIC.
// Official URLs identify the general specification, not published cards with these stats.
// None of these fixtures are installed in an application catalog.
const ruleEvidence = [{
  sourceId: 'CN-advanced-3.1.0', kind: 'official-rule',
  url: 'https://www.pokemon.cn/tcg/pdf/basic_rules08.pdf', locator: 'I.A-01',
}];
const claimedCardEvidence = [{
  sourceId: 'synthetic-card-evidence', kind: 'official-card',
  url: 'https://www.pokemon.cn/', locator: 'TEST ONLY: fictitious card, not official evidence',
}];
const ruleset = { region: 'CN', version: 'V20261019' };
const definition = () => structuredClone({
  schemaVersion: '1.0.0', definitionId: 'fixture:basic:1', ruleset,
  name: '测试用虚构宝可梦', nameKey: 'fixture:basic', kind: 'pokemon',
  sourceOfTruth: claimedCardEvidence,
  implementation: { status: 'unimplemented', testIds: [] },
  deckLimits: { sameName: 4, groups: [] },
  mechanics: {
    stage: 'basic', evolvesFrom: null, hp: 100, types: ['Water'],
    weakness: { type: 'Lightning', operation: 'multiply', value: 2 },
    resistance: { type: 'Fighting', value: 20 }, retreatCost: 1,
    attacks: [{
      attackId: 'fixture:tackle', name: '测试招式', cost: ['Water'],
      printedDamage: { value: 20, operator: 'fixed' }, effects: [], sourceOfTruth: claimedCardEvidence,
    }],
    abilities: [], ruleBox: false, prizeCount: 1, tags: [], effects: [],
  },
});
const printing = () => structuredClone({
  schemaVersion: '1.0.0', printingId: 'fixture:zh-Hans:001_100', game: 'tcg', language: 'zh-Hans',
  setCode: 'FIXTURE', number: '001/100', regulationMark: 'G', identityReview: 'unreviewed',
  definitionBindings: [], metadataRefs: [{ provider: '52poke', id: 'fixture:1', revision: '123' }],
});
const verified = () => {
  const d = definition();
  d.implementation = { status: 'verified', testIds: ['fixture:test:1'] };
  return d;
};
const approval = (d) => ({ ruleset, approvedDefinitions: new Map([[d.definitionId, canonicalDefinition(d)]]) });
const effect = () => ({
  effectId: 'fixture:effect:1', handlerId: 'fixture:handler@1',
  parameters: { count: 1 }, sourceOfTruth: claimedCardEvidence,
});
const handler = () => ({
  rulesetId: 'CN/V20261019', sourceOfTruth: ruleEvidence,
  execute() {}, validateParameters: (p) => Object.keys(p).length === 1 && Number.isInteger(p.count) && p.count >= 0,
});

test('schema separates definitions from physical printings and keeps raw card numbers', () => {
  assertDefinitionShape(definition());
  assertPrintingShape(printing());
  const p = printing(); p.number = '10 02/04'; assertPrintingShape(p); assert.equal(p.number, '10 02/04');
  assert.throws(() => assertDefinitionShape(printing()), CardSchemaError);
  assert.throws(() => assertPrintingShape(definition()), CardSchemaError);
});

test('schema rejects missing numeric semantics instead of inventing card defaults', () => {
  for (const field of ['weakness', 'resistance', 'retreatCost', 'prizeCount', 'ruleBox', 'types']) {
    const d = definition(); delete d.mechanics[field]; assert.throws(() => assertDefinitionShape(d), CardSchemaError);
  }
  const d = definition(); delete d.mechanics.resistance.value;
  assert.throws(() => assertDefinitionShape(d), CardSchemaError);
  d.mechanics.resistance.value = 30; assertDefinitionShape(d);
  d.mechanics.hp = '100'; assert.throws(() => assertDefinitionShape(d), CardSchemaError);
});

test('display text, legacy fields and extra properties are not executable schema', () => {
  for (const [path, value] of [['img', 'card.png'], ['powerKind', 'magic'], ['count', 4], ['text', 'do anything']]) {
    const d = definition(); d[path] = value; assert.throws(() => assertDefinitionShape(d), CardSchemaError);
  }
  const d = definition(); d.mechanics.attacks[0].effect = { selfDamage: 10 };
  assert.throws(() => assertDefinitionShape(d), CardSchemaError);
});

test('Wiki may be metadata provenance, never the official rule source of truth', () => {
  const d = definition();
  d.metadataRefs = [{ provider: '52poke', id: '52poke:1', revision: '2026' }];
  assertDefinitionShape(d);
  d.sourceOfTruth[0] = { ...claimedCardEvidence[0], url: 'https://wiki.52poke.com/wiki/fixture' };
  assert.throws(() => assertDefinitionShape(d), CardSchemaError);
});

test('structurally valid unimplemented/partial data cannot be executed', () => {
  for (const status of ['unimplemented', 'partial']) {
    const d = definition(); d.implementation.status = status; assertDefinitionShape(d);
    assert.throws(() => assertExecutableDefinition(d, approval(d)), /Unimplemented/);
  }
  const d = verified();
  assert.throws(() => assertExecutableDefinition(d), RangeError, 'An explicit ruleset is mandatory.');
  assert.throws(() => assertExecutableDefinition(d, { ruleset }), /independent approval/);
});

test('independent approval is content bound and returned cards are immutable', () => {
  const d = verified(), context = approval(d);
  const executable = assertExecutableDefinition(d, context);
  assert.notEqual(executable, d);
  assert.throws(() => { executable.mechanics.hp = 900; }, TypeError);
  d.mechanics.hp = 200;
  assert.throws(() => assertExecutableDefinition(d, context), /changed since review/);
});

test('general rule evidence alone does not prove a particular card', () => {
  const d = verified(); d.sourceOfTruth = ruleEvidence;
  assert.throws(() => assertExecutableDefinition(d, approval(d)), /do not prove/);
});

test('unknown, cross-version, unsourced handlers and invalid parameters fail closed', () => {
  const d = verified(); d.mechanics.attacks[0].effects = [effect()];
  assert.throws(() => assertExecutableDefinition(d, approval(d)), /Unknown/);
  const h = handler(), handlers = new Map([['fixture:handler@1', h]]);
  const context = { ...approval(d), handlers };
  assertExecutableDefinition(d, context);
  h.rulesetId = 'US/V20261019';
  assert.throws(() => assertExecutableDefinition(d, context), /wrong-version/);
  h.rulesetId = 'CN/V20261019'; h.sourceOfTruth = [];
  assert.throws(() => assertExecutableDefinition(d, context), /unsourced/);
  h.sourceOfTruth = ruleEvidence; d.mechanics.attacks[0].effects[0].parameters = { count: '1' };
  assert.throws(() => assertExecutableDefinition(d, { ...approval(d), handlers }), /Invalid parameters/);
});

test('formula markers cannot silently become plain damage', () => {
  const d = verified(); d.mechanics.attacks[0].printedDamage.operator = 'times';
  assert.throws(() => assertExecutableDefinition(d, approval(d)), /implemented formula/);
});

test('cross-region rules and Pocket/non-simplified/unreviewed printings cannot be mixed', () => {
  const d = verified(), p = printing();
  p.identityReview = 'verified';
  p.definitionBindings = [{ ruleset, definitionId: d.definitionId, sourceOfTruth: claimedCardEvidence }];
  assertPrintingBinding(p, d, ruleset);
  for (const [field, value] of [['game', 'pocket'], ['language', 'zh-Hant'], ['identityReview', 'unreviewed']]) {
    const changed = { ...p, [field]: value };
    assert.throws(() => assertPrintingBinding(changed, d, ruleset), CardSchemaError);
  }
  p.definitionBindings.push({ ...p.definitionBindings[0] });
  assert.throws(() => assertPrintingBinding(p, d, ruleset), /ambiguous/);
  assert.throws(() => assertExecutableDefinition(d, { ...approval(d), ruleset: { region: 'US', version: 'V20261019' } }), RangeError);
});

test('Trainer definitions and granted attacks have the same strict effect gate', () => {
  const d = verified();
  d.kind = 'trainer';
  d.mechanics = { category: 'tool', effects: [effect()], grantedAttacks: [definition().mechanics.attacks[0]] };
  const handlers = new Map([['fixture:handler@1', handler()]]);
  assertDefinitionShape(d);
  assertExecutableDefinition(d, { ...approval(d), handlers });
  d.mechanics.category = 'legacy-trainer';
  assert.throws(() => assertDefinitionShape(d), CardSchemaError);
});

test('Energy definition supports multi-unit cards but no invented basic Colorless/Dragon Energy', () => {
  const d = verified();
  d.kind = 'energy';
  d.mechanics = { category: 'special', baseUnits: [['Water', 'Fighting'], ['Water', 'Fighting']], effects: [] };
  assertExecutableDefinition(d, approval(d));
  d.mechanics = { category: 'basic', baseUnits: [['Water']], effects: [] };
  assertDefinitionShape(d);
  assert.throws(() => assertExecutableDefinition(d, approval(d)), /four-per-name limit/);
  d.deckLimits.sameName = null;
  assertExecutableDefinition(d, approval(d));
  for (const type of ['Dragon', 'Colorless']) {
    d.mechanics.baseUnits = [[type]];
    assert.throws(() => assertDefinitionShape(d), CardSchemaError);
  }
  const dragon = definition();
  dragon.mechanics.types = ['Dragon'];
  assertDefinitionShape(dragon);
  dragon.mechanics.attacks[0].cost = ['Dragon'];
  assert.throws(() => assertDefinitionShape(dragon), CardSchemaError);
});

test('abilities and attack effects cannot share an ambiguous effect ID', () => {
  const d = verified();
  d.mechanics.abilities = [{
    abilityId: 'fixture:ability', name: '测试特性', mode: 'activated',
    usage: { period: 'turn', scope: 'pokemon', key: 'fixture:ability', limit: 1 },
    effects: [effect()], sourceOfTruth: claimedCardEvidence,
  }];
  d.mechanics.attacks[0].effects = [effect()];
  const handlers = new Map([['fixture:handler@1', handler()]]);
  assert.throws(() => assertExecutableDefinition(d, { ...approval(d), handlers }), /Duplicate effect ID/);
});

test('evolution and Rule Box semantics are not inferred from display names', () => {
  const d = verified();
  d.mechanics.evolvesFrom = 'fixture:other';
  assert.throws(() => assertExecutableDefinition(d, approval(d)), /Basic Pokémon/);
  d.mechanics.evolvesFrom = null;
  d.mechanics.stage = 'stage1';
  assert.throws(() => assertExecutableDefinition(d, approval(d)), /Evolution needs/);
  d.mechanics.evolvesFrom = 'fixture:other';
  assertExecutableDefinition(d, approval(d));
  d.mechanics.prizeCount = 2;
  assert.throws(() => assertExecutableDefinition(d, approval(d)), /Rule Box/);
  d.mechanics.ruleBox = true;
  assertExecutableDefinition(d, approval(d));
});

test('special evolution and damage formulas require the matching handler capability', () => {
  const d = verified(), h = handler();
  d.mechanics.stage = 'special'; d.mechanics.effects = [effect()];
  const handlers = new Map([['fixture:handler@1', h]]);
  assert.throws(() => assertExecutableDefinition(d, { ...approval(d), handlers }), /Special deployment/);
  h.capabilities = ['special-evolution'];
  assertExecutableDefinition(d, { ...approval(d), handlers });
  d.mechanics.attacks[0].printedDamage.operator = 'plus';
  d.mechanics.attacks[0].effects = [{ ...effect(), effectId: 'fixture:formula' }];
  assert.throws(() => assertExecutableDefinition(d, { ...approval(d), handlers }), /implemented formula/);
  h.capabilities.push('resolve-attack-damage');
  assertExecutableDefinition(d, { ...approval(d), handlers });
});

test('wrong definition version and wrong/missing printing bindings are rejected', () => {
  const d = verified();
  d.ruleset = { region: 'CN', version: 'V20270101' };
  assert.throws(() => assertExecutableDefinition(d, approval(d)), /different region/);
  const p = printing(); p.identityReview = 'verified';
  assert.throws(() => assertPrintingBinding(p, verified(), ruleset), /Missing/);
  p.definitionBindings = [{ ruleset, definitionId: 'wrong', sourceOfTruth: claimedCardEvidence }];
  assert.throws(() => assertPrintingBinding(p, verified(), ruleset), /conflicting/);
});
