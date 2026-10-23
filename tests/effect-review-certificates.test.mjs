// Reviewed consensus certificates: an agreed program no template covers is admitted only with a committed per-unit
// "correct" review of exactly that program. Tested on the committed snapshot without local model outputs or paid APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../catalog/zh-CN/V20261019/library/machine/effects.json' with { type: 'json' };
import ledger from '../catalog/zh-CN/V20261019/library/machine/effect-reviews.json' with { type: 'json' };
import { REVIEW_FAMILY, REVIEW_FAMILIES, DISAGREEMENT_FAMILY, REVIEW_SCHEMA, programSha256, reviewLedger, reviewedConsensusProof, inexpressible,
  needsOfficialEvidence }
  from '../scripts/effect-review-certificates.mjs';
import { certifyCandidate } from '../scripts/effect-certificates.mjs';
import { check } from '../scripts/effect-validate.mjs';

const unit = { uid: 'u1', kind: 'attack', text: '测试。', card: { name: '测试', kind: 'pokemon' },
  attack: { name: '测试', cost: '无', damage: '' } };
const program = { status: 'ok', effects: [['e', 'cn.discardDeckTop@1', { side: 'own', count: 2 }]] };
const ledgerOf = (...reviews) => reviewLedger({ schema: REVIEW_SCHEMA, reviews });
const correct = (uid = 'u1', result = program) => ({ uid, verdict: 'correct', programSha256: programSha256(result) });

test('only a "correct" review of exactly this program admits it', () => {
  const proof = reviewedConsensusProof(unit, program, ledgerOf(correct()));
  assert.equal(proof.family, REVIEW_FAMILY);
  assert.deepEqual(proof.review, { verdict: 'correct', programSha256: programSha256(program) });
  for (const verdict of ['wrong', 'unsure'])
    assert.equal(reviewedConsensusProof(unit, program, ledgerOf({ ...correct(), verdict })), null);
  assert.equal(reviewedConsensusProof(unit, program, ledgerOf(correct('u2'))), null, 'another unit\'s review');
  const changed = structuredClone(program); changed.effects[0][2].count = 3;
  assert.equal(reviewedConsensusProof(unit, changed, ledgerOf(correct())), null, 'a program other than the reviewed one');
  // Entry keys are local names, so renaming one is still the reviewed program.
  const renamed = structuredClone(program); renamed.effects[0][0] = 'mill';
  assert.ok(reviewedConsensusProof(unit, renamed, ledgerOf(correct())));
  // Where the models disagree, the one reviewed program is admitted under its own family; the gates are the same.
  assert.equal(reviewedConsensusProof(unit, program, ledgerOf(correct()), DISAGREEMENT_FAMILY).family, DISAGREEMENT_FAMILY);
  assert.equal(reviewedConsensusProof(unit, changed, ledgerOf(correct()), DISAGREEMENT_FAMILY), null);
  assert.throws(() => reviewedConsensusProof(unit, program, ledgerOf(correct()), 'template'), /Unknown review family/);
});

test('fallbacks, open rulings and non-ok results are never admitted by review', () => {
  const orElse = { status: 'ok', effects: [['e', 'cn.orElse@1', { first: {}, otherwise: {} }]] };
  const ruling = { status: 'ok', effects: [['e', 'cn.attackCopy@1', { specialRules: 'needsRuling' }]] };
  for (const result of [orElse, ruling, { ...program, status: 'unsupported' }])
    assert.equal(reviewedConsensusProof(unit, result, ledgerOf(correct('u1', result))), null);
});

test('texts a handler cannot express exactly and official-only evidence slots are never admitted by review', () => {
  const attack = (text, ...effects) => [{ ...unit, text }, { status: 'ok', effects }];
  const cases = [
    attack('将自己弃牌区中的2张【火】能量，附着于这只宝可梦身上。', ['a', 'cn.attachDiscard@1',
      { type: 'Fire', count: 2, benchOnly: false, optional: false, target: 'self' }]),
    attack('若希望，可选择自己牌库中任意卡牌最多2张，加入手牌。并重洗牌库。', ['s', 'cn.cards@1', { from: 'deck', to: 'hand',
      selector: { kind: 'any' }, quantity: { kind: 'upTo', count: 2 }, reveal: false, lookTop: null, shuffleAfter: true }]),
    attack('……「连击」宝可梦……', ['t', 'cn.suppression@1', { effect: { op: 'suppression', channel: 'abilities', scope: 'all', tag: '连击' } }]),
    attack('（除「X」外）', ['x', 'cn.suppression@1', { effect: { op: 'suppression', channel: 'abilities', scope: 'all',
      exceptAbilityIds: ['DEF:b'] } }]),
    attack('将这只宝可梦，以及放于其身上的所有卡牌，放回手牌。', ['r', 'cn.fieldReturn@1', { op: 'returnPokemon', side: 'own',
      target: 'self', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 }, to: 'hand', attachments: 'return',
      chooser: 'source', promotion: { timing: 'afterAction', sourceOfTruth: 'CARD_EVIDENCE' } }]),
  ];
  for (const [u, result] of cases) assert.equal(reviewedConsensusProof(u, result, ledgerOf(correct('u1', result))), null, u.text);
  for (const [u, result] of cases.slice(0, 4)) assert.ok(inexpressible(u, result), u.text);
  assert.ok(needsOfficialEvidence(cases[4][1]) && !inexpressible(...cases[4]));
  // The ruled values are settled by the ruleset's sourced rules, not by the card-library record.
  const ruled = structuredClone(cases[4][1]); ruled.effects[0][2].promotion.timing = 'afterRelatedResolution';
  const copy = { status: 'ok', effects: [['c', 'cn.copyAttack@1', { op: 'copyAttack', special: { mode: 'consumeUserQuota', sourceOfTruth: 'CARD_EVIDENCE' } }]] };
  for (const result of [ruled, copy]) assert.ok(!needsOfficialEvidence(result) && reviewedConsensusProof(cases[4][0], result, ledgerOf(correct('u1', result))));
  copy.effects[0][2].special.mode = 'declaredOnly';
  assert.ok(needsOfficialEvidence(copy));
  // The same shapes are fine where the text allows them; II.C-11 puts only Basic Pokémon onto the Bench in the
  // kernel, and II.D-04 「N张」 from the discard pile is attachDiscard's `exact`.
  const upTo = attack('选择自己弃牌区中最多2张【火】能量，附着于这只宝可梦身上。', ['a', 'cn.attachDiscard@1',
    { type: 'Fire', count: 2, benchOnly: false, optional: false, target: 'self' }]);
  const exact = attack('将自己弃牌区中的2张【火】能量，附着于这只宝可梦身上。', ['a', 'cn.attachDiscard@1',
    { type: 'Fire', count: 2, benchOnly: false, optional: false, target: 'self', exact: true }]);
  const named = attack('选择自己牌库中最多2张「鬼斯」，放于备战区。并重洗牌库。', ['b', 'cn.cards@1', { from: 'deck', to: 'bench',
    selector: { kind: 'pokemon', nameKeys: ['gastly'] }, quantity: { kind: 'upTo', count: 2 }, reveal: false, lookTop: null, shuffleAfter: true }]);
  const typed = attack('选择自己弃牌区中最多3张【龙】宝可梦，放于备战区。', ['b', 'cn.cards@1', { from: 'discard', to: 'bench',
    selector: { kind: 'pokemon', types: ['Dragon'] }, quantity: { kind: 'upTo', count: 3 }, reveal: false, lookTop: null, shuffleAfter: false }]);
  // II.E-10: cn.optional@1 lets the user decline the whole any-card search.
  const declinable = attack('若希望，可选择自己牌库中任意卡牌最多2张，加入手牌。并重洗牌库。', ['s', 'cn.optional@1', { effect: {
    handlerId: 'cn.cards@1', parameters: cases[1][1].effects[0][2] } }]);
  for (const [u, result] of [upTo, exact, named, typed, declinable]) assert.ok(reviewedConsensusProof(u, result, ledgerOf(correct('u1', result))), u.text);
});

test('the ledger rejects other schemas, duplicates and malformed rows', () => {
  assert.throws(() => reviewLedger({ schema: 'other', reviews: [] }), /schema/);
  assert.throws(() => ledgerOf(correct(), correct()), /Duplicate/);
  assert.throws(() => ledgerOf({ ...correct(), verdict: 'ok' }), /Malformed/);
  assert.throws(() => ledgerOf({ ...correct(), programSha256: 'abc' }), /Malformed/);
});

test('every committed review certificate has its correct ledger row; rejected reviews stay out', () => {
  const reviews = reviewLedger(ledger), admitted = new Set();
  assert.ok(ledger.decoys.planted > 0 && ledger.decoys.caught <= ledger.decoys.planted);
  for (const row of snapshot.units.filter((r) => REVIEW_FAMILIES.includes(r.family))) {
    admitted.add(row.unit.uid);
    assert.deepEqual(reviewedConsensusProof(row.unit, row.result, reviews, row.family)?.review, row.review, row.unit.uid);
    assert.ok(check(row.unit, row.result).valid, row.unit.uid);
    // A text a narrow template covers is certified by the template, never by review.
    assert.equal(certifyCandidate(row.unit, row.result, row.result, row.result.usage?.key), null, row.unit.uid);
  }
  assert.ok(admitted.size > 0);
  for (const r of ledger.reviews) if (r.verdict !== 'correct') {
    assert.ok(!admitted.has(r.uid), r.uid);
    assert.ok(!snapshot.units.some((row) => row.unit.uid === r.uid), r.uid);
  }
  assert.ok(snapshot.certificateTests.includes('tests/effect-review-certificates.test.mjs'));
});
