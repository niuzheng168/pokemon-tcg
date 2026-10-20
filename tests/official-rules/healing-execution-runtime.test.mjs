// VALID OfficialGame execution traces, using reviewed SYNTHETIC fixtures only.
// Custom programs/receipts here are not real-card or production approvals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const heal = (extra = {}) => ({
  op: 'healPokemon', side: 'own', target: 'any', selector: { kind: 'pokemon' },
  selection: { kind: 'exact', count: 2 }, amount: 10, discardHealedEnergy: false, ...extra,
});
const draw = (count = 1) => ({ op: 'draw', count });
const sequence = (...steps) => ({ op: 'sequence', steps });
const then = (first, next) => ({ op: 'then', first, next });
const optional = (effect) => ({ op: 'optional', effect });
const mons = (s, owner = 0) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const execution = (s, id) => s.events.filter((event) =>
  event.ruleId === 'effects.execution' && (id === undefined || event.data.id === id));
const healing = (s, kind = 'resolved') => s.events.filter((event) =>
  event.ruleId === 'effects.heal-results' && event.data.kind === kind);

function reviewed(program, operations = []) {
  return {
    rulesetId: 'CN/V20261019', implementationVersion: 'synthetic-execution-fixture-v1',
    sourceOfTruth: EVIDENCE, timing: 'resolve',
    operations: ['healPokemon', 'draw', 'sequence', 'then', 'optional', ...operations],
    validateParameters: (p) => p !== null && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0,
    canUse: () => true,
    execute: () => clone(program),
  };
}
async function custom(program, id, transform = () => {}, extraHandlers = new Map()) {
  return fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding(id, {}, 'execution-body')];
    transform(defs);
  }, new Map([[id, reviewed(program)], ...extraHandlers]));
}
function restore(g, f) {
  const saved = g.snapshot(), r = OfficialGame.restore(clone(saved), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), saved);
  assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  return r;
}
function respond(g, f, selected) {
  const r = restore(g, f);
  answer(g, selected); answer(r, selected);
  assert.deepEqual(r.snapshot(), g.snapshot(), 'A valid restored answer must neither repeat nor skip an execution step.');
  return restore(g, f);
}
function prepare(f, mutate = () => {}) {
  let sourceId, targets;
  const g = board(f, (s) => {
    sourceId = hand(s, 0, 'potion');
    targets = [s.players[0].active, bench(s, 0, 'other'), bench(s, 0, 'other')];
    targets.forEach((m, i) => { m.counters = [6, 4, 3][i]; });
    mutate(s, targets);
    targets = targets.map((m) => m.id);
    s.events = [];
  });
  return { g, sourceId, targets };
}
function setTop(s, owner, names) {
  const p = s.players[owner], ids = [];
  for (const name of names) {
    const id = hand(s, owner, name); p.hand.pop(); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) p.resolving.splice(p.resolving.indexOf(id), 1);
  p.deck.push(...[...ids].reverse());
  return ids;
}
const play = (g, sourceId) => command(g, { type: 'playTrainer', cardId: sourceId });

function activeRefs(s) {
  const ids = [];
  for (const task of s.queue) {
    if (task.data.programId) ids.push(task.data.programId);
    if (task.op === 'draw-cards' && task.data.completion?.programId) ids.push(task.data.completion.programId);
  }
  if (s.pending?.data.programId) ids.push(s.pending.data.programId);
  for (const copy of s.attack?.copies ?? []) if (copy.continuation.programId) ids.push(copy.continuation.programId);
  assert.equal(new Set(ids).size, ids.length, 'Each active tracked program has one legitimate continuation owner.');
  return ids;
}
function trace(g, id, program, { complete = false } = {}) {
  assert.equal(typeof id, 'string'); assert(id.length);
  const saved = g.snapshot(), events = execution(saved, id);
  assert(events.length); assert(events.every((event) => event.visibility === 'private'));
  const scheduled = events.filter((event) => event.data.kind === 'scheduled');
  const opened = events.filter((event) => event.data.kind === 'opened');
  assert.equal(scheduled.length, 1); assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].data.program, program);
  assert.deepEqual(opened[0].data.source, scheduled[0].data.source);
  assert.deepEqual(opened[0].data.binding, scheduled[0].data.binding);
  assert.equal(opened[0].data.turn, scheduled[0].data.turn);
  const advances = events.filter((event) => event.data.kind === 'advance').map((event) => event.data);
  for (let i = 1; i < advances.length; i++) assert.equal(advances[i].index, advances[i - 1].index + 1);
  if (complete) {
    assert.equal(advances.at(-1).mode, 'complete');
    assert(!activeRefs(saved).includes(id), 'Completed programs have history, not outstanding work.');
  } else assert(activeRefs(saved).includes(id));
  for (const viewer of [0, 1]) {
    const view = g.view(viewer);
    assert(!view.events.some((event) => event.ruleId === 'effects.execution'));
    assert(!Object.hasOwn(view, 'queue')); assert(!Object.hasOwn(view, 'rng'));
  }
  return opened[0].data;
}

test('declining a tracked optional finishes once without healing, drawing or re-running the source finalizer', async () => {
  const program = [optional(then(heal(), draw()))];
  const f = await custom(program, 'fixture:execution-optional-skip');
  let { g, sourceId } = prepare(f);
  const before = g.snapshot(); play(g, sourceId);
  assert.equal(g.snapshot().pending.kind, 'optional-effect');
  const id = g.snapshot().pending.data.programId, opened = trace(g, id, program);
  assert.equal(opened.source.instanceId, sourceId); assert.deepEqual(opened.binding.parameters, {});
  g = respond(g, f, ['skip']);
  const after = g.snapshot();
  assert.equal(after.pending, null); assert.equal(after.phase, 'main');
  assert.deepEqual(mons(after).map((m) => m.counters), mons(before).map((m) => m.counters));
  assert.deepEqual(after.players[0].deck, before.players[0].deck);
  assert.deepEqual(after.players[0].hand, before.players[0].hand.filter((id) => id !== sourceId));
  assert.equal(healing(after).length, 0);
  assert(!after.events.some((event) => event.ruleId === 'effects.draw'));
  assert.equal(after.players[0].discard.filter((id) => id === sourceId).length, 1);
  assert.equal(after.events.filter((event) => event.ruleId === 'turn.trainer' &&
    event.data.kind === 'trainer-finished' && event.data.cardId === sourceId).length, 1);
  assert.deepEqual(after.rng, before.rng); trace(g, id, program, { complete: true });
});

test('accepted heal then draw preserves its suspended draw-completion program while an incoming card opens a distinct nested tracked program', async () => {
  const outer = [sequence(optional(then(heal(), draw())), draw())];
  const nested = [optional(heal()), draw()];
  const nestedId = 'fixture:execution-incoming';
  const f = await custom(outer, 'fixture:execution-outer-draw', (defs) => {
    defs[2].mechanics.abilities.push({
      abilityId: 'incoming', name: '测试嵌套程序入手前', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'effect', optional: true, afterUse: 'hand' },
      effects: [binding(nestedId, {}, 'incoming-program')],
    });
  }, new Map([[nestedId, reviewed(nested)]]));
  let top;
  let { g, sourceId, targets } = prepare(f, (s) => { top = setTop(s, 0, ['evolution', 'water', 'water']); });
  const before = g.snapshot(); play(g, sourceId);
  const outerId = g.snapshot().pending.data.programId;
  trace(g, outerId, outer); g = respond(g, f, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'healing-targets');
  assert.equal(g.snapshot().pending.data.programId, outerId);
  g = respond(g, f, targets.slice(0, 2));
  assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  const paused = g.snapshot(), completion = paused.queue.find((task) =>
    task.op === 'draw-cards' && task.data.completion?.programId === outerId);
  assert(completion); assert.equal(completion.data.completion.action.op, 'draw');
  assert.equal(completion.data.completion.source.instanceId, sourceId);
  assert(paused.players[0].resolving.includes(top[0]));
  g = respond(g, f, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'optional-effect');
  const innerId = g.snapshot().pending.data.programId;
  assert.notEqual(innerId, outerId);
  assert.deepEqual(new Set(activeRefs(g.snapshot())), new Set([outerId, innerId]));
  const inner = trace(g, innerId, nested);
  assert.equal(inner.source.instanceId, top[0]); assert.equal(inner.source.origin, 'draw');
  assert.deepEqual(g.snapshot().queue.find((task) =>
    task.op === 'draw-cards' && task.data.completion?.programId === outerId).data.completion,
  completion.data.completion, 'A nested incoming effect does not advance/rebind the suspended original draw.');
  g = respond(g, f, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'healing-targets');
  assert.equal(g.snapshot().pending.data.programId, innerId);
  trace(g, outerId, outer); trace(g, innerId, nested);
  g = respond(g, f, [targets[0], targets[2]]);
  const after = g.snapshot();
  assert.equal(after.pending, null); assert.equal(after.phase, 'main');
  assert.deepEqual(mons(after).map((m) => m.counters), [4, 3, 2]);
  assert.deepEqual(after.players[0].deck, before.players[0].deck.slice(0, -3));
  assert.deepEqual(after.players[0].hand, before.players[0].hand.filter((id) => id !== sourceId)
    .concat(top[1], top[0], top[2]));
  assert.equal(healing(after).length, 2); assert.equal(execution(after).filter((event) => event.data.kind === 'opened').length, 2);
  assert.deepEqual(after.rng, before.rng);
  trace(g, outerId, outer, { complete: true }); trace(g, innerId, nested, { complete: true });
});

test('two distinct healing leaves in one custom {}-parameter program share programId but have independent current windows and legitimate advances', async () => {
  const first = heal(), second = heal({ amount: 20 });
  const program = [then(first, sequence(optional(second), draw()))];
  const f = await custom(program, 'fixture:execution-two-heals');
  let { g, sourceId, targets } = prepare(f);
  const before = g.snapshot(); play(g, sourceId);
  const id = g.snapshot().pending.data.programId, firstChoice = g.snapshot().pending.data.healingChoice.id;
  assert.deepEqual(g.snapshot().pending.data.action, first);
  trace(g, id, program); g = respond(g, f, targets.slice(0, 2));
  assert.equal(g.snapshot().pending.kind, 'optional-effect'); assert.equal(g.snapshot().pending.data.programId, id);
  g = respond(g, f, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'healing-targets'); assert.equal(g.snapshot().pending.data.programId, id);
  assert.notEqual(g.snapshot().pending.data.healingChoice.id, firstChoice);
  assert.deepEqual(g.snapshot().pending.data.action, second);
  assert.deepEqual(g.snapshot().pending.data.healingChoice.targets.map((t) => t.counters), [5, 3, 3]);
  trace(g, id, program); g = respond(g, f, targets.slice(1));
  const after = g.snapshot();
  assert.deepEqual(mons(after).map((m) => m.counters), [5, 1, 1]);
  assert.equal(after.players[0].deck.length, before.players[0].deck.length - 1);
  assert.equal(healing(after).length, 2);
  assert.equal(execution(after).filter((event) => event.data.kind === 'opened').length, 1);
  assert.deepEqual(after.rng, before.rng); trace(g, id, program, { complete: true });
});

test('a copied native healing binding has its own copyId program while the suspended custom parent resumes its then/heal/draw exactly once', async () => {
  const copy = { op: 'copyAttack',
    origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
    excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE } };
  const child = heal({ amount: 20 });
  const parent = [then(copy, sequence(heal({ target: 'self', selection: { kind: 'all' } }), draw()))];
  const id = 'fixture:execution-copy-parent';
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].printedDamage = { value: 0, operator: 'fixed' };
    defs[0].mechanics.attacks[0].effects = [binding(id, {}, 'copy-parent')];
    defs[1].mechanics.attacks[0].printedDamage = { value: 0, operator: 'fixed' };
    defs[1].mechanics.attacks[0].effects = [binding('cn.healPokemon@1', child, 'native-copy-child')];
  }, new Map([[id, reviewed(parent, ['copyAttack'])]]));
  let { g, targets } = prepare(f, (s) => {
    const p = s.players[1], old = p.active, replacement = bench(s, 1, 'other');
    p.bench.pop(); p.active = replacement; p.hand.push(...old.stack, ...old.energy, ...old.tools);
    attached(s, 0, s.players[0].active, 'water');
  });
  const before = g.snapshot(), actualUser = before.players[0].active.stack.at(-1);
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.kind, 'copy-attack');
  const parentId = g.snapshot().pending.data.programId;
  trace(g, parentId, parent);
  const option = g.view(0).pending.attacks.find((a) => a.attackId === 'other:strike'); assert(option);
  g = respond(g, f, [option.optionId]);
  assert.equal(g.snapshot().pending.kind, 'healing-targets');
  const saved = g.snapshot(), childId = saved.pending.data.programId;
  assert.notEqual(childId, parentId); assert.equal(saved.attack.copies[0].continuation.programId, parentId);
  assert.deepEqual(new Set(activeRefs(saved)), new Set([parentId, childId]));
  const opened = trace(g, childId, [child]), caller = trace(g, parentId, parent);
  assert.equal(opened.source.instanceId, actualUser);
  assert.equal(opened.source.owner, 0); assert.equal(opened.source.copyId, saved.attack.execution.copyId);
  assert.equal(opened.source.contentSource.instanceId, before.players[1].active.stack.at(-1));
  assert.equal(caller.source.copyId ?? null, null); assert.deepEqual(opened.binding.parameters, child);
  g = respond(g, f, targets.slice(0, 2)); settle(g);
  const after = g.snapshot();
  assert.equal(after.attack, null); assert.equal(after.current, 1);
  assert.deepEqual(mons(after).map((m) => m.counters), [3, 2, 3]);
  assert.equal(healing(after).length, 2); assert.deepEqual(after.rng, before.rng);
  trace(g, parentId, parent, { complete: true }); trace(g, childId, [child], { complete: true });
  restore(g, f);
});

test('two ordinary same-turn uses of one recovered physical Item keep independent tracked programs and one completion per use', async () => {
  const program = [heal(), draw()];
  const f = await custom(program, 'fixture:execution-reused-item', (defs) => {
    defs[0].mechanics.abilities.push({
      abilityId: 'recover-source', name: '测试取回程序来源', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: 'recover-source', limit: 1 }, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.cards@1', { from: 'discard', to: 'hand',
        selector: { kind: 'trainer', nameKeys: ['potion'] }, quantity: { kind: 'exact', count: 1 },
        reveal: true, lookTop: null, shuffleAfter: false }, 'recover-source')],
    });
  });
  let { g, sourceId, targets } = prepare(f);
  const before = g.snapshot(); play(g, sourceId);
  const firstId = g.snapshot().pending.data.programId, firstSource = trace(g, firstId, program).source;
  g = respond(g, f, targets.slice(0, 2)); trace(g, firstId, program, { complete: true });
  command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'recover-source' });
  g = respond(g, f, [sourceId]); play(g, sourceId);
  const secondId = g.snapshot().pending.data.programId;
  assert.notEqual(secondId, firstId); assert.deepEqual(trace(g, secondId, program).source, firstSource);
  assert.equal(execution(g.snapshot(), firstId).filter((event) => event.data.kind === 'opened').length, 1);
  g = respond(g, f, targets.slice(0, 2));
  const after = g.snapshot();
  assert.equal(after.turn, before.turn); assert.deepEqual(mons(after).map((m) => m.counters), [4, 2, 3]);
  assert.equal(after.players[0].deck.length, before.players[0].deck.length - 2);
  assert.equal(after.players[0].discard.filter((id) => id === sourceId).length, 1);
  const finished = after.events.filter((event) => event.ruleId === 'turn.trainer' &&
    event.data.kind === 'trainer-finished' && event.data.cardId === sourceId);
  assert.equal(finished.length, 2); assert.notEqual(finished[0].data.id, finished[1].data.id);
  assert.deepEqual(after.rng, before.rng);
  trace(g, firstId, program, { complete: true }); trace(g, secondId, program, { complete: true });
});

test('native delayedReaction registration and its later embedded heal/draw open separate tracked programs and restore through real trigger/target choices', async () => {
  const program = [then(heal({ amount: 20 }), draw())];
  const parameters = {
    side: 'own', target: 'self',
    trigger: { event: 'energyAttached', subject: 'self', origin: 'hand',
      optional: true, choiceOwner: 'source', scope: 'global' },
    program, duration: 'untilNextOpponentTurnEnd', clearOnBench: true, clearOnEvolution: true,
  };
  const registrationProgram = [{ op: 'delayedReaction', ...parameters }];
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities.push({
      abilityId: 'arm-reaction', name: '测试原生延迟回复程序', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: 'arm-reaction', limit: 1 }, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.delayedReaction@1', parameters, 'native-delayed-heal')],
    });
  });
  let energyId;
  let { g, targets } = prepare(f, (s) => { energyId = hand(s, 0, 'water'); });
  const before = g.snapshot(), sourceId = before.players[0].active.stack.at(-1);
  command(g, { type: 'useAbility', pokemonId: targets[0], abilityId: 'arm-reaction' });
  assert.equal(g.snapshot().pending.kind, 'effect-target');
  const registrationId = g.snapshot().pending.data.programId;
  const registration = trace(g, registrationId, registrationProgram);
  assert.equal(registration.origin, 'handler'); assert.equal(registration.source.instanceId, sourceId);
  assert.equal(registration.binding.handlerId, 'cn.delayedReaction@1');
  g = respond(g, f, [targets[0]]);
  trace(g, registrationId, registrationProgram, { complete: true });
  const registered = clone(execution(g.snapshot(), registrationId));
  assert.equal(g.snapshot().ongoing.length, 1);
  assert.equal(g.snapshot().ongoing[0].effect.op, 'reaction');
  assert.deepEqual(g.snapshot().ongoing[0].effect.program, program);
  assert.equal(healing(g.snapshot()).length, 0, 'Establishing a reaction must not execute its embedded healing early.');
  assert.deepEqual(mons(g.snapshot()).map((m) => m.counters), [6, 4, 3]);
  command(g, { type: 'attachEnergy', cardId: energyId, pokemonId: targets[0] });
  assert.equal(g.snapshot().pending.kind, 'trigger-optional');
  assert.equal(execution(g.snapshot()).filter((event) => event.data.kind === 'opened').length, 1);
  g = respond(g, f, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'healing-targets');
  const reactionId = g.snapshot().pending.data.programId, reaction = trace(g, reactionId, program);
  assert.notEqual(reactionId, registrationId); assert.deepEqual(activeRefs(g.snapshot()), [reactionId]);
  assert.equal(reaction.origin, 'reaction');
  assert.deepEqual(reaction.source, registration.source);
  assert.deepEqual(reaction.binding, registration.binding);
  assert.equal(reaction.event.kind, 'energyAttached'); assert.equal(reaction.event.cardId, energyId);
  g = respond(g, f, targets.slice(0, 2));
  const after = g.snapshot();
  assert.equal(after.pending, null); assert.equal(after.phase, 'main');
  assert.deepEqual(mons(after).map((m) => m.counters), [4, 2, 3]);
  assert(after.players[0].active.energy.includes(energyId)); assert(after.players[0].flags.energy);
  assert.equal(after.players[0].active.used['arm-reaction'].length, 1);
  assert.equal(after.players[0].deck.length, before.players[0].deck.length - 1);
  assert.equal(healing(after).length, 1);
  assert.equal(execution(after).filter((event) => event.data.kind === 'opened').length, 2);
  assert.deepEqual(execution(after, registrationId), registered, 'A later reaction cannot reopen or advance the completed registration.');
  assert.deepEqual(after.rng, before.rng);
  trace(g, registrationId, registrationProgram, { complete: true });
  trace(g, reactionId, program, { complete: true }); restore(g, f);
});
