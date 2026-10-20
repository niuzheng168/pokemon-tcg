// Real OfficialGame state/protocol tests; all definitions/printings are synthetic.
// No successful fixture, source flag or healing receipt approves an actual card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import {
  validatePokemonHealingParameters, validateEffectProgram,
} from '../../public/rules/schema-validators.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached, fixtureClock,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const spec = (extra = {}) => ({
  op: 'healPokemon', side: 'own', target: 'any', selector: { kind: 'pokemon' },
  selection: { kind: 'exact', count: 2 }, amount: 30, discardHealedEnergy: false, ...extra,
});
const cost = () => ({
  costId: 'fee', kind: 'discardHand', count: 2,
  selector: { kind: 'energy', category: 'basic' }, sourceOfTruth: EVIDENCE,
});
const ability = (id, effects, extra = {}) => ({
  abilityId: id, name: `测试回复状态${id}`, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: id, limit: 1 },
  effects, sourceOfTruth: EVIDENCE, ...extra,
});
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const healingEvents = (s, kind) => s.events.filter((event) =>
  event.ruleId === 'effects.heal-results' && event.data.kind === kind);
const paymentEvents = (s) => s.events.filter((event) => event.ruleId === 'effects.activation-cost');
const count = (values, id) => values.filter((value) => value === id).length;
const use = (g, sourceId, slot = 'trainer', owner = g.snapshot().current) => command(g,
  slot === 'trainer' ? { type: 'playTrainer', cardId: sourceId } :
    { type: 'useAbility', pokemonId: g.snapshot().players[owner].active.id, abilityId: 'state-heal' }, owner);

async function make(action = spec(), { slot = 'trainer', trainer = 'research', paid = false, transform = () => {} } = {}) {
  return fixture((defs) => {
    const effects = [binding('cn.healPokemon@1', action, 'state-heal')];
    if (slot === 'trainer') {
      const d = defs.find((d) => d.definitionId === trainer);
      d.mechanics.effects = effects;
      if (paid) d.mechanics.playCosts = [cost()];
    } else defs[0].mechanics.abilities.push(ability('state-heal', effects, paid ? { costs: [cost()] } : {}));
    transform(defs);
  });
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
function setup(f, { owner = 0, side = 'own', slot = 'trainer', trainer = 'research',
  counters = [4, 2, 0], energies = false, mutate = () => {} } = {}) {
  let sourceId, targets;
  const g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    sourceId = slot === 'trainer' ? hand(s, owner, trainer) : s.players[owner].active.stack.at(-1);
    const recipient = side === 'own' ? owner : 1 - owner;
    targets = [s.players[recipient].active, bench(s, recipient, 'other'), bench(s, recipient, 'other')];
    targets.forEach((m, i) => { m.counters = counters[i]; if (energies) attached(s, recipient, m, 'water'); });
    s.events = [];
    mutate(s, { sourceId, targets, owner, recipient });
    targets = targets.map((m) => m.id);
  });
  return { g, sourceId, targets };
}
function atomic(g, fn, predicate) {
  const before = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(fn, predicate);
  assert.deepEqual(g.snapshot(), before, 'Rejected work cannot change counters, cards, RNG, quota, receipts, queue or revision.');
  assert.deepEqual([g.view(0), g.view(1)], views);
}
function restored(g, f) {
  const saved = g.snapshot(), r = OfficialGame.restore(clone(saved), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), saved);
  assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  return r;
}
function rejectRestore(snapshot, f, mutate, label, predicate = undefined) {
  const bad = clone(snapshot); mutate(bad); const original = clone(bad);
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), predicate, label);
  assert.deepEqual(bad, original, `${label}: restore must not repair the supplied snapshot.`);
}
function assertNoRngOrCardRewrite(before, after) {
  assert.deepEqual(after.rng, before.rng);
  assert.deepEqual(after.cards, before.cards);
  for (const owner of [0, 1]) {
    assert.deepEqual(after.players[owner].deck, before.players[owner].deck);
    assert.deepEqual(after.players[owner].prizes, before.players[owner].prizes);
  }
}

test('native healing parameters are the exact full action, with explicit flags, ten-point amount bounds and unchanged legacy heal', () => {
  const h = createCoreHandlers().get('cn.healPokemon@1'), legacy = createCoreHandlers().get('cn.heal@1');
  assert(h); assert.equal(h.timing, 'resolve'); assert.deepEqual(h.operations, ['healPokemon', 'discardEnergy']);
  assert.equal(h.parameterSchemaRef, 'urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/pokemonHealing');
  for (const amount of [10, 9007199254740990, 'all']) for (const discardHealedEnergy of [false, true])
    for (const selection of [{ kind: 'exact', count: 2 }, { kind: 'upTo', count: 2 }, { kind: 'all' }]) {
      const p = spec({ amount, discardHealedEnergy, selection });
      assert(validatePokemonHealingParameters(p)); assert(h.validateParameters(p));
      assert.deepEqual(h.execute({}, p), [p]); assert(validateEffectProgram([p]));
    }
  const missingFlag = spec(); delete missingFlag.discardHealedEnergy;
  for (const invalid of [
    missingFlag, { action: spec() }, spec({ op: 'heal' }), spec({ selector: { kind: 'any' } }),
    spec({ selector: { kind: 'energy' } }), spec({ selection: { kind: 'any' } }),
    spec({ selection: { kind: 'exact', count: 0 } }), spec({ discardHealedEnergy: 1 }),
    spec({ approved: true }), spec({ hp: 100 }), spec({ healed: ['invented'] }),
    ...[0, 1, 15, 0.5, 9007199254741000, Number.MAX_SAFE_INTEGER].map((amount) => spec({ amount })),
  ]) {
    assert(!validatePokemonHealingParameters(invalid), JSON.stringify(invalid));
    assert(!h.validateParameters(invalid)); assert(!validateEffectProgram([invalid]));
  }
  assert(legacy.validateParameters({ target: 'any', amount: 30 }));
  assert.deepEqual(legacy.execute({}, { target: 'any', amount: 30 }), [{ op: 'heal', side: 'own', target: 'any', count: 3 }]);
  assert(!legacy.validateParameters(spec()));
});

test('both actors and own/opponent sources keep a public exact two-of-three request stable through JSON restore and finalize their own Supporter once', async () => {
  for (const owner of [0, 1]) for (const side of ['own', 'opponent']) {
    const f = await make(spec({ side }));
    let { g, sourceId, targets } = setup(f, { owner, side });
    const before = g.snapshot(), recipient = side === 'own' ? owner : 1 - owner;
    g = restored(g, f); use(g, sourceId);
    const pending = g.snapshot(), q = pending.pending, c = q.data.healingChoice;
    assert.equal(q.kind, 'healing-targets'); assert.equal(q.ruleId, 'effects.heal-results'); assert.equal(q.player, owner);
    assert.deepEqual(q.options, targets); assert.equal(q.minimum, 2); assert.equal(q.maximum, 2); assert(!q.allowZero);
    assert.deepEqual(c, { id: c.id, turn: before.turn, sourceId,
      targets: mons(before, recipient).map((m) => ({ pokemonId: m.id, topCardId: m.stack.at(-1), counters: m.counters })) });
    assert(pending.players[owner].flags.supporter); assert(pending.players[owner].resolving.includes(sourceId));
    const request = healingEvents(pending, 'requested');
    assert.equal(request.length, 1); assert.equal(request[0].visibility, 'public');
    assert.deepEqual(request[0].data.choice, c); assert.deepEqual(request[0].data.action, spec({ side }));
    for (const viewer of [0, 1]) {
      assert(g.view(viewer).events.some((event) => event.ruleId === 'effects.heal-results' && event.data.id === c.id));
      assert(!Object.hasOwn(g.view(viewer), 'rng')); assert(!Object.hasOwn(g.view(viewer), 'queue'));
      if (viewer !== owner) assert.equal(g.view(viewer).pending, null);
    }
    const direct = restored(g, f); g = restored(restored(g, f), f);
    for (const game of [direct, g]) { answer(game, targets.slice(0, 2)); settle(game); }
    assert.deepEqual(g.snapshot(), direct.snapshot());
    const after = g.snapshot();
    assert.equal(after.phase, 'main'); assert.equal(after.pending, null);
    assert.deepEqual(mons(after, recipient).map((m) => m.counters), [1, 0, 0]);
    assert.equal(count(after.players[owner].discard, sourceId), 1); assert(!after.players[owner].resolving.includes(sourceId));
    assert.equal(after.players[owner].flags.supporter, true);
    assert.equal(healingEvents(after, 'resolved').length, 1); assertNoRngOrCardRewrite(before, after);
    restored(g, f);
  }
});

test('invalid or healthy-only multi-selections are atomic; including a healthy second target is legal and restoring never consumes an ability twice', async () => {
  const f = await make(spec({ amount: 10 }), { slot: 'ability' });
  let { g, sourceId, targets } = setup(f, { slot: 'ability', counters: [4, 0, 0] });
  const before = g.snapshot(); use(g, sourceId, 'ability');
  const pending = g.snapshot(), q = pending.pending;
  assert.equal(pending.players[0].active.used['state-heal'].length, 1);
  for (const selected of [[], [targets[0]], [targets[0], targets[0]], targets,
    targets.slice(1), [targets[0], before.players[1].active.id], [targets[0], 'missing']])
    atomic(g, () => answer(g, selected));
  atomic(g, () => command(g, { type: 'answer', requestId: q.id, selected: targets.slice(0, 2) }, 1));
  atomic(g, () => command(g, { type: 'answer', requestId: `${q.id}-old`, selected: targets.slice(0, 2) }));
  g = restored(g, f); answer(g, targets.slice(0, 2)); settle(g);
  assert.deepEqual(mons(g.snapshot(), 0).map((m) => m.counters), [3, 0, 0]);
  assert.equal(g.snapshot().players[0].active.used['state-heal'].length, 1);
  assert(!g.view(0).legalActions.some((a) => a.type === 'useAbility' && a.abilityId === 'state-heal'),
    'An injured eligible target remains, so the repeated-use rejection proves the quota.');
  atomic(g, () => use(g, sourceId, 'ability'));
  assertNoRngOrCardRewrite(before, g.snapshot()); restored(g, f);
});

test('all and forced-unique selections auto-resolve; all-healthy or empty windows cannot consume a Trainer/ability', async () => {
  for (const slot of ['trainer', 'ability']) {
    const all = spec({ selection: { kind: 'all' }, amount: 'all' }), f = await make(all, { slot });
    const { g, sourceId } = setup(f, { slot, counters: [3, 0, 1] });
    const before = g.snapshot(); use(g, sourceId, slot);
    assert.equal(g.snapshot().pending, null); assert.deepEqual(mons(g.snapshot(), 0).map((m) => m.counters), [0, 0, 0]);
    assert.equal(healingEvents(g.snapshot(), 'requested').length, 1); assert.equal(healingEvents(g.snapshot(), 'resolved').length, 1);
    assertNoRngOrCardRewrite(before, g.snapshot()); restored(g, f);
    const healthy = setup(f, { slot, counters: [0, 0, 0] });
    assert(!healthy.g.view(0).legalActions.some((a) => slot === 'trainer' ?
      a.type === 'playTrainer' && a.cardId === healthy.sourceId : a.type === 'useAbility' && a.abilityId === 'state-heal'));
    atomic(healthy.g, () => use(healthy.g, healthy.sourceId, slot));
  }
  const one = await make(spec({ selection: { kind: 'exact', count: 1 } }));
  const single = setup(one, { counters: [0, 2, 0] }); use(single.g, single.sourceId);
  assert.equal(single.g.snapshot().pending, null);
  assert.deepEqual(mons(single.g.snapshot(), 0).map((m) => m.counters), [0, 0, 0]); restored(single.g, one);
  const none = await make(spec({ selector: { kind: 'pokemon', nameKeys: ['evolution'] } }));
  const empty = setup(none); atomic(empty.g, () => use(empty.g, empty.sourceId));
});

test('full hand costs are independent of hand/attached-Energy after payment, paid once across both restore windows, and partial or unusable declarations reject atomically', async () => {
  for (const slot of ['trainer', 'ability']) for (const energies of [false, true]) {
    const f = await make(spec({ amount: 10, discardHealedEnergy: true }), { slot, paid: true });
    let fees;
    let { g, sourceId, targets } = setup(f, { slot, energies, counters: [4, 3, 2], mutate: (s) => {
      const ids = setHand(s, 0, slot === 'trainer' ? ['research', 'water', 'water'] : ['water', 'water']);
      fees = ids.slice(slot === 'trainer' ? 1 : 0);
    } });
    const before = g.snapshot(); use(g, sourceId, slot);
    const payment = g.snapshot(); assert.equal(payment.pending.kind, 'activation-cost');
    const selected = fees.map((id) => paymentOptionId('fee', id));
    for (const invalid of [[], selected.slice(0, 1), [selected[0], selected[0]]]) atomic(g, () => answer(g, invalid));
    g = restored(g, f); answer(g, selected);
    const healedChoice = g.snapshot(); assert.equal(healedChoice.pending.kind, 'healing-targets');
    assert.equal(healedChoice.players[0].hand.length, 0); assert.equal(paymentEvents(healedChoice).length, 1);
    assert.equal(paymentEvents(healedChoice)[0].data.payment.sourceId, sourceId);
    if (slot === 'ability') assert.equal(healedChoice.players[0].active.used['state-heal'].length, 1);
    g = restored(restored(g, f), f); answer(g, targets.slice(0, 2)); settle(g);
    const after = g.snapshot();
    assert.equal(paymentEvents(after).length, 1); assert.deepEqual(mons(after, 0).map((m) => m.counters), [3, 2, 2]);
    for (const id of fees) assert.equal(count(after.players[0].discard, id), 1);
    if (slot === 'trainer') assert.equal(count(after.players[0].discard, sourceId), 1);
    else assert.equal(after.players[0].active.used['state-heal'].length, 1);
    if (energies) assert.deepEqual(mons(after, 0).map((m) => m.energy.length), [0, 0, 1]);
    assertNoRngOrCardRewrite(before, after); restored(g, f);
    atomic(g, () => command(g, { type: 'answer', requestId: payment.pending.id, selected }));
    for (const [availableFees, counters] of [[1, [3, 2, 0]], [2, [0, 0, 0]]]) {
      const bad = setup(f, { slot, counters, mutate: (s) => {
        setHand(s, 0, [...(slot === 'trainer' ? ['research'] : []), ...Array(availableFees).fill('water')]);
      } });
      atomic(bad.g, () => use(bad.g, bad.sourceId, slot));
      assert.equal(paymentEvents(bad.g.snapshot()).length, 0);
    }
  }
});

test('restore binds the public original window/source/action/turn and exact bounds, rejecting local, queued, replayed and independently tampered work', async () => {
  const f = await make();
  const { g, sourceId, targets } = setup(f); use(g, sourceId);
  const saved = g.snapshot(), index = saved.events.findIndex((event) =>
    event.ruleId === 'effects.heal-results' && event.data.kind === 'requested');
  const changes = [
    ['missing choice', (s) => { delete s.pending.data.healingChoice; }],
    ['choice id', (s) => { s.pending.data.healingChoice.id += '-forged'; }],
    ['choice turn', (s) => { s.pending.data.healingChoice.turn++; }],
    ['source card', (s) => { s.pending.data.healingChoice.sourceId = s.players[0].active.stack.at(-1); }],
    ['window order', (s) => { s.pending.data.healingChoice.targets.reverse(); }],
    ['window target', (s) => { s.pending.data.healingChoice.targets.pop(); }],
    ['window top', (s) => { s.pending.data.healingChoice.targets[0].topCardId = s.players[0].deck[0]; }],
    ['window counters', (s) => { s.pending.data.healingChoice.targets[0].counters++; }],
    ['live counters', (s) => { s.players[0].active.counters++; }],
    ['live top', (s) => {
      const p = s.players[0], id = hand(s, 0, 'evolution'); p.hand.pop(); p.active.stack.push(id);
    }],
    ['source holder', (s) => { s.pending.data.source.owner = 1; }],
    ['source binding', (s) => { s.pending.data.source.effectId = 'different-effect'; }],
    ['source evidence', (s) => { s.pending.data.source.sourceOfTruth[0].locator = 'forged'; }],
    ['amount', (s) => { s.pending.data.action.amount = 40; }],
    ['selector', (s) => { s.pending.data.action.selector = { kind: 'pokemon', stages: ['stage1'] }; }],
    ['action side', (s) => { s.pending.data.action.side = 'opponent'; }],
    ['discard flag', (s) => { s.pending.data.action.discardHealedEnergy = true; }],
    ['selection', (s) => { s.pending.data.action.selection = { kind: 'upTo', count: 2 }; }],
    ['options', (s) => { s.pending.options.reverse(); }],
    ['minimum', (s) => { s.pending.minimum = 1; }],
    ['maximum', (s) => { s.pending.maximum = 3; }],
    ['zero permission', (s) => { s.pending.allowZero = true; }],
    ['player', (s) => { s.pending.player = 1; }],
    ['kind', (s) => { s.pending.kind = 'effect-target'; }],
    ['rule', (s) => { s.pending.ruleId = 'effects.heal'; }],
    ['local', (s) => { s.pending.data.local = true; }],
    ['preselected', (s) => { s.pending.data.selected = targets.slice(0, 2); }],
    ['missing request', (s) => { s.events.splice(index, 1); }],
    ['duplicate request', (s) => { s.events.push(clone(s.events[index])); }],
    ['request id', (s) => { s.events[index].data.id += '-forged'; }],
    ['request turn', (s) => { s.events[index].data.choice.turn++; }],
    ['queued started work', (s) => { s.queue.unshift({ op: s.pending.resume, data: clone(s.pending.data) }); }],
    ['already resolved', (s) => {
      s.events.push({ ruleId: 'effects.heal-results', visibility: 'public',
        data: { kind: 'resolved', id: s.pending.data.healingChoice.id } });
    }],
    ['missing Trainer finalizer', (s) => { s.queue = s.queue.filter((task) => task.op !== 'finish-trainer'); }],
    ['duplicate Trainer finalizer', (s) => { s.queue.push(clone(s.queue.find((task) => task.op === 'finish-trainer'))); }],
  ];
  for (const visibility of ['private', 0, 1]) changes.push([
    `request visibility ${visibility}`, (s) => { s.events[index].visibility = visibility; },
  ]);
  const accepted = [];
  for (const [label, mutate] of changes) {
    const bad = clone(saved); mutate(bad); const originalBad = clone(bad);
    let rejected = false; try { OfficialGame.restore(bad, { catalog: f.catalog }); } catch { rejected = true; }
    if (!rejected) accepted.push(label);
    assert.deepEqual(bad, originalBad, label); assert.deepEqual(g.snapshot(), saved, label);
  }
  assert.deepEqual(accepted, [], 'No independently changed healing continuation may be restored.');
  rejectRestore(saved, f, (s) => {
    const d = s.queue.find((task) => task.op === 'finish-trainer').data;
    s.events.push({ ruleId: 'turn.trainer', visibility: 'public', data: {
      kind: 'trainer-finished', id: d.completionId, player: d.player, cardId: d.cardId, turn: s.turn,
    } });
  }, 'The still-outstanding current completion cannot already be trainer-finished',
  { code: 'invalid-trainer-finish' });
  const valid = restored(g, f); answer(valid, targets.slice(0, 2)); settle(valid); restored(valid, f);
});

test('a second use of the same physical Item gets new request/finalizer identities and cannot borrow an earlier same-turn completion', async () => {
  const f = await make(spec({ amount: 10 }), { trainer: 'potion', transform: (defs) => {
    defs[0].mechanics.abilities.push(ability('recover-source', [binding('cn.cards@1', {
      from: 'discard', to: 'hand', selector: { kind: 'trainer', nameKeys: ['potion'] },
      quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false,
    }, 'recover-source')]));
  } });
  let { g, sourceId, targets } = setup(f, { trainer: 'potion', counters: [5, 4, 3] });
  const before = g.snapshot(); use(g, sourceId);
  const first = g.snapshot(), oldChoice = first.pending.data.healingChoice;
  const oldFinalizer = first.queue.find((task) => task.op === 'finish-trainer');
  answer(g, targets.slice(0, 2)); settle(g);
  command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'recover-source' });
  answer(g, [sourceId]); settle(g); use(g, sourceId);
  const second = g.snapshot(), finalizer = second.queue.find((task) => task.op === 'finish-trainer');
  assert.equal(second.turn, first.turn); assert.notEqual(second.pending.data.healingChoice.id, oldChoice.id);
  assert.notEqual(finalizer.data.completionId, oldFinalizer.data.completionId);
  rejectRestore(second, f, (s) => { s.pending.data.healingChoice = clone(oldChoice); }, 'old window');
  rejectRestore(second, f, (s) => { s.pending.data.healingChoice.id = oldChoice.id; }, 'resolved old request id');
  rejectRestore(second, f, (s) => {
    s.queue[s.queue.findIndex((task) => task.op === 'finish-trainer')] = clone(oldFinalizer);
  }, 'an already completed use cannot finalize a new use of the same physical card');
  g = restored(g, f); answer(g, targets.slice(0, 2)); settle(g);
  assert.equal(count(g.snapshot().players[0].discard, sourceId), 1);
  assert.equal(healingEvents(g.snapshot(), 'requested').length, 2); assert.equal(healingEvents(g.snapshot(), 'resolved').length, 2);
  assert.deepEqual(mons(g.snapshot(), 0).map((m) => m.counters), [3, 2, 3]);
  assertNoRngOrCardRewrite(before, g.snapshot()); restored(g, f);
});

test('restored protected/healthy targets cannot borrow an earlier healedTurn flag to enter this instruction’s healed set or lose Energy', async () => {
  const f = await make(spec({ side: 'opponent', amount: 'all', discardHealedEnergy: true }), { transform: (defs) => {
    defs[1].mechanics.effects.push(binding('cn.protection@1', { effect: {
      op: 'protection', useRule: 'ordinary', channel: 'effects', scope: 'self', from: 'opponent', categories: ['trainer'],
    } }, 'protected-heal'));
  } });
  let { g, sourceId, targets } = setup(f, { side: 'opponent', counters: [4, 2, 0], energies: true,
    mutate: (s, { targets: live }) => {
      live[1].facts.healedTurn = s.turn; live[2].facts.healedTurn = s.turn;
    } });
  const before = g.snapshot(); use(g, sourceId); g = restored(g, f);
  answer(g, targets.slice(0, 2)); settle(g);
  const after = g.snapshot(), result = healingEvents(after, 'resolved').at(-1);
  assert.deepEqual(result.data.healed, [targets[0]]);
  assert.deepEqual(result.data.discarded, before.players[1].active.energy);
  assert.deepEqual(mons(after, 1).map((m) => m.counters), [0, 2, 0]);
  assert.deepEqual(mons(after, 1).slice(1).map((m) => m.energy), mons(before, 1).slice(1).map((m) => m.energy));
  assertNoRngOrCardRewrite(before, after); restored(g, f);
});

test('the live-type healing selector does not fall back to printed Pokémon types', async () => {
  const f = await make(spec({ selector: { kind: 'pokemon', types: ['Psychic'] }, selection: { kind: 'exact', count: 1 } }),
    { transform: (defs) => {
      defs[0].mechanics.abilities.push({
        abilityId: 'current-psychic', name: '测试当前属性', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
        effects: [binding('cn.pokemonTypes@1', { effect: { op: 'pokemonTypes', types: ['Psychic'], scope: 'self' } })],
      });
    } });
  const { g, sourceId } = setup(f);
  const before = g.snapshot(), printed = clone(f.catalog.definition('base'));
  assert.deepEqual(printed.mechanics.types, ['Water']); assert.deepEqual(g.view(0).players[0].active.effective.types, ['Psychic']);
  use(g, sourceId);
  assert.equal(g.snapshot().pending, null); assert.deepEqual(mons(g.snapshot(), 0).map((m) => m.counters), [1, 2, 0]);
  assert.deepEqual(f.catalog.definition('base'), printed); assertNoRngOrCardRewrite(before, g.snapshot()); restored(g, f);
});

test('a global KO-trigger healing receipt survives restore but cannot resurrect an already latched Pokémon or cancel its Prize award', async () => {
  const f = await fixture((defs) => {
    defs[1].mechanics.abilities.push({
      abilityId: 'ko-heal', name: '测试锁定昏厥后回复', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'knockout', subject: 'self', optional: true, choiceOwner: 'source', scope: 'global' },
      effects: [binding('cn.healPokemon@1', spec({ target: 'self', selection: { kind: 'all' }, amount: 'all' }))],
    });
  });
  let victim, victimCard;
  let g = board(f, (s) => {
    const p = s.players[1], old = p.active, replacement = bench(s, 1, 'other');
    p.bench.pop(); p.active = replacement; p.bench.push(old);
    replacement.counters = 8; victim = replacement.id; victimCard = replacement.stack.at(-1);
    attached(s, 0, s.players[0].active, 'water'); s.events = [];
  });
  const before = g.snapshot(); command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.kind, 'trigger-optional'); g = restored(g, f);
  answer(g, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'prize');
  assert.equal(healingEvents(g.snapshot(), 'resolved').length, 1);
  assert(g.snapshot().players[1].discard.includes(victimCard));
  assert(!mons(g.snapshot(), 1).some((m) => m.id === victim));
  g = restored(g, f); answer(g, ['0']); settle(g);
  assert.equal(g.snapshot().players[0].prizes.length, before.players[0].prizes.length - 1);
  assert(!mons(g.snapshot(), 1).some((m) => m.id === victim));
  assert.equal(healingEvents(g.snapshot(), 'resolved').length, 1);
  assert.deepEqual(g.snapshot().rng, before.rng); restored(g, f);
});
