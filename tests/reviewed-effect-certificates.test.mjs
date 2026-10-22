// Gold program reuse is exact in complete unit identity, not a license to inherit a different card's rules/quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEffectGold } from '../scripts/effect-gold.mjs';
import { reviewedEffectProof, reviewedProgramEvidence } from '../scripts/reviewed-effect-certificates.mjs';
import { certifyCandidate, canonicalEffectResult } from '../scripts/effect-certificates.mjs';
import { check } from '../scripts/effect-validate.mjs';
import { bindMachineEffects, machinePokemon, machineTrainer, fingerprint, libraryEvidence }
  from '../catalog/zh-CN/V20261019/machine.mjs';
import * as reviewed from '../catalog/zh-CN/V20261019/index.mjs';
import { createCoreHandlers } from '../public/rules/handlers.js';
import { canonicalDefinition, assertExecutableDefinition } from '../public/rules/card-schema.js';

const gold = buildEffectGold(), source = libraryEvidence({ dir: 'TEST/GOLD', mik: 'TEST/GOLD' });
test('committed reviewed programs are pure/reproducible and retain exact printing, definition and mechanism tests', () => {
  assert.equal(gold.units.length, 86); assert.equal(gold.sourceTexts, 89);
  assert.deepEqual(buildEffectGold(), gold);
  for (const row of gold.units) {
    const proof = reviewedEffectProof(row.unit, row.expected.usage?.key);
    if (row.unit.kind === 'rule') { assert.equal(proof, null); continue; }
    assert.ok(proof, row.uid);
    assert.equal(proof.family, `reviewed-${row.unit.kind}`);
    assert.equal(proof.reviewed.printingId, row.card);
    assert.ok(reviewed.PRINTINGS.find((p) => p.printingId === row.card).definitionBindings
      .some((b) => b.definitionId === proof.reviewed.definitionId));
    assert.ok(proof.reviewed.testIds.length > 0);
    assert.equal(check(row.unit, proof.result).valid, true, row.uid);
  }
});

test('a claimed UID cannot hide extra/changed clauses, printed damage, name or Trainer category', () => {
  for (const row of gold.units.filter((g) => g.unit.kind !== 'rule')) {
    const copy = structuredClone(row.unit); copy.text += '然后，令这只宝可梦昏厥。';
    assert.equal(reviewedEffectProof(copy, row.expected.usage?.key), null);
  }
  for (const kind of ['trainer', 'ability', 'attack']) {
    const row = gold.units.find((r) => r.unit.kind === kind), copy = structuredClone(row.unit);
    if (kind === 'trainer') copy.card.category = 'stadium';
    if (kind === 'ability') copy.ability.name = '不是这个特性';
    if (kind === 'attack') copy.attack.damage = '999';
    assert.equal(reviewedEffectProof(copy, row.expected.usage?.key), null);
    const a = reviewedEffectProof(row.unit, row.expected.usage?.key).result, wrong = structuredClone(a);
    wrong.effects.reverse();
    if (a.effects.length > 1) assert.equal(certifyCandidate(row.unit, a, wrong, a.usage?.key), null);
  }
});

test('context-free Trainer programs may share exact text/category but never borrow identity, own-name clauses or category', () => {
  const row = gold.units.find((g) => g.unit.kind === 'trainer' && g.unit.card.name === '妮莫');
  const other = structuredClone(row.unit); other.card.name = '另一张同文卡'; delete other.uid;
  const proof = reviewedEffectProof(other);
  assert.equal(proof.reviewed.match, 'exact-text-and-category');
  const def = machineTrainer('cn:machine:another', { name: other.card.name, nameKey: 'another',
    category: other.card.category, translation: proof.result }, source);
  assert.equal(def.name, other.card.name); assert.equal(def.nameKey, 'another');
  assert.equal(def.implementation.tier, 'machine');
  const bad = structuredClone(other); bad.card.category = 'tool';
  assert.equal(reviewedEffectProof(bad), null);
});

test('counted discard reuses a reviewed formula with actual local effect references at the second attack', () => {
  const row = gold.units.find((g) => g.expected.effects?.some((e) => e[1] === 'cn.countedEnergyDiscard@1'));
  const proof = reviewedEffectProof(row.unit), result = proof.result;
  const discard = result.effects.find((e) => e[1] === 'cn.countedEnergyDiscard@1');
  const bound = bindMachineEffects('cn:test', 'a2', result, source);
  const formula = bound.find((e) => e.handlerId === 'cn.damageValue@1');
  assert.ok(JSON.stringify(formula.parameters).includes(`cn:test:a2:${discard[0]}`));
  assert.equal(JSON.stringify(formula.parameters).includes('DEF:'), false);
  assert.ok(certifyCandidate(row.unit, result, result));
  const renamed = structuredClone(result), replacement = 'another-discard';
  const rename = (v) => typeof v === 'string' ? v.replace(`DEF:a:${discard[0]}`, `DEF:a:${replacement}`)
    : Array.isArray(v) ? v.map(rename) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)])) : v;
  const alpha = rename(renamed); alpha.effects.find((e) => e[1] === discard[1])[0] = replacement;
  assert.equal(canonicalEffectResult(alpha), canonicalEffectResult(result));
  assert.ok(certifyCandidate(row.unit, alpha, result));
});

test('semantic fingerprints normalize identity references but never erase WHICH counted result a formula reads', () => {
  const make = (id, chosen) => machinePokemon(id, {
    name: '指纹测试', nameKey: 'fingerprint-test', stage: 'basic', hp: 100, type: '水', retreat: 1, ruleBox: null,
    attacks: [{ name: '公式', cost: '', damage: { value: 10, operator: 'times' }, translation: { effects: [
      ['left', 'cn.countedEnergyDiscard@1', { marker: 1 }], ['right', 'cn.countedEnergyDiscard@1', { marker: 2 }],
      ['damage', 'cn.damageValue@1', { expression: { kind: 'effectCards', effectId: `DEF:a:${chosen}` } }],
    ] } }],
  }, source);
  assert.equal(fingerprint(make('cn:a', 'left')), fingerprint(make('cn:b', 'left')));
  assert.notEqual(fingerprint(make('cn:a', 'left')), fingerprint(make('cn:a', 'right')));
  assert.notEqual(fingerprint(make('cn:a', 'left')), fingerprint(make('cn:b', 'missing')));
});

test('named selectors bind through the checked name table, without borrowing reviewed evidence or card identity', () => {
  const row = gold.units.find((g) => JSON.stringify(g.expected.effects ?? []).includes('NAME:'));
  assert.ok(row);
  const proof = reviewedEffectProof(row.unit, row.expected.usage?.key), names = new Map(reviewed.DEFINITIONS.map((d) => [d.name, d.nameKey]));
  const face = { name: '机器测试', nameKey: 'machine-test', category: row.unit.card.category, translation: proof.result,
    resolveNameKey: (n) => names.get(n) };
  if (row.unit.kind === 'trainer') {
    const card = machineTrainer('cn:machine:test', face, source);
    assert.equal(card.implementation.tier, 'machine'); assert.deepEqual(card.sourceOfTruth, source);
    assert.equal(JSON.stringify(card.mechanics).includes('NAME:'), false);
    assert.throws(() => machineTrainer('cn:machine:test', { ...face, resolveNameKey: () => null }, source), /Unresolved/);
  } else {
    const actual = bindMachineEffects('cn:machine:test', row.unit.kind === 'attack' ? 'a1' : 'b1', proof.result, source, (n) => names.get(n));
    assert.equal(JSON.stringify(actual).includes('NAME:'), false);
  }
});

test('named cross-attack effects bind by printed name, not first attack or stand-in position, and reject ambiguity', () => {
  const row = gold.units.find((g) => g.unit.kind === 'ability' && g.unit.text.includes('「血月」'));
  const proof = reviewedEffectProof(row.unit, row.expected.usage?.key);
  assert.ok(JSON.stringify(proof.result).includes('ATTACK:血月'));
  const standIn = structuredClone(proof.result);
  standIn.effects[0][2].effect.attackIds = ['DEF:a'];
  assert.ok(certifyCandidate(row.unit, standIn, proof.result, proof.result.usage?.key));
  const build = (names) => machinePokemon('cn:test', {
    name: '测试', nameKey: 'test', stage: 'basic', hp: 300, type: '无', retreat: 1,
    attacks: names.map((name) => ({ name, cost: '无无无无无', damage: 100 })),
    abilities: [{ name: row.unit.ability.name, translation: proof.result }],
  }, source);
  assert.deepEqual(build(['其他招式', '血月']).mechanics.abilities[0].effects[0].parameters.effect.attackIds, ['cn:test:a2']);
  assert.throws(() => build(['其他招式']), /Unresolved named attack/);
  assert.throws(() => build(['血月', '血月']), /Unresolved named attack/);
});

test('official policy evidence is kept distinct from machine printing identity and cannot be forged by a model token', () => {
  const row = gold.units.find((g) => g.expected.effects?.some((e) => e[1] === 'cn.copyAttack@1'));
  const expected = reviewedEffectProof(row.unit).result;
  const proof = certifyCandidate(row.unit, expected, expected);
  const token = `REVIEWED_EVIDENCE:${proof.reviewed.printingId}`;
  assert.equal(proof.result.effects[0][2].special.sourceOfTruth, token);
  assert.equal(check(row.unit, proof.result).valid, true);
  assert.equal(reviewedProgramEvidence('fake'), null);
  const wrong = structuredClone(proof.result); wrong.effects[0][2].special.sourceOfTruth = 'REVIEWED_EVIDENCE:fake';
  assert.equal(certifyCandidate(row.unit, proof.result, wrong), null);
  const face = { name: '机器复制测试', nameKey: 'copy-test', stage: 'basic', hp: 100, type: '超', retreat: 1,
    attacks: [{ name: '复制', cost: '', damage: null, translation: proof.result }], resolveProgramEvidence: reviewedProgramEvidence };
  const def = machinePokemon('cn:machine:copy-test', face, source);
  assert.equal(def.implementation.tier, 'machine'); assert.deepEqual(def.sourceOfTruth, source);
  assert.deepEqual(def.mechanics.attacks[0].effects[0].sourceOfTruth, source);
  const policy = def.mechanics.attacks[0].effects[0].parameters.special.sourceOfTruth;
  assert.ok(policy.every((s) => s.kind === 'official-card' && s.sourceId.startsWith('reviewed-policy:')));
  assert.ok(policy.every((s) => s.locator.includes('不证明目标机器印刷')));
  assertExecutableDefinition(def, { ruleset: reviewed.RULESET,
    approvedDefinitions: new Map([[def.definitionId, canonicalDefinition(def)]]), handlers: createCoreHandlers() });
  assert.throws(() => machinePokemon('cn:machine:copy-test', { ...face, resolveProgramEvidence: undefined }, source), /Unresolved reviewed policy/);
});
