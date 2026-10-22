import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import {
  fixture, binding, EVIDENCE, board, fixtureClock, hand, bench, command, answer, settle,
} from './fixtures.mjs';

// Synthetic catalog only. II.A p19 / II.E-19 p62–63 motivate preserving
// approved contents and their order; the execution journal is a SOFTWARE
// integrity protocol, not cryptographic authentication of arbitrary snapshots.
// Phase A: six real paused native invocations. Other native paths remain
// phase B. drawUntil is a static program whose draw reads the hand when it begins.
const clone = (value) => JSON.parse(JSON.stringify(value));
const cores = createCoreHandlers();
const restore = (saved, f) => OfficialGame.restore(clone(saved), { catalog: f.catalog });

function setHand(s, owner, definitions) {
  const p = s.players[owner], ids = [];
  p.discard.push(...p.hand.splice(0));
  for (const definitionId of definitions) {
    const id = hand(s, owner, definitionId);
    p.hand.pop(); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) p.resolving.splice(p.resolving.indexOf(id), 1);
  p.hand.push(...ids);
  return ids;
}

function setTop(s, owner, definitions) {
  const p = s.players[owner], ids = [];
  for (const definitionId of definitions) {
    const id = hand(s, owner, definitionId);
    p.hand.splice(p.hand.indexOf(id), 1); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) p.resolving.splice(p.resolving.indexOf(id), 1);
  p.deck.push(...[...ids].reverse());
  return ids;
}

async function make(handlerId, parameters, { trainer = 'potion', mutate = () => {} } = {}) {
  const own = binding(handlerId, parameters, `native-pin:${trainer}`);
  const f = await fixture((definitions) => {
    definitions.find((d) => d.definitionId === trainer).mechanics.effects = [own];
    mutate(definitions);
  });
  return { ...f, own };
}

function prepare(f, {
  owner = 0, trainer = 'potion', handNames = [trainer], topNames = [], mutate = () => {},
} = {}) {
  let sourceId, top;
  const g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    sourceId = setHand(s, owner, handNames)[0];
    top = setTop(s, owner, topNames);
    mutate(s);
  });
  const before = g.snapshot();
  command(g, { type: 'playTrainer', cardId: sourceId }, owner);
  return { g, before, sourceId, top, owner };
}

function invocation(s, sourceId, handlerId) {
  const opened = s.events.filter((event) => event.ruleId === 'effects.execution' &&
    event.data.kind === 'opened' && event.data.source.instanceId === sourceId &&
    event.data.binding.handlerId === handlerId);
  assert.equal(opened.length, 1, `${handlerId} must have its own actual opened program, not an untracked leaf.`);
  const id = opened[0].data.id;
  const scheduled = s.events.filter((event) => event.ruleId === 'effects.execution' &&
    event.data.kind === 'scheduled' && event.data.id === id);
  assert.equal(scheduled.length, 1);
  assert.equal(opened[0].visibility, 'private');
  assert.equal(scheduled[0].visibility, 'private');
  return { id, opened: opened[0], scheduled: scheduled[0] };
}

function staticallyExpected(s, sourceId, handlerId, expected) {
  const info = invocation(s, sourceId, handlerId);
  const { source, event, binding: original } = info.opened.data;
  const parameters = clone(original.parameters), before = clone(parameters);
  // No state, definitions, effectivePokemon, hidden cards or canUse call.
  assert.deepEqual(cores.get(handlerId).execute({ source: clone(source), event: clone(event) }, parameters), expected);
  assert.deepEqual(parameters, before);
  assert.deepEqual(info.opened.data.program, expected);
  return info;
}

function unchangedRestore(g, f) {
  const before = g.snapshot(), r = restore(before, f);
  assert.deepEqual(r.snapshot(), before);
  assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  assert.deepEqual(g.snapshot(), before);
  return r;
}

function respond(g, f, selected) {
  const r = unchangedRestore(g, f);
  answer(g, selected); answer(r, selected);
  assert.deepEqual(r.snapshot(), g.snapshot(), 'A legal restore neither changes the native result nor executes it twice.');
  return unchangedRestore(g, f);
}

function visit(value, callback, { skipBindings = false } = {}) {
  if (!value || typeof value !== 'object') return;
  callback(value);
  for (const [key, child] of Object.entries(value)) {
    if (!skipBindings || key !== 'binding') visit(child, callback, { skipBindings });
  }
}

function rewriteActions(s, predicate, mutate) {
  let count = 0;
  visit(s, (value) => {
    if (predicate(value)) { mutate(value); count++; }
  }, { skipBindings: true });
  assert(count >= 2, 'Forge both original program and live work/frames or private request; do not test only a one-sided mismatch.');
}

function assertCoherentCheckpoint(s) {
  const records = s.events.filter((event) => event.ruleId === 'selection.request' &&
    event.data.request.id === s.pending.id);
  assert.equal(records.length, 1);
  assert.equal(records[0].visibility, 'private');
  assert.deepEqual(records[0].data.request, s.pending,
    'The forged current step also appears consistently in the existing request checkpoint.');
  assert.deepEqual(records[0].data.work, {
    queue: s.queue, attack: s.attack, serial: s.serial, revision: s.revision, turn: s.turn,
    current: s.current, phase: s.phase, first: s.first, nextPlayer: s.nextPlayer, vacancies: s.vacancies,
  }, 'The existing paused-work checkpoint stays coherent; native pinning, not a stale checkpoint, must reject.');
}

function reject(g, f, mutate, codes = ['invalid-effect-execution']) {
  const original = g.snapshot(), bad = clone(original);
  mutate(bad);
  const untouched = clone(bad);
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }),
    (error) => error instanceof EngineError && codes.includes(error.code));
  assert.deepEqual(bad, untouched, 'Rejected restoration must not repair or mutate the supplied JSON.');
  assert.deepEqual(g.snapshot(), original);
}

function conserved(before, after) {
  assert.deepEqual(after.cards, before.cards);
  for (const owner of [0, 1]) {
    const locations = (s) => {
      const p = s.players[owner], ids = ['hand', 'deck', 'prizes', 'discard', 'lost', 'resolving'].flatMap((zone) => p[zone]);
      for (const m of [p.active, ...p.bench].filter(Boolean)) ids.push(...m.stack, ...m.energy, ...m.tools);
      if (s.stadium && s.cards[s.stadium].owner === owner) ids.push(s.stadium);
      return ids.sort();
    };
    assert.deepEqual(locations(after), locations(before));
    assert.equal(new Set(locations(after)).size, 60);
  }
}

function incomingDraw(definitions) {
  definitions.find((d) => d.definitionId === 'evolution').mechanics.abilities.push({
    abilityId: 'incoming-draw', name: '测试原生抽牌暂停', mode: 'triggered', usage: null,
    trigger: { event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'effect',
      optional: true, afterUse: 'hand' },
    effects: [binding('cn.draw@1', { count: 1 }, 'native-pin:incoming')], sourceOfTruth: EVIDENCE,
  });
}

function drawCompletion(s, programId) {
  const tasks = s.queue.filter((task) => task.op === 'draw-cards' && task.data.completion?.programId === programId);
  assert.equal(tasks.length, 1);
  return tasks[0].data;
}

test('native counters cannot enlarge a coherent opened program/current leaf, or authorize the original source with another card’s valid binding', async () => {
  const parameters = { side: 'opponent', target: 'any', count: 2 };
  const foreign = binding('cn.counters@1', { ...parameters, count: 9 }, 'native-pin:foreign');
  const f = await make('cn.counters@1', parameters, { mutate: (definitions) => {
    definitions.find((d) => d.definitionId === 'research').mechanics.effects = [foreign];
  } });
  const { g, before, sourceId } = prepare(f, { mutate: (s) => { bench(s, 1, 'other'); } });
  assert.equal(g.snapshot().pending.kind, 'effect-target');
  const info = staticallyExpected(g.snapshot(), sourceId, 'cn.counters@1', [{ op: 'counters', ...parameters }]);
  reject(g, f, (s) => {
    rewriteActions(s, (a) => a.op === 'counters' && a.count === 2, (a) => { a.count = 9; });
    assert.deepEqual(invocation(s, sourceId, 'cn.counters@1').opened.data.binding.parameters, parameters);
    assertCoherentCheckpoint(s);
  });
  reject(g, f, (s) => {
    rewriteActions(s, (a) => a.op === 'counters' && a.count === 2, (a) => { a.count = 9; });
    for (const event of s.events) if (event.ruleId === 'effects.execution' && event.data.id === info.id &&
      ['scheduled', 'opened'].includes(event.data.kind)) event.data.binding.parameters.count = 9;
  });
  reject(g, f, (s) => {
    rewriteActions(s, (a) => a.op === 'counters' && a.count === 2, (a) => { a.count = 9; });
    visit(s, (value) => {
      if (value.instanceId === sourceId && value.effectId === f.own.effectId) value.effectId = foreign.effectId;
      if (value.binding?.effectId === f.own.effectId) value.binding = clone(foreign);
    });
  }, ['invalid-effect-execution', 'invalid-effect-source']);
  const target = before.players[1].bench[0].id;
  const r = respond(g, f, [target]); settle(r);
  assert.equal(r.snapshot().players[1].bench[0].counters, 2);
  assert.equal(r.snapshot().players[0].discard.filter((id) => id === sourceId).length, 1);
  conserved(before, r.snapshot()); unchangedRestore(r, f);
});

test('native cards keeps its approved reveal policy despite coherent private-window/live-action/opened edits, while an untouched hidden search restores', async () => {
  const parameters = {
    from: 'deck', to: 'hand', selector: { kind: 'energy', category: 'basic', types: ['Water'] },
    quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: 3, shuffleAfter: false,
  };
  const f = await make('cn.cards@1', parameters);
  const { g, before, sourceId, top } = prepare(f, { topNames: ['water', 'water', 'water'] });
  assert.equal(g.snapshot().pending.kind, 'select-cards');
  staticallyExpected(g.snapshot(), sourceId, 'cn.cards@1', [{ op: 'cards', ...parameters }]);
  reject(g, f, (s) => {
    rewriteActions(s, (a) => a.op === 'cards', (a) => { a.reveal = true; });
  });
  const r = respond(g, f, [top[0]]); settle(r);
  assert(r.snapshot().players[0].hand.includes(top[0]));
  assert.equal(r.snapshot().players[0].deck.length, before.players[0].deck.length - 1);
  const searched = r.snapshot().events.slice(before.events.length).filter((e) => e.ruleId === 'effects.search');
  assert(!searched.some((e) => e.data.revealed?.length));
  conserved(before, r.snapshot()); unchangedRestore(r, f);
});

test('native deck Energy program remains params-only across its real hidden selection and recipient stages; coherent reveal escalation is not authorization', async () => {
  const parameters = {
    op: 'attachDeckEnergy', lookTop: 3, selector: { kind: 'energy', category: 'basic', types: ['Water'] },
    quantity: { kind: 'upTo', count: 1 },
    recipient: { position: 'bench', selector: { kind: 'pokemon' } },
    distribution: 'separateRecipients', remainder: 'shuffleDeck', reveal: false,
  };
  const f = await make('cn.attachDeckEnergy@1', parameters);
  const { g, before, sourceId, top } = prepare(f, {
    topNames: ['water', 'water', 'water'],
    mutate: (s) => { bench(s, 0, 'other'); bench(s, 0, 'other'); },
  });
  assert.equal(g.snapshot().pending.kind, 'inspect-deck');
  staticallyExpected(g.snapshot(), sourceId, 'cn.attachDeckEnergy@1', [parameters]);
  reject(g, f, (s) => {
    rewriteActions(s, (a) => a.op === 'attachDeckEnergy', (a) => { a.reveal = true; });
  });
  let r = respond(g, f, [top[0]]);
  assert.equal(r.snapshot().pending.kind, 'deck-energy-recipient');
  assert.deepEqual(r.snapshot().players[0].deck, before.players[0].deck);
  staticallyExpected(r.snapshot(), sourceId, 'cn.attachDeckEnergy@1', [parameters]);
  reject(r, f, (s) => {
    rewriteActions(s, (a) => a.op === 'attachDeckEnergy', (a) => { a.reveal = true; });
  });
  const target = before.players[0].bench[1].id;
  r = respond(r, f, [target]); settle(r);
  assert(r.snapshot().players[0].bench[1].energy.includes(top[0]));
  assert.equal(r.snapshot().players[0].deck.length, before.players[0].deck.length - 1);
  conserved(before, r.snapshot()); unchangedRestore(r, f);
});

test('native fixed draw pins its original count while a later card is paused before hand, not the remaining draw count', async () => {
  const f = await make('cn.draw@1', { count: 2 }, { mutate: incomingDraw });
  const { g, before, sourceId, top } = prepare(f, { topNames: ['water', 'evolution', 'water'] });
  assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  assert(g.snapshot().players[0].hand.includes(top[0]));
  const info = staticallyExpected(g.snapshot(), sourceId, 'cn.draw@1', [{ op: 'draw', count: 2 }]);
  assert.equal(drawCompletion(g.snapshot(), info.id).completion.action.count, 2);
  reject(g, f, (s) => {
    rewriteActions(s, (a) => a.op === 'draw' && a.count === 2, (a) => { a.count = 3; });
    visit(s, (value) => {
      if (value.op === 'draw-cards' && value.data.completion?.programId === info.id) value.data.remaining++;
    });
  });
  const r = respond(g, f, ['skip']); settle(r);
  assert(r.snapshot().players[0].hand.includes(top[1]));
  assert(!r.snapshot().players[0].hand.includes(top[2]));
  assert.equal(r.snapshot().players[0].deck.length, before.players[0].deck.length - 2);
  assert.deepEqual(r.snapshot().rng, before.rng);
  conserved(before, r.snapshot()); unchangedRestore(r, f);
});

test('native hand-bottom draw pins source-relative players and the unexecuted draw branch despite coherent opened/continuation edits', async () => {
  const owner = 1, parameters = { side: 'own', ownDraw: 2, opponentDraw: 1 };
  const f = await make('cn.handBottomDraw@1', parameters, { trainer: 'research', mutate: incomingDraw });
  const { g, before, sourceId } = prepare(f, {
    owner, trainer: 'research', handNames: ['research', 'water', 'water'],
    topNames: ['evolution', 'water', 'water'],
    mutate: (s) => { setTop(s, 1 - owner, ['water', 'water']); },
  });
  assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  const expected = [{
    op: 'then', first: { op: 'shuffleHandToBottom', side: 'own' },
    next: { op: 'sequence', steps: [
      { op: 'draw', player: owner, count: 2 },
      { op: 'draw', player: 1 - owner, count: 1 },
    ] },
  }];
  const info = staticallyExpected(g.snapshot(), sourceId, 'cn.handBottomDraw@1', expected);
  assert.equal(g.snapshot().players[owner].hand.length, 0);
  assert.equal(drawCompletion(g.snapshot(), info.id).completion.action.player, owner);
  reject(g, f, (s) => {
    rewriteActions(s, (a) => a.op === 'draw' && a.player === 1 - owner && a.count === 1,
      (a) => { a.count = 7; });
    assertCoherentCheckpoint(s);
  });
  const r = respond(g, f, ['skip']); settle(r);
  assert.equal(r.snapshot().players[owner].hand.length, 2);
  assert.equal(r.snapshot().players[1 - owner].hand.length, before.players[1 - owner].hand.length + 1);
  assert.equal(r.snapshot().players[owner].discard.filter((id) => id === sourceId).length, 1);
  conserved(before, r.snapshot()); unchangedRestore(r, f);
});

test('native draw-until is static: its draw reads the hand when it begins, and a restore keeps that budget, never one above the target', async () => {
  const owner = 0, parameters = { count: 4 };
  const f = await make('cn.drawUntil@1', parameters, { mutate: incomingDraw });
  const { g, before, sourceId, top } = prepare(f, {
    owner, handNames: ['potion', 'water'], topNames: ['water', 'evolution', 'water', 'water'],
  });
  assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  // When the draw began, the Trainer had left a one-card hand: 4 - 1 = 3. A real
  // first draw has since changed that hand to two; the budget stays three.
  const info = invocation(g.snapshot(), sourceId, 'cn.drawUntil@1');
  assert.deepEqual(info.opened.data.program, [{ op: 'draw', untilHand: 4 }]);
  assert.equal(g.snapshot().players[owner].hand.length, 2);
  assert(g.snapshot().players[owner].hand.includes(top[0]));
  const task = drawCompletion(g.snapshot(), info.id);
  assert.equal(task.remaining + task.drawn, 3);
  assert.deepEqual(task.completion.action, { op: 'draw', untilHand: 4 });
  const above = clone(g.snapshot());
  drawCompletion(above, info.id).remaining += 2;
  assert.throws(() => restore(above, f), (e) => e.code === 'invalid-draw-task');
  const r = respond(g, f, ['skip']); settle(r);
  assert.equal(r.snapshot().players[owner].hand.length, 4);
  assert.equal(r.snapshot().players[owner].deck.length, before.players[owner].deck.length - 3);
  assert(!r.snapshot().players[owner].hand.includes(top[3]));
  assert.deepEqual(r.snapshot().rng, before.rng);
  conserved(before, r.snapshot()); unchangedRestore(r, f);
});
