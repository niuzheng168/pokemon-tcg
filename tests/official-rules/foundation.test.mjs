import test from 'node:test';
import assert from 'node:assert/strict';
import { CN_V20261019, getRuleset, listRulesets } from '../../public/rules/index.js';
import { createRuleset, requireRule, ruleTrace, violation, PROVISIONAL_RULE_LABEL } from '../../public/rules/registry.js';
import { calculateAttackDamage, DAMAGE_RULE_IDS } from '../../public/rules/damage.js';
import { payEnergyCost, validateRetreatPayment, ENERGY_RULE_IDS } from '../../public/rules/energy.js';

const evidence = [{ documentId: 'test-card-fixture', section: 'synthetic card text, not an official printing' }];
const mod = (id, amount) => ({ id, amount, sourceOfTruth: evidence });
const packet = (extra = {}) => ({ amount: 100, attackerTypes: ['Fire'], ...extra });
const calc = (extra = {}) => calculateAttackDamage(packet(extra));
const weak = (value = 2) => ({ type: 'Fire', operation: 'multiply', value });
const resist = (value) => ({ type: 'Fire', value });

test('ruleset identity cannot be inferred from UI language or silently updated', () => {
  assert.equal(getRuleset({ region: 'CN', version: 'V20261019' }), CN_V20261019);
  for (const selection of [{}, { region: 'CN' }, { region: 'zh-CN', version: 'V20261019' },
    { region: 'US', version: 'V20261019' }, { region: 'CN', version: 'latest' }])
    assert.throws(() => getRuleset(selection), RangeError);
  assert.equal(listRulesets().length, 1);
  assert.throws(() => { CN_V20261019.rules['damage.base'].summary = 'changed'; }, TypeError);
});

test('every exported core rule resolves to official simplified-Chinese source evidence', () => {
  for (const id of [...DAMAGE_RULE_IDS, ...ENERGY_RULE_IDS]) {
    const rule = requireRule(CN_V20261019, id);
    assert(rule.sourceOfTruth.length);
    for (const reference of rule.sourceOfTruth) {
      const document = CN_V20261019.documents.find((d) => d.id === reference.documentId);
      assert(document && ['www.pokemon.cn', 'image.pokemon.com.cn'].includes(new URL(document.url).hostname));
      assert(reference.section);
    }
  }
  assert.throws(() => requireRule(CN_V20261019, 'international-up-to-zero'), TypeError);
  for (const d of CN_V20261019.documents) {
    if (d.evidence.binaryVerification === 'verified') assert.match(d.sha256, /^[a-f0-9]{64}$/);
    else assert.equal(d.sha256, null, 'Do not invent binary hashes before retrieval.');
  }
});

test('unsourced rules and unverified source hosts are rejected', () => {
  const definition = {
    region: 'CN', version: 'V20261019', reviewedOn: '2026-10-19',
    documents: structuredClone(CN_V20261019.documents),
    rules: [{ id: 'unproven', summary: 'missing official reference' }],
  };
  assert.throws(() => createRuleset(definition), /Unsourced/);
  definition.rules[0].sourceOfTruth = [{ documentId: 'made-up', section: 'I.A' }];
  assert.throws(() => createRuleset(definition), /Unknown source/);
  definition.rules = [];
  definition.documents[0].url = 'https://wiki.52poke.com/wiki/规则';
  assert.throws(() => createRuleset(definition), /Not an approved/);
});

test('source registry validates identity, fingerprints, duplicates and real PDF page bounds', () => {
  const data = () => ({
    region: 'CN', version: 'V20261019', reviewedOn: '2026-10-19',
    documents: structuredClone(CN_V20261019.documents),
    rules: [{ id: 'test-rule', summary: 'test reference', sourceOfTruth: [
      { documentId: 'CN-advanced-3.1.0', section: 'I.A-01', pdfPages: [7] },
    ] }],
  });
  for (const [field, value] of [['region', 'zh-CN'], ['version', 'latest']]) {
    const d = data(); d[field] = value; assert.throws(() => createRuleset(d), /explicit region/);
  }
  const duplicateDocument = data(); duplicateDocument.documents.push(duplicateDocument.documents[0]);
  assert.throws(() => createRuleset(duplicateDocument), /Duplicate document/);
  const incomplete = data(); delete incomplete.documents[0].authority;
  assert.throws(() => createRuleset(incomplete), /Incomplete source/);
  const fingerprint = data(); fingerprint.documents[0].sha256 = 'a'.repeat(64); createRuleset(fingerprint);
  fingerprint.documents[0].sha256 = 'invented';
  assert.throws(() => createRuleset(fingerprint), /fingerprint/);
  const duplicateRule = data(); duplicateRule.rules.push(duplicateRule.rules[0]);
  assert.throws(() => createRuleset(duplicateRule), /Duplicate rule/);
  for (const pages of [[], [0], [77], [1.5]]) {
    const d = data(); d.rules[0].sourceOfTruth[0].pdfPages = pages;
    assert.throws(() => createRuleset(d), /Invalid PDF page/);
  }
  const notAPdf = data(); notAPdf.rules[0].sourceOfTruth[0].documentId = 'CN-basic-play';
  assert.throws(() => createRuleset(notAPdf), /Invalid PDF page/);
});

test('a provisional rule (pending an official ruling) is an explicit, labelled marker with its record; these are the ones in force', () => {
  assert.deepEqual(Object.values(CN_V20261019.rules).filter((r) => r.provisional).map((r) => r.id), ['effects.remove-content-loop']);
  const data = (rule) => ({
    region: 'CN', version: 'V20261019', reviewedOn: '2026-10-19', documents: structuredClone(CN_V20261019.documents),
    rules: [{ id: 'test-rule', summary: 'test reference', sourceOfTruth: [
      { documentId: 'CN-advanced-3.1.0', section: 'II.D-13', pdfPages: [48] },
    ], ...rule }],
  });
  const label = `${PROVISIONAL_RULE_LABEL}：测试`;
  assert.equal(createRuleset(data({ summary: label, provisional: true, record: 'docs/test' })).rules['test-rule'].provisional, true);
  for (const rule of [{ provisional: true, record: 'docs/test' }, { summary: label, provisional: true },
    { summary: label, provisional: 'yes', record: 'docs/test' }, { summary: label }, { record: 'docs/test' },
    { summary: label, provisional: true, record: '' }, { provisional: false }])
    assert.throws(() => createRuleset(data(rule)), /provisional rule/);
});

test('rule violations retain rule identity and authoritative evidence', () => {
  const error = violation(CN_V20261019, 'energy.payment', 'Cannot pay cost.', { cost: ['Water'] });
  assert.equal(error.name, 'RuleViolation');
  assert.equal(error.ruleId, 'energy.payment');
  assert.equal(error.message, 'Cannot pay cost.');
  assert.deepEqual(error.details, { cost: ['Water'] });
  assert(error.sourceOfTruth.length);
});

const damageCases = [
  ['plain damage', {}, 100, null],
  ['zero base cannot be revived', { amount: 0, attackerModifiers: [mod('tool', 30)] }, 0, 'base'],
  ['effects-only attack cannot acquire damage', { amount: null, attackerModifiers: [mod('tool', 30)] }, 0, 'base'],
  ['attacker before Weakness', { attackerModifiers: [mod('tool', 30)], weakness: weak(), defenderModifiers: [mod('body', -20)] }, 240, null],
  ['attacker subtraction before Weakness', { attackerModifiers: [mod('debuff', -30)], weakness: weak() }, 140, null],
  ['zero attacker result stops', { attackerModifiers: [mod('debuff', -100)], defenderModifiers: [mod('vulnerability', 50)] }, 0, 'attacker'],
  ['negative attacker result stops', { attackerModifiers: [mod('debuff', -120)] }, 0, 'attacker'],
  ['attacker modifiers aggregate before zero test', { attackerModifiers: [mod('a', -150), mod('b', 100)] }, 50, null],
  ['reverse same-stage order has same result', { attackerModifiers: [mod('b', 100), mod('a', -150)] }, 50, null],
  ['card-specific Resistance 20', { resistance: resist(20) }, 80, null],
  ['card-specific Resistance 30', { resistance: resist(30) }, 70, null],
  ['zero Resistance stops before defender bonus', { amount: 20, resistance: resist(20), defenderModifiers: [mod('vulnerability', 50)] }, 0, 'resistance'],
  ['negative Resistance stops', { amount: 10, resistance: resist(30) }, 0, 'resistance'],
  ['defender modifiers aggregate before zero test', { defenderModifiers: [mod('a', -150), mod('b', 100)] }, 50, null],
  ['defender zero', { defenderModifiers: [mod('body', -100)] }, 0, 'defender'],
  ['ignore Weakness only', { weakness: weak(), resistance: resist(20), ignoreWeakness: true }, 80, null],
  ['ignore Resistance only', { weakness: weak(), resistance: resist(20), ignoreResistance: true }, 200, null],
  ['ignore W/R is not ignore defender effects', { weakness: weak(), ignoreWeakness: true, ignoreResistance: true, defenderModifiers: [mod('body', -20)] }, 80, null],
  ['ignore defender effects is not ignore Weakness', { weakness: weak(), ignoreDefenderEffects: true, defenderModifiers: [mod('body', -20)] }, 200, null],
  ['removed effective Weakness is not restored', { weakness: null, ignoreDefenderEffects: true }, 100, null],
  ['prevention', { preventions: [{ id: 'shield', sourceOfTruth: evidence }] }, 0, 'prevention'],
  ['ignore defender effects bypasses prevention', { preventions: [{ id: 'shield', sourceOfTruth: evidence }], ignoreDefenderEffects: true }, 100, null],
  ['Bench skips W/R but not defender effects', { targetPosition: 'bench', weakness: weak(), resistance: resist(20), defenderModifiers: [mod('body', -20)] }, 80, null],
  ['Bench card-text exception can apply W/R', { targetPosition: 'bench', weakness: weak(), applyBenchWeaknessResistance: true }, 200, null],
  ['self damage follows damage calculation unless text gives exception', { targetRelation: 'self', weakness: weak(), resistance: resist(20) }, 180, null],
  ['different attacker type', { attackerTypes: ['Water'], weakness: weak(), resistance: resist(20) }, 100, null],
  ['explicit additive Weakness', { weakness: { type: 'Fire', operation: 'add', value: 20 } }, 120, null],
  ['weakness uses matching type among attacker types', { attackerTypes: ['Water', 'Fire'], weakness: weak() }, 200, null],
];
for (const [name, input, expected, stoppedAt] of damageCases) {
  test(`official damage: ${name}`, () => {
    const original = structuredClone(input);
    const result = calc(input);
    assert.equal(result.damage, expected);
    assert.equal(result.counters, expected / 10);
    assert.equal(result.stoppedAt, stoppedAt);
    assert.deepEqual(input, original, 'Pure calculation must not mutate game/card state.');
    assert(result.trace.every((step) => step.rulesetId === 'CN/V20261019' && step.sourceOfTruth.length));
  });
}

test('damage input rejects ambiguity and unsafe numeric coercion', () => {
  for (const amount of [undefined, '100', NaN, Infinity, -10, 5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => calc({ amount }), TypeError);
  assert.throws(() => calc({ attackerModifiers: [{ id: 'tool', amount: 30 }] }), /evidence/);
  assert.throws(() => calc({ attackerModifiers: [mod('same', 30), mod('same', 30)] }), /unique/);
  assert.throws(() => calc({ resistance: { type: 'Fairy' } }), TypeError, 'No guessed Resistance magnitude.');
  assert.throws(() => calc({ attackerTypes: ['妖'] }), /Unknown normalized type/);
  assert.throws(() => calc({ ignoreWeakness: 1 }), TypeError);
  assert.throws(() => calculateAttackDamage(packet(), { id: 'US/V20261019' }), RangeError);
  for (const attackerTypes of [null, [], ['Fire', 'Fire']])
    assert.throws(() => calc({ attackerTypes }), TypeError);
  assert.throws(() => calc({ targetPosition: 'hand' }), TypeError);
  assert.throws(() => calc({ targetRelation: 'guess' }), TypeError);
  assert.throws(() => calc({ weakness: { type: 'Fire', operation: 'unknown', value: 2 } }), TypeError);
  assert.throws(() => calc({ weakness: weak(0) }), TypeError);
  assert.throws(() => calc({ amount: 9007199254740990, weakness: weak(2) }), TypeError);
  assert.throws(() => calc({ amount: 9007199254740990, attackerModifiers: [mod('overflow', 10)] }), TypeError);
  assert.throws(() => calc({ attackerModifiers: null }), TypeError);
  assert.throws(() => calc({ preventions: null }), TypeError);
  assert.throws(() => calc({ preventions: [{}] }), TypeError);
  assert.throws(() => calc({ preventions: [{ id: 'unsourced' }] }), TypeError);
});

test('damage trace records the official six-stage order and evidence', () => {
  const result = calc({ attackerModifiers: [mod('tool', 30)], weakness: weak(), defenderModifiers: [mod('body', -20)] });
  assert.deepEqual(result.trace.map((s) => s.ruleId), [
    'damage.base', 'damage.attacker', 'damage.weakness', 'damage.resistance', 'damage.defender', 'damage.record',
  ]);
  assert.deepEqual(result.trace.map((s) => s.after), [100, 130, 260, 260, 240, 240]);
});

test('trace evidence is protected and card modifier details are snapshotted', () => {
  const extra = { ruleId: 'spoof', sourceOfTruth: [], rulesetId: 'US/latest', data: { amount: 30 } };
  const trace = ruleTrace(CN_V20261019, 'damage.base', extra);
  extra.data.amount = 90;
  assert.equal(trace.data.amount, 30);
  assert.equal(trace.rulesetId, 'CN/V20261019');
  assert.equal(trace.ruleId, 'damage.base');
  assert(trace.sourceOfTruth.length);
  const modifier = mod('tool', 30);
  const result = calc({ attackerModifiers: [modifier] });
  modifier.amount = 90;
  assert.equal(result.trace[1].modifiers[0].amount, 30);
  assert.throws(() => { result.trace[1].modifiers[0].amount = 500; }, TypeError);
});

test('Energy matching handles overlapping alternatives instead of greedy false negatives', () => {
  const units = [['Water', 'Fighting'], ['Water']];
  const assignment = payEnergyCost(units, ['Water', 'Fighting']);
  assert.deepEqual(assignment, [1, 0]);
  assert.equal(payEnergyCost([['Water', 'Fighting']], ['Water', 'Fighting']), null);
  assert.equal(payEnergyCost([['Colorless'], ['Colorless']], ['Water']), null);
  assert.deepEqual(payEnergyCost([], []), []);
  assert.equal(payEnergyCost([], ['Colorless']), null);
  assert.deepEqual(payEnergyCost([['Fairy']], ['Fairy']), [0]);
});

test('Energy matching agrees with exhaustive matching over all small pools and costs', () => {
  const alternatives = [['Water'], ['Fighting'], ['Water', 'Fighting'], ['Colorless']];
  const types = ['Water', 'Fighting', 'Colorless'];
  const lists = (choices, n) => n === 0 ? [[]] : lists(choices, n - 1).flatMap((a) => choices.map((c) => [...a, c]));
  const oracle = (units, cost) => !cost.length || units.some((u, i) =>
    (cost[0] === 'Colorless' || u.includes(cost[0])) && oracle(units.filter((_, j) => i !== j), cost.slice(1)));
  for (let n = 0; n <= 3; n++) for (const units of lists(alternatives, n))
    for (let k = 0; k <= 3; k++) for (const cost of lists(types, k)) {
      const assignment = payEnergyCost(units, cost);
      assert.equal(assignment !== null, oracle(units, cost), JSON.stringify({ units, cost }));
      if (assignment) {
        assert.equal(new Set(assignment).size, cost.length);
        assignment.forEach((unit, i) => assert(cost[i] === 'Colorless' || units[unit].includes(cost[i])));
      }
    }
});

test('Retreat payment respects player choice and indivisible multi-unit Energy', () => {
  const cards = [
    { instanceId: 'fire', units: [['Fire']] },
    { instanceId: 'water', units: [['Water']] },
    { instanceId: 'double', units: [['Colorless'], ['Colorless']] },
    { instanceId: 'inactive', units: [] },
  ];
  assert(validateRetreatPayment(cards, ['fire'], 1));
  assert(validateRetreatPayment(cards, ['water'], 1));
  assert(validateRetreatPayment(cards, ['double'], 1));
  assert(validateRetreatPayment(cards, ['double'], 2));
  assert(!validateRetreatPayment(cards, ['double', 'water'], 2));
  assert(!validateRetreatPayment(cards, ['inactive'], 1));
  assert(!validateRetreatPayment(cards, ['fire', 'fire'], 2));
  assert(!validateRetreatPayment(cards, ['opponent-card'], 1));
  assert(validateRetreatPayment(cards, [], 0));
  assert(!validateRetreatPayment(cards, ['fire'], 0));
});

test('Energy/Retreat APIs reject malformed units, costs and duplicate card identities', () => {
  for (const units of [null, [null], [[]], [['Water', 'Water']], [['妖']], [['Dragon']]])
    assert.throws(() => payEnergyCost(units, []), TypeError);
  for (const cost of [null, ['妖']]) assert.throws(() => payEnergyCost([], cost), TypeError);
  for (const cost of [-1, 0.5, '1']) assert.throws(() => validateRetreatPayment([], [], cost), TypeError);
  assert.throws(() => validateRetreatPayment(null, [], 0), TypeError);
  assert.throws(() => validateRetreatPayment([{ units: [] }], [], 0), TypeError);
  assert.throws(() => validateRetreatPayment([{ instanceId: 'a', units: [] }, { instanceId: 'a', units: [] }], [], 0), TypeError);
  assert.equal(validateRetreatPayment([], null, 0), false);
});
