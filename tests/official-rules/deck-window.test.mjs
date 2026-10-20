import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  DECK_WINDOW_RULE_IDS, DECK_WINDOW_SOURCES,
  assertDeckInspectionAction, validateDeckInspectionAction,
  inspectDeckWindow, planDeckInspection, assertDeckInspectionPlan,
  deckInspectionNeedsShuffle, assertDeckInspectionRemainder, assertDeckInspectionPlacement,
} from '../../public/rules/deck-window.js';
import { CN_V20261019 } from '../../public/rules/zh-CN/V20261019.js';
import { requireRule, deepFreeze } from '../../public/rules/registry.js';

const clone = (value) => structuredClone(value);
// Parameters transcribed from the observed csv4C 122/129 G face. This is not a
// catalog definition, production approval, handler binding or trustpin.
const rika = (extra = {}) => ({
  op: 'inspectDeck', lookTop: 4, selector: { kind: 'any' },
  quantity: { kind: 'exact', count: 2 }, revealSelected: false,
  remainder: { mode: 'shuffleToBottom' }, ...extra,
});

// Minimal normalized predicate fixtures, not printed-card evidence/approvals.
function context(top = ['a', 'b', 'c', 'd', 'e', 'f'], owner = 0) {
  const definitions = {
    mon: { kind: 'pokemon', name: '测试基础', nameKey: 'fixture:mon', mechanics: {
      stage: 'basic', hp: 100, types: ['Lightning'], ruleBox: false, tags: [],
      attacks: [{ attackId: 'fixture:attack' }], abilities: [{ abilityId: 'fixture:ability' }],
    } },
    item: { kind: 'trainer', name: '测试物品', nameKey: 'fixture:item', mechanics: { category: 'item' } },
    supporter: { kind: 'trainer', name: '测试支援者', nameKey: 'fixture:supporter', mechanics: { category: 'supporter' } },
    basic: { kind: 'energy', name: '测试基本雷能量', nameKey: 'fixture:basic', mechanics: {
      category: 'basic', baseUnits: [['Lightning']],
    } },
    special: { kind: 'energy', name: '测试特殊能量', nameKey: 'fixture:special', mechanics: {
      category: 'special', baseUnits: [['Lightning'], ['Colorless']],
    } },
  };
  const own = { deck: [...top].reverse(), hand: ['old-hand'], flags: { supporter: false } };
  const other = { deck: ['foreign'], hand: ['foreign-hand'], flags: { supporter: true } };
  return {
    source: { owner, instanceId: 'fixture:source' }, definitions,
    state: {
      current: 1 - owner, rng: [123, 456, 789, 42],
      cards: Object.fromEntries([...top.map((id) =>
        [id, { instanceId: id, definitionId: 'mon', printingId: 'fixture:printing', owner }]),
      ['foreign', { instanceId: 'foreign', definitionId: 'mon', owner: 1 - owner }]]),
      players: owner === 0 ? [own, other] : [other, own],
    },
  };
}

// Register only transitive references, not arbitrary concurrent agents' schema
// files. The root schema itself remains standalone; no shared generator edits.
const ajv = new Ajv2020({ strict: true, allErrors: true });
const loaded = new Map();
async function register(name) {
  const doc = JSON.parse(await readFile(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
  if (loaded.has(doc.$id)) return;
  loaded.set(doc.$id, doc); ajv.addSchema(doc);
  const pending = [doc];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (typeof value.$ref === 'string' && value.$ref.startsWith('urn:pokemon-tcg:')) {
      const uri = value.$ref.split('#')[0];
      if (!loaded.has(uri)) {
        const key = uri.split(':')[2];
        await register(key === 'core-handler-parameters' ? 'handler-parameters' : key);
      }
    }
    pending.push(...Object.values(value));
  }
}
await register('deck-window');
const schema = loaded.get('urn:pokemon-tcg:deck-window:1.0.0');
const schemaAction = ajv.getSchema(schema.$id);
const schemaPlan = ajv.compile({ $ref: `${schema.$id}#/$defs/plan` });
const schemaShuffled = ajv.compile({ $ref: `${schema.$id}#/$defs/shuffledRemainder` });

function* permutations(values) {
  if (!values.length) { yield []; return; }
  for (let i = 0; i < values.length; i++) {
    const rest = [...values]; const [first] = rest.splice(i, 1);
    for (const tail of permutations(rest)) yield [first, ...tail];
  }
}
// Independent complement oracle: erase selected identities one at a time.
function oracleRemainder(window, selected) {
  const remaining = [...window];
  for (const id of selected) {
    const index = remaining.indexOf(id);
    assert(index >= 0); remaining.splice(index, 1);
  }
  return remaining;
}
// Independent placement oracle works in physical top-first reading order,
// opposite to the production assertion's bottom-first prefix construction.
const oracleDeck = (top, windowLength, randomTop) => [...top.slice(windowLength), ...randomTop].reverse();

test('sources pin actual CN sections/pages and distinguish E-35 subset shuffle from E-36 full-deck shuffle', () => {
  for (const id of DECK_WINDOW_RULE_IDS) assert(requireRule(CN_V20261019, id));
  assert.deepEqual(DECK_WINDOW_SOURCES, {
    hiddenSelection: { documentId: 'CN-advanced-3.1.0', section: 'I.H', pdfPages: [18] },
    cardInstructionAndShortfall: { documentId: 'CN-advanced-3.1.0', section: 'II.A', pdfPages: [19] },
    inspection: { documentId: 'CN-advanced-3.1.0', section: 'II.C-20', pdfPages: [41] },
    exact: { documentId: 'CN-advanced-3.1.0', section: 'II.D-04', pdfPages: [43, 44] },
    upTo: { documentId: 'CN-advanced-3.1.0', section: 'II.D-05', pdfPages: [44] },
    anyQuantity: { documentId: 'CN-advanced-3.1.0', section: 'II.D-02', pdfPages: [42, 43] },
    shuffleRemainder: { documentId: 'CN-advanced-3.1.0', section: 'II.E-35', pdfPages: [73, 74] },
    shuffleDistinction: { documentId: 'CN-advanced-3.1.0', section: 'II.E-35—36', pdfPages: [73, 74] },
  });
  assert(Object.isFrozen(DECK_WINDOW_SOURCES));
  for (const item of Object.values(DECK_WINDOW_SOURCES)) {
    assert(Object.isFrozen(item)); assert(Object.isFrozen(item.pdfPages));
  }
  const pdf = CN_V20261019.documents.find((d) => d.id === 'CN-advanced-3.1.0');
  assert.match(schema.$comment, new RegExp(pdf.sha256));
  assert.match(schema.$comment, /f31a2e3e9d0d0f17e82c99d6c0dcf2efc3451cb7df37be9bfbdcf90235ae0ffa/);
  assert.match(schema.$comment, /csv4C 122\/129 G/);
  assert.match(schema.$comment, /NOT production approval/);
  assert.equal(schema.$defs.action.properties.selector.$ref, 'urn:pokemon-tcg:card-selector:1.0.0');
});

test('schema and pure action gate agree on explicit quantities, selectors and positive safe bounds', () => {
  const selectors = [
    { kind: 'any' }, { kind: 'pokemon', stages: ['basic'], printedHpAtMost: 100, ruleBox: false },
    { kind: 'pokemon', types: ['Lightning'], attackIds: ['fixture:attack'], abilityIds: ['fixture:ability'] },
    { kind: 'trainer', categories: ['supporter'], nameContains: '测试' },
    { kind: 'energy', category: 'basic', types: ['Lightning'] },
    { anyOf: [{ kind: 'pokemon' }, { kind: 'trainer', categories: ['item'] }] },
  ];
  for (const selector of selectors) for (const revealSelected of [false, true]) {
    for (const lookTop of [1, 4, Number.MAX_SAFE_INTEGER]) {
      for (const quantity of [{ kind: 'exact', count: 1 }, { kind: 'upTo', count: Number.MAX_SAFE_INTEGER }, { kind: 'any' }]) {
        const action = rika({ selector, quantity, revealSelected, lookTop });
        const before = clone(action);
        assert(schemaAction(action), JSON.stringify(schemaAction.errors));
        assert(validateDeckInspectionAction(action));
        assert.equal(assertDeckInspectionAction(action), action);
        assert.deepEqual(action, before);
      }
    }
  }
  const nullPrototype = Object.assign(Object.create(null), rika());
  assert.equal(assertDeckInspectionAction(nullPrototype), nullPrototype);
  assert(validateDeckInspectionAction(deepFreeze(rika())));
});

test('unknown fields, optional/count defaults and full-deck/top/foreign modes fail closed, with no approvals', () => {
  const invalid = [
    null, [], 0, true, 'inspectDeck', {}, rika({ op: 'cards' }),
    ...[-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '4', null].map((lookTop) => rika({ lookTop })),
    rika({ revealSelected: 1 }), rika({ selector: { kind: 'any', verified: true } }),
    rika({ selector: { kind: 'pokemon', currentHpAtMost: 100 } }),
    rika({ selector: { kind: 'energy', category: 'special', types: ['Lightning'] } }),
    rika({ quantity: null }), rika({ quantity: [] }), rika({ quantity: {} }),
    rika({ quantity: { kind: 'all' } }), rika({ quantity: { kind: 'exact' } }),
    rika({ quantity: { kind: 'exact', count: 0 } }), rika({ quantity: { kind: 'upTo', count: -1 } }),
    rika({ quantity: { kind: 'upTo', count: 1.1 } }), rika({ quantity: { kind: 'exact', count: Number.MAX_SAFE_INTEGER + 1 } }),
    rika({ quantity: { kind: 'any', count: 0 } }), rika({ quantity: { kind: 'exact', count: 2, optional: true } }),
    rika({ quantity: { kind: 'unknown', count: 2 } }), rika({ quantity: { kind: 'exact', count: '2' } }),
    rika({ remainder: null }), rika({ remainder: { mode: 'shuffleDeck' } }),
    rika({ remainder: { mode: 'keepOnTop' } }), rika({ remainder: { mode: 'shuffleToBottom', reveal: true } }),
    ...['from', 'to', 'side', 'shuffleAfter', 'approved', 'verified', 'trustpins', 'sourceOfTruth'].map((key) =>
      rika({ [key]: key === 'side' ? 'opponent' : true })),
  ];
  for (const key of Object.keys(rika())) {
    const missing = rika(); delete missing[key]; invalid.push(missing);
  }
  for (const action of invalid) {
    assert(!schemaAction(action), JSON.stringify(action));
    assert(!validateDeckInspectionAction(action), JSON.stringify(action));
    assert.throws(() => assertDeckInspectionAction(action), TypeError);
    assert.throws(() => inspectDeckWindow(context(), action), TypeError);
  }
});

test('non-JSON inputs, getters, hidden fields, symbols, sparse arrays and cycles cannot influence a plan', () => {
  const cyclic = rika(); cyclic.selector = cyclic;
  const getter = rika(); Object.defineProperty(getter, 'selector', { enumerable: true, get() { throw Error('executed'); } });
  const hidden = rika(); Object.defineProperty(hidden, 'approved', { value: true });
  const symbol = rika(); symbol[Symbol('approval')] = true;
  const proto = Object.assign(Object.create({ approved: true }), rika());
  const arrays = [
    new Array(2), Object.assign(['a'], { extra: 'b' }), Object.assign(['a'], { '01': 'b' }),
    Object.assign(['a'], { '-1': 'b' }),
  ];
  const arrayGetter = ['a'];
  Object.defineProperty(arrayGetter, 0, { enumerable: true, get() { throw Error('executed'); } });
  const arrayHidden = ['a']; Object.defineProperty(arrayHidden, 0, { enumerable: false });
  const arraySymbol = ['a']; arraySymbol[Symbol('x')] = true;
  const swappedSparse = ['a', 'b']; delete swappedSparse[0]; swappedSparse.extra = 'c';
  arrays.push(arrayGetter, arrayHidden, arraySymbol, swappedSparse);
  for (const action of [cyclic, getter, hidden, symbol, proto, new Date(), new Map(),
    ...[undefined, NaN, Infinity, -Infinity, 1n, () => {}].map((lookTop) => rika({ lookTop }))]) {
    assert(!validateDeckInspectionAction(action));
    assert.throws(() => assertDeckInspectionAction(action), TypeError);
  }
  const ctx = context();
  for (const selected of [...arrays, null, {}, [''], ['a', 'a'], [null], [1], ['a', undefined]]) {
    assert.throws(() => planDeckInspection(ctx, rika(), selected), TypeError);
  }
  const replacedArrayPrototype = ['a']; Object.setPrototypeOf(replacedArrayPrototype, null);
  assert.throws(() => planDeckInspection(ctx, rika(), replacedArrayPrototype), TypeError);
  // Non-JSON values are rejected without invoking getters, including selectors.
  const getterSelector = rika(); Object.defineProperty(getterSelector.selector, 'kind',
    { enumerable: true, get() { throw Error('executed'); } });
  assert.throws(() => assertDeckInspectionAction(getterSelector), TypeError);
});

test('window reads only the actual owner, preserves original TOP order and cannot choose the fifth card', () => {
  for (const owner of [0, 1]) {
    const ctx = context(undefined, owner);
    Object.defineProperty(ctx.state.players[1 - owner], 'deck', { get() { throw Error('opponent zone read'); } });
    Object.defineProperty(ctx.state.cards, 'e', { get() { throw Error('fifth definition read'); } });
    Object.defineProperty(ctx.state, 'rng', { get() { throw Error('RNG read'); } });
    const view = inspectDeckWindow(ctx, rika());
    assert.deepEqual(view.window, ['a', 'b', 'c', 'd']);
    assert.deepEqual(view.eligible, ['a', 'b', 'c', 'd']);
    assert.equal(view.bounds.minimum, 2); assert.equal(view.bounds.maximum, 2); assert(!view.bounds.allowZero);
    assert.throws(() => planDeckInspection(ctx, rika(), ['a', 'e']), /window/);
    assert.throws(() => planDeckInspection(ctx, rika(), ['foreign', 'a']), /window/);
    assert.deepEqual(planDeckInspection(ctx, rika(), ['d', 'a']), {
      window: ['a', 'b', 'c', 'd'], selected: ['d', 'a'], remainder: ['b', 'c'],
    });
  }
});

test('Rika arbitrary cards exact two: empty/short/full decks take the closest possible count, not fail-to-find', () => {
  for (let n = 0; n <= 7; n++) {
    const top = Array.from({ length: n }, (_, i) => `card${i}`);
    const ctx = context(top), action = rika();
    const view = inspectDeckWindow(ctx, action), required = Math.min(2, n);
    assert.deepEqual(view.window, top.slice(0, 4));
    assert.equal(view.bounds.minimum, required); assert.equal(view.bounds.maximum, required);
    assert.equal(view.bounds.allowZero, n === 0);
    for (let count = 0; count <= Math.min(4, n); count++) {
      const chosen = top.slice(0, count);
      if (count !== required) {
        assert.throws(() => planDeckInspection(ctx, action, chosen), /quantity/);
      } else {
        const plan = planDeckInspection(ctx, action, chosen);
        assert.deepEqual(plan.remainder, top.slice(required, Math.min(4, n)));
        const saved = clone(plan);
        assert.equal(assertDeckInspectionPlan(ctx, action, saved), saved);
      }
    }
  }
});

test('filtered hidden selection, upTo and any quantity use CN literal bounds without inferring an any-card predicate', () => {
  const ctx = context();
  ctx.state.cards.a.definitionId = 'basic'; ctx.state.cards.b.definitionId = 'special';
  ctx.state.cards.c.definitionId = 'item'; ctx.state.cards.d.definitionId = 'basic';
  const cases = [
    [{ selector: { kind: 'energy', category: 'basic', types: ['Lightning'] } }, ['a', 'd'], 0, 2],
    [{ selector: { kind: 'pokemon' } }, [], 0, 0],
    [{ selector: { kind: 'trainer', categories: ['item'] }, quantity: { kind: 'exact', count: 1 } }, ['c'], 0, 1],
    [{ selector: { anyOf: [{ kind: 'energy' }, { kind: 'trainer' }] } }, ['a', 'b', 'c', 'd'], 0, 2],
    [{ quantity: { kind: 'upTo', count: 2 } }, ['a', 'b', 'c', 'd'], 1, 2],
    [{ selector: { kind: 'energy' }, quantity: { kind: 'upTo', count: 2 } }, ['a', 'b', 'd'], 0, 2],
    [{ quantity: { kind: 'any' } }, ['a', 'b', 'c', 'd'], 0, 4],
  ];
  for (const [extra, eligible, minimum, maximum] of cases) {
    const action = rika(extra), view = inspectDeckWindow(ctx, action);
    assert.deepEqual(view.eligible, eligible);
    assert.equal(view.bounds.minimum, minimum); assert.equal(view.bounds.maximum, maximum);
    for (let count = 0; count <= eligible.length; count++) {
      const chosen = eligible.slice(0, count);
      if (count >= minimum && count <= maximum) assert(schemaPlan(planDeckInspection(ctx, action, chosen)));
      else assert.throws(() => planDeckInspection(ctx, action, chosen), TypeError);
    }
  }
  assert.throws(() => planDeckInspection(ctx, rika(cases[0][0]), ['a', 'b']), /selector/);
  const allMon = context();
  assert.equal(inspectDeckWindow(allMon, rika({ selector: { kind: 'pokemon' } })).bounds.minimum, 0);
  assert.equal(inspectDeckWindow(context([]), rika({ quantity: { kind: 'upTo', count: 2 } })).bounds.minimum, 0);
});

test('independent ordered-selection/permutation oracle conserves the whole window and places every remainder below all unseen cards', () => {
  let checked = 0;
  for (let n = 0; n <= 7; n++) {
    const top = Array.from({ length: n }, (_, i) => `oracle:${i}`), window = top.slice(0, 4);
    const ctx = deepFreeze(context(top)), action = deepFreeze(rika()), required = Math.min(2, n);
    const choices = new Map([...permutations(window)].map((p) => {
      const selected = p.slice(0, required); return [JSON.stringify(selected), selected];
    }));
    for (const chosen of choices.values()) {
      const plan = planDeckInspection(ctx, action, deepFreeze(chosen));
      const remainder = oracleRemainder(window, chosen);
      assert.deepEqual(plan, { window, selected: chosen, remainder });
      assert(schemaPlan(plan));
      assert.equal(assertDeckInspectionPlan(ctx, action, plan, chosen), plan);
      for (const randomTop of permutations(remainder)) {
        assert(schemaShuffled(randomTop));
        assert.equal(assertDeckInspectionRemainder(plan, randomTop), randomTop);
        const after = oracleDeck(top, window.length, randomTop);
        assert.equal(assertDeckInspectionPlacement(ctx, action, plan, randomTop, after), after);
        assert.deepEqual([...after].reverse().slice(0, n - window.length), top.slice(window.length));
        assert.deepEqual([...new Set([...after, ...plan.selected])].sort(), [...top].sort());
        checked++;
      }
    }
  }
  assert.equal(checked, 106);
});

test('save/restore validates exact original window, partition, selected identities/order and semantic quantity', () => {
  const ctx = context(), action = rika(), chosen = ['a', 'c'];
  const plan = planDeckInspection(ctx, action, chosen);
  const restored = JSON.parse(JSON.stringify(plan));
  assert.equal(assertDeckInspectionPlan(ctx, action, restored, chosen), restored);
  const invalid = [
    null, [], {}, { ...plan, approved: true }, { ...plan, window: ['b', 'a', 'c', 'd'] },
    { ...plan, window: ['a', 'b', 'c', 'd', 'e'], remainder: ['b', 'd', 'e'] },
    { ...plan, window: ['a', 'b', 'c'], remainder: ['b'] },
    { ...plan, window: ['a', 'b', 'a', 'd'] }, { ...plan, selected: ['a', 'a'] },
    { ...plan, selected: ['e', 'c'] }, { ...plan, selected: [], remainder: [...plan.window] },
    { ...plan, selected: ['a'], remainder: ['b', 'c', 'd'] },
    { ...plan, remainder: ['b'] }, { ...plan, remainder: ['b', 'd', 'd'] },
    { ...plan, remainder: ['a', 'b', 'd'] }, { ...plan, remainder: ['d', 'b'] },
    { ...plan, remainder: ['b', 'e'] },
  ];
  for (const key of Object.keys(plan)) { const missing = clone(plan); delete missing[key]; invalid.push(missing); }
  for (const saved of invalid) assert.throws(() => assertDeckInspectionPlan(ctx, action, saved), TypeError);
  const reordered = { ...plan, selected: ['c', 'a'] };
  assert.equal(assertDeckInspectionPlan(ctx, action, reordered), reordered, 'a fresh answer may choose either order');
  assert.throws(() => assertDeckInspectionPlan(ctx, action, reordered, chosen), /original/);
  const alternate = planDeckInspection(ctx, action, ['b', 'd']);
  assert.throws(() => assertDeckInspectionPlan(ctx, action, alternate, chosen), /original/);
  const changedDeck = clone(ctx); changedDeck.state.players[0].deck.reverse();
  assert.throws(() => assertDeckInspectionPlan(changedDeck, action, plan), TypeError);
  const escrowed = clone(ctx); escrowed.state.players[0].deck.splice(-4);
  assert.throws(() => assertDeckInspectionPlan(escrowed, action, plan), TypeError,
    'partial post-removal state cannot masquerade as the original planning context');
  const corrupt = clone(ctx); corrupt.state.cards.a.definitionId = 'item';
  const specific = rika({ selector: { kind: 'pokemon' } });
  assert.throws(() => assertDeckInspectionPlan(corrupt, specific, plan), /selector/);
  // Structural schema cannot authenticate cross-array partitions or a live deck.
  assert(schemaPlan({ ...plan, remainder: ['foreign'] }));
  assert(!schemaPlan({ ...plan, selected: ['a', 'a'] }));
});

test('remainder permutation and placement reject missing/extra/duplicate cards, whole-deck shuffle and top replacement', () => {
  const ctx = context(), action = rika(), plan = planDeckInspection(ctx, action, ['a', 'c']);
  for (const shuffled of [[], ['b'], ['b', 'b'], ['b', 'a'], ['d', 'e'], ['b', 'd', 'e'], ['d', 'b', 'f'], {}, null]) {
    assert.throws(() => assertDeckInspectionRemainder(plan, shuffled), TypeError);
  }
  const shuffled = ['d', 'b'], after = ['b', 'd', 'f', 'e'];
  assert.equal(assertDeckInspectionPlacement(ctx, action, plan, shuffled, after), after);
  for (const bad of [
    ['f', 'e', 'b', 'd'], // leave remainder on top
    ['b', 'd', 'e', 'f'], // shuffle unseen cards
    ['d', 'b', 'f', 'e'], // different exact RNG result, despite valid permutation
    ['b', 'd', 'f', 'e', 'a'], ['b', 'd', 'f'], ['b', 'd', 'f', 'f'],
  ]) assert.throws(() => assertDeckInspectionPlacement(ctx, action, plan, shuffled, bad), TypeError);
  const malformed = { ...plan, remainder: ['d', 'b'] };
  assert.throws(() => assertDeckInspectionRemainder(malformed, ['b', 'd']), TypeError);
  assert.throws(() => deckInspectionNeedsShuffle(malformed), TypeError);
  // Randomness is not "order must change": identity is a possible real shuffle.
  assert.equal(assertDeckInspectionRemainder(plan, plan.remainder), plan.remainder);
});

test('nonempty remainder, including a singleton, counts as shuffle; empty remainder does not', () => {
  for (const n of [0, 1, 2, 3, 4]) {
    const top = ['a', 'b', 'c', 'd'].slice(0, n), ctx = context(top);
    const plan = planDeckInspection(ctx, rika(), top.slice(0, Math.min(n, 2)));
    assert.equal(deckInspectionNeedsShuffle(plan), n > 2);
    assert.equal(assertDeckInspectionRemainder(plan, [...plan.remainder]).length, Math.max(0, n - 2));
    assert.equal(assertDeckInspectionPlacement(ctx, rika(), plan, plan.remainder,
      [...plan.remainder].reverse()).length, Math.max(0, n - 2));
  }
  const any = rika({ quantity: { kind: 'any' } }), ctx = context(['singleton']);
  const plan = planDeckInspection(ctx, any, []);
  assert(deckInspectionNeedsShuffle(plan));
  assert.deepEqual(plan.remainder, ['singleton']);
});

test('input originals, RNG, flags and chosen order are neither changed nor frozen; outputs have no mutable aliases', () => {
  const ctx = context(), action = rika(), chosen = ['d', 'a'];
  const before = clone({ ctx, action, chosen });
  const view = inspectDeckWindow(ctx, action), plan = planDeckInspection(ctx, action, chosen);
  const randomTop = ['c', 'b'], after = ['b', 'c', 'f', 'e'];
  assertDeckInspectionPlan(ctx, action, plan, chosen);
  assertDeckInspectionRemainder(plan, randomTop);
  assertDeckInspectionPlacement(ctx, action, plan, randomTop, after);
  assert.deepEqual({ ctx, action, chosen }, before);
  assert(!Object.isFrozen(ctx)); assert(!Object.isFrozen(ctx.state.players[0].deck));
  assert(!Object.isFrozen(action)); assert(!Object.isFrozen(chosen));
  view.window.reverse(); view.eligible.pop(); view.bounds.minimum = 0;
  plan.window[0] = 'changed'; plan.selected.push('changed'); plan.remainder.reverse();
  assert.deepEqual({ ctx, action, chosen }, before);
  assert.deepEqual(planDeckInspection(deepFreeze(ctx), deepFreeze(action), deepFreeze(chosen)), {
    window: ['a', 'b', 'c', 'd'], selected: ['d', 'a'], remainder: ['b', 'c'],
  });
});

test('physical cards and normalized metadata do not approve themselves or bypass identity/window checks', () => {
  for (const mutate of [
    (c) => { c.source.owner = null; }, (c) => { c.source.owner = 2; }, (c) => { delete c.source; },
    (c) => { c.state.players[0].deck = ['a', 'a']; }, (c) => { c.state.players[0].deck = ['']; },
    (c) => { delete c.state; }, (c) => { delete c.state.players; },
    (c) => { delete c.state.cards; }, (c) => { delete c.state.cards.a; },
    (c) => { c.state.cards.a.instanceId = 'b'; }, (c) => { c.state.cards.a.owner = 1; },
    (c) => { c.state.cards.a.definitionId = ''; }, (c) => { delete c.definitions; },
    (c) => { delete c.definitions.mon; }, (c) => { c.definitions.mon = null; },
    (c) => { c.definitions.mon.kind = 'pocket'; },
  ]) {
    const ctx = context(); mutate(ctx);
    assert.throws(() => inspectDeckWindow(ctx, rika()), TypeError);
  }
  assert.throws(() => inspectDeckWindow(null, rika()), TypeError);
  const ctx = context();
  ctx.definitions.mon.implementation = { status: 'verified', testIds: ['not-approval'] };
  ctx.definitions.mon.productionApproved = true;
  ctx.state.cards.a.verified = true; ctx.state.cards.a.approved = true;
  const before = clone(ctx);
  assert.throws(() => planDeckInspection(ctx, rika(), []), /quantity/);
  assert.throws(() => planDeckInspection(ctx, rika(), ['a', 'e']), /window/);
  const plan = planDeckInspection(ctx, rika(), ['a', 'b']);
  assert.deepEqual(Object.keys(plan), ['window', 'selected', 'remainder']);
  assert(!JSON.stringify(plan).match(/approved|verified|trustpin|sourceOfTruth|official-card/i));
  assert.deepEqual(ctx, before);
  // Runtime identity strings are preserved verbatim, never parsed as numbers
  // or replaced by a printing ID/definition ID.
  const raw = ['实例:001/129', 'physical 0002', '001', '1'];
  const exact = planDeckInspection(context(raw), rika(), raw.slice(0, 2));
  assert.deepEqual(exact.window, raw); assert.deepEqual(exact.selected, raw.slice(0, 2));
});
