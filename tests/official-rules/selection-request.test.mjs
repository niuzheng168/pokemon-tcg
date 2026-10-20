// Synthetic request snapshots only. No OfficialGame actions or card approvals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  SelectionRequestError, SELECTION_REQUEST_RULE_IDS, SELECTION_REQUEST_SOURCES,
  assertSelectionRequestEvent, selectionRequestEvent, hasSelectionRequestPayload,
} from '../../public/rules/selection-request.js';
import { validateSelectionRequestEvent } from '../../public/rules/schema-validators.js';
import { queryPrizesTaken } from '../../public/rules/prize-count.js';

const MAX = Number.MAX_SAFE_INTEGER;
const clone = (value) => structuredClone(value);
const evidence = [{
  sourceId: 'fixture:request', kind: 'official-rule', url: 'https://www.pokemon.cn/',
  locator: 'TEST ONLY: synthetic private request, not an approved real card.',
}];
const source = () => ({
  instanceId: 'physical:source', owner: 0, category: 'ability', pokemonId: 'pokemon:0',
  attackId: null, effectId: 'fixture:effect', sourceOfTruth: clone(evidence),
});
const entry = (origin = 'draw') => ({
  id: 'entry:1', player: 0, cardId: 'physical:incoming', origin,
  reason: origin === 'draw' ? 'effect' : null, turn: 5, during: 0, cause: source(),
});
const resolution = (action = { op: 'heal', side: 'own', target: 'any', count: 2 }) => ({
  action, frames: [{ kind: 'sequence', remaining: [{ op: 'draw', count: 1 }], performed: false }],
  source: source(), programId: 'program:1', event: null, local: false, entry: null, payment: null,
});
const activation = () => ({
  kind: 'trainer', player: 0, sourceId: 'physical:trainer',
  pokemonId: null, abilityId: null, unit: null, entry: null, entryUnitId: null,
});
const request = (extra = {}) => ({
  id: 'q1', player: 0, kind: 'effect-target', options: ['pokemon:0', 'pokemon:1'],
  minimum: 1, maximum: 1, allowZero: false, resume: 'effect-choice',
  data: resolution(), ruleId: 'effects.partial', ...extra,
});
const work = (extra = {}) => ({
  queue: [], attack: null, serial: 12, revision: 2, turn: 5, current: 0,
  phase: 'resolving', first: 0, nextPlayer: 1, vacancies: [null, null], ...extra,
});
const wrapper = (r = request(), w = work()) => ({
  ruleId: 'selection.request', visibility: 'private', data: { kind: 'requested', request: r, work: w },
});
const rejects = (fn) => assert.throws(fn, TypeError);
const getAt = (root, path) => path.reduce((current, key) => current[key], root);
const setAt = (root, path, value) => { getAt(root, path.slice(0, -1))[path.at(-1)] = value; };
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

// Read only schema sources; never call the shared schema/kernel generators.
const ajv = new Ajv2020({ strict: true, allErrors: true }), loaded = new Map();
async function register(name) {
  const doc = JSON.parse(await readFile(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
  if (loaded.has(doc.$id)) return;
  loaded.set(doc.$id, doc); ajv.addSchema(doc);
  const pending = [doc];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node.$ref === 'string' && node.$ref.startsWith('urn:pokemon-tcg:')) {
      const uri = node.$ref.split('#')[0], key = uri.split(':')[2];
      if (!loaded.has(uri)) await register(key === 'core-handler-parameters' ? 'handler-parameters' : key);
    }
    pending.push(...Object.values(node));
  }
}
await register('selection-request');
const schema = loaded.get('urn:pokemon-tcg:selection-request:1.0.0');
const standalone = ajv.getSchema(schema.$id);
const pendingSchema = ajv.getSchema('urn:pokemon-tcg:game-state:1.0.0#/properties/pending');
const workSchema = ajv.getSchema(`${schema.$id}#/$defs/work`);
const typed = (urn, name) => ajv.getSchema(`urn:pokemon-tcg:${urn}:1.0.0#/$defs/${name}`);
function check(event, expected) {
  for (const validate of [standalone, validateSelectionRequestEvent]) assert.equal(validate(event), expected);
  if (expected) assert.equal(assertSelectionRequestEvent(event), event);
  else rejects(() => assertSelectionRequestEvent(event));
}

const examples = () => [
  ['cost', request({
    kind: 'activation-cost', options: ['["fee","physical:water"]'], resume: 'activation-choice',
    data: { activation: activation() }, ruleId: 'effects.activation-cost',
  }), typed('game-state', 'activationChoice')],
  ['before-hand order from a draw', request({
    kind: 'before-hand-order', options: ['unit:1', 'unit:2'], resume: 'entry-window',
    data: { entry: entry(), remaining: ['unit:1', 'unit:2'] }, ruleId: 'trigger.before-hand',
  }), typed('game-state', 'entryWindow')],
  ['before-hand optional Prize card', request({
    kind: 'before-hand-optional', options: ['perform', 'skip'], resume: 'entry-use',
    data: { entry: entry('prizes'), unitId: 'unit:1' }, ruleId: 'trigger.before-hand',
  }), typed('game-state', 'entryUse')],
  ['legacy effect', request(), typed('effect-program', 'resolution')],
  ['optional draw body', request({
    kind: 'optional-effect', options: ['perform', 'skip'],
    data: resolution({ op: 'optional', effect: { op: 'draw', count: 2 } }), ruleId: 'selection.optional',
  }), typed('effect-program', 'resolution')],
  ['retreat fee', request({
    kind: 'retreat-energy', options: ['physical:energy1', 'physical:energy2'], resume: 'retreat-paid',
    data: { player: 0 }, ruleId: 'retreat.payment',
  }), null],
  ['retreat destination', request({
    kind: 'retreat-target', options: ['pokemon:1', 'pokemon:2'], resume: 'finish-retreat',
    data: { player: 0 }, ruleId: 'retreat.limit',
  }), null],
  ['Prize position', request({
    player: 1, kind: 'prize', options: ['0', '1', '2'], resume: 'award',
    data: { player: 1, count: 1 }, ruleId: 'ko.boundary',
  }), null],
  ['attack self-failure hand choice, not activation cost', request({
    kind: 'attack-payment', options: ['physical:water'], minimum: 0, allowZero: true,
    resume: 'attack-payment', ruleId: 'attack.failure.hand-payment',
    data: {
      id: 'check:1', turn: 5,
      flow: { frameId: 'attack:1', player: 0, pokemonId: 'pokemon:0', sourceId: 'physical:source', copyId: null },
      hand: ['physical:water'], eligible: ['physical:water'],
    },
  }), typed('attack-failure', 'paymentChoice')],
];

test('schema reuses complete non-null GameState.pending without an alternate bag; pinned evidence is a software boundary', () => {
  assert.equal(schema.$id, 'urn:pokemon-tcg:selection-request:1.0.0');
  assert.deepEqual(schema.properties.data.properties.request.allOf, [
    { $ref: 'urn:pokemon-tcg:game-state:1.0.0#/properties/pending' }, { type: 'object' },
  ]);
  assert.deepEqual(schema.properties.data.required, ['kind', 'request', 'work']);
  assert.deepEqual(schema.$defs.work.required, Object.keys(work()));
  for (const name of Object.keys(work()))
    assert.equal(schema.$defs.work.properties[name].$ref, `urn:pokemon-tcg:game-state:1.0.0#/properties/${name}`);
  assert.match(schema.$comment, /II\.A PDF p19.*II\.D-04 p43–44.*I\.H p18.*II\.E-33\/II\.E-34 p73/);
  assert.match(schema.$comment, /do NOT prescribe this software log format/);
  assert.deepEqual(SELECTION_REQUEST_RULE_IDS, ['selection.request']);
  assert.deepEqual(SELECTION_REQUEST_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.A', pdfPages: [19] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.D-04', pdfPages: [43, 44] },
    { documentId: 'CN-advanced-3.1.0', section: 'I.H', pdfPages: [18] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-33', pdfPages: [73] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-34', pdfPages: [73] },
  ]);
  assert(Object.isFrozen(SELECTION_REQUEST_RULE_IDS)); assert(Object.isFrozen(SELECTION_REQUEST_SOURCES));
  for (const item of SELECTION_REQUEST_SOURCES) { assert(Object.isFrozen(item)); assert(Object.isFrozen(item.pdfPages)); }
  const error = new SelectionRequestError('fixture');
  assert(error instanceof TypeError); assert.equal(error.name, 'SelectionRequestError');
  assert.equal(error.code, 'invalid-selection-request'); assert.equal(error.ruleId, 'selection.request');
});

test('cost/before-hand/legacy effect/draw/retreat/Prize/attack-payment typed snapshots retain their ENTIRE pending object', () => {
  for (const [name, r, validateData] of examples()) {
    if (validateData) assert.equal(validateData(r.data), true, name);
    assert.equal(pendingSchema(r), true, name);
    const before = clone(r), event = selectionRequestEvent(freeze(r), freeze(work()));
    assert.deepEqual(event, wrapper(before), name);
    check(event, true); assert(hasSelectionRequestPayload(event)); assert(hasSelectionRequestPayload(r));
    assert.deepEqual(r, before);
    // There is no separate per-resume shadow schema in this pure module.
    for (const field of ['id', 'options', 'data', 'resume']) {
      const invalid = clone(r); delete invalid[field];
      check(wrapper(invalid), false); rejects(() => selectionRequestEvent(invalid, work()));
    }
    for (const invalidData of [null, [], false, 'opaque text', 0]) {
      const invalid = { ...r, data: invalidData };
      assert.equal(pendingSchema(invalid), false);
      check(wrapper(invalid), false);
    }
  }
});

test('standalone and generated event schemas agree exactly with the authoritative pending schema on request mutations', () => {
  for (const [_name, r] of examples()) {
    for (const [field, values] of [
      ['id', ['', null, 1]], ['player', [-1, 2, '0', null]],
      ['kind', ['', null, 1]], ['options', [null, {}, [null], [''], ['a', 'a']]],
      ['minimum', [-1, 0.5, MAX + 1, '0', null]], ['maximum', [-1, MAX + 1]],
      ['allowZero', [0, null]], ['resume', ['', null, 1]], ['ruleId', ['', 1, null]],
    ]) for (const value of values) {
      const invalid = { ...clone(r), [field]: value };
      assert.equal(pendingSchema(invalid), false); check(wrapper(invalid), false);
    }
    const extra = { ...r, hiddenChoice: ['physical:secret'] };
    assert.equal(pendingSchema(extra), false); check(wrapper(extra), false);
  }
  assert.equal(pendingSchema(null), true, 'A game may have no pending request.');
  check(wrapper(null), false); rejects(() => selectionRequestEvent(null, work()));
});

test('receipt wrapper/data are exact and always private, irrespective of valid inner pending data', () => {
  const event = wrapper(); check(event, true);
  for (const value of [null, [], {}, 0, true, 'request']) check(value, false);
  for (const field of Object.keys(event)) {
    const changed = clone(event); delete changed[field]; check(changed, false);
  }
  for (const field of Object.keys(event.data)) {
    const changed = clone(event); delete changed.data[field]; check(changed, false);
  }
  check({ ...event, extra: true }, false);
  check({ ...event, data: { ...event.data, extra: true } }, false);
  check({ ...event, data: [] }, false); check({ ...event, data: null }, false);
  for (const visibility of ['public', 'owner', 0, 1, null]) check({ ...event, visibility }, false);
  for (const ruleId of ['effects.execution', 'other', '', null]) check({ ...event, ruleId }, false);
  for (const kind of ['finished', 'requested-renamed', 'open', '', null])
    check({ ...event, data: { ...event.data, kind } }, false);
});

test('work is REQUIRED and exact; each paused field uses its real GameState schema, without events/players/self recursion', () => {
  rejects(() => selectionRequestEvent(request()));
  for (const invalid of [undefined, null, [], {}, false, 'work']) {
    rejects(() => selectionRequestEvent(request(), invalid));
    check({ ...wrapper(), data: { kind: 'requested', request: request(), work: invalid } }, false);
  }
  for (const name of Object.keys(work())) {
    const w = work(); delete w[name];
    assert.equal(workSchema(w), false); check(wrapper(request(), w), false);
  }
  for (const name of ['events', 'players', 'pending', 'request', 'work', 'trusted']) {
    const w = work({ [name]: [] });
    assert.equal(workSchema(w), false); rejects(() => selectionRequestEvent(request(), w));
  }
  for (const [name, values] of [
    ['queue', [null, {}, [null], [{ op: 'unknown', data: {} }], [{ op: 'award' }]]],
    ['attack', [false, [], {}]], ['serial', [-1, 0.5, MAX + 1, '0', null]],
    ['revision', [-1, MAX + 1]], ['turn', [-1, MAX + 1]],
    ['current', [2, '0', false]], ['first', [2, false]], ['nextPlayer', [2, null]],
    ['phase', ['unknown', null]], ['vacancies', [null, [], [null], [null, null, null], [{}, null]]],
  ]) for (const value of values) {
    const w = work({ [name]: value });
    assert.equal(workSchema(w), false); check(wrapper(request(), w), false);
  }
  const draw = {
    op: 'draw-cards', data: { player: 0, remaining: 2, drawn: 0, reason: 'effect',
      source: source(), completion: resolution({ op: 'draw', count: 2 }) },
  };
  assert.equal(typed('game-state', 'drawTask')(draw.data), true);
  const w = work({ queue: [draw], serial: MAX, revision: MAX, turn: MAX });
  check(selectionRequestEvent(request(), w), true);
  const invalid = clone(w); invalid.queue[0].data.remaining = -1;
  check(wrapper(request(), invalid), false);
  const missing = clone(w); delete missing.queue[0].data.completion;
  check(wrapper(request(), missing), false);
  const extra = clone(w); extra.queue[0].data.untrustedExtra = true;
  check(wrapper(request(), extra), false);
  for (const current of [null, 0, 1]) for (const first of [null, 0, 1])
    check(selectionRequestEvent(request(), work({ current, first })), true);
});

test('typed draw work detaches its completion and does not confuse historical shape checks with current-state authorization', () => {
  const w = work({
    queue: [{ op: 'draw-cards', data: {
      player: 0, remaining: 2, drawn: 0, reason: 'effect',
      source: source(), completion: resolution({ op: 'draw', count: 2 }),
    } }],
  });
  const before = clone(w), event = selectionRequestEvent(request(), freeze(w));
  assert.notEqual(event.data.work.queue, w.queue);
  assert.notEqual(event.data.work.queue[0].data.completion, w.queue[0].data.completion);
  event.data.work.queue[0].data.remaining = 1;
  assert.deepEqual(w, before);
  // A shape-valid changed control plane is still NOT an authority token. The
  // host compares the active request+work to its unique original private record.
  check(event, true);
  const later = selectionRequestEvent({ ...request(), id: 'q2' }, work({ revision: 3, serial: 13 }));
  assert.equal(assertSelectionRequestEvent(later), later);
  assert.equal(assertSelectionRequestEvent(event), event, 'History is not compared to the current work by this pure shape gate.');
});

test('schema-valid attack damage models retain exact D17 object consts through null-prototype descriptor copying', () => {
  const attackSource = { ...source(), category: 'attack', attackId: 'fixture:strike', effectId: 'attack:fixture:strike' };
  const stats = {
    damageCounters: 2, maximumHp: 100, remainingHp: 80, retreatEnergy: 1, energyCards: 1, energyUnits: 1,
  };
  const prizes = {};
  for (const [side, remainingPrizes] of [['own', 6], ['opponent', 4]]) prizes[side] = clone(queryPrizesTaken({
    ruleset: { region: 'CN', version: 'V20261019' }, deckSize: 60, matchMode: 'normal', remainingPrizes,
  }));
  const model = {
    targetId: 'pokemon:1', owner: 1, targetPosition: 'active', targetRelation: 'opponent',
    attackerTypes: ['Water'], weakness: null, resistance: null,
    attackerModifiers: [], defenderModifiers: [], preventions: [],
    battleValues: { coins: {}, pokemon: {
      self: clone(stats), ownActive: clone(stats), opponentActive: clone(stats), target: clone(stats),
    }, prizes },
  };
  const w = work({
    queue: [{ op: 'resolve-attack', data: {
      frameId: 'attack:1', player: 0, pokemonId: 'pokemon:0', sourceId: 'physical:source', copyId: null,
    } }],
    attack: {
      id: 'attack:1', player: 0, pokemonId: 'pokemon:0', sourceId: 'physical:source', source: attackSource,
      attack: {
        attackId: 'fixture:strike', name: '测试伤害快照', cost: ['Water'],
        printedDamage: { value: 20, operator: 'fixed' }, effects: [], sourceOfTruth: clone(evidence),
      },
      options: {}, events: [], damageModels: [model], copies: [], usedSpecialRules: [],
      execution: { reference: null, copyId: null, performed: false, failureReceipt: null, phase: 'body', damageCoins: null },
    },
  });
  const r = request(), before = clone(w);
  assert.equal(workSchema(w), true, 'The fixture uses the actual attack/damage model schemas, not an opaque data bag.');
  const ordinary = wrapper(r, w);
  assert.equal(standalone(ordinary), true);
  assert.equal(validateSelectionRequestEvent(ordinary), true);
  // The pure gate deliberately makes descriptor-checked null-prototype copies.
  // This must NOT weaken that gate to satisfy constructor-sensitive Ajv equal.
  assert.equal(assertSelectionRequestEvent(ordinary), ordinary);
  const event = selectionRequestEvent(freeze(r), freeze(w));
  assert.deepEqual(event.data.work.attack.damageModels[0].battleValues.prizes, prizes);
  assert.notEqual(event.data.work.attack.damageModels[0].battleValues.prizes.own.sourceOfTruth, prizes.own.sourceOfTruth);
  const nullProto = clone(event);
  for (const side of ['own', 'opponent']) {
    const result = nullProto.data.work.attack.damageModels[0].battleValues.prizes[side];
    result.sourceOfTruth[0] = Object.assign(Object.create(null), result.sourceOfTruth[0]);
  }
  assert.equal(assertSelectionRequestEvent(nullProto), nullProto);
  assert(hasSelectionRequestPayload(nullProto));
  for (const mutate of [
    (s) => { s.section = 'II.D-16'; },
    (s) => { s.pdfPages.reverse(); },
    (s) => { s.unreviewed = true; },
  ]) {
    const forged = clone(event);
    mutate(forged.data.work.attack.damageModels[0].battleValues.prizes.own.sourceOfTruth[0]);
    check(forged, false);
  }
  assert.deepEqual(w, before, 'Const checking must not mutate the query results or paused attack.');
});

test('factory and assertion do not freeze/mutate/alias requests, frames, source evidence or paused work', () => {
  const r = request(), w = work(), before = clone({ r, w }), event = selectionRequestEvent(r, w);
  assert.equal(assertSelectionRequestEvent(event), event);
  assert.deepEqual({ r, w }, before);
  for (const value of [r, r.data, r.data.frames, r.data.source, r.data.source.sourceOfTruth, w, w.queue, w.vacancies])
    assert(!Object.isFrozen(value));
  assert.notEqual(event.data.request, r); assert.notEqual(event.data.request.options, r.options);
  assert.notEqual(event.data.request.data, r.data); assert.notEqual(event.data.request.data.frames, r.data.frames);
  event.data.request.options.push('physical:extra');
  event.data.request.data.frames[0].remaining[0].count = 99;
  event.data.request.data.source.sourceOfTruth[0].locator = 'changed';
  event.data.work.queue.push({ op: 'award', data: { player: 0, count: 1 } });
  event.data.work.serial++; event.data.work.vacancies.reverse();
  assert.deepEqual({ r, w }, before);
  const first = selectionRequestEvent(r, w), second = selectionRequestEvent(r, w);
  r.options.reverse(); r.data.action.count = 7;
  w.serial++; w.queue.push({ op: 'award', data: { player: 0, count: 1 } });
  assert.deepEqual(first, second); assert.notEqual(first.data.request, second.data.request);
  assert.notEqual(first.data.work, second.data.work); assert.notEqual(first.data.work.queue, second.data.work.queue);
});

test('frozen and null-prototype records are legal; shared acyclic subtrees are detached rather than mistaken for cycles', () => {
  const r = request();
  r.data = Object.assign(Object.create(null), r.data);
  r.data.source = Object.assign(Object.create(null), r.data.source);
  const value = Object.assign(Object.create(null), r);
  const w = Object.assign(Object.create(null), work());
  const expected = clone(value), event = selectionRequestEvent(freeze(value), freeze(w));
  assert.deepEqual(event.data.request, expected);
  const outer = Object.assign(Object.create(null), event);
  outer.data = Object.assign(Object.create(null), outer.data);
  assert.equal(assertSelectionRequestEvent(outer), outer);
  assert.equal(hasSelectionRequestPayload(outer), true);
  const shared = { publicCount: 1, array: ['one', false, null] };
  assert.equal(hasSelectionRequestPayload({ left: shared, right: shared }), false);
  assert.equal(hasSelectionRequestPayload(Object.create(null)), false);
});

test('strict JSON rejects getters/inheritance/hidden/symbol/cycle/executable values without invoking code', () => {
  let calls = 0;
  const poison = () => { calls++; throw Error('Validation must not execute a getter/toJSON.'); };
  for (const path of [
    [], ['data'], ['data', 'request'], ['data', 'request', 'data'],
    ['data', 'request', 'data', 'source'], ['data', 'request', 'data', 'frames', 0], ['data', 'work'],
  ]) {
    for (const mode of ['getter', 'hidden', 'symbol']) {
      const event = wrapper(), value = getAt(event, path);
      if (mode === 'getter') Object.defineProperty(value, 'hidden', { enumerable: true, get: poison });
      else if (mode === 'hidden') Object.defineProperty(value, 'hidden', { value: true });
      else value[Symbol('hidden')] = true;
      rejects(() => assertSelectionRequestEvent(event)); assert.equal(hasSelectionRequestPayload(event), true);
    }
  }
  for (const path of [['ruleId'], ['visibility'], ['data', 'kind'], ['data', 'request', 'resume']]) {
    const event = wrapper(), object = getAt(event, path.slice(0, -1)), name = path.at(-1);
    delete object[name];
    Object.setPrototypeOf(object, Object.defineProperty({}, name, { get: poison }));
    rejects(() => assertSelectionRequestEvent(event)); assert(hasSelectionRequestPayload(event));
  }
  for (const invalid of [
    undefined, NaN, Infinity, -Infinity, 1n, Symbol('secret'), () => {}, new Date(0), new Map(), new Set(),
    new Number(1), /private/, Object.create({ inherited: true }),
  ]) {
    const event = wrapper(); event.data.request.data = invalid;
    rejects(() => assertSelectionRequestEvent(event));
    rejects(() => selectionRequestEvent({ ...request(), data: invalid }, work()));
    assert.equal(hasSelectionRequestPayload(invalid), true);
  }
  const cycle = wrapper(); cycle.data.request.data.loop = cycle;
  rejects(() => assertSelectionRequestEvent(cycle)); assert(hasSelectionRequestPayload(cycle));
  const workCycle = work(); workCycle.queue.push({ op: 'award', data: workCycle });
  rejects(() => selectionRequestEvent(request(), workCycle)); assert(hasSelectionRequestPayload(workCycle));
  const arrayCycle = []; arrayCycle.push(arrayCycle);
  rejects(() => selectionRequestEvent({ ...request(), options: arrayCycle }, work())); assert(hasSelectionRequestPayload(arrayCycle));
  const toJSON = wrapper(); toJSON.toJSON = poison;
  rejects(() => assertSelectionRequestEvent(toJSON)); assert(hasSelectionRequestPayload(toJSON));
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  assert.equal(hasSelectionRequestPayload(proxy), true, 'Reflection failure must fail closed, not crash the raw projector.');
  assert.equal(calls, 0);
});

test('sparse/extra/symbol/subclass/null-prototype arrays and accessor/hidden indices are not request JSON', () => {
  let calls = 0;
  const arrays = [new Array(1), new (class Entries extends Array {})()];
  const disguised = new Array(1); disguised.extra = true; arrays.push(disguised);
  const hidden = ['a']; Object.defineProperty(hidden, '0', { enumerable: false }); arrays.push(hidden);
  const getter = ['a']; Object.defineProperty(getter, '0', { enumerable: true, get() { calls++; throw Error('index getter'); } }); arrays.push(getter);
  const extra = []; extra.extra = true; arrays.push(extra);
  const symbol = []; symbol[Symbol('extra')] = true; arrays.push(symbol);
  const nullProto = []; Object.setPrototypeOf(nullProto, null); arrays.push(nullProto);
  for (const options of arrays) {
    const r = { ...request(), options };
    rejects(() => selectionRequestEvent(r, work())); rejects(() => assertSelectionRequestEvent(wrapper(r)));
    assert.equal(hasSelectionRequestPayload(options), true);
  }
  assert.equal(calls, 0);
});

test('privacy signature ignores every outer ruleId/visibility/kind rename, nesting choice and invalid inner field values', () => {
  const r = request();
  for (const ruleId of ['selection.request', 'turn.trainer', 'unrelated', null])
    for (const visibility of ['private', 'public', 0, 1, null])
      for (const kind of ['requested', 'finished', 'summary', null]) {
        const renamed = { ruleId, visibility, data: { kind, request: r } };
        assert.equal(hasSelectionRequestPayload(renamed), true);
        assert.equal(hasSelectionRequestPayload({ renamed: [null, { deep: renamed }] }), true);
        const requestDeleted = { ruleId, visibility, data: { kind, work: work() } };
        assert.equal(hasSelectionRequestPayload(requestDeleted), true, 'Deleting request cannot expose the paused queue/attack.');
        assert.equal(hasSelectionRequestPayload({ renamed: [null, { deep: requestDeleted }] }), true);
      }
  for (const [resume, options, data] of [
    [null, null, null], [0, false, 'untrusted'], [{}, {}, {}], ['', [], {}],
  ]) assert.equal(hasSelectionRequestPayload({ resume, options, data }), true);
  for (const part of ['resume', 'options', 'data']) {
    const value = { resume: 'x', options: [], data: {} }; delete value[part];
    assert.equal(hasSelectionRequestPayload(value), false);
  }
  assert.equal(hasSelectionRequestPayload({ resume: 'x', nested: { options: [], data: {} } }), false);
  for (const part of ['queue', 'attack', 'serial', 'revision']) {
    const value = { queue: [], attack: null, serial: 0, revision: 0 }; delete value[part];
    assert.equal(hasSelectionRequestPayload(value), false);
  }
  assert.equal(hasSelectionRequestPayload({ queue: false, attack: '', serial: {}, revision: null }), true);
  assert.equal(hasSelectionRequestPayload({ queue: [], attack: null, nested: { serial: 1, revision: 2 } }), false);
  assert.equal(hasSelectionRequestPayload(JSON.parse('{"__proto__":{"resume":"x","options":[],"data":{}}}')), true);
  assert.equal(hasSelectionRequestPayload(JSON.parse('{"__proto__":{"safe":1}}')), false);
  let calls = 0;
  const hidden = { queue: [], attack: null, serial: 1 };
  Object.defineProperty(hidden, 'revision', { get() { calls++; throw Error('work getter'); } });
  assert.equal(hasSelectionRequestPayload(hidden), true); assert.equal(calls, 0);
});

// Independent oracle over NORMAL serialized JSON only. Unsafe/executable input
// is checked separately above, never executed to compute an expected result.
function privacyOracle(value) {
  if (value === null || typeof value !== 'object') return false;
  const names = Object.keys(value);
  if (['resume', 'options', 'data'].every((key) => names.includes(key))) return true;
  if (['queue', 'attack', 'serial', 'revision'].every((key) => names.includes(key))) return true;
  return Object.values(value).some(privacyOracle);
}
test('bounded normal-JSON signature oracle exhausts presence/value/nesting without treating labels or re-encoded strings as proof', (t) => {
  const values = [null, false, [], {}];
  let cases = 0, detected = 0;
  for (const names of [['resume', 'options', 'data'], ['queue', 'attack', 'serial', 'revision']])
    for (let mask = 0; mask < 2 ** names.length; mask++) {
      const fields = names.filter((_name, i) => mask & (1 << i));
      const count = 4 ** fields.length;
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const value = {};
        fields.forEach((name, i) => { value[name] = clone(values[Math.floor(ordinal / (4 ** i)) % 4]); });
        for (const candidate of [value, [value], { unrelated: value }, { outer: [1, null, { inner: value }] }]) {
          const normal = JSON.parse(JSON.stringify(candidate)), expected = privacyOracle(normal);
          assert.equal(hasSelectionRequestPayload(freeze(normal)), expected);
          cases++; if (expected) detected++;
        }
      }
    }
  assert.equal(cases, 3000); assert.equal(detected, 1280);
  for (const value of [null, true, false, 0, -1, 1.5, '', 'resume', [], {}, { count: 4 },
    { ruleId: 'selection.request', visibility: 'private', data: { kind: 'requested' } },
    { r: 'effect-choice', o: ['secret:id'], d: {} }, JSON.stringify(request()), JSON.stringify(work())])
    assert.equal(hasSelectionRequestPayload(value), false,
      'No promise to recognize arbitrary private data under renamed keys or inside a string.');
  t.diagnostic(`${cases} normal JSON shapes; ${detected} structurally private, ${cases - detected} without signature.`);
});
