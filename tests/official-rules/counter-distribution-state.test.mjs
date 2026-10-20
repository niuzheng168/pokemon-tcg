// CN C07 numeric allocation/state regressions against the real OfficialGame.
// Every card, printing and approval is synthetic; these are not real-card approvals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, playerView } from '../../public/rules/game.js';
import {
  fixture, binding, EVIDENCE, board, fixtureClock, hand, bench, command, answer, settle,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const RULE = 'damage.counter-distribution';
const TRACE = 'effects.execution';
const spec = (extra = {}) => ({
  op: 'distributeCounters', side: 'own', target: 'any', selector: { kind: 'pokemon' },
  count: 4, ...extra,
});
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const events = (s, kind) => s.events.filter((e) => e.ruleId === RULE && e.data.kind === kind);
const contains = (value, needle) => value === needle || !!value && typeof value === 'object' &&
  Object.values(value).some((child) => contains(child, needle));
const pause = {
  rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
  operations: ['optional', 'draw'], validateParameters: (p) => Object.keys(p).length === 0,
  execute: () => [{ op: 'optional', effect: { op: 'draw', count: 1 } }],
};
const thenDistribute = {
  rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
  operations: ['then', 'distributeCounters', 'draw'],
  validateParameters: (p) => p.op === 'distributeCounters',
  execute: (_ctx, p) => [{ op: 'then', first: p, next: { op: 'draw', count: 1 } }],
};
// Declaring an embedded capability must trigger tracking even when the current
// handler program only opens an optional control node, not a distribution leaf.
const embeddedOnly = {
  ...pause, embeddedOperations: ['distributeCounters'],
};
async function make({ action = spec(), mode = 'native', protection = null, recover = false } = {}) {
  return fixture((defs) => {
    const own = binding(mode === 'then' ? 'fixture:counter-then' : 'cn.distributeCounters@1',
      action, 'counter:source');
    defs.find((d) => d.definitionId === 'potion').mechanics.effects =
      mode === 'gated' ? [binding('fixture:counter-pause', {}, 'counter:pause'), own] :
        mode === 'embedded' ? [binding('fixture:counter-embedded', {}, 'counter:embedded')] : [own];
    // An independently valid catalog binding is not this physical Item's binding.
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [
      binding('cn.distributeCounters@1', action, 'counter:foreign'),
    ];
    if (protection) for (const id of protection === 'all' ? ['base', 'other'] : ['other']) {
      defs.find((d) => d.definitionId === id).mechanics.effects.push(binding('cn.protection@1', { effect: {
        op: 'protection', useRule: 'ordinary', channel: 'effects', scope: 'self', from: 'all', categories: ['trainer'],
      } }, `counter:protection:${id}`));
    }
    if (recover) defs[0].mechanics.abilities.push({
      abilityId: 'recover-counter-source', name: '测试取回伤害指示物来源', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: 'recover-counter-source', limit: 1 },
      sourceOfTruth: EVIDENCE,
      effects: [binding('cn.cards@1', {
        from: 'discard', to: 'hand', selector: { kind: 'trainer', nameKeys: ['potion'] },
        quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false,
      }, 'counter:recover')],
    });
  }, new Map([
    ['fixture:counter-pause', pause], ['fixture:counter-then', thenDistribute],
    ['fixture:counter-embedded', embeddedOnly],
  ]));
}
function setup(f, { owner = 0, side = 'own', counters = [1, 2, 3] } = {}) {
  let sourceId, targets;
  const g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    sourceId = hand(s, owner, 'potion');
    const recipient = side === 'own' ? owner : 1 - owner;
    targets = [s.players[recipient].active, bench(s, recipient, 'other'), bench(s, recipient, 'other')];
    targets.forEach((m, i) => { m.counters = counters[i]; });
    targets = targets.map((m) => m.id);
  });
  const before = g.snapshot();
  conservation(before, before.cards);
  command(g, { type: 'playTrainer', cardId: sourceId }, owner);
  return { g, sourceId, targets, before };
}
function conservation(s, cards) {
  assert.deepEqual(s.cards, cards, 'No card metadata or physical identity may be invented or rewritten.');
  const all = [];
  for (const owner of [0, 1]) {
    const p = s.players[owner], ids = ['deck', 'hand', 'discard', 'prizes', 'lost', 'resolving'].flatMap((z) => p[z]);
    ids.push(...mons(s, owner).flatMap((m) => [...m.stack, ...m.energy, ...m.tools]));
    if (s.stadium && s.cards[s.stadium].owner === owner) ids.push(s.stadium);
    assert.equal(ids.length, 60); assert.equal(new Set(ids).size, 60);
    assert.deepEqual(new Set(ids), new Set(Object.keys(cards).filter((id) => cards[id].owner === owner)));
    all.push(...ids);
  }
  assert.equal(new Set(all).size, 120);
}
function restore(g, f) {
  const saved = g.snapshot(), r = OfficialGame.restore(clone(saved), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), saved);
  assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  conservation(r.snapshot(), saved.cards);
  return r;
}
function atomic(g, fn, label, predicate = undefined) {
  const before = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(fn, predicate, label);
  assert.deepEqual(g.snapshot(), before, `${label}: no counters, RNG, facts, queue, receipts, revision or cards may change.`);
  assert.deepEqual([g.view(0), g.view(1)], views, label);
  conservation(g.snapshot(), before.cards);
}
function rejectCases(g, f, changes) {
  const saved = g.snapshot(), views = [g.view(0), g.view(1)], accepted = [];
  for (const [label, mutate] of changes) {
    const bad = clone(saved); mutate(bad); const supplied = clone(bad);
    let rejected = false;
    try { OfficialGame.restore(bad, { catalog: f.catalog }); } catch { rejected = true; }
    if (!rejected) accepted.push(label);
    assert.deepEqual(bad, supplied, `${label}: reject, never repair or mutate supplied saved state.`);
    assert.deepEqual(g.snapshot(), saved, label);
    assert.deepEqual([g.view(0), g.view(1)], views, label);
  }
  conservation(g.snapshot(), saved.cards);
  assert.deepEqual(accepted, [], 'No independently forged distribution continuation may be restored.');
}
function allocate(g, allocations, overrides = {}) {
  const s = g.snapshot(), q = s.pending;
  assert(q, 'The test must answer an actual pending request.');
  return g.dispatch({
    player: q.player, expectedRevision: s.revision,
    action: { type: 'allocateCounters', requestId: q.id, allocations }, ...overrides,
  });
}
function request(s) {
  const id = s.pending.data.counterChoice.id;
  const found = events(s, 'requested').filter((e) => e.data.id === id);
  assert.equal(found.length, 1); return found[0];
}
function token(s) {
  const id = s.pending.data.programId;
  assert.equal(typeof id, 'string'); assert(id.length > 0);
  return id;
}
function trace(s, id = token(s)) {
  const entries = s.events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.ruleId === TRACE && event.data.id === id);
  const scheduled = entries.find(({ event }) => event.data.kind === 'scheduled');
  const opened = entries.find(({ event }) => event.data.kind === 'opened');
  assert(scheduled, 'The actual catalog binding must have a scheduled receipt.');
  assert(opened, 'A started program must have an opened receipt.');
  return { id, entries, scheduled, opened };
}
function noDamageOrHealing(before, after) {
  assert.deepEqual(after.battleHistory, before.battleHistory,
    'Nonlethal Item allocation is neither an attack nor a heal and cannot create their usage/history facts.');
  assert.deepEqual(after.rng, before.rng);
  assert.equal(after.attack, null);
  for (const owner of [0, 1]) {
    assert.deepEqual(after.players[owner].deck, before.players[owner].deck);
    assert.deepEqual(after.players[owner].prizes, before.players[owner].prizes);
    for (const m of mons(after, owner)) {
      const old = mons(before, owner).find((oldMon) => oldMon.id === m.id);
      assert.deepEqual(m.facts, old.facts); assert.deepEqual(m.used, old.used);
    }
  }
  const added = after.events.slice(before.events.length);
  assert(!added.some((e) => ['attack.order', 'attack.used', 'damage.expression', 'effects.heal-results'].includes(e.ruleId)));
  conservation(after, before.cards);
}

test('both actors and own/opponent allocations preserve the full numeric window, RNG and counters until a complete answer survives JSON restore', async () => {
  for (const owner of [0, 1]) for (const side of ['own', 'opponent']) {
    const action = spec({ side }), f = await make({ action });
    const { g, sourceId, targets, before } = setup(f, { owner, side });
    const s = g.snapshot(), q = s.pending, c = q.data.counterChoice, recipient = side === 'own' ? owner : 1 - owner;
    assert.equal(q.kind, 'counter-allocation'); assert.equal(q.ruleId, RULE); assert.equal(q.player, owner);
    assert.deepEqual(q.options, targets); assert.equal(q.minimum, 0); assert.equal(q.maximum, 3); assert.equal(q.allowZero, true);
    assert(!Object.hasOwn(q, 'allocations')); assert(!Object.hasOwn(q.data, 'allocations')); assert(!Object.hasOwn(q.data, 'selected'));
    assert.deepEqual(c, { id: c.id, turn: before.turn, sourceId,
      targets: mons(before, recipient).map((m) => ({ pokemonId: m.id, topCardId: m.stack.at(-1), counters: m.counters })) });
    assert.deepEqual(mons(s, recipient).map((m) => m.counters), [1, 2, 3]);
    assert.deepEqual(s.rng, before.rng); assert.deepEqual(s.battleHistory, before.battleHistory);
    assert(s.players[owner].resolving.includes(sourceId));
    assert.equal(request(s).visibility, 'public'); assert.deepEqual(request(s).data.action, action);
    assert.deepEqual(request(s).data.choice, c);
    assert.deepEqual(trace(s).opened.event.data.program, [action]);
    const direct = restore(g, f), roundTrip = restore(restore(g, f), f);
    const allocations = [{ pokemonId: targets[2], count: 1 }, { pokemonId: targets[0], count: 3 }];
    for (const game of [direct, roundTrip]) { allocate(game, allocations); settle(game); }
    assert.deepEqual(roundTrip.snapshot(), direct.snapshot(), 'Restoring does not restart the effect or consume another random draw.');
    const after = direct.snapshot();
    assert.equal(after.pending, null); assert.equal(after.phase, 'main');
    assert.deepEqual(mons(after, recipient).map((m) => m.counters), [4, 2, 4]);
    assert.equal(after.players[owner].discard.filter((id) => id === sourceId).length, 1);
    assert.equal(events(after, 'requested').length, 1); assert.equal(events(after, 'resolved').length, 1);
    const result = events(after, 'resolved')[0].data;
    assert.equal(result.selectedTotal, 4); assert.equal(result.placedTotal, 4);
    assert.equal(result.preventedTotal, 0); assert.equal(result.performed, true);
    noDamageOrHealing(before, after); restore(direct, f);
  }
});

test('too few/many/empty, nonpositive, fractional, unsafe, duplicate and foreign numeric allocations reject without any partial placement', async () => {
  const f = await make(), { g, targets, before } = setup(f), [a, b] = targets;
  const cases = [
    ['empty', []], ['short sum', [{ pokemonId: a, count: 3 }]], ['excess sum', [{ pokemonId: a, count: 5 }]],
    ['zero entry', [{ pokemonId: a, count: 4 }, { pokemonId: b, count: 0 }]],
    ['negative offset', [{ pokemonId: a, count: 5 }, { pokemonId: b, count: -1 }]],
    ['fractional exact sum', [{ pokemonId: a, count: 1.5 }, { pokemonId: b, count: 2.5 }]],
    ['duplicate exact sum', [{ pokemonId: a, count: 2 }, { pokemonId: a, count: 2 }]],
    ['unknown Pokémon', [{ pokemonId: 'fixture:missing-pokemon', count: 4 }]],
    ['opposing Pokémon', [{ pokemonId: before.players[1].active.id, count: 4 }]],
    ['physical card not Pokémon', [{ pokemonId: before.players[0].active.stack.at(-1), count: 4 }]],
    ['missing count', [{ pokemonId: a }]], ['extra data', [{ pokemonId: a, count: 4, selected: true }]],
    ['numeric string', [{ pokemonId: a, count: '4' }]], ['boolean', [{ pokemonId: a, count: true }]],
    ['unsafe', [{ pokemonId: a, count: Number.MAX_SAFE_INTEGER + 1 }]],
    ['counter bound', [{ pokemonId: a, count: 900719925474100 }]],
    ['infinity', [{ pokemonId: a, count: Infinity }]], ['NaN', [{ pokemonId: a, count: NaN }]],
    ['not an array', { [a]: 4 }], ['string array', [a]], ['null', null],
  ];
  for (const [label, allocations] of cases) atomic(g, () => allocate(g, allocations), label);
  const r = restore(g, f); allocate(r, [{ pokemonId: b, count: 4 }]); settle(r);
  assert.deepEqual(mons(r.snapshot(), 0).map((m) => m.counters), [1, 6, 3]);
  noDamageOrHealing(before, r.snapshot());
});

test('wrong actor/request/revision and the old selected-string protocol are atomically rejected by an outstanding numeric request', async () => {
  const f = await make(), { g, targets } = setup(f);
  const saved = g.snapshot(), allocations = [{ pokemonId: targets[0], count: 4 }];
  atomic(g, () => allocate(g, allocations, { player: 1 }), 'Wrong actor', { code: 'wrong-choice' });
  atomic(g, () => allocate(g, allocations, { expectedRevision: saved.revision - 1 }), 'Stale revision', { code: 'stale-command' });
  atomic(g, () => allocate(g, allocations, { expectedRevision: saved.revision + 1 }), 'Future revision', { code: 'stale-command' });
  atomic(g, () => command(g, { type: 'allocateCounters', requestId: `${saved.pending.id}-old`, allocations }),
    'Wrong request', { code: 'wrong-choice' });
  atomic(g, () => answer(g, [targets[0]]), 'String selection cannot stand in for numeric allocation', { code: 'wrong-choice' });
  atomic(g, () => command(g, { type: 'allocateCounters', requestId: saved.pending.id, allocations, selected: [targets[0]] }),
    'Numeric answers cannot carry a second string protocol', { code: 'invalid-command' });
  allocate(g, allocations); settle(g);
  atomic(g, () => g.dispatch({ player: 0, expectedRevision: saved.revision,
    action: { type: 'allocateCounters', requestId: saved.pending.id, allocations } }), 'Replayed old revision', { code: 'stale-command' });
  restore(g, f);
});

test('an eligible mixed window validates numeric allocation before protection; selecting only protected subjects performs nothing and cannot run then', async () => {
  const f = await make({ protection: 'bench', mode: 'then' }), { g, targets, before } = setup(f);
  assert.equal(g.snapshot().pending.kind, 'counter-allocation',
    'The unprotected Active makes the instruction usable; protected Bench subjects remain valid allocation choices.');
  assert.deepEqual(g.snapshot().pending.options, targets);
  for (const allocations of [
    [], [{ pokemonId: targets[1], count: 3 }],
    [{ pokemonId: targets[1], count: 2 }, { pokemonId: targets[1], count: 2 }],
    [{ pokemonId: targets[1], count: 3 }, { pokemonId: 'fixture:missing-pokemon', count: 1 }],
  ]) atomic(g, () => allocate(g, allocations), 'Protection cannot excuse an incomplete/forged allocation.');
  const r = restore(g, f);
  allocate(r, [{ pokemonId: targets[1], count: 1 }, { pokemonId: targets[2], count: 3 }]); settle(r);
  assert.deepEqual(mons(r.snapshot(), 0).map((m) => m.counters), [1, 2, 3]);
  const result = events(r.snapshot(), 'resolved')[0].data;
  assert.equal(result.selectedTotal, 4); assert.equal(result.placedTotal, 0);
  assert.equal(result.preventedTotal, 4); assert.equal(result.performed, false);
  noDamageOrHealing(before, r.snapshot()); restore(r, f);
});

test('partially protected restored allocations keep the selected protected share rather than reallocating it', async () => {
  const f = await make({ protection: 'bench' }), { g, targets, before } = setup(f), r = restore(g, f);
  allocate(r, [{ pokemonId: targets[0], count: 1 }, { pokemonId: targets[1], count: 3 }]); settle(r);
  assert.deepEqual(mons(r.snapshot(), 0).map((m) => m.counters), [2, 2, 3]);
  const result = events(r.snapshot(), 'resolved')[0].data;
  assert.equal(result.selectedTotal, 4); assert.equal(result.placedTotal, 1);
  assert.equal(result.preventedTotal, 3); assert.equal(result.performed, true);
  noDamageOrHealing(before, r.snapshot()); restore(r, f);
});

test('restore rejects independently forged windows, top cards, live counters, turn and source identities', async () => {
  const f = await make(), { g } = setup(f);
  rejectCases(g, f, [
    ['missing window', (s) => { delete s.pending.data.counterChoice; }],
    ['window id', (s) => { s.pending.data.counterChoice.id += '-forged'; }],
    ['window turn', (s) => { s.pending.data.counterChoice.turn++; }],
    ['window source', (s) => { s.pending.data.counterChoice.sourceId = s.players[0].active.stack.at(-1); }],
    ['window order', (s) => { s.pending.data.counterChoice.targets.reverse(); }],
    ['window target removed', (s) => { s.pending.data.counterChoice.targets.pop(); }],
    ['window duplicate', (s) => { s.pending.data.counterChoice.targets[1] = clone(s.pending.data.counterChoice.targets[0]); }],
    ['window top', (s) => { s.pending.data.counterChoice.targets[0].topCardId = s.players[0].deck[0]; }],
    ['window counters', (s) => { s.pending.data.counterChoice.targets[0].counters++; }],
    ['live counters', (s) => { s.players[0].active.counters++; }],
    ['live top', (s) => {
      const p = s.players[0], id = hand(s, 0, 'evolution'); p.hand.pop(); p.active.stack.push(id);
    }],
    ['source holder', (s) => { s.pending.data.source.owner = 1; }],
    ['source card', (s) => { s.pending.data.source.instanceId = s.players[0].active.stack.at(-1); }],
    ['source binding', (s) => { s.pending.data.source.effectId += '-foreign'; }],
    ['source evidence', (s) => { s.pending.data.source.sourceOfTruth[0].locator = 'forged'; }],
  ]);
  restore(g, f);
});

test('restore rejects changed prompt identity/bounds/protocol, preallocated answers and detached Trainer finalizers', async () => {
  const f = await make(), { g, targets } = setup(f);
  rejectCases(g, f, [
    ['request id', (s) => { s.pending.id += '-forged'; }],
    ['options order', (s) => { s.pending.options.reverse(); }],
    ['minimum', (s) => { s.pending.minimum = 1; }],
    ['maximum', (s) => { s.pending.maximum = 1; }],
    ['zero permission', (s) => { s.pending.allowZero = false; }],
    ['actor', (s) => { s.pending.player = 1; }],
    ['kind', (s) => { s.pending.kind = 'effect-target'; }],
    ['rule', (s) => { s.pending.ruleId = 'effects.heal-results'; }],
    ['local lane', (s) => { s.pending.data.local = true; }],
    ['string preselection', (s) => { s.pending.data.selected = [targets[0]]; }],
    ['preallocated data', (s) => { s.pending.data.allocations = [{ pokemonId: targets[0], count: 4 }]; }],
    ['preallocated prompt', (s) => { s.pending.allocations = [{ pokemonId: targets[0], count: 4 }]; }],
    ['removed finalizer', (s) => { s.queue = s.queue.filter((t) => t.op !== 'finish-trainer'); }],
    ['duplicate finalizer', (s) => { s.queue.push(clone(s.queue.find((t) => t.op === 'finish-trainer'))); }],
  ]);
});

test('native current action and requested journal cannot coherently override the approved count, selector, target or side', async () => {
  const f = await make(), { g } = setup(f);
  rejectCases(g, f, [
    ...[
      ['larger count', (a) => { a.count = 5; }],
      ['zero count', (a) => { a.count = 0; }],
      ['equivalent selector', (a) => { a.selector = { kind: 'pokemon', stages: ['basic'] }; }],
      ['different target', (a) => { a.target = 'bench'; }],
      ['different side', (a) => { a.side = 'opponent'; }],
    ].map(([label, mutate]) => [label, (s) => {
      mutate(s.pending.data.action); request(s).data.action = clone(s.pending.data.action);
    }]),
    ['coherent native opened program', (s) => {
      s.pending.data.action.count = 5;
      request(s).data.action = clone(s.pending.data.action);
      s.events[trace(s).opened.index].data.program = [clone(s.pending.data.action)];
    }],
    ['opened binding parameters', (s) => {
      const info = trace(s);
      for (const { index } of [info.scheduled, info.opened]) s.events[index].data.binding.parameters.count = 5;
    }],
    ['another operation cannot become untracked', (s) => {
      delete s.pending.data.counterChoice; delete s.pending.data.programId;
      s.pending.data.action = { op: 'draw', count: 1 };
    }],
  ]);
});

test('sequence and then frames cannot graft work or change performed transitions around a pending allocation', async () => {
  const f = await make(), { g } = setup(f);
  rejectCases(g, f, [
    ...[spec(), { op: 'draw', count: 1 }].map((extra) => [
      `grafted sequence ${extra.op}`, (s) => {
        assert.equal(s.pending.data.frames[0].kind, 'sequence');
        s.pending.data.frames[0].remaining.push(clone(extra));
      },
    ]),
    ['inserted then', (s) => { s.pending.data.frames.push({ kind: 'then', next: spec() }); }],
    ['forged performed', (s) => { s.pending.data.frames[0].performed = true; }],
  ]);
  const composite = await make({ mode: 'then' }), valid = setup(composite);
  rejectCases(valid.g, composite, [['modified legitimate then', (s) => {
    const frame = s.pending.data.frames.find((fr) => fr.kind === 'then'); assert(frame);
    frame.next = { op: 'draw', count: 2 };
  }]]);
  const before = valid.g.snapshot(), r = restore(valid.g, composite);
  allocate(r, [{ pokemonId: valid.targets[0], count: 4 }]); settle(r);
  assert.deepEqual(mons(r.snapshot(), 0).map((m) => m.counters), [5, 2, 3]);
  assert.equal(r.snapshot().players[0].deck.length, before.players[0].deck.length - 1, 'A genuine performed then draws exactly once.');
  assert.equal(events(r.snapshot(), 'resolved').length, 1); conservation(r.snapshot(), before.cards); restore(r, composite);
});

test('queued duplicate leaves cannot replay the same token even after deleting their choice, programId or allocation operation', async () => {
  const f = await make(), { g } = setup(f);
  rejectCases(g, f, [
    ...['unchanged', 'no choice', 'no token', 'neither', 'fresh token', 'different op'].map((mode) => [
      mode, (s) => {
        const d = clone(s.pending.data);
        if (['no choice', 'neither', 'fresh token', 'different op'].includes(mode)) delete d.counterChoice;
        if (['no token', 'neither', 'different op'].includes(mode)) delete d.programId;
        if (mode === 'fresh token') d.programId = `${token(s)}-invented`;
        if (mode === 'different op') d.action = { op: 'draw', count: 1 };
        s.queue.unshift({ op: 'effect-choice', data: d });
      },
    ]),
    ['draw completion aliases pending token', (s) => {
      s.queue.unshift({ op: 'draw-cards', data: {
        player: 0, remaining: 1, drawn: 0, reason: 'effect',
        source: clone(s.pending.data.source), completion: clone(s.pending.data),
      } });
    }],
    ['missing current token', (s) => { delete s.pending.data.programId; }],
    ['invented current token', (s) => { s.pending.data.programId += '-invented'; }],
  ]);
});

test('unopened queued native invocations already require a unique scheduled token and cannot be cloned, dropped or stripped', async () => {
  const f = await make({ mode: 'gated' }), { g } = setup(f);
  assert.equal(g.snapshot().pending.kind, 'optional-effect');
  const locate = (s) => {
    const index = s.queue.findIndex((t) => t.op === 'effect' && t.data.binding.handlerId === 'cn.distributeCounters@1');
    assert(index >= 0); assert.equal(typeof s.queue[index].data.programId, 'string'); return index;
  };
  locate(g.snapshot()); restore(g, f);
  rejectCases(g, f, [
    ['cloned initial invocation', (s) => { s.queue.unshift(clone(s.queue[locate(s)])); }],
    ['untracked initial clone', (s) => {
      const d = clone(s.queue[locate(s)]); delete d.data.programId; s.queue.unshift(d);
    }],
    ['missing scheduled token', (s) => { delete s.queue[locate(s)].data.programId; }],
    ['invented scheduled token', (s) => { s.queue[locate(s)].data.programId += '-invented'; }],
    ['orphaned schedule', (s) => { s.queue.splice(locate(s), 1); }],
  ]);
  const r = restore(g, f); answer(r, ['skip']);
  assert.equal(r.snapshot().pending.kind, 'counter-allocation');
  allocate(r, [{ pokemonId: r.snapshot().pending.options[0], count: 4 }]); settle(r);
  restore(r, f);
});

test('requested/resolved history is unique, public, bound to the original source/window and cannot claim the pending allocation already completed', async () => {
  const f = await make(), { g } = setup(f);
  const index = g.snapshot().events.findIndex((e) => e.ruleId === RULE && e.data.kind === 'requested');
  assert(index >= 0);
  rejectCases(g, f, [
    ['missing public request', (s) => { s.events.splice(index, 1); }],
    ['duplicate public request', (s) => { s.events.push(clone(s.events[index])); }],
    ['renamed public request', (s) => { s.events[index].data.kind = 'already-requested'; }],
    ['request id', (s) => { s.events[index].data.id += '-forged'; }],
    ['request action', (s) => { s.events[index].data.action.count++; }],
    ['request source', (s) => { s.events[index].data.source.owner = 1; }],
    ['request window', (s) => { s.events[index].data.choice.targets[0].counters++; }],
    ['forged resolution before answer', (s) => {
      s.events.push({ ruleId: RULE, visibility: 'public',
        data: { kind: 'resolved', id: s.pending.data.counterChoice.id } });
    }],
    ...['private', 0, 1].map((visibility) => [
      `nonpublic request ${visibility}`, (s) => { s.events[index].visibility = visibility; },
    ]),
  ]);
});

test('every scheduled/opened/advance execution receipt is required once, ordered, private and unrenamable', async () => {
  const f = await make({ mode: 'then' }), { g } = setup(f), info = trace(g.snapshot());
  assert(info.entries.some(({ event }) => event.data.kind === 'advance'), 'Use a real expanded control frame, not a fabricated trace.');
  rejectCases(g, f, [
    ...info.entries.flatMap(({ event, index }) => [
      [`missing ${event.data.kind}`, (s) => { s.events.splice(index, 1); }],
      [`duplicate ${event.data.kind}`, (s) => { s.events.push(clone(s.events[index])); }],
      [`renamed ${event.data.kind}`, (s) => { s.events[index].data.kind += '-renamed'; }],
      [`visible ${event.data.kind}`, (s) => { s.events[index].visibility = 'public'; }],
    ]),
    ['reordered opening', (s) => {
      [s.events[info.scheduled.index], s.events[info.opened.index]] =
        [s.events[info.opened.index], s.events[info.scheduled.index]];
    }],
    ['advanced incorrect index', (s) => {
      s.events[info.entries.find(({ event }) => event.data.kind === 'advance').index].data.index++;
    }],
  ]);
});

test('both hidden projections omit every execution receipt/token even if an unknown renamed trace is falsely public', async () => {
  const f = await make(), { g, targets } = setup(f), s = g.snapshot(), info = trace(s);
  for (const viewer of [0, 1]) {
    const view = g.view(viewer);
    assert(!contains(view, info.id)); assert(!view.events.some((e) => e.ruleId === TRACE));
    assert(!Object.hasOwn(view, 'rng')); assert(!Object.hasOwn(view, 'queue'));
    if (viewer === 0) {
      assert.equal(view.pending.kind, 'counter-allocation');
      assert.deepEqual(view.pending.counterAllocation, { total: 4, targets: s.pending.data.counterChoice.targets });
      assert.deepEqual(view.pending.options, targets);
    } else assert.equal(view.pending, null);
    assert(view.events.some((e) => e.ruleId === RULE && e.data.kind === 'requested'));
  }
  for (const { index } of info.entries) for (const visibility of ['public', 0, 1]) {
    const bad = clone(s), marker = `fixture:private-counter-trace:${index}:${visibility}`;
    bad.events[index].visibility = visibility; bad.events[index].data.kind = 'unknown-visible-kind';
    bad.events[index].data.marker = marker;
    for (const viewer of [0, 1]) {
      const view = playerView(bad, f.catalog, viewer);
      assert(!contains(view, marker)); assert(!contains(view, info.id));
      assert(!view.events.some((e) => e.ruleId === TRACE));
    }
  }
});

test('source receipts cannot coherently borrow another card binding, change invocation lane or launder an impossible Item origin', async () => {
  const f = await make(), { g } = setup(f), foreign = clone(f.catalog.definition('research').mechanics.effects[0]);
  rejectCases(g, f, [
    ['foreign catalog binding', (s) => {
      const info = trace(s);
      for (const { index } of [info.scheduled, info.opened]) {
        s.events[index].data.binding = clone(foreign);
        s.events[index].data.source.effectId = foreign.effectId;
      }
      s.pending.data.source.effectId = foreign.effectId;
      request(s).data.source.effectId = foreign.effectId;
    }],
    ['coherent impossible field origin', (s) => {
      s.pending.data.source.origin = 'field';
      for (const e of s.events) if ([TRACE, RULE].includes(e.ruleId) &&
          e.data.source?.instanceId === s.pending.data.source.instanceId) e.data.source.origin = 'field';
    }],
    ['changed opened lane', (s) => {
      const d = s.events[trace(s).opened.index].data; assert.equal(typeof d.local, 'boolean'); d.local = !d.local;
    }],
    ['native reaction origin', (s) => {
      const info = trace(s);
      s.events[info.scheduled.index].data.origin = 'reaction';
      s.events[info.opened.index].data.origin = 'reaction';
    }],
  ]);
});

test('a completed allocation token/request cannot authorize a second use of the same physical Item in the same turn', async () => {
  const f = await make({ recover: true }), { g, sourceId, targets, before } = setup(f);
  const first = g.snapshot(), oldToken = token(first), oldChoice = clone(first.pending.data.counterChoice);
  const allocations = [{ pokemonId: targets[0], count: 4 }];
  allocate(g, allocations); settle(g); restore(g, f);
  command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'recover-counter-source' });
  answer(g, [sourceId]); settle(g); command(g, { type: 'playTrainer', cardId: sourceId });
  const second = g.snapshot();
  assert.equal(second.turn, first.turn); assert.notEqual(token(second), oldToken);
  assert.notEqual(second.pending.id, first.pending.id);
  assert.notEqual(second.pending.data.counterChoice.id, oldChoice.id);
  assert.equal(second.pending.data.source.instanceId, sourceId);
  atomic(g, () => command(g, { type: 'allocateCounters', requestId: first.pending.id, allocations }),
    'Completed request cannot answer a new use', { code: 'wrong-choice' });
  rejectCases(g, f, [
    ['completed token', (s) => { s.pending.data.programId = oldToken; }],
    ['completed numeric request id', (s) => { s.pending.id = first.pending.id; }],
    ['completed window', (s) => { s.pending.data.counterChoice = clone(oldChoice); }],
    ['completed window id', (s) => { s.pending.data.counterChoice.id = oldChoice.id; }],
    ['queued completed leaf', (s) => { s.queue.unshift({ op: 'effect-choice', data: clone(first.pending.data) }); }],
    ['reopened completed program', (s) => {
      const oldOpen = s.events.find((e) => e.ruleId === TRACE && e.data.id === oldToken && e.data.kind === 'opened');
      assert(oldOpen); s.events.push(clone(oldOpen));
    }],
  ]);
  const r = restore(g, f); allocate(r, allocations); settle(r);
  assert.deepEqual(mons(r.snapshot(), 0).map((m) => m.counters), [9, 2, 3]);
  assert.equal(events(r.snapshot(), 'requested').length, 2); assert.equal(events(r.snapshot(), 'resolved').length, 2);
  assert.equal(r.snapshot().players[0].discard.filter((id) => id === sourceId).length, 1);
  assert.deepEqual(r.snapshot().rng, before.rng); assert.deepEqual(r.snapshot().battleHistory, before.battleHistory);
  conservation(r.snapshot(), before.cards); restore(r, f);
});

test('an embedded-only catalog declaration still requires execution tracking before the current leaf enters a distribution operation', async () => {
  const f = await make({ mode: 'embedded' }), { g } = setup(f);
  assert.equal(g.snapshot().pending.kind, 'optional-effect');
  const info = trace(g.snapshot());
  assert.deepEqual(info.opened.event.data.program, [{ op: 'optional', effect: { op: 'draw', count: 1 } }]);
  rejectCases(g, f, [
    ['missing embedded-capability token', (s) => { delete s.pending.data.programId; }],
    ['duplicate embedded-capability leaf', (s) => { s.queue.unshift({ op: 'effect-choice', data: clone(s.pending.data) }); }],
    ['missing embedded-capability schedule', (s) => { s.events.splice(info.scheduled.index, 1); }],
  ]);
  const r = restore(g, f); answer(r, ['skip']); settle(r); restore(r, f);
});

test('placing beyond remaining HP keeps all counters in the allocation result and records only an effect KO, never attack damage or healing', async () => {
  const f = await make({ action: spec({ side: 'opponent' }) });
  const { g, targets, before } = setup(f, { side: 'opponent', counters: [9, 2, 3] });
  const victim = before.players[1].active, victimCards = [...victim.stack, ...victim.energy, ...victim.tools];
  const r = restore(g, f);
  allocate(r, [{ pokemonId: targets[0], count: 4 }]); settle(r);
  const after = r.snapshot(), result = events(after, 'resolved')[0].data;
  assert.equal(result.selectedTotal, 4); assert.equal(result.placedTotal, 4);
  assert.equal(result.preventedTotal, 0);
  const update = result.updates.find((u) => u.pokemonId === victim.id); assert(update);
  assert.equal(update.beforeCounters, 9); assert.equal(update.afterCounters, 13, 'Four counters are not truncated to the one-counter remaining HP.');
  assert(!mons(after, 1).some((m) => m.id === victim.id));
  for (const id of victimCards) assert(after.players[1].discard.includes(id));
  const ko = after.battleHistory.events.filter((e) => e.kind === 'ko' && e.pokemonId === victim.id);
  assert.equal(ko.length, 1); assert.equal(ko[0].cause.kind, 'effect');
  assert.equal(ko[0].cause.source.owner, 0); assert.equal(ko[0].cause.source.category, 'trainer');
  assert.equal(after.battleHistory.events.filter((e) => e.kind === 'heal').length,
    before.battleHistory.events.filter((e) => e.kind === 'heal').length);
  assert(!after.events.slice(before.events.length).some((e) => ['attack.order', 'attack.used', 'effects.heal-results'].includes(e.ruleId)));
  assert.deepEqual(after.rng, before.rng);
  assert.equal(after.players[0].prizes.length, before.players[0].prizes.length - 1);
  conservation(after, before.cards); restore(r, f);
});
