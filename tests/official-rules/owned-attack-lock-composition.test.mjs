// Synthetic composition regressions; no real card, printing or release approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, command, answer, attached } from './fixtures.mjs';

const clone = (value) => structuredClone(value);
const lock = () => ({ op: 'disableOwnedAttack', side: 'opponent', target: 'active',
  duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true });
async function setup(program = [lock()], extra = {}) {
  const id = 'fixture:owned-composition', handler = {
    rulesetId: 'CN/V20261019', implementationVersion: 'synthetic-owned-composition-1',
    timing: 'resolve', operations: ['disableOwnedAttack', 'delayedReaction'], embeddedOperations: ['draw'],
    sourceOfTruth: EVIDENCE, validateParameters: (p) => p && Object.keys(p).length === 0,
    execute: () => clone(program), ...extra,
  };
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [binding(id, {})];
    defs[0].mechanics.attacks.push({ ...clone(defs[0].mechanics.attacks[0]),
      attackId: 'base:other-choice', name: '合成第二招', effects: [] });
  }, new Map([[id, handler]]));
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    attached(s, 1, s.players[1].active, 'water');
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  return { f, g };
}
function restore(g, f) {
  const saved = g.snapshot(), input = clone(saved);
  const r = OfficialGame.restore(input, { catalog: f.catalog });
  assert.deepEqual(input, saved); assert.deepEqual(r.snapshot(), saved);
  return r;
}
const records = (s, kind) => s.events.filter((e) => e.ruleId === 'attack.owned-lock' && e.data.kind === kind);
function choose(g, index = 0) {
  assert.equal(g.snapshot().pending.kind, 'owned-attack');
  answer(g, [g.snapshot().pending.options[index]]);
}

test('a lock body preserves its approved embedded-reaction grammar while replaying the original instruction', async () => {
  const reaction = { op: 'delayedReaction', side: 'own', target: 'self',
    trigger: { event: 'attackDamage', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global' },
    program: [{ op: 'draw', count: 1 }], duration: 'untilNextOpponentTurnEnd',
    clearOnBench: true, clearOnEvolution: true };
  const { f, g } = await setup([lock(), reaction]);
  let r = restore(g, f); choose(r);
  assert.equal(r.snapshot().pending.kind, 'effect-target');
  answer(r, [r.snapshot().pending.options[0]]);
  r = restore(r, f);
  assert.equal(r.snapshot().ongoing.filter((e) => e.effect.op === 'ownedAttackRestriction').length, 1);
  assert.equal(r.snapshot().ongoing.filter((e) => e.effect.op === 'reaction').length, 1);
  const before = r.snapshot().players[0].deck.length;
  command(r, { type: 'attack', attackId: 'base:other-choice' });
  assert.equal(r.snapshot().players[0].deck.length, before - 2,
    'One original deferred draw and the actual next own turn draw resolve, with no new owned-lock declaration.');
  restore(r, f);
});

test('two identical lock leaves in one invocation retain different original positions and independent choices', async () => {
  const { f, g } = await setup([lock(), lock()]);
  let r = restore(g, f); const first = r.snapshot().pending.id;
  choose(r); r = restore(r, f);
  const second = r.snapshot().pending.id;
  assert.notEqual(first, second);
  const requested = records(r.snapshot(), 'requested');
  assert.equal(requested.length, 2);
  assert.equal(requested[0].data.programId, requested[1].data.programId);
  assert.notEqual(requested[0].data.programIndex, requested[1].data.programIndex);
  assert.equal(r.snapshot().pending.options.length, 2, 'The already locked attack remains printed-owned.');
  choose(r, 1); r = restore(r, f);
  assert.equal(records(r.snapshot(), 'answered').length, 2);
  assert.equal(records(r.snapshot(), 'applied').length, 2);
  assert.equal(r.snapshot().ongoing.filter((e) => e.effect.op === 'ownedAttackRestriction').length, 2);
  assert.deepEqual(r.view(1).legalActions.filter((a) => a.type === 'attack'), []);
  const bad = clone(r.snapshot()), requests = records(bad, 'requested');
  requests[1].data.programIndex = requests[0].data.programIndex;
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
});

test('conceding during an owned prompt retains the original unconsumed history without inventing an answer or lock', async () => {
  const { f, g } = await setup(), before = g.snapshot();
  command(g, { type: 'concede' }, 0);
  const after = restore(g, f).snapshot();
  assert.equal(after.result.winner, 1); assert.equal(after.result.reason, 'concede');
  assert.equal(after.pending, null); assert.equal(after.ongoing.length, 0);
  assert.equal(records(after, 'requested').length, 1);
  assert.equal(records(after, 'answered').length, 0);
  assert.equal(records(after, 'applied').length, 0);
  assert.deepEqual(after.rng, before.rng); assert.deepEqual(after.cards, before.cards);
});

test('completed nonempty choices still require their original unique private pause, not only matching applied journals', async () => {
  const { f, g } = await setup(); choose(g); restore(g, f);
  for (const duplicate of [false, true]) {
    const bad = clone(g.snapshot()), index = bad.events.findIndex((e) =>
      e.ruleId === 'selection.request' && e.data.request.kind === 'owned-attack');
    assert(index >= 0);
    if (duplicate) bad.events.push(clone(bad.events[index]));
    else bad.events.splice(index, 1);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), { code: 'invalid-owned-attack-lock' });
  }
});
