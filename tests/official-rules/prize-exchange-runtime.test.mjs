// Real OfficialGame integration with SYNTHETIC definitions/printings only.
// Heavy-Ball/Gladio-shaped actions do not approve any actual printing or source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { randomIndex } from '../../public/rules/random.js';
import { prizesTakenForPlayer } from '../../public/rules/prize-count.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, settle, hand, fixtureClock,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const action = (selector = { kind: 'any' }, revealSelected = false) => ({
  op: 'exchangePrizes', selector, revealSelected,
});
const basic = () => ({ kind: 'pokemon', stages: ['basic'] });
const prizeNames = ['other', 'evolution', 'water', 'water', 'double', 'tool'];
const ids = (cards) => cards.map((card) => card.instanceId);
const ref = (s, id) => ({
  instanceId: id, printingId: s.cards[id].printingId, definitionId: s.cards[id].definitionId,
});
const count = (values, id) => values.filter((value) => value === id).length;
const shuffles = (s, from) => s.events.slice(from).filter((event) => event.ruleId === 'effects.shuffle');
const restore = (snapshot, f) => OfficialGame.restore(clone(snapshot), { catalog: f.catalog });
const play = (g, cardId) => command(g, { type: 'playTrainer', cardId });
const earned = (g, owner) => prizesTakenForPlayer(
  { state: g.snapshot() }, { player: owner, deckSize: 60 },
);

async function make(spec = action(), { trainer = 'potion', transform = () => {} } = {}) {
  return fixture((defs) => {
    defs.find((definition) => definition.definitionId === trainer).mechanics.effects = [
      binding('cn.prizeExchange@1', spec, 'prize-exchange'),
    ];
    transform(defs);
  });
}

// Relocate existing physical cards only; never fabricate IDs or omit a card.
function setPrizes(s, owner, names) {
  const p = s.players[owner];
  p.deck.push(...p.prizes.splice(0));
  for (const name of names) {
    const id = hand(s, owner, name);
    p.hand.pop(); p.prizes.push(id);
  }
  return [...p.prizes];
}
function setup(f, { owner = 0, trainer = 'potion', names = prizeNames, seed, mutate = () => {} } = {}) {
  let sourceId, prizes;
  const g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    sourceId = hand(s, owner, trainer);
    prizes = setPrizes(s, owner, names);
    // Isolate hidden-information checks from legitimate setup/mulligan reveals.
    s.events = [];
    mutate(s, sourceId, prizes);
    if (seed) s.rng = [...seed];
  });
  return { g, sourceId, prizes };
}

function assertAtomic(g, fn, predicate) {
  const saved = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(fn, predicate);
  assert.deepEqual(g.snapshot(), saved, 'A rejected command cannot move cards, consume RNG, log work or advance revision.');
  assert.deepEqual([g.view(0), g.view(1)], views);
}
function strings(value, out = new Set()) {
  if (typeof value === 'string') out.add(value);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { out.add(key); strings(child, out); }
  }
  return out;
}
function cardLocations(s, owner) {
  const p = s.players[owner];
  return ['deck', 'hand', 'prizes', 'discard', 'lost', 'resolving'].flatMap((zone) => p[zone])
    .concat([p.active, ...p.bench].filter(Boolean).flatMap((m) => [...m.stack, ...m.energy, ...m.tools]))
    .concat(s.stadium && s.cards[s.stadium].owner === owner ? [s.stadium] : []);
}
function assertConserved(before, after) {
  assert.deepEqual(after.cards, before.cards, 'No definition/printing/physical-card metadata is rewritten.');
  for (const owner of [0, 1]) {
    assert.equal(cardLocations(after, owner).length, 60);
    assert.deepEqual(cardLocations(after, owner).sort(), cardLocations(before, owner).sort());
    assert.equal(new Set(cardLocations(after, owner)).size, 60);
  }
}
function assertRestored(g, f) {
  const saved = g.snapshot(), restored = restore(saved, f);
  assert.deepEqual(restored.snapshot(), saved);
  assert.deepEqual([restored.view(0), restored.view(1)], [g.view(0), g.view(1)]);
  return restored;
}
function assertNoHostState(view) {
  for (const key of ['cards', 'queue', 'rng', 'attack']) assert(!Object.hasOwn(view, key));
  for (const p of view.players) {
    assert(!Object.hasOwn(p, 'deck'));
    assert.deepEqual(Object.keys(p.prizes), ['count'], 'Prize positions and IDs are never player-visible.');
  }
  assert(!view.events.some((event) => event.visibility === 'private'));
}
function assertSelected(g, before, sourceId, selected, owner) {
  const after = g.snapshot(), p = after.players[owner];
  assert.equal(after.pending, null); assert.equal(after.phase, 'main'); assert.equal(after.result, null);
  assert.deepEqual(p.hand, before.players[owner].hand.filter((id) => id !== sourceId).concat(selected));
  assert.equal(p.prizes.length, before.players[owner].prizes.length);
  assert.equal(count(p.prizes, sourceId), selected.length);
  assert.equal(count(p.discard, sourceId), selected.length ? 0 : 1);
  assert(!p.resolving.includes(sourceId));
  for (const id of selected) { assert(!p.prizes.includes(id)); assert.equal(count(p.hand, id), 1); }
  assertConserved(before, after);
}

// Independent Fisher-Yates oracle; do not call the production zone/subset helper.
function shuffled(values, initialRng) {
  const order = [...values], rng = [...initialRng];
  for (let n = order.length; n > 1; n--) {
    const i = randomIndex(rng, n);
    [order[n - 1], order[i]] = [order[i], order[n - 1]];
  }
  return { order, rng };
}

test('native prizeExchange takes the entire strict action and never accepts a generic cards/wrapper/approval protocol', () => {
  const h = createCoreHandlers().get('cn.prizeExchange@1'), spec = action(basic(), true);
  assert(h);
  assert.equal(h.timing, 'resolve'); assert.deepEqual(h.operations, ['exchangePrizes']);
  assert.equal(h.parameterSchemaRef, 'urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/prizeExchange');
  assert(h.validateParameters(spec)); assert.deepEqual(h.execute({}, spec), [spec]);
  for (const invalid of [
    { action: spec }, { ...spec, op: 'cards' }, { ...spec, from: 'prizes' }, { ...spec, side: 'opponent' },
    { ...spec, sourceCard: 'invented' }, { ...spec, quantity: { kind: 'upTo', count: 1 } },
    { ...spec, approved: true }, { ...spec, reveal: true },
    { op: 'exchangePrizes', selector: { kind: 'any' } },
  ]) assert(!h.validateParameters(invalid), JSON.stringify(invalid));
});

test('Heavy-Ball-shaped Item inspects all own Prizes, filters printed basic Pokémon, and exchanges only the resolving source without earning a Prize', async () => {
  const f = await make(action(basic(), true));
  for (const owner of [0, 1]) {
    let { g, sourceId, prizes } = setup(f, { owner });
    const before = g.snapshot(), earnedBefore = earned(g, owner);
    g = assertRestored(g, f); play(g, sourceId);
    const s = g.snapshot(), q = s.pending;
    assert.equal(q.kind, 'prize-exchange'); assert.equal(q.player, owner);
    assert.deepEqual(q.options, [prizes[0]]); assert.equal(q.minimum, 0); assert.equal(q.maximum, 1); assert(q.allowZero);
    assert.deepEqual(g.view(owner).pending.lookedAt, prizes.map((id) => ref(s, id)));
    assert.equal(g.view(1 - owner).pending, null);
    assert.deepEqual(s.players[owner].prizes, prizes); assert.deepEqual(s.rng, before.rng);
    assert(s.players[owner].resolving.includes(sourceId)); assert(!s.players[owner].discard.includes(sourceId));
    assert(!s.players[owner].hand.includes(sourceId));
    g = assertRestored(g, f); answer(g, [prizes[0]]); settle(g);
    assertSelected(g, before, sourceId, [prizes[0]], owner);
    assert.equal(earned(g, owner), earnedBefore);
    assert.deepEqual(g.snapshot().battleHistory, before.battleHistory);
    assert(!g.snapshot().events.slice(before.events.length).some((event) =>
      event.ruleId === 'ko.boundary' || event.ruleId === 'trigger.before-hand'));
    for (const viewer of [0, 1]) {
      const disclosed = strings(g.view(viewer));
      assert(disclosed.has(prizes[0]), 'The selected basic Pokémon is explicitly revealed.');
      for (const id of prizes.slice(1)) assert(!disclosed.has(id), 'Inspecting all Prizes is private, even with revealSelected.');
      assertNoHostState(g.view(viewer));
    }
    assertRestored(g, f);
  }
});

test('Gladio-shaped Supporter forces one arbitrary card; both actors and reveal modes preserve private windows and conceal the replaced Prize location after restore', async () => {
  for (const owner of [0, 1]) for (const reveal of [false, true]) {
    const f = await make(action({ kind: 'any' }, reveal), { trainer: 'research' });
    let { g, sourceId, prizes } = setup(f, { owner, trainer: 'research' });
    const before = g.snapshot();
    play(g, sourceId);
    const pending = g.snapshot();
    assert.equal(pending.pending.kind, 'prize-exchange'); assert.equal(pending.pending.player, owner);
    assert.deepEqual(pending.pending.options, prizes);
    assert.equal(pending.pending.minimum, 1); assert.equal(pending.pending.maximum, 1); assert(!pending.pending.allowZero);
    assert(pending.players[owner].flags.supporter);
    assert.deepEqual(ids(g.view(owner).pending.lookedAt), prizes);
    assert.equal(g.view(1 - owner).pending, null);
    assertAtomic(g, () => answer(g, []));
    for (const viewer of [0, 1]) {
      assertNoHostState(g.view(viewer));
      if (viewer !== owner) for (const id of prizes) assert(!strings(g.view(viewer)).has(id));
    }
    g = assertRestored(g, f); answer(g, [prizes[4]]); settle(g);
    assertSelected(g, before, sourceId, [prizes[4]], owner);
    assert.equal(earned(g, owner), 0);
    for (const viewer of [0, 1]) {
      const view = g.view(viewer), disclosed = strings(view);
      assert.equal(view.pending, null); assertNoHostState(view);
      assert.equal(disclosed.has(prizes[4]), viewer === owner || reveal);
      for (const id of prizes.filter((id) => id !== prizes[4]))
        assert(!disclosed.has(id), 'Neither player keeps the looked-at window/new Prize order in history.');
      assert(!JSON.stringify(view).includes(JSON.stringify(g.snapshot().players[owner].prizes)));
    }
    assertRestored(g, f);
  }
});

test('a specific hidden selector may choose zero with or without a match; all original Prizes still shuffle and the source discards exactly once', async () => {
  const f = await make(action(basic(), true));
  for (const matches of [false, true]) {
    const names = matches ? prizeNames : ['water', 'water', 'double', 'evolution', 'tool', 'hp-tool'];
    let { g, sourceId, prizes } = setup(f, { names });
    const before = g.snapshot(), expected = shuffled(prizes, before.rng);
    play(g, sourceId);
    assert.equal(g.snapshot().pending.minimum, 0); assert.equal(g.snapshot().pending.maximum, matches ? 1 : 0);
    assert(g.snapshot().pending.allowZero);
    assert.deepEqual(g.snapshot().pending.options, matches ? [prizes[0]] : []);
    assert.deepEqual(ids(g.view(0).pending.lookedAt), prizes);
    g = assertRestored(g, f); answer(g, []); settle(g);
    assertSelected(g, before, sourceId, [], 0);
    assert.deepEqual(g.snapshot().players[0].prizes, expected.order);
    assert.deepEqual(g.snapshot().rng, expected.rng); assert.notDeepEqual(expected.rng, before.rng);
    assert.deepEqual(g.snapshot().players[0].deck, before.players[0].deck);
    const events = shuffles(g.snapshot(), before.events.length);
    assert.equal(events.length, 1); assert.equal(events[0].data.zone, 'prizes'); assert.equal(events[0].data.count, 6);
    for (const viewer of [0, 1]) {
      assertNoHostState(g.view(viewer));
      for (const id of prizes) assert(!strings(g.view(viewer)).has(id));
    }
    assertRestored(g, f);
  }
});

test('one Prize exchanges or fails a specific filter without inventing a card; a singleton counts as shuffled and an empty Prize pool is not playable', async () => {
  for (const specific of [false, true]) {
    const f = await make(action(specific ? basic() : { kind: 'any' }));
    let { g, sourceId, prizes } = setup(f, { names: ['water'] });
    const before = g.snapshot(); play(g, sourceId);
    const q = g.snapshot().pending;
    assert.equal(q.kind, 'prize-exchange'); assert.equal(q.minimum, specific ? 0 : 1); assert.equal(q.maximum, specific ? 0 : 1);
    assert.deepEqual(ids(g.view(0).pending.lookedAt), prizes);
    g = assertRestored(g, f); answer(g, specific ? [] : prizes); settle(g);
    assertSelected(g, before, sourceId, specific ? [] : prizes, 0);
    assert.deepEqual(g.snapshot().players[0].prizes, specific ? prizes : [sourceId]);
    assert.deepEqual(g.snapshot().rng, before.rng, 'Singleton shuffle consumes no RNG words, not even when the source replaces the Prize.');
    const events = shuffles(g.snapshot(), before.events.length);
    assert.equal(events.length, 1); assert.equal(events[0].data.zone, 'prizes'); assert.equal(events[0].data.count, 1);
    assertRestored(g, f);
  }
  const f = await make();
  const { g, sourceId } = setup(f, { names: [] });
  assert(!g.view(0).legalActions.some((entry) => entry.type === 'playTrainer' && entry.cardId === sourceId));
  assertAtomic(g, () => play(g, sourceId));
});

test('real RNG randomizes only the Prize pool; deck/unselected zones and metadata are conserved and no ordered shuffle receipt is exposed', async () => {
  const f = await make(), sourcePositions = new Set();
  for (let i = 1; i <= 16; i++) {
    const seed = [i, Math.imul(i, 0x9e3779b9) >>> 0, i * 3, i * 5];
    const { g, sourceId, prizes } = setup(f, { seed });
    const before = g.snapshot(), selected = prizes[2];
    const expected = shuffled(prizes.map((id) => id === selected ? sourceId : id), before.rng);
    play(g, sourceId); answer(g, [selected]); settle(g);
    const after = g.snapshot(), p = after.players[0];
    assertSelected(g, before, sourceId, [selected], 0);
    assert.deepEqual([...p.prizes].sort(), prizes.filter((id) => id !== selected).concat(sourceId).sort());
    assert.deepEqual(p.prizes, expected.order, 'Replace the selected slot, then shuffle the complete Prize pool using actual RNG.');
    assert.deepEqual(after.rng, expected.rng, 'Only a six-card Prize shuffle consumes RNG.');
    assert.deepEqual(p.deck, before.players[0].deck); assert.deepEqual(after.players[1], before.players[1]);
    assert.deepEqual(p.discard, before.players[0].discard); assert.deepEqual(p.lost, before.players[0].lost);
    sourcePositions.add(p.prizes.indexOf(sourceId));
    const events = shuffles(after, before.events.length);
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0].data).sort(), ['count', 'effectId', 'player', 'zone']);
    assert.equal(events[0].data.zone, 'prizes'); assert.equal(events[0].data.count, prizes.length);
    for (const viewer of [0, 1]) {
      const view = g.view(viewer); assertNoHostState(view);
      assert(!JSON.stringify(view).includes(JSON.stringify(p.prizes)));
      for (const id of prizes.filter((id) => id !== selected)) assert(!strings(view).has(id));
    }
  }
  assert(sourcePositions.size > 1, 'Source replacement must not have a fixed known post-shuffle slot.');
});

test('invalid, duplicate, foreign, outside-window and replayed answers reject atomically; a successful exchange finalizer never pulls the source out of Prizes', async () => {
  const f = await make(action(basic(), true));
  let { g, sourceId, prizes } = setup(f);
  const before = g.snapshot(); play(g, sourceId);
  const pending = g.snapshot(), q = pending.pending;
  for (const selected of [
    [prizes[0], prizes[0]], [prizes[0], prizes[1]], [prizes[1]], [sourceId],
    [before.players[0].deck[0]], [before.players[1].prizes[0]], ['not-a-card'],
  ]) assertAtomic(g, () => answer(g, selected));
  assertAtomic(g, () => command(g, { type: 'answer', requestId: q.id, selected: [prizes[0]] }, 1));
  assertAtomic(g, () => command(g, { type: 'answer', requestId: `${q.id}-stale`, selected: [prizes[0]] }));
  g = assertRestored(g, f); answer(g, [prizes[0]]); settle(g);
  assertSelected(g, before, sourceId, [prizes[0]], 0);
  assert.equal(count(g.snapshot().players[0].prizes, sourceId), 1);
  assertAtomic(g, () => command(g, { type: 'answer', requestId: q.id, selected: [prizes[0]] }));
  g = assertRestored(g, f);
  assert.equal(count(g.snapshot().players[0].prizes, sourceId), 1);
  assert.equal(count(g.snapshot().players[0].discard, sourceId), 0);
});

test('restore binds the untouched Prize window, eligible choices, rule source, turn, source card, exact quantity and unique host-only request/finalizer', async () => {
  const f = await make(action(basic(), true));
  const { g, sourceId, prizes } = setup(f);
  play(g, sourceId);
  const saved = g.snapshot(), c = saved.pending.data.prizeChoice;
  assert(c); assert.deepEqual(c.prizes, prizes); assert.equal(c.sourceId, sourceId); assert.equal(c.turn, saved.turn);
  const requestIndex = saved.events.findIndex((event) =>
    event.ruleId === 'effects.prize-exchange' && event.data.kind === 'requested');
  assert(requestIndex >= 0); assert.equal(saved.events[requestIndex].visibility, 'private');
  const finalizer = saved.queue.find((task) => task.op === 'finish-trainer' && task.data.cardId === sourceId);
  assert(finalizer); assert.equal(c.completion.kind, 'trainer'); assert.equal(c.completion.id, finalizer.data.completionId);

  const mutations = [
    ['missing choice', (s) => { delete s.pending.data.prizeChoice; }],
    ['saved window', (s) => { s.pending.data.prizeChoice.prizes.reverse(); }],
    ['live window', (s) => { s.players[0].prizes.reverse(); }],
    ['eligible options', (s) => { s.pending.options.push(prizes[1]); }],
    ['selector', (s) => { s.pending.data.action.selector = { kind: 'any' }; }],
    ['rule source', (s) => { s.pending.data.source.sourceOfTruth[0].locator = 'forged'; }],
    ['choice turn', (s) => { s.pending.data.prizeChoice.turn++; }],
    ['sourceCard', (s) => { s.pending.data.prizeChoice.sourceId = prizes[1]; }],
    ['source identity', (s) => { s.pending.data.source.instanceId = prizes[5]; }],
    ['source owner', (s) => { s.pending.data.source.owner = 1; }],
    ['source origin', (s) => { s.pending.data.source.origin = 'field'; }],
    ['source outside resolving', (s) => {
      const p = s.players[0]; p.resolving.splice(p.resolving.indexOf(sourceId), 1); p.hand.push(sourceId);
    }],
    ['minimum', (s) => { s.pending.minimum = 1; }],
    ['maximum', (s) => { s.pending.maximum = 0; s.pending.options = []; }],
    ['zero permission', (s) => { s.pending.allowZero = false; }],
    ['prompt player', (s) => { s.pending.player = 1; }],
    ['prompt kind', (s) => { s.pending.kind = 'select-cards'; }],
    ['prompt rule', (s) => { s.pending.ruleId = 'effects.search'; }],
    ['local work', (s) => { s.pending.data.local = true; }],
    ['preselected answer', (s) => { s.pending.data.selected = [prizes[0]]; }],
    ['missing original request', (s) => { s.events.splice(requestIndex, 1); }],
    ['duplicate original request', (s) => { s.events.push(clone(s.events[requestIndex])); }],
    ['request turn', (s) => { s.events[requestIndex].data.choice.turn++; }],
    ['completion identity', (s) => { s.pending.data.prizeChoice.completion.id = 'wrong-completion'; }],
    ['missing finalizer', (s) => { s.queue = s.queue.filter((task) => task.op !== 'finish-trainer'); }],
    ['duplicate finalizer', (s) => { s.queue.push(clone(finalizer)); }],
    ['replayed queued work', (s) => { s.queue.unshift({ op: s.pending.resume, data: clone(s.pending.data) }); }],
  ];
  for (const visibility of ['public', 0, 1]) mutations.push([
    `original request visibility ${visibility}`, (s) => { s.events[requestIndex].visibility = visibility; },
  ]);
  const acceptedTampering = [];
  for (const [label, mutate] of mutations) {
    const bad = clone(saved); mutate(bad); const originalBad = clone(bad);
    let rejected = false;
    try { OfficialGame.restore(bad, { catalog: f.catalog }); } catch { rejected = true; }
    if (!rejected) acceptedTampering.push(label);
    assert.deepEqual(bad, originalBad, `${label}: restoring must not repair/mutate the caller input`);
    assert.deepEqual(g.snapshot(), saved, label);
  }
  const complete = assertRestored(g, f); answer(complete, [prizes[0]]); settle(complete);
  const completed = complete.snapshot(), hostIndices = completed.events.flatMap((event, i) =>
    event.ruleId === 'effects.prize-exchange' && ['requested', 'resolved'].includes(event.data.kind) ? [i] : []);
  assert.equal(hostIndices.length, 2);
  for (const index of hostIndices) for (const visibility of ['public', 0, 1]) {
    const bad = clone(completed); bad.events[index].visibility = visibility;
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }),
      undefined, 'Historical full-Prize request and exact swap identity remain host-only after completion.');
  }
  assertRestored(complete, f);
  assert.deepEqual(acceptedTampering, [], 'Every independently tampered snapshot must be rejected.');
});

test('E31 Prize-before-hand interaction is needsRuling before moving cards/RNG; an unselected affected card or draw-only descriptor does not block an ordinary exchange', async () => {
  for (const origin of ['prizes', 'draw']) {
    const f = await make(action(), { transform: (defs) => {
      defs[1].mechanics.abilities.push({
        abilityId: 'incoming', name: '测试未裁定的奖赏入手前交互', mode: 'triggered', usage: null,
        trigger: { event: 'beforeHand', origin, turn: 'own', drawReason: 'any', optional: true, afterUse: 'hand' },
        effects: [binding('cn.draw@1', { count: 1 })], sourceOfTruth: EVIDENCE,
      });
    } });
    let { g, sourceId, prizes } = setup(f);
    const before = g.snapshot(); play(g, sourceId);
    assert.equal(g.snapshot().pending.kind, 'prize-exchange');
    if (origin === 'prizes') {
      assertAtomic(g, () => answer(g, [prizes[0]]), { code: 'unresolved-prize-before-hand' });
      g = assertRestored(g, f);
      assert.equal(g.snapshot().pending.kind, 'prize-exchange');
      answer(g, [prizes[2]]);
      assertSelected(g, before, sourceId, [prizes[2]], 0);
    } else {
      g = assertRestored(g, f); answer(g, [prizes[0]]);
      assertSelected(g, before, sourceId, [prizes[0]], 0);
    }
    settle(g);
    assert(!g.snapshot().events.some((event) => event.ruleId === 'trigger.before-hand'));
    assertRestored(g, f);
  }
});
