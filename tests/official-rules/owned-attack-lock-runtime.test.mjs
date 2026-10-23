// Real OfficialGame integration with reviewed SYNTHETIC cards/handlers only.
// No actual card approval, imported metadata approval, or same-name/cross-route
// ruling is inferred from these deliberately distinct printed attack identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { attackOptionId } from '../../public/rules/attack-copy.js';
import { ongoingIsActive } from '../../public/rules/ongoing.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, hand, bench, attached, fixtureClock,
} from './fixtures.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const action = () => ({ op: 'disableOwnedAttack', side: 'opponent', target: 'active',
  duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true });
const move = (attackId, name, extra = {}) => ({
  attackId, name, cost: [], printedDamage: { value: 0, operator: 'fixed' }, effects: [], sourceOfTruth: EVIDENCE, ...extra,
});
const activated = (abilityId, effects) => ({
  abilityId, name: `测试解除路径${abilityId}`, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: abilityId, limit: 1 }, effects, sourceOfTruth: EVIDENCE,
});
const reviewed = (program, operations, extra = {}) => ({
  rulesetId: 'CN/V20261019', implementationVersion: 'synthetic-owned-lock-runtime-v1',
  timing: 'resolve', sourceOfTruth: EVIDENCE, operations,
  validateParameters: (p) => p !== null && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0,
  execute: () => clone(program), ...extra,
});
const shield = (channel) => ({ op: 'protection', scope: 'self', channel, useRule: 'ordinary',
  from: 'opponent', categories: ['attack'] });
const returnAction = (side = 'own') => ({
  op: 'returnPokemon', side, target: 'active', selector: { kind: 'pokemon' },
  quantity: { kind: 'exact', count: 1 }, to: 'hand', attachments: 'return', chooser: 'source',
  promotion: { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE },
});
const devolution = () => ({
  op: 'devolvePokemon', side: 'own', target: 'self', targetSelector: { kind: 'pokemon' },
  selection: { kind: 'all' }, layers: { kind: 'exact', count: 1 }, to: 'hand', chooser: 'source',
});
const ownSwitch = () => ({ side: 'own', chooser: 'self', affected: 'active' });
const logs = (s, ruleId, kind, id) => s.events.filter((e) => e.ruleId === ruleId &&
  (kind === undefined || e.data.kind === kind) && (id === undefined || e.data.id === id));
const locks = (s) => s.ongoing.filter((e) => e.effect.op === 'ownedAttackRestriction');
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const hasAttack = (g, owner, attackId) => g.view(owner).legalActions.some((a) => a.type === 'attack' && a.attackId === attackId);

async function make(transform = () => {}, handlers = new Map()) {
  return fixture((defs) => {
    defs[0].mechanics.attacks = [move('base:seal', '测试封口', {
      printedDamage: null, effects: [binding('cn.disableOwnedAttack@1', action(), 'owned-lock')],
    })];
    defs[1].mechanics.attacks = [move('other:alpha', '测试甲招式'), move('other:beta', '测试乙招式')];
    defs[2].mechanics.evolvesFrom = 'other';
    defs[2].mechanics.attacks = [move('evolution:alpha', '测试进化甲'), move('evolution:beta', '测试进化乙')];
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.switch@1', ownSwitch(), 'switch-back')];
    transform(defs);
  }, handlers);
}
function setHand(s, owner, definitions) {
  const p = s.players[owner], ids = [];
  p.deck.unshift(...p.hand.splice(0));
  for (const name of definitions) {
    const id = hand(s, owner, name); p.hand.pop(); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) { p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id); }
  return ids;
}
function hold(s, owner, mon, definitionId) {
  const id = hand(s, owner, definitionId); s.players[owner].hand.pop(); mon.tools.push(id); return id;
}
function stackEvolution(s, owner, mon) {
  const id = hand(s, owner, 'evolution'); s.players[owner].hand.pop(); mon.stack.push(id); return id;
}
function setup(f, {
  actor = 0, sourceBench = false, targetBench = false, targetBenchDefinition = 'base',
  targetEnergy = false, evolved = false, targetHand = [], mutate = () => {},
} = {}) {
  const c = { actor, owner: 1 - actor };
  c.g = board(f, (s) => {
    if (actor === 1) fixtureClock(s, [0, 1, 0, 1]);
    const p = s.players[c.owner], old = p.active;
    p.hand.push(...old.stack, ...old.energy, ...old.tools);
    p.active = bench(s, c.owner, 'other'); p.bench.pop();
    if (evolved) stackEvolution(s, c.owner, p.active);
    c.sourcePokemonId = s.players[actor].active.id; c.sourceId = s.players[actor].active.stack.at(-1);
    c.targetPokemonId = p.active.id; c.topCardId = p.active.stack.at(-1);
    if (sourceBench) c.sourceBenchId = bench(s, actor, 'other').id;
    if (targetBench) c.targetBenchId = bench(s, c.owner, targetBenchDefinition).id;
    if (targetEnergy) c.energyId = attached(s, c.owner, p.active, 'water');
    setHand(s, actor, []); c.hand = setHand(s, c.owner, targetHand);
    mutate(s, c); s.events = [];
  });
  return c;
}
function restored(g, f) {
  const saved = g.snapshot(), input = clone(saved), r = OfficialGame.restore(input, { catalog: f.catalog });
  assert.deepEqual(input, saved); assert.deepEqual(r.snapshot(), saved);
  assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  const receipts = logs(saved, 'selection.request', 'requested');
  assert(receipts.every((e) => e.visibility === 'private'));
  assert.equal(new Set(receipts.map((e) => e.data.request.id)).size, receipts.length);
  if (saved.pending) {
    const matching = receipts.filter((e) => e.data.request.id === saved.pending.id);
    assert.equal(matching.length, 1); assert.deepEqual(matching[0].data.request, saved.pending);
    const keys = ['queue', 'attack', 'serial', 'revision', 'turn', 'current', 'phase', 'first', 'nextPlayer', 'vacancies'];
    assert.deepEqual(matching[0].data.work, Object.fromEntries(keys.map((key) => [key, clone(saved[key])])));
  }
  for (const viewer of [0, 1]) {
    const view = g.view(viewer);
    assert(!view.events.some((e) => ['attack.owned-lock', 'selection.request', 'effects.execution'].includes(e.ruleId)));
    assert(!Object.hasOwn(view, 'queue')); assert(!Object.hasOwn(view, 'rng'));
    if (saved.pending?.player !== viewer) assert.equal(view.pending, null);
  }
  assert.deepEqual(g.snapshot(), saved); return r;
}
function run(g, f, a, player = g.snapshot().current) {
  const r = restored(g, f);
  command(g, a, player); command(r, a, player);
  assert.deepEqual(r.snapshot(), g.snapshot()); restored(g, f); return g;
}
function respond(g, f, selected) {
  const r = restored(g, f); answer(g, selected); answer(r, selected);
  assert.deepEqual(r.snapshot(), g.snapshot()); restored(g, f); return g;
}
function settleRestoring(g, f, policy = (q) => q.allowZero ? [] : q.options.slice(0, q.minimum)) {
  for (let n = 0; g.snapshot().pending; n++) {
    assert(n < 30, 'Finite synthetic-choice guard, not a game rule.');
    respond(g, f, policy(g.snapshot().pending, g.snapshot()));
  }
}
function atomic(g, fn) {
  const saved = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(fn); assert.deepEqual(g.snapshot(), saved);
  assert.deepEqual([g.view(0), g.view(1)], views);
}
function conserved(s, before) {
  assert.deepEqual(s.cards, before.cards); assert.deepEqual(s.rng, before.rng);
  for (const owner of [0, 1]) {
    const p = s.players[owner], ids = ['deck', 'hand', 'prizes', 'discard', 'lost', 'resolving'].flatMap((z) => p[z]);
    ids.push(...mons(s, owner).flatMap((m) => [...m.stack, ...m.energy, ...m.tools]));
    if (s.stadium && s.cards[s.stadium].owner === owner) ids.push(s.stadium);
    assert.equal(ids.length, 60); assert.equal(new Set(ids).size, 60);
    assert.deepEqual(new Set(ids), new Set(Object.keys(s.cards).filter((id) => s.cards[id].owner === owner)));
  }
}
function prompt(g, f, c) {
  const s = g.snapshot(), q = s.pending, d = q.data;
  c.ownerTurnAtChoice = s.players[c.owner].turns;
  const printed = f.catalog.definition(s.cards[c.topCardId].definitionId).mechanics.attacks;
  const refs = printed.map((a) => ({ instanceId: c.topCardId, attackId: a.attackId }));
  assert.equal(q.kind, 'owned-attack'); assert.equal(q.player, c.actor); assert.equal(q.ruleId, 'attack.owned-lock');
  assert.deepEqual(q.options, refs.map(attackOptionId)); assert.equal(q.minimum, 1); assert.equal(q.maximum, 1);
  assert.equal(q.allowZero, false); assert.deepEqual(d.action, action()); assert.equal(typeof d.programId, 'string');
  const added = s.battleHistory.events.slice(c.historyBefore).map((e) => e.kind);
  assert.deepEqual(added.filter((k) => k !== 'attackDamage'), ['attackUsed'],
    'These fixed synthetic programs add no battle-history facts but the declared attack and its damage before the owned choice.');
  c.historyIndexAtChoice = s.battleHistory.events.length;
  assert.deepEqual(d.ownedAttackChoice, { id: q.id, turn: s.turn, sourceId: c.sourceId, owner: c.owner,
    target: { pokemonId: c.targetPokemonId, topCardId: c.topCardId }, candidates: refs,
    historyIndex: c.historyIndexAtChoice });
  const requests = logs(s, 'attack.owned-lock', 'requested', q.id);
  assert.equal(requests.length, 1); assert.equal(requests[0].visibility, 'private');
  assert.deepEqual(requests[0].data.choice, d.ownedAttackChoice);
  assert.deepEqual(requests[0].data.source, d.source); assert.deepEqual(requests[0].data.action, action());
  assert.equal(requests[0].data.programId, d.programId);
  assert(Number.isSafeInteger(requests[0].data.programIndex) && requests[0].data.programIndex >= 0);
  const view = g.view(c.actor).pending;
  assert.deepEqual(view.attacks.map((a) => ({ optionId: a.optionId, attackId: a.attackId,
    name: a.name, cost: a.cost, printedDamage: a.printedDamage })),
  printed.map((a, i) => ({ optionId: attackOptionId(refs[i]), attackId: a.attackId,
    name: a.name, cost: a.cost, printedDamage: a.printedDamage })));
  for (const a of view.attacks) for (const key of ['effects', 'bindings', 'parameters']) assert(!Object.hasOwn(a, key));
  assert.equal(g.view(c.owner).pending, null); restored(g, f);
  return clone(q);
}
function assertLock(s, c, q, attackId) {
  const entries = locks(s).filter((e) => e.ownedAttackLockId === q.id);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.targetId, c.targetPokemonId);
  assert.deepEqual(entry.effect, { op: 'ownedAttackRestriction', scope: 'all',
    reference: { instanceId: c.topCardId, attackId } });
  assert(!Object.hasOwn(entry.effect, 'attackIds'), 'The lock retains an owned reference, not a guessed generic ID/name restriction.');
  assert.equal(entry.duration, 'nextOpponentTurn'); assert.equal(entry.clearOnBench, true); assert.equal(entry.clearOnEvolution, true);
  assert.equal(entry.source.instanceId, c.sourceId); assert.equal(entry.source.pokemonId, c.sourcePokemonId);
  assert.equal(entry.source.owner, c.actor); assert.equal(entry.source.category, 'attack');
  assert.deepEqual(entry.deadline, { player: c.owner, ownerTurn: c.ownerTurnAtChoice + 1, boundary: 'turn-end' });
  const applied = logs(s, 'attack.owned-lock', 'applied', q.id);
  assert.equal(applied.length, 1); assert.equal(applied[0].visibility, 'private');
  assert.equal(applied[0].data.performed, true); assert.equal(applied[0].data.entryId, entry.id);
  assert.deepEqual(applied[0].data.selected, [entry.effect.reference]);
  assert.deepEqual(applied[0].data.choice, q.data.ownedAttackChoice);
  assert.equal(applied[0].data.programId, q.data.programId);
  return entry;
}
const choose = (g, f, c, attackId = 'other:alpha') => respond(g, f, [attackOptionId({ instanceId: c.topCardId, attackId })]);
const seal = (g, f, c) => {
  // The declared attack itself (attackUsed, history.previous-own-attack) and the damage it dealt are the new facts.
  c.historyBefore = g.snapshot().battleHistory.events.length;
  return run(g, f, { type: 'attack', attackId: 'base:seal' }, c.actor);
};

test('both source actors choose one opponent Active printed attack, retain the owned receipt, and prohibit only that reference on the next opponent turn', async () => {
  for (const actor of [0, 1]) {
    const f = await make(), c = setup(f, { actor }), before = c.g.snapshot();
    seal(c.g, f, c); const q = prompt(c.g, f, c);
    assert.equal(locks(c.g.snapshot()).length, 0, 'Inspecting an owned window has not yet attached a restriction.');
    choose(c.g, f, c);
    const after = c.g.snapshot(), entry = assertLock(after, c, q, 'other:alpha');
    assert.equal(after.current, c.owner); assert(ongoingIsActive(entry, after));
    assert.equal(hasAttack(c.g, c.owner, 'other:alpha'), false); assert(hasAttack(c.g, c.owner, 'other:beta'));
    atomic(c.g, () => command(c.g, { type: 'attack', attackId: 'other:alpha' }, c.owner));
    conserved(after, before); restored(c.g, f);
  }
});

test('the current printed window ignores missing Energy, real used VSTAR quota, an already applied prior lock, and Tool-granted attacks', async () => {
  const f = await make((defs) => {
    defs[1].mechanics.ruleBox = true;
    defs[1].mechanics.attacks[0].cost = ['Fire', 'Fire'];
    defs[1].mechanics.attacks[1].specialRule = 'VSTAR';
    defs[0].mechanics.attacks[0].effects.unshift(binding('cn.lasting@1', {
      side: 'opponent', target: 'active',
      effect: { op: 'restriction', scope: 'all', actions: ['attack'], attackIds: ['other:alpha'] },
      duration: 'untilNextOpponentTurnEnd', clearOnBench: true, clearOnEvolution: true,
    }, 'prior-lock'));
    const tool = defs.find((d) => d.definitionId === 'tool').mechanics;
    tool.effects = []; tool.grantedAttacks = [move('tool:bonus', '测试外来招式')];
  });
  const c = setup(f, { mutate: (s) => {
    fixtureClock(s, [0, 1, 0, 1]); hold(s, 1, s.players[1].active, 'tool');
  } }), before = c.g.snapshot();
  run(c.g, f, { type: 'attack', attackId: 'other:beta' }, 1);
  assert.equal(c.g.snapshot().players[1].vstarUsed, true);
  assert.equal(c.g.snapshot().players[1].active.facts.lastUsedAttack.attackId, 'other:beta');
  seal(c.g, f, c);
  assert.equal(c.g.snapshot().pending.kind, 'effect-target');
  respond(c.g, f, [c.targetPokemonId]);
  const q = prompt(c.g, f, c);
  assert.deepEqual(c.g.snapshot().players[1].active.energy, []);
  assert(c.g.view(0).players[1].active.effective.attackRequirements.some((a) => a.attackId === 'tool:bonus'));
  assert(c.g.snapshot().ongoing.some((e) => e.source.effectId === 'fixture:prior-lock'));
  assert.deepEqual(q.options, ['other:alpha', 'other:beta'].map((attackId) => attackOptionId({ instanceId: c.topCardId, attackId })));
  choose(c.g, f, c, 'other:beta'); assertLock(c.g.snapshot(), c, q, 'other:beta');
  assert(hasAttack(c.g, 1, 'tool:bonus')); conserved(c.g.snapshot(), before);
});

test('an evolved Active offers only its current top card’s printed attacks, not the lower Basic or an unrelated Bench', async () => {
  const f = await make(), c = setup(f, { evolved: true, targetBench: true, targetBenchDefinition: 'other' });
  const before = c.g.snapshot(); seal(c.g, f, c);
  const q = prompt(c.g, f, c), lower = before.players[1].active.stack[0];
  assert(q.options.every((option) => JSON.parse(option)[0] === c.topCardId));
  assert(!q.options.includes(attackOptionId({ instanceId: lower, attackId: 'other:alpha' })));
  choose(c.g, f, c, 'evolution:alpha'); assertLock(c.g.snapshot(), c, q, 'evolution:alpha');
  assert.equal(hasAttack(c.g, 1, 'evolution:alpha'), false); assert(hasAttack(c.g, 1, 'evolution:beta'));
  conserved(c.g.snapshot(), before);
});

test('effects protection preserves the exact-one candidate choice but blocks attachment/then; a damage shield does not block the attack’s lock effect', async () => {
  const program = [{ op: 'then', first: action(), next: { op: 'draw', count: 1 } }];
  const id = 'fixture:owned-lock-then';
  for (const channel of ['effects', 'damage']) {
    const f = await make((defs) => {
      defs[0].mechanics.attacks[0].printedDamage = { value: 20, operator: 'fixed' };
      defs[0].mechanics.attacks[0].effects = [binding(id, {}, 'owned-lock')];
      defs[1].mechanics.effects.push(binding('cn.protection@1', { effect: shield(channel) }, 'owned-lock-shield'));
    }, new Map([[id, reviewed(program, ['then', 'disableOwnedAttack', 'draw'])]]));
    const c = setup(f), before = c.g.snapshot();
    seal(c.g, f, c); const q = prompt(c.g, f, c);
    atomic(c.g, () => answer(c.g, []));
    choose(c.g, f, c);
    const after = c.g.snapshot(), blocked = channel === 'effects';
    assert.equal(after.players[1].active.counters, blocked ? 2 : 0);
    assert.equal(locks(after).length, blocked ? 0 : 1);
    const applied = logs(after, 'attack.owned-lock', 'applied', q.id);
    assert.equal(applied.length, 1); assert.equal(applied[0].data.performed, !blocked);
    assert.deepEqual(applied[0].data.selected, [{ instanceId: c.topCardId, attackId: 'other:alpha' }]);
    assert.equal(applied[0].data.entryId === null, blocked);
    assert.equal(after.players[0].deck.length, before.players[0].deck.length - Number(!blocked));
    const results = logs(after, 'effects.partial').filter((e) => e.data.effectId === 'fixture:owned-lock');
    assert.deepEqual(results.map((e) => [e.data.operation, e.data.performed]),
      blocked ? [['disableOwnedAttack', false]] : [['disableOwnedAttack', true], ['draw', true]]);
    if (!blocked) assertLock(after, c, q, 'other:alpha');
    conserved(after, before);
  }
});

test('no printed attacks means no owned prompt and a false leaf, even with a usable Tool attack; independent attack body text still resolves', async () => {
  const f = await make((defs) => {
    defs[1].mechanics.attacks = [];
    defs[0].mechanics.attacks[0].effects.push(binding('cn.draw@1', { count: 1 }, 'owned-lock-independent-draw'));
    const tool = defs.find((d) => d.definitionId === 'tool').mechanics;
    tool.effects = []; tool.grantedAttacks = [move('tool:bonus', '测试不属于当前卡面的招式')];
  });
  const c = setup(f, { mutate: (s) => hold(s, 1, s.players[1].active, 'tool') }), before = c.g.snapshot();
  seal(c.g, f, c);
  const after = c.g.snapshot();
  assert.equal(after.pending, null); assert.equal(locks(after).length, 0);
  assert.equal(logs(after, 'selection.request').length, 0);
  const result = logs(after, 'effects.partial').find((e) => e.data.operation === 'disableOwnedAttack');
  assert(result); assert.equal(result.data.performed, false);
  assert.equal(after.players[0].deck.length, before.players[0].deck.length - 1);
  assert(hasAttack(c.g, 1, 'tool:bonus')); conserved(after, before);
});

test('nextOpponentTurn is inactive in the preceding checkup, active only for the affected turn, and expires before its following checkup for both actors', async () => {
  const id = 'fixture:owned-checkup-observer', observer = reviewed([], [], { canUse: () => true });
  const f = await make((defs) => defs[1].mechanics.abilities.push({
    abilityId: 'checkup-observer', name: '测试检查回合边界', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
    trigger: { event: 'checkup', subject: 'self', optional: true, choiceOwner: 'source', scope: 'global' },
    effects: [binding(id, {}, 'owned-checkup-observer')],
  }), new Map([[id, observer]]));
  for (const actor of [0, 1]) {
    const c = setup(f, { actor }), before = c.g.snapshot(); seal(c.g, f, c);
    const q = prompt(c.g, f, c); choose(c.g, f, c);
    const firstCheck = c.g.snapshot();
    assert.equal(firstCheck.phase, 'checkup'); assert.equal(firstCheck.current, null);
    const entry = assertLock(firstCheck, c, q, 'other:alpha');
    assert.equal(ongoingIsActive(entry, firstCheck), false);
    settleRestoring(c.g, f, (request) => request.kind === 'checkup-placement' ? ['before'] :
      request.kind === 'trigger-optional' ? ['skip'] : request.options.slice(0, request.minimum));
    assert.equal(c.g.snapshot().current, c.owner); assert(ongoingIsActive(locks(c.g.snapshot())[0], c.g.snapshot()));
    assert.equal(hasAttack(c.g, c.owner, 'other:alpha'), false);
    const ending = c.g.snapshot(), historyIndex = ending.battleHistory.events.length;
    run(c.g, f, { type: 'endTurn' }, c.owner);
    const lastCheck = c.g.snapshot(); assert.equal(lastCheck.phase, 'checkup'); assert.equal(lastCheck.current, null);
    assert.equal(locks(lastCheck).length, 0);
    const expired = lastCheck.events.find((e) => e.data.effectId === entry.id && e.data.expiredAt);
    assert(expired); assert.equal(expired.data.expiredAt, 'turn-end');
    const cleared = logs(lastCheck, 'attack.owned-lock', 'cleared', q.id);
    assert.equal(cleared.length, 1); assert.equal(cleared[0].visibility, 'private');
    assert.deepEqual(cleared[0].data, { kind: 'cleared', id: q.id, entryId: entry.id,
      reason: 'expiry', turn: ending.turn, historyIndex });
    assert.deepEqual(lastCheck.battleHistory.events[historyIndex],
      { kind: 'turnEnded', owner: c.owner, turn: ending.turn, during: c.owner });
    settleRestoring(c.g, f, (request) => request.kind === 'checkup-placement' ? ['before'] :
      request.kind === 'trigger-optional' ? ['skip'] : request.options.slice(0, request.minimum));
    assert.equal(c.g.snapshot().current, c.actor);
    conserved(c.g.snapshot(), before);
  }
});

test('retreating to the Bench clears the chosen lock and switching that same physical Pokemon back does not revive it', async () => {
  const f = await make(), c = setup(f, { targetBench: true, targetEnergy: true, targetHand: ['potion'] });
  const before = c.g.snapshot(); seal(c.g, f, c); const q = prompt(c.g, f, c); choose(c.g, f, c);
  assertLock(c.g.snapshot(), c, q, 'other:alpha');
  run(c.g, f, { type: 'retreat' }, 1); settleRestoring(c.g, f);
  assert.equal(c.g.snapshot().players[1].active.id, c.targetBenchId); assert.equal(locks(c.g.snapshot()).length, 0);
  run(c.g, f, { type: 'playTrainer', cardId: c.hand[0] }, 1);
  assert.equal(c.g.snapshot().pending.kind, 'effect-target'); respond(c.g, f, [c.targetPokemonId]);
  assert.equal(c.g.snapshot().players[1].active.id, c.targetPokemonId);
  assert.equal(c.g.snapshot().players[1].active.stack.at(-1), c.topCardId);
  assert.equal(locks(c.g.snapshot()).length, 0); assert(hasAttack(c.g, 1, 'other:alpha'));
  conserved(c.g.snapshot(), before);
});

test('ordinary evolution clears the old reference while retaining the Pokemon identity and moving to the new printed attack window', async () => {
  const f = await make(), c = setup(f, { targetHand: ['evolution'] }), before = c.g.snapshot();
  seal(c.g, f, c); const q = prompt(c.g, f, c); choose(c.g, f, c);
  assertLock(c.g.snapshot(), c, q, 'other:alpha');
  const evolve = c.g.view(1).legalActions.find((a) => a.type === 'evolve' && a.pokemonId === c.targetPokemonId); assert(evolve);
  run(c.g, f, evolve, 1);
  assert.equal(c.g.snapshot().players[1].active.id, c.targetPokemonId);
  assert.equal(c.g.snapshot().players[1].active.stack.at(-1), c.hand[0]); assert.equal(locks(c.g.snapshot()).length, 0);
  assert(hasAttack(c.g, 1, 'evolution:alpha')); conserved(c.g.snapshot(), before);
});

test('an actual devolution removes the selected top-card reference and clears its lock before the underlying Basic attacks are offered', async () => {
  const f = await make((defs) => defs[2].mechanics.abilities.push(activated('devolve-self', [
    binding('cn.pokemonTransition@1', devolution(), 'owned-devolve'),
  ])));
  const c = setup(f, { evolved: true }), before = c.g.snapshot();
  seal(c.g, f, c); const q = prompt(c.g, f, c); choose(c.g, f, c, 'evolution:alpha');
  assertLock(c.g.snapshot(), c, q, 'evolution:alpha');
  run(c.g, f, { type: 'useAbility', pokemonId: c.targetPokemonId, abilityId: 'devolve-self' }, 1);
  assert.equal(c.g.snapshot().pending.kind, 'devolution-count'); respond(c.g, f, ['1']);
  assert.equal(c.g.snapshot().players[1].active.id, c.targetPokemonId);
  assert.equal(c.g.snapshot().players[1].active.stack.length, 1);
  assert(c.g.snapshot().players[1].hand.includes(c.topCardId)); assert.equal(locks(c.g.snapshot()).length, 0);
  assert(hasAttack(c.g, 1, 'other:alpha')); conserved(c.g.snapshot(), before);
});

test('returning the target to hand clears the lock; re-benching the same physical Basic and switching it Active creates a fresh unrestricted identity', async () => {
  const f = await make((defs) => defs[1].mechanics.abilities.push(activated('return-self', [
    binding('cn.fieldReturn@1', returnAction(), 'owned-return-target'),
  ])));
  const c = setup(f, { targetBench: true, targetHand: ['potion'] }), before = c.g.snapshot();
  seal(c.g, f, c); const q = prompt(c.g, f, c); choose(c.g, f, c); assertLock(c.g.snapshot(), c, q, 'other:alpha');
  run(c.g, f, { type: 'useAbility', pokemonId: c.targetPokemonId, abilityId: 'return-self' }, 1);
  settleRestoring(c.g, f);
  assert(c.g.snapshot().players[1].hand.includes(c.topCardId)); assert.equal(locks(c.g.snapshot()).length, 0);
  run(c.g, f, { type: 'bench', cardId: c.topCardId }, 1);
  const fresh = c.g.snapshot().players[1].bench.find((m) => m.stack.at(-1) === c.topCardId); assert(fresh);
  assert.notEqual(fresh.id, c.targetPokemonId);
  run(c.g, f, { type: 'playTrainer', cardId: c.hand[0] }, 1); respond(c.g, f, [fresh.id]);
  assert.equal(c.g.snapshot().players[1].active.id, fresh.id);
  assert(hasAttack(c.g, 1, 'other:alpha')); assert.equal(locks(c.g.snapshot()).length, 0);
  conserved(c.g.snapshot(), before);
});

test('the source leaving play later does not cancel the already applied lock on the still-present opponent target', async () => {
  const f = await make((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [
      binding('cn.fieldReturn@1', returnAction('opponent'), 'owned-return-source'),
    ];
  });
  const c = setup(f, { sourceBench: true, targetHand: ['potion'] }), before = c.g.snapshot();
  seal(c.g, f, c); const q = prompt(c.g, f, c); choose(c.g, f, c);
  const entry = clone(assertLock(c.g.snapshot(), c, q, 'other:alpha'));
  run(c.g, f, { type: 'playTrainer', cardId: c.hand[0] }, 1); settleRestoring(c.g, f);
  const after = c.g.snapshot();
  assert(after.players[0].hand.includes(c.sourceId));
  assert(!mons(after, 0).some((m) => m.id === c.sourcePokemonId));
  assert.equal(after.players[1].active.id, c.targetPokemonId);
  assert.deepEqual(locks(after), [entry]); assert(ongoingIsActive(locks(after)[0], after));
  assert.equal(hasAttack(c.g, 1, 'other:alpha'), false); assert(hasAttack(c.g, 1, 'other:beta'));
  conserved(after, before); restored(c.g, f);
});

test('a lethally damaged target still chooses a lock before normal KO discard/Prize resolution clears it with its actual knockout cause', async () => {
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].printedDamage = { value: 100, operator: 'fixed' };
    defs[1].mechanics.abilities.push({
      abilityId: 'owned-ko-observer', name: '测试昏厥时可选抽牌', mode: 'triggered', usage: null,
      trigger: { event: 'knockout', subject: 'self', optional: true, choiceOwner: 'source', scope: 'global' },
      effects: [binding('cn.draw@1', { count: 1 }, 'owned-ko-observer')], sourceOfTruth: EVIDENCE,
    });
  });
  const c = setup(f, { targetBench: true, targetEnergy: true,
    mutate: (s) => hold(s, 1, s.players[1].active, 'tool') });
  const before = c.g.snapshot(), victim = before.players[c.owner].active;
  const victimCards = [...victim.stack, ...victim.energy, ...victim.tools];
  seal(c.g, f, c); const q = prompt(c.g, f, c), choosing = c.g.snapshot();
  assert.equal(choosing.players[c.owner].active.id, c.targetPokemonId);
  assert.equal(choosing.players[c.owner].active.counters, 10);
  assert.equal(c.g.view(c.actor).players[c.owner].active.effective.currentHp, 0);
  assert.equal(logs(choosing, 'ko.boundary', 'latched').length, 0);
  assert.equal(choosing.battleHistory.events.filter((e) => e.kind === 'ko').length, 0);
  assert.equal(logs(choosing, 'attack.owned-lock', 'cleared', q.id).length, 0);
  for (const id of victimCards) assert(!choosing.players[c.owner].discard.includes(id));
  const cause = clone(choosing.players[c.owner].active.facts.knockoutCause);
  assert.equal(cause.kind, 'attackDamage'); assert.equal(cause.source.category, 'attack');
  assert.equal(cause.source.owner, c.actor); assert.equal(cause.source.pokemonId, c.sourcePokemonId);
  assert.equal(cause.source.instanceId, c.sourceId); assert.equal(cause.source.attackId, 'base:seal');
  assert.equal(cause.source.effectId, 'attack:base:seal');

  choose(c.g, f, c);
  const latched = c.g.snapshot(), entry = assertLock(latched, c, q, 'other:alpha');
  assert.equal(latched.pending.kind, 'trigger-optional'); assert.equal(latched.pending.player, c.owner);
  assert.equal(latched.players[c.owner].active.id, c.targetPokemonId);
  const receipts = logs(latched, 'ko.boundary', 'latched');
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].data.item, {
    owner: c.owner, id: c.targetPokemonId, topCardId: c.topCardId, prizes: 1,
    turn: before.turn, during: c.actor, cause, receiptId: receipts[0].data.id,
  });
  assert.equal(latched.battleHistory.events.filter((e) => e.kind === 'ko').length, 0);
  assert.equal(logs(latched, 'attack.owned-lock', 'cleared', q.id).length, 0);
  assert(latched.events.indexOf(logs(latched, 'attack.owned-lock', 'applied', q.id)[0]) <
    latched.events.indexOf(receipts[0]), 'The selected lock attaches before the related KO is latched.');
  assert.equal(latched.players[c.actor].prizes.length, before.players[c.actor].prizes.length);

  respond(c.g, f, ['skip']);
  const awarding = c.g.snapshot();
  assert.equal(awarding.pending.kind, 'prize'); assert.equal(awarding.pending.player, c.actor);
  assert.equal(awarding.players[c.owner].active, null);
  assert(!mons(awarding, c.owner).some((m) => m.id === c.targetPokemonId));
  assert.equal(locks(awarding).length, 0);
  for (const id of victimCards) assert.equal(awarding.players[c.owner].discard.filter((card) => card === id).length, 1);
  const cleared = logs(awarding, 'attack.owned-lock', 'cleared', q.id);
  assert.equal(cleared.length, 1); assert.equal(cleared[0].visibility, 'private');
  const historyIndex = latched.battleHistory.events.length;
  assert.deepEqual(cleared[0].data, { kind: 'cleared', id: q.id, entryId: entry.id,
    reason: 'knockout', turn: before.turn, historyIndex });
  const committed = logs(awarding, 'ko.boundary').filter((e) => e.data.pokemonId === c.targetPokemonId);
  assert.equal(committed.length, 1);
  assert.deepEqual(committed[0].data, { owner: c.owner, pokemonId: c.targetPokemonId, prizes: 1 });
  assert(awarding.events.indexOf(cleared[0]) < awarding.events.indexOf(committed[0]));
  const ko = awarding.battleHistory.events.filter((e) => e.kind === 'ko');
  assert.deepEqual(ko, [{ kind: 'ko', owner: c.owner, pokemonId: c.targetPokemonId,
    turn: before.turn, during: c.actor, cause }]);
  assert.deepEqual(awarding.battleHistory.events[historyIndex], ko[0]);
  assert.equal(awarding.players[c.actor].prizes.length, before.players[c.actor].prizes.length);

  const prizeId = awarding.players[c.actor].prizes[Number(awarding.pending.options[0])];
  respond(c.g, f, [awarding.pending.options[0]]);
  assert.equal(c.g.snapshot().pending.kind, 'promote'); assert.equal(c.g.snapshot().pending.player, c.owner);
  respond(c.g, f, [c.targetBenchId]);
  const after = c.g.snapshot();
  assert.equal(after.pending, null); assert.equal(after.result, null); assert.equal(after.current, c.owner);
  assert.equal(after.players[c.owner].active.id, c.targetBenchId);
  assert.equal(after.players[c.actor].active.id, c.sourcePokemonId, 'This clears the target’s lock, not a source-departure lock.');
  assert.equal(after.players[c.actor].prizes.length, before.players[c.actor].prizes.length - 1);
  assert.equal(after.players[c.owner].prizes.length, before.players[c.owner].prizes.length);
  assert(after.players[c.actor].hand.includes(prizeId));
  assert.deepEqual(after.battleHistory.events.filter((e) => e.kind === 'ko'), ko);
  assert.equal(logs(after, 'attack.owned-lock', 'applied', q.id).length, 1);
  assert.equal(logs(after, 'attack.owned-lock', 'cleared', q.id).length, 1);
  assert.equal(locks(after).length, 0);
  conserved(after, before); restored(c.g, f);
});

test('exact-one owned answers reject zero, duplicate, foreign-top, Bench and wrong-controller choices atomically, then restore one valid lock without replay', async () => {
  const f = await make(), c = setup(f, { targetBench: true, targetBenchDefinition: 'other' }), before = c.g.snapshot();
  seal(c.g, f, c); const q = prompt(c.g, f, c);
  const benchTop = c.g.snapshot().players[1].bench[0].stack.at(-1);
  for (const selected of [[], [q.options[0], q.options[0]], [...q.options],
    [attackOptionId({ instanceId: c.sourceId, attackId: 'other:alpha' })],
    [attackOptionId({ instanceId: benchTop, attackId: 'other:alpha' })],
    [attackOptionId({ instanceId: c.topCardId, attackId: 'not-owned' })]])
    atomic(c.g, () => answer(c.g, selected));
  atomic(c.g, () => command(c.g, { type: 'answer', requestId: q.id, selected: [q.options[0]] }, 1));
  choose(c.g, f, c); assertLock(c.g.snapshot(), c, q, 'other:alpha');
  const after = c.g.snapshot();
  atomic(c.g, () => command(c.g, { type: 'answer', requestId: q.id, selected: [q.options[0]] }, 0));
  assert.equal(logs(after, 'attack.owned-lock', 'applied', q.id).length, 1);
  conserved(after, before); restored(c.g, f);
});

test('the exact native action is attack-resolve-only and cannot be admitted as an Item, activated Ability, beforeDamage or Stadium onUse program', async () => {
  const native = createCoreHandlers().get('cn.disableOwnedAttack@1'); assert(native);
  assert.equal(native.timing, 'resolve'); assert(native.validateParameters(action()));
  assert.deepEqual(native.execute({}, action()), [action()]);
  for (const bad of [
    { ...action(), side: 'own' }, { ...action(), target: 'bench' }, { ...action(), clearOnBench: false },
    { ...action(), clearOnEvolution: false }, { ...action(), duration: 'untilNextOpponentTurnEnd' },
    { ...action(), selector: { kind: 'pokemon' } }, { ...action(), optional: true }, { ...action(), approved: true },
  ]) assert.equal(native.validateParameters(bad), false);
  for (const placement of ['item', 'ability', 'beforeDamage', 'onUse']) {
    const id = `fixture:owned-invalid-${placement}`, h = { ...native,
      implementationVersion: `synthetic-invalid-${placement}`,
      timing: ['beforeDamage', 'onUse'].includes(placement) ? placement : 'resolve' };
    const f = await make((defs) => {
      const b = binding(id, action(), 'invalid-owned-placement');
      if (placement === 'item') defs.find((d) => d.definitionId === 'potion').mechanics.effects = [b];
      else if (placement === 'ability') defs[0].mechanics.abilities.push(activated('invalid-owned', [b]));
      else if (placement === 'onUse') defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [b];
      else defs[0].mechanics.attacks[0].effects = [b];
    }, new Map([[id, h]]));
    assert.throws(() => board(f), { code: 'unsupported-owned-attack-lock' }, placement);
  }
});
