// Pure printed-membership fixtures, not real-card approval or a host ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  OwnedAttackLockError, OWNED_ATTACK_LOCK_RULE_IDS, OWNED_ATTACK_LOCK_SOURCES,
  assertOwnedAttackLockAction, ownedAttackLockWindow, planOwnedAttackLock,
} from '../../public/rules/owned-attack-lock.js';
import * as generated from '../../public/rules/schema-validators.js';

const clone = (value) => structuredClone(value);
const action = (extra = {}) => ({
  op: 'disableOwnedAttack', side: 'opponent', target: 'active',
  duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true, ...extra,
});
const ref = (attackId = 'printed:a', instanceId = 'physical:top') => ({ instanceId, attackId });
const target = () => ({ pokemonId: 'pokemon:opponent', topCardId: 'physical:top' });
const reject = (fn, code) => assert.throws(fn, (error) =>
  error instanceof TypeError && (code === undefined || error.code === code));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function nullPrototypes(value) {
  if (Array.isArray(value)) return value.map(nullPrototypes);
  if (value && typeof value === 'object')
    return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, nullPrototypes(item)])));
  return value;
}
const at = (root, path) => path.reduce((value, key) => value[key], root);
const set = (root, path, value) => { at(root, path.slice(0, -1))[path.at(-1)] = value; };

// Context projections are intentionally public/requested facts. The production
// catalog/host, not this module, validates all other card/state fields.
function context({
  owner = 0, cardOwner = owner, present = true, printed = ['printed:a', 'printed:b'],
  depth = 1, used = false, current = 1 - owner,
} = {}) {
  const opponent = 1 - owner, stack = [
    ...Array.from({ length: depth - 1 }, (_v, i) => `physical:lower-${i}`), 'physical:top',
  ];
  const active = {
    id: 'pokemon:opponent', stack, energy: used ? ['physical:energy'] : [],
    tools: ['physical:tool'], used: used ? { GX: [1] } : {},
    facts: { lastUsedAttack: used ? { attackId: 'printed:a' } : null },
    conditions: { rotation: used ? 'asleep' : null },
  };
  const players = Array.from({ length: 2 }, () => ({
    active: { id: 'pokemon:own', stack: ['physical:own'] },
    bench: [{ id: 'pokemon:bench', stack: ['physical:bench'] }],
    deck: ['hidden:deck'], hand: ['hidden:hand'], prizes: ['hidden:prize'],
    gxUsed: used, vstarUsed: used,
  }));
  players[opponent].active = present ? active : null;
  const printedDefinition = {
    definitionId: 'definition:top', kind: 'pokemon', name: 'TEST ONLY',
    mechanics: {
      attacks: printed.map((attackId) => ({
        attackId, name: '相同显示名称', cost: used ? ['Fire', 'Fire'] : [],
        specialRule: 'GX', printedDamage: { value: 10, operator: 'fixed' }, effects: [],
      })),
      grantedAttacks: [{ attackId: 'extra:body' }], abilities: [{ granted: 'extra:ability' }],
      effects: [{ op: 'attackGrant', attacks: ['extra:permission'] }],
    },
  };
  const cards = {
    'physical:top': { instanceId: 'physical:top', owner: opponent, definitionId: 'definition:top' },
    'physical:own': { instanceId: 'physical:own', owner, definitionId: 'definition:own' },
    'physical:bench': { instanceId: 'physical:bench', owner: opponent, definitionId: 'definition:bench' },
    'physical:tool': { instanceId: 'physical:tool', owner: opponent, definitionId: 'definition:tool' },
  };
  for (const id of stack.slice(0, -1)) cards[id] = { instanceId: id, owner: opponent, definitionId: 'definition:lower' };
  return {
    source: { owner, cardOwner, category: 'attack', pokemonId: 'pokemon:own' },
    state: { current, turn: 7, players, cards, ongoing: [{ effect: { attackIds: [...printed] } }], rng: [1, 2, 3, 4] },
    definitions: {
      'definition:top': printedDefinition,
      'definition:own': { definitionId: 'definition:own', kind: 'pokemon', mechanics: { attacks: [{ attackId: 'own:attack' }] } },
      'definition:lower': { definitionId: 'definition:lower', kind: 'pokemon', mechanics: { attacks: [{ attackId: 'lower:attack' }] } },
      'definition:bench': { definitionId: 'definition:bench', kind: 'pokemon', mechanics: { attacks: [{ attackId: 'bench:attack' }] } },
      'definition:tool': { definitionId: 'definition:tool', kind: 'trainer', mechanics: { grantedAttacks: [{ attackId: 'extra:tool' }] } },
    },
    effectivePokemon: { 'pokemon:opponent': { attacks: ['extra:ability', 'extra:permission', 'lower:attack'] } },
    legalActions: [],
  };
}

const schema = JSON.parse(await readFile(new URL('../../schemas/owned-attack-lock.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
const rootSchema = ajv.getSchema(schema.$id);
const referenceSchema = ajv.getSchema(`${schema.$id}#/$defs/reference`);
const targetSchema = ajv.getSchema(`${schema.$id}#/$defs/target`);
const windowSchema = ajv.getSchema(`${schema.$id}#/$defs/window`);
const planSchema = ajv.getSchema(`${schema.$id}#/$defs/plan`);
function checkAction(value, expected) {
  assert.equal(rootSchema(value), expected);
  if (expected) assert.equal(assertOwnedAttackLockAction(value), value);
  else reject(() => assertOwnedAttackLockAction(value));
}

test('fixed six-field root and explicit source evidence identify the printed-choice software boundary, not card approval', () => {
  assert.equal(schema.$id, 'urn:pokemon-tcg:owned-attack-lock:1.0.0');
  assert.equal(schema.$ref, '#/$defs/action');
  assert.deepEqual(schema.$defs.action.required, Object.keys(action()));
  assert.match(schema.$comment, /II\.C-15 PDF p36/);
  assert.match(schema.$comment, /II\.C-17 p38.*II\.D-04 p43.*II\.D-06 p44–45/);
  assert.match(schema.$comment, /II\.E-37 p74–75/);
  assert.match(schema.$comment, /NOT card approval or authorization/);
  assert.deepEqual(OWNED_ATTACK_LOCK_RULE_IDS, ['effects.pokemon-lock', 'attack.owned', 'selection.exact']);
  assert(Object.isFrozen(OWNED_ATTACK_LOCK_RULE_IDS));
  assert.deepEqual(OWNED_ATTACK_LOCK_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.C-15', pdfPages: [36] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.C-17', pdfPages: [38] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.D-04', pdfPages: [43] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.D-06', pdfPages: [44, 45] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-37', pdfPages: [74, 75] },
  ]);
  assert(Object.isFrozen(OWNED_ATTACK_LOCK_SOURCES));
  for (const item of OWNED_ATTACK_LOCK_SOURCES) { assert(Object.isFrozen(item)); assert(Object.isFrozen(item.pdfPages)); }
  const error = new OwnedAttackLockError('fixture:error', 'fixture');
  assert(error instanceof TypeError); assert.equal(error.code, 'fixture:error'); assert.equal(error.name, 'OwnedAttackLockError');
  checkAction(freeze(action()), true);
});

// Independent ordered-subset enumeration, not production candidate logic.
function orderedSubsets(values) {
  const out = [[]];
  function walk(prefix, remaining) {
    for (let i = 0; i < remaining.length; i++) {
      const next = [...prefix, remaining[i]]; out.push(next);
      walk(next, remaining.filter((_v, j) => i !== j));
    }
  }
  walk([], values);
  return out;
}
function oracle(owner, printed, present, chosen, blocked) {
  const legalCount = present && printed.length > 0 ? 1 : 0;
  const accepted = chosen.length === legalCount && chosen.every((item) =>
    item.instanceId === 'physical:top' && printed.includes(item.attackId));
  return { accepted, result: {
    owner: 1 - owner, target: present ? target() : null, selected: clone(chosen),
    performed: legalCount === 1 && !blocked,
  } };
}

test('independent ordered-subset/selection oracle: all printed choices, relative users, runtime noise and blocked results', (t) => {
  const universe = ['printed:a', 'printed:b', 'printed:c', 'printed:d'];
  const lists = orderedSubsets(universe);
  assert.equal(lists.length, 65);
  let windows = 0, plans = 0, accepted = 0, denied = 0;
  for (const owner of [0, 1]) for (const cardOwner of [0, 1]) for (const depth of [1, 3])
    for (const used of [false, true]) for (const printed of lists) {
      const ctx = freeze(context({ owner, cardOwner, depth, used, printed })), a = freeze(action());
      const before = clone({ ctx, a });
      const expected = {
        owner: 1 - owner, target: target(),
        candidates: printed.map((attackId) => ({ instanceId: 'physical:top', attackId })),
      };
      assert.deepEqual(ownedAttackLockWindow(ctx, a), expected);
      assert.equal(windowSchema(expected), true);
      windows++;
      const selections = [
        [], ...universe.map((attackId) => [ref(attackId)]),
        [ref('lower:attack', 'physical:lower-0')], [ref('extra:tool', 'physical:tool')],
        [ref('own:attack', 'physical:own')], [ref('printed:a', 'physical:foreign')],
        [ref('printed:a'), ref('printed:a')], [ref('printed:a'), ref('printed:b')],
      ];
      for (const chosen of selections) for (const blocked of [false, true]) {
        const model = oracle(owner, printed, true, chosen, blocked), selected = freeze(clone(chosen));
        if (model.accepted) {
          const plan = planOwnedAttackLock(ctx, a, selected, blocked);
          assert.deepEqual(plan, model.result); assert.equal(planSchema(plan), true); accepted++;
        } else {
          reject(() => planOwnedAttackLock(ctx, a, selected, blocked), 'invalid-owned-attack-lock-selection'); denied++;
        }
        assert.deepEqual(selected, chosen); plans++;
      }
      assert.deepEqual({ ctx, a }, before);
    }
  for (const owner of [0, 1]) for (const blocked of [false, true]) {
    const ctx = freeze(context({ owner, present: false }));
    const expected = { owner: 1 - owner, target: null, candidates: [] };
    assert.deepEqual(ownedAttackLockWindow(ctx, action()), expected);
    const model = oracle(owner, [], false, [], blocked);
    assert.deepEqual(planOwnedAttackLock(ctx, action(), [], blocked), model.result);
    assert.equal(windowSchema(expected), true); assert.equal(planSchema(model.result), true);
    reject(() => planOwnedAttackLock(ctx, action(), [ref()], blocked));
  }
  assert.equal(windows, 1040); assert.equal(plans, 22880);
  assert.equal(accepted + denied, plans);
  t.diagnostic(`${windows} ordered printed windows; ${plans} independent selection/mask cases (${accepted} accepted, ${denied} rejected), plus absent targets.`);
});

test('top physical identity wins over lower evolution cards, Tools, body grants, energy sufficiency, use quotas and existing locks', () => {
  const ctx = context({ owner: 1, cardOwner: 0, depth: 3, used: true, printed: ['printed:b', 'printed:a'] });
  const before = clone(ctx), window = ownedAttackLockWindow(ctx, action());
  assert.deepEqual(window, { owner: 0, target: target(), candidates: [ref('printed:b'), ref('printed:a')] });
  assert.deepEqual(ctx, before);
  for (const id of ['lower:attack', 'extra:tool', 'extra:body', 'extra:ability', 'extra:permission', 'own:attack', 'bench:attack'])
    reject(() => planOwnedAttackLock(ctx, action(), [ref(id)]));
  const names = ctx.definitions['definition:top'].mechanics.attacks.map((a) => a.name);
  assert.equal(new Set(names).size, 1, 'Equal displayed names do not deduplicate printed entries.');
  assert.equal(window.candidates.length, 2);
  const one = context({ printed: ['printed:a'] });
  assert.equal(planOwnedAttackLock(one, action(), [ref()]).performed, true, 'Default blocked is false.');
  const blocked = planOwnedAttackLock(one, action(), [ref()], true);
  assert.deepEqual(blocked.selected, [ref()]); assert.equal(blocked.performed, false);
  assert.deepEqual(Object.keys(blocked), ['owner', 'target', 'selected', 'performed']);
});

test('present zero-attack targets and absent Active targets remain distinct; no optional-zero escape with candidates', () => {
  const present = context({ printed: [] }), absent = context({ present: false });
  assert.deepEqual(ownedAttackLockWindow(present, action()), { owner: 1, target: target(), candidates: [] });
  for (const ctx of [present, absent]) for (const blocked of [false, true]) {
    const plan = planOwnedAttackLock(ctx, action(), [], blocked);
    assert.deepEqual(plan.selected, []); assert.equal(plan.performed, false);
    reject(() => planOwnedAttackLock(ctx, action(), [ref()], blocked));
  }
  for (const blocked of [false, true]) reject(() => planOwnedAttackLock(context(), action(), [], blocked));
  for (const blocked of [null, 0, 1, 'false', [], {}, new Boolean(false), () => false])
    reject(() => planOwnedAttackLock(context(), action(), [ref()], blocked));
});

test('action is exact, with no defaults, generic targeting, duration changes or prefilled attack IDs', () => {
  for (const key of Object.keys(action())) {
    const value = action(); delete value[key]; checkAction(value, false);
    for (const wrong of [null, 0, 1, '', false, [], {}, 'arbitrary']) {
      const changed = action({ [key]: wrong });
      if (changed[key] !== action()[key]) checkAction(changed, false);
    }
  }
  for (const extra of [
    { side: 'own' }, { target: 'bench' }, { target: 'any' }, { duration: 'untilNextOpponentTurnEnd' },
    { op: 'restriction' }, { attackIds: ['printed:a'] }, { selected: [ref()] },
    { selector: { kind: 'pokemon' } }, { count: 1 }, { effect: {} },
    { sourceOfTruth: [] }, { approved: true }, { blocked: false }, { chosenName: 'name' },
  ]) checkAction(action(extra), false);
  for (const value of [null, undefined, true, 1, 'action', [], new Date(), Object.create({ ...action() })])
    reject(() => assertOwnedAttackLockAction(value));
});

test('selected reference shape, exact membership and cardinality reject foreign/lower/duplicated/partial or augmented choices', () => {
  for (const selected of [
    null, undefined, {}, 'printed:a', 1, true, [null], [[]], [1], [{}],
    [{ instanceId: 'physical:top' }], [{ attackId: 'printed:a' }],
    [ref('', 'physical:top')], [ref('printed:a', '')], [ref(null)], [ref('printed:a', 7)],
    [{ ...ref(), owner: 1 }], [{ ...ref(), name: 'selected' }], [{ ...ref(), effect: {} }],
    [ref('missing')], [ref('printed:a', 'physical:lower-0')], [ref('printed:a', 'physical:own')],
    [ref(), ref()], [ref(), ref('printed:b')], [ref(), ref('printed:b'), ref('printed:c')],
  ]) reject(() => planOwnedAttackLock(context(), action(), selected));
  const alias = ref();
  assert.throws(() => planOwnedAttackLock(context(), action(), [alias, alias]), /exactly one/,
    'Repeated acyclic object references are not misreported as cycles; the selection count is invalid.');
});

test('only requested public facts are inspected; hidden, effective, grant, attack cost and runtime getters are never executed', () => {
  let reads = 0;
  const poison = (object, key) => Object.defineProperty(object, key, {
    enumerable: true, configurable: true, get() { reads++; throw new Error(`Unexpected read ${key}`); },
  });
  for (const owner of [0, 1]) {
    const ctx = context({ owner, depth: 3 });
    const opponent = 1 - owner, mon = ctx.state.players[opponent].active;
    for (const key of ['effectivePokemon', 'legalActions', 'event', 'payment', 'rng']) poison(ctx, key);
    for (const key of ['hand', 'deck', 'prizes', 'discard', 'lost', 'resolving', 'bench', 'gxUsed', 'vstarUsed'])
      for (const player of ctx.state.players) poison(player, key);
    for (const key of ['used', 'facts', 'counters', 'energy', 'tools', 'conditions', 'currentHp', 'maximumHp']) poison(mon, key);
    for (const key of ['current', 'ongoing', 'rng', 'attack', 'events', 'stadium']) poison(ctx.state, key);
    for (const key of ['cardOwner', 'pokemonId', 'category']) poison(ctx.source, key);
    poison(ctx.state.players[owner], 'active');
    const definition = ctx.definitions['definition:top'];
    for (const key of ['name', 'sourceOfTruth', 'implementation']) poison(definition, key);
    for (const key of ['abilities', 'effects', 'grantedAttacks', 'types', 'hp']) poison(definition.mechanics, key);
    for (const attack of definition.mechanics.attacks)
      for (const key of ['name', 'cost', 'specialRule', 'printedDamage', 'effects', 'sourceOfTruth']) poison(attack, key);
    for (const key of ['definition:lower', 'definition:tool', 'definition:bench', 'definition:own', 'unrelated']) poison(ctx.definitions, key);
    for (const key of ['physical:lower-0', 'physical:lower-1', 'physical:tool', 'unrelated']) poison(ctx.state.cards, key);
    ctx.unrelated = ctx; // No whole-context traversal or false whole-state approval.
    const expected = { owner: opponent, target: target(), candidates: [ref(), ref('printed:b')] };
    assert.deepEqual(ownedAttackLockWindow(ctx, action()), expected);
    assert.deepEqual(planOwnedAttackLock(ctx, action(), [ref()], true),
      { owner: opponent, target: target(), selected: [ref()], performed: false });
  }
  const absent = context({ present: false });
  poison(absent.state, 'cards'); poison(absent, 'definitions');
  assert.deepEqual(ownedAttackLockWindow(absent, action()), { owner: 1, target: null, candidates: [] });
  assert.equal(reads, 0);
});

test('requested context identity/owner/card/printed membership facts fail closed without inherited or executable fallbacks', () => {
  const mutations = [
    [['source'], null], [['source'], []], [['source', 'owner'], null], [['source', 'owner'], 2],
    [['source', 'owner'], -1], [['source', 'owner'], 0.5], [['source', 'owner'], '0'], [['source', 'owner'], false],
    [['state'], null], [['state', 'players'], null], [['state', 'players'], []],
    [['state', 'players'], [{}]], [['state', 'players'], [{}, {}, {}]],
    [['state', 'players', 1], null], [['state', 'players', 1, 'active'], undefined],
    [['state', 'players', 1, 'active'], []], [['state', 'players', 1, 'active'], 'pokemon'],
    [['state', 'players', 1, 'active', 'id'], ''], [['state', 'players', 1, 'active', 'id'], 7],
    [['state', 'players', 1, 'active', 'stack'], []], [['state', 'players', 1, 'active', 'stack'], {}],
    [['state', 'players', 1, 'active', 'stack'], ['physical:top', 'physical:top']],
    [['state', 'players', 1, 'active', 'stack'], ['', 'physical:top']],
    [['state', 'players', 1, 'active', 'stack'], [false, 'physical:top']],
    [['state', 'players', 1, 'active', 'stack'], [7, 'physical:top']],
    [['state', 'cards'], null], [['state', 'cards', 'physical:top'], null],
    [['state', 'cards', 'physical:top', 'instanceId'], 'foreign'],
    [['state', 'cards', 'physical:top', 'owner'], 0],
    [['state', 'cards', 'physical:top', 'definitionId'], ''],
    [['state', 'cards', 'physical:top', 'definitionId'], null],
    [['definitions'], null], [['definitions', 'definition:top'], null],
    [['definitions', 'definition:top', 'definitionId'], 'foreign'],
    [['definitions', 'definition:top', 'kind'], 'trainer'],
    [['definitions', 'definition:top', 'kind'], 'energy'],
    [['definitions', 'definition:top', 'mechanics'], null],
    [['definitions', 'definition:top', 'mechanics', 'attacks'], null],
    [['definitions', 'definition:top', 'mechanics', 'attacks'], {}],
    [['definitions', 'definition:top', 'mechanics', 'attacks'], [null]],
    [['definitions', 'definition:top', 'mechanics', 'attacks'], [[]]],
    [['definitions', 'definition:top', 'mechanics', 'attacks'], [{}]],
    [['definitions', 'definition:top', 'mechanics', 'attacks'], [{ attackId: '' }]],
    [['definitions', 'definition:top', 'mechanics', 'attacks'], [{ attackId: 1 }]],
    [['definitions', 'definition:top', 'mechanics', 'attacks'], [{ attackId: 'same' }, { attackId: 'same' }]],
  ];
  for (const [path, value] of mutations) {
    const ctx = context(); set(ctx, path, value);
    reject(() => ownedAttackLockWindow(ctx, action()), 'invalid-owned-attack-lock-context');
  }
  reject(() => ownedAttackLockWindow(null, action()));
  const fields = [
    ['source'], ['source', 'owner'], ['state'], ['state', 'players'],
    ['state', 'players', 1, 'active'], ['state', 'players', 1, 'active', 'id'],
    ['state', 'players', 1, 'active', 'stack'], ['state', 'cards'], ['state', 'cards', 'physical:top'],
    ['state', 'cards', 'physical:top', 'instanceId'], ['state', 'cards', 'physical:top', 'owner'],
    ['state', 'cards', 'physical:top', 'definitionId'], ['definitions'], ['definitions', 'definition:top'],
    ['definitions', 'definition:top', 'definitionId'], ['definitions', 'definition:top', 'kind'],
    ['definitions', 'definition:top', 'mechanics'], ['definitions', 'definition:top', 'mechanics', 'attacks'],
    ['definitions', 'definition:top', 'mechanics', 'attacks', 0, 'attackId'],
  ];
  let calls = 0;
  for (const path of fields) for (const mode of ['missing', 'hidden', 'getter', 'inherited']) {
    const ctx = context(), object = at(ctx, path.slice(0, -1)), key = path.at(-1), original = object[key];
    if (mode === 'missing') delete object[key];
    else if (mode === 'hidden') Object.defineProperty(object, key, { value: original, enumerable: false });
    else if (mode === 'getter') Object.defineProperty(object, key, { enumerable: true, get() { calls++; return original; } });
    else { delete object[key]; Object.setPrototypeOf(object, { [key]: original }); }
    reject(() => ownedAttackLockWindow(ctx, action()));
  }
  assert.equal(calls, 0);
});

test('strict action/selected/stack JSON rejects getters, sparse/custom arrays, symbols, cycles and executable values without invocation', () => {
  let calls = 0;
  const getter = (object, key) => Object.defineProperty(object, key, {
    enumerable: true, get() { calls++; return 'printed:a'; },
  });
  const cyclic = {}; cyclic.self = cyclic;
  const cyclicArray = []; cyclicArray.push(cyclicArray);
  const sparse = new Array(1);
  const accessorArray = getter([null], '0');
  const hiddenArray = [null]; Object.defineProperty(hiddenArray, '0', { value: null, enumerable: false });
  const customArray = Object.setPrototypeOf([], Object.create(Array.prototype));
  const extraArray = []; extraArray.extra = 1;
  const symbolArray = []; symbolArray[Symbol('hidden')] = 1;
  const unsupported = [
    undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol('hidden'), new Date(), new Map(), new Set(), /attack/,
    Object.create({ attackId: 'printed:a' }), cyclic, cyclicArray, sparse, accessorArray, hiddenArray, customArray, extraArray, symbolArray,
  ];
  for (const value of unsupported) {
    reject(() => assertOwnedAttackLockAction(action({ extra: value })));
    reject(() => planOwnedAttackLock(context(), action(), value));
    const ctx = context(); ctx.state.players[1].active.stack = value;
    reject(() => ownedAttackLockWindow(ctx, action()));
  }
  const symbolObject = action(); symbolObject[Symbol('secret')] = 1;
  const hidden = action(); Object.defineProperty(hidden, 'secret', { value: 1, enumerable: false });
  const withGetter = getter(action(), 'side');
  const toJSON = action({ toJSON() { calls++; return action(); } });
  for (const value of [symbolObject, hidden, withGetter, toJSON]) reject(() => assertOwnedAttackLockAction(value));
  const selectedGetter = [getter(ref(), 'attackId')];
  const selectedHidden = ref(); Object.defineProperty(selectedHidden, 'attackId', { value: 'printed:a', enumerable: false });
  const selectedSymbol = ref(); selectedSymbol[Symbol('secret')] = 1;
  for (const value of [selectedGetter, [selectedHidden], [selectedSymbol], [cyclic], [cyclicArray]])
    reject(() => planOwnedAttackLock(context(), action(), value));
  for (const path of [['state', 'players'], ['definitions', 'definition:top', 'mechanics', 'attacks']]) {
    for (const invalid of [sparse, accessorArray, hiddenArray, customArray, extraArray, symbolArray]) {
      const ctx = context(); set(ctx, path, invalid); reject(() => ownedAttackLockWindow(ctx, action()));
    }
  }
  assert.equal(calls, 0);
});

test('frozen and legal null-prototype inputs are accepted; all output objects/arrays are detached and caller mutation cannot change inputs', () => {
  const ctx = freeze(context({ depth: 3 })), a = freeze(action()), selected = freeze([ref()]);
  const before = clone({ ctx, a, selected }), window = ownedAttackLockWindow(ctx, a), plan = planOwnedAttackLock(ctx, a, selected);
  const plain = { window: clone(window), plan: clone(plan) };
  const zeroProtoContext = nullPrototypes(ctx), zeroProtoAction = nullPrototypes(a), zeroProtoSelected = nullPrototypes(selected);
  assert.equal(assertOwnedAttackLockAction(zeroProtoAction), zeroProtoAction);
  assert.deepEqual(ownedAttackLockWindow(zeroProtoContext, zeroProtoAction), plain.window);
  assert.deepEqual(planOwnedAttackLock(zeroProtoContext, zeroProtoAction, zeroProtoSelected), plain.plan);
  assert.notEqual(plan.selected, selected); assert.notEqual(plan.selected[0], selected[0]);
  window.target.topCardId = 'tampered'; window.candidates[0].attackId = 'tampered'; window.candidates.push(ref('injected'));
  plan.target.pokemonId = 'tampered'; plan.selected[0].instanceId = 'tampered'; plan.selected.length = 0;
  assert.deepEqual({ ctx, a, selected }, before);
  assert.deepEqual(ownedAttackLockWindow(ctx, a), plain.window);
  assert.deepEqual(planOwnedAttackLock(ctx, a, selected), plain.plan);
  const hostile = context();
  delete hostile.state.cards['physical:top']; Object.setPrototypeOf(hostile.state.cards, {
    'physical:top': { instanceId: 'physical:top', owner: 1, definitionId: 'definition:top' },
  });
  reject(() => ownedAttackLockWindow(hostile, a));
  for (const key of ['__proto__', 'constructor']) {
    const safe = context();
    safe.state.players[1].active.stack = [key];
    safe.state.cards = Object.fromEntries([[key, { instanceId: key, owner: 1, definitionId: key }]]);
    safe.definitions = Object.fromEntries([[key, { definitionId: key, kind: 'pokemon', mechanics: { attacks: [{ attackId: key }] } }]]);
    assert.deepEqual(ownedAttackLockWindow(safe, a).candidates, [{ instanceId: key, attackId: key }]);
    assert.equal(planOwnedAttackLock(safe, a, [{ instanceId: key, attackId: key }]).performed, true);
  }
});

test('reference/target/window/plan schemas reject extra fields, impossible null-target/performed shapes and invented effect authority', () => {
  const validReference = ref(), validTarget = target();
  const validWindow = { owner: 1, target: validTarget, candidates: [validReference] };
  const validPlan = { owner: 1, target: validTarget, selected: [validReference], performed: true };
  for (const [validate, value] of [[referenceSchema, validReference], [targetSchema, validTarget],
    [windowSchema, validWindow], [planSchema, validPlan]]) {
    assert.equal(validate(value), true);
    assert.equal(validate({ ...value, unexpected: true }), false);
    for (const key of Object.keys(value)) { const bad = clone(value); delete bad[key]; assert.equal(validate(bad), false); }
  }
  for (const bad of [
    { ...validReference, attackId: '' }, { ...validReference, instanceId: 1 }, { ...validReference, name: 'not-identity' },
  ]) assert.equal(referenceSchema(bad), false);
  for (const bad of [{ ...validTarget, pokemonId: null }, { ...validTarget, topCardId: '' }])
    assert.equal(targetSchema(bad), false);
  for (const bad of [
    { ...validWindow, owner: 2 }, { ...validWindow, target: null },
    { ...validWindow, candidates: [ref(), ref()] }, { ...validWindow, candidates: {} },
  ]) assert.equal(windowSchema(bad), false);
  for (const bad of [
    { ...validPlan, owner: -1 }, { ...validPlan, performed: 1 }, { ...validPlan, selected: [] },
    { ...validPlan, selected: [ref(), ref('printed:b')] }, { ...validPlan, target: null },
    { ...validPlan, effect: { op: 'restriction' } }, { ...validPlan, deadline: {} }, { ...validPlan, blocked: false },
    { owner: 1, target: null, selected: [], performed: true },
    { owner: 1, target: null, selected: [ref()], performed: false },
  ]) assert.equal(planSchema(bad), false);
  for (const good of [
    { owner: 0, target: null, selected: [], performed: false },
    { owner: 0, target: target(), selected: [], performed: false },
    { owner: 0, target: target(), selected: [ref()], performed: false },
  ]) assert.equal(planSchema(good), true);
  assert.equal(windowSchema({ owner: 0, target: null, candidates: [] }), true);
  assert.equal(windowSchema({ owner: 0, target: target(), candidates: [] }), true);
});

test('parent generated action/parameter validators match this standalone exact root', () => {
  const { validateOwnedAttackLockAction, validateOwnedAttackLockParameters } = generated;
  assert.equal(typeof validateOwnedAttackLockAction, 'function');
  assert.equal(typeof validateOwnedAttackLockParameters, 'function');
  for (const value of [
    action(), null, {}, { ...action(), target: 'bench' }, { ...action(), attackIds: ['printed:a'] },
    { ...action(), clearOnBench: false }, { effect: action() },
  ]) {
    const expected = rootSchema(value);
    assert.equal(validateOwnedAttackLockAction(value), expected);
    assert.equal(validateOwnedAttackLockParameters(value), expected);
  }
});
