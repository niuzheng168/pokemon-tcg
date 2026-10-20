// Synthetic printed definitions and physical cards, never real-card approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  PrizeExchangeError, PRIZE_EXCHANGE_RULE_IDS, PRIZE_EXCHANGE_SOURCES,
  assertPrizeExchangeAction, prizeExchangeWindow, planPrizeExchange, assertPrizeExchangePlan,
} from '../../public/rules/prize-exchange.js';

const clone = (value) => structuredClone(value);
const action = (selector = { kind: 'any' }, revealSelected = false) =>
  ({ op: 'exchangePrizes', selector, revealSelected });
const evidence = [{
  sourceId: 'fixture:prize-exchange', kind: 'official-card', url: 'https://www.pokemon.cn/',
  locator: 'TEST ONLY: synthetic printed definitions, not an actual card approval.',
}];
const base = (id, kind, mechanics) => ({
  schemaVersion: '1.0.0', definitionId: `fixture:${id}`, ruleset: { region: 'CN', version: 'V20261019' },
  name: `测试${id}`, nameKey: `fixture:${id}`, kind, mechanics, sourceOfTruth: clone(evidence),
  implementation: { status: 'verified', testIds: ['fixture:test'] }, deckLimits: { sameName: 4, groups: [] },
});
const pokemon = (id, hp, types, stage = 'basic') => base(id, 'pokemon', {
  stage, evolvesFrom: stage === 'basic' ? null : 'fixture:water', hp, types,
  weakness: null, resistance: null, retreatCost: 1, attacks: [], abilities: [],
  ruleBox: false, prizeCount: 1, tags: [], effects: [],
});
const trainer = (id, category) => base(id, 'trainer', { category, effects: [] });
function definitions(category) {
  const values = [
    trainer('source', category), pokemon('water', 60, ['Water']), pokemon('fire', 80, ['Fire']),
    pokemon('stage', 140, ['Water'], 'stage1'),
    base('energy', 'energy', { category: 'basic', baseUnits: [['Water']], effects: [] }),
    base('special', 'energy', { category: 'special', baseUnits: [['Colorless'], ['Colorless']], effects: [] }),
    trainer('item', 'item'),
  ];
  return Object.fromEntries(values.map((value) => [value.definitionId, value]));
}
function addCard(ctx, id, definitionId, owner) {
  Object.defineProperty(ctx.state.cards, id, {
    enumerable: true, configurable: true, writable: true,
    value: { instanceId: id, definitionId, printingId: `printing:${id}`, owner },
  });
}
function context(tokens = ['water', 'stage', 'energy'], owner = 0, category = 'item', names = null) {
  const player = () => ({ deck: [], hand: [], discard: [], lost: [], prizes: [], resolving: [], active: null, bench: [] });
  const ctx = {
    source: { owner, instanceId: 'source', category: 'trainer' },
    definitions: definitions(category),
    state: { current: 1 - owner, cards: {}, players: [player(), player()], stadium: null, rng: [1, 2, 3, 4] },
  };
  addCard(ctx, 'source', 'fixture:source', owner);
  ctx.state.players[owner].resolving.push('source');
  tokens.forEach((token, index) => {
    const id = names ? names[index] : `prize:${index}`;
    addCard(ctx, id, `fixture:${token}`, owner);
    ctx.state.players[owner].prizes.push(id);
  });
  // Metadata is sufficient for unrelated cards. Their private card faces must
  // NOT be read/required by this operation.
  addCard(ctx, 'foreign', 'uninspected:foreign', 1 - owner);
  ctx.state.players[1 - owner].deck.push('foreign');
  addCard(ctx, 'old-hand', 'uninspected:hand', owner);
  ctx.state.players[owner].hand.push('old-hand');
  return ctx;
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const rejects = (fn) => assert.throws(fn, TypeError);
const own = (ctx) => ctx.state.players[ctx.source.owner];
const setAt = (root, path, value) => {
  const parent = path.slice(0, -1).reduce((current, key) => current[key], root);
  parent[path.at(-1)] = value;
};
const getAt = (root, path) => path.reduce((current, key) => current[key], root);

// Standalone Ajv registration of transitive references. No shared compiler,
// generator, catalog, kernel build stamp, or parent integration file is changed.
const ajv = new Ajv2020({ strict: true, allErrors: true }), loaded = new Map();
async function register(name) {
  const document = JSON.parse(await readFile(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
  if (loaded.has(document.$id)) return;
  loaded.set(document.$id, document); ajv.addSchema(document);
  const pending = [document];
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
await register('prize-exchange');
const schema = loaded.get('urn:pokemon-tcg:prize-exchange:1.0.0');
const schemaAction = ajv.getSchema(schema.$id);
const schemaPlan = ajv.getSchema(`${schema.$id}#/$defs/plan`);

function* words(alphabet, length, prefix = []) {
  if (!length) { yield prefix; return; }
  for (const token of alphabet) yield* words(alphabet, length - 1, [...prefix, token]);
}
const cases = [
  { selector: { kind: 'any' }, accepts: ['water', 'fire', 'stage', 'energy', 'special', 'item'], any: true },
  { selector: { kind: 'pokemon', stages: ['basic'] }, accepts: ['water', 'fire'], any: false },
  { selector: { kind: 'pokemon', types: ['Water'], printedHpAtMost: 70 }, accepts: ['water'], any: false },
  { selector: { kind: 'energy', category: 'basic', types: ['Water'] }, accepts: ['energy'], any: false },
  { selector: { anyOf: [{ kind: 'pokemon', stages: ['stage1'] }, { kind: 'trainer', categories: ['item'] }] },
    accepts: ['stage', 'item'], any: false },
];
// Independent positional swap oracle: splice one index, not the production
// map/selection helpers. Conservation includes source left outside on zero.
function oraclePlan(owner, window, chosen) {
  const prizesAfter = [...window];
  if (chosen.length) prizesAfter.splice(window.indexOf(chosen[0]), 1, 'source');
  return { owner, sourceId: 'source', window: [...window], selected: [...chosen], prizesAfter };
}
function assertConservation(plan) {
  assert.equal(plan.prizesAfter.length, plan.window.length);
  const before = [...plan.window, plan.sourceId].sort();
  const after = [...plan.prizesAfter, ...plan.selected, ...(plan.selected.length ? [] : [plan.sourceId])].sort();
  assert.deepEqual(after, before);
  assert.equal(new Set(after).size, after.length);
}

test('root schema and immutable source references pin CN C-20 p41, E-34 p73 and E-35 p73–74 only', () => {
  assert.equal(schema.$id, 'urn:pokemon-tcg:prize-exchange:1.0.0');
  assert.equal(schema.$ref, '#/$defs/action');
  assert.equal(schema.$defs.action.properties.selector.$ref, 'urn:pokemon-tcg:card-selector:1.0.0');
  assert.deepEqual(PRIZE_EXCHANGE_RULE_IDS, ['effects.prize-exchange', 'selection.prizes', 'selection.exact', 'effects.shuffle']);
  assert.deepEqual(PRIZE_EXCHANGE_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.C-20', pdfPages: [41] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-34', pdfPages: [73] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-35', pdfPages: [73, 74] },
  ]);
  assert(Object.isFrozen(PRIZE_EXCHANGE_RULE_IDS));
  assert(Object.isFrozen(PRIZE_EXCHANGE_SOURCES));
  for (const source of PRIZE_EXCHANGE_SOURCES) {
    assert(Object.isFrozen(source)); assert(Object.isFrozen(source.pdfPages));
  }
  assert.match(schema.$comment, /II\.C-20.*41.*II\.E-34.*73.*II\.E-35.*73–74/);
  assert.match(schema.$comment, /27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419/);
});

test('independent complete small-domain selection/positional-conservation oracle checks both owners and reveal flags', (t) => {
  const alphabet = ['water', 'fire', 'stage', 'energy', 'special', 'item'];
  let configurations = 0, accepted = 0, rejected = 0;
  for (const owner of [0, 1]) for (let length = 0; length <= 3; length++)
    for (const tokens of words(alphabet, length)) {
      const ctx = freeze(context(tokens, owner, owner === 0 ? 'item' : 'supporter')), before = JSON.stringify(ctx);
      const window = [...ctx.state.players[owner].prizes];
      for (const row of cases) for (const reveal of [false, true]) {
        const a = freeze(action(row.selector, reveal));
        assert.equal(schemaAction(a), true);
        assert.equal(assertPrizeExchangeAction(a), a);
        const eligible = window.filter((_id, index) => row.accepts.includes(tokens[index]));
        const minimum = row.any && window.length ? 1 : 0, maximum = eligible.length ? 1 : 0;
        const view = prizeExchangeWindow(ctx, a);
        assert.equal(view.owner, owner); assert.equal(view.sourceId, 'source');
        assert.deepEqual(view.window, window);
        assert.deepEqual(view.eligible, eligible);
        assert.equal(view.bounds.minimum, minimum);
        assert.equal(view.bounds.maximum, maximum);
        assert.equal(view.bounds.allowZero, minimum === 0);
        assert(view.bounds.trace.some((trace) => trace.ruleId === 'selection.exact'));
        if (!row.any) assert(view.bounds.trace.some((trace) => trace.ruleId === 'selection.prizes'));
        for (const chosen of [[], ...window.map((id) => [id])]) {
          freeze(chosen);
          const legal = chosen.length === 0 ? minimum === 0 : eligible.includes(chosen[0]);
          if (!legal) { rejects(() => planPrizeExchange(ctx, a, chosen)); rejected++; continue; }
          const plan = planPrizeExchange(ctx, a, chosen), expected = oraclePlan(owner, window, chosen);
          assert.deepEqual(plan, expected);
          assertConservation(plan);
          assert.equal(schemaPlan(plan), true);
          assert.notEqual(plan.selected, chosen);
          assert.notEqual(plan.window, ctx.state.players[owner].prizes);
          assert.notEqual(plan.prizesAfter, plan.window);
          const saved = freeze(JSON.parse(JSON.stringify(plan)));
          assert.equal(assertPrizeExchangePlan(ctx, a, saved), saved);
          assert.deepEqual(saved, expected);
          accepted++;
        }
        configurations++;
      }
      assert.equal(JSON.stringify(ctx), before, 'No card, zone, flag, source, definition or RNG mutation.');
    }
  assert.equal(configurations, 5_180);
  assert(accepted > 0 && rejected > 0);
  t.diagnostic(JSON.stringify({ configurations, acceptedPlans: accepted, rejectedChoices: rejected }));
});

test('any-card requires exactly one if present; specific hidden selection may fail to find even if every card matches', () => {
  for (const category of ['item', 'supporter']) {
    const ctx = context(['water', 'water'], 1, category);
    rejects(() => planPrizeExchange(ctx, action(), []));
    const specific = action({ kind: 'pokemon', stages: ['basic'] }, true);
    const zero = planPrizeExchange(ctx, specific, []);
    assert.deepEqual(zero.prizesAfter, own(ctx).prizes);
    assert(!zero.prizesAfter.includes('source'));
    assert.deepEqual(own(ctx).resolving, ['source'], 'Normal source discard is host finalization, not this planner.');
    assert.equal(prizeExchangeWindow(ctx, specific).bounds.minimum, 0);
    const union = action({ anyOf: [{ kind: 'pokemon' }, { kind: 'trainer' }] });
    assert.equal(planPrizeExchange(ctx, union, []).selected.length, 0, 'Do not infer literal any from a covering union.');
  }
  const empty = context([]);
  assert.deepEqual(planPrizeExchange(empty, action(), []), {
    owner: 0, sourceId: 'source', window: [], selected: [], prizesAfter: [],
  });
  const noMatch = context(['energy']);
  const a = action({ kind: 'pokemon', stages: ['basic'] });
  assert.deepEqual(prizeExchangeWindow(noMatch, a).bounds.minimum, 0);
  assert.deepEqual(planPrizeExchange(noMatch, a, []).prizesAfter, ['prize:0']);
});

test('selectors read printed HP/types/card identity, never live state, attached special Energy provision or opponent card faces', () => {
  const ctx = context(['water', 'fire', 'special', 'energy', 'item']);
  let calls = 0;
  for (const [record, key] of [
    [ctx, 'effectivePokemon'], [ctx.state, 'current'], [ctx.state, 'rng'], [ctx.state, 'battleHistory'],
    [ctx.definitions, 'uninspected:foreign'], [ctx.definitions, 'uninspected:hand'],
  ]) Object.defineProperty(record, key, {
    enumerable: true, get() { calls++; throw new Error(`Unrequested ${key}`); },
  });
  assert.deepEqual(prizeExchangeWindow(ctx, action({ kind: 'pokemon', printedHpAtMost: 70 })).eligible, ['prize:0']);
  assert.deepEqual(prizeExchangeWindow(ctx, action({ kind: 'pokemon', types: ['Fire'] })).eligible, ['prize:1']);
  assert.deepEqual(prizeExchangeWindow(ctx, action({ kind: 'energy', category: 'basic', types: ['Water'] })).eligible, ['prize:3']);
  assert.deepEqual(prizeExchangeWindow(ctx, action({ kind: 'energy', category: 'special' })).eligible, ['prize:2']);
  assert.deepEqual(prizeExchangeWindow(ctx, action({ kind: 'trainer', nameContains: 'item' })).eligible, ['prize:4']);
  assert.equal(calls, 0);
  rejects(() => assertPrizeExchangeAction(action({ kind: 'pokemon', currentHpAtMost: 70 })));
  rejects(() => assertPrizeExchangeAction(action({ kind: 'energy', category: 'special', types: ['Water'] })));
});

test('source must be the actual originally owned physical resolving Item/Supporter, not another zone or Trainer category', () => {
  for (const category of ['tool', 'stadium']) rejects(() => prizeExchangeWindow(context([], 0, category), action()));
  for (const token of ['water', 'energy']) {
    const ctx = context();
    ctx.state.cards.source.definitionId = `fixture:${token}`;
    rejects(() => prizeExchangeWindow(ctx, action()));
  }
  for (const zone of ['deck', 'hand', 'discard', 'lost', 'prizes']) {
    const ctx = context();
    own(ctx).resolving = []; own(ctx)[zone].push('source');
    rejects(() => prizeExchangeWindow(ctx, action()));
  }
  const foreign = context(); foreign.source.owner = 1;
  rejects(() => prizeExchangeWindow(foreign, action()));
  const wrongOriginalOwner = context(); wrongOriginalOwner.state.cards.source.owner = 1;
  rejects(() => prizeExchangeWindow(wrongOriginalOwner, action()));
  const absent = context(); own(absent).resolving = [];
  rejects(() => prizeExchangeWindow(absent, action()));
});

test('physical zone audit includes both players, stacks, Energy, Tools and shared Stadium without reading their card faces', () => {
  const ctx = context(), ownPlayer = own(ctx), other = ctx.state.players[1];
  const makeMon = (prefix, owner) => {
    const mon = { stack: [], energy: [], tools: [] };
    for (const zone of ['stack', 'energy', 'tools']) {
      const id = `${prefix}:${zone}`;
      addCard(ctx, id, `uninspected:${id}`, owner); mon[zone].push(id);
    }
    return mon;
  };
  ownPlayer.active = makeMon('active', 0);
  ownPlayer.bench.push(makeMon('bench', 0));
  other.active = makeMon('foreign-active', 1);
  other.bench.push(makeMon('foreign-bench', 1));
  for (const owner of [0, 1]) {
    addCard(ctx, `stadium:${owner}`, 'uninspected:stadium', owner);
    ctx.state.stadium = `stadium:${owner}`;
    const saved = planPrizeExchange(ctx, action(), ['prize:1']);
    assert.equal(assertPrizeExchangePlan(ctx, action(), saved), saved);
  }
  const bad = clone(ctx); bad.state.stadium = false;
  rejects(() => prizeExchangeWindow(bad, action()));
  const emptyStack = clone(ctx); emptyStack.state.players[0].active.stack = [];
  rejects(() => prizeExchangeWindow(emptyStack, action()));
  for (const path of [
    ['state', 'players', 0, 'hand'], ['state', 'players', 0, 'resolving'],
    ['state', 'players', 1, 'deck'], ['state', 'players', 0, 'active', 'stack'],
    ['state', 'players', 0, 'bench', 0, 'energy'], ['state', 'players', 1, 'active', 'tools'],
  ]) {
    const duplicate = clone(ctx); getAt(duplicate, path).push('prize:0');
    rejects(() => prizeExchangeWindow(duplicate, action()));
  }
  const stadiumDuplicate = clone(ctx); stadiumDuplicate.state.stadium = 'prize:0';
  rejects(() => prizeExchangeWindow(stadiumDuplicate, action()));
  const duplicatePrize = context(); own(duplicatePrize).prizes.push('prize:0');
  rejects(() => prizeExchangeWindow(duplicatePrize, action()));
});

test('context requires real owners, maps, players, identity and normalized source/Prize definitions', () => {
  const changes = [
    [[], null], [['source'], null], [['state'], null], [['definitions'], null], [['state', 'cards'], []],
    [['source', 'owner'], 2], [['source', 'owner'], '0'], [['source', 'instanceId'], ''],
    [['state', 'players'], []], [['state', 'players'], [{}]], [['state', 'players'], [{}, {}, {}]],
    [['state', 'players', 0], null], [['state', 'players', 0, 'bench'], null],
    [['state', 'cards', 'source', 'instanceId'], 'alias'], [['state', 'cards', 'source', 'owner'], 2],
    [['state', 'cards', 'prize:0', 'owner'], 1], [['state', 'cards', 'prize:0', 'definitionId'], ''],
    [['state', 'cards', 'prize:0', 'printingId'], ''], [['state', 'cards', 'prize:0'], null],
    [['definitions', 'fixture:water'], null], [['definitions', 'fixture:water', 'mechanics', 'hp'], 65],
  ];
  for (const [path, value] of changes) {
    let ctx = context();
    if (!path.length) ctx = value; else setAt(ctx, path, value);
    rejects(() => prizeExchangeWindow(ctx, action()));
  }
  for (const path of [
    ['source', 'owner'], ['source', 'instanceId'], ['state', 'cards', 'source', 'definitionId'],
    ['state', 'cards', 'prize:0'], ['definitions', 'fixture:water'],
    ['state', 'players', 0, 'prizes'], ['state', 'stadium'],
  ]) {
    const ctx = context(); const parent = getAt(ctx, path.slice(0, -1)); delete parent[path.at(-1)];
    rejects(() => prizeExchangeWindow(ctx, action()));
  }
  const alias = context(); alias.definitions['fixture:water'] = pokemon('different', 60, ['Water']);
  rejects(() => prizeExchangeWindow(alias, action()));
  const unknownPhysicalField = context(); unknownPhysicalField.state.cards.source.currentHp = 10;
  rejects(() => prizeExchangeWindow(unknownPhysicalField, action()));
  const optionalPrinting = context(); delete optionalPrinting.state.cards.source.printingId;
  assert.equal(prizeExchangeWindow(optionalPrinting, action()).sourceId, 'source');
});

test('required context access is own enumerable plain data; getters and inherited defaults are never called', () => {
  const paths = [
    ['source'], ['state'], ['definitions'], ['source', 'owner'], ['source', 'instanceId'],
    ['state', 'cards'], ['state', 'players'], ['state', 'stadium'], ['state', 'cards', 'source'],
    ['state', 'cards', 'source', 'owner'], ['definitions', 'fixture:water'],
    ['definitions', 'fixture:water', 'mechanics', 'types'],
    ['state', 'players', 0, 'prizes'], ['state', 'players', 0, 'resolving'],
    ['state', 'players', 1, 'deck'], ['state', 'players', 0, 'active'],
  ];
  let calls = 0;
  for (const path of paths) for (const mode of ['getter', 'hidden', 'inherited']) {
    const ctx = context(), parentPath = path.slice(0, -1), parent = getAt(ctx, parentPath), key = path.at(-1);
    const value = parent[key];
    if (mode === 'getter') Object.defineProperty(parent, key, {
      enumerable: true, configurable: true, get() { calls++; throw new Error('Context getter must not run.'); },
    });
    else if (mode === 'hidden') Object.defineProperty(parent, key, { value, enumerable: false });
    else {
      const inherited = Object.create({ [key]: value });
      for (const [name, item] of Object.entries(parent)) if (name !== key) inherited[name] = item;
      if (parentPath.length) setAt(ctx, parentPath, inherited);
      else Object.setPrototypeOf(ctx, { [key]: value }), delete ctx[key];
    }
    rejects(() => prizeExchangeWindow(ctx, action()));
  }
  assert.equal(calls, 0);
  const nullProto = context();
  nullProto.source = Object.assign(Object.create(null), nullProto.source);
  nullProto.state.cards = Object.assign(Object.create(null), nullProto.state.cards);
  nullProto.definitions = Object.assign(Object.create(null), nullProto.definitions);
  assert.equal(prizeExchangeWindow(nullProto, action()).owner, 0);
});

test('selection accepts only zero/one unique eligible physical IDs, not aliases, source, foreign cards or implicit auto-choice', () => {
  const ctx = context(), a = action({ kind: 'pokemon', stages: ['basic'] });
  for (const chosen of [undefined, null, false, '', 'prize:0', {}, [0], [''], ['fixture:water'],
    ['source'], ['foreign'], ['old-hand'], ['prize:1'], ['prize:0', 'prize:0'], ['prize:0', 'prize:1'],
  ]) rejects(() => planPrizeExchange(ctx, a, chosen));
  const duplicateResolving = context(); own(duplicateResolving).resolving.push('source');
  rejects(() => planPrizeExchange(duplicateResolving, a, []));
  const prototypeNames = context(['water', 'fire', 'energy'], 0, 'item', ['__proto__', 'constructor', 'toString']);
  for (const id of ['__proto__', 'constructor', 'toString'])
    assert.equal(planPrizeExchange(prototypeNames, action(), [id]).selected[0], id);
});

test('saved plans are recomputed against the original context, not their own claimed window or a shuffled/part-applied state', () => {
  const ctx = context(), a = action(), original = planPrizeExchange(ctx, a, ['prize:1']);
  const before = clone({ ctx, a, original });
  assert.equal(assertPrizeExchangePlan(ctx, a, original), original);
  const mutations = [
    (p) => { p.owner = 1; }, (p) => { p.sourceId = 'other-source'; },
    (p) => { p.window.reverse(); }, (p) => { p.window.pop(); },
    (p) => { p.prizesAfter.reverse(); }, (p) => { p.prizesAfter.pop(); },
    (p) => { p.prizesAfter[1] = 'prize:1'; }, (p) => { p.prizesAfter[0] = 'source'; },
    (p) => { p.selected = ['prize:0']; },
  ];
  for (const mutate of mutations) {
    const forged = clone(original); mutate(forged);
    rejects(() => assertPrizeExchangePlan(ctx, a, forged));
  }
  const changedContext = clone(ctx); own(changedContext).prizes.reverse();
  rejects(() => assertPrizeExchangePlan(changedContext, a, original));
  const applied = clone(ctx);
  own(applied).prizes = [...original.prizesAfter]; own(applied).resolving = [];
  own(applied).hand.push(...original.selected);
  rejects(() => assertPrizeExchangePlan(applied, a, original));
  assert.deepEqual({ ctx, a, original }, before);
  assert(!Object.isFrozen(original)); assert(!Object.isFrozen(original.window));
  const detached = prizeExchangeWindow(ctx, a); detached.window.reverse(); detached.eligible.pop();
  assert.deepEqual(ctx, before.ctx);
});

test('action and plan schema/shape reject unknown policy flags, runtime selectors, alternate zones and missing fields', () => {
  const invalidActions = [
    null, false, 0, '', [], {}, action({ kind: 'unknown' }), action({ kind: 'any', approved: true }),
    { ...action(), op: 'cards' }, { ...action(), revealSelected: 1 },
    ...['quantity', 'lookTop', 'side', 'sourceId', 'from', 'to', 'shuffle', 'beforeHand', 'countAsPrize', 'approved']
      .map((key) => ({ ...action(), [key]: 1 })),
    ...Object.keys(action()).map((key) => { const copy = action(); delete copy[key]; return copy; }),
  ];
  for (const a of invalidActions) {
    assert.equal(schemaAction(a), false);
    rejects(() => assertPrizeExchangeAction(a));
    rejects(() => prizeExchangeWindow(context(), a));
  }
  const ctx = context(), a = action(), valid = planPrizeExchange(ctx, a, ['prize:0']);
  const invalidPlans = [
    null, false, 0, '', [], {}, { ...valid, owner: 2 }, { ...valid, sourceId: '' },
    ...Object.keys(valid).map((key) => { const copy = clone(valid); delete copy[key]; return copy; }),
    ...['actor', 'revealSelected', 'rng', 'shuffleOrder', 'beforeHand', 'needsRuling', 'countAsPrize', 'approved']
      .map((key) => ({ ...clone(valid), [key]: true })),
    { ...valid, selected: ['prize:0', 'prize:1'] }, { ...valid, window: ['prize:0', 'prize:0'] },
    { ...valid, prizesAfter: ['source', 'source'] }, { ...valid, selected: [1] },
  ];
  for (const plan of invalidPlans) {
    assert.equal(schemaPlan(plan), false);
    rejects(() => assertPrizeExchangePlan(ctx, a, plan));
  }
  const nullProto = Object.assign(Object.create(null), action());
  assert.equal(assertPrizeExchangeAction(nullProto), nullProto);
  assert.equal(assertPrizeExchangePlan(ctx, nullProto, Object.assign(Object.create(null), valid)).sourceId, 'source');
});

test('strict JSON gates reject executable/scalar instances, symbol/hidden fields, sparse arrays and data/prototype cycles', () => {
  const invalid = [
    undefined, NaN, Infinity, -Infinity, 1n, Symbol('action'), () => action(), new Date(), new Map(),
    Object.create(action()), Object.assign(new (class Action {})(), action()),
  ];
  let calls = 0;
  for (const key of ['op', 'selector', 'revealSelected', 'unknown']) {
    const getter = action(); Object.defineProperty(getter, key, {
      enumerable: true, get() { calls++; throw new Error('Action getter'); },
    }); invalid.push(getter);
    const hidden = action(); Object.defineProperty(hidden, key, { value: true, enumerable: false }); invalid.push(hidden);
  }
  const symbol = action(); symbol[Symbol('approval')] = true; invalid.push(symbol);
  const cyclic = action(); cyclic.selector = cyclic; invalid.push(cyclic);
  const arrayCycle = []; arrayCycle.push(arrayCycle); invalid.push(action({ anyOf: arrayCycle }));
  const sparse = new Array(2); sparse[1] = { kind: 'pokemon' }; invalid.push(action({ anyOf: sparse }));
  const sparseExtra = new Array(1); sparseExtra.extra = {}; invalid.push(action({ anyOf: sparseExtra }));
  const indexGetter = [{ kind: 'pokemon' }, { kind: 'trainer' }];
  Object.defineProperty(indexGetter, '0', { enumerable: true, get() { calls++; throw new Error('Selector index getter'); } });
  invalid.push(action({ anyOf: indexGetter }));
  const hiddenIndex = [{ kind: 'pokemon' }, { kind: 'trainer' }];
  Object.defineProperty(hiddenIndex, '0', { value: { kind: 'pokemon' }, enumerable: false });
  invalid.push(action({ anyOf: hiddenIndex }));
  invalid.push(action({ anyOf: new (class Selectors extends Array {})({ kind: 'pokemon' }, { kind: 'trainer' }) }));
  const prototype = {}, protoCycle = Object.assign(Object.create(prototype), action());
  prototype.back = protoCycle; invalid.push(protoCycle);
  for (const a of invalid) rejects(() => assertPrizeExchangeAction(a));

  const ctx = context(), a = action({ kind: 'pokemon' });
  const choices = [new Array(1), Object.assign(['prize:0'], { extra: true })];
  const chosenCycle = []; chosenCycle.push(chosenCycle); choices.push(chosenCycle);
  const sym = ['prize:0']; sym[Symbol('extra')] = true; choices.push(sym);
  for (const chosen of choices) rejects(() => planPrizeExchange(ctx, a, chosen));
  const saved = planPrizeExchange(ctx, a, []); saved.prizesAfter = saved;
  rejects(() => assertPrizeExchangePlan(ctx, a, saved));
  const cardCycle = context(); cardCycle.state.cards.source.definitionId = cardCycle.state.cards.source;
  rejects(() => prizeExchangeWindow(cardCycle, action()));
  const definitionCycle = context(); definitionCycle.definitions['fixture:water'].mechanics.effects.push(definitionCycle.definitions['fixture:water']);
  rejects(() => prizeExchangeWindow(definitionCycle, action()));
  assert.equal(calls, 0);
  const shared = { kind: 'pokemon' };
  assert.equal(assertPrizeExchangeAction(action({ anyOf: [shared, shared] })).op, 'exchangePrizes');
});

test('missing selector kinds cannot reach an Object.prototype getter, even for a valid anyOf selector', () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'kind');
  const ctx = context(), valid = action({ anyOf: [{ kind: 'pokemon' }, { kind: 'trainer' }] });
  let calls = 0, result, caught;
  Object.defineProperty(Object.prototype, 'kind', {
    configurable: true, get() { calls++; throw new Error('No inherited selector kind.'); },
    // Ajv builds ordinary evaluated-property metadata with assignments. Permit
    // creation of an OWN metadata field: this probe targets inherited READS,
    // not unrelated write denial caused by a getter-only ambient prototype.
    set(value) { Object.defineProperty(this, 'kind', { value, writable: true, configurable: true, enumerable: true }); },
  });
  try {
    try { assertPrizeExchangeAction(action({})); } catch (error) { caught = error; }
    result = prizeExchangeWindow(ctx, valid);
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'kind', original);
    else delete Object.prototype.kind;
  }
  assert(caught instanceof TypeError);
  assert.equal(calls, 0);
  assert.deepEqual(result.eligible, ['prize:0', 'prize:1']);
});

test('planner has no movement, disclosure, shuffle, Prize-award policy or E-31 decision side effect', () => {
  const ctx = context(['water']), a = action({ kind: 'pokemon', stages: ['basic'] }, true);
  const before = clone({ ctx, a });
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('Prize exchange plans do not randomize.'); };
  let plan;
  try { plan = planPrizeExchange(ctx, a, ['prize:0']); }
  finally { Math.random = originalRandom; }
  assert.deepEqual({ ctx, a }, before);
  assertConservation(plan);
  assert.deepEqual(Object.keys(plan).sort(), ['owner', 'prizesAfter', 'selected', 'sourceId', 'window']);
  assert.deepEqual(own(ctx).prizes, ['prize:0']);
  assert.deepEqual(own(ctx).resolving, ['source']);
  assert(!Object.isFrozen(ctx)); assert(!Object.isFrozen(plan)); assert(!Object.isFrozen(plan.prizesAfter));
  assert.equal(new PrizeExchangeError('test', 'test').ruleId, 'effects.prize-exchange');
});
