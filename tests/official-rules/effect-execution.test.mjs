// Synthetic programs only; this protocol does not approve cards or authenticate
// a mutable journal. Host must anchor it to its catalog and compare replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  EffectExecutionError, EFFECT_EXECUTION_RULE_IDS, EFFECT_EXECUTION_SOURCES,
  assertEffectExecutionEvent, beginEffectExecution, advanceEffectExecution, replayEffectExecution,
} from '../../public/rules/effect-execution.js';
import { validateEffectExecutionEvent } from '../../public/rules/schema-validators.js';

const MAX = Number.MAX_SAFE_INTEGER;
const clone = (value) => structuredClone(value);
const draw = (count = 1) => ({ op: 'draw', count });
const sequence = (...steps) => ({ op: 'sequence', steps });
const then = (first, next) => ({ op: 'then', first, next });
const optional = (effect) => ({ op: 'optional', effect });
const operations = ['draw', 'sequence', 'then', 'optional'];
const evidence = [{
  sourceId: 'fixture:execution', kind: 'official-rule', url: 'https://www.pokemon.cn/',
  locator: 'TEST ONLY: synthetic effect binding, no real-card approval.',
}];
const source = () => ({
  instanceId: 'physical:source', owner: 0, category: 'trainer', pokemonId: null,
  attackId: null, effectId: 'fixture:effect', sourceOfTruth: clone(evidence),
});
const binding = () => ({
  effectId: 'fixture:effect', handlerId: 'fixture:program@1', parameters: {},
  sourceOfTruth: clone(evidence),
});
const wrapper = (data) => ({ ruleId: 'effects.execution', visibility: 'private', data });
const opened = (program = [draw()], extra = {}) => wrapper({
  kind: 'opened', id: 'program:1', turn: 0, source: source(), binding: binding(),
  program, origin: 'handler', event: null, local: false, entry: null, payment: null, ...extra,
});
function scheduled(extra = {}) {
  const event = opened([], extra);
  delete event.data.program; event.data.kind = 'scheduled';
  return event;
}
const advance = (index, mode, performed = null, id = 'program:1') => wrapper({
  kind: 'advance', id, index, mode, performed,
});
const payment = () => ({
  id: 'payment:1', player: 0, sourceId: 'physical:source', kind: 'trainer',
  groups: [{ costId: 'cost:1', cardIds: ['physical:cost'] }],
});
const entry = () => ({
  id: 'entry:1', player: 0, cardId: 'physical:source', origin: 'draw',
  reason: 'effect', turn: 0, during: 0, cause: source(),
});
const trigger = () => ({
  id: 'event:1', kind: 'checkup', turn: 0, during: null, endingPlayer: 1,
  subjectId: 'pokemon:1', owner: 0, wasActive: true, origin: null, cardId: null,
  damage: 0, cause: { kind: 'checkup', source: null }, definitionId: 'fixture:pokemon',
  effectiveTypes: ['Water'], payment: payment(),
  snapshot: {
    id: 'pokemon:1', stack: ['physical:pokemon'], energy: [], tools: [],
    counters: 1, conditions: { rotation: null, poison: null, burned: false, paralysisRecoverTurn: null },
    enteredTurn: 0, evolvedTurn: 0, used: {}, facts: {},
  },
});
const heal = () => ({
  op: 'healPokemon', side: 'own', target: 'any', selector: { kind: 'pokemon' },
  selection: { kind: 'all' }, amount: 'all', discardHealedEnergy: true,
});
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const rejects = (fn) => assert.throws(fn, TypeError);
const getAt = (root, path) => path.reduce((current, key) => current[key], root);
const setAt = (root, path, value) => { getAt(root, path.slice(0, -1))[path.at(-1)] = value; };

// Read-only transitive standalone schema loading; never invoke a generator.
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
await register('effect-execution');
const schema = loaded.get('urn:pokemon-tcg:effect-execution:1.0.0');
const standalone = ajv.getSchema(schema.$id);
function checkShape(event, expected) {
  for (const validate of [standalone, validateEffectExecutionEvent])
    assert.equal(validate(event), expected, JSON.stringify(event));
  if (expected) assert.equal(assertEffectExecutionEvent(event), event);
  else rejects(() => assertEffectExecutionEvent(event));
}

// Independent recursive evaluator: construct each possible syntactic traversal
// and its continuations from parent/child relationships. It never calls any
// production begin/expand/complete helper, never pops production frames, and
// enumerates BOTH outcomes of every leaf/optional choice (including all skips).
function oracle(action, frames = []) {
  const record = (mode, performed) => ({ step: { action, frames }, mode, performed });
  if (action.op === 'sequence') {
    let paths = [{ performed: false, records: [record('expand', null)] }];
    for (const [index, child] of action.steps.entries()) {
      const next = [];
      for (const path of paths) {
        const frame = { kind: 'sequence', remaining: action.steps.slice(index + 1), performed: path.performed };
        for (const branch of oracle(child, [...frames, frame])) next.push({
          performed: path.performed || branch.performed, records: [...path.records, ...branch.records],
        });
      }
      paths = next;
    }
    return paths;
  }
  if (action.op === 'then') {
    const paths = [];
    for (const first of oracle(action.first, [...frames, { kind: 'then', next: action.next }])) {
      const prefix = [record('expand', null), ...first.records];
      if (!first.performed) paths.push({ performed: false, records: prefix });
      else for (const next of oracle(action.next, [...frames, { kind: 'sequence', remaining: [], performed: true }]))
        paths.push({ performed: true, records: [...prefix, ...next.records] });
    }
    return paths;
  }
  if (action.op === 'optional') return [
    { performed: false, records: [record('complete', false)] },
    ...oracle(action.effect, frames).map((path) => ({
      performed: path.performed, records: [record('optional', true), ...path.records],
    })),
  ];
  return [false, true].map((performed) => ({ performed, records: [record('complete', performed)] }));
}
function grammar(depth) {
  const base = [draw(1), draw(2), sequence()];
  if (depth === 0) return base;
  const children = grammar(depth - 1);
  return [
    ...base, ...children.map(optional),
    ...children.flatMap((a) => children.flatMap((b) => [sequence(a, b), then(a, b)])),
  ];
}
function checkWalk(program, path) {
  const open = freeze(opened(program)), before = clone(open), events = [];
  let cursor = beginEffectExecution(open, operations);
  for (const [index, expected] of path.records.entries()) {
    assert.deepEqual(cursor, { id: 'program:1', step: expected.step, index });
    const snapshot = clone(cursor), event = freeze(advance(index, expected.mode, expected.performed));
    const next = advanceEffectExecution(freeze(cursor), event);
    assert.deepEqual(cursor, snapshot, 'No input cursor/frame may be mutated.');
    assert.notEqual(next, cursor);
    events.push(event); cursor = next;
  }
  assert.deepEqual(cursor, { id: 'program:1', step: null, index: events.length });
  assert.deepEqual(replayEffectExecution(open, freeze(events), operations), cursor);
  assert.deepEqual(open, before, 'No program or context may be mutated.');
  return events.length;
}

test('strict schema references actual source/effect/context/receipt definitions; evidence is not authorization', () => {
  assert.equal(schema.$id, 'urn:pokemon-tcg:effect-execution:1.0.0');
  assert.deepEqual(EFFECT_EXECUTION_RULE_IDS, ['effects.execution']);
  assert.deepEqual(EFFECT_EXECUTION_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.A', pdfPages: [19] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-19', pdfPages: [62, 63] },
  ]);
  assert(Object.isFrozen(EFFECT_EXECUTION_RULE_IDS)); assert(Object.isFrozen(EFFECT_EXECUTION_SOURCES));
  for (const item of EFFECT_EXECUTION_SOURCES) { assert(Object.isFrozen(item)); assert(Object.isFrozen(item.pdfPages)); }
  assert.match(schema.$comment, /II\.A PDF p19.*II\.E-19 PDF p62–63/);
  assert.match(schema.$comment, /not an official card approval.*cryptographic authentication/);
  const expected = {
    source: 'urn:pokemon-tcg:effect-program:1.0.0#/$defs/source',
    binding: 'urn:pokemon-tcg:card-definition:1.0.0#/$defs/effect',
  };
  for (const kind of ['scheduled', 'opened']) for (const [key, ref] of Object.entries(expected))
    assert.equal(schema.$defs[kind].properties[key].$ref, ref);
  assert.equal(schema.$defs.opened.properties.program.$ref, 'urn:pokemon-tcg:effect-program:1.0.0');
  assert.deepEqual(
    Object.keys(schema.$defs.scheduled.properties).sort(),
    Object.keys(schema.$defs.opened.properties).filter((key) => key !== 'program').sort(),
  );
  const error = new EffectExecutionError('fixture', 'fixture message');
  assert(error instanceof TypeError); assert.equal(error.name, 'EffectExecutionError');
  assert.equal(error.code, 'fixture'); assert.equal(error.ruleId, 'effects.execution');
});

test('complete bounded recursive grammar oracle exhausts leaf results, optional skips, partial then and exact frames', (t) => {
  const programs = grammar(2).map((node) => [node]);
  programs.push([], [draw(1), draw(2)], [
    then(sequence(optional(then(draw(1), sequence())), then(optional(draw(2)), draw(1))), optional(draw(2))),
    then(then(draw(1), draw(2)), then(draw(2), draw(1))),
  ]);
  let walks = 0, transitions = 0;
  const started = performance.now();
  for (const program of programs) {
    freeze(program);
    for (const path of oracle(sequence(...program))) {
      transitions += checkWalk(program, path); walks++;
    }
  }
  assert.equal(programs.length, 1182);
  assert.equal(walks, 5894); assert.equal(transitions, 41311);
  t.diagnostic(`${programs.length} programs, ${walks} exhaustive control walks, ${transitions} transitions; ${(performance.now() - started).toFixed(1)}ms.`);
});

test('scheduled shapes admit all context but neither begin nor replay accepts them; opened-only kinds are enforced', () => {
  for (const origin of ['handler', 'reaction']) for (const local of [false, true])
    for (const context of [{}, { event: trigger(), entry: entry(), payment: payment() }]) {
      const open = opened([], { origin, local, turn: MAX, ...context });
      const schedule = scheduled({ origin, local, turn: MAX, ...context });
      checkShape(open, true); checkShape(schedule, true);
      rejects(() => beginEffectExecution(schedule, []));
      rejects(() => replayEffectExecution(schedule, [], []));
      assert.deepEqual(beginEffectExecution(open, []), {
        id: 'program:1', step: { action: sequence(), frames: [] }, index: 0,
      });
    }
  checkShape({ ...scheduled(), data: { ...scheduled().data, program: [] } }, false);
  rejects(() => beginEffectExecution(advance(0, 'expand'), operations));
  rejects(() => replayEffectExecution(advance(0, 'expand'), [], operations));
});

test('wrapper/open/scheduled/advance exact own fields, boundaries and mode/performed truth table agree with generated schema', () => {
  const examples = [opened(), scheduled(), advance(0, 'expand'), advance(0, 'optional', true), advance(MAX, 'complete', false)];
  for (const original of examples) {
    checkShape(original, true);
    for (const key of Object.keys(original)) {
      const changed = clone(original); delete changed[key]; checkShape(changed, false);
    }
    for (const key of Object.keys(original.data)) {
      const changed = clone(original); delete changed.data[key]; checkShape(changed, false);
    }
    checkShape({ ...original, extra: true }, false);
    checkShape({ ...original, data: { ...original.data, extra: true } }, false);
    for (const visibility of ['public', 'owner', 0, 1, null]) checkShape({ ...original, visibility }, false);
    checkShape({ ...original, ruleId: 'effects.partial' }, false);
    checkShape({ ...original, data: { ...original.data, id: '' } }, false);
  }
  for (const mode of ['expand', 'optional', 'complete', 'unknown'])
    for (const performed of [null, true, false, 0, 1, 'true']) {
      const expected = mode === 'expand' ? performed === null :
        mode === 'optional' ? performed === true : mode === 'complete' && typeof performed === 'boolean';
      checkShape(advance(0, mode, performed), expected);
    }
  for (const value of [-1, 0.5, MAX + 1, '0', null]) {
    checkShape(advance(value, 'expand'), false);
  }
  for (const factory of [opened, scheduled]) {
    // opened accepts program then context; scheduled accepts context only.
    const make = (extra) => factory === opened ? opened([], extra) : scheduled(extra);
    for (const turn of [-1, 0.5, MAX + 1, '0', null]) checkShape(make({ turn }), false);
    for (const patch of [{ origin: 'task' }, { local: null }, { source: null }, { binding: null },
      { event: {} }, { entry: {} }, { payment: {} }, { id: 1 }]) checkShape(make(patch), false);
  }
  for (const program of [null, {}, [null], [{ op: 'unknown' }], [{ op: 'draw', count: -1 }]])
    checkShape(opened(program), false);
  for (const value of [null, [], true, 0, 'event']) checkShape(value, false);
});

test('referenced context fields reject extra/missing/malformed nested data without inferring authorization', () => {
  const event = opened([], { event: trigger(), entry: entry(), payment: payment() });
  checkShape(event, true);
  for (const [path, shape] of [
    [['source'], loaded.get('urn:pokemon-tcg:effect-program:1.0.0').$defs.source],
    [['binding'], loaded.get('urn:pokemon-tcg:card-definition:1.0.0').$defs.effect],
    [['event'], loaded.get('urn:pokemon-tcg:trigger:1.0.0').$defs.event],
    [['event', 'snapshot'], loaded.get('urn:pokemon-tcg:game-state:1.0.0').$defs.pokemon],
    [['event', 'cause'], loaded.get('urn:pokemon-tcg:trigger:1.0.0').$defs.cause],
    [['entry'], loaded.get('urn:pokemon-tcg:game-state:1.0.0').$defs.entryContext],
    [['payment'], loaded.get('urn:pokemon-tcg:activation-cost:1.0.0').$defs.receipt],
    [['payment', 'groups', 0], loaded.get('urn:pokemon-tcg:activation-cost:1.0.0').$defs.receipt.properties.groups.items],
  ]) {
    const extra = clone(event); getAt(extra.data, path).unknown = 'hidden'; checkShape(extra, false);
    // Remove every referenced REQUIRED field, not an approximate local subset.
    for (const field of shape.required) {
      const missing = clone(event); delete getAt(missing.data, path)[field]; checkShape(missing, false);
    }
  }
  for (const [path, invalid] of [
    [['source', 'owner'], 2], [['source', 'category'], 'mystery'],
    [['source', 'sourceOfTruth'], []], [['binding', 'handlerId'], ''],
    [['binding', 'parameters'], []], [['event', 'damage'], 1],
    [['event', 'snapshot', 'counters'], -1], [['entry', 'origin'], 'hand'],
    [['entry', 'reason'], null], [['payment', 'groups'], []],
    [['payment', 'groups', 0, 'cardIds'], ['same', 'same']],
  ]) {
    const changed = clone(event); setAt(changed.data, path, invalid); checkShape(changed, false);
  }
  // Shape does NOT assert source/binding identity or approved handler output.
  const coherent = opened([draw()], { source: { ...source(), effectId: 'different:effect' } });
  checkShape(coherent, true);
  assert.equal(beginEffectExecution(coherent, ['draw']).step.action.steps[0].op, 'draw');
});

test('all static branches and embedded programs require declared operations, even when skipped, including healing compound discard', () => {
  const compounds = [optional(heal()), then(sequence(), heal()), sequence(draw(), heal())];
  for (const action of compounds) {
    const event = opened([action]), declared = [...operations, 'healPokemon'];
    checkShape(event, true);
    rejects(() => beginEffectExecution(event, operations));
    rejects(() => beginEffectExecution(event, declared));
    rejects(() => replayEffectExecution(event, [], declared));
    assert.equal(beginEffectExecution(event, [...declared, 'discardEnergy']).index, 0);
  }
  const delayed = {
    op: 'delayedReaction', side: 'own', target: 'self',
    trigger: { event: 'checkup', subject: 'self', optional: true, choiceOwner: 'source', scope: 'subject' },
    program: [optional(heal())], duration: 'untilNextOwnTurnEnd', clearOnBench: false, clearOnEvolution: true,
  };
  const event = opened([optional(delayed)]), outer = [...operations, 'delayedReaction'];
  checkShape(event, true);
  rejects(() => beginEffectExecution(event, outer));
  rejects(() => beginEffectExecution(event, outer, ['optional', 'healPokemon']));
  const embedded = ['optional', 'healPokemon', 'discardEnergy'];
  assert.deepEqual(replayEffectExecution(event, [], outer, embedded), beginEffectExecution(event, outer, embedded));
  assert.equal(beginEffectExecution(opened([]), []).index, 0);
  assert.equal(beginEffectExecution(opened([draw()]), ['draw', 'draw']).index, 0);
  for (const list of [null, {}, 'draw', [null], [1], [''], [undefined]]) {
    rejects(() => beginEffectExecution(opened(), list));
    rejects(() => beginEffectExecution(opened(), ['draw'], list));
  }
});

test('transition modes are restricted to exact current control kinds and optional acceptance cannot bypass its effect', () => {
  const root = beginEffectExecution(opened([then(draw(), optional(draw(2)))]), operations);
  rejects(() => advanceEffectExecution(root, advance(0, 'complete', false)));
  rejects(() => advanceEffectExecution(root, advance(0, 'complete', true)));
  rejects(() => advanceEffectExecution(root, advance(0, 'optional', true)));
  const afterRoot = advanceEffectExecution(root, advance(0, 'expand'));
  rejects(() => advanceEffectExecution(afterRoot, advance(1, 'complete', false)));
  const leaf = advanceEffectExecution(afterRoot, advance(1, 'expand'));
  rejects(() => advanceEffectExecution(leaf, advance(2, 'expand')));
  rejects(() => advanceEffectExecution(leaf, advance(2, 'optional', true)));
  const opt = advanceEffectExecution(leaf, advance(2, 'complete', true));
  assert.equal(opt.step.action.op, 'optional');
  rejects(() => advanceEffectExecution(opt, advance(3, 'expand')));
  rejects(() => advanceEffectExecution(opt, advance(3, 'complete', true)));
  rejects(() => advanceEffectExecution(opt, advance(3, 'optional', false)));
  const accepted = advanceEffectExecution(opt, advance(3, 'optional', true));
  assert.equal(accepted.step.action.op, 'draw'); assert.equal(accepted.step.action.count, 2);
  assert.notEqual(accepted.step.frames, opt.step.frames);
  const done = advanceEffectExecution(accepted, advance(4, 'complete', false));
  assert.equal(done.step, null);
  assert.equal(advanceEffectExecution(opt, advance(3, 'complete', false)).step, null);
});

test('cursor identity/index/live-state and safe increment are strict without timestamp selection or repair', () => {
  const cursor = beginEffectExecution(opened(), operations);
  for (const event of [opened(), scheduled(), advance(0, 'expand', null, 'other'),
    advance(1, 'expand'), advance(MAX, 'expand')]) rejects(() => advanceEffectExecution(cursor, event));
  for (const value of [null, [], false, 'cursor', {}, { ...cursor, extra: true },
    { id: cursor.id, step: cursor.step }, { ...cursor, id: '' }, { ...cursor, id: 1 },
    ...[-1, 0.5, MAX + 1, '0', null].map((index) => ({ ...cursor, index })),
    { ...cursor, step: {} }, { ...cursor, step: { action: draw(), frames: [{ kind: 'invented' }] } },
  ]) rejects(() => advanceEffectExecution(value, advance(0, 'expand')));
  const terminal = advanceEffectExecution(beginEffectExecution(opened([]), []), advance(0, 'expand'));
  assert.equal(terminal.step, null);
  rejects(() => advanceEffectExecution(terminal, advance(1, 'complete', false)));
  const near = { ...cursor, index: MAX - 1 };
  const last = advanceEffectExecution(near, advance(MAX - 1, 'expand'));
  assert.equal(last.index, MAX); assert.equal(last.step.action.op, 'draw');
  rejects(() => advanceEffectExecution(last, advance(MAX, 'complete', false)));
});

test('replay accepts prefixes and terminal once, rejects reorder/duplicate/gap/foreign/opened/scheduled or appended transitions', () => {
  const event = opened([optional(draw())]);
  const events = [advance(0, 'expand'), advance(1, 'optional', true), advance(2, 'complete', false)];
  for (let length = 0; length <= events.length; length++) {
    let cursor = beginEffectExecution(event, operations);
    for (const next of events.slice(0, length)) cursor = advanceEffectExecution(cursor, next);
    assert.deepEqual(replayEffectExecution(event, events.slice(0, length), operations), cursor);
  }
  for (const bad of [
    [events[1], events[0]], [events[0], events[0]], [events[0], events[2]],
    [events[0], advance(1, 'optional', true, 'foreign')], [events[0], opened()],
    [events[0], scheduled()], [...events, advance(3, 'complete', false)],
    [...events, advance(2, 'complete', false)],
  ]) rejects(() => replayEffectExecution(event, bad, operations));
  for (const bad of [null, {}, 'events', [null], [0]]) rejects(() => replayEffectExecution(event, bad, operations));
  // A syntactically valid injected continuation is NOT authenticated by cursor
  // shape. Replaying the anchored opened event exposes both changed action/frame.
  const canonical = replayEffectExecution(event, [events[0]], operations);
  for (const tamper of [
    { ...clone(canonical), step: { action: draw(999), frames: [] } },
    { ...clone(canonical), step: { action: canonical.step.action, frames: [{ kind: 'sequence', remaining: [draw(999)], performed: false }] } },
  ]) assert.notDeepEqual(tamper, replayEffectExecution(event, [events[0]], operations));
});

test('strict descriptor JSON rejects getters without invoking them, class/prototype defaults, sparse/hidden/symbol/cyclic/executable data', () => {
  let reads = 0;
  const accessor = () => { reads++; throw new Error('A getter must never run.'); };
  const attach = (value) => opened([], { binding: { ...binding(), parameters: { value } } });
  const badObjects = [
    undefined, NaN, Infinity, -Infinity, 1n, Symbol('hidden'), () => {}, new Date(0),
    new Map(), new Set(), new Number(1), /execution/,
    Object.create({ inherited: true }),
  ];
  for (const value of badObjects) rejects(() => assertEffectExecutionEvent(attach(value)));
  const ownGetter = {}; Object.defineProperty(ownGetter, 'value', { enumerable: true, get: accessor });
  const hidden = {}; Object.defineProperty(hidden, 'value', { value: 1 });
  const symbol = { [Symbol('hidden')]: true };
  const toJSON = { toJSON() { reads++; return {}; } };
  const cycle = {}; cycle.self = cycle;
  const arrayCycle = []; arrayCycle.push(arrayCycle);
  for (const value of [ownGetter, hidden, symbol, toJSON, cycle, arrayCycle])
    rejects(() => assertEffectExecutionEvent(attach(value)));
  const missingKind = opened(); delete missingKind.data.kind;
  Object.setPrototypeOf(missingKind.data, Object.defineProperty({}, 'kind', { get: accessor }));
  rejects(() => assertEffectExecutionEvent(missingKind));
  for (const path of [[], ['data'], ['data', 'program'], ['data', 'source'], ['data', 'binding', 'parameters']]) {
    const event = opened(), record = getAt(event, path);
    Object.defineProperty(record, 'getter', { enumerable: true, get: accessor });
    rejects(() => assertEffectExecutionEvent(event));
  }
  const arrays = [];
  const extra = []; extra.extra = true; arrays.push(extra);
  const subclass = new (class extends Array {})(); arrays.push(subclass);
  arrays.push(new Array(1));
  const disguisedHole = new Array(1); disguisedHole.extra = true; arrays.push(disguisedHole);
  const arrayGetter = [1]; Object.defineProperty(arrayGetter, '0', { enumerable: true, get: accessor }); arrays.push(arrayGetter);
  const hiddenIndex = [1]; Object.defineProperty(hiddenIndex, '0', { enumerable: false }); arrays.push(hiddenIndex);
  const symbolArray = []; symbolArray[Symbol('extra')] = true; arrays.push(symbolArray);
  const protoArray = []; Object.setPrototypeOf(protoArray, null); arrays.push(protoArray);
  for (const value of arrays) {
    rejects(() => assertEffectExecutionEvent(attach(value)));
    rejects(() => beginEffectExecution(opened(), value));
    rejects(() => replayEffectExecution(opened(), value, operations));
  }
  const cursor = beginEffectExecution(opened(), operations);
  Object.defineProperty(cursor, 'index', { enumerable: true, get: accessor });
  rejects(() => advanceEffectExecution(cursor, advance(0, 'expand')));
  assert.equal(reads, 0, 'Validation must never read inherited/own/array getters or invoke toJSON.');
});

test('frozen/null-prototype/shared-subtree JSON is admitted; every result is detached from open/cursor/events and caller mutation', () => {
  const same = { text: 'arbitrary handler parameters', zero: 0, flag: true, null: null, nested: ['data', false, {}] };
  const open = opened([optional(draw())]);
  open.data.binding.parameters = Object.assign(Object.create(null), { left: same, right: same });
  Object.setPrototypeOf(open.data.source, null);
  checkShape(freeze(open), true);
  const cursor = beginEffectExecution(open, operations), before = clone(open);
  cursor.step.action.steps[0].effect.count = 7;
  assert.deepEqual(clone(open), before);
  const replayed = replayEffectExecution(open, [], operations);
  assert.equal(replayed.step.action.steps[0].effect.count, 1);
  const expanded = advanceEffectExecution(replayed, advance(0, 'expand'));
  expanded.step.frames[0].remaining.push(draw(2));
  assert.deepEqual(replayed, beginEffectExecution(open, operations));
  const opt = replayEffectExecution(open, [advance(0, 'expand')], operations);
  const accepted = advanceEffectExecution(opt, advance(1, 'optional', true));
  accepted.step.action.count = 42; accepted.step.frames[0].performed = true;
  assert.equal(opt.step.action.effect.count, 1); assert.equal(opt.step.frames[0].performed, false);
});
