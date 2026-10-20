// Positive invocation/prompt-binding flows through the real OfficialGame.
// Reviewed SYNTHETIC fixtures only: no real-card approval or E29 reclassification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { replayEffectExecution } from '../../public/rules/effect-execution.js';
import { randomIndex } from '../../public/rules/random.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, hand, bench, attached,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const sequence = (...steps) => ({ op: 'sequence', steps });
const then = (first, next) => ({ op: 'then', first, next });
const optional = (effect) => ({ op: 'optional', effect });
const heal = (target = 'any') => ({ op: 'heal', side: 'own', target, count: 1 });
const counters = (side = 'own', target = 'any', count = 1) => ({ op: 'counters', side, target, count });
const switching = (side = 'opponent', chooser = 'opponent') => ({
  op: 'switch', side, chooser, affected: 'selected',
});
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const events = (s, ruleId, kind) => s.events.filter((e) => e.ruleId === ruleId &&
  (kind === undefined || e.data.kind === kind));
const requests = (s) => events(s, 'selection.request', 'requested');
const opened = (s, id) => events(s, 'effects.execution', 'opened').find((e) => e.data.id === id)?.data;
const workKeys = ['queue', 'attack', 'serial', 'revision', 'turn', 'current', 'phase', 'first', 'nextPlayer', 'vacancies'];
const contains = (value, needle) => value === needle || !!value && typeof value === 'object' &&
  Object.values(value).some((child) => contains(child, needle));
const ability = (id, effects, extra = {}) => ({
  abilityId: id, name: `测试程序调用${id}`, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: id, limit: 1 }, effects, sourceOfTruth: EVIDENCE, ...extra,
});
function reviewed(program, operations, extra = {}) {
  return {
    rulesetId: 'CN/V20261019', implementationVersion: 'synthetic-program-binding-flows-v1',
    timing: 'resolve', sourceOfTruth: EVIDENCE, operations,
    validateParameters: (p) => p !== null && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0,
    canUse: () => true, execute: () => clone(program), ...extra,
  };
}
function setHand(s, owner, definitions) {
  const p = s.players[owner], ids = [];
  p.discard.push(...p.hand.splice(0));
  for (const definitionId of definitions) {
    const id = hand(s, owner, definitionId); p.hand.pop(); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) { p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id); }
  return ids;
}
function setTop(s, owner, definitions) {
  const p = s.players[owner], ids = [];
  for (const definitionId of definitions) {
    const id = hand(s, owner, definitionId);
    p.hand.splice(p.hand.indexOf(id), 1); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) p.resolving.splice(p.resolving.indexOf(id), 1);
  p.deck.push(...[...ids].reverse()); return ids;
}
function references(s) {
  const refs = [];
  const add = (data, kind) => {
    assert.equal(typeof data.programId, 'string', `${kind} needs its actual invocation, including legacy/native leaves.`);
    assert(data.programId.length); refs.push({ id: data.programId, data, kind });
  };
  for (const task of s.queue) {
    if (['effect', 'effect-choice'].includes(task.op)) add(task.data, task.op);
    if (task.op === 'draw-cards' && task.data.completion) add(task.data.completion, 'effect-choice');
  }
  if (s.pending && ['effect', 'effect-choice'].includes(s.pending.resume)) add(s.pending.data, s.pending.resume);
  for (const copy of s.attack?.copies ?? []) add(copy.continuation, 'effect-choice');
  assert.equal(new Set(refs.map((r) => r.id)).size, refs.length,
    'One invocation has exactly one live owner, not both pending/queue/draw-completion/copy-parent.');
  return refs;
}
function audit(g, f) {
  const s = g.snapshot(), refs = references(s), execution = events(s, 'effects.execution');
  const ids = [...new Set(execution.map((e) => e.data.id))];
  assert(execution.every((e) => e.visibility === 'private'));
  for (const id of ids) {
    const records = execution.filter((e) => e.data.id === id);
    const scheduled = records.filter((e) => e.data.kind === 'scheduled');
    const starts = records.filter((e) => e.data.kind === 'opened');
    assert.equal(scheduled.length, 1); assert(starts.length <= 1);
    assert.equal(records[0].data.kind, 'scheduled');
    const ref = refs.find((r) => r.id === id);
    if (!starts.length) {
      assert(ref); assert.equal(ref.kind, 'effect');
      assert.deepEqual(ref.data.binding, scheduled[0].data.binding);
    } else {
      assert.equal(records[1].data.kind, 'opened');
      const { kind: _scheduleKind, ...schedule } = scheduled[0].data;
      const { kind: _openKind, program: _program, ...start } = starts[0].data;
      assert.deepEqual(start, schedule);
      const h = f.catalog.handler(schedule.binding.handlerId);
      const cursor = replayEffectExecution(starts[0], records.slice(2),
        schedule.origin === 'handler' ? h.operations : h.embeddedOperations ?? [],
        schedule.origin === 'handler' ? h.embeddedOperations ?? [] : []);
      assert.equal(ref !== undefined, cursor.step !== null, 'Completed history must not retain a live reference.');
      if (ref) {
        assert.equal(ref.kind, 'effect-choice');
        assert.deepEqual({ action: ref.data.action, frames: ref.data.frames }, cursor.step,
          'The live action and complete continuation are the current step, not a generic handler/output token.');
      }
    }
    if (ref) {
      assert.deepEqual(ref.data.source, scheduled[0].data.source);
      assert.deepEqual(ref.data.event ?? null, scheduled[0].data.event);
      assert.equal(ref.data.local ?? false, scheduled[0].data.local);
      assert.deepEqual(ref.data.entry ?? null, scheduled[0].data.entry);
      assert.deepEqual(ref.data.payment ?? null, scheduled[0].data.payment);
    }
  }
  assert(refs.every((ref) => ids.includes(ref.id)));
  const receipts = requests(s);
  assert.equal(new Set(receipts.map((e) => e.data.request.id)).size, receipts.length);
  for (const receipt of receipts) {
    assert.equal(receipt.visibility, 'private');
    assert.deepEqual(Object.keys(receipt.data).sort(), ['kind', 'request', 'work']);
  }
  if (s.pending) {
    const matching = receipts.filter((e) => e.data.request.id === s.pending.id);
    assert.equal(matching.length, 1, 'Every actual prompt needs one original full private request.');
    assert.deepEqual(matching[0].data.request, s.pending);
    assert.deepEqual(matching[0].data.work, Object.fromEntries(workKeys.map((key) => [key, clone(s[key])])),
      'The request is sealed to this exact paused work; older receipts are not rebound to the current queue.');
  }
  for (const viewer of [0, 1]) {
    const view = g.view(viewer);
    assert(!view.events.some((e) => ['selection.request', 'effects.execution'].includes(e.ruleId)));
    assert(!Object.hasOwn(view, 'queue')); assert(!Object.hasOwn(view, 'rng'));
    for (const id of ids) assert(!contains(view, id), 'Private invocation tokens cannot disclose programs through projection.');
    for (const p of view.players) assert(!Object.hasOwn(p, 'deck'));
    if (view.pending) for (const key of ['data', 'action', 'frames', 'programId', 'binding', 'resume'])
      assert(!Object.hasOwn(view.pending, key), `A playable prompt must not expose host ${key}.`);
    if (s.pending?.player !== viewer) assert.equal(view.pending, null);
  }
  assert.deepEqual(g.snapshot(), s, 'Auditing/restoring/projecting is readonly, including private RNG and journals.');
  return refs;
}
function checkpoint(g, f) {
  audit(g, f);
  const saved = g.snapshot(), input = clone(saved), r = OfficialGame.restore(input, { catalog: f.catalog });
  assert.deepEqual(input, saved); assert.deepEqual(r.snapshot(), saved);
  assert.deepEqual(r.snapshot().rng, saved.rng);
  assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  audit(r, f); return r;
}
function respond(g, f, selected) {
  const r = checkpoint(g, f);
  answer(g, selected); answer(r, selected);
  assert.deepEqual(r.snapshot(), g.snapshot(), 'Every real answer has the exact same result after JSON restore, including RNG.');
  assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  audit(g, f); return g;
}
function pause(g, kind, action = undefined, player = undefined) {
  const q = g.snapshot().pending;
  assert(q); assert.equal(q.kind, kind);
  if (action !== undefined) assert.deepEqual(q.data.action, action);
  if (player !== undefined) assert.equal(q.player, player);
  return q;
}
function done(g, f, before, { rng = before.rng } = {}) {
  assert.equal(g.snapshot().pending, null); assert.deepEqual(references(g.snapshot()), []);
  assert.deepEqual(g.snapshot().cards, before.cards); assert.deepEqual(g.snapshot().rng, rng);
  checkpoint(g, f);
}
const play = (g, cardId) => command(g, { type: 'playTrainer', cardId });
const use = (g, pokemonId, abilityId) => command(g, { type: 'useAbility', pokemonId, abilityId });

test('legacy native heal/counters/switch bindings each own a distinct invocation and private prompt, including an opponent-controlled switch', async () => {
  const p = { side: 'opponent', chooser: 'opponent', affected: 'selected' };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [
      binding('cn.heal@1', { target: 'any', amount: 10 }, 'flows-native-heal'),
      binding('cn.counters@1', { side: 'opponent', target: 'active', count: 2 }, 'flows-native-counters'),
      binding('cn.switch@1', p, 'flows-native-switch'),
    ];
  });
  let cardId, ownBench, opponentBench;
  const g = board(f, (s) => {
    ownBench = bench(s, 0, 'other').id; opponentBench = bench(s, 1, 'other').id;
    s.players[0].active.counters = 3; s.players[0].bench[0].counters = 2;
    [cardId] = setHand(s, 0, ['potion']); s.events = [];
  }), before = g.snapshot();
  play(g, cardId);
  const first = pause(g, 'effect-target'), firstId = first.data.programId;
  assert.deepEqual(opened(g.snapshot(), firstId).program, [heal()]);
  const scheduled = events(g.snapshot(), 'effects.execution', 'scheduled');
  assert.equal(scheduled.length, 3); assert.equal(events(g.snapshot(), 'effects.execution', 'opened').length, 1);
  assert.equal(audit(g, f).length, 3, 'Two still-unopened bindings remain distinct queued invocation references.');
  respond(g, f, [ownBench]);
  const second = pause(g, 'effect-target', counters('opponent', 'active', 2), 0);
  assert.notEqual(second.data.programId, firstId);
  respond(g, f, [before.players[1].active.id]);
  const third = pause(g, 'effect-target', { op: 'switch', ...p }, 1);
  assert.equal(new Set([firstId, second.data.programId, third.data.programId]).size, 3);
  assert.equal(g.view(0).pending, null);
  respond(g, f, [opponentBench]);
  assert.equal(mons(g.snapshot(), 0).find((m) => m.id === ownBench).counters, 1);
  assert.equal(g.snapshot().players[1].active.id, opponentBench);
  assert.equal(g.snapshot().players[1].bench.find((m) => m.id === before.players[1].active.id).counters, 2);
  assert.equal(requests(g.snapshot()).length, 3);
  assert.equal(g.snapshot().players[0].discard.filter((id) => id === cardId).length, 1);
  done(g, f, before);
});

test('one whole first/then/sequence/optional program preserves exact branches and fresh prompts without exposing future handler output', async () => {
  const sentinel = 'SYNTHETIC-PRIVATE-FUTURE-SELECTOR-NOT-A-CARD';
  const unfindable = { op: 'cards', from: 'discard', to: 'hand',
    selector: { kind: 'trainer', nameKeys: [sentinel] }, quantity: { kind: 'exact', count: 1 },
    reveal: false, lookTop: null, shuffleAfter: false };
  const first = optional(heal()), switchStep = switching();
  const program = [then(first, sequence(counters('opponent', 'any', 2), optional(switchStep), unfindable)), counters()];
  const id = 'fixture:flows-control';
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding(id, {}, 'flows-control')];
  }, new Map([[id, reviewed(program, ['then', 'sequence', 'optional', 'heal', 'counters', 'switch', 'cards'])]]));
  for (const accept of [false, true]) {
    let cardId, ownBench, opponentBench;
    const g = board(f, (s) => {
      ownBench = bench(s, 0, 'other').id; opponentBench = bench(s, 1, 'other').id;
      s.players[0].active.counters = 3; s.players[0].bench[0].counters = 2;
      [cardId] = setHand(s, 0, ['potion']); s.events = [];
    }), before = g.snapshot();
    play(g, cardId);
    const programId = pause(g, 'optional-effect', first, 0).data.programId;
    assert.deepEqual(opened(g.snapshot(), programId).program, program);
    const assertHidden = () => {
      for (const viewer of [0, 1]) assert(!contains(g.view(viewer), sentinel));
    };
    assertHidden(); respond(g, f, [accept ? 'perform' : 'skip']);
    if (accept) {
      assert.equal(pause(g, 'effect-target', heal()).data.programId, programId);
      respond(g, f, [ownBench]);
      assert.equal(pause(g, 'effect-target', counters('opponent', 'any', 2)).data.programId, programId);
      respond(g, f, [opponentBench]);
      pause(g, 'optional-effect', optional(switchStep), 0); respond(g, f, ['perform']);
      assert.equal(pause(g, 'effect-target', switchStep, 1).data.programId, programId);
      assertHidden(); respond(g, f, [opponentBench]);
    }
    assert.equal(pause(g, 'effect-target', counters(), 0).data.programId, programId);
    assertHidden(); respond(g, f, [before.players[0].active.id]);
    const after = g.snapshot();
    assert.equal(after.players[0].active.counters, 4);
    assert.equal(after.players[0].bench.find((m) => m.id === ownBench).counters, accept ? 1 : 2);
    assert.equal(after.players[1].active.id, accept ? opponentBench : before.players[1].active.id);
    assert.equal(mons(after, 1).find((m) => m.id === opponentBench).counters, accept ? 2 : 0);
    assert.equal(events(after, 'effects.execution', 'opened').length, 1);
    assert.equal(requests(after).length, accept ? 6 : 2);
    assertHidden(); done(g, f, before);
  }
});

test('cross-owner subject-local turn-end triggers keep their own source/event/program and restore optional pauses without acquiring a global board context', async () => {
  const add = counters('own', 'event'), recover = heal('event');
  const program = [sequence(then(optional(add), optional(recover)))], id = 'fixture:flows-local';
  const h = reviewed(program, ['sequence', 'then', 'optional', 'counters', 'heal'], {
    execute: (ctx) => {
      assert.equal(Object.hasOwn(ctx, 'state'), false);
      assert.equal(ctx.subject.owner, ctx.source.owner); assert.equal(ctx.event.subjectId, ctx.subject.pokemon.id);
      return clone(program);
    },
  });
  const f = await fixture((defs) => defs[0].mechanics.abilities.push({
    abilityId: 'local-flow', name: '测试双方局部程序', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
    trigger: { event: 'turnEnd', subject: 'self', optional: true, choiceOwner: 'source', scope: 'subject' },
    effects: [binding(id, {}, 'flows-local')],
  }), new Map([[id, h]]));
  const g = board(f, (s) => {
    s.players[0].active.counters = 2; s.players[1].active.counters = 3; s.events = [];
  }), before = g.snapshot(), ids = [];
  command(g, { type: 'endTurn' });
  for (const owner of [0, 1]) {
    pause(g, 'trigger-optional', undefined, owner); respond(g, f, ['perform']);
    const q = pause(g, 'optional-effect', optional(add), owner), programId = q.data.programId;
    ids.push(programId);
    const invocation = opened(g.snapshot(), programId);
    assert.equal(invocation.local, true); assert.equal(invocation.source.owner, owner);
    assert.equal(invocation.event.owner, owner); assert.equal(invocation.event.subjectId, before.players[owner].active.id);
    respond(g, f, ['perform']);
    assert.equal(pause(g, 'optional-effect', optional(recover), owner).data.programId, programId);
    assert.equal(g.snapshot().players[owner].active.counters, before.players[owner].active.counters + 1);
    respond(g, f, ['perform']);
  }
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(g.snapshot().players.map((p) => p.active.counters), [2, 3]);
  assert.equal(g.snapshot().current, 1); assert.equal(requests(g.snapshot()).length, 6);
  assert.deepEqual(events(g.snapshot(), 'effects.execution', 'opened').map((e) => e.data.source.owner), [0, 1]);
  done(g, f, before);
});

test('native draw completion survives a nested beforeHand native non-healing program and returns once to the next queued binding', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [
      binding('cn.draw@1', { count: 2 }, 'flows-outer-draw'),
      binding('cn.counters@1', { side: 'own', target: 'any', count: 1 }, 'flows-after-draw'),
    ];
    defs[2].mechanics.abilities.push({
      abilityId: 'incoming-flow', name: '测试入手前程序', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'effect', optional: true, afterUse: 'hand' },
      effects: [binding('cn.counters@1', { side: 'own', target: 'any', count: 2 }, 'flows-incoming-counters')],
    });
  });
  let cardId, ownBench, top;
  const g = board(f, (s) => {
    ownBench = bench(s, 0, 'other').id; [cardId] = setHand(s, 0, ['potion']);
    top = setTop(s, 0, ['evolution', 'water']); s.events = [];
  }), before = g.snapshot();
  play(g, cardId); pause(g, 'before-hand-optional');
  const frame = g.snapshot().queue.find((t) => t.op === 'draw-cards' && t.data.completion);
  assert(frame); const completion = clone(frame.data.completion), parentId = completion.programId;
  assert.equal(completion.action.op, 'draw'); assert.equal(completion.source.instanceId, cardId);
  assert.equal(audit(g, f).length, 2);
  respond(g, f, ['perform']);
  const q = pause(g, 'effect-target', counters('own', 'any', 2)), innerId = q.data.programId;
  assert.notEqual(innerId, parentId); assert.equal(audit(g, f).length, 3);
  assert.deepEqual(g.snapshot().queue.find((t) => t.op === 'draw-cards' && t.data.completion?.programId === parentId)
    .data.completion, completion);
  assert.equal(opened(g.snapshot(), innerId).source.instanceId, top[0]);
  assert.equal(opened(g.snapshot(), innerId).source.origin, 'draw');
  assert.equal(opened(g.snapshot(), innerId).entry.cardId, top[0]);
  respond(g, f, [ownBench]);
  const resumed = pause(g, 'effect-target', counters());
  assert(![parentId, innerId].includes(resumed.data.programId));
  assert.deepEqual(opened(g.snapshot(), parentId).program, [{ op: 'draw', count: 2 }]);
  respond(g, f, [before.players[0].active.id]);
  const after = g.snapshot();
  assert.equal(after.players[0].active.counters, 1);
  assert.equal(after.players[0].bench.find((m) => m.id === ownBench).counters, 2);
  assert.deepEqual(after.players[0].hand, top); assert.deepEqual(after.players[0].deck, before.players[0].deck.slice(0, -2));
  assert.equal(events(after, 'effects.draw').filter((e) => e.data.player === 0 && e.data.count === 2).length, 1);
  assert.equal(events(after, 'effects.execution', 'opened').length, 3);
  done(g, f, before);
});

test('a copied native non-healing child owns its copy program, preserves the actual actor, and returns to the exact parent optional/then frames', async () => {
  const copy = { op: 'copyAttack',
    origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
    excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE } };
  const ownCounter = counters('own', 'self'), parent = [then(copy, sequence(optional(ownCounter), { op: 'draw', count: 1 }))];
  const id = 'fixture:flows-copy-parent';
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].printedDamage = null;
    defs[0].mechanics.attacks[0].effects = [binding(id, {}, 'flows-copy-parent')];
    defs[1].mechanics.attacks[0].printedDamage = null;
    defs[1].mechanics.attacks[0].effects = [
      binding('cn.counters@1', { side: 'own', target: 'any', count: 2 }, 'flows-native-copy-child'),
    ];
  }, new Map([[id, reviewed(parent, ['then', 'sequence', 'optional', 'copyAttack', 'counters', 'draw'])]]));
  let ownBench;
  const g = board(f, (s) => {
    ownBench = bench(s, 0, 'other').id;
    const p = s.players[1], original = p.active, replacement = bench(s, 1, 'other');
    p.bench.pop(); p.bench.push(original); p.active = replacement;
    attached(s, 0, s.players[0].active, 'water'); s.events = [];
  }), before = g.snapshot(), actualActor = before.players[0].active.stack.at(-1);
  command(g, { type: 'attack', attackId: 'base:strike' });
  const parentId = pause(g, 'copy-attack', copy).data.programId;
  const choice = g.view(0).pending.attacks.find((a) => a.attackId === 'other:strike'); assert(choice);
  for (const key of ['effects', 'bindings', 'parameters']) assert(!Object.hasOwn(choice, key));
  respond(g, f, [choice.optionId]);
  const q = pause(g, 'effect-target', counters('own', 'any', 2)), childId = q.data.programId;
  assert.notEqual(childId, parentId);
  assert.equal(g.snapshot().attack.copies[0].continuation.programId, parentId);
  assert.deepEqual(new Set(audit(g, f).map((r) => r.id)), new Set([parentId, childId]));
  const child = opened(g.snapshot(), childId);
  assert.equal(child.binding.handlerId, 'cn.counters@1');
  assert.equal(child.source.instanceId, actualActor); assert.equal(child.source.owner, 0);
  assert.equal(child.source.copyId, g.snapshot().attack.execution.copyId);
  assert.equal(child.source.contentSource.instanceId, before.players[1].active.stack.at(-1));
  respond(g, f, [ownBench]);
  assert.equal(pause(g, 'optional-effect', optional(ownCounter), 0).data.programId, parentId);
  assert.equal(g.snapshot().attack.copies.length, 0); assert.equal(g.snapshot().attack.execution.copyId, null);
  respond(g, f, ['perform']);
  assert.equal(pause(g, 'effect-target', ownCounter).data.programId, parentId);
  respond(g, f, [before.players[0].active.id]);
  const after = g.snapshot();
  assert.equal(after.attack, null); assert.equal(after.players[0].active.counters, 1);
  assert.equal(after.players[0].bench.find((m) => m.id === ownBench).counters, 2);
  assert.deepEqual(mons(after, 1).map((m) => m.counters), [0, 0]);
  assert.equal(after.players[0].deck.length, before.players[0].deck.length - 1);
  assert.deepEqual(opened(after, parentId).program, parent);
  done(g, f, before);
});

test('native hand-Energy selection and repeated recipient stages retain one invocation before a separate native switch binding', async () => {
  const attach = { type: 'Water', count: 2, benchOnly: true, optional: false };
  const p = { side: 'own', chooser: 'self', affected: 'active' };
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('energy-flow', [
    binding('cn.attachHand@1', attach, 'flows-hand-energy'), binding('cn.switch@1', p, 'flows-after-energy-switch'),
  ])));
  let energies, recipients;
  const g = board(f, (s) => {
    recipients = [bench(s, 0, 'other').id, bench(s, 0, 'other').id];
    energies = setHand(s, 0, ['water', 'water']); s.events = [];
  }), before = g.snapshot();
  use(g, before.players[0].active.id, 'energy-flow');
  const id = pause(g, 'hand-energy', { op: 'attachHand', ...attach }).data.programId;
  respond(g, f, energies);
  for (const [index, recipient] of recipients.entries()) {
    const q = pause(g, 'energy-recipient', { op: 'attachHand', ...attach });
    assert.equal(q.data.programId, id); assert.equal(q.data.index, index);
    assert.deepEqual(q.data.energies, energies); assert.equal(q.data.stage, 'target');
    respond(g, f, [recipient]);
  }
  const next = pause(g, 'effect-target', { op: 'switch', ...p });
  assert.notEqual(next.data.programId, id); respond(g, f, [recipients[0]]);
  const after = g.snapshot();
  assert.equal(after.players[0].active.id, recipients[0]);
  for (const [index, recipient] of recipients.entries())
    assert.deepEqual(mons(after, 0).find((m) => m.id === recipient).energy, [energies[index]]);
  assert.equal(after.players[0].hand.length, 0);
  assert.deepEqual(mons(after, 0).find((m) => m.id === before.players[0].active.id).used['energy-flow'], [before.turn]);
  assert.equal(events(after, 'effects.execution', 'opened').length, 2);
  assert.equal(requests(after).length, 4); done(g, f, before);
});

test('a private fixed deck window resumes its same then/optional/counter program after real subset RNG without revealing lower deck or future frames', async () => {
  const inspect = { op: 'inspectDeck', lookTop: 4, selector: { kind: 'any' },
    quantity: { kind: 'exact', count: 2 }, revealSelected: false, remainder: { mode: 'shuffleToBottom' } };
  const program = [then(inspect, sequence(optional(heal()), counters()))], id = 'fixture:flows-deck';
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding(id, {}, 'flows-deck')];
  }, new Map([[id, reviewed(program, ['then', 'sequence', 'inspectDeck', 'optional', 'heal', 'counters'])]]));
  let cardId, ownBench, top;
  const g = board(f, (s) => {
    ownBench = bench(s, 0, 'other').id; s.players[0].active.counters = 3; s.players[0].bench[0].counters = 2;
    [cardId] = setHand(s, 0, ['potion']); top = setTop(s, 0, ['water', 'water', 'water', 'water']); s.events = [];
  }), before = g.snapshot(), lower = before.players[0].deck.slice(0, -4);
  play(g, cardId);
  const q = pause(g, 'inspect-deck', inspect, 0), programId = q.data.programId;
  assert.deepEqual(q.data.deckChoice.window, top); assert.deepEqual(q.data.deckChoice.deck, before.players[0].deck);
  assert.deepEqual(g.view(0).pending.lookedAt.map((c) => c.instanceId), top);
  for (const viewer of [0, 1]) {
    const view = g.view(viewer);
    for (const hiddenId of lower) assert(!contains({ pending: view.pending, events: view.events }, hiddenId));
    if (viewer === 1) for (const windowId of top) assert(!contains({ pending: view.pending, events: view.events }, windowId));
  }
  const selected = [top[0], top[2]], remainder = [top[1], top[3]], rng = [...before.rng];
  const at = randomIndex(rng, 2); [remainder[1], remainder[at]] = [remainder[at], remainder[1]];
  respond(g, f, selected);
  assert.equal(pause(g, 'optional-effect', optional(heal())).data.programId, programId);
  assert.deepEqual(g.snapshot().players[0].deck, [...remainder].reverse().concat(lower));
  assert.deepEqual(g.snapshot().rng, rng); respond(g, f, ['perform']);
  assert.equal(pause(g, 'effect-target', heal()).data.programId, programId); respond(g, f, [ownBench]);
  assert.equal(pause(g, 'effect-target', counters()).data.programId, programId);
  respond(g, f, [before.players[0].active.id]);
  const after = g.snapshot();
  assert.equal(after.players[0].active.counters, 4);
  assert.equal(after.players[0].bench.find((m) => m.id === ownBench).counters, 1);
  assert.deepEqual(after.players[0].hand, selected);
  assert.deepEqual(after.players[0].deck, [...remainder].reverse().concat(lower));
  assert.equal(events(after, 'effects.shuffle').filter((e) => e.data.subset === 'looked-remainder').length, 1);
  for (const viewer of [0, 1]) for (const hiddenId of [...lower, ...remainder])
    assert(!contains(g.view(viewer).events, hiddenId), 'No private request, lower card identity or shuffled remainder order leaks into history.');
  done(g, f, before, { rng });
});

test('two legitimate uses of the same native binding/output/options are distinct invocations, never conflicting generic tokens or recycled request IDs', async () => {
  const parameters = { side: 'own', target: 'self', count: 1 };
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('repeat-native', [
    binding('cn.counters@1', parameters, 'flows-repeat-native'),
  ], { usage: { period: 'unlimited', scope: 'pokemon', key: 'repeat-native', limit: null } })));
  const g = board(f, (s) => { s.events = []; }), before = g.snapshot(), invocations = [], prompts = [];
  for (let i = 0; i < 2; i++) {
    use(g, before.players[0].active.id, 'repeat-native');
    const q = pause(g, 'effect-target', { op: 'counters', ...parameters });
    invocations.push(q.data.programId); prompts.push(q.id); respond(g, f, [before.players[0].active.id]);
    assert.equal(g.snapshot().players[0].active.counters, i + 1);
  }
  assert.equal(new Set(invocations).size, 2); assert.equal(new Set(prompts).size, 2);
  const starts = invocations.map((id) => opened(g.snapshot(), id));
  assert.deepEqual(starts[0].binding, starts[1].binding); assert.deepEqual(starts[0].program, starts[1].program);
  assert.deepEqual(starts[0].source, starts[1].source);
  assert.deepEqual(requests(g.snapshot()).map((e) => e.data.request.id), prompts);
  done(g, f, before);
});
