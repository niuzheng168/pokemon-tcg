import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { assertPrismStarRule, discardDestination } from '../../public/rules/discard-policy.js';
import { validatePrismStarRule } from '../../public/rules/schema-validators.js';

// No real card admission: this evidence cites the generic archived rule only.
const evidence = (extra = {}) => ({
  sourceId: 'CN-formats-extra', kind: 'official-rule',
  url: 'https://www.pokemon.cn/tcg-rules-regulation-extra/', locator: '棱镜之星',
  ...extra,
});
const rule = () => ({ sourceOfTruth: [evidence()] });
const definition = (kind = 'pokemon', prism = true) => ({
  kind, name: 'TEST ONLY: not an approved printing', deckLimits: { sameName: prism ? 1 : 4, groups: [] },
  mechanics: kind === 'pokemon' ? { stage: 'basic', ruleBox: true, hp: 100 } :
    kind === 'energy' ? { category: 'special' } : { category: 'stadium' },
  ...(prism ? { prismStar: rule() } : {}),
});
const rejectedRule = (value) => assert.throws(() => assertPrismStarRule(value), TypeError);
const rejectedDefinition = (value) => assert.throws(() => discardDestination(value), TypeError);

// Independent declarative oracle: compile the actual existing evidence schema,
// not another imperative validator and not this module's validation result.
const cardSchema = JSON.parse(await readFile(new URL('../../schemas/card-definition.schema.json', import.meta.url), 'utf8'));
const schemaRule = new Ajv2020({ strict: true, allErrors: true }).compile({
  $schema: cardSchema.$schema,
  $defs: Object.fromEntries(['id', 'text', 'evidence', 'evidenceList', 'libraryEvidence', 'cardEvidenceList', 'prismStarRule']
    .map((key) => [key, cardSchema.$defs[key]])),
  $ref: '#/$defs/prismStarRule',
});

function nullRecords(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(nullRecords);
  return Object.assign(Object.create(null),
    Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, nullRecords(item)])));
}

function unchanged(...roots) {
  const saved = new Map();
  function remember(value) {
    if (!value || typeof value !== 'object' || saved.has(value)) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    saved.set(value, {
      descriptors, prototype: Object.getPrototypeOf(value), extensible: Object.isExtensible(value),
    });
    for (const descriptor of Object.values(descriptors))
      if (Object.hasOwn(descriptor, 'value')) remember(descriptor.value);
  }
  roots.forEach(remember);
  return () => {
    for (const [value, snapshot] of saved) {
      assert.equal(Object.getPrototypeOf(value), snapshot.prototype);
      assert.equal(Object.isExtensible(value), snapshot.extensible);
      assert.deepEqual(Reflect.ownKeys(value), Reflect.ownKeys(snapshot.descriptors));
      for (const key of Reflect.ownKeys(snapshot.descriptors)) {
        const before = snapshot.descriptors[key], after = Object.getOwnPropertyDescriptor(value, key);
        assert.deepEqual(Object.keys(after), Object.keys(before));
        for (const property of Object.keys(before)) assert.equal(after[property], before[property]);
      }
    }
  };
}

test('explicit contract oracle distinguishes ordinary and Prism Star Pokémon, Trainer and Energy', () => {
  const cases = [
    { kind: 'pokemon', prism: false, expected: 'discard' },
    { kind: 'trainer', prism: false, expected: 'discard' },
    { kind: 'energy', prism: false, expected: 'discard' },
    { kind: 'pokemon', prism: true, expected: 'lost' },
    { kind: 'trainer', prism: true, expected: 'lost' },
    { kind: 'energy', prism: true, expected: 'lost' },
  ];
  for (const { kind, prism, expected } of cases) {
    const input = definition(kind, prism), check = unchanged(input);
    assert.equal(discardDestination(input), expected);
    assert.equal(discardDestination(nullRecords(input)), expected);
    check();
  }
});

test('no flag means ordinary discard, never inferred from name, diamond, same-name limit or a runtime zone', () => {
  for (const kind of ['pokemon', 'trainer', 'energy']) {
    const input = definition(kind, false);
    Object.assign(input, { name: '测试◇棱镜之星', nameKey: 'PRISM-STAR', zone: 'lost', currentHp: 0 });
    input.deckLimits.sameName = 1;
    assert.equal(discardDestination(input), 'discard');
  }
  assert.equal(discardDestination({}), 'discard', 'This is not whole-CardDefinition validation.');
  assert.equal(discardDestination(Object.create(null)), 'discard');
});

test('ordinary fast path never reads or enumerates definition fields beyond the optional root flag', () => {
  let reads = 0;
  const input = {};
  for (const key of ['kind', 'name', 'deckLimits', 'mechanics', 'hp', 'currentHp', 'zone', 'sourceOfTruth'])
    Object.defineProperty(input, key, { enumerable: true, get() { reads++; throw new Error(key); } });
  input.self = input;
  const protectedInput = new Proxy(input, {
    get() { reads++; throw new Error('property read'); },
    ownKeys() { throw new Error('whole-definition scan'); },
  });
  assert.equal(discardDestination(protectedInput), 'discard');
  assert.equal(reads, 0);
});

test('Prism Star reads only necessary printed fields, never HP, runtime effects, groups or whole static records', () => {
  let reads = 0;
  const opaque = (value) => new Proxy(value, {
    get() { reads++; throw new Error('property read'); },
    ownKeys() { throw new Error('unnecessary record scan'); },
  });
  for (const kind of ['pokemon', 'trainer', 'energy']) {
    const input = definition(kind);
    for (const key of ['hp', 'currentHp', 'zone', 'runtime', 'sourceOfTruth', 'name'])
      Object.defineProperty(input, key, { enumerable: true, get() { reads++; throw new Error(key); } });
    Object.defineProperty(input.deckLimits, 'groups', { get() { reads++; throw new Error('groups'); } });
    Object.defineProperty(input.mechanics, 'hp', { get() { reads++; throw new Error('printed HP'); } });
    if (kind === 'trainer') Object.defineProperty(input, 'mechanics', {
      get() { reads++; throw new Error('Trainer mechanics are irrelevant to destination'); },
    });
    else input.mechanics = opaque(input.mechanics);
    input.deckLimits = opaque(input.deckLimits);
    assert.equal(discardDestination(opaque(input)), 'lost');
  }
  assert.equal(reads, 0);
});

test('strict rule accepts every evidence kind/official host and returns identical input without assigning approval', () => {
  for (const kind of ['official-card', 'official-erratum', 'official-rule'])
    for (const host of ['www.pokemon.cn', 'image.pokemon.com.cn', 'special.pokemon.cn']) {
      const input = { sourceOfTruth: [evidence({ kind, url: `https://${host}/fixture` })] };
      assert(schemaRule(input), JSON.stringify(schemaRule.errors));
      assert(validatePrismStarRule(input), JSON.stringify(validatePrismStarRule.errors));
      const check = unchanged(input);
      assert.equal(assertPrismStarRule(input), input);
      check();
      assert.deepEqual(Object.keys(input), ['sourceOfTruth']);
    }
  const input = nullRecords(rule());
  assert(schemaRule(input));
  assert(validatePrismStarRule(input), JSON.stringify(validatePrismStarRule.errors));
  assert.equal(assertPrismStarRule(input), input);
});

test('a machine-implemented card\'s own card-library record is accepted in the same strict shape; the catalog keeps it to machine tiers', () => {
  const library = (extra = {}) => ({ sourceId: 'library_v1:zh-Hans/TEST/001', kind: 'card-library', url: 'https://tcg.mik.moe/cards/1',
    locator: '测试卡库记录', ...extra });
  for (const item of [library(), library({ url: 'https://wiki.52poke.com/wiki/x', observedOn: '2026-10-23' })]) {
    const input = { sourceOfTruth: [item] };
    assert(schemaRule(input), JSON.stringify(schemaRule.errors));
    assert(validatePrismStarRule(input), JSON.stringify(validatePrismStarRule.errors));
    assert.equal(assertPrismStarRule(input), input);
  }
  for (const item of [library({ url: 'https://www.pokemon.cn/x' }), library({ textSha256: 'a'.repeat(64) }), library({ url: 'https://tcg.mik.moe.evil/x' }),
    { ...evidence(), url: 'https://tcg.mik.moe/x' }]) {
    const input = { sourceOfTruth: [item] };
    assert.equal(schemaRule(input), false); assert.equal(validatePrismStarRule(input), false); rejectedRule(input);
  }
});

test('evidence permits optional normalized hash/date, aliasing, key order and syntax-only unfamiliar source ids', () => {
  const shared = evidence({
    sourceId: 'fixture:unregistered/@-._1', textSha256: 'a'.repeat(64), observedOn: '2026-10-20',
  });
  const input = { sourceOfTruth: [shared, shared, evidence({ sourceId: 'a'.repeat(200), locator: '测试\n条款' })] };
  const check = unchanged(input);
  assert(schemaRule(input));
  assert(validatePrismStarRule(input), JSON.stringify(validatePrismStarRule.errors));
  assert.equal(assertPrismStarRule(input), input);
  assert.equal(input.sourceOfTruth[0], input.sourceOfTruth[1]);
  check();
  // This assertion is syntax validation, NOT catalog lookup/card approval.
  assert.equal(discardDestination({ ...definition('trainer'), prismStar: input }), 'lost');
});

test('rule and evidence records reject scalars, arrays, classes and inherited/custom prototypes', () => {
  class Rule { constructor() { this.sourceOfTruth = [evidence()]; } }
  for (const input of [undefined, null, false, 1, 'rule', 1n, Symbol(), () => {}, [], new Date(), new Rule(),
    Object.create({ sourceOfTruth: [evidence()] })]) rejectedRule(input);
  for (const input of [undefined, null, false, 1, 'evidence', [], new Date(), Object.create(evidence())])
    rejectedRule({ sourceOfTruth: [input] });
});

test('only the declared own enumerable data fields are accepted in a rule or evidence record', () => {
  for (const key of ['approved', 'op', 'destination', 'constructor', '__proto__', 'toJSON', Symbol('unknown')]) {
    const input = rule();
    Object.defineProperty(input, key, { value: input, enumerable: true });
    rejectedRule(input);
    const source = evidence();
    Object.defineProperty(source, key, { value: source, enumerable: true });
    rejectedRule({ sourceOfTruth: [source] });
  }
  rejectedRule({});
  for (const key of ['sourceId', 'kind', 'url', 'locator']) {
    const source = evidence(); delete source[key];
    rejectedRule({ sourceOfTruth: [source] });
  }
  for (const [object, key] of [[rule(), 'sourceOfTruth'], [evidence(), 'sourceId']]) {
    Object.defineProperty(object, key, { enumerable: false });
    rejectedRule(key === 'sourceOfTruth' ? object : { sourceOfTruth: [object] });
  }
});

test('source list is nonempty, dense, plain and contains no extra, hidden, symbolic or executable elements', () => {
  for (const sourceOfTruth of [undefined, null, false, 1, {}, 'source', [], Object.create([evidence()])])
    rejectedRule({ sourceOfTruth });
  const sparse = new Array(1);
  const holeWithExtra = new Array(1); holeWithExtra.extra = evidence();
  const extra = [evidence()]; extra.extra = evidence();
  const symbol = [evidence()]; symbol[Symbol('extra')] = true;
  const hidden = [evidence()]; Object.defineProperty(hidden, '0', { enumerable: false });
  const nullArray = [evidence()]; Object.setPrototypeOf(nullArray, null);
  class Sources extends Array {}
  for (const sourceOfTruth of [sparse, holeWithExtra, extra, symbol, hidden, nullArray, new Sources(evidence())])
    rejectedRule({ sourceOfTruth });
});

test('declarative source schema and assertion reject unknown required evidence values without coercion', () => {
  const invalids = [
    ['sourceId', ''], ['sourceId', 'a'.repeat(201)], ['sourceId', '/bad'], ['sourceId', '名字'], ['sourceId', 'a b'],
    ['kind', 'wiki'], ['kind', 'official'], ['url', 'http://www.pokemon.cn/'],
    ['url', 'https://www.pokemon.cn.evil.invalid/'], ['url', 'https://example.org/'],
    ['url', 'https://www.pokemon.cn'], ['locator', ''],
  ];
  for (const field of ['sourceId', 'kind', 'url', 'locator'])
    for (const value of [null, false, 0, [], {}]) invalids.push([field, value]);
  for (const [field, value] of invalids) {
    const input = { sourceOfTruth: [evidence({ [field]: value })] };
    assert.equal(schemaRule(input), false, `${field}: ${JSON.stringify(value)}`);
    assert.equal(validatePrismStarRule(input), false, `${field}: ${JSON.stringify(value)}`);
    rejectedRule(input);
  }
  for (const field of ['sourceId', 'kind', 'url', 'locator'])
    for (const value of [undefined, 1n, Symbol(), () => {}]) rejectedRule({ sourceOfTruth: [evidence({ [field]: value })] });
});

test('optional evidence fields reject wrong scalar types and malformed normalized hash/date strings', () => {
  const invalids = [
    ['textSha256', ''], ['textSha256', 'a'.repeat(63)], ['textSha256', 'a'.repeat(65)],
    ['textSha256', 'A'.repeat(64)], ['textSha256', 'g'.repeat(64)],
    ['observedOn', ''], ['observedOn', '2026-1-20'], ['observedOn', '20-10-2026'], ['observedOn', '2026-10-20T00:00:00Z'],
  ];
  for (const field of ['textSha256', 'observedOn'])
    for (const value of [null, false, 0, [], {}]) invalids.push([field, value]);
  for (const [field, value] of invalids) {
    const input = { sourceOfTruth: [evidence({ [field]: value })] };
    assert.equal(schemaRule(input), false);
    assert.equal(validatePrismStarRule(input), false);
    rejectedRule(input);
  }
  for (const field of ['textSha256', 'observedOn'])
    for (const value of [undefined, 1n, Symbol(), () => {}]) rejectedRule({ sourceOfTruth: [evidence({ [field]: value })] });
});

test('all requested rule/evidence getters reject with zero reads, including unknown executable properties', () => {
  let reads = 0;
  const accessor = { enumerable: true, get() { reads++; throw new Error('getter executed'); } };
  const root = rule(); Object.defineProperty(root, 'sourceOfTruth', accessor); rejectedRule(root);
  for (const field of ['sourceId', 'kind', 'url', 'locator', 'textSha256', 'observedOn', 'unknown']) {
    const source = evidence(); Object.defineProperty(source, field, accessor);
    rejectedRule({ sourceOfTruth: [source] });
  }
  const sources = [evidence()]; Object.defineProperty(sources, '0', accessor);
  rejectedRule({ sourceOfTruth: sources });
  assert.equal(reads, 0);
});

test('cycles cannot masquerade as evidence; unrelated static/runtime cycles are neither traversed nor modified', () => {
  const circularRule = {}; circularRule.sourceOfTruth = circularRule; rejectedRule(circularRule);
  const sources = []; sources.push(sources); rejectedRule({ sourceOfTruth: sources });
  const cyclicValue = {}; cyclicValue.self = cyclicValue;
  rejectedRule({ sourceOfTruth: [evidence({ locator: cyclicValue })] });
  const extra = rule(); extra.extra = extra; rejectedRule(extra);
  const rootFlagCycle = definition(); rootFlagCycle.prismStar = rootFlagCycle; rejectedDefinition(rootFlagCycle);
  for (const prism of [true, false]) {
    const input = definition('pokemon', prism);
    input.self = input; input.mechanics.runtime = cyclicValue; input.deckLimits.unused = input;
    const check = unchanged(input);
    assert.equal(discardDestination(input), prism ? 'lost' : 'discard');
    check();
  }
});

test('root must be plain/null-prototype and the explicit prismStar flag must be own enumerable data', () => {
  for (const input of [undefined, null, false, 1, 'definition', 1n, Symbol(), () => {}, [], new Date(),
    Object.create(definition())]) rejectedDefinition(input);
  for (const flag of [undefined, null, false, true, 0, '◇', [], {}])
    rejectedDefinition({ ...definition(), prismStar: flag });
  const hidden = definition(); Object.defineProperty(hidden, 'prismStar', { enumerable: false });
  rejectedDefinition(hidden);
  let reads = 0;
  const executable = definition();
  Object.defineProperty(executable, 'prismStar', { enumerable: true, get() { reads++; return rule(); } });
  rejectedDefinition(executable);
  assert.equal(reads, 0);
});

test('present flag requires recognized kind and exact numeric one-card same-name limit', () => {
  for (const kind of [undefined, null, false, 'Pokemon', 'stadium', {}, [], 1])
    rejectedDefinition({ ...definition(), kind });
  const missingKind = definition(); delete missingKind.kind; rejectedDefinition(missingKind);
  for (const sameName of [undefined, null, false, 0, 2, 4, 1.5, '1', 1n, {}, []]) {
    const input = definition(); input.deckLimits.sameName = sameName;
    rejectedDefinition(input);
  }
  const missingLimit = definition(); delete missingLimit.deckLimits.sameName; rejectedDefinition(missingLimit);
  const missingLimits = definition(); delete missingLimits.deckLimits; rejectedDefinition(missingLimits);
  for (const deckLimits of [undefined, null, 1, [], Object.create({ sameName: 1 })])
    rejectedDefinition({ ...definition(), deckLimits });
});

test('Prism Star Pokémon must be Basic with a true printed rule box; Energy must be Special', () => {
  for (const stage of [undefined, null, 'stage1', 'stage2', 'VSTAR', 'VMAX', 'special', {}, 'Basic']) {
    const input = definition(); input.mechanics.stage = stage; rejectedDefinition(input);
  }
  for (const ruleBox of [undefined, null, false, 1, 'true', {}]) {
    const input = definition(); input.mechanics.ruleBox = ruleBox; rejectedDefinition(input);
  }
  for (const category of [undefined, null, 'basic', 'Special', 'trainer', {}]) {
    const input = definition('energy'); input.mechanics.category = category; rejectedDefinition(input);
  }
  for (const kind of ['pokemon', 'energy']) {
    const missing = definition(kind); delete missing.mechanics; rejectedDefinition(missing);
    for (const mechanics of [undefined, null, false, [], Object.create({ stage: 'basic', ruleBox: true, category: 'special' })])
      rejectedDefinition({ ...definition(kind), mechanics });
  }
  for (const [kind, field] of [['pokemon', 'stage'], ['pokemon', 'ruleBox'], ['energy', 'category']]) {
    const input = definition(kind); delete input.mechanics[field]; rejectedDefinition(input);
  }
});

test('Trainer destination needs no runtime category inspection; all printed Trainer categories share the policy', () => {
  for (const category of ['item', 'supporter', 'tool', 'stadium']) {
    const input = definition('trainer'); input.mechanics.category = category;
    assert.equal(discardDestination(input), 'lost');
  }
  const normalizedStaticProjection = { kind: 'trainer', deckLimits: { sameName: 1 }, prismStar: rule() };
  assert.equal(discardDestination(normalizedStaticProjection), 'lost');
});

test('every requested definition field rejects hidden/accessor/inherited data without executing getters', () => {
  let reads = 0;
  const paths = [
    ['pokemon', [], 'kind'], ['pokemon', [], 'deckLimits'], ['pokemon', ['deckLimits'], 'sameName'],
    ['pokemon', [], 'mechanics'], ['pokemon', ['mechanics'], 'stage'], ['pokemon', ['mechanics'], 'ruleBox'],
    ['energy', [], 'mechanics'], ['energy', ['mechanics'], 'category'],
  ];
  for (const [kind, path, field] of paths) for (const mode of ['accessor', 'hidden', 'inherited']) {
    const input = definition(kind), target = path.reduce((value, key) => value[key], input);
    const value = target[field];
    if (mode === 'accessor') Object.defineProperty(target, field, {
      enumerable: true, get() { reads++; return value; },
    });
    else if (mode === 'hidden') Object.defineProperty(target, field, { enumerable: false });
    else { delete target[field]; Object.setPrototypeOf(target, { [field]: value }); }
    rejectedDefinition(input);
  }
  assert.equal(reads, 0);
});

test('no coercion, toJSON, valueOf or constructor hooks are invoked while rejecting malformed rules', () => {
  let calls = 0;
  const executable = {
    toJSON() { calls++; return 'valid'; },
    valueOf() { calls++; return 1; },
    toString() { calls++; return 'basic'; },
  };
  for (const field of ['sourceId', 'kind', 'url', 'locator', 'textSha256', 'observedOn'])
    rejectedRule({ sourceOfTruth: [evidence({ [field]: executable })] });
  const input = definition(); input.deckLimits.sameName = executable; rejectedDefinition(input);
  Object.defineProperty(executable, 'constructor', { get() { calls++; throw new Error('constructor read'); } });
  rejectedRule(executable);
  assert.equal(calls, 0);
});

test('data-only proxies need no property reads; revoked/uninspectable proxies reject instead of falling back', () => {
  let reads = 0;
  const noGets = (value) => new Proxy(value, { get() { reads++; throw new Error('get trap'); } });
  const input = rule();
  input.sourceOfTruth[0] = noGets(input.sourceOfTruth[0]);
  input.sourceOfTruth = noGets(input.sourceOfTruth);
  const proxied = noGets(input);
  assert.equal(assertPrismStarRule(proxied), proxied);
  assert.equal(reads, 0);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  rejectedDefinition(revoked.proxy); rejectedRule(revoked.proxy);
  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    const inaccessible = new Proxy(rule(), { [trap]() { throw new Error(`blocked ${trap}`); } });
    assert.throws(() => assertPrismStarRule(inaccessible), /blocked/);
  }
  const inaccessibleFlag = new Proxy(definition(), {
    getOwnPropertyDescriptor() { throw new Error('blocked flag'); },
  });
  assert.throws(() => discardDestination(inaccessibleFlag), /blocked flag/);
});

test('frozen/null-prototype inputs remain valid and mutable inputs keep every descriptor, alias and extensibility', () => {
  for (const kind of ['pokemon', 'trainer', 'energy']) {
    const input = nullRecords(definition(kind));
    input.prismStar.sourceOfTruth.push(input.prismStar.sourceOfTruth[0]);
    const mutableCheck = unchanged(input);
    assert.equal(assertPrismStarRule(input.prismStar), input.prismStar);
    assert.equal(discardDestination(input), 'lost');
    mutableCheck();
    Object.freeze(input.prismStar.sourceOfTruth[0]); Object.freeze(input.prismStar.sourceOfTruth);
    Object.freeze(input.prismStar); Object.freeze(input.mechanics); Object.freeze(input.deckLimits); Object.freeze(input);
    const frozenCheck = unchanged(input);
    assert.equal(discardDestination(input), 'lost'); assert.equal(assertPrismStarRule(input.prismStar), input.prismStar);
    frozenCheck();
  }
});
