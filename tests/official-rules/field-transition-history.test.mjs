// Software observed facts, not card approvals, source authorization or a
// reconstruction of the complete board. All identities below are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  BATTLE_HISTORY_RULES, BattleHistoryError, FIELD_TRANSITION_HISTORY_SOURCES, TURN_ENDED_HISTORY_SOURCES,
  createBattleHistory, assertBattleHistory, recordBattleTurn, recordBattleEvent, normalizeKnockoutEvent,
  previousOpponentTurn, hadKnockoutInPreviousOpponentTurn, wasMovedFromBenchToActiveThisTurn,
  wasSupporterPlayedFromHandThisTurn, wasHealedThisTurn,
} from '../../public/rules/battle-history.js';

const clone = (value) => structuredClone(value);
const ledger = (players, events = []) => ({
  schemaVersion: '1.0.0', turns: players.map((player, i) => ({ turn: i + 1, player })), events,
});
const transition = (extra = {}) => ({
  kind: 'fieldTransition', turn: 1, during: 0, owner: 0, pokemonId: 'pokemon:subject',
  fromCardId: 'card:before', toCardId: 'card:after', method: 'evolution', ...extra,
});
const ended = (extra = {}) => ({ kind: 'turnEnded', turn: 1, during: 0, owner: 0, ...extra });
const knockout = (extra = {}) => ({
  kind: 'ko', turn: 1, during: 0, owner: 0, pokemonId: 'pokemon:subject',
  cause: { kind: 'rule', source: null }, ...extra,
});
const reject = (fn, code) => assert.throws(fn, (error) =>
  error instanceof BattleHistoryError && (code === undefined || error.code === code));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function nullPrototypes(value) {
  if (Array.isArray(value)) return value.map(nullPrototypes);
  if (value && typeof value === 'object') return Object.assign(Object.create(null),
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nullPrototypes(item)])));
  return value;
}

// Read-only transitive schema compilation, independent of generated validators.
const ajv = new Ajv2020({ strict: true, allErrors: true }), loaded = new Map();
async function register(name) {
  const doc = JSON.parse(await readFile(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
  if (loaded.has(doc.$id)) return;
  loaded.set(doc.$id, doc); ajv.addSchema(doc);
  const work = [doc];
  while (work.length) {
    const item = work.pop();
    if (!item || typeof item !== 'object') continue;
    if (typeof item.$ref === 'string' && item.$ref.startsWith('urn:pokemon-tcg:')) {
      const id = item.$ref.split('#')[0], key = id.split(':')[2];
      if (!loaded.has(id)) await register(key === 'core-handler-parameters' ? 'handler-parameters' : key);
    }
    work.push(...Object.values(item));
  }
}
await register('battle-history');
const schema = loaded.get('urn:pokemon-tcg:battle-history:1.0.0');
const validateHistory = ajv.getSchema(schema.$id);
const validateTransition = ajv.getSchema(`${schema.$id}#/$defs/fieldTransition`);
const validateEnded = ajv.getSchema(`${schema.$id}#/$defs/turnEnded`);

test('new observed-fact sources cite the pinned CN pages without changing the six existing condition/query rules', () => {
  assert.equal(Object.keys(BATTLE_HISTORY_RULES).length, 6);
  assert.deepEqual(FIELD_TRANSITION_HISTORY_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.C-15', pdfPages: [36] },
    { documentId: 'CN-advanced-3.1.0', section: 'I.A-05', pdfPages: [10] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.C-13', pdfPages: [35] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.D-19', pdfPages: [52, 53] },
  ]);
  assert.deepEqual(TURN_ENDED_HISTORY_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'I.A-01', pdfPages: [5] },
    { documentId: 'CN-advanced-3.1.0', section: 'I.F', pdfPages: [16] },
  ]);
  for (const sources of [FIELD_TRANSITION_HISTORY_SOURCES, TURN_ENDED_HISTORY_SOURCES]) {
    assert(Object.isFrozen(sources));
    for (const source of sources) { assert(Object.isFrozen(source)); assert(Object.isFrozen(source.pdfPages)); }
  }
  assert.match(schema.$comment, /II\.C-15 PDF p36.*I\.A-05 p10.*II\.C-13 p35.*II\.D-19 p52–53/);
  assert.match(schema.$comment, /I\.A-01 p5 and I\.F p16/);
  assert.match(schema.$comment, /NOT officially prescribed fields/);
  assert.match(schema.$defs.fieldTransition.description, /inequality is enforced by assertBattleHistory/);
  assert.deepEqual(schema.$defs.fieldTransition.required, Object.keys(transition()));
  assert.deepEqual(schema.$defs.turnEnded.required, Object.keys(ended()));
  assert.deepEqual(schema.$defs.event.oneOf.slice(-3), [
    { $ref: '#/$defs/fieldTransition' }, { $ref: '#/$defs/turnEnded' }, { $ref: '#/$defs/attackUsed' },
  ]);
});

test('both evolution methods and affected owners append detached actual facts on a turn or checkup without inventing a source', () => {
  for (const during of [0, 1, null]) for (const owner of [0, 1]) for (const method of ['evolution', 'devolution']) {
    const realPlayer = during ?? 0, clock = freeze({ turn: 1, during });
    const h = freeze(ledger([realPlayer])), event = freeze(transition({ during, owner, method }));
    const before = clone({ h, event, clock });
    const result = recordBattleEvent(h, event, clock);
    assert.deepEqual(result, { ...h, events: [event] });
    assert.notEqual(result, h); assert.notEqual(result.events[0], event);
    assert.equal(assertBattleHistory(result, clock), result);
    assert.equal(validateTransition(event), true); assert.equal(validateHistory(result), true);
    assert.deepEqual({ h, event, clock }, before);
    assert(!Object.hasOwn(result.events[0], 'source'));
    reject(() => normalizeKnockoutEvent(event), 'invalid-history-event');
  }
});

test('turnEnded is exactly a non-Pokemon actual-player boundary and skips holder/retired target handling', () => {
  for (const owner of [0, 1]) {
    const clock = { turn: 1, during: owner }, event = freeze(ended({ during: owner, owner }));
    const h = freeze(ledger([owner], [
      knockout({ during: owner, owner, pokemonId: 'retired' }),
      transition({ during: owner, owner: 1 - owner, pokemonId: 'still-live' }),
    ]));
    const next = recordBattleEvent(h, event, clock);
    assert.equal(next.events.length, 3); assert.deepEqual(next.events[2], event);
    assert.equal(validateHistory(next), true); assert.equal(validateEnded(event), true);
    const followingTurn = recordBattleTurn(next, { turn: 2, player: 1 - owner });
    assert.equal(followingTurn.turns.length, 2);
    assert.equal(assertBattleHistory(followingTurn, { turn: 2, during: 1 - owner }), followingTurn);
    reject(() => normalizeKnockoutEvent(event), 'invalid-history-event');
    for (const during of [null, 1 - owner])
      reject(() => recordBattleEvent(ledger([owner]), ended({ during, owner }), { turn: 1, during: owner }), 'invalid-history-event');
  }
});

// Independent shape oracles do not call a production validator or append API.
const isPlayer = (value) => value === 0 || value === 1;
const isId = (value) => typeof value === 'string' && value.length > 0;
const isTurn = (value) => Number.isSafeInteger(value) && value >= 1;
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function shapeOracle(event) {
  const common = ['kind', 'turn', 'during', 'owner'];
  if (event.kind === 'turnEnded') return exact(event, common) && isTurn(event.turn) &&
    isPlayer(event.owner) && event.during === event.owner;
  return event.kind === 'fieldTransition' &&
    exact(event, [...common, 'pokemonId', 'fromCardId', 'toCardId', 'method']) &&
    isTurn(event.turn) && (event.during === null || isPlayer(event.during)) && isPlayer(event.owner) &&
    isId(event.pokemonId) && isId(event.fromCardId) && isId(event.toCardId) &&
    ['evolution', 'devolution'].includes(event.method);
}
function accepted(history, clock) {
  try { assertBattleHistory(history, clock); return true; }
  catch (error) { assert(error instanceof BattleHistoryError); return false; }
}

test('independent schema/semantic oracle exhausts physical from/to, methods, affected owners and actual boundaries', (t) => {
  let checks = 0;
  for (const fromCardId of ['', 'a', 'b', 1, null]) for (const toCardId of ['', 'a', 'b', 1, null])
    for (const method of ['evolution', 'devolution', 'inheritance', 'EVOLUTION', null, 1])
      for (const owner of [0, 1]) for (const during of [null, 0, 1]) for (const realPlayer of [0, 1]) {
        const event = transition({ fromCardId, toCardId, method, owner, during });
        const shape = shapeOracle(event), h = ledger([realPlayer], [event]);
        assert.equal(validateTransition(event), shape);
        assert.equal(validateHistory(h), shape);
        const expected = shape && fromCardId !== toCardId && (during === null || during === realPlayer);
        assert.equal(accepted(h, { turn: 1, during: during === null ? null : realPlayer }), expected);
        checks++;
      }
  assert.equal(checks, 1800);
  const equal = transition({ fromCardId: 'same', toCardId: 'same' });
  assert.equal(validateTransition(equal), true, 'Standard JSON Schema shape is not arbitrary sibling-value inequality.');
  reject(() => recordBattleEvent(ledger([0]), equal, { turn: 1, during: 0 }), 'invalid-history-event');
  t.diagnostic(`${checks} independent fieldTransition shape/clock/inequality cases.`);
});

test('turnEnded schema and pure oracle agree on every small owner/during domain and safe-turn boundary', (t) => {
  const values = [null, 0, 1, 2, false, '0'];
  const turns = [-1, 0, 1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, '1', null];
  let checks = 0;
  for (const owner of values) for (const during of values) for (const turn of turns) {
    const event = ended({ owner, during, turn }), shape = shapeOracle(event);
    assert.equal(validateEnded(event), shape);
    assert.equal(validateHistory(ledger([0], [event])), shape);
    for (const realPlayer of [0, 1])
      assert.equal(accepted(ledger([realPlayer], [event]), { turn: 1, during: realPlayer }),
        shape && turn === 1 && owner === realPlayer);
    checks++;
  }
  assert.equal(checks, 288);
  t.diagnostic(`${checks} independent turnEnded shapes, each against both actual players.`);
});

// Independent temporal/lifecycle oracle: times are ranked turn, then checkup.
// It explicitly excludes turnEnded from target ownership/retirement maps.
function lifecycleOracle(players, events, boundary) {
  const now = 2 * players.length + (boundary === null ? 1 : 0);
  let previous = 0;
  const owners = new Map(), retired = new Set();
  for (const event of events) {
    if (event.kind === 'turnEnded' && !shapeOracle(event)) return false;
    if (event.during !== null && event.during !== players[event.turn - 1]) return false;
    const time = 2 * event.turn + (event.during === null ? 1 : 0);
    if (time < previous || time > now) return false;
    previous = time;
    if (event.kind === 'turnEnded') continue;
    if (retired.has(event.pokemonId) || owners.has(event.pokemonId) && owners.get(event.pokemonId) !== event.owner) return false;
    owners.set(event.pokemonId, event.owner);
    if (event.kind === 'ko') retired.add(event.pokemonId);
  }
  return true;
}

test('independent two-fact lifecycle oracle exhausts consecutive-player turns, checkup order, holder stability and retirement', (t) => {
  let checks = 0;
  for (let length = 1; length <= 3; length++) for (let bits = 0; bits < 2 ** length; bits++) {
    const players = Array.from({ length }, (_v, index) => bits >> index & 1);
    for (let firstTurn = 1; firstTurn <= length; firstTurn++) for (let secondTurn = 1; secondTurn <= length; secondTurn++)
      for (const firstKind of ['fieldTransition', 'ko', 'turnEnded']) for (const secondKind of ['fieldTransition', 'turnEnded'])
        for (const firstOwner of [0, 1]) for (const secondOwner of [0, 1])
          for (const firstCheckup of [false, true]) for (const secondCheckup of [false, true])
            for (const sameTarget of [false, true]) for (const boundary of [players.at(-1), null]) {
              const build = (kind, turn, during, owner, pokemonId) => kind === 'turnEnded' ?
                ended({ turn, during, owner }) : kind === 'ko' ? knockout({ turn, during, owner, pokemonId }) :
                  transition({ turn, during, owner, pokemonId, method: 'devolution' });
              const events = [
                build(firstKind, firstTurn, firstCheckup ? null : players[firstTurn - 1], firstOwner, 'subject'),
                build(secondKind, secondTurn, secondCheckup ? null : players[secondTurn - 1], secondOwner, sameTarget ? 'subject' : 'other'),
              ];
              const h = ledger(players, events), expected = lifecycleOracle(players, events, boundary);
              assert.equal(accepted(h, { turn: length, during: boundary }), expected);
              checks++;
            }
  }
  assert.equal(checks, 34560);
  t.diagnostic(`${checks} independent chronological/holder/retired-identity cases; no assumed turn alternation.`);
});

test('new types reject missing/extra/coerced fields, implicit methods, source payloads and generic log fields', () => {
  for (const [factory, validate] of [[transition, validateTransition], [ended, validateEnded]]) {
    for (const key of Object.keys(factory())) {
      const event = factory(); delete event[key];
      assert.equal(validate(event), false);
      reject(() => recordBattleEvent(ledger([0]), event, { turn: 1, during: 0 }));
    }
    for (const extra of [
      { source: null }, { data: {} }, { reason: 'evolution' }, { entryId: 'e1' }, { historyIndex: 0 },
      { id: 'event' }, { effectId: 'lock' }, { action: {} }, { visibility: 'private' },
      { cause: { kind: 'rule', source: null } }, { approved: true },
    ]) {
      const event = factory(extra); assert.equal(validate(event), false);
      reject(() => recordBattleEvent(ledger([0]), event, { turn: 1, during: 0 }), 'invalid-history-event');
    }
  }
  for (const value of ['', null, 1, false, {}, []]) {
    for (const key of ['pokemonId', 'fromCardId', 'toCardId', 'method']) {
      const event = transition({ [key]: value }); assert.equal(validateTransition(event), false);
      reject(() => recordBattleEvent(ledger([0]), event, { turn: 1, during: 0 }), 'invalid-history-event');
    }
  }
  for (const method of ['inheritPokemon', 'inheritance', 'switch', 'evolve', 'devolve'])
    reject(() => recordBattleEvent(ledger([0]), transition({ method }), { turn: 1, during: 0 }), 'invalid-history-event');
  for (const extra of [
    { pokemonId: 'not-a-target' }, { fromCardId: 'before' }, { toCardId: 'after' }, { method: 'evolution' },
  ]) {
    assert.equal(validateEnded(ended(extra)), false);
    reject(() => recordBattleEvent(ledger([0]), ended(extra), { turn: 1, during: 0 }), 'invalid-history-event');
  }
});

test('new facts cannot be future/backfilled, change the Pokemon holder or resurrect a KO identity; turnEnded remains non-target data', () => {
  const h = ledger([0, 1], [transition()]), clock = { turn: 2, during: 1 };
  reject(() => recordBattleEvent(h, transition(), clock), 'invalid-history-time');
  reject(() => recordBattleEvent(h, ended(), clock), 'invalid-history-time');
  reject(() => recordBattleEvent(h, transition({ turn: 3, during: 1 }), clock), 'invalid-history-time');
  reject(() => recordBattleEvent(h, transition({ turn: 2, during: 1, owner: 1 }), clock), 'invalid-history-identity');
  const retired = ledger([0, 1], [knockout()]);
  reject(() => recordBattleEvent(retired, transition({ turn: 2, during: 1 }), clock), 'invalid-history-identity');
  const stillRetired = recordBattleEvent(retired, ended({ turn: 2, during: 1, owner: 1 }), clock);
  assert.equal(stillRetired.events.length, 2, 'No invented undefined-Pokemon owner or retirement key.');
  reject(() => recordBattleEvent(stillRetired, transition({ turn: 2, during: 1 }), clock), 'invalid-history-identity');
  reject(() => recordBattleEvent(createBattleHistory(), transition({ turn: 0, during: null }), { turn: 0, during: null }), 'invalid-history-event');
  const checked = ledger([0], [transition({ during: null })]);
  reject(() => recordBattleEvent(checked, ended(), { turn: 1, during: null }), 'invalid-history-time');
  reject(() => assertBattleHistory(ledger([0], [transition({ during: null }), ended()]), { turn: 1, during: null }), 'invalid-history-order');
});

test('fieldTransition/turnEnded never satisfy existing heal, switch, Supporter or KO conditions and legacy appends add no facts automatically', () => {
  for (const owner of [0, 1]) {
    const other = 1 - owner, h = ledger([other, owner], [
      transition({ turn: 1, during: other, owner, pokemonId: 'subject' }),
      ended({ turn: 1, during: other, owner: other }),
      transition({ turn: 2, during: owner, owner, pokemonId: 'subject' }),
    ]), clock = { turn: 2, during: owner };
    assert.deepEqual(previousOpponentTurn(h, clock, owner), { turn: 1, player: other });
    assert.equal(hadKnockoutInPreviousOpponentTurn(h, clock, { owner }), false);
    assert.equal(wasMovedFromBenchToActiveThisTurn(h, clock, owner, 'subject'), false);
    assert.equal(wasSupporterPlayedFromHandThisTurn(h, clock, owner), false);
    assert.equal(wasHealedThisTurn(h, clock, owner, 'subject'), false);
    let legacy = recordBattleTurn(createBattleHistory(), { turn: 1, player: owner });
    legacy = recordBattleTurn(legacy, { turn: 2, player: other });
    assert.deepEqual(legacy.events, []);
  }
});

test('descriptor JSON rejects inherited/accessor/hidden/symbol/cyclic/executable facts and sparse arrays without invoking code', () => {
  let calls = 0;
  for (const factory of [transition, ended]) {
    for (const key of Object.keys(factory())) for (const mode of ['getter', 'hidden', 'inherited']) {
      const event = factory(), original = event[key];
      if (mode === 'getter') Object.defineProperty(event, key, { enumerable: true, get() { calls++; return original; } });
      else if (mode === 'hidden') Object.defineProperty(event, key, { value: original, enumerable: false });
      else { delete event[key]; Object.setPrototypeOf(event, { [key]: original }); }
      reject(() => recordBattleEvent(ledger([0]), event, { turn: 1, during: 0 }), 'invalid-history-json');
    }
    const symbol = factory(); symbol[Symbol('hidden')] = 1;
    const cyclic = factory(); cyclic.self = cyclic;
    const sparse = new Array(1), extra = []; extra.extra = true;
    for (const invalid of [
      symbol, cyclic, factory({ extra: undefined }), factory({ extra: NaN }),
      factory({ extra: Infinity }), factory({ extra: 1n }), factory({ extra: () => true }),
      factory({ extra: new Date() }), factory({ extra: new Map() }), factory({ extra: sparse }),
      factory({ extra }), factory({ toJSON() { calls++; return factory(); } }),
    ]) reject(() => recordBattleEvent(ledger([0]), invalid, { turn: 1, during: 0 }), 'invalid-history-json');
  }
  assert.equal(calls, 0);
});

test('immutable append accepts legal null-prototype/frozen inputs, round trips exactly and keeps stable history indexes', () => {
  const h = freeze(ledger([0], [transition()])), event = freeze(ended()), clock = freeze({ turn: 1, during: 0 });
  const before = clone({ h, event, clock }), index = h.events.length;
  const actual = recordBattleEvent(h, event, clock);
  assert.equal(index, 1); assert.deepEqual(actual.events[index], event);
  const nullHistory = nullPrototypes(h), nullEvent = nullPrototypes(event), nullClock = nullPrototypes(clock);
  assert.deepEqual(recordBattleEvent(nullHistory, nullEvent, nullClock), actual);
  assert.equal(assertBattleHistory(nullHistory, nullClock), nullHistory);
  assert.equal(validateHistory(nullHistory), true);
  assert.deepEqual(recordBattleEvent(JSON.parse(JSON.stringify(h)), clone(event), clone(clock)), actual);
  actual.events[0].fromCardId = 'mutated'; actual.events[index].owner = 1; actual.turns[0].player = 1;
  assert.deepEqual({ h, event, clock }, before);
  assert.deepEqual(recordBattleEvent(h, event, clock).events[index], event);
});
