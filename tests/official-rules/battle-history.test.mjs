import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  BATTLE_HISTORY_RULES, BattleHistoryError, createBattleHistory, normalizeKnockoutEvent,
  assertBattleHistory, recordBattleTurn, recordBattleEvent, previousOpponentTurn,
  hadKnockoutInPreviousOpponentTurn, wasMovedFromBenchToActiveThisTurn,
  wasSupporterPlayedFromHandThisTurn, wasHealedThisTurn,
} from '../../public/rules/battle-history.js';

// These are independent event/ledger builders, not the implementation's append
// APIs. All "card" evidence below is synthetic, not production card approval.
const clone = (value) => structuredClone(value);
const evidence = [{
  sourceId: 'fixture:battle-history', kind: 'official-card', url: 'https://www.pokemon.cn/',
  locator: 'TEST ONLY: synthetic source, not an actual official card or approval',
}];
const source = (owner = 1, extra = {}) => ({
  instanceId: `source-card-${owner}`, owner, category: 'attack', pokemonId: `attacker-${owner}`,
  attackId: 'fixture:strike', effectId: 'attack:fixture:strike', sourceOfTruth: clone(evidence), ...extra,
});
const ko = (turn, during, owner, kind = 'attackDamage', extra = {}) => ({
  kind: 'ko', turn, during, owner, pokemonId: `victim-${owner}-${turn}`,
  cause: { kind, source: ['attackDamage', 'effect'].includes(kind) ? source(during ?? 1 - owner) : null },
  ...extra,
});
const heal = (turn, during, owner, pokemonId = 'subject', amount = 10) =>
  ({ kind: 'heal', turn, during, owner, pokemonId, amount });
const move = (turn, during, owner, pokemonId = 'subject') =>
  ({ kind: 'benchToActive', turn, during, owner, pokemonId });
const supporter = (turn, during, owner, origin = 'hand') =>
  ({ kind: 'supporterPlayed', turn, during, owner, cardId: 'supporter-card', origin });
const ledger = (players, events = []) => ({
  schemaVersion: '1.0.0', turns: players.map((player, index) => ({ turn: index + 1, player })), events,
});
const clock = (history, during = history.turns.at(-1)?.player ?? null) => ({ turn: history.turns.length, during });
const rejects = (fn, code) => assert.throws(fn, (error) => {
  assert(error instanceof BattleHistoryError);
  assert(error instanceof TypeError);
  assert.equal(error.name, 'BattleHistoryError');
  if (code) assert.equal(error.code, code);
  return true;
});
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('the independent history rules cite the reviewed CN original and exact one-based PDF pages', () => {
  const expected = {
    previousOpponentKO: ['II.E-11', [58, 59]], benchToActive: ['II.E-24', [66, 67]],
    supporterFromHand: ['II.E-25', [67]], healed: ['II.E-26', [67]],
    checkup: ['I.F; II.E-20', [16, 64]],
    knockoutCause: ['I.D; II.C-07—08; II.E-11', [14, 30, 31, 58, 59]],
  };
  assert(Object.isFrozen(BATTLE_HISTORY_RULES));
  for (const [name, [section, pdfPages]] of Object.entries(expected)) {
    const rule = BATTLE_HISTORY_RULES[name];
    assert.equal(rule.rulesetId, 'CN/V20261019');
    assert(rule.id.startsWith('history.'));
    assert.deepEqual(rule.sourceOfTruth, [{ documentId: 'CN-advanced-3.1.0', section, pdfPages }]);
    assert(Object.isFrozen(rule)); assert(Object.isFrozen(rule.sourceOfTruth));
    assert(Object.isFrozen(rule.sourceOfTruth[0])); assert(Object.isFrozen(rule.sourceOfTruth[0].pdfPages));
  }
  assert.equal(new Set(Object.values(BATTLE_HISTORY_RULES).map((rule) => rule.id)).size, 6);
});

test('fresh setup, normal turns, additional consecutive turns and chronological append are pure', () => {
  const empty = freeze(createBattleHistory()), setup = { turn: 0, during: null };
  assert.deepEqual(empty, { schemaVersion: '1.0.0', turns: [], events: [] });
  assert.equal(assertBattleHistory(empty, setup), empty);
  assert.equal(previousOpponentTurn(empty, setup, 0), null);
  assert.equal(hadKnockoutInPreviousOpponentTurn(empty, setup, { owner: 0 }), false);
  assert.equal(wasHealedThisTurn(empty, setup, 0, 'subject'), false);
  const first = recordBattleTurn(empty, freeze({ turn: 1, player: 1 }));
  const event = freeze(ko(1, 1, 0)), firstBefore = clone(first);
  const withKO = recordBattleEvent(freeze(first), event, clock(first));
  const second = recordBattleTurn(freeze(withKO), { turn: 2, player: 1 });
  const third = recordBattleTurn(second, { turn: 3, player: 0 });
  assert.deepEqual(first, firstBefore); assert.equal(empty.turns.length, 0);
  assert.notEqual(withKO.events[0], event); assert.notEqual(withKO.events[0].cause.source, event.cause.source);
  assert.deepEqual(third.turns, [{ turn: 1, player: 1 }, { turn: 2, player: 1 }, { turn: 3, player: 0 }]);
  assert.equal(hadKnockoutInPreviousOpponentTurn(third, clock(third), { owner: 0 }), false,
    'Only the most recent opponent turn counts, not any earlier one.');
  const previous = previousOpponentTurn(third, clock(third), 0); previous.player = 0;
  assert.equal(third.turns[1].player, 1, 'Query results cannot mutate the ledger.');
  const checkupEvent = ko(1, null, 1, 'checkup');
  const checked = recordBattleEvent(withKO, checkupEvent, { turn: 1, during: null });
  assert.equal(checked.events[1].during, null);
  assert.equal(recordBattleTurn(checked, { turn: 2, player: 0 }).turns.length, 2);
});

test('KO normalization retains actual sources and both holders without inventing legacy cause data', () => {
  for (const owner of [0, 1]) for (const kind of ['attackDamage', 'effect', 'checkup', 'rule']) {
    const input = freeze(ko(2, kind === 'checkup' ? null : 1 - owner, owner, kind));
    const actual = normalizeKnockoutEvent(input);
    assert.deepEqual(actual, input); assert.notEqual(actual, input);
    if (input.cause.source) {
      actual.cause.source.sourceOfTruth[0].locator = 'detached';
      assert.notEqual(actual.cause.source.sourceOfTruth[0].locator, input.cause.source.sourceOfTruth[0].locator);
    }
  }
  rejects(() => normalizeKnockoutEvent({ kind: 'ko', turn: 1, during: 1, pokemonId: 'legacy' }), 'invalid-history-event');
  rejects(() => normalizeKnockoutEvent({ ...ko(1, 1, 0), cause: null }), 'invalid-history-event');
  rejects(() => normalizeKnockoutEvent(heal(1, 1, 0)), 'invalid-history-event');
});

test('E-11 both players: any KO is distinct from attack damage, self damage, attack effects and checkup', () => {
  for (const owner of [0, 1]) {
    const opponent = 1 - owner;
    for (const kind of ['attackDamage', 'effect', 'checkup', 'rule']) {
      const h = ledger([owner, opponent, owner], [ko(2, kind === 'checkup' ? null : opponent, owner, kind)]);
      const c = clock(h), any = kind !== 'checkup';
      assert.equal(hadKnockoutInPreviousOpponentTurn(h, c, { owner }), any);
      assert.equal(hadKnockoutInPreviousOpponentTurn(h, c, { owner, cause: 'any' }), any);
      assert.equal(hadKnockoutInPreviousOpponentTurn(h, c, { owner, cause: 'attackDamage' }), kind === 'attackDamage');
      assert.equal(hadKnockoutInPreviousOpponentTurn(h, c, { owner, cause: 'attackDamage', attacker: opponent }), kind === 'attackDamage');
      assert.equal(hadKnockoutInPreviousOpponentTurn(h, c, { owner, cause: 'attackDamage', attacker: owner }), false);
      assert.equal(hadKnockoutInPreviousOpponentTurn(h, c, { owner: opponent }), false, 'Off-turn card conditions do not become true.');
    }
    const opponentSelfKO = ledger([owner, opponent, owner], [ko(2, opponent, opponent)]);
    assert.equal(hadKnockoutInPreviousOpponentTurn(opponentSelfKO, clock(opponentSelfKO), { owner }), false);
    const ownTurnKO = ledger([opponent, owner], [ko(2, owner, owner)]);
    assert.equal(hadKnockoutInPreviousOpponentTurn(ownTurnKO, clock(ownTurnKO), { owner }), false);
    const noPrevious = ledger([owner, owner, owner], [ko(1, owner, owner)]);
    assert.equal(previousOpponentTurn(noPrevious, clock(noPrevious), owner), null);
    assert.equal(hadKnockoutInPreviousOpponentTurn(noPrevious, clock(noPrevious), { owner }), false);
  }
});

test('extra own turns retain the last actual opposing turn; extra opposing turns replace it', () => {
  for (const owner of [0, 1]) {
    const other = 1 - owner;
    const retained = ledger([other, owner, owner, owner], [ko(1, other, owner)]);
    assert.deepEqual(previousOpponentTurn(retained, clock(retained), owner), { turn: 1, player: other });
    assert.equal(hadKnockoutInPreviousOpponentTurn(retained, clock(retained), { owner }), true);
    const stale = ledger([other, other, owner, owner], [ko(1, other, owner)]);
    assert.deepEqual(previousOpponentTurn(stale, clock(stale), owner), { turn: 2, player: other });
    assert.equal(hadKnockoutInPreviousOpponentTurn(stale, clock(stale), { owner }), false);
    const latest = ledger([other, other, owner, owner], [ko(2, other, owner)]);
    assert.equal(hadKnockoutInPreviousOpponentTurn(latest, clock(latest), { owner }), true);
    const checkup = ledger([other, owner, owner], [ko(1, null, owner, 'effect')]);
    assert.equal(hadKnockoutInPreviousOpponentTurn(checkup, clock(checkup), { owner }), false,
      'A real card effect during checkup still is not an opposing-turn KO.');
  }
});

test('E-11 multi-KO is a boolean, persists without a target board, and uses actual attack actor not copied content', () => {
  const actualSource = source(1, {
    instanceId: 'shared-provider', cardOwner: 0, origin: 'field',
    contentSource: { instanceId: 'content-owned-by-zero', attackId: 'fixture:copied' }, copyId: 'copy:receipt',
  });
  const h = ledger([1, 0], [
    ko(1, 1, 0, 'attackDamage', { pokemonId: 'first', cause: { kind: 'attackDamage', source: actualSource } }),
    ko(1, 1, 0, 'attackDamage', { pokemonId: 'second' }),
  ]);
  const before = clone(h), c = freeze(clock(h));
  freeze(h);
  assert.equal(hadKnockoutInPreviousOpponentTurn(h, c, { owner: 0, cause: 'attackDamage', attacker: 1 }), true);
  assert.equal(hadKnockoutInPreviousOpponentTurn(h, c, { owner: 0, cause: 'attackDamage', attacker: 0 }), false);
  assert.deepEqual(h, before);
  const granted = clone(h); granted.events[0].cause.source.grantId = 'grant:receipt';
  delete granted.events[0].cause.source.copyId;
  assert.equal(assertBattleHistory(granted, c), granted);
  const ruleWithSource = ledger([1, 0], [ko(1, 1, 0, 'rule', {
    cause: { kind: 'rule', source: source(1, { category: 'rule', pokemonId: null, attackId: null }) },
  })]);
  assert.equal(hadKnockoutInPreviousOpponentTurn(ruleWithSource, clock(ruleWithSource), { owner: 0 }), true);
});

// Independent oracle: choose an opponent turn by comparing all real records,
// then count matching facts. No production lookup or append helper is used.
function oracleKO(h, c, owner, filter = 'any', attacker) {
  if (c.during !== owner) return false;
  const candidates = h.turns.filter((t) => t.player === 1 - owner && t.turn < c.turn);
  const turn = candidates.reduce((latest, t) => Math.max(latest, t.turn), 0);
  return h.events.filter((event) => event.kind === 'ko' && event.owner === owner &&
    event.turn === turn && event.during === 1 - owner &&
    (filter === 'any' || event.cause.kind === 'attackDamage') &&
    (attacker === undefined || event.cause.source?.owner === attacker)).length > 0;
}

test('exhaustive independent oracle covers all player sequences of one to five turns and every KO boundary/cause', () => {
  let checks = 0;
  for (let length = 1; length <= 5; length++) for (let bits = 0; bits < 2 ** length; bits++) {
    const players = Array.from({ length }, (_, i) => bits >> i & 1);
    for (const owner of [0, 1]) for (let turn = 1; turn <= length; turn++) {
      for (const kind of ['attackDamage', 'effect', 'rule', 'checkup']) {
        for (const boundary of kind === 'attackDamage' ? [players[turn - 1]] :
          kind === 'checkup' ? [null] : [players[turn - 1], null]) {
          const h = ledger(players, [ko(turn, boundary, owner, kind)]);
          for (const evaluationBoundary of [players.at(-1), null]) {
            // During the last actual turn, its subsequent checkup is still future.
            if (turn === length && boundary === null && evaluationBoundary !== null) continue;
            const c = clock(h, evaluationBoundary);
            for (const filter of ['any', 'attackDamage']) {
              const options = { owner, cause: filter };
              assert.equal(hadKnockoutInPreviousOpponentTurn(h, c, options), oracleKO(h, c, owner, filter));
              checks++;
              if (filter === 'attackDamage') for (const attacker of [0, 1]) {
                assert.equal(hadKnockoutInPreviousOpponentTurn(h, c, { ...options, attacker }), oracleKO(h, c, owner, filter, attacker));
                checks++;
              }
            }
          }
        }
      }
    }
  }
  assert(checks > 20000);
});

test('E-24/25/26 use actual same-turn facts, not present board state or hypothetical effects', () => {
  for (const owner of [0, 1]) {
    const h = ledger([1 - owner, owner], [
      move(1, 1 - owner, owner), heal(1, 1 - owner, owner), supporter(1, 1 - owner, owner),
      supporter(2, owner, owner, 'deck'), heal(2, owner, owner, 'subject', 0),
    ]), c = clock(h);
    assert.equal(wasMovedFromBenchToActiveThisTurn(h, c, owner, 'subject'), false);
    assert.equal(wasSupporterPlayedFromHandThisTurn(h, c, owner), false);
    assert.equal(wasHealedThisTurn(h, c, owner, 'subject'), false);
    let actual = recordBattleEvent(h, move(2, owner, owner), c);
    actual = recordBattleEvent(actual, move(2, owner, owner), c);
    actual = recordBattleEvent(actual, heal(2, owner, owner, 'subject', 10), c);
    actual = recordBattleEvent(actual, heal(2, owner, owner, 'subject', 30), c);
    actual = recordBattleEvent(actual, supporter(2, owner, owner), c);
    const before = clone(actual); freeze(actual);
    assert.equal(wasMovedFromBenchToActiveThisTurn(actual, c, owner, 'subject'), true);
    assert.equal(wasHealedThisTurn(actual, c, owner, 'subject'), true);
    assert.equal(wasSupporterPlayedFromHandThisTurn(actual, c, owner), true);
    assert.equal(wasMovedFromBenchToActiveThisTurn(actual, c, owner, 'reentered-new-identity'), false);
    assert.equal(wasHealedThisTurn(actual, c, owner, 'copied-attack-content-holder'), false);
    for (const other of [1 - owner]) {
      assert.equal(wasMovedFromBenchToActiveThisTurn(actual, c, other, 'subject'), false);
      assert.equal(wasHealedThisTurn(actual, c, other, 'subject'), false);
      assert.equal(wasSupporterPlayedFromHandThisTurn(actual, c, other), false);
    }
    assert.deepEqual(actual, before);
    const next = recordBattleTurn(actual, { turn: 3, player: owner });
    assert.equal(wasHealedThisTurn(next, clock(next), owner, 'subject'), false);
    assert.equal(wasMovedFromBenchToActiveThisTurn(next, clock(next), owner, 'subject'), false);
    assert.equal(wasSupporterPlayedFromHandThisTurn(next, clock(next), owner), false);
  }
});

test('same-turn queries exclude checkup facts, other holders, non-Hand Supporters and no-op recovery', () => {
  for (const owner of [0, 1]) {
    for (const origin of ['deck', 'discard', 'prizes']) {
      const h = ledger([owner], [supporter(1, owner, owner, origin)]);
      assert.equal(wasSupporterPlayedFromHandThisTurn(h, clock(h), owner), false);
    }
    const h = ledger([owner], [move(1, owner, 1 - owner, 'other'),
      heal(1, owner, 1 - owner, 'other'), supporter(1, owner, 1 - owner)]);
    assert.equal(wasMovedFromBenchToActiveThisTurn(h, clock(h), owner, 'subject'), false);
    assert.equal(wasHealedThisTurn(h, clock(h), owner, 'subject'), false);
    assert.equal(wasSupporterPlayedFromHandThisTurn(h, clock(h), owner), false);
    const checked = ledger([owner], [move(1, null, owner), heal(1, null, owner), supporter(1, null, owner)]);
    const c = clock(checked, null);
    assert.equal(wasMovedFromBenchToActiveThisTurn(checked, c, owner, 'subject'), false);
    assert.equal(wasHealedThisTurn(checked, c, owner, 'subject'), false);
    assert.equal(wasSupporterPlayedFromHandThisTurn(checked, c, owner), false);
    assert.equal(hadKnockoutInPreviousOpponentTurn(checked, c, { owner }), false);
  }
});

test('independent same-turn oracle includes zero/positive recovery, identity, holder, origin and phase', () => {
  let checks = 0;
  for (const owner of [0, 1]) for (const during of [0, 1, null]) for (const eventOwner of [0, 1]) {
    for (const amount of [0, 10, 30]) for (const id of ['subject', 'other']) for (const origin of ['hand', 'deck', 'discard', 'prizes']) {
      const players = [1 - (during ?? owner), during ?? owner];
      const h = ledger(players, [move(2, during, eventOwner, id), heal(2, during, eventOwner, id, amount), supporter(2, during, eventOwner, origin)]);
      const c = clock(h, during), visible = during === owner && eventOwner === owner;
      assert.equal(wasMovedFromBenchToActiveThisTurn(h, c, owner, 'subject'), visible && id === 'subject');
      assert.equal(wasHealedThisTurn(h, c, owner, 'subject'), visible && id === 'subject' && amount >= 10);
      assert.equal(wasSupporterPlayedFromHandThisTurn(h, c, owner), visible && origin === 'hand');
      checks += 3;
    }
  }
  assert.equal(checks, 864);
});

test('reject missing, future, noncontiguous, duplicate, unsafe or contradictory turn records and clocks', () => {
  const good = ledger([0, 1, 0]), c = clock(good);
  for (const mutate of [
    (h) => { h.schemaVersion = 'latest'; }, (h) => { h.unexpected = true; },
    (h) => { delete h.events; }, (h) => { h.turns = null; }, (h) => { h.events = {}; },
    (h) => { h.turns.pop(); }, (h) => { h.turns.push({ turn: 4, player: 1 }); },
    (h) => { h.turns[0].turn = 0; }, (h) => { h.turns[1].turn = 1; }, (h) => { h.turns[1].turn = 3; },
    (h) => { h.turns[1].turn = Number.MAX_SAFE_INTEGER + 1; }, (h) => { h.turns[0].player = false; },
    (h) => { h.turns[0].extra = true; }, (h) => { h.turns[2].player = 1; },
  ]) { const h = clone(good); mutate(h); rejects(() => assertBattleHistory(h, c)); }
  for (const invalid of [
    null, [], {}, { turn: -1, during: null }, { turn: 0, during: 0 }, { turn: 3, during: 1 },
    { turn: 3, during: 2 }, { turn: 3, during: false }, { turn: 3.1, during: 0 },
    { turn: Number.MAX_SAFE_INTEGER + 1, during: 0 }, { turn: 3, during: 0, phase: 'main' },
  ]) rejects(() => assertBattleHistory(good, invalid));
  assert.equal(assertBattleHistory(good, clock(good, null)), good);
  for (const invalid of [{ turn: 0, player: 0 }, { turn: 3, player: 1 }, { turn: 5, player: 0 },
    { turn: 4, player: 2 }, { turn: 4, player: 0, extra: true }])
    rejects(() => recordBattleTurn(good, invalid));
  rejects(() => recordBattleTurn({ ...good, turns: null }, { turn: 1, player: 0 }));
  rejects(() => recordBattleTurn(null, { turn: 1, player: 0 }));
});

test('reject temporal rewinds, wrong during-player, checkup-as-turn, stale appends and post-KO identity reuse', () => {
  const players = [0, 1, 0];
  for (const events of [
    [ko(4, 1, 0)], [ko(0, 0, 1)], [ko(-1, 0, 1)], [ko(2, 0, 1)],
    [ko(3, null, 1, 'checkup')], [ko(2, 1, 0), ko(1, 0, 1)],
    [ko(2, null, 0, 'checkup'), heal(2, 1, 1)],
    [ko(2, 1, 0), ko(2, 1, 0)],
    [ko(2, 1, 0), heal(3, 0, 0, 'victim-0-2')],
    [heal(1, 0, 0, 'same'), move(2, 1, 1, 'same')],
    [ko(1, 0, 1), ko(2, 1, 0, 'effect', { cause: { kind: 'effect', source: source(0, { pokemonId: 'victim-1-1' }) } })],
  ]) {
    const h = ledger(players, events), before = clone(h);
    rejects(() => assertBattleHistory(h, clock(h)));
    assert.deepEqual(h, before);
  }
  const h = ledger(players);
  rejects(() => recordBattleEvent(h, heal(2, 1, 0), clock(h)), 'invalid-history-time');
  rejects(() => recordBattleEvent(h, heal(3, null, 0), clock(h)), 'invalid-history-time');
  rejects(() => recordBattleEvent(createBattleHistory(), ko(1, 0, 1), { turn: 0, during: null }), 'invalid-history-time');
  const delayed = ledger([0, 1], [ko(1, 0, 1), ko(2, 1, 0, 'effect', {
    cause: { kind: 'effect', source: source(1, { pokemonId: 'victim-1-1' }) },
  })]);
  assert.equal(assertBattleHistory(delayed, clock(delayed)), delayed,
    'A real delayed source can remain causal after its own KO; target identity retirement is separate.');
});

test('strict KO causes reject absent/fabricated sources and impossible damage/checkup attribution', () => {
  for (const event of [
    null, [], {}, { ...ko(1, 1, 0), kind: '__proto__' }, { ...ko(1, 1, 0), extra: true },
    { ...ko(1, 1, 0), turn: '1' }, { ...ko(1, 1, 0), owner: 2 },
    { ...ko(1, 1, 0), during: false }, { ...ko(1, 1, 0), pokemonId: '' },
    { ...ko(1, 1, 0), cause: { kind: 'unknown', source: null } },
    { ...ko(1, 1, 0), cause: { kind: 'attackDamage', source: null } },
    { ...ko(1, 1, 0), cause: { kind: 'effect', source: null } },
    { ...ko(1, 1, 0), cause: { kind: 'attackDamage', source: source(1, { category: 'ability' }) } },
    { ...ko(1, 1, 0), cause: { kind: 'attackDamage', source: source(0) } },
    ko(1, null, 0), ko(1, 1, 0, 'checkup'),
    { ...ko(1, null, 0, 'checkup'), cause: { kind: 'checkup', source: source(1) } },
    { ...ko(1, 1, 0), cause: { kind: 'rule', source: null, sourceOwner: 1 } },
  ]) rejects(() => normalizeKnockoutEvent(event));
  const trainerEffect = ko(1, null, 0, 'effect', { cause: { kind: 'effect',
    source: source(1, { category: 'trainer', pokemonId: null, attackId: null, origin: 'field' }) } });
  assert.deepEqual(normalizeKnockoutEvent(trainerEffect), trainerEffect);
});

test('strict source contracts preserve all runtime identities, evidence and copy/grant provenance', () => {
  for (const mutate of [
    (s) => { s.extra = true; }, (s) => { s.instanceId = ''; }, (s) => { s.owner = 2; },
    (s) => { s.effectId = null; }, (s) => { s.category = 'pokemon'; }, (s) => { s.pokemonId = ''; },
    (s) => { s.attackId = 1; }, (s) => { s.pokemonId = null; }, (s) => { s.attackId = null; },
    (s) => { s.origin = null; }, (s) => { s.cardOwner = false; }, (s) => { s.sourceOfTruth = []; },
    (s) => { s.sourceOfTruth = {}; }, (s) => { s.sourceOfTruth[0].extra = true; },
    (s) => { s.sourceOfTruth[0].sourceId = ''; }, (s) => { s.sourceOfTruth[0].sourceId = 2; },
    (s) => { s.sourceOfTruth[0].sourceId = 'a'.repeat(201); }, (s) => { s.sourceOfTruth[0].kind = 'wiki'; },
    (s) => { s.sourceOfTruth[0].url = 2; }, (s) => { s.sourceOfTruth[0].url = 'https://www.pokemon.cn.evil/'; },
    (s) => { s.sourceOfTruth[0].locator = ''; }, (s) => { s.sourceOfTruth[0].textSha256 = 'invalid'; },
    (s) => { s.sourceOfTruth[0].textSha256 = 2; }, (s) => { s.sourceOfTruth[0].observedOn = 'today'; },
    (s) => { s.sourceOfTruth[0].observedOn = 2; }, (s) => { s.copyId = 'missing-reference'; },
    (s) => { s.grantId = 'missing-reference'; },
    (s) => { s.contentSource = { instanceId: 'content', attackId: 'attack' }; },
    (s) => { s.contentSource = { instanceId: 'content', attackId: 'attack' }; s.copyId = ''; },
    (s) => { s.contentSource = { instanceId: 'content', attackId: 'attack' }; s.grantId = ''; },
    (s) => { s.contentSource = { instanceId: 'content', attackId: 'attack' }; s.copyId = 'c'; s.grantId = 'g'; },
    (s) => { s.contentSource = {}; s.copyId = 'c'; },
    (s) => { s.contentSource = { instanceId: '', attackId: 'attack' }; s.copyId = 'c'; },
    (s) => { s.contentSource = { instanceId: 'content', attackId: '' }; s.copyId = 'c'; },
    (s) => { s.category = 'trainer'; s.contentSource = { instanceId: 'content', attackId: 'attack' }; s.copyId = 'c'; },
  ]) {
    const s = source(1); mutate(s);
    rejects(() => normalizeKnockoutEvent(ko(1, 1, 0, 'effect', { cause: { kind: 'effect', source: s } })), 'invalid-history-source');
  }
  for (const category of ['attack', 'ability', 'trainer', 'energy', 'rule']) {
    const s = source(1, { category, origin: 'prizes', cardOwner: 0 });
    s.sourceOfTruth[0].textSha256 = 'a'.repeat(64);
    s.sourceOfTruth[0].observedOn = '2026-10-19';
    const event = ko(1, 1, 0, 'effect', { cause: { kind: 'effect', source: s } });
    assert.deepEqual(normalizeKnockoutEvent(event), event);
  }
});

test('strict fact contracts and query options reject silent coercion, missing identities and guessed conditions', () => {
  for (const event of [
    heal(1, 0, 0, 'subject', -10), heal(1, 0, 0, 'subject', 1), heal(1, 0, 0, 'subject', 5),
    heal(1, 0, 0, 'subject', 9007199254741000), heal(1, 0, 0, 'subject', 1.5),
    { ...supporter(1, 0, 0), cardId: '' }, supporter(1, 0, 0, 'field'),
    { ...move(1, 0, 0), from: 'hand' }, { ...heal(1, 0, 0), amount: '10' },
  ]) rejects(() => recordBattleEvent(ledger([0]), event, { turn: 1, during: 0 }), 'invalid-history-event');
  const h = ledger([1, 0]), c = clock(h);
  for (const options of [
    null, [], {}, { owner: 2 }, { owner: false }, { owner: '0' }, { owner: 0, cause: null },
    { owner: 0, cause: 'effect' }, { owner: 0, cause: 'any', attacker: 1 },
    { owner: 0, cause: 'attackDamage', attacker: null }, { owner: 0, cause: 'attackDamage', attacker: 2 },
    { owner: 0, pokemonId: 'unrequested-filter' },
  ]) rejects(() => hadKnockoutInPreviousOpponentTurn(h, c, options), 'invalid-history-query');
  rejects(() => previousOpponentTurn(h, c, 2), 'invalid-history-query');
  rejects(() => wasSupporterPlayedFromHandThisTurn(h, c, null), 'invalid-history-query');
  for (const id of [null, '', 1]) {
    rejects(() => wasHealedThisTurn(h, c, 0, id), 'invalid-history-query');
    rejects(() => wasMovedFromBenchToActiveThisTurn(h, c, 0, id), 'invalid-history-query');
  }
});

test('non-JSON data never disappears, invokes getters, mutates input or gains semantics after serialization', () => {
  const h = ledger([0]), c = clock(h);
  const values = [undefined, NaN, Infinity, () => true, 1n, new Date(), new Map(), new Set(),
    new (class Custom { constructor() { this.value = 1; } })(), Object.create(Array.prototype)];
  const cyclic = {}; cyclic.self = cyclic; values.push(cyclic);
  const sparse = Array(1); values.push(sparse);
  const extra = []; extra.unexpected = true; values.push(extra);
  const nullArrayPrototype = []; Object.setPrototypeOf(nullArrayPrototype, null); values.push(nullArrayPrototype);
  const objectArrayPrototype = []; Object.setPrototypeOf(objectArrayPrototype, Object.prototype); values.push(objectArrayPrototype);
  const negative = [1]; negative['-1'] = 2; values.push(negative);
  const nonIndex = [1]; delete nonIndex[0]; nonIndex['00'] = 2; values.push(nonIndex);
  const symbolic = {}; symbolic[Symbol('secret')] = true; values.push(symbolic);
  const hidden = {}; Object.defineProperty(hidden, 'hidden', { value: 1 }); values.push(hidden);
  let getterCalls = 0;
  const getter = {}; Object.defineProperty(getter, 'value', { enumerable: true, get() { getterCalls++; return 1; } }); values.push(getter);
  for (const invalid of values) {
    rejects(() => assertBattleHistory({ ...h, events: [invalid] }, c), 'invalid-history-json');
    rejects(() => normalizeKnockoutEvent(invalid), 'invalid-history-json');
  }
  assert.equal(getterCalls, 0);
  const nullPrototype = Object.assign(Object.create(null), h);
  assert.equal(assertBattleHistory(nullPrototype, c), nullPrototype);
  const withBoolean = { ...h, extra: true };
  rejects(() => assertBattleHistory(withBoolean, c), 'invalid-history-shape');
  const valid = ledger([1, 0], [ko(1, 1, 0)]);
  assert.deepEqual(recordBattleTurn(JSON.parse(JSON.stringify(valid)), { turn: 3, player: 0 }),
    recordBattleTurn(valid, { turn: 3, player: 0 }));
  const shared = source(1); shared.sourceOfTruth.push(shared.sourceOfTruth[0]);
  assert.deepEqual(normalizeKnockoutEvent(ko(1, 1, 0, 'effect', { cause: { kind: 'effect', source: shared } })).cause.source.sourceOfTruth,
    JSON.parse(JSON.stringify(shared.sourceOfTruth)), 'Shared acyclic JS references have no extra protocol meaning.');
});

test('independent schema compiles without generated validators and leaves temporal assertions explicit', async () => {
  const directory = new URL('../../schemas/', import.meta.url);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const filename of await readdir(directory)) if (filename.endsWith('.schema.json'))
    ajv.addSchema(JSON.parse(await readFile(new URL(filename, directory), 'utf8')));
  const validate = ajv.getSchema('urn:pokemon-tcg:battle-history:1.0.0');
  const h = ledger([1, 0], [
    ko(1, 1, 0), ko(1, null, 1, 'checkup'),
    move(2, 0, 0), heal(2, 0, 0), supporter(2, 0, 0),
  ]);
  assert(validate(h), JSON.stringify(validate.errors));
  for (const event of [ko(1, 1, 0, 'effect'), ko(1, 1, 0, 'rule'), ko(1, null, 0, 'effect')])
    assert(validate(ledger([1, 0], [event])), JSON.stringify(validate.errors));
  for (const bad of [
    { ...h, extra: true }, { ...h, schemaVersion: '2.0.0' }, ledger([1, 0], [{ kind: 'ko', turn: 1, during: 1, pokemonId: 'legacy' }]),
    ledger([1, 0], [ko(1, null, 0)]), ledger([1, 0], [ko(1, 1, 0, 'checkup')]),
    ledger([1, 0], [{ ...ko(1, 1, 0), cause: { kind: 'effect', source: null } }]),
    ledger([1, 0], [{ ...ko(1, 1, 0), cause: { kind: 'attackDamage', source: source(1, { category: 'trainer' }) } }]),
    ledger([1, 0], [heal(2, 0, 0, 'subject', 5)]),
  ]) assert.equal(validate(bad), false);
  const future = ledger([1, 0], [ko(3, 1, 0)]);
  assert.equal(validate(future), true, 'A schema alone cannot prove the actual timeline.');
  rejects(() => assertBattleHistory(future, clock(future)), 'invalid-history-time');
});
