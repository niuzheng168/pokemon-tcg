// Real OfficialGame restore regressions, using only synthetic 60-card decks.
// The private journal is a host receipt, NOT cryptographic authentication.
// Native static programs have an independent approved-parameter oracle; custom
// context-sensitive opened output remains trusted. Never rewrite its whole log
// and claim that these tests authenticate arbitrary historical state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, playerView } from '../../public/rules/game.js';
import {
  fixture, binding, EVIDENCE, board, fixtureClock, hand, bench, command, answer, settle,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const EXECUTION = 'effects.execution';
const REQUEST = 'selection.request';
const NATIVE = ['heal', 'counters', 'switch'];
const STYLES = [...NATIVE, 'custom', 'context'];
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const contains = (value, needle) => value === needle || !!value && typeof value === 'object' &&
  Object.values(value).some((child) => contains(child, needle));
const nativeParams = (style) => style === 'heal' ? { side: 'own', target: 'any', amount: 30 } :
  style === 'counters' ? { side: 'opponent', target: 'any', count: 2 } :
    { side: 'opponent', chooser: 'opponent', affected: 'active' };
const expectedProgram = (style) => [style === 'heal' ? { op: 'heal', side: 'own', target: 'any', count: 3 } :
  { op: style, ...nativeParams(style) }];
const pause = {
  rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'resolve',
  operations: ['optional', 'draw'], validateParameters: (p) => Object.keys(p).length === 0,
  execute: () => [{ op: 'optional', effect: { op: 'draw', count: 1 } }],
};
const customProgram = [{ op: 'then',
  first: { op: 'optional', effect: { op: 'draw', count: 1 } },
  next: { op: 'counters', side: 'opponent', target: 'any', count: 1 },
}];
const custom = {
  ...pause, operations: ['then', 'optional', 'draw', 'counters'],
  execute: () => clone(customProgram),
};
const context = {
  ...pause, operations: ['sequence', 'optional', 'draw', 'counters'],
  execute: (ctx) => [{ op: 'sequence', steps: [
    { op: 'optional', effect: { op: 'draw', count: ctx.source.owner + 1 } },
    { op: 'counters', side: 'opponent', target: 'any', count: ctx.state.turn % 2 + 1 },
  ] }],
};
async function make(style = 'heal', { gated = false, recover = false } = {}) {
  const handlerId = NATIVE.includes(style) ? `cn.${style}@1` : `fixture:binding-${style}`;
  const parameters = NATIVE.includes(style) ? nativeParams(style) : {};
  const f = await fixture((defs) => {
    const own = binding(handlerId, parameters, `binding:${style}:body`);
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = gated ?
      [binding('fixture:binding-pause', {}, 'binding:gate'), own] : [own];
    if (recover) defs[0].mechanics.abilities.push({
      abilityId: 'recover-binding-source', name: '测试取回程序来源', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: 'recover-binding-source', limit: 1 },
      sourceOfTruth: EVIDENCE, effects: [binding('cn.cards@1', {
        from: 'discard', to: 'hand', selector: { kind: 'trainer', nameKeys: ['potion'] },
        quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false,
      }, 'binding:recover')],
    });
  }, new Map([
    ['fixture:binding-pause', pause], ['fixture:binding-custom', custom], ['fixture:binding-context', context],
  ]));
  return { ...f, style, bodyId: `fixture:binding:${style}:body`, handlerId };
}
function setup(f, { owner = 0 } = {}) {
  let sourceId;
  const g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    sourceId = hand(s, owner, 'potion');
    for (const player of [0, 1]) {
      const subjects = [s.players[player].active, bench(s, player, 'other'), bench(s, player, 'other')];
      subjects.forEach((m, i) => { m.counters = player === owner ? [8, 4, 3][i] : [1, 2, 0][i]; });
    }
  });
  const before = g.snapshot(); conservation(before, before.cards);
  command(g, { type: 'playTrainer', cardId: sourceId }, owner);
  return { g, f, owner, sourceId, before };
}
function conservation(s, cards) {
  assert.deepEqual(s.cards, cards);
  const all = [];
  for (const owner of [0, 1]) {
    const p = s.players[owner], ids = ['deck', 'hand', 'discard', 'prizes', 'lost', 'resolving'].flatMap((zone) => p[zone]);
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
  assert.deepEqual(r.snapshot(), saved); assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  conservation(r.snapshot(), saved.cards); return r;
}
function rejectCases(g, f, cases) {
  const saved = g.snapshot(), views = [g.view(0), g.view(1)], accepted = [];
  for (const [label, mutate, expected] of cases) {
    const bad = clone(saved); mutate(bad); const supplied = clone(bad);
    let rejected = false;
    try { OfficialGame.restore(bad, { catalog: f.catalog }); } catch (error) {
      rejected = true;
      if (expected) {
        assert.equal(error.code, expected.code, label);
        assert.match(error.message, expected.message, label);
      }
    }
    if (!rejected) accepted.push(label);
    assert.deepEqual(bad, supplied, `${label}: rejected snapshots cannot be repaired/mutated.`);
    assert.deepEqual(g.snapshot(), saved, label); assert.deepEqual([g.view(0), g.view(1)], views, label);
  }
  conservation(g.snapshot(), saved.cards);
  assert.deepEqual(accepted, [], 'No forged live continuation in this bounded host-receipt model may restore.');
}
function checkpoint(s) {
  return clone({ queue: s.queue, attack: s.attack, serial: s.serial, revision: s.revision, turn: s.turn,
    current: s.current, phase: s.phase, first: s.first, nextPlayer: s.nextPlayer, vacancies: s.vacancies });
}
function selection(s) {
  assert(s.pending);
  const entries = s.events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.ruleId === REQUEST && event.data.request?.id === s.pending.id);
  assert.equal(entries.length, 1, 'Every real pending choice needs its one original private request receipt.');
  assert.equal(entries[0].event.visibility, 'private');
  assert.deepEqual(Object.keys(entries[0].event.data).sort(), ['kind', 'request', 'work']);
  assert.deepEqual(entries[0].event.data.request, s.pending, 'The receipt binds the entire original pending, not just options or an ID.');
  assert.deepEqual(entries[0].event.data.work, checkpoint(s), 'The sealed receipt retains actual paused work and the post-dispatch revision.');
  return entries[0];
}
function trace(s, id = s.pending?.data.programId) {
  assert.equal(typeof id, 'string', 'Every effect/control/choice invocation needs its own opaque program token.');
  assert(id.length > 0);
  const entries = s.events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.ruleId === EXECUTION && event.data.id === id);
  const scheduled = entries.find(({ event }) => event.data.kind === 'scheduled');
  const opened = entries.find(({ event }) => event.data.kind === 'opened');
  assert(scheduled); assert(opened);
  return { id, entries, scheduled, opened };
}
function coherentWork(s, mutate) {
  const receipt = selection(s);
  mutate(s);
  s.events[receipt.index].data.request = clone(s.pending);
  s.events[receipt.index].data.work = checkpoint(s);
}
function coherentChoice(s, mutate) {
  const oldAction = clone(s.pending.data.action);
  // Keep this one pending/work checkpoint coherent to reach the independent
  // execution binding check. Dynamic opened output is never rewritten.
  coherentWork(s, () => mutate(s.pending, s));
  for (const e of s.events) if (e.visibility === 'public' && e.data.action &&
      JSON.stringify(e.data.action) === JSON.stringify(oldAction)) e.data.action = clone(s.pending.data.action);
}
function actionChanges(style) {
  if (style === 'heal') return [
    ['printed 30 HP escalated to 30 counters', (q) => { q.data.action.count = 30; }],
    ['heal side', (q, s) => { q.data.action.side = 'opponent'; q.options = mons(s, 1 - q.data.source.owner).map((m) => m.id); }],
    ['heal target', (q, s) => { q.data.action.target = 'bench'; q.options = s.players[q.data.source.owner].bench.map((m) => m.id); }],
  ];
  if (style === 'counters') return [
    ['counter quantity', (q) => { q.data.action.count = 3; }],
    ['counter side', (q, s) => { q.data.action.side = 'own'; q.options = mons(s, q.data.source.owner).map((m) => m.id); }],
    ['counter target', (q, s) => { q.data.action.target = 'bench'; q.options = s.players[1 - q.data.source.owner].bench.map((m) => m.id); }],
  ];
  return [
    ['switch affected subject', (q) => { q.data.action.affected = 'selected'; }],
    ['switch chooser', (q) => { q.data.action.chooser = 'self'; q.player = q.data.source.owner; }],
    ['switch side', (q, s) => {
      q.data.action.side = 'own'; q.options = s.players[q.data.source.owner].bench.map((m) => m.id);
    }],
  ];
}

for (const style of NATIVE) test(`unmodified ${style} restores its literal approved native program and applies exactly once`, async () => {
  const f = await make(style), c = setup(f, { owner: style === 'counters' ? 1 : 0 });
  const saved = c.g.snapshot(), info = trace(saved); selection(saved);
  assert.deepEqual(info.opened.event.data.program, expectedProgram(style));
  const r = restore(restore(c.g, f), f), holder = style === 'heal' ? c.owner : 1 - c.owner;
  const target = style === 'switch' ? c.before.players[holder].bench[1].id : c.before.players[holder].active.id;
  for (const game of [c.g, r]) { answer(game, [target]); settle(game); }
  assert.deepEqual(r.snapshot(), c.g.snapshot());
  const after = r.snapshot();
  if (style === 'heal') {
    assert.equal(after.players[holder].active.counters, 5, 'Printed 30 HP removes exactly three counters, not 30.');
    assert.deepEqual(after.battleHistory.events.slice(c.before.battleHistory.events.length), [{
      kind: 'heal', turn: c.before.turn, during: c.owner, owner: holder, pokemonId: target, amount: 30,
    }]);
  } else if (style === 'counters') {
    assert.equal(after.players[holder].active.counters, 3);
    assert.deepEqual(after.battleHistory, c.before.battleHistory);
  } else {
    assert.equal(after.players[holder].active.id, target);
    assert.deepEqual(after.battleHistory.events.slice(c.before.battleHistory.events.length), [{
      kind: 'benchToActive', turn: c.before.turn, during: c.owner, owner: holder, pokemonId: target,
    }]);
  }
  assert.equal(after.players[c.owner].discard.filter((id) => id === c.sourceId).length, 1);
  assert.deepEqual(after.rng, c.before.rng); conservation(after, c.before.cards); restore(r, f);
});

for (const style of NATIVE) test(`${style}: coherently editing the current action and its request receipt cannot change approved native semantics`, async () => {
  const f = await make(style), { g } = setup(f);
  rejectCases(g, f, actionChanges(style).map(([label, mutate]) => [
    label, (s) => coherentChoice(s, mutate),
  ]));
});

test('legacy heal frames cannot append a draw, insert a then, or forge performed even with a matching pending receipt', async () => {
  const f = await make(), { g } = setup(f);
  rejectCases(g, f, [
    ['extra sequence draw', (s) => coherentChoice(s, (q) => {
      assert.equal(q.data.frames[0].kind, 'sequence'); q.data.frames[0].remaining.push({ op: 'draw', count: 1 });
    })],
    ['inserted then', (s) => coherentChoice(s, (q) => { q.data.frames.push({ kind: 'then', next: { op: 'draw', count: 1 } }); })],
    ['forged performed', (s) => coherentChoice(s, (q) => { q.data.frames[0].performed = true; })],
  ]);
});

test('rewriting a static native opened program as well still cannot override independently approved parameters', async () => {
  for (const style of NATIVE) {
    const f = await make(style), { g } = setup(f);
    rejectCases(g, f, actionChanges(style).map(([label, mutate]) => [label, (s) => {
      const opened = trace(s).opened.index;
      coherentChoice(s, mutate);
      s.events[opened].data.program = [clone(s.pending.data.action)];
      const receipt = selection(s);
      assert.deepEqual(receipt.event.data.request, s.pending);
      assert.deepEqual(receipt.event.data.work, checkpoint(s));
    }, { code: 'invalid-effect-execution', message: /static native program/i }]));
  }
});

test('all native and custom/context programs require their original token; deleting it cannot downgrade any current opcode into untracked work', async () => {
  for (const style of STYLES) {
    const f = await make(style), { g } = setup(f); trace(g.snapshot()); selection(g.snapshot());
    rejectCases(g, f, [
      ['missing programId', (s) => coherentChoice(s, (q) => { delete q.data.programId; })],
      ['invented programId', (s) => coherentChoice(s, (q) => { q.data.programId += '-invented'; })],
      ['different untracked opcode', (s) => coherentChoice(s, (q) => {
        delete q.data.programId; q.data.action = { op: 'draw', count: 1 };
      })],
    ]);
  }
});

test('duplicate queued leaves, including stripped or opcode-changed clones and draw completions, cannot alias a current program', async () => {
  for (const style of STYLES) {
    const f = await make(style), { g } = setup(f);
    const changes = [
      ...['same', 'missing', 'invented', 'different-op'].map((mode) => [mode, (s) => {
        const d = clone(s.pending.data);
        if (['missing', 'different-op'].includes(mode)) delete d.programId;
        if (mode === 'invented') d.programId += '-invented';
        if (mode === 'different-op') d.action = { op: 'draw', count: 1 };
        s.queue.unshift({ op: 'effect-choice', data: d });
      }]),
      ['draw completion alias', (s) => {
        s.queue.unshift({ op: 'draw-cards', data: {
          player: s.pending.data.source.owner, remaining: 1, drawn: 0, reason: 'effect',
          source: clone(s.pending.data.source), completion: clone(s.pending.data),
        } });
      }],
    ];
    rejectCases(g, f, changes.map(([label, mutate]) => [label, (s) => coherentWork(s, () => mutate(s))]));
  }
});

test('scheduled unopened native/custom/context effects cannot be cloned, stripped, restarted or dropped as an orphan', async () => {
  for (const style of STYLES) {
    const f = await make(style, { gated: true }), { g } = setup(f);
    assert.equal(g.snapshot().pending.kind, 'optional-effect'); trace(g.snapshot()); selection(g.snapshot());
    const locate = (s) => {
      const index = s.queue.findIndex((t) => t.op === 'effect' && t.data.binding.effectId === f.bodyId);
      assert(index >= 0); assert.equal(typeof s.queue[index].data.programId, 'string'); return index;
    };
    locate(g.snapshot()); restore(g, f);
    const changes = [
      ['cloned initial invocation', (s) => { s.queue.unshift(clone(s.queue[locate(s)])); }],
      ['untracked cloned initial', (s) => {
        const copy = clone(s.queue[locate(s)]); delete copy.data.programId; s.queue.unshift(copy);
      }],
      ['missing scheduled token', (s) => { delete s.queue[locate(s)].data.programId; }],
      ['invented scheduled token', (s) => { s.queue[locate(s)].data.programId += '-invented'; }],
      ['dropped initial work', (s) => { s.queue.splice(locate(s), 1); }],
    ];
    rejectCases(g, f, changes.map(([label, mutate]) => [label, (s) => coherentWork(s, () => mutate(s))]));
  }
});

test('custom/context opened programs retain exact action/control frames across restore without re-executing dynamic output', async () => {
  for (const style of ['custom', 'context']) {
    const f = await make(style), c = setup(f, { owner: 1 }), saved = c.g.snapshot();
    const info = trace(saved); selection(saved);
    assert.equal(saved.pending.kind, 'optional-effect');
    assert.equal(info.opened.event.data.binding.handlerId, f.handlerId);
    // Only live action/continuation/choice copies are altered. The private
    // context-sensitive opened record remains the trusted host boundary.
    rejectCases(c.g, f, [
      ['extra control work', (s) => coherentChoice(s, (q) => {
        const frame = q.data.frames.find((fr) => fr.kind === 'sequence'); assert(frame);
        frame.remaining.push({ op: 'draw', count: 3 });
      })],
      ['changed optional body', (s) => coherentChoice(s, (q) => { q.data.action.effect.count++; })],
      ['removed continuation', (s) => coherentChoice(s, (q) => { q.data.frames = []; })],
    ]);
    const r = restore(c.g, f), top = c.before.players[1].deck.slice(-(style === 'context' ? 2 : 1)).reverse();
    answer(r, ['perform']); assert.equal(r.snapshot().pending.kind, 'effect-target');
    const r2 = restore(r, f), target = c.before.players[0].bench[0].id;
    for (const game of [r, r2]) { answer(game, [target]); settle(game); }
    assert.deepEqual(r2.snapshot(), r.snapshot());
    const after = r.snapshot(), count = style === 'context' ? 2 : 1;
    assert.equal(after.players[1].deck.length, c.before.players[1].deck.length - count);
    assert.deepEqual(after.players[1].hand, [...c.before.players[1].hand.filter((id) => id !== c.sourceId), ...top]);
    assert.equal(after.players[0].bench.find((m) => m.id === target).counters, 3, 'The actual turn-four custom/context counter amount is one.');
    assert.deepEqual(after.rng, c.before.rng); conservation(after, c.before.cards); restore(r, f);
  }
});

test('the selection receipt binds pending id, kind, rule, actor, options, bounds, resume and the entire data payload', async () => {
  for (const style of NATIVE) {
    const f = await make(style), { g } = setup(f); selection(g.snapshot());
    rejectCases(g, f, [
      ['request nonce', (s) => { s.pending.id += '-forged'; }],
      ['kind', (s) => { s.pending.kind = 'optional-effect'; }],
      ['rule', (s) => { s.pending.ruleId = 'effects.heal'; }],
      ['actor', (s) => { s.pending.player = 1 - s.pending.player; }],
      ['options order', (s) => { s.pending.options.reverse(); }],
      ['options subset', (s) => { s.pending.options.pop(); }],
      ['minimum', (s) => { s.pending.minimum = 0; }],
      ['maximum', (s) => { s.pending.maximum = 2; }],
      ['zero permission', (s) => { s.pending.allowZero = true; }],
      ['resume', (s) => { s.pending.resume = 'choose-order'; }],
      ['preselected data', (s) => { s.pending.data.selected = [s.pending.options[0]]; }],
      ['source origin', (s) => { s.pending.data.source.origin = 'field'; }],
    ]);
  }
});

test('each original selection request receipt is unique, private, correctly named and cannot be detached from its pending', async () => {
  for (const style of ['heal', 'custom', 'context']) {
    const f = await make(style), { g } = setup(f), receipt = selection(g.snapshot());
    rejectCases(g, f, [
      ['missing original request', (s) => { s.events.splice(receipt.index, 1); }],
      ['duplicated original request', (s) => { s.events.push(clone(s.events[receipt.index])); }],
      ['public private request', (s) => { s.events[receipt.index].visibility = 'public'; }],
      ['renamed history rule', (s) => { s.events[receipt.index].ruleId = 'effects.partial'; }],
      ['renamed history kind', (s) => { s.events[receipt.index].data.kind = 'renamed-host-request'; }],
      ['receipt id only', (s) => { s.events[receipt.index].data.request.id += '-forged'; }],
      ['receipt data only', (s) => { s.events[receipt.index].data.request.data.action = { op: 'draw', count: 3 }; }],
    ]);
  }
});

test('required scheduled/opened/advance records cannot be lost, duplicated, made public or renamed for a non-healing program', async () => {
  const f = await make('custom'), { g } = setup(f), info = trace(g.snapshot());
  assert(info.entries.some(({ event }) => event.data.kind === 'advance'));
  rejectCases(g, f, info.entries.flatMap(({ event, index }) => [
    [`missing ${event.data.kind}`, (s) => { s.events.splice(index, 1); }],
    [`duplicate ${event.data.kind}`, (s) => { s.events.push(clone(s.events[index])); }],
    [`public ${event.data.kind}`, (s) => { s.events[index].visibility = 'public'; }],
    [`renamed ${event.data.kind}`, (s) => { s.events[index].data.kind += '-renamed'; }],
  ]));
});

test('a completed legacy native program/request cannot be borrowed by a new use of the same physical Item in the same turn', async () => {
  const f = await make('heal', { recover: true }), c = setup(f), first = c.g.snapshot();
  const oldToken = trace(first).id, target = c.before.players[0].active.id;
  answer(c.g, [target]); settle(c.g); restore(c.g, f);
  command(c.g, { type: 'useAbility', pokemonId: c.g.snapshot().players[0].active.id, abilityId: 'recover-binding-source' });
  answer(c.g, [c.sourceId]); settle(c.g);
  command(c.g, { type: 'playTrainer', cardId: c.sourceId });
  const second = c.g.snapshot(); assert.equal(second.turn, first.turn);
  assert.notEqual(trace(second).id, oldToken); assert.notEqual(second.pending.id, first.pending.id);
  selection(second);
  rejectCases(c.g, f, [
    ['completed program token', (s) => coherentChoice(s, (q) => { q.data.programId = oldToken; })],
    ['completed choice request', (s) => { s.pending.id = first.pending.id; }],
    ['queued completed leaf', (s) => coherentWork(s, () => {
      s.queue.unshift({ op: 'effect-choice', data: clone(first.pending.data) });
    })],
    ['reopened completed invocation', (s) => { s.events.push(clone(trace(s, oldToken).opened.event)); }],
  ]);
  const r = restore(c.g, f); answer(r, [target]); settle(r);
  assert.equal(r.snapshot().players[0].active.counters, 2);
  assert.equal(r.snapshot().players[0].discard.filter((id) => id === c.sourceId).length, 1);
  assert.deepEqual(r.snapshot().rng, c.before.rng); conservation(r.snapshot(), c.before.cards); restore(r, f);
});

test('player projections hide all original selection and execution records even after unknown kind/visibility edits', async () => {
  const f = await make('context'), { g } = setup(f), saved = g.snapshot(), info = trace(saved), receipt = selection(saved);
  const records = [receipt, ...info.entries];
  for (const viewer of [0, 1]) {
    const view = g.view(viewer);
    assert(!view.events.some((e) => [REQUEST, EXECUTION].includes(e.ruleId)));
    assert(!contains(view, info.id)); assert(!Object.hasOwn(view, 'queue')); assert(!Object.hasOwn(view, 'rng'));
  }
  for (const { index } of records) for (const visibility of ['public', 0, 1]) {
    const bad = clone(saved), marker = `fixture:binding-private:${index}:${visibility}`;
    bad.events[index].visibility = visibility;
    bad.events[index].data.kind = 'unknown-visible-private-record'; bad.events[index].data.marker = marker;
    for (const viewer of [0, 1]) {
      const view = playerView(bad, f.catalog, viewer);
      assert(!contains(view, marker)); assert(!contains(view, info.id));
      assert(!view.events.some((e) => [REQUEST, EXECUTION].includes(e.ruleId)));
    }
  }
});
