// Real OfficialGame tests with reviewed SYNTHETIC definitions/printings only.
// These fixtures/receipts do not approve an actual card or imported metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { validateEffectProgram, validateGameCommand } from '../../public/rules/schema-validators.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached, fixtureClock,
} from './fixtures.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const action = (extra = {}) => ({
  op: 'distributeCounters', side: 'opponent', target: 'any', selector: { kind: 'pokemon' }, count: 6, ...extra,
});
const allocation = (pokemonId, count) => ({ pokemonId, count });
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const distributionEvents = (s, kind) => s.events.filter((event) =>
  event.ruleId === 'damage.counter-distribution' && event.data.kind === kind);
const spread = (a, id = 'spread') => binding('cn.distributeCounters@1', a, id);
const fee = () => ({
  costId: 'fee', kind: 'discardHand', count: 2,
  selector: { kind: 'energy', category: 'basic' }, sourceOfTruth: EVIDENCE,
});
const ability = (effects, extra = {}) => ({
  abilityId: 'spread', name: '测试分配指示物', mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: 'spread', limit: 1 },
  effects, sourceOfTruth: EVIDENCE, ...extra,
});
const shield = (channel = 'effects', scope = 'self') => ({
  op: 'protection', useRule: 'ordinary', channel, scope, from: 'opponent', categories: ['attack'],
});
const nativeSourceShield = (slot, trainer, scope = 'own') => ({
  ...shield('effects', scope), categories: [slot === 'trainer' ? 'trainer' : slot === 'attack' ? 'attack' : 'ability'],
  ...(slot === 'trainer' ? { trainerCategories: [trainer === 'research' ? 'supporter' : 'item'],
    trainerOrigins: ['hand'] } : {}),
});
const reviewed = (program, operations) => ({
  rulesetId: 'CN/V20261019', implementationVersion: 'synthetic-counter-runtime-v1',
  sourceOfTruth: EVIDENCE, timing: 'resolve', operations,
  validateParameters: (p) => !!p && !Array.isArray(p) && Object.keys(p).length === 0,
  execute: () => clone(program),
});
async function make(a = action(), { slot = 'trainer', trainer = 'potion', paid = false, transform = () => {},
  handlers = new Map() } = {}) {
  return fixture((defs) => {
    const effects = [spread(a)];
    if (slot === 'trainer') {
      const d = defs.find((d) => d.definitionId === trainer); d.mechanics.effects = effects;
      if (paid) d.mechanics.playCosts = [fee()];
    } else if (slot === 'ability') defs[0].mechanics.abilities.push(ability(effects, paid ? { costs: [fee()] } : {}));
    else {
      defs[0].mechanics.attacks[0].printedDamage = { value: 0, operator: 'fixed' };
      defs[0].mechanics.attacks[0].effects = effects;
    }
    transform(defs);
  }, handlers);
}
function setup(f, { owner = 0, side = 'opponent', slot = 'trainer', trainer = 'potion',
  names = ['other', 'other'], counters = [1, 2, 0], mutate = () => {} } = {}) {
  let sourceId, targets;
  const g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    sourceId = slot === 'trainer' ? hand(s, owner, trainer) : s.players[owner].active.stack.at(-1);
    if (slot === 'attack') attached(s, owner, s.players[owner].active, 'water');
    const recipient = side === 'own' ? owner : 1 - owner;
    targets = [s.players[recipient].active, ...names.map((name) => bench(s, recipient, name))];
    targets.forEach((m, i) => { m.counters = counters[i] ?? 0; });
    s.events = [];
    mutate(s, { sourceId, targets, owner, recipient });
    targets = targets.map((m) => m.id);
  });
  return { g, sourceId, targets };
}
const use = (g, sourceId, slot = 'trainer', owner = g.snapshot().current) => command(g,
  slot === 'trainer' ? { type: 'playTrainer', cardId: sourceId } :
    slot === 'ability' ? { type: 'useAbility', pokemonId: g.snapshot().players[owner].active.id, abilityId: 'spread' } :
      { type: 'attack', attackId: 'base:strike' }, owner);
const allocate = (g, allocations, requestId = g.snapshot().pending.id, player = g.snapshot().pending.player) =>
  command(g, { type: 'allocateCounters', requestId, allocations }, player);
function restored(g, f) {
  const saved = g.snapshot(), r = OfficialGame.restore(clone(saved), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), saved);
  assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  return r;
}
function resolve(g, f, allocations) {
  const r = restored(g, f);
  allocate(g, allocations); allocate(r, allocations);
  assert.deepEqual(r.snapshot(), g.snapshot(), 'Restoring an allocation cannot duplicate/drop a placement or continuation.');
  return restored(g, f);
}
function atomic(g, fn) {
  const saved = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(fn); assert.deepEqual(g.snapshot(), saved);
  assert.deepEqual([g.view(0), g.view(1)], views);
}
function setHand(s, owner, names) {
  const p = s.players[owner], ids = [];
  p.discard.push(...p.hand.splice(0));
  for (const name of names) {
    const id = hand(s, owner, name); p.hand.pop(); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) { p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id); }
  return ids;
}
function assertUnchangedIdentities(before, after) {
  assert.deepEqual(after.cards, before.cards); assert.deepEqual(after.rng, before.rng);
}
function assertResult(before, after, owner, parts, blocked = []) {
  const event = distributionEvents(after, 'resolved').at(-1); assert(event);
  assert.equal(event.visibility, 'public'); assert.deepEqual(event.data.allocations, parts);
  const updates = parts.map(({ pokemonId, count }) => {
    const beforeCounters = mons(before, owner).find((m) => m.id === pokemonId).counters;
    const placedCounters = blocked.includes(pokemonId) ? 0 : count;
    return { pokemonId, beforeCounters, afterCounters: beforeCounters + placedCounters, placedCounters };
  });
  const selectedTotal = parts.reduce((sum, part) => sum + part.count, 0);
  const placedTotal = updates.reduce((sum, update) => sum + update.placedCounters, 0);
  assert.deepEqual(event.data.updates, updates);
  assert.deepEqual({
    selectedTotal: event.data.selectedTotal, placedTotal: event.data.placedTotal,
    preventedTotal: event.data.preventedTotal, performed: event.data.performed,
  }, { selectedTotal, placedTotal, preventedTotal: selectedTotal - placedTotal, performed: placedTotal > 0 });
}

test('native distribution takes the strict full action and the allocation command is a separate positive-count protocol, not transfer or generic answer', () => {
  const h = createCoreHandlers().get('cn.distributeCounters@1'); assert(h);
  assert.equal(h.timing, 'resolve'); assert(h.operations.includes('distributeCounters'));
  assert(!h.operations.includes('transferCounters'));
  for (const count of [0, 1, 900719925474099]) {
    const a = action({ count }); assert(h.validateParameters(a)); assert.deepEqual(h.execute({}, a), [a]);
    assert(validateEffectProgram([a]));
  }
  for (const invalid of [
    { action: action() }, action({ op: 'transferCounters' }), action({ selector: { kind: 'any' } }),
    action({ count: -1 }), action({ count: 0.5 }), action({ count: 900719925474100 }),
    action({ count: Number.MAX_SAFE_INTEGER }), action({ quantity: { kind: 'any' } }),
    action({ allocations: [allocation('made-up', 6)] }), action({ approved: true }),
  ]) { assert(!h.validateParameters(invalid)); assert(!validateEffectProgram([invalid])); }
  const cmd = { player: 0, expectedRevision: 0,
    action: { type: 'allocateCounters', requestId: 'q1', allocations: [allocation('m1', 2), allocation('m2', 4)] } };
  assert(validateGameCommand(cmd));
  for (const value of [0, -1, 0.5]) {
    const bad = clone(cmd); bad.action.allocations[0].count = value; assert(!validateGameCommand(bad));
  }
});

test('both source owners and relative sides may split one fixed total or put it all on one candidate, never N per Pokémon', async () => {
  for (const owner of [0, 1]) for (const side of ['own', 'opponent']) for (const allOnOne of [false, true]) {
    const a = action({ side }), f = await make(a);
    let { g, sourceId, targets } = setup(f, { owner, side });
    const before = g.snapshot(), recipient = side === 'own' ? owner : 1 - owner;
    use(g, sourceId);
    const pending = g.snapshot(), q = pending.pending;
    assert.equal(q.kind, 'counter-allocation'); assert.equal(q.player, owner);
    assert.equal(q.ruleId, 'damage.counter-distribution');
    assert.equal(typeof q.data.programId, 'string');
    assert.deepEqual(q.data.counterChoice, { id: q.data.counterChoice.id, turn: before.turn, sourceId,
      targets: mons(before, recipient).map((m) => ({ pokemonId: m.id, topCardId: m.stack.at(-1), counters: m.counters })) });
    assert.deepEqual(mons(pending, recipient), mons(before, recipient), 'Inspecting the window performs no placement.');
    assert.deepEqual(pending.rng, before.rng); assert.equal(g.view(1 - owner).pending, null);
    assert.deepEqual(g.view(owner).pending.counterAllocation, { total: 6, targets: q.data.counterChoice.targets });
    const request = distributionEvents(pending, 'requested');
    assert.equal(request.length, 1); assert.equal(request[0].visibility, 'public');
    assert.deepEqual(request[0].data.choice, q.data.counterChoice); assert.deepEqual(request[0].data.action, a);
    const parts = allOnOne ? [allocation(targets[0], 6)] :
      [allocation(targets[0], 1), allocation(targets[1], 2), allocation(targets[2], 3)];
    g = resolve(g, f, parts);
    const after = g.snapshot(), placed = new Map(parts.map((p) => [p.pokemonId, p.count]));
    assert.deepEqual(mons(after, recipient).map((m) => m.counters),
      mons(before, recipient).map((m) => m.counters + (placed.get(m.id) ?? 0)));
    assert.equal(mons(after, recipient).reduce((n, m, i) => n + m.counters - mons(before, recipient)[i].counters, 0), 6);
    assertResult(before, after, recipient, parts);
    assert.equal(distributionEvents(after, 'resolved').length, 1);
    assert(!after.battleHistory.events.some((event) => event.kind === 'heal'));
    assert.equal(after.players[owner].discard.filter((id) => id === sourceId).length, 1);
    assertUnchangedIdentities(before, after); restored(g, f);
  }
});

test('invalid totals, zero/fractional parts, repeated/foreign IDs and wrong answer protocols are atomic; the saved untouched window is restore-bound', async () => {
  const f = await make();
  let { g, sourceId, targets } = setup(f);
  use(g, sourceId); const saved = g.snapshot(), q = saved.pending;
  for (const parts of [
    [], [allocation(targets[0], 5)], [allocation(targets[0], 7)],
    [allocation(targets[0], 3), allocation(targets[0], 3)],
    [allocation(targets[0], 0), allocation(targets[1], 6)],
    [allocation(targets[0], 0.5), allocation(targets[1], 5.5)],
    [allocation(targets[0], -1), allocation(targets[1], 7)],
    [allocation(saved.players[0].active.id, 6)], [allocation('missing', 6)],
    [allocation(targets[0], Number.MAX_SAFE_INTEGER)],
  ]) atomic(g, () => allocate(g, parts));
  atomic(g, () => answer(g, [targets[0]]));
  atomic(g, () => allocate(g, [allocation(targets[0], 6)], q.id, 1));
  atomic(g, () => allocate(g, [allocation(targets[0], 6)], `${q.id}-old`));
  const mutations = [
    (s) => { delete s.pending.data.counterChoice; },
    (s) => { s.pending.data.counterChoice.id += '-changed'; },
    (s) => { s.pending.data.counterChoice.turn++; },
    (s) => { s.pending.data.counterChoice.sourceId = s.players[0].active.stack.at(-1); },
    (s) => { s.pending.data.counterChoice.targets.reverse(); },
    (s) => { s.pending.data.counterChoice.targets[0].topCardId = s.players[1].deck[0]; },
    (s) => { s.pending.data.counterChoice.targets[0].counters++; },
    (s) => { s.players[1].active.counters++; },
    (s) => { s.pending.data.source.owner = 1; },
    (s) => { s.pending.data.action.count = 5; },
    (s) => { s.pending.data.action.side = 'own'; },
    (s) => { s.pending.data.local = true; },
    (s) => { delete s.pending.data.programId; },
    (s) => { s.pending.data.allocations = [allocation(targets[0], 6)]; },
    (s) => { s.pending.data.selected = [targets[0]]; },
    (s) => { s.pending.options.reverse(); },
    (s) => { s.pending.minimum = 1; },
    (s) => { s.pending.maximum = 2; },
    (s) => { s.pending.allowZero = false; },
    (s) => { s.pending.player = 1; },
    (s) => { s.pending.kind = 'effect-target'; },
    (s) => { s.queue.unshift({ op: s.pending.resume, data: clone(s.pending.data) }); },
  ];
  for (const mutate of mutations) {
    const bad = clone(saved); mutate(bad); const original = clone(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
    assert.deepEqual(bad, original); assert.deepEqual(g.snapshot(), saved);
  }
  g = resolve(g, f, [allocation(targets[0], 2), allocation(targets[1], 4)]);
  atomic(g, () => allocate(g, [allocation(targets[0], 6)], q.id, 0));
  restored(g, f);
});

test('the whole batch is placed without remaining-HP clipping before any KO window, and its locked causes are effects rather than attack damage', async () => {
  const f = await make(action(), { slot: 'attack', transform: (defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.abilities.push({
      abilityId: 'observe-ko', name: '测试批次后昏厥窗口', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'knockout', subject: 'self', optional: true, choiceOwner: 'source', scope: 'global' },
      effects: [binding('cn.draw@1', { count: 1 }, 'observe-ko')],
    });
  } });
  let { g, sourceId, targets } = setup(f, { slot: 'attack', counters: [8, 8, 0] });
  const before = g.snapshot(); use(g, sourceId, 'attack');
  assert.equal(g.snapshot().pending.kind, 'counter-allocation');
  assert(!g.snapshot().events.some((event) => event.ruleId === 'ko.boundary'));
  g = resolve(g, f, [allocation(targets[0], 4), allocation(targets[1], 2)]);
  const locked = g.snapshot();
  assert(['trigger-order', 'trigger-optional'].includes(locked.pending.kind));
  assert.deepEqual(mons(locked, 1).map((m) => m.counters), [12, 10, 0], 'Four counters are not clipped to two remaining HP-counters.');
  const batch = locked.queue.flatMap((task) => task.data.batch ?? []);
  for (const id of targets.slice(0, 2)) {
    const ko = batch.find((item) => item.id === id); assert(ko);
    assert.equal(ko.cause.kind, 'effect'); assert.equal(ko.cause.source.category, 'attack');
    assert.equal(ko.cause.source.instanceId, sourceId);
  }
  g = restored(g, f);
  settle(g, (q) => q.kind === 'trigger-optional' ? ['skip'] : q.options.slice(0, q.minimum));
  const after = g.snapshot(), records = after.battleHistory.events.filter((event) => event.kind === 'ko');
  assert.equal(records.length, 2); assert(records.every((event) => event.cause.kind === 'effect'));
  assert.equal(after.players[0].prizes.length, before.players[0].prizes.length - 2);
  assert.deepEqual(after.rng, before.rng); restored(g, f);
});

test('sole targets auto-receive the total; zero/empty Trainer and ability effects are unusable while an attack still executes its independent damage/draw', async () => {
  for (const slot of ['trainer', 'ability']) {
    const one = await make(action({ side: 'own', target: 'active' }), { slot });
    const single = setup(one, { side: 'own', slot });
    use(single.g, single.sourceId, slot);
    assert.equal(single.g.snapshot().pending, null); assert.equal(single.g.snapshot().players[0].active.counters, 7);
    restored(single.g, one);
    for (const a of [action({ count: 0 }), action({ selector: { kind: 'pokemon', stages: ['stage2'] } })]) {
      const f = await make(a, { slot }), empty = setup(f, { slot });
      assert(!empty.g.view(0).legalActions.some((cmd) => slot === 'trainer' ?
        cmd.type === 'playTrainer' && cmd.cardId === empty.sourceId : cmd.type === 'useAbility' && cmd.abilityId === 'spread'));
      atomic(empty.g, () => use(empty.g, empty.sourceId, slot));
    }
  }
  for (const a of [action({ count: 0 }), action({ selector: { kind: 'pokemon', stages: ['stage2'] } })]) {
    const f = await make(a, { slot: 'attack', transform: (defs) => {
      defs[0].mechanics.attacks[0].printedDamage = { value: 20, operator: 'fixed' };
      defs[0].mechanics.attacks[0].effects.push(binding('cn.draw@1', { count: 1 }, 'independent-draw'));
    } });
    const { g, sourceId } = setup(f, { slot: 'attack' }), before = g.snapshot();
    use(g, sourceId, 'attack'); assert.equal(g.snapshot().pending, null);
    assert.equal(g.snapshot().players[1].active.counters, 3);
    assert.equal(g.snapshot().players[0].deck.length, before.players[0].deck.length - 1);
    const partial = g.snapshot().events.find((event) => event.ruleId === 'effects.partial' &&
      event.data.operation === 'distributeCounters');
    assert(partial); assert.equal(partial.data.performed, false);
    assertUnchangedIdentities(before, g.snapshot()); restored(g, f);
  }
});

test('selectors retain printed HP/stage while explicitly using current in-play types', async () => {
  const a = action({ side: 'own', count: 3,
    selector: { kind: 'pokemon', stages: ['basic'], printedHpAtMost: 100, types: ['Psychic'] } });
  const f = await make(a, { transform: (defs) => {
    for (const [name, types] of [['base', ['Psychic']], ['other', ['Water']]]) {
      const d = defs.find((d) => d.definitionId === name);
      if (name === 'other') d.mechanics.types = ['Psychic'];
      d.mechanics.abilities.push({ abilityId: 'live-type', name: '测试分配当前属性', mode: 'continuous',
        usage: null, sourceOfTruth: EVIDENCE,
        effects: [binding('cn.pokemonTypes@1', { effect: { op: 'pokemonTypes', types, scope: 'self' } })] });
    }
    defs[2].mechanics.hp = 80; defs[2].mechanics.types = ['Psychic'];
  } });
  let tool;
  const { g, sourceId } = setup(f, { side: 'own', names: ['other', 'evolution'], mutate: (s) => {
    tool = hand(s, 0, 'hp-tool'); s.players[0].hand.pop(); s.players[0].active.tools.push(tool);
  } });
  const before = g.snapshot(), printed = clone(f.catalog.definition('base'));
  assert.equal(g.view(0).players[0].active.effective.maxHp, 150);
  assert.deepEqual(g.view(0).players[0].active.effective.types, ['Psychic']);
  assert.deepEqual(printed.mechanics.types, ['Water']);
  use(g, sourceId);
  assert.equal(g.snapshot().pending, null);
  assert.deepEqual(mons(g.snapshot(), 0).map((m) => m.counters), [4, 2, 0]);
  assert.deepEqual(f.catalog.definition('base'), printed); assert(g.snapshot().players[0].active.tools.includes(tool));
  assertUnchangedIdentities(before, g.snapshot()); restored(g, f);
});

test('attack damage shields do not block counter effects; blocked allocations are lost, and only positive actual placement unlocks then', async () => {
  for (const mode of ['damage', 'all-effects', 'mixed-effects']) {
    const a = action({ target: 'bench', count: 5 });
    const program = [{ op: 'then', first: a, next: { op: 'draw', count: 1 } }];
    const id = `fixture:distribution-shield-${mode}`;
    const f = await make(a, { slot: 'attack', handlers: new Map([[id,
      reviewed(program, ['then', 'draw', 'distributeCounters'])]]), transform: (defs) => {
      defs[0].mechanics.attacks[0].printedDamage = { value: 20, operator: 'fixed' };
      defs[0].mechanics.attacks[0].effects = [binding(id, {}, 'shield-then')];
      const d = mode === 'mixed-effects' ? defs[1] : defs[0];
      d.mechanics.effects.push(binding('cn.protection@1', { effect:
        shield(mode === 'damage' ? 'damage' : 'effects', mode === 'mixed-effects' ? 'self' : 'own') }));
    } });
    let { g, sourceId, targets } = setup(f, { slot: 'attack', names: ['other', 'evolution'], counters: [0, 0, 0] });
    const before = g.snapshot(); use(g, sourceId, 'attack');
    const parts = [allocation(targets[1], 2), allocation(targets[2], 3)];
    g = resolve(g, f, parts);
    const after = g.snapshot(), expected = mode === 'damage' ? [0, 2, 3] :
      mode === 'all-effects' ? [2, 0, 0] : [2, 0, 3];
    assert.deepEqual(mons(after, 1).map((m) => m.counters), expected);
    assert.equal(after.players[0].deck.length, before.players[0].deck.length - Number(mode !== 'all-effects'));
    const leaf = after.events.find((event) => event.ruleId === 'effects.partial' &&
      event.data.operation === 'distributeCounters');
    assert.equal(leaf.data.performed, mode !== 'all-effects');
    assertResult(before, after, 1, parts, mode === 'all-effects' ? targets.slice(1) :
      mode === 'mixed-effects' ? [targets[1]] : []);
    assertUnchangedIdentities(before, after); restored(g, f);
  }
});

test('all selected protections are frozen before the first counter update can turn on a whole-side shield', async () => {
  const id = 'fixture:counter-activated-shield';
  const conditional = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
    timing: 'continuous', operations: ['protection'], validateParameters: (p) => Object.keys(p).length === 0,
    execute: (ctx) => ctx.state.players[ctx.source.owner].active.counters > 0 ? [shield('effects', 'own')] : [] };
  const f = await make(action({ count: 3 }), { slot: 'attack', handlers: new Map([[id, conditional]]),
    transform: (defs) => { defs[0].mechanics.effects.push(binding(id, {})); } });
  let { g, sourceId, targets } = setup(f, { slot: 'attack', counters: [0, 0, 0] });
  const before = g.snapshot(); use(g, sourceId, 'attack');
  g = resolve(g, f, [allocation(targets[0], 1), allocation(targets[1], 2)]);
  assert.deepEqual(mons(g.snapshot(), 1).map((m) => m.counters), [1, 2, 0],
    'The later target cannot be newly blocked by counters placed on the earlier target.');
  assertResult(before, g.snapshot(), 1, [allocation(targets[0], 1), allocation(targets[1], 2)]);
  assertUnchangedIdentities(before, g.snapshot()); restored(g, f);
});

test('full costs survive payment/allocation restores without double spending, and incomplete payment cannot declare', async () => {
  for (const slot of ['trainer', 'ability']) {
    const a = action({ side: 'own' }), f = await make(a, { slot, trainer: 'research', paid: true });
    let fees;
    let { g, sourceId, targets } = setup(f, { slot, trainer: 'research', side: 'own', mutate: (s) => {
      const ids = setHand(s, 0, slot === 'trainer' ? ['research', 'water', 'water'] : ['water', 'water']);
      fees = ids.slice(slot === 'trainer' ? 1 : 0);
      attached(s, 0, s.players[0].active, 'water');
    } });
    const before = g.snapshot(); use(g, sourceId, slot);
    const q = g.snapshot().pending; assert.equal(q.kind, 'activation-cost');
    const selected = fees.map((id) => paymentOptionId('fee', id));
    atomic(g, () => answer(g, selected.slice(0, 1)));
    g = restored(g, f); answer(g, selected);
    assert.equal(g.snapshot().pending.kind, 'counter-allocation'); assert.equal(g.snapshot().players[0].hand.length, 0);
    assert.equal(g.snapshot().events.filter((event) => event.ruleId === 'effects.activation-cost').length, 1);
    g = resolve(g, f, [allocation(targets[0], 2), allocation(targets[1], 4)]);
    const after = g.snapshot();
    assert.equal(after.events.filter((event) => event.ruleId === 'effects.activation-cost').length, 1);
    for (const id of fees) assert.equal(after.players[0].discard.filter((found) => found === id).length, 1);
    if (slot === 'trainer') assert.equal(after.players[0].discard.filter((found) => found === sourceId).length, 1);
    else assert.equal(after.players[0].active.used.spread.length, 1);
    assert.deepEqual(after.players[0].active.energy, before.players[0].active.energy);
    assertUnchangedIdentities(before, after); restored(g, f);
    const poor = setup(f, { slot, trainer: 'research', side: 'own', mutate: (s) => {
      setHand(s, 0, slot === 'trainer' ? ['research', 'water'] : ['water']);
    } });
    atomic(poor.g, () => use(poor.g, poor.sourceId, slot));
  }
});

test('a copied native allocation belongs to the actual user and its own tracked copy program, then returns once to the parent allocation/draw', async () => {
  const copy = { op: 'copyAttack',
    origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
    excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE } };
  const child = action({ side: 'own', count: 4 });
  const parent = [{ op: 'then', first: copy, next: { op: 'sequence', steps: [
    action({ side: 'own', target: 'self', count: 1 }), { op: 'draw', count: 1 },
  ] } }];
  const id = 'fixture:copied-counter-parent';
  const f = await make(child, { slot: 'attack', handlers: new Map([[id,
    reviewed(parent, ['copyAttack', 'distributeCounters', 'then', 'sequence', 'draw'])]]), transform: (defs) => {
    defs[0].mechanics.attacks[0].effects = [binding(id, {}, 'copy-parent')];
    defs[1].mechanics.attacks[0].printedDamage = { value: 0, operator: 'fixed' };
    defs[1].mechanics.attacks[0].effects = [spread(child, 'copy-child')];
  } });
  let { g, sourceId, targets } = setup(f, { slot: 'attack', side: 'own', counters: [0, 0, 0], mutate: (s) => {
    const p = s.players[1], old = p.active, replacement = bench(s, 1, 'other');
    p.bench.pop(); p.active = replacement; p.hand.push(...old.stack, ...old.energy, ...old.tools);
  } });
  const before = g.snapshot(); use(g, sourceId, 'attack');
  assert.equal(g.snapshot().pending.kind, 'copy-attack');
  const parentId = g.snapshot().pending.data.programId;
  const option = g.view(0).pending.attacks.find((a) => a.attackId === 'other:strike'); assert(option);
  g = restored(g, f); answer(g, [option.optionId]);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'counter-allocation'); assert.notEqual(q.data.programId, parentId);
  assert.equal(q.data.counterChoice.sourceId, sourceId);
  assert.equal(q.data.source.copyId, g.snapshot().attack.execution.copyId);
  assert.equal(g.snapshot().attack.copies[0].continuation.programId, parentId);
  g = resolve(g, f, [allocation(targets[1], 1), allocation(targets[2], 3)]);
  const after = g.snapshot();
  assert.deepEqual(mons(after, 0).map((m) => m.counters), [1, 1, 3]);
  assert.equal(after.players[1].active.counters, before.players[1].active.counters);
  assert.equal(after.players[0].deck.length, before.players[0].deck.length - 1);
  assert.equal(after.attack, null); assertUnchangedIdentities(before, after); restored(g, f);
});

test('native-only Item/Supporter/activated-ability use is unavailable when all candidates are protected from that actual source, without costs/quota/RNG or qualification logs', async () => {
  for (const [slot, trainer] of [['trainer', 'potion'], ['trainer', 'research'], ['ability', 'potion']])
    for (const paid of [false, true]) {
      const f = await make(action(), { slot, trainer, paid, transform: (defs) => {
        defs[0].mechanics.effects.push(binding('cn.protection@1',
          { effect: nativeSourceShield(slot, trainer) }, 'native-source-shield'));
      } });
      const { g, sourceId } = setup(f, { slot, trainer, mutate: (s) => {
        setHand(s, 0, [...(slot === 'trainer' ? [trainer] : []), ...(paid ? ['water', 'water'] : [])]);
      } });
      const before = g.snapshot();
      for (const viewer of [0, 1, 0]) g.view(viewer);
      assert.deepEqual(g.snapshot(), before, 'Source-aware eligibility must not log protections or mutate anything.');
      assert(!g.view(0).legalActions.some((a) => slot === 'trainer' ?
        a.type === 'playTrainer' && a.cardId === sourceId : a.type === 'useAbility' && a.abilityId === 'spread'));
      atomic(g, () => use(g, sourceId, slot));
      assert.deepEqual(g.snapshot(), before);
      assert.equal(distributionEvents(g.snapshot(), 'requested').length, 0);
      assert(!g.snapshot().events.some((event) => event.ruleId === 'effects.activation-cost' ||
        event.ruleId === 'effects.protection' || event.ruleId === 'effects.execution'));
      restored(g, f);
    }
});

test('one unprotected candidate permits native paid activation without removing protected candidates or refunding their allocated share', async () => {
  for (const [slot, trainer] of [['trainer', 'potion'], ['trainer', 'research'], ['ability', 'potion']]) {
    const f = await make(action(), { slot, trainer, paid: true, transform: (defs) => {
      defs[1].mechanics.effects.push(binding('cn.protection@1',
        { effect: nativeSourceShield(slot, trainer, 'self') }, 'mixed-native-shield'));
    } });
    let fees;
    let { g, sourceId, targets } = setup(f, { slot, trainer, mutate: (s) => {
      const ids = setHand(s, 0, [...(slot === 'trainer' ? [trainer] : []), 'water', 'water']);
      fees = ids.slice(slot === 'trainer' ? 1 : 0);
    } });
    const before = g.snapshot();
    assert(g.view(0).legalActions.some((a) => slot === 'trainer' ?
      a.type === 'playTrainer' && a.cardId === sourceId : a.type === 'useAbility' && a.abilityId === 'spread'));
    use(g, sourceId, slot); assert.equal(g.snapshot().pending.kind, 'activation-cost');
    g = restored(g, f); answer(g, fees.map((id) => paymentOptionId('fee', id)));
    assert.equal(g.snapshot().pending.kind, 'counter-allocation');
    assert.deepEqual(g.snapshot().pending.options, targets);
    assert.deepEqual(g.view(0).pending.counterAllocation.targets.map((t) => t.pokemonId), targets);
    const parts = [allocation(targets[0], 3), allocation(targets[1], 3)];
    g = resolve(g, f, parts);
    assert.deepEqual(mons(g.snapshot(), 1).map((m) => m.counters), [4, 2, 0]);
    assertResult(before, g.snapshot(), 1, parts, [targets[1]]);
    assert.equal(g.snapshot().events.filter((event) => event.ruleId === 'effects.activation-cost').length, 1);
    for (const id of fees) assert.equal(g.snapshot().players[0].discard.filter((card) => card === id).length, 1);
    assertUnchangedIdentities(before, g.snapshot()); restored(g, f);
  }
});

test('an independent native draw binding permits protected-only allocation on paid Trainer/ability use; an attack likewise keeps its other text', async () => {
  for (const [slot, trainer] of [['trainer', 'potion'], ['trainer', 'research'], ['ability', 'potion'], ['attack', 'potion']]) {
    const paid = slot !== 'attack';
    const f = await make(action(), { slot, trainer, paid, transform: (defs) => {
      const effects = slot === 'trainer' ? defs.find((d) => d.definitionId === trainer).mechanics.effects :
        slot === 'ability' ? defs[0].mechanics.abilities.find((a) => a.abilityId === 'spread').effects :
          defs[0].mechanics.attacks[0].effects;
      effects.push(binding('cn.draw@1', { count: 1 }, 'independent-protected-draw'));
      defs[0].mechanics.effects.push(binding('cn.protection@1',
        { effect: nativeSourceShield(slot, trainer) }, 'independent-source-shield'));
    } });
    let fees = [];
    let { g, sourceId, targets } = setup(f, { slot, trainer, mutate: (s) => {
      if (paid) {
        const ids = setHand(s, 0, [...(slot === 'trainer' ? [trainer] : []), 'water', 'water']);
        fees = ids.slice(slot === 'trainer' ? 1 : 0);
      }
    } });
    const before = g.snapshot(); use(g, sourceId, slot);
    if (paid) {
      assert.equal(g.snapshot().pending.kind, 'activation-cost'); g = restored(g, f);
      answer(g, fees.map((id) => paymentOptionId('fee', id)));
    }
    assert.equal(g.snapshot().pending.kind, 'counter-allocation');
    assert.deepEqual(g.snapshot().pending.options, targets, 'Qualification must never filter protected objects out of a valid selection window.');
    const parts = [allocation(targets[0], 2), allocation(targets[1], 4)];
    g = resolve(g, f, parts);
    const after = g.snapshot();
    assert.deepEqual(mons(after, 1).map((m) => m.counters), [1, 2, 0]);
    assertResult(before, after, 1, parts, targets);
    assert.equal(after.players[0].deck.length, before.players[0].deck.length - 1);
    assert(after.events.some((event) => event.ruleId === 'effects.draw' && event.data.player === 0 && event.data.count === 1));
    assert.equal(after.events.filter((event) => event.ruleId === 'effects.activation-cost').length, Number(paid));
    assertUnchangedIdentities(before, after); restored(g, f);
  }
});
