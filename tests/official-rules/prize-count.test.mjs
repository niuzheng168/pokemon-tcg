// All game values below are synthetic. No actual card/catalog approvals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  PrizeCountError, PRIZE_COUNT_BASES, PRIZE_COUNT_RULE_IDS, PRIZE_COUNT_SOURCES,
  assertPrizeCountQuery, queryPrizesTaken, requirePrizesTaken, prizesTakenForPlayer,
} from '../../public/rules/prize-count.js';
import { CN_V20261019 } from '../../public/rules/zh-CN/V20261019.js';
import { requireRule } from '../../public/rules/registry.js';

const ruleset = () => ({ region: 'CN', version: 'V20261019' });
const query = (deckSize = 60, remainingPrizes = 6, matchMode = 'normal') => ({
  ruleset: ruleset(), deckSize, matchMode, remainingPrizes,
});
const clone = (value) => structuredClone(value);
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const error = (fn, code) => assert.throws(fn, (e) => {
  assert(e instanceof TypeError); assert(e instanceof PrizeCountError);
  assert.equal(e.name, 'PrizeCountError'); assert.equal(e.code, code);
  assert.equal(e.needsRuling, code === 'needs-ruling'); return true;
});
const ctx = (remaining = [4, 1], extra = {}) => ({ source: { owner: 1 }, state: {
  ruleset: ruleset(), matchMode: 'normal', phase: 'main', current: 1, turn: 5, rng: [1, 2, 3, 4],
  setup: { actualPrizesPlaced: 1 },
  players: remaining.map((n, owner) => ({ prizes: Array.from({ length: n }, (_, i) => `p${owner}:prize:${i}`),
    deck: [], hand: [], discard: [] })), ...extra,
} });

// Standalone schema only. No shared compiler, generated output or state edit.
const schema = JSON.parse(await readFile(new URL('../../schemas/prize-count.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true }); ajv.addSchema(schema);
const schemaQuery = ajv.getSchema(schema.$id);
const schemaResult = ajv.getSchema(`${schema.$id}#/$defs/result`);
const schemaHook = ajv.getSchema(`${schema.$id}#/$defs/hookParameters`);

test('D-17 and the limited tiebreak evidence cite the pinned CN originals and exact PDF pages', () => {
  assert.deepEqual(PRIZE_COUNT_BASES, { 30: 3, 40: 4, 60: 6 });
  for (const id of PRIZE_COUNT_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  assert.deepEqual(PRIZE_COUNT_SOURCES, {
    effectsCount: { documentId: 'CN-advanced-3.1.0', section: 'II.D-17', pdfPages: [50, 51] },
    tiebreakSetup: { documentId: 'CN-advanced-3.1.0', section: 'I.E 抢分赛', pdfPages: [16] },
    tournamentScope: { documentId: 'CN-tournament-3.1.0', section: '5.1; 第12章', pdfPages: [5, 17] },
  });
  for (const [id, sha256] of [
    ['CN-advanced-3.1.0', '27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419'],
    ['CN-tournament-3.1.0', 'b5f0c8b87d928f5ca640f1f021863eb78aafcc8216067883e7b2075a25ab1ac6'],
  ]) {
    const doc = CN_V20261019.documents.find((d) => d.id === id); assert(doc); assert.equal(doc.sha256, sha256);
    for (const source of Object.values(PRIZE_COUNT_SOURCES).filter((s) => s.documentId === id))
      assert(source.pdfPages.every((page) => page >= 1 && page <= doc.pages));
  }
  assert(Object.isFrozen(PRIZE_COUNT_RULE_IDS)); assert(Object.isFrozen(PRIZE_COUNT_BASES));
  assert(Object.isFrozen(PRIZE_COUNT_SOURCES)); assert(Object.isFrozen(PRIZE_COUNT_SOURCES.effectsCount.pdfPages));
  assert.throws(() => { PRIZE_COUNT_BASES[60] = 1; }, TypeError);
  assert.throws(() => { PRIZE_COUNT_SOURCES.effectsCount.pdfPages.push(16); }, TypeError);
});

test('normal 60/40/30 use independent fixed 6/4/3 bases for every reachable remaining count, including zero', () => {
  // Independent table from D-17, not computed from the module's exported map.
  for (const [deckSize, expectedByRemaining] of [
    [60, [6, 5, 4, 3, 2, 1, 0]],
    [40, [4, 3, 2, 1, 0]],
    [30, [3, 2, 1, 0]],
  ]) for (const [remaining, expected] of expectedByRemaining.entries()) {
    const q = freeze(query(deckSize, remaining)), before = clone(q);
    assert.equal(schemaQuery(q), true); assert.equal(assertPrizeCountQuery(q), q);
    const result = queryPrizesTaken(q);
    assert.deepEqual(result, { status: 'resolved', basis: expectedByRemaining[0], count: expected,
      reasons: [], sourceOfTruth: [PRIZE_COUNT_SOURCES.effectsCount] });
    assert.equal(requirePrizesTaken(q), expected); assert.equal(schemaResult(result), true);
    assert.deepEqual(q, before);
  }
});

test('one remaining Prize in normal mode is not zero obtained merely because actual setup might have placed one', () => {
  assert.equal(requirePrizesTaken(query(60, 1)), 5);
  assert.equal(requirePrizesTaken(query(40, 1)), 3);
  assert.equal(requirePrizesTaken(query(30, 1)), 2);
  for (const key of ['initialPrizes', 'actualPrizesPlaced', 'setupPrizeCount', 'basis', 'count', 'taken', 'approved']) {
    const q = { ...query(), [key]: 1 };
    assert.equal(schemaQuery(q), false); error(() => queryPrizesTaken(q), 'invalid-prize-count-query');
  }
});

test('tiebreak never guesses either one-minus-remaining or the normal D-17 result, even with zero remaining', () => {
  for (const [deckSize, basis] of [[60, 6], [40, 4], [30, 3]]) for (const remaining of [0, 1, basis]) {
    const q = query(deckSize, remaining, 'tiebreak'), result = queryPrizesTaken(q);
    assert.equal(schemaQuery(q), true); assert.equal(schemaResult(result), true);
    assert.deepEqual(result, { status: 'needsRuling', basis, count: null, reasons: ['tiebreak-scope-unresolved'],
      sourceOfTruth: [PRIZE_COUNT_SOURCES.effectsCount, PRIZE_COUNT_SOURCES.tiebreakSetup, PRIZE_COUNT_SOURCES.tournamentScope] });
    assert.throws(() => requirePrizesTaken(q), (e) => {
      assert(e instanceof PrizeCountError); assert.equal(e.code, 'needs-ruling'); assert.equal(e.needsRuling, true);
      assert.deepEqual(e.details, result); assert(Object.isFrozen(e.details)); return true;
    });
  }
});

test('more remaining Prizes than the basis (an effect placed extra ones) count zero taken, never a negative number', () => {
  // JP official Q&A (アーゴヨンGX「インジェクションGX」): the basis minus the Prizes now placed, at most the basis.
  for (const [deckSize, basis] of [[60, 6], [40, 4], [30, 3]]) for (const remaining of [basis + 1, 100, Number.MAX_SAFE_INTEGER]) {
    const q = query(deckSize, remaining), result = queryPrizesTaken(q);
    assert.equal(schemaQuery(q), true);
    assert.deepEqual(result, { status: 'resolved', basis, count: 0, reasons: [], sourceOfTruth: [PRIZE_COUNT_SOURCES.effectsCount] });
    assert.equal(schemaResult(result), true); assert.equal(requirePrizesTaken(q), 0);
  }
});

test('the tiebreak reason alone survives an over-basis count, with all relevant evidence', () => {
  const result = queryPrizesTaken(query(60, 7, 'tiebreak'));
  assert.deepEqual(result.reasons, ['tiebreak-scope-unresolved']);
  assert.equal(result.count, null); assert.equal(result.basis, 6); assert.equal(schemaResult(result), true);
  assert.deepEqual(queryPrizesTaken(query(60, Number.MAX_SAFE_INTEGER, 'tiebreak')).reasons, result.reasons);
  error(() => requirePrizesTaken(query(60, 7, 'tiebreak')), 'needs-ruling');
});

test('query schema and runtime reject missing fields, region/version fallbacks and malformed finite or integer values', () => {
  const invalid = [
    undefined, null, [], false, 0, '', {}, ...Object.keys(query()).map((key) => {
      const q = query(); delete q[key]; return q;
    }),
    { ...query(), ruleset: null }, { ...query(), ruleset: [] }, { ...query(), ruleset: {} },
    { ...query(), ruleset: { region: 'CN' } }, { ...query(), ruleset: { version: 'V20261019' } },
    { ...query(), ruleset: { region: 'US', version: 'V20261019' } },
    { ...query(), ruleset: { region: 'CN', version: 'latest' } },
    { ...query(), ruleset: { ...ruleset(), locale: 'zh-CN' } },
    ...[0, 20, 50, 61, '60', null, true, Infinity, NaN, new Number(60)].map((deckSize) => ({ ...query(), deckSize })),
    ...['normal60', 'tiebreak60', 'casual60', 'suddenDeath', '', undefined, null, false].map((matchMode) => ({ ...query(), matchMode })),
    ...[-1, 0.5, '1', null, false, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 1n]
      .map((remainingPrizes) => ({ ...query(), remainingPrizes })),
    { ...query(), sourceOfTruth: [{ documentId: 'claim-not-approval' }] },
  ];
  for (const value of invalid) {
    assert.equal(schemaQuery(value), false);
    error(() => assertPrizeCountQuery(value), 'invalid-prize-count-query');
    error(() => queryPrizesTaken(value), 'invalid-prize-count-query');
  }
});

test('JSON gates never invoke query getters or accept symbols, hidden properties, class instances or inherited defaults', () => {
  const invalid = [
    Object.assign(Object.create({}), query()), new (class { constructor() { Object.assign(this, query()); } })(),
    Object.create(query()), { ...query(), ruleset: Object.create(ruleset()) },
  ];
  for (const hidden of ['deckSize', 'extra']) {
    const q = query(); Object.defineProperty(q, hidden, { value: 60, enumerable: false }); invalid.push(q);
  }
  const symbolic = query(); symbolic[Symbol('approval')] = true; invalid.push(symbolic);
  let calls = 0;
  for (const key of ['ruleset', 'deckSize', 'matchMode', 'remainingPrizes']) {
    const q = query(); Object.defineProperty(q, key, { enumerable: true, get() { calls++; throw new Error('must not run'); } });
    invalid.push(q);
  }
  const nested = query(); Object.defineProperty(nested.ruleset, 'region', { enumerable: true, get() { calls++; return 'CN'; } });
  invalid.push(nested);
  for (const q of invalid) error(() => queryPrizesTaken(q), 'invalid-prize-count-query');
  assert.equal(calls, 0);
  const nullProto = Object.assign(Object.create(null), query());
  nullProto.ruleset = Object.assign(Object.create(null), ruleset());
  assert.equal(requirePrizesTaken(nullProto), 0); assert.equal(schemaQuery(nullProto), true);
});

test('result values are detached, deeply immutable and schema-checked without turning a receipt into card approval', () => {
  const q = query(60, 4), result = queryPrizesTaken(q);
  q.remainingPrizes = 1; q.ruleset.region = 'US'; assert.equal(result.count, 2);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.reasons)); assert(Object.isFrozen(result.sourceOfTruth));
  assert.throws(() => { result.count = 6; }, TypeError);
  assert.throws(() => result.reasons.push('tiebreak-scope-unresolved'), TypeError);
  assert.throws(() => { result.sourceOfTruth[0].section = 'invented'; }, TypeError);
  for (const mutate of [
    (r) => { r.extra = true; }, (r) => { r.basis = 1; }, (r) => { r.count = -1; },
    (r) => { r.basis = 3; r.count = 4; }, (r) => { r.basis = 4; r.count = 5; },
    (r) => { r.count = null; }, (r) => { r.reasons = ['tiebreak-scope-unresolved']; },
    (r) => { r.sourceOfTruth = []; }, (r) => { r.sourceOfTruth[0].pdfPages = [1]; },
    (r) => { r.sourceOfTruth.push(clone(r.sourceOfTruth[0])); }, (r) => { r.status = 'approved'; },
  ]) { const bad = clone(result); mutate(bad); assert.equal(schemaResult(bad), false); }
  const unresolved = queryPrizesTaken(query(60, 1, 'tiebreak'));
  for (const mutate of [
    (r) => { r.count = 0; }, (r) => { r.reasons = []; }, (r) => { r.reasons = ['invented']; },
    (r) => { r.sourceOfTruth.pop(); }, (r) => { r.sourceOfTruth.reverse(); },
  ]) { const bad = clone(unresolved); mutate(bad); assert.equal(schemaResult(bad), false); }
  const both = clone(queryPrizesTaken(query(60, 7, 'tiebreak'))); both.reasons.push('remaining-exceeds-basis');
  assert.equal(schemaResult(both), false);
  assert(!JSON.stringify(result).match(/approved|verified|trustpin|definitionId|printingId/i));
});

test('the normal-60 hook reads the explicitly selected player, not current/source owner, deck length or one-Prize setup', () => {
  const state = freeze(ctx()), before = clone(state);
  assert.equal(schemaHook({ player: 0, deckSize: 60 }), true);
  assert.equal(prizesTakenForPlayer(state, { player: 0, deckSize: 60 }), 2);
  assert.equal(prizesTakenForPlayer(state, { player: 1, deckSize: 60 }), 5);
  assert.deepEqual(state, before);
  for (const phase of ['main', 'resolving', 'checkup', 'over']) {
    const c = ctx([0, 6], { phase, current: phase === 'checkup' ? null : 1 });
    assert.equal(prizesTakenForPlayer(c, { player: 0, deckSize: 60 }), 6);
    assert.equal(prizesTakenForPlayer(c, { player: 1, deckSize: 60 }), 0);
  }
  for (const [deckSize, remaining, expected] of [[40, 3, 1], [30, 1, 2]])
    assert.equal(prizesTakenForPlayer(ctx([remaining, 0]), { player: 0, deckSize }), expected);
});

test('numeric hook propagates unresolved tiebreak results without updating state, history or RNG; over-basis is zero', () => {
  for (const context of [ctx([1, 1], { matchMode: 'tiebreak' }), ctx([7, 1], { matchMode: 'tiebreak' })]) {
    const before = clone(context);
    error(() => prizesTakenForPlayer(freeze(context), { player: 0, deckSize: 60 }), 'needs-ruling');
    assert.deepEqual(context, before);
  }
  assert.equal(prizesTakenForPlayer(freeze(ctx([7, 1])), { player: 0, deckSize: 60 }), 0);
});

test('hook parameters require a concrete owner and trusted deck size; no source/relative-player/setup override is admitted', () => {
  for (const parameters of [undefined, null, [], {}, { player: 0 }, { deckSize: 60 },
    ...[-1, 2, null, true, '0', 'own', 'opponent'].map((player) => ({ player, deckSize: 60 })),
    { player: 0, deckSize: 60, basis: 1 }, { player: 0, deckSize: 60, initialPrizes: 1 }]) {
    assert.equal(schemaHook(parameters), false);
    error(() => prizesTakenForPlayer(ctx(), parameters), 'invalid-prize-count-context');
  }
  for (const deckSize of [20, '60', null]) {
    assert.equal(schemaHook({ player: 0, deckSize }), false);
    error(() => prizesTakenForPlayer(ctx(), { player: 0, deckSize }), 'invalid-prize-count-query');
  }
});

test('hook does not access hidden card faces, unselected Prizes, deck/hand data, actual setup or source/current defaults', () => {
  const c = ctx(); let calls = 0;
  const trap = { enumerable: true, get() { calls++; throw new Error('unread hidden/private field'); } };
  Object.defineProperty(c, 'source', trap);
  for (const key of ['current', 'setup', 'cards', 'rng', 'hand', 'deck']) Object.defineProperty(c.state, key, trap);
  for (const key of ['deck', 'hand', 'discard', 'faces']) Object.defineProperty(c.state.players[0], key, trap);
  Object.defineProperty(c.state.players[1], 'prizes', trap);
  assert.equal(prizesTakenForPlayer(c, { player: 0, deckSize: 60 }), 2); assert.equal(calls, 0);
});

test('hook rejects missing/inherited/executable state fields and setup, rather than interpreting pre-setup emptiness as six', () => {
  const cases = [null, [], {}, { state: null }, Object.create(ctx())];
  for (const mutate of [
    (c) => { delete c.state.phase; }, (c) => { c.state.phase = 'setup'; }, (c) => { c.state.phase = 'unknown'; },
    (c) => { delete c.state.players; }, (c) => { delete c.state.matchMode; }, (c) => { delete c.state.ruleset; },
    (c) => { c.state.players[0] = null; }, (c) => { delete c.state.players[0].prizes; },
  ]) { const c = ctx([0, 0]); mutate(c); cases.push(c); }
  let calls = 0;
  const getter = { enumerable: true, get() { calls++; throw new Error('must not execute'); } };
  for (const level of ['state', 'phase', 'players', 'prizes']) {
    const c = ctx();
    if (level === 'state') Object.defineProperty(c, level, getter);
    else if (level === 'prizes') Object.defineProperty(c.state.players[0], level, getter);
    else Object.defineProperty(c.state, level, getter);
    cases.push(c);
  }
  const hidden = ctx(); Object.defineProperty(hidden.state, 'phase', { value: 'main', enumerable: false }); cases.push(hidden);
  for (const c of cases) error(() => prizesTakenForPlayer(c, { player: 0, deckSize: 60 }), 'invalid-prize-count-context');
  assert.equal(calls, 0);
  for (const mutate of [
    (c) => { c.state.ruleset.version = 'latest'; }, (c) => { c.state.matchMode = undefined; },
  ]) {
    const c = ctx(); mutate(c);
    error(() => prizesTakenForPlayer(c, { player: 0, deckSize: 60 }), 'invalid-prize-count-query');
  }
});

test('hook physical arrays reject holes, extras, inherited subclasses, getters, duplicate IDs and public count projections', () => {
  for (const players of [null, {}, [], [{}], [{}, {}, {}], new Array(2)]) {
    const c = ctx(); c.state.players = players;
    error(() => prizesTakenForPlayer(c, { player: 0, deckSize: 60 }), 'invalid-prize-count-context');
  }
  for (const prizes of [null, {}, { count: 4 }, new Array(2), ['a', 'a'], [''], [null], [1], [false], [undefined],
    new (class extends Array {})('a')]) {
    const c = ctx(); c.state.players[0].prizes = prizes;
    error(() => prizesTakenForPlayer(c, { player: 0, deckSize: 60 }), 'invalid-prize-count-context');
  }
  for (const key of ['extra', Symbol('extra')]) {
    const c = ctx(); c.state.players[0].prizes[key] = true;
    error(() => prizesTakenForPlayer(c, { player: 0, deckSize: 60 }), 'invalid-prize-count-context');
  }
  let calls = 0;
  for (const target of ['players', 'prizes']) for (const executable of [false, true]) {
    const c = ctx(), a = target === 'players' ? c.state.players : c.state.players[0].prizes;
    Object.defineProperty(a, '0', executable ? { enumerable: true, get() { calls++; throw new Error('array getter'); } } :
      { enumerable: false, value: a[0] });
    error(() => prizesTakenForPlayer(c, { player: 0, deckSize: 60 }), 'invalid-prize-count-context');
  }
  assert.equal(calls, 0);
});
