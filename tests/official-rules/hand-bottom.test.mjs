// Synthetic physical cards only. No production cards, approvals or trustpins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  HandBottomError, HAND_BOTTOM_RULE_IDS, HAND_BOTTOM_SOURCES,
  assertHandBottomAction, handBottomWindows, planHandBottom,
  assertHandBottomPermutation, assertHandBottomWindowPlacement,
} from '../../public/rules/hand-bottom.js';
import { CN_V20261019 } from '../../public/rules/zh-CN/V20261019.js';

const action = (side = 'both') => ({ op: 'shuffleHandToBottom', side });
const clone = (value) => structuredClone(value);
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
function context(owner = 0, hands = [['p0:h0', 'p0:h1'], ['p1:h0']], decks = [
  ['p0:bottom', 'p0:middle', 'p0:top'], ['p1:bottom', 'p1:top'],
]) {
  const players = [0, 1].map((holder) => ({ hand: [...hands[holder]], deck: [...decks[holder]] }));
  const cards = Object.fromEntries(players.flatMap((p, holder) => [...p.hand, ...p.deck].map((instanceId) =>
    [instanceId, { instanceId, owner: holder }])));
  return { source: { owner, instanceId: 'played-trainer' }, state: {
    current: 1 - owner, rng: [11, 22, 33, 44], serial: 51, cards, players,
  } };
}
const window = (hand = ['h0', 'h1', 'h2'], deck = ['bottom', 'middle', 'top'], owner = 0) => ({
  owner, hand: [...hand], deck: [...deck],
});
const error = (fn, code) => assert.throws(fn, (e) => {
  assert(e instanceof TypeError); assert(e instanceof HandBottomError);
  assert.equal(e.name, 'HandBottomError'); assert.equal(e.code, code); return true;
});
const schema = JSON.parse(await readFile(new URL('../../schemas/hand-bottom.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true }); ajv.addSchema(schema);
const schemaAction = ajv.getSchema(schema.$id);
const schemaWindow = ajv.getSchema(`${schema.$id}#/$defs/window`);
const schemaWindows = ajv.getSchema(`${schema.$id}#/$defs/windows`);
const schemaPlan = ajv.getSchema(`${schema.$id}#/$defs/plan`);

function* permutations(items) {
  if (!items.length) { yield []; return; }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items], [first] = rest.splice(i, 1);
    for (const suffix of permutations(rest)) yield [first, ...suffix];
  }
}

// Independent physical/top-first oracle: existing top cards must all be drawn
// first, then the shuffled hand in its reversed draw order. Erase each identity
// from the original multiset once. No production helper supplies expectations.
function placementOracle(original, shuffledBottomFirst, deckAfter) {
  const expectedDraw = [...original.deck].reverse();
  for (let i = shuffledBottomFirst.length - 1; i >= 0; i--) expectedDraw.push(shuffledBottomFirst[i]);
  const remaining = [...original.hand, ...original.deck], draws = [...deckAfter];
  assert.equal(draws.length, remaining.length);
  for (const id of expectedDraw) {
    assert.equal(draws.pop(), id);
    const index = remaining.indexOf(id); assert.notEqual(index, -1); remaining.splice(index, 1);
  }
  assert.deepEqual(draws, []); assert.deepEqual(remaining, []);
}

test('sources pin actual CN E19 FAQ2 and E35, not E36 deck shuffle or a whole-card approval', () => {
  assert.equal(schema.$id, 'urn:pokemon-tcg:hand-bottom:1.0.0');
  assert.deepEqual(HAND_BOTTOM_RULE_IDS, ['effects.hand-bottom']);
  assert.deepEqual(HAND_BOTTOM_SOURCES, [
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-19 FAQ2', pdfPages: [63] },
    { documentId: 'CN-advanced-3.1.0', section: 'II.E-35', pdfPages: [73, 74] },
  ]);
  const doc = CN_V20261019.documents.find((d) => d.id === 'CN-advanced-3.1.0');
  assert.equal(doc.sha256, '27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419');
  assert(schema.$comment.includes(doc.sha256)); assert.match(schema.$comment, /not E-36/);
  assert(Object.isFrozen(HAND_BOTTOM_RULE_IDS)); assert(Object.isFrozen(HAND_BOTTOM_SOURCES));
  for (const source of HAND_BOTTOM_SOURCES) {
    assert(Object.isFrozen(source)); assert(Object.isFrozen(source.pdfPages));
    assert(source.pdfPages.every((p) => p >= 1 && p <= doc.pages));
  }
  assert.throws(() => HAND_BOTTOM_SOURCES[0].pdfPages.push(74), TypeError);
});

test('all explicit sides and actual source owners preserve original IDs and bottom-first decks, never current', () => {
  for (const owner of [0, 1]) for (const [side, expectedOwners] of [
    ['own', [owner]], ['opponent', [1 - owner]], ['both', [owner, 1 - owner]],
  ]) {
    const ctx = freeze(context(owner)), a = freeze(action(side)), before = clone({ ctx, a });
    assert.equal(assertHandBottomAction(a), a); assert.equal(schemaAction(a), true);
    const expected = expectedOwners.map((holder) => ({
      owner: holder, hand: [...ctx.state.players[holder].hand], deck: [...ctx.state.players[holder].deck],
    }));
    const windows = handBottomWindows(ctx, a), plan = planHandBottom(ctx, a);
    assert.deepEqual(windows, expected); assert.equal(schemaWindows(windows), true);
    assert.deepEqual(plan, { windows: expected, performed: true }); assert.equal(schemaPlan(plan), true);
    for (const entry of windows) {
      assert.equal(schemaWindow(entry), true);
      assert.notEqual(entry.hand, ctx.state.players[entry.owner].hand);
      assert.notEqual(entry.deck, ctx.state.players[entry.owner].deck);
    }
    assert.deepEqual({ ctx, a }, before);
  }
});

test('both-side performed truth table retains empty windows; singleton counts and a nonempty old deck cannot substitute for a hand', () => {
  for (const owner of [0, 1]) for (const [hands, wants] of [
    [[[], []], [false, false, false]],
    [[['a'], []], owner === 0 ? [true, false, true] : [false, true, true]],
    [[[], ['b']], owner === 0 ? [false, true, true] : [true, false, true]],
    [[['a'], ['b']], [true, true, true]],
  ]) {
    for (const decks of [[[], []], [['old0'], ['old1']]]) {
      const ctx = context(owner, hands, decks);
      for (const [i, side] of ['own', 'opponent', 'both'].entries()) {
        const plan = planHandBottom(ctx, action(side));
        assert.equal(plan.performed, wants[i]); assert.equal(schemaPlan(plan), true);
        assert.equal(plan.windows.length, side === 'both' ? 2 : 1);
      }
    }
  }
});

test('commit context excludes the played Trainer and paid hand cards; planner never creates permission or skips an empty player', () => {
  const ctx = context(0, [[], []], [['old0'], ['old1']]);
  ctx.state.cards['played-trainer'] = { instanceId: 'played-trainer', owner: 0 };
  ctx.state.cards.payment = { instanceId: 'payment', owner: 0 };
  ctx.state.players[0].resolving = ['played-trainer']; ctx.state.players[0].discard = ['payment'];
  const before = clone(ctx);
  assert.deepEqual(planHandBottom(ctx, action()), { windows: [
    { owner: 0, hand: [], deck: ['old0'] }, { owner: 1, hand: [], deck: ['old1'] },
  ], performed: false });
  assert.deepEqual(ctx, before);
  ctx.state.players[1].hand.push('survivor');
  ctx.state.cards.survivor = { instanceId: 'survivor', owner: 1 };
  assert.equal(planHandBottom(ctx, action()).performed, true);
  assert.equal(planHandBottom(ctx, action('own')).performed, false);
});

test('plans and windows are detached plain caller JSON without mutating, freezing, normalizing or caching inputs', () => {
  const ctx = context(), a = action(), before = clone({ ctx, a });
  const windows = handBottomWindows(ctx, a), plan = planHandBottom(ctx, a);
  assert.equal(Object.isFrozen(ctx), false); assert.equal(Object.isFrozen(a), false);
  windows[0].hand.reverse(); windows[0].deck.pop(); plan.windows[1].hand.length = 0;
  assert.deepEqual({ ctx, a }, before);
  assert.deepEqual(planHandBottom(ctx, a), planHandBottom(clone(ctx), JSON.parse(JSON.stringify(a))));
  ctx.state.players[0].hand.pop();
  assert.equal(planHandBottom(ctx, a).windows[0].hand.length, 1);
  assert.equal(windows[0].hand.length, 2);
});

test('original arbitrary physical IDs and null-prototype records are preserved without sort, trim or prototype lookup', () => {
  const ctx = context(1, [['__proto__', 'constructor', 'toString'], ['z', '2', 'a', '1', ' 空白 ']], [[], []]);
  ctx.source = Object.assign(Object.create(null), ctx.source);
  ctx.state.cards = Object.assign(Object.create(null), ctx.state.cards);
  ctx.state.players[1] = Object.assign(Object.create(null), ctx.state.players[1]);
  const a = Object.assign(Object.create(null), action('own'));
  assert.equal(assertHandBottomAction(a), a); assert.equal(schemaAction(a), true);
  assert.deepEqual(planHandBottom(ctx, a), { windows: [
    { owner: 1, hand: ['z', '2', 'a', '1', ' 空白 '], deck: [] },
  ], performed: true });
  assert.deepEqual(handBottomWindows(ctx, action('opponent'))[0].hand, ['__proto__', 'constructor', 'toString']);
});

test('targeted hands/decks require exact physical identity, original owner and uniqueness across every requested zone', () => {
  const bad = [];
  for (const zone of ['hand', 'deck']) for (const mode of ['missing', 'wrongId', 'wrongOwner', 'duplicate']) {
    const ctx = context(), id = ctx.state.players[0][zone][0];
    if (mode === 'missing') delete ctx.state.cards[id];
    if (mode === 'wrongId') ctx.state.cards[id].instanceId = 'other-id';
    if (mode === 'wrongOwner') ctx.state.cards[id].owner = 1;
    if (mode === 'duplicate') ctx.state.players[0][zone].push(id);
    bad.push(ctx);
  }
  const crossZone = context(); crossZone.state.players[0].deck.push(crossZone.state.players[0].hand[0]); bad.push(crossZone);
  const crossOwner = context(); crossOwner.state.players[1].hand.push(crossOwner.state.players[0].hand[0]); bad.push(crossOwner);
  const crossDecks = context(); crossDecks.state.players[1].deck.push(crossDecks.state.players[0].deck[0]); bad.push(crossDecks);
  for (const ctx of bad) {
    error(() => handBottomWindows(ctx, action()), 'invalid-hand-bottom-context');
    error(() => planHandBottom(ctx, action()), 'invalid-hand-bottom-context');
  }
});

test('no definition, card face, current, RNG, unrelated card or unrequested player zone is ever read', () => {
  let calls = 0;
  const getter = { enumerable: true, get() { calls++; throw new Error('not a requested physical fact'); } };
  const ctx = context(1);
  for (const key of ['definitions', 'printings', 'catalog', 'approval']) Object.defineProperty(ctx, key, getter);
  for (const key of ['current', 'rng', 'history', 'serial']) Object.defineProperty(ctx.state, key, getter);
  for (const card of Object.values(ctx.state.cards)) for (const key of ['definitionId', 'printingId', 'face', 'name'])
    Object.defineProperty(card, key, getter);
  Object.defineProperty(ctx.state.cards, 'unrelated', getter);
  const own = planHandBottom(ctx, action('own'));
  assert.equal(own.windows[0].owner, 1);
  for (const key of ['hand', 'deck', 'active', 'bench']) Object.defineProperty(ctx.state.players[0], key, getter);
  assert.deepEqual(planHandBottom(ctx, action('own')), own);
  assert.equal(calls, 0);
});

test('action schema and pure assertions reject missing/default/extra sides, executable descriptors and non-plain records', () => {
  const bad = [
    undefined, null, false, 0, '', [], {}, { op: 'shuffleHandToBottom' }, { side: 'both' },
    ...['shuffleDeck', 'shuffleHandToDeck', '', null, false, 0].map((op) => ({ op, side: 'both' })),
    ...['self', 'all', 'current', '', null, false, 0, [], {}].map((side) => action(side)),
    ...['owner', 'selector', 'shuffle', 'reveal', 'draw', 'to', 'approved', 'performed', 'windows']
      .map((key) => ({ ...action(), [key]: true })),
  ];
  for (const a of bad) {
    assert.equal(schemaAction(a), false);
    error(() => assertHandBottomAction(a), 'invalid-hand-bottom-action');
    error(() => planHandBottom(context(), a), 'invalid-hand-bottom-action');
  }
  let calls = 0;
  const unsafe = [Object.create(action()), Object.assign(new (class Action {})(), action()),
    Object.assign(Object.create({}), action())];
  for (const key of ['op', 'side', 'extra']) {
    const accessor = action(); Object.defineProperty(accessor, key, {
      enumerable: true, get() { calls++; throw new Error('must not execute'); },
    }); unsafe.push(accessor);
    const hidden = action(); Object.defineProperty(hidden, key, { value: 'both', enumerable: false }); unsafe.push(hidden);
  }
  const symbolic = action(); symbolic[Symbol('extra')] = true; unsafe.push(symbolic);
  for (const a of unsafe) error(() => assertHandBottomAction(a), 'invalid-hand-bottom-action');
  assert.equal(calls, 0);
});

test('context requires explicit source owner, two real players and plain physical map; missing data never becomes an empty window', () => {
  const bad = [undefined, null, [], {}, { source: null }, { source: {} }];
  for (const owner of [undefined, null, false, true, '0', -1, 2, 0.5, NaN]) {
    const ctx = context(); ctx.source.owner = owner; bad.push(ctx);
  }
  for (const value of [undefined, null, false, [], {}]) {
    const ctx = context(); ctx.state = value; bad.push(ctx);
  }
  for (const value of [undefined, null, false, {}, [], [{}], [{}, {}, {}]]) {
    const ctx = context(); ctx.state.players = value; bad.push(ctx);
  }
  for (const value of [undefined, null, false, [], new Map()]) {
    const ctx = context(); ctx.state.cards = value; bad.push(ctx);
  }
  for (const value of [null, [], false, {}]) {
    const ctx = context(); ctx.state.players[0] = value; bad.push(ctx);
  }
  for (const ctx of bad) error(() => handBottomWindows(ctx, action('own')), 'invalid-hand-bottom-context');
});

test('all requested context descriptor paths reject inherited, hidden and getter facts without executing them', () => {
  let calls = 0;
  const paths = [
    ['source'], ['source', 'owner'], ['state'], ['state', 'players'], ['state', 'cards'],
    ['state', 'players', 0, 'hand'], ['state', 'players', 0, 'deck'],
    ['state', 'cards', 'p0:h0'], ['state', 'cards', 'p0:h0', 'instanceId'],
    ['state', 'cards', 'p0:h0', 'owner'],
  ];
  for (const path of paths) for (const mode of ['getter', 'hidden', 'inherited', 'class']) {
    let ctx = context(), parent = null, holder = ctx, previousKey = null;
    for (const key of path.slice(0, -1)) { parent = holder; previousKey = key; holder = holder[key]; }
    const key = path.at(-1), value = holder[key];
    if (mode === 'getter') Object.defineProperty(holder, key, {
      enumerable: true, get() { calls++; throw new Error('no context getter'); },
    });
    if (mode === 'hidden') Object.defineProperty(holder, key, { value, enumerable: false });
    if (mode === 'inherited' || mode === 'class') {
      const data = { ...holder }; delete data[key];
      const replacement = mode === 'inherited' ? Object.assign(Object.create({ [key]: value }), data) :
        Object.assign(new (class Record {})(), holder);
      if (parent) parent[previousKey] = replacement;
      else ctx = replacement;
    }
    error(() => planHandBottom(ctx, action('own')), 'invalid-hand-bottom-context');
  }
  assert.equal(calls, 0);
});

test('zone arrays reject holes, non-string IDs, duplicates, hidden/accessor elements and extended/non-ordinary arrays', () => {
  let calls = 0;
  const bad = [undefined, null, false, {}, new Array(1), ['a', 'a'], [''], [null], [false], [0], [[]], [{}], [1n]];
  const extra = ['a']; extra.extra = 1; bad.push(extra);
  const symbolic = ['a']; symbolic[Symbol('extra')] = true; bad.push(symbolic);
  const sparseWithExtra = new Array(1); sparseWithExtra.extra = 'a'; bad.push(sparseWithExtra);
  const inherited = ['a']; Object.setPrototypeOf(inherited, null); bad.push(inherited);
  bad.push(new (class IDs extends Array {})('a'));
  const hidden = ['a']; Object.defineProperty(hidden, '0', { value: 'a', enumerable: false }); bad.push(hidden);
  const getter = ['a']; Object.defineProperty(getter, '0', {
    enumerable: true, get() { calls++; throw new Error('no array getter'); },
  }); bad.push(getter);
  for (const zone of ['hand', 'deck']) for (const value of bad) {
    const ctx = context(); ctx.state.players[0][zone] = value;
    error(() => planHandBottom(ctx, action('own')), 'invalid-hand-bottom-context');
  }
  const players = context(); Object.defineProperty(players.state.players, '0', {
    enumerable: true, get() { calls++; throw new Error('no player getter'); },
  });
  error(() => handBottomWindows(players, action()), 'invalid-hand-bottom-context');
  assert.equal(calls, 0);
});

test('every hand permutation is conserved at the bottom while old deck draw order stays unchanged, including zero/singleton', () => {
  let checked = 0;
  for (const owner of [0, 1]) for (let n = 0; n <= 5; n++) for (const deck of [[], ['only'], ['bottom', 'middle', 'top']]) {
    const original = freeze(window(Array.from({ length: n }, (_, i) => `h${i}`), deck, owner));
    for (const shuffled of permutations(original.hand)) {
      freeze(shuffled);
      const deckAfter = freeze([...shuffled, ...original.deck]), handAfter = freeze([]);
      const before = clone({ original, shuffled, handAfter, deckAfter });
      assert.equal(assertHandBottomPermutation(original, shuffled), shuffled);
      assert.equal(assertHandBottomWindowPlacement(original, shuffled, handAfter, deckAfter), deckAfter);
      placementOracle(original, shuffled, deckAfter);
      assert.deepEqual({ original, shuffled, handAfter, deckAfter }, before); checked++;
    }
  }
  assert.equal(checked, 924);
});

test('both owners are shuffled independently without merging hands or modifying either old deck', () => {
  const ctx = freeze(context(1, [['a', 'b', 'c'], ['x', 'y', 'z']], [['old0b', 'old0t'], ['old1b', 'old1t']]));
  const plan = planHandBottom(ctx, action()), before = clone(ctx);
  assert.deepEqual(plan.windows.map((w) => w.owner), [1, 0]);
  let checked = 0;
  for (const first of permutations(['x', 'y', 'z'])) for (const second of permutations(['a', 'b', 'c'])) {
    for (const [i, shuffled] of [first, second].entries()) {
      const original = plan.windows[i], deckAfter = [...shuffled, ...original.deck];
      assertHandBottomWindowPlacement(original, shuffled, [], deckAfter);
      placementOracle(original, shuffled, deckAfter);
    }
    const all = [...first, ...second];
    assert.equal(new Set(all).size, 6); checked++;
  }
  assert.equal(checked, 36);
  error(() => assertHandBottomPermutation(plan.windows[0], ['a', 'b', 'c']), 'invalid-hand-bottom-permutation');
  error(() => assertHandBottomPermutation(plan.windows[0], ['x', 'y', 'z', 'a', 'b', 'c']), 'invalid-hand-bottom-permutation');
  assert.deepEqual(ctx, before);
});

test('permutation and placement reject loss, duplication, foreign cards, reversed/reshuffled old deck and uncleared hands', () => {
  const original = freeze(window()), shuffled = freeze(['h2', 'h0', 'h1']);
  for (const bad of [[], ['h0', 'h1'], ['h0', 'h1', 'other'], ['h0', 'h1', 'h1'],
    ['h0', 'h1', 'top'], ['h0', 'h1', 'h2', 'top'], null, false])
    error(() => assertHandBottomPermutation(original, bad), 'invalid-hand-bottom-permutation');
  for (const [handAfter, deckAfter] of [
    [['h0'], [...shuffled, ...original.deck]],
    [[], [...original.deck, ...shuffled]],
    [[], [...shuffled].reverse().concat(original.deck)],
    [[], [...shuffled, 'top', 'middle', 'bottom']],
    [[], [...shuffled, 'bottom', 'top', 'middle']],
    [[], [...shuffled, 'bottom', 'middle']],
    [[], [...shuffled, ...original.deck, 'extra']],
    [[], [...shuffled, ...original.deck, 'h0']],
    [null, [...shuffled, ...original.deck]],
    [[], null],
  ]) error(() => assertHandBottomWindowPlacement(original, shuffled, handAfter, deckAfter), 'invalid-hand-bottom-placement');
  // Conservation alone is insufficient: bind placement to the exact host RNG result.
  error(() => assertHandBottomWindowPlacement(original, shuffled, [],
    ['h0', 'h1', 'h2', ...original.deck]), 'invalid-hand-bottom-placement');
});

test('window helper gates reject untrusted shapes/descriptors, unsafe IDs and hand/deck overlaps before checking answers', () => {
  const bad = [
    undefined, null, false, [], {}, { ...window(), owner: 2 }, { ...window(), owner: false },
    { ...window(), hand: ['same'], deck: ['same'] }, { ...window(), hand: [0] },
    { ...window(), deck: ['x', 'x'] }, { ...window(), owner: 0, extra: true },
    Object.create(window()), Object.assign(new (class Window {})(), window()),
  ];
  for (const key of ['owner', 'hand', 'deck']) {
    const missing = window(); delete missing[key]; bad.push(missing);
  }
  let calls = 0;
  for (const key of ['owner', 'hand', 'deck', 'extra']) {
    const value = window(); Object.defineProperty(value, key, {
      enumerable: true, get() { calls++; throw new Error('no window getter'); },
    }); bad.push(value);
  }
  for (const original of bad) {
    error(() => assertHandBottomPermutation(original, []), 'invalid-hand-bottom-window');
    error(() => assertHandBottomWindowPlacement(original, [], [], []), 'invalid-hand-bottom-window');
  }
  assert.equal(calls, 0);
  const original = Object.assign(Object.create(null), window([], [], 1));
  assert.equal(assertHandBottomWindowPlacement(original, [], [], original.deck), original.deck);
});

test('plan schema requires explicit performed consistent with nonempty hands and rejects extra capabilities', () => {
  const empty = planHandBottom(context(0, [[], []], [[], []]), action());
  const nonempty = planHandBottom(context(), action());
  for (const good of [empty, nonempty]) {
    assert.equal(schemaPlan(good), true);
    assert.equal(schemaPlan({ ...good, performed: !good.performed }), false);
    assert.equal(schemaPlan({ ...good, performed: 1 }), false);
    assert.equal(schemaPlan({ ...good, approved: true }), false);
    const missing = clone(good); delete missing.performed; assert.equal(schemaPlan(missing), false);
  }
  for (const windows of [[], [window(), window(), window()], [window([], [], 2)], [{ ...window(), reveal: true }],
    [{ ...window(), hand: ['a', 'a'] }]]) assert.equal(schemaPlan({ windows, performed: true }), false);
  assert.equal(schemaPlan({ performed: false }), false);
});

test('prototype pollution cannot provide missing action side or source owner, and is always restored', () => {
  let calls = 0;
  const saved = new Map(['side', 'owner'].map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]));
  try {
    for (const key of saved.keys()) Object.defineProperty(Object.prototype, key, {
      configurable: true, get() { calls++; throw new Error('must not read prototype getter'); },
    });
    error(() => assertHandBottomAction({ op: 'shuffleHandToBottom' }), 'invalid-hand-bottom-action');
    const ctx = context(); delete ctx.source.owner;
    error(() => handBottomWindows(ctx, action()), 'invalid-hand-bottom-context');
    assert.equal(calls, 0);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete Object.prototype[key];
    }
  }
  for (const [key, descriptor] of saved) assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, key), descriptor);
});
