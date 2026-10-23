// Real OfficialGame state/choice regressions; all cards and approvals synthetic.
// Printed attacks are public; this protocol's requested/applied journals are private.
// Private host execution/checkpoints are not a
// cryptographic log: these tests do not rewrite a complete coherent history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, playerView } from '../../public/rules/game.js';
import { attackOptionId } from '../../public/rules/attack-copy.js';
import {
  fixture, binding, EVIDENCE, board, fixtureClock, hand, bench, attached, command, answer, settle,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const RULE = 'attack.owned-lock';
const EXECUTION = 'effects.execution';
const REQUEST = 'selection.request';
const spec = () => ({
  op: 'disableOwnedAttack', side: 'opponent', target: 'active', duration: 'nextOpponentTurn',
  clearOnBench: true, clearOnEvolution: true,
});
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const contains = (value, needle) => value === needle || !!value && typeof value === 'object' &&
  Object.values(value).some((child) => contains(child, needle));
async function make({ protectedTarget = false, attackCount = 2, inherit = false } = {}) {
  const f = await fixture((defs) => {
    const source = defs[0].mechanics.attacks[0];
    source.printedDamage = { value: 0, operator: 'fixed' };
    source.effects = [binding('cn.disableOwnedAttack@1', spec(), 'owned-lock:body')];
    const target = defs[1].mechanics;
    const printed = clone(target.attacks[0]);
    if (attackCount === 0) target.attacks = [];
    if (attackCount === 2) target.attacks.push({ ...clone(printed), attackId: 'other:second', name: '测试另一招式',
      printedDamage: { value: 10, operator: 'fixed' } });
    defs.find((d) => d.definitionId === 'tool').mechanics.grantedAttacks = [
      { ...clone(printed), attackId: 'tool:extra', name: '测试道具授予招式', cost: [] },
    ];
    if (inherit) target.abilities.push({
      abilityId: 'inherit-same-name', name: '测试同名继承', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: 'inherit-same-name', limit: 1 },
      sourceOfTruth: EVIDENCE, effects: [binding('cn.pokemonTransition@1', {
        op: 'inheritPokemon', target: 'self', targetSelector: { kind: 'pokemon' }, from: 'hand',
        selector: { kind: 'pokemon', nameKeys: ['other'] }, relation: 'sameName', to: 'hand',
      }, 'owned-lock:inherit')],
    });
    if (protectedTarget) target.effects.push(binding('cn.protection@1', { effect: {
      op: 'protection', useRule: 'ordinary', scope: 'self', channel: 'effects',
      from: 'opponent', categories: ['attack'],
    } }, 'owned-lock:protection'));
  });
  return { ...f, attackCount, inherit };
}
function setup(f, owner = 0) {
  let targetId, topCardId, toolId, replacementId;
  const g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    const recipient = 1 - owner, p = s.players[recipient], old = p.active;
    const target = bench(s, recipient, 'other'); p.bench.pop(); p.active = target; p.bench.push(old);
    bench(s, owner, 'other');
    targetId = target.id; topCardId = target.stack.at(-1);
    toolId = hand(s, recipient, 'tool'); p.hand.pop(); target.tools.push(toolId);
    attached(s, owner, s.players[owner].active, 'water');
    attached(s, recipient, target, 'water');
    if (f.inherit) replacementId = hand(s, recipient, 'other');
  });
  const before = g.snapshot(); conservation(before, before.cards);
  command(g, { type: 'attack', attackId: 'base:strike' }, owner);
  return { g, f, owner, recipient: 1 - owner, targetId, topCardId, toolId, replacementId, before,
    refs: [{ instanceId: topCardId, attackId: 'other:strike' }, { instanceId: topCardId, attackId: 'other:second' }].slice(0, f.attackCount) };
}
function conservation(s, cards) {
  assert.deepEqual(s.cards, cards);
  const all = [];
  for (const owner of [0, 1]) {
    const p = s.players[owner], ids = ['deck', 'hand', 'discard', 'lost', 'prizes', 'resolving'].flatMap((z) => p[z]);
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
function atomic(g, run, label) {
  const saved = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(run, undefined, label);
  assert.deepEqual(g.snapshot(), saved, `${label}: no RNG, counters, facts, queue, lock, event or revision mutation.`);
  assert.deepEqual([g.view(0), g.view(1)], views); conservation(g.snapshot(), saved.cards);
}
function rejectCases(g, f, cases) {
  const saved = g.snapshot(), views = [g.view(0), g.view(1)], accepted = [];
  for (const [label, mutate] of cases) {
    const bad = clone(saved); mutate(bad); const supplied = clone(bad);
    let rejected = false;
    try { OfficialGame.restore(bad, { catalog: f.catalog }); } catch { rejected = true; }
    if (!rejected) accepted.push(label);
    assert.deepEqual(bad, supplied, `${label}: reject rather than repairing/mutating the supplied snapshot.`);
    assert.deepEqual(g.snapshot(), saved, label); assert.deepEqual([g.view(0), g.view(1)], views, label);
  }
  conservation(g.snapshot(), saved.cards);
  assert.deepEqual(accepted, [], 'No independently forged owned-attack continuation or bound lock may restore.');
}
const records = (s, kind) => s.events.filter((e) => e.ruleId === RULE && e.data.kind === kind);
function requested(s) {
  const id = s.pending.data.ownedAttackChoice.id;
  const found = records(s, 'requested').filter((e) => e.data.id === id);
  assert.equal(found.length, 1); return found[0];
}
function checkpoint(s) {
  return clone({ queue: s.queue, attack: s.attack, serial: s.serial, revision: s.revision, turn: s.turn,
    current: s.current, phase: s.phase, first: s.first, nextPlayer: s.nextPlayer, vacancies: s.vacancies });
}
function selection(s) {
  const found = s.events.filter((e) => e.ruleId === REQUEST && e.data.request?.id === s.pending.id);
  assert.equal(found.length, 1); assert.equal(found[0].visibility, 'private');
  assert.deepEqual(found[0].data.request, s.pending); assert.deepEqual(found[0].data.work, checkpoint(s)); return found[0];
}
function coherent(s, mutate) {
  const seal = selection(s), publicRequest = requested(s);
  mutate(s.pending, s);
  publicRequest.data.id = s.pending.data.ownedAttackChoice.id;
  publicRequest.data.choice = clone(s.pending.data.ownedAttackChoice);
  publicRequest.data.source = clone(s.pending.data.source);
  publicRequest.data.action = clone(s.pending.data.action);
  seal.data.request = clone(s.pending); seal.data.work = checkpoint(s);
}
function execution(s) {
  const id = s.pending.data.programId; assert.equal(typeof id, 'string'); assert(id.length);
  const events = s.events.filter((e) => e.ruleId === EXECUTION && e.data.id === id);
  assert.equal(events.filter((e) => e.data.kind === 'scheduled').length, 1);
  assert.equal(events.filter((e) => e.data.kind === 'opened').length, 1);
  return { id, events, opened: events.find((e) => e.data.kind === 'opened') };
}
function apply(c, ref = c.refs[0]) {
  const r = restore(restore(c.g, c.f), c.f);
  answer(r, [attackOptionId(ref)]); settle(r); return r;
}
function applied(s, id) {
  const found = records(s, 'applied').filter((e) => e.data.id === id);
  assert.equal(found.length, 1); return found[0];
}
function answered(s, id) {
  const found = records(s, 'answered').filter((e) => e.data.id === id);
  assert.equal(found.length, 1); assert.equal(found[0].visibility, 'private'); return found[0];
}
function entry(s, id) {
  const result = s.ongoing.find((e) => e.ownedAttackLockId === id); assert(result, 'A performed lock must retain its applied-receipt link.');
  return result;
}

test('both owners restore the exact public printed-attack window and apply one source-bound next-opponent-turn lock without RNG or card changes', async () => {
  const f = await make();
  for (const owner of [0, 1]) {
    const c = setup(f, owner), saved = c.g.snapshot(), q = saved.pending, choice = q.data.ownedAttackChoice;
    assert.equal(q.kind, 'owned-attack'); assert.equal(q.ruleId, RULE); assert.equal(q.player, owner);
    assert.equal(q.id, choice.id);
    assert.deepEqual(q.options, c.refs.map(attackOptionId));
    assert.equal(q.minimum, 1); assert.equal(q.maximum, 1); assert.equal(q.allowZero, false);
    assert.deepEqual(choice, { id: choice.id, turn: c.before.turn, sourceId: c.before.players[owner].active.stack.at(-1),
      historyIndex: c.before.battleHistory.events.length + 1, // after the attack's own attackUsed fact
      owner: c.recipient, target: { pokemonId: c.targetId, topCardId: c.topCardId }, candidates: c.refs });
    const trace = execution(saved), request = requested(saved);
    assert.equal(request.visibility, 'private');
    assert.deepEqual(request.data.action, spec()); assert.deepEqual(request.data.choice, choice);
    assert.equal(request.data.programId, trace.id); assert(Number.isSafeInteger(request.data.programIndex));
    assert.deepEqual(trace.opened.data.program, [spec()]); selection(saved);
    assert.deepEqual(saved.rng, c.before.rng);
    const direct = restore(c.g, f), r = apply(c);
    answer(direct, [attackOptionId(c.refs[0])]); settle(direct);
    assert.deepEqual(r.snapshot(), direct.snapshot());
    const after = r.snapshot(), result = applied(after, choice.id).data, lock = entry(after, choice.id);
    assert.equal(applied(after, choice.id).visibility, 'private');
    assert.deepEqual(answered(after, choice.id).data, { ...clone(request.data), kind: 'answered', selected: [c.refs[0]] });
    assert.deepEqual(result.choice, choice); assert.deepEqual(result.selected, [c.refs[0]]); assert.equal(result.performed, true);
    assert.equal(result.programId, request.data.programId); assert.equal(result.programIndex, request.data.programIndex);
    assert.equal(result.entryId, lock.id); assert.equal(lock.targetId, c.targetId);
    assert.deepEqual(lock.effect, { op: 'ownedAttackRestriction', scope: 'all', reference: c.refs[0] });
    assert.equal(lock.duration, 'nextOpponentTurn'); assert.equal(lock.clearOnBench, true); assert.equal(lock.clearOnEvolution, true);
    assert.deepEqual(lock.deadline, { player: c.recipient, ownerTurn: c.before.players[c.recipient].turns + 1, boundary: 'turn-end' });
    assert.equal(after.current, c.recipient);
    assert(!r.view(c.recipient).legalActions.some((a) => a.type === 'attack' && a.attackId === 'other:strike'));
    assert(r.view(c.recipient).legalActions.some((a) => a.type === 'attack' && a.attackId === 'other:second'));
    assert.deepEqual(after.rng, c.before.rng);
    for (const player of [0, 1]) assert.deepEqual(mons(after, player).map((m) => m.counters), mons(c.before, player).map((m) => m.counters));
    conservation(after, c.before.cards); restore(r, f);
  }
});

test('one printed owned attack still requires a sealed choice; Tool-only extra attacks do not create an owned window or lock', async () => {
  for (const attackCount of [1, 0]) {
    const f = await make({ attackCount }), c = setup(f), waiting = c.g.snapshot();
    if (attackCount === 1) {
      assert.equal(waiting.pending.kind, 'owned-attack');
      assert.deepEqual(waiting.pending.options, c.refs.map(attackOptionId)); selection(waiting);
      const r = apply(c), id = waiting.pending.data.ownedAttackChoice.id;
      assert.equal(applied(r.snapshot(), id).data.performed, true); answered(r.snapshot(), id);
      assert(r.view(1).legalActions.some((a) => a.type === 'attack' && a.attackId === 'tool:extra'));
      restore(r, f);
    } else {
      assert.equal(waiting.pending, null); assert.equal(waiting.ongoing.length, 0);
      const request = records(waiting, 'requested'); assert.equal(request.length, 1);
      assert.deepEqual(request[0].data.choice.candidates, []);
      const result = applied(waiting, request[0].data.id).data;
      assert.deepEqual(result.selected, []); assert.equal(result.performed, false); assert.equal(result.entryId, null);
      assert.equal(records(waiting, 'answered').length, 0, 'An empty owned window is not a fabricated player answer.');
      restore(c.g, f);
    }
    assert.deepEqual(c.g.snapshot().rng, c.before.rng); conservation(c.g.snapshot(), c.before.cards);
  }
});

test('empty, duplicate, foreign, granted, malformed and unknown choices plus wrong actor/request/revision all reject atomically', async () => {
  const f = await make(), c = setup(f), s = c.g.snapshot(), option = attackOptionId(c.refs[0]);
  for (const selected of [
    [], [option, option], c.refs.map(attackOptionId), ['other:strike'],
    [JSON.stringify([c.topCardId])], [JSON.stringify({ ...c.refs[0] })], ['not-json'],
    [attackOptionId({ instanceId: c.toolId, attackId: 'tool:extra' })],
    [attackOptionId({ instanceId: c.before.players[0].active.stack.at(-1), attackId: 'base:strike' })],
    [attackOptionId({ instanceId: c.topCardId, attackId: 'not-a-printed-attack' })],
  ]) atomic(c.g, () => answer(c.g, selected), `Invalid owned attack ${JSON.stringify(selected)}`);
  atomic(c.g, () => command(c.g, { type: 'answer', requestId: s.pending.id, selected: [option] }, 1), 'Wrong chooser');
  atomic(c.g, () => command(c.g, { type: 'answer', requestId: `${s.pending.id}-old`, selected: [option] }), 'Wrong request');
  for (const expectedRevision of [s.revision - 1, s.revision + 1])
    atomic(c.g, () => c.g.dispatch({ player: 0, expectedRevision, action: { type: 'answer', requestId: s.pending.id, selected: [option] } }), 'Wrong revision');
  restore(c.g, f);
});

test('the original selection seal rejects all independently changed prompt fields and preselected data', async () => {
  const f = await make(), { g } = setup(f); selection(g.snapshot());
  rejectCases(g, f, [
    ['request id', (s) => { s.pending.id += '-forged'; }],
    ['kind', (s) => { s.pending.kind = 'copy-attack'; }],
    ['rule', (s) => { s.pending.ruleId = 'attack.copy'; }],
    ['player', (s) => { s.pending.player = 1; }],
    ['options', (s) => { s.pending.options.reverse(); }],
    ['minimum', (s) => { s.pending.minimum = 0; }],
    ['maximum', (s) => { s.pending.maximum = 2; }],
    ['zero permission', (s) => { s.pending.allowZero = true; }],
    ['resume', (s) => { s.pending.resume = 'choose-order'; }],
    ['preselected', (s) => { s.pending.data.selected = [s.pending.options[0]]; }],
  ]);
});

test('restoring rejects stale target/top cards, candidates, source identity, holder and turn', async () => {
  const f = await make(), { g } = setup(f);
  rejectCases(g, f, [
    ['missing choice', (s) => { delete s.pending.data.ownedAttackChoice; }],
    ['choice id', (s) => { s.pending.data.ownedAttackChoice.id += '-forged'; }],
    ['turn', (s) => { s.pending.data.ownedAttackChoice.turn++; }],
    ['choice source', (s) => { s.pending.data.ownedAttackChoice.sourceId = s.players[1].active.stack.at(-1); }],
    ['choice owner', (s) => { s.pending.data.ownedAttackChoice.owner = 0; }],
    ['null target', (s) => { s.pending.data.ownedAttackChoice.target = null; }],
    ['target Pokémon', (s) => { s.pending.data.ownedAttackChoice.target.pokemonId = s.players[1].bench[0].id; }],
    ['target top', (s) => { s.pending.data.ownedAttackChoice.target.topCardId = s.players[1].deck[0]; }],
    ['live top changed', (s) => {
      const p = s.players[1], id = hand(s, 1, 'evolution'); p.hand.pop(); p.active.stack.push(id);
    }],
    ['reordered candidates', (s) => { s.pending.data.ownedAttackChoice.candidates.reverse(); }],
    ['missing candidate', (s) => { s.pending.data.ownedAttackChoice.candidates.pop(); }],
    ['duplicate candidate', (s) => { s.pending.data.ownedAttackChoice.candidates[1] = clone(s.pending.data.ownedAttackChoice.candidates[0]); }],
    ['source owner', (s) => { s.pending.data.source.owner = 1; }],
    ['source binding', (s) => { s.pending.data.source.effectId += '-forged'; }],
    ['source evidence', (s) => { s.pending.data.source.sourceOfTruth[0].locator = 'forged'; }],
  ]);
});

test('coherent current/public request/checkpoint edits cannot authorize a foreign or granted attack or detach the target window', async () => {
  const f = await make(), c = setup(f);
  rejectCases(c.g, f, [
    ['foreign physical card', (s) => coherent(s, (q) => {
      q.data.ownedAttackChoice.candidates[0].instanceId = c.before.players[0].active.stack.at(-1);
      q.options = q.data.ownedAttackChoice.candidates.map(attackOptionId);
    })],
    ['Tool-granted attack', (s) => coherent(s, (q) => {
      q.data.ownedAttackChoice.candidates.push({ instanceId: c.toolId, attackId: 'tool:extra' });
      q.options = q.data.ownedAttackChoice.candidates.map(attackOptionId);
    })],
    ['bench target', (s) => coherent(s, (q, live) => {
      const m = live.players[1].bench[0];
      q.data.ownedAttackChoice.target = { pokemonId: m.id, topCardId: m.stack.at(-1) };
    })],
    ['source identity', (s) => coherent(s, (q) => { q.data.ownedAttackChoice.sourceId = c.topCardId; })],
  ]);
});

test('native program/action identity, continuation frames and unique token cannot be changed or downgraded into untracked queued work', async () => {
  const f = await make(), c = setup(f);
  rejectCases(c.g, f, [
    ['no token', (s) => coherent(s, (q) => { delete q.data.programId; })],
    ['invented token', (s) => coherent(s, (q) => { q.data.programId += '-forged'; })],
    ['extra draw', (s) => coherent(s, (q) => { q.data.frames[0].remaining.push({ op: 'draw', count: 1 }); })],
    ['forged performed', (s) => coherent(s, (q) => { q.data.frames[0].performed = true; })],
    ['static opened action', (s) => {
      const opened = execution(s).opened;
      coherent(s, (q) => { q.data.action.clearOnBench = false; }); opened.data.program = [clone(s.pending.data.action)];
    }],
    ...[false, true].map((strip) => [`duplicate queued leaf strip=${strip}`, (s) => {
      const seal = selection(s), d = clone(s.pending.data);
      if (strip) { delete d.programId; delete d.ownedAttackChoice; }
      s.queue.unshift({ op: 'effect-choice', data: d }); seal.data.work = checkpoint(s);
    }]),
  ]);
});

test('the requested journal cannot be lost, duplicated, renamed, detached or claim the pending choice was already applied', async () => {
  const f = await make(), c = setup(f), saved = c.g.snapshot();
  const index = saved.events.findIndex((e) => e.ruleId === RULE && e.data.kind === 'requested'); assert(index >= 0);
  rejectCases(c.g, f, [
    ['missing request', (s) => { s.events.splice(index, 1); }],
    ['duplicate request', (s) => { s.events.push(clone(s.events[index])); }],
    ['renamed request', (s) => { s.events[index].data.kind = 'requested-renamed'; }],
    ['public request', (s) => { s.events[index].visibility = 'public'; }],
    ['request program', (s) => { s.events[index].data.programId += '-forged'; }],
    ['request program index', (s) => { s.events[index].data.programIndex++; }],
    ['request source', (s) => { s.events[index].data.source.owner = 1; }],
    ['request action', (s) => { s.events[index].data.action.clearOnEvolution = false; }],
    ['request choice', (s) => { s.events[index].data.choice.candidates.reverse(); }],
    ['already applied', (s) => {
      s.events.push({ ruleId: RULE, visibility: 'private', data: {
        kind: 'applied', id: s.pending.data.ownedAttackChoice.id, source: clone(s.pending.data.source),
        action: spec(), choice: clone(s.pending.data.ownedAttackChoice), selected: [c.refs[0]], performed: false, entryId: null,
        programId: s.pending.data.programId, programIndex: s.events[index].data.programIndex,
      } });
    }],
  ]);
});

test('an applied lock restores only with its exact ledger target, effect, source, duration, deadline and applied-receipt link', async () => {
  const f = await make(), c = setup(f), choice = c.g.snapshot().pending.data.ownedAttackChoice, r = apply(c);
  entry(r.snapshot(), choice.id); restore(r, f);
  rejectCases(r, f, [
    ['missing live ledger', (s) => { s.ongoing.splice(s.ongoing.findIndex((e) => e.ownedAttackLockId === choice.id), 1); }],
    ['missing link', (s) => { delete entry(s, choice.id).ownedAttackLockId; }],
    ['foreign link', (s) => { entry(s, choice.id).ownedAttackLockId += '-forged'; }],
    ['target', (s) => { entry(s, choice.id).targetId = s.players[1].bench[0].id; }],
    ['different attack', (s) => { entry(s, choice.id).effect.reference = clone(c.refs[1]); }],
    ['different physical reference', (s) => { entry(s, choice.id).effect.reference.instanceId = s.players[1].bench[0].stack.at(-1); }],
    ['generic restriction cannot stand in', (s) => {
      entry(s, choice.id).effect = { op: 'restriction', scope: 'all', actions: ['attack'], attackIds: [c.refs[0].attackId] };
    }],
    ['source holder', (s) => { entry(s, choice.id).source.owner = 1; }],
    ['source binding', (s) => { entry(s, choice.id).source.effectId += '-foreign'; }],
    ['source attack', (s) => { entry(s, choice.id).source.attackId = 'other:strike'; }],
    ['source provenance', (s) => { entry(s, choice.id).source.sourceOfTruth[0].locator = 'forged'; }],
    ['clear on bench', (s) => { entry(s, choice.id).clearOnBench = false; }],
    ['clear on evolution', (s) => { entry(s, choice.id).clearOnEvolution = false; }],
    ['deadline player', (s) => { entry(s, choice.id).deadline.player = 0; }],
    ['deadline turn', (s) => { entry(s, choice.id).deadline.ownerTurn++; }],
    ['duration', (s) => {
      const e = entry(s, choice.id); e.duration = 'untilNextOpponentTurnEnd'; e.deadline.boundary = 'checkup-end';
      e.ruleId = 'effects.duration.until-end';
    }],
    ['duplicate linked entry', (s) => { const e = clone(entry(s, choice.id)); e.id += '-duplicate'; s.ongoing.push(e); }],
  ]);
});

test('the applied result cannot change its selected reference, performed result, entryId, action or original source/window independently of the bound ledger', async () => {
  const f = await make(), c = setup(f), choice = c.g.snapshot().pending.data.ownedAttackChoice, r = apply(c);
  rejectCases(r, f, [
    ['missing original answer', (s) => { s.events.splice(s.events.findIndex((e) => e.ruleId === RULE && e.data.kind === 'answered'), 1); }],
    ['duplicate original answer', (s) => { s.events.push(clone(answered(s, choice.id))); }],
    ['changed original answer', (s) => { answered(s, choice.id).data.selected = [clone(c.refs[1])]; }],
    ['missing applied result', (s) => { s.events.splice(s.events.findIndex((e) => e.ruleId === RULE && e.data.kind === 'applied'), 1); }],
    ['duplicate applied result', (s) => { s.events.push(clone(applied(s, choice.id))); }],
    ['public applied result', (s) => { applied(s, choice.id).visibility = 'public'; }],
    ['different program', (s) => { applied(s, choice.id).data.programId += '-forged'; }],
    ['different program index', (s) => { applied(s, choice.id).data.programIndex++; }],
    ['different selected', (s) => { applied(s, choice.id).data.selected = [clone(c.refs[1])]; }],
    ['coherent result/ledger cannot replace the actual answer', (s) => {
      applied(s, choice.id).data.selected = [clone(c.refs[1])];
      entry(s, choice.id).effect.reference = clone(c.refs[1]);
    }],
    ['empty selected', (s) => { applied(s, choice.id).data.selected = []; }],
    ['performed false', (s) => { applied(s, choice.id).data.performed = false; }],
    ['missing entry id', (s) => { applied(s, choice.id).data.entryId = null; }],
    ['different entry id', (s) => { applied(s, choice.id).data.entryId += '-forged'; }],
    ['different action', (s) => { applied(s, choice.id).data.action.duration = 'nextOwnTurn'; }],
    ['different source', (s) => { applied(s, choice.id).data.source.owner = 1; }],
    ['different original top', (s) => { applied(s, choice.id).data.choice.target.topCardId = s.players[1].deck[0]; }],
  ]);
});

test('coherently retargeting completed owned-lock journals and ledger cannot detach them from the original unchanged private selection pause', async () => {
  const f = await make(), c = setup(f), id = c.g.snapshot().pending.data.ownedAttackChoice.id, r = apply(c);
  const saved = r.snapshot(), views = [r.view(0), r.view(1)], bad = clone(saved);
  assert.equal(saved.pending, null, 'This checks historical anchoring after application, not just a currently paused request.');
  const originalPauses = saved.events.filter((e) => e.ruleId === REQUEST);
  const originalExecutions = saved.events.filter((e) => e.ruleId === EXECUTION);
  const other = bad.players[c.recipient].bench.find((m) => m.id !== c.targetId &&
    bad.cards[m.stack.at(-1)].definitionId === 'base');
  assert(other);
  const ref = { instanceId: other.stack.at(-1), attackId: 'base:strike' };
  assert.deepEqual(f.catalog.definition('base').mechanics.attacks.map((a) => a.attackId), [ref.attackId]);
  const changed = bad.events.filter((e) => e.ruleId === RULE && e.data.id === id &&
    ['requested', 'answered', 'applied'].includes(e.data.kind));
  assert.equal(changed.length, 3);
  for (const event of changed) {
    event.data.choice.target = { pokemonId: other.id, topCardId: ref.instanceId };
    event.data.choice.candidates = [clone(ref)];
    if (Object.hasOwn(event.data, 'selected')) event.data.selected = [clone(ref)];
  }
  const lock = entry(bad, id);
  lock.targetId = other.id; lock.effect.reference = clone(ref);
  assert.deepEqual(changed[0].data.choice, changed[1].data.choice);
  assert.deepEqual(changed[1].data.choice, changed[2].data.choice);
  assert.deepEqual(changed[1].data.selected, changed[2].data.selected);
  assert.deepEqual(changed[2].data.selected, [lock.effect.reference]);
  assert.deepEqual(bad.events.filter((e) => e.ruleId === REQUEST), originalPauses,
    'The complete original private pending/work receipt remains unchanged.');
  assert.deepEqual(bad.events.filter((e) => e.ruleId === EXECUTION), originalExecutions,
    'No authoritative program output or advance is rewritten.');
  assert.deepEqual(bad.players, saved.players); conservation(bad, saved.cards);
  const supplied = clone(bad);
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), (error) =>
    error.code === 'invalid-owned-attack-lock' && /original private pause/.test(error.message),
  'Consistent new-namespace journals and ledger must fail at the original historical-pause anchor.');
  assert.deepEqual(bad, supplied); assert.deepEqual(r.snapshot(), saved);
  assert.deepEqual([r.view(0), r.view(1)], views);
  assert.deepEqual(r.snapshot().rng, c.before.rng); restore(r, f);
});

test('a new attack use cannot borrow the old consumed choice/token after the first lock expires', async () => {
  const f = await make(), c = setup(f), first = c.g.snapshot(), oldChoice = clone(first.pending.data.ownedAttackChoice);
  const oldToken = execution(first).id;
  let r = apply(c); const originalLock = clone(entry(r.snapshot(), oldChoice.id));
  command(r, { type: 'endTurn' }); settle(r);
  assert.equal(r.snapshot().current, 0); assert(!r.snapshot().ongoing.some((e) => e.ownedAttackLockId === oldChoice.id));
  const cleared = records(r.snapshot(), 'cleared').filter((e) => e.data.id === oldChoice.id);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].data.entryId, originalLock.id); assert.equal(cleared[0].data.reason, 'expiry');
  command(r, { type: 'attack', attackId: 'base:strike' });
  assert.equal(r.snapshot().pending.kind, 'owned-attack');
  assert.notEqual(r.snapshot().pending.data.ownedAttackChoice.id, oldChoice.id);
  assert.notEqual(execution(r.snapshot()).id, oldToken);
  rejectCases(r, f, [
    ['completed choice', (s) => { s.pending.data.ownedAttackChoice = clone(oldChoice); }],
    ['consumed id coherent', (s) => coherent(s, (q) => { q.data.ownedAttackChoice.id = oldChoice.id; })],
    ['completed token', (s) => coherent(s, (q) => { q.data.programId = oldToken; })],
    ['completed queued leaf', (s) => {
      const seal = selection(s); s.queue.unshift({ op: 'effect-choice', data: clone(first.pending.data) }); seal.data.work = checkpoint(s);
    }],
  ]);
  r = restore(r, f); answer(r, [attackOptionId(c.refs[1])]); settle(r);
  assert(r.view(1).legalActions.some((a) => a.type === 'attack' && a.attackId === 'other:strike'));
  assert(!r.view(1).legalActions.some((a) => a.type === 'attack' && a.attackId === 'other:second'));
  assert.deepEqual(r.snapshot().rng, c.before.rng); conservation(r.snapshot(), c.before.cards); restore(r, f);
});

test('clear lifecycle receipts cannot be removed, changed, duplicated or forged to retire a live lock; retained inheritance requires its actual ordered from/to event', async () => {
  const f = await make(), c = setup(f), id = c.g.snapshot().pending.data.ownedAttackChoice.id;
  const live = apply(c), originalLock = clone(entry(live.snapshot(), id));
  const expired = restore(live, f);
  command(expired, { type: 'endTurn' }); settle(expired); restore(expired, f);
  const saved = expired.snapshot(), index = saved.events.findIndex((e) => e.ruleId === RULE && e.data.kind === 'cleared' && e.data.id === id);
  assert(index >= 0); assert.equal(saved.events[index].visibility, 'private');
  assert.equal(saved.events[index].data.reason, 'expiry');
  assert.equal(saved.events[index].data.entryId, originalLock.id);
  assert(!saved.ongoing.some((e) => e.ownedAttackLockId === id));
  const reasons = ['bench', 'evolution', 'devolution', 'leave', 'knockout'];
  rejectCases(expired, f, [
    ['removed original clear', (s) => { s.events.splice(index, 1); }],
    ['duplicate clear receipt', (s) => { s.events.push(clone(s.events[index])); }],
    ['changed clear id', (s) => { s.events[index].data.id += '-forged'; }],
    ['changed cleared entry', (s) => { s.events[index].data.entryId += '-forged'; }],
    ['clear turn before deadline', (s) => { s.events[index].data.turn--; }],
    ['clear turn after deadline', (s) => { s.events[index].data.turn++; }],
    ...reasons.map((reason) => [`expiry relabelled ${reason}`, (s) => { s.events[index].data.reason = reason; }]),
    ...['public', 0, 1].map((visibility) => [
      `clear visibility ${visibility}`, (s) => { s.events[index].visibility = visibility; },
    ]),
    ['resurrect cleared ledger', (s) => { s.ongoing.push(clone(originalLock)); }],
  ]);
  rejectCases(live, f, ['expiry', ...reasons].map((reason) => [
    `forged ${reason} substitutes for a still-live lock`, (s) => {
      s.ongoing.splice(s.ongoing.findIndex((e) => e.ownedAttackLockId === id), 1);
      s.events.push({ ruleId: RULE, visibility: 'private',
        data: { kind: 'cleared', id, entryId: originalLock.id, reason, turn: s.turn,
          historyIndex: reason === 'leave' ? null : s.battleHistory.events.length } });
    },
  ]));

  // This is an actual inherited replacement, not a hand-edited live top card.
  // D owns the separate inheritance gameplay suite; only restore negatives are
  // added here, keeping the authoritative physical movement and its log fixed.
  const inheritedFixture = await make({ inherit: true }), inherited = setup(inheritedFixture);
  const inheritedId = inherited.g.snapshot().pending.data.ownedAttackChoice.id, r = apply(inherited);
  command(r, { type: 'useAbility', pokemonId: inherited.targetId, abilityId: 'inherit-same-name' });
  answer(r, [inherited.targetId]); answer(r, [inherited.replacementId]); settle(r);
  assert.equal(r.snapshot().players[1].active.stack.at(-1), inherited.replacementId);
  entry(r.snapshot(), inheritedId); restore(r, inheritedFixture);
  const eventIndex = r.snapshot().events.findIndex((e) => e.ruleId === 'effects.inherit' && e.data.pokemonId === inherited.targetId);
  assert(eventIndex >= 0);
  assert.equal(r.snapshot().events[eventIndex].data.fromCardId, inherited.topCardId);
  assert.equal(r.snapshot().events[eventIndex].data.toCardId, inherited.replacementId);
  rejectCases(r, inheritedFixture, [
    ['missing inherited link', (s) => { s.events.splice(eventIndex, 1); }],
    ['wrong inherited from', (s) => { s.events[eventIndex].data.fromCardId = s.players[1].deck[0]; }],
    ['wrong inherited to', (s) => { s.events[eventIndex].data.toCardId = s.players[1].deck[0]; }],
    ['wrong inherited subject', (s) => { s.events[eventIndex].data.pokemonId = s.players[1].bench[0].id; }],
    ['reversed inherited link', (s) => {
      const e = s.events[eventIndex].data; [e.fromCardId, e.toCardId] = [e.toCardId, e.fromCardId];
    }],
  ]);
  assert.deepEqual(r.snapshot().rng, inherited.before.rng); conservation(r.snapshot(), inherited.before.cards);
});

test('P1 matching generic bench/evolution/expiry logs cannot retire a live lock without changing the actual battle facts, players or clock', async () => {
  const f = await make(), c = setup(f), id = c.g.snapshot().pending.data.ownedAttackChoice.id, live = apply(c);
  const saved = live.snapshot(), lock = clone(entry(saved, id)), views = [live.view(0), live.view(1)];
  assert.equal(saved.current, c.recipient); assert.equal(saved.phase, 'main');
  assert(!live.view(c.recipient).legalActions.some((a) => a.type === 'attack' && a.attackId === c.refs[0].attackId));
  for (const reason of ['bench', 'evolution', 'expiry']) {
    const bad = clone(saved);
    bad.ongoing.splice(bad.ongoing.findIndex((e) => e.ownedAttackLockId === id), 1);
    const clear = { ruleId: RULE, visibility: 'private', data: {
      kind: 'cleared', id, entryId: lock.id, reason, turn: saved.turn,
      // This is only the would-be next fact slot. No real transition/turn end
      // was committed, so appending plausible public logs cannot populate it.
      historyIndex: saved.battleHistory.events.length,
    } };
    if (reason === 'bench') {
      bad.events.push(clear, { ruleId: 'status.clear', visibility: 'public', data: {
        player: c.recipient, from: c.targetId, to: saved.players[c.recipient].bench[0].id,
      } });
    } else if (reason === 'evolution') {
      const evolution = Object.values(saved.cards).find((card) =>
        card.owner === c.recipient && card.definitionId === 'evolution'); assert(evolution);
      bad.events.push(clear, { ruleId: 'turn.evolve', visibility: 'public', data: {
        player: c.recipient, cardId: evolution.instanceId, pokemonId: c.targetId,
        fromCardId: c.topCardId, origin: 'hand',
      } });
    } else {
      // Match the former cause-adjacency check exactly: expiration's generic
      // log precedes the private clear, unlike switch/evolution's later log.
      bad.events.push({ ruleId: lock.ruleId, visibility: 'public', data: {
        effectId: lock.id, expiredAt: lock.deadline.boundary, player: lock.deadline.player,
      } }, clear);
    }
    assert.deepEqual(bad.battleHistory, saved.battleHistory, `${reason}: no typed fact is invented or edited.`);
    assert.deepEqual(bad.players, saved.players, `${reason}: positions, top cards, counters, zones and player clocks stay fixed.`);
    for (const key of ['turn', 'current', 'first', 'nextPlayer', 'phase', 'revision', 'serial', 'rng', 'cards', 'vacancies', 'attack'])
      assert.deepEqual(bad[key], saved[key], `${reason}: ${key} remains unchanged.`);
    assert.deepEqual(bad.events.slice(0, saved.events.length), saved.events,
      `${reason}: original execution, selection and actual-history receipts remain untouched.`);
    conservation(bad, saved.cards);
    const supplied = clone(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }),
      (error) => error.code === 'invalid-owned-attack-lock',
      `${reason}: plausible generic log adjacency is not an actual causal battle fact.`);
    assert.deepEqual(bad, supplied);
    assert.deepEqual(live.snapshot(), saved); assert.deepEqual([live.view(0), live.view(1)], views);
  }
  restore(live, f);
});

test('a no-candidate false application cannot invent an answer, selected reference, performed result or resulting/cleared ledger', async () => {
  const f = await make({ attackCount: 0 }), c = setup(f), saved = c.g.snapshot();
  assert.equal(saved.pending, null); assert.equal(saved.ongoing.length, 0);
  const requests = records(saved, 'requested'); assert.equal(requests.length, 1);
  const request = requests[0], id = request.data.id;
  assert.deepEqual(request.data.choice.candidates, []);
  assert.deepEqual(applied(saved, id).data.selected, []); assert.equal(applied(saved, id).data.performed, false);
  assert.equal(applied(saved, id).data.entryId, null); assert.equal(records(saved, 'answered').length, 0);
  restore(c.g, f);
  const applicationIndex = saved.events.findIndex((e) => e.ruleId === RULE && e.data.kind === 'applied' && e.data.id === id);
  assert(applicationIndex >= 0);
  const forged = { instanceId: c.toolId, attackId: 'tool:extra' };
  rejectCases(c.g, f, [
    ['fabricated empty answer', (s) => {
      s.events.splice(applicationIndex, 0, { ruleId: RULE, visibility: 'private',
        data: { ...clone(request.data), kind: 'answered', selected: [] } });
    }],
    ['fabricated granted-attack answer', (s) => {
      s.events.splice(applicationIndex, 0, { ruleId: RULE, visibility: 'private',
        data: { ...clone(request.data), kind: 'answered', selected: [forged] } });
    }],
    ['fabricated selected ref', (s) => { applied(s, id).data.selected = [clone(forged)]; }],
    ['fabricated performed', (s) => { applied(s, id).data.performed = true; }],
    ['fabricated entry id for false result', (s) => { applied(s, id).data.entryId = 'fixture:invented-lock-entry'; }],
    ['fabricated answer/result pair', (s) => {
      s.events.splice(applicationIndex, 0, { ruleId: RULE, visibility: 'private',
        data: { ...clone(request.data), kind: 'answered', selected: [forged] } });
      const result = applied(s, id).data; result.selected = [clone(forged)]; result.performed = true;
      result.entryId = 'fixture:invented-lock-entry';
    }],
    ['fabricated clear for never-established lock', (s) => {
      s.events.push({ ruleId: RULE, visibility: 'private',
        data: { kind: 'cleared', id, entryId: 'fixture:invented-lock-entry', reason: 'expiry', turn: s.turn,
          historyIndex: s.battleHistory.events.length } });
    }],
    ['fabricated live ledger for false result', (s) => {
      s.ongoing.push({
        id: 'fixture:invented-lock-entry', targetId: c.targetId, source: clone(request.data.source),
        effect: { op: 'ownedAttackRestriction', scope: 'all', reference: forged }, ownedAttackLockId: id,
        duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
        deadline: { player: 1, ownerTurn: c.before.players[1].turns + 1, boundary: 'turn-end' },
        ruleId: 'effects.duration.turn-only',
      });
    }],
  ]);
  assert.deepEqual(c.g.snapshot().rng, c.before.rng); conservation(c.g.snapshot(), c.before.cards);
});

test('protected target attacks remain selectable but apply performed=false with no ledger entry, even across repeated restore', async () => {
  const f = await make({ protectedTarget: true }), c = setup(f);
  const s = c.g.snapshot(), choice = s.pending.data.ownedAttackChoice;
  assert.equal(s.pending.kind, 'owned-attack'); assert.deepEqual(s.pending.options, c.refs.map(attackOptionId));
  const r = apply(c), result = applied(r.snapshot(), choice.id).data;
  assert.deepEqual(result.selected, [c.refs[0]]); assert.equal(result.performed, false); assert.equal(result.entryId, null);
  assert(!r.snapshot().ongoing.some((e) => e.targetId === c.targetId));
  for (const id of ['other:strike', 'other:second']) assert(r.view(1).legalActions.some((a) => a.type === 'attack' && a.attackId === id));
  assert.deepEqual(r.snapshot().rng, c.before.rng); conservation(r.snapshot(), c.before.cards); restore(r, f);
});

test('public printed attack choices do not leak private execution, checkpoints, queue or RNG for either viewer, even if private event kinds are renamed', async () => {
  const f = await make(), c = setup(f), saved = c.g.snapshot(), info = execution(saved);
  selection(saved);
  for (const viewer of [0, 1]) {
    const view = c.g.view(viewer);
    assert(!Object.hasOwn(view, 'queue')); assert(!Object.hasOwn(view, 'rng')); assert(!Object.hasOwn(view, 'attack'));
    assert(!contains(view, info.id));
    assert(!view.events.some((e) => [EXECUTION, REQUEST, RULE].includes(e.ruleId)));
    if (viewer === c.owner) assert.deepEqual(view.pending.options, c.refs.map(attackOptionId));
    else assert.equal(view.pending, null);
  }
  const privateIndexes = saved.events.map((e, i) => [e, i]).filter(([e]) =>
    e.ruleId === EXECUTION && e.data.id === info.id || e.ruleId === REQUEST && e.data.request?.id === saved.pending.id ||
    e.ruleId === RULE && e.data.id === saved.pending.data.ownedAttackChoice.id).map(([, i]) => i);
  for (const index of privateIndexes) for (const visibility of ['public', 0, 1]) {
    const bad = clone(saved), marker = `fixture:owned-private:${index}:${visibility}`;
    bad.events[index].visibility = visibility; bad.events[index].data.kind = 'unknown-private-kind';
    bad.events[index].data.marker = marker;
    for (const viewer of [0, 1]) {
      const view = playerView(bad, f.catalog, viewer);
      assert(!contains(view, marker)); assert(!contains(view, info.id));
      assert(!view.events.some((e) => [EXECUTION, REQUEST, RULE].includes(e.ruleId)));
    }
  }
});
