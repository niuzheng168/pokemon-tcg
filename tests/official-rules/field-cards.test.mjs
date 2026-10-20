// Pure public field-card plans and source matching; synthetic definitions only.
// No real-card approval, OfficialGame action, permission inference or RNG.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  FieldCardError, FIELD_CARD_SOURCES, assertDiscardStadiumAction, assertStadiumProtection,
  stadiumWindow, canUseDiscardStadium, planDiscardStadium, matchesStadiumProtection,
} from '../../public/rules/field-cards.js';
import * as generated from '../../public/rules/schema-validators.js';

const clone = (value) => structuredClone(value);
const evidence = [{
  sourceId: 'fixture:field-card', kind: 'official-card', url: 'https://www.pokemon.cn/',
  locator: 'TEST ONLY: synthetic printed card and Prism marker, not actual approval.',
}];
const selector = (extra = {}) => ({ kind: 'trainer', categories: ['stadium'], ...extra });
const action = (extra = {}) => ({ op: 'discardStadium', side: 'either', selector: selector(), ...extra });
const protection = (extra = {}) => ({
  op: 'stadiumProtection', scope: 'self', channel: 'effects', useRule: 'ordinary',
  from: 'all', categories: ['attack', 'ability', 'trainer', 'energy'], ...extra,
});
function printed(id = 'fixture:stadium', category = 'stadium', prism = false) {
  return {
    schemaVersion: '1.0.0', definitionId: id, ruleset: { region: 'CN', version: 'V20261019' },
    name: '测试 雷霆 场地◇', nameKey: id, kind: 'trainer', mechanics: { category, effects: [] },
    sourceOfTruth: clone(evidence), implementation: { status: 'verified', testIds: ['fixture:test'] },
    deckLimits: { sameName: prism ? 1 : 4, groups: [] },
    ...(prism ? { prismStar: { sourceOfTruth: clone(evidence) } } : {}),
  };
}
function context({ stadiumOwner = 0, sourceOwner = stadiumOwner, prism = false, present = true } = {}) {
  const d = printed('fixture:stadium', 'stadium', prism);
  return {
    source: { instanceId: 'physical:stadium', owner: sourceOwner, cardOwner: stadiumOwner, category: 'trainer', origin: 'field' },
    state: {
      stadium: present ? 'physical:stadium' : null,
      cards: {
        'physical:stadium': { instanceId: 'physical:stadium', owner: stadiumOwner, definitionId: d.definitionId },
      },
    },
    definitions: { [d.definitionId]: d },
  };
}
function incoming(ctx, category, user, trainerCategory = 'item', origin = 'hand', cardOwner = user) {
  if (category !== 'trainer') return { category, owner: user };
  const d = printed(`fixture:incoming-${trainerCategory}`, trainerCategory);
  ctx.state.cards['physical:incoming'] = {
    instanceId: 'physical:incoming', owner: cardOwner, definitionId: d.definitionId,
  };
  ctx.definitions[d.definitionId] = d;
  return { category, owner: user, cardOwner, instanceId: 'physical:incoming', origin };
}
const target = (owner) => ({
  kind: 'stadium', instanceId: 'physical:stadium', owner, definitionId: 'fixture:stadium',
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
function subsets(items) {
  return Array.from({ length: 2 ** items.length - 1 }, (_v, index) =>
    items.filter((_item, bit) => (index + 1) & (1 << bit)));
}

// Read-only standalone compilation; no generator or shared-file changes.
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
await register('field-cards');
const schema = loaded.get('urn:pokemon-tcg:field-cards:1.0.0');
const schemaAction = ajv.getSchema(schema.$id);
const schemaProtection = ajv.getSchema(`${schema.$id}#/$defs/protection`);
const schemaTarget = ajv.getSchema(`${schema.$id}#/$defs/target`);
const schemaPlan = ajv.getSchema(`${schema.$id}#/$defs/plan`);
function checkAction(value, expected) {
  assert.equal(schemaAction(value), expected);
  if (expected) assert.equal(assertDiscardStadiumAction(value), value);
  else rejects(() => assertDiscardStadiumAction(value));
}
function checkProtection(value, expected) {
  assert.equal(schemaProtection(value), expected);
  if (expected) assert.equal(assertStadiumProtection(value), value);
  else rejects(() => assertStadiumProtection(value));
}

test('schema pins Stadium as a non-Pokemon field-card subject, strict printed selector and correct CN software boundaries', () => {
  assert.equal(schema.$id, 'urn:pokemon-tcg:field-cards:1.0.0'); assert.equal(schema.$ref, '#/$defs/action');
  assert.equal(schema.$defs.selector.allOf[0].$ref, 'urn:pokemon-tcg:card-selector:1.0.0');
  assert.deepEqual(schema.$defs.selector.allOf[1].properties.categories.const, ['stadium']);
  assert.match(schema.$comment, /I\.B-04 PDF p12–13.*II\.C-01 p25–26.*II\.D-04 p43–44.*II\.E-29 p68–69/);
  assert.match(schema.$comment, /NOT a Pokemon.*timed\/ongoing/);
  assert.deepEqual(FIELD_CARD_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'I.B-04', pdfPages: [12, 13] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.C-01', pdfPages: [25, 26] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.D-04', pdfPages: [43, 44] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-29', pdfPages: [68, 69] },
  ]);
  assert(Object.isFrozen(FIELD_CARD_SOURCES));
  for (const source of FIELD_CARD_SOURCES) { assert(Object.isFrozen(source)); assert(Object.isFrozen(source.pdfPages)); }
  const error = new FieldCardError('fixture', 'fixture');
  assert(error instanceof TypeError); assert.equal(error.name, 'FieldCardError'); assert.equal(error.code, 'fixture');
});

test('independent bounded selection/owner/selector/blocked oracle delegates explicit Prism routing, never name/symbol inference', (t) => {
  const selectors = [
    [selector(), true], [selector({ nameKeys: ['fixture:stadium'] }), true],
    [selector({ nameKeys: ['fixture:missing'] }), false], [selector({ nameContains: '雷霆' }), true],
    [selector({ nameContains: '不存在' }), false],
    [selector({ nameKeys: ['fixture:stadium'], nameContains: '雷霆' }), true],
    [selector({ nameKeys: ['fixture:missing'], nameContains: '雷霆' }), false],
  ];
  let cases = 0;
  for (const stadiumOwner of [0, 1]) for (const sourceOwner of [0, 1]) for (const present of [false, true])
    for (const prism of [false, true]) for (const side of ['either', 'own', 'opponent'])
      for (const [s, printedMatch] of selectors) for (const blocked of [false, true]) {
        const ctx = freeze(context({ stadiumOwner, sourceOwner, present, prism })), a = freeze(action({ side, selector: s }));
        const before = clone({ ctx, a });
        const relative = side === 'either' || (side === 'own' ? stadiumOwner === sourceOwner : stadiumOwner !== sourceOwner);
        const eligible = present && relative && printedMatch, expectedTarget = eligible ? target(stadiumOwner) : null;
        assert.deepEqual(stadiumWindow(ctx, a), { target: expectedTarget });
        assert.equal(canUseDiscardStadium(ctx, a), eligible);
        const expected = {
          target: expectedTarget, destination: eligible && !blocked ? prism ? 'lost' : 'discard' : null,
          performed: eligible && !blocked,
        };
        const plan = planDiscardStadium(ctx, a, blocked);
        assert.deepEqual(plan, expected); assert.equal(schemaPlan(plan), true);
        if (expectedTarget) assert.equal(schemaTarget(expectedTarget), true);
        assert.deepEqual({ ctx, a }, before);
        cases++;
      }
  assert.equal(cases, 672);
  t.diagnostic(`${cases} independent candidate/plan cases, including blocked and explicit Prism routes.`);
  const prism = context({ prism: true }); prism.definitions['fixture:stadium'].name = '没有特殊符号的测试场地';
  assert.equal(planDiscardStadium(prism, action()).destination, 'lost');
  assert.equal(planDiscardStadium(context(), action()).destination, 'discard', 'A diamond in the name is not a Prism marker.');
});

// Expected predicate uses only independent table membership and physical holder
// equality. It never calls the production matcher, selector or source resolver.
function matchOracle(effect, holder, user, category, trainerCategory, origin) {
  if (!effect.categories.includes(category)) return false;
  if (effect.from === 'own' && user !== holder || effect.from === 'opponent' && user === holder) return false;
  if (category !== 'trainer') return true;
  if (effect.trainerCategories && !effect.trainerCategories.includes(trainerCategory)) return false;
  if (effect.trainerOrigins && !effect.trainerOrigins.includes(origin)) return false;
  return true;
}
test('independent ordinary/CN.E29 source oracle covers categories, all relative owners, printed Trainer categories and actual origins', (t) => {
  const sourceCategories = ['attack', 'ability', 'trainer', 'energy'];
  const trainerCategories = ['item', 'supporter', 'tool', 'stadium'], origins = ['hand', 'field', 'draw', 'prizes'];
  const categoryFilters = [undefined, ...trainerCategories.map((x) => [x]), trainerCategories];
  const originFilters = [undefined, ...origins.map((x) => [x]), origins];
  const effects = [];
  for (const categories of subsets(sourceCategories))
    for (const trainerCategories of categoryFilters) for (const trainerOrigins of originFilters) {
      if ((trainerCategories || trainerOrigins) && !categories.includes('trainer')) continue;
      effects.push(protection({ categories,
        ...(trainerCategories ? { trainerCategories } : {}), ...(trainerOrigins ? { trainerOrigins } : {}) }));
    }
  for (const trainerCategories of [['item'], ['supporter'], ['item', 'supporter'], ['supporter', 'item']])
    effects.push(protection({ useRule: 'CN.E29', categories: ['trainer'], trainerOrigins: ['hand'], trainerCategories }));
  const packets = [
    ...['attack', 'ability', 'energy'].map((category) => ({ category })),
    ...trainerCategories.flatMap((trainerCategory) => origins.map((origin) => ({ category: 'trainer', trainerCategory, origin }))),
  ];
  const probes = [];
  for (const holder of [0, 1]) for (const user of [0, 1]) for (const packet of packets) {
    const ctx = context({ stadiumOwner: holder });
    const physicalOwner = packet.trainerCategory === 'stadium' && packet.origin === 'field' ? 1 - user : user;
    const src = incoming(ctx, packet.category, user, packet.trainerCategory, packet.origin, physicalOwner);
    probes.push({ holder, user, packet, ctx: freeze(ctx), src: freeze(src), before: clone({ ctx, src }) });
  }
  let cases = 0, matched = 0; const started = performance.now();
  for (const effect of effects) for (const from of ['own', 'opponent', 'all']) {
    const e = freeze({ ...effect, from });
    for (const { holder, user, packet, ctx, src } of probes) {
        const expected = matchOracle(e, holder, user, packet.category, packet.trainerCategory, packet.origin);
        assert.equal(matchesStadiumProtection(ctx, e, src), expected);
        cases++; if (expected) matched++;
    }
  }
  for (const { ctx, src, before } of probes) assert.deepEqual({ ctx, src }, before);
  assert.equal(effects.length, 299); assert.equal(cases, 68172); assert(matched > 0 && matched < cases);
  t.diagnostic(`${effects.length} descriptors, ${cases} independent source matches; ${(performance.now() - started).toFixed(1)}ms.`);
});

test('shared Stadium incoming user is NOT its physical holder or the protecting provider owner', () => {
  for (const holder of [0, 1]) {
    const ctx = context({ stadiumOwner: holder });
    const src = incoming(ctx, 'trainer', 1 - holder, 'stadium', 'field', holder);
    const e = protection({ from: 'opponent', categories: ['trainer'], trainerCategories: ['stadium'], trainerOrigins: ['field'] });
    assert.equal(src.owner, 1 - ctx.source.owner); assert.equal(src.cardOwner, ctx.source.owner);
    assert.equal(matchesStadiumProtection(ctx, e, src), true);
    assert.equal(matchesStadiumProtection(ctx, { ...e, from: 'own' }, src), false);
    assert.equal(matchesStadiumProtection(ctx, { ...e, trainerCategories: ['item'] }, src), false);
    assert.equal(matchesStadiumProtection(ctx, { ...e, trainerOrigins: ['hand'] }, src), false);
  }
});

test('CN.E29 is a strict explicit class, not an inferred match or actual performed result; ordinary matches stay distinct', () => {
  const ctx = context(), src = incoming(ctx, 'trainer', 1, 'item', 'hand');
  const e = protection({ useRule: 'CN.E29', categories: ['trainer'], trainerOrigins: ['hand'], trainerCategories: ['item', 'supporter'] });
  assert.equal(matchesStadiumProtection(ctx, e, src), true);
  assert.equal(matchesStadiumProtection(ctx, { ...e, useRule: 'ordinary' }, src), true);
  assert.equal(canUseDiscardStadium(ctx, action()), true);
  assert.deepEqual(planDiscardStadium(ctx, action(), true), { target: target(0), destination: null, performed: false });
  assert.equal(matchesStadiumProtection(ctx, protection(), { category: 'rule', owner: 1 }), false);
});

test('requested data excludes Pokemon/effective/hidden zones, unneeded source origin/card identity and outside protection', () => {
  const ctx = context(), e = protection({ categories: ['attack', 'trainer'] }); let calls = 0;
  const poison = (record, key) => Object.defineProperty(record, key, {
    enumerable: true, configurable: true, get() { calls++; throw Error(`Unrequested ${key}`); },
  });
  for (const key of ['players', 'rng', 'current', 'ongoing', 'hp', 'types', 'counters', 'bench']) poison(ctx.state, key);
  for (const key of ['effectivePokemon', 'event', 'protection', 'hand', 'deck']) poison(ctx, key);
  poison(ctx.state.cards, 'hidden:physical'); poison(ctx.definitions, 'hidden:definition');
  const src = { owner: 1, category: 'attack' }; poison(src, 'instanceId'); poison(src, 'origin');
  assert.equal(matchesStadiumProtection(ctx, e, src), true);
  assert.equal(planDiscardStadium(ctx, action()).destination, 'discard');
  const trainer = incoming(ctx, 'trainer', 1); poison(trainer, 'origin');
  assert.equal(matchesStadiumProtection(ctx, e, trainer), true, 'No origin filter means no requested origin read.');
  const empty = context({ present: false }); poison(empty.state, 'cards'); poison(empty, 'definitions');
  assert.deepEqual(stadiumWindow(empty, action()), { target: null });
  assert.equal(calls, 0);
});

test('current provider must be this actual physical field Stadium; malformed providers/packets cannot forge self protection', () => {
  const e = protection(), src = { owner: 1, category: 'attack' };
  for (const patch of [
    { instanceId: 'foreign' }, { owner: 1 }, { category: 'ability' }, { origin: 'hand' }, { origin: 'prizes' },
  ]) {
    const ctx = context(); Object.assign(ctx.source, patch);
    rejects(() => matchesStadiumProtection(ctx, e, src));
  }
  rejects(() => matchesStadiumProtection(context({ present: false }), e, src));
  for (const value of [null, {}, { owner: 2, category: 'attack' }, { owner: '0', category: 'attack' },
    { owner: 0, category: 'unknown' }]) rejects(() => matchesStadiumProtection(context(), e, value));
  const ctx = context(), trainer = incoming(ctx, 'trainer', 1);
  for (const instanceId of ['', null]) rejects(() => matchesStadiumProtection(ctx, e, { ...trainer, instanceId }));
  for (const origin of [undefined, null, 'deck']) {
    const packet = { ...trainer, origin };
    if (origin === undefined) delete packet.origin;
    rejects(() => matchesStadiumProtection(ctx, protection({ trainerOrigins: ['hand'] }), packet));
  }
  const spoofed = clone(ctx);
  spoofed.definitions['fixture:incoming-item'] = {
    ...printed('fixture:incoming-item'), kind: 'energy', mechanics: { category: 'basic', baseUnits: [['Water']], effects: [] },
  };
  rejects(() => matchesStadiumProtection(spoofed, e, trainer));
});

test('static action and protection shapes reject unit/subject/timing extensions and unsupported CN.E29 domains', () => {
  for (const invalid of [
    null, [], false, 0, '', {}, action({ op: 'cards' }), action({ side: 'all' }),
    action({ selector: null }), action({ selector: { kind: 'any' } }), action({ selector: { kind: 'trainer' } }),
    action({ selector: selector({ categories: ['item'] }) }),
    action({ selector: selector({ categories: ['stadium', 'tool'] }) }),
    action({ selector: selector({ categories: ['stadium', 'stadium'] }) }),
    action({ selector: selector({ nameKeys: [] }) }), action({ selector: selector({ nameContains: '' }) }),
    action({ selector: selector({ currentHpAtMost: 20 }) }),
    ...['count', 'target', 'destination', 'blocked', 'scope', 'pokemonId', 'type', 'sourceOfTruth']
      .map((key) => action({ [key]: 1 })),
    ...Object.keys(action()).map((key) => { const a = action(); delete a[key]; return a; }),
  ]) checkAction(invalid, false);
  for (const invalid of [
    null, [], {}, protection({ op: 'protection' }), protection({ scope: 'own' }), protection({ channel: 'damage' }),
    protection({ useRule: 'inferred' }), protection({ from: 'either' }), protection({ categories: null }),
    protection({ categories: [] }), protection({ categories: ['rule'] }), protection({ categories: ['trainer', 'trainer'] }),
    protection({ categories: ['attack'], trainerOrigins: ['hand'] }),
    protection({ categories: ['attack'], trainerCategories: ['item'] }),
    protection({ trainerOrigins: [] }), protection({ trainerOrigins: ['deck'] }),
    protection({ trainerCategories: [] }), protection({ trainerCategories: ['item', 'item'] }),
    ...['type', 'activeOnly', 'sourceActive', 'duration', 'targetId', 'location', 'hp', 'counters', 'group']
      .map((key) => protection({ [key]: true })),
    ...Object.keys(protection()).map((key) => { const e = protection(); delete e[key]; return e; }),
    protection({ useRule: 'CN.E29' }),
    protection({ useRule: 'CN.E29', categories: ['attack'] }),
    protection({ useRule: 'CN.E29', categories: ['trainer'], trainerCategories: ['item'] }),
    protection({ useRule: 'CN.E29', categories: ['trainer'], trainerOrigins: ['hand'] }),
    protection({ useRule: 'CN.E29', categories: ['trainer'], trainerOrigins: ['field'], trainerCategories: ['item'] }),
    protection({ useRule: 'CN.E29', categories: ['trainer'], trainerOrigins: ['hand', 'field'], trainerCategories: ['item'] }),
    protection({ useRule: 'CN.E29', categories: ['trainer'], trainerOrigins: ['hand'], trainerCategories: ['tool'] }),
    protection({ useRule: 'CN.E29', categories: ['trainer'], trainerOrigins: ['hand'], trainerCategories: ['stadium'] }),
  ]) checkProtection(invalid, false);
  checkAction(action(), true); checkProtection(protection(), true);
  for (const blocked of [null, 0, 1, '', 'false', [], {}])
    rejects(() => planDiscardStadium(context({ present: false }), action(), blocked));
});

test('public physical identity and normalized Stadium definitions fail closed on corrupt owner/ID/category/mapping', () => {
  for (const [path, value] of [
    [['source'], null], [['source', 'owner'], 2], [['source', 'owner'], '0'],
    [['state'], []], [['state', 'stadium'], ''], [['state', 'stadium'], 0],
    [['state', 'cards'], null], [['state', 'cards', 'physical:stadium', 'instanceId'], 'foreign'],
    [['state', 'cards', 'physical:stadium', 'owner'], 2], [['state', 'cards', 'physical:stadium', 'definitionId'], ''],
    [['definitions'], null], [['definitions', 'fixture:stadium'], null],
    [['definitions', 'fixture:stadium', 'definitionId'], 'fixture:alias'],
    [['definitions', 'fixture:stadium', 'mechanics', 'category'], 'unknown'],
  ]) {
    const ctx = context(); setAt(ctx, path, value); rejects(() => stadiumWindow(ctx, action()));
  }
  for (const category of ['item', 'supporter', 'tool']) {
    const ctx = context(); ctx.definitions['fixture:stadium'].mechanics.category = category;
    rejects(() => stadiumWindow(ctx, action()));
  }
  const energy = context(); energy.definitions['fixture:stadium'] = {
    ...printed(), kind: 'energy', mechanics: { category: 'basic', baseUnits: [['Water']], effects: [] },
  };
  rejects(() => stadiumWindow(energy, action()));
});

test('required context fields use own enumerable descriptors without getter/inherited/hidden fallbacks', () => {
  let calls = 0;
  for (const path of [
    ['source'], ['source', 'owner'], ['state'], ['state', 'stadium'], ['state', 'cards'],
    ['state', 'cards', 'physical:stadium'], ['state', 'cards', 'physical:stadium', 'definitionId'],
    ['definitions'], ['definitions', 'fixture:stadium', 'mechanics', 'category'],
  ]) for (const mode of ['getter', 'hidden', 'missing', 'inherited']) {
    const ctx = context(), parentPath = path.slice(0, -1), parent = getAt(ctx, parentPath), key = path.at(-1), value = parent[key];
    if (mode === 'getter') Object.defineProperty(parent, key, { enumerable: true, get() { calls++; throw Error('getter'); } });
    else if (mode === 'hidden') Object.defineProperty(parent, key, { value, enumerable: false });
    else if (mode === 'missing') delete parent[key];
    else {
      const inherited = Object.assign(Object.create({ [key]: value }), parent); delete inherited[key];
      if (parentPath.length) setAt(ctx, parentPath, inherited);
      else { Object.setPrototypeOf(ctx, { [key]: value }); delete ctx[key]; }
    }
    rejects(() => stadiumWindow(ctx, action()));
  }
  assert.equal(calls, 0);
  const ctx = context(); ctx.source = Object.assign(Object.create(null), ctx.source);
  ctx.state.cards = Object.assign(Object.create(null), ctx.state.cards);
  ctx.definitions = Object.assign(Object.create(null), ctx.definitions);
  const a = Object.assign(Object.create(null), action()), e = Object.assign(Object.create(null), protection());
  assert.equal(assertDiscardStadiumAction(a), a); assert.equal(assertStadiumProtection(e), e);
  assert.equal(matchesStadiumProtection(ctx, e, { owner: 1, category: 'attack' }), true);
});

test('strict JSON rejects executable/hidden/symbol/prototype/cyclic descriptions and sparse/custom arrays without executing code', () => {
  let calls = 0;
  const poison = () => { calls++; throw Error('getter/toJSON'); };
  const invalid = [
    new Date(0), new Map(), Object.create(action()), Object.assign(new (class Effect {})(), protection()),
    undefined, NaN, Infinity, -Infinity, 1n, Symbol('field'), () => {},
  ];
  for (const value of invalid) {
    rejects(() => assertDiscardStadiumAction(value)); rejects(() => assertStadiumProtection(value));
  }
  for (const factory of [action, protection]) for (const mode of ['getter', 'hidden', 'symbol', 'cycle', 'toJSON']) {
    const value = factory();
    if (mode === 'getter') Object.defineProperty(value, 'extra', { enumerable: true, get: poison });
    else if (mode === 'hidden') Object.defineProperty(value, 'extra', { value: true });
    else if (mode === 'symbol') value[Symbol('extra')] = true;
    else if (mode === 'cycle') value.extra = value;
    else value.toJSON = poison;
    rejects(() => factory === action ? assertDiscardStadiumAction(value) : assertStadiumProtection(value));
  }
  const arrays = [new Array(1), new (class Types extends Array {})()];
  const disguised = new Array(1); disguised.extra = true; arrays.push(disguised);
  const hidden = ['trainer']; Object.defineProperty(hidden, '0', { enumerable: false }); arrays.push(hidden);
  const getter = ['trainer']; Object.defineProperty(getter, '0', { enumerable: true, get: poison }); arrays.push(getter);
  const symbol = []; symbol[Symbol('extra')] = true; arrays.push(symbol);
  const extra = []; extra.extra = true; arrays.push(extra);
  const nullProto = []; Object.setPrototypeOf(nullProto, null); arrays.push(nullProto);
  const cycle = []; cycle.push(cycle); arrays.push(cycle);
  for (const categories of arrays) {
    rejects(() => assertDiscardStadiumAction(action({ selector: selector({ categories }) })));
    rejects(() => assertStadiumProtection(protection({ categories })));
  }
  assert.equal(calls, 0);
});

test('target/plan schemas retain original physical owner and actual destination, not a Pokemon or a second move authority', () => {
  const valid = planDiscardStadium(context(), action()); assert.equal(schemaPlan(valid), true);
  for (const value of [
    null, [], {}, { ...valid, destination: 'hand' }, { ...valid, performed: 1 },
    { ...valid, target: null }, { ...valid, performed: false }, { ...valid, destination: null },
    { ...valid, extra: true }, { ...valid, target: { ...valid.target, kind: 'pokemon' } },
    { ...valid, target: { ...valid.target, owner: 2 } },
    { ...valid, target: { ...valid.target, counters: 1 } },
    ...Object.keys(valid).map((key) => { const p = clone(valid); delete p[key]; return p; }),
    ...Object.keys(valid.target).map((key) => { const p = clone(valid); delete p.target[key]; return p; }),
  ]) assert.equal(schemaPlan(value), false);
  assert.equal(schemaPlan({ target: null, destination: null, performed: false }), true);
  assert.equal(schemaPlan({ target: target(1), destination: null, performed: false }), true);
  const ctx = context(), a = action(), before = clone({ ctx, a }), random = Math.random;
  let window, plan;
  Math.random = () => { throw Error('No field-card RNG.'); };
  try { window = stadiumWindow(ctx, a); plan = planDiscardStadium(ctx, a); }
  finally { Math.random = random; }
  for (const value of [ctx, a, ctx.definitions, window.target, plan, plan.target]) assert(!Object.isFrozen(value));
  window.target.owner = 1; plan.target.instanceId = 'changed';
  assert.deepEqual({ ctx, a }, before);
});

test('parent generated action/protection schemas agree with standalone reviewed roots without running a generator', () => {
  assert.equal(typeof generated.validateDiscardStadiumAction, 'function');
  assert.equal(typeof generated.validateStadiumProtection, 'function');
  for (const a of [action(), action({ side: 'own' }), action({ side: 'opponent' }), action({ side: 'all' }),
    action({ selector: { kind: 'trainer' } }), action({ selector: selector({ categories: ['stadium', 'tool'] }) })])
    assert.equal(generated.validateDiscardStadiumAction(a), schemaAction(a));
  for (const e of [protection(), protection({ scope: 'all' }), protection({ channel: 'damage' }),
    protection({ useRule: 'CN.E29' }),
    protection({ useRule: 'CN.E29', categories: ['trainer'], trainerOrigins: ['hand'], trainerCategories: ['item', 'supporter'] })])
    assert.equal(generated.validateStadiumProtection(e), schemaProtection(e));
});
