import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import { deckEnergyWindow } from '../../public/rules/deck-energy.js';
import { shuffleIds } from '../../public/rules/random.js';
import { fixture, binding, EVIDENCE, board, command, answer, hand, attached, bench } from './fixtures.mjs';

// Real OfficialGame integration with synthetic executable definitions. These
// exercise the visually reviewed CN instructions, not production card approval.
const generator = (extra = {}) => ({
  op: 'attachDeckEnergy', lookTop: 5,
  selector: { kind: 'energy', category: 'basic', types: ['Lightning'] },
  quantity: { kind: 'upTo', count: 2 },
  recipient: { position: 'bench', selector: { kind: 'pokemon', types: ['Lightning'] } },
  distribution: 'separateRecipients', remainder: 'shuffleDeck', reveal: false, ...extra,
});
const charge = (extra = {}) => generator({
  lookTop: null, quantity: { kind: 'exact', count: 1 },
  recipient: { position: 'self', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient', ...extra,
});
const descriptor = (extra = {}) => ({
  event: 'energyAttached', subject: 'self', optional: false, choiceOwner: 'source', scope: 'subject', ...extra,
});
const reaction = (id, count, extra = {}) => ({
  abilityId: id, name: `测试附着反应${id}`, mode: 'triggered', usage: null,
  trigger: descriptor(extra),
  effects: [binding('cn.counters@1', { side: 'own', target: 'event', count }, id)], sourceOfTruth: EVIDENCE,
});
async function make(itemAction = generator(), mutate = () => {}, handlers = new Map()) {
  return fixture((defs) => {
    const base = defs.find((d) => d.definitionId === 'base'), other = defs.find((d) => d.definitionId === 'other');
    base.mechanics.types = ['Lightning']; other.mechanics.types = ['Lightning'];
    const nonLightning = defs.find((d) => d.definitionId === 'evolution').mechanics;
    nonLightning.stage = 'basic'; nonLightning.evolvesFrom = null; nonLightning.types = ['Water'];
    defs.find((d) => d.definitionId === 'water').mechanics.baseUnits = [['Lightning']];
    defs.find((d) => d.definitionId === 'double').mechanics.baseUnits = [['Lightning'], ['Lightning']];
    defs.find((d) => d.definitionId === 'potion').mechanics.effects =
      [binding('cn.attachDeckEnergy@1', itemAction, 'generator')];
    base.mechanics.attacks = [{
      attackId: 'base:charge', name: '测试充电', cost: ['Lightning'], printedDamage: null,
      effects: [binding('cn.attachDeckEnergy@1', charge(), 'charge')], sourceOfTruth: EVIDENCE,
    }];
    mutate(defs);
  }, handlers);
}
const copy = (value) => JSON.parse(JSON.stringify(value));
const restore = (s, f) => OfficialGame.restore(copy(s), { catalog: f.catalog });
const defaultPolicy = (q) => q.allowZero ? [] : q.options.slice(0, q.minimum);
const logSince = (g, index, ruleId) => g.snapshot().events.slice(index).filter((event) => event.ruleId === ruleId);
const attachedLogs = (g, index) => logSince(g, index, 'effects.attach').filter((event) => event.data.from === 'deck');
const triggerLogs = (g, index, abilityId) => logSince(g, index, 'trigger.energy')
  .filter((event) => event.data.performed && event.data.abilityId === abilityId);

/** Every real answer is compared to an independently JSON-restored game. */
function respond(g, f, selected) {
  const before = g.snapshot(), next = restore(before, f);
  assert.deepEqual(next.snapshot(), before);
  assert.deepEqual(next.view(0), g.view(0)); assert.deepEqual(next.view(1), g.view(1));
  answer(g, selected); answer(next, selected);
  assert.deepEqual(next.snapshot(), g.snapshot());
  return g.snapshot();
}
function settleRestoring(g, f, policy = defaultPolicy) {
  for (let guard = 0; g.snapshot().pending; guard++) {
    assert(guard < 200, 'Test-choice guard, not an engine rule.');
    respond(g, f, policy(g.snapshot().pending, g.snapshot()));
  }
  return g.snapshot();
}
function invalidAnswer(g, fn) {
  const before = g.snapshot(); assert.throws(fn);
  assert.deepEqual(g.snapshot(), before, 'An invalid answer must not mutate state, cards, RNG, receipts or revision.');
}

// Reserve all intended window cards before returning any to the deck: take()
// may otherwise use deck.pop() to replace a card fetched from face-down Prizes.
function reserve(s, owner, definitionId) {
  const id = hand(s, owner, definitionId), p = s.players[owner];
  p.hand.splice(p.hand.indexOf(id), 1); p.resolving.push(id); return id;
}
function release(s, owner, ids, destination) {
  const p = s.players[owner];
  for (const id of ids) {
    const at = p.resolving.indexOf(id); assert(at >= 0); p.resolving.splice(at, 1);
  }
  p[destination].push(...ids);
}
function top(s, owner, idsTopFirst, only = false) {
  const p = s.players[owner];
  if (only) p.hand.push(...p.deck.splice(0));
  release(s, owner, [...idsTopFirst].reverse(), 'deck');
}
function setup(s, { window = ['water', 'research', 'double', 'water', 'tool'], only = false } = {}) {
  const item = hand(s, 0, 'potion'), first = bench(s, 0, 'other').id, second = bench(s, 0, 'other').id;
  const excluded = bench(s, 0, 'evolution').id, manual = hand(s, 0, 'water');
  const outside = reserve(s, 0, 'water'), looked = window.map((id) => reserve(s, 0, id));
  release(s, 0, [outside], 'deck');
  top(s, 0, looked, only);
  return { item, first, second, excluded, manual, outside, looked,
    chosen: looked.filter((id) => s.cards[id].definitionId === 'water') };
}
function play(g, ids) { command(g, { type: 'playTrainer', cardId: ids.item }); }
function assertUntouched(g, originalDeck, originalRng, originalHand) {
  const s = g.snapshot();
  assert.deepEqual(s.players[0].deck, originalDeck);
  assert.deepEqual(s.rng, originalRng);
  assert.deepEqual(s.players[0].hand, originalHand);
}
function assertSafeOwnerProjection(g, owner, receiptId) {
  const mine = g.view(owner), theirs = g.view(1 - owner);
  assert.equal(theirs.pending, null, 'Only the actual owner sees the private selection/assignment prompt.');
  assert(!theirs.events.some((event) => event.data.id === receiptId &&
    ['requested', 'selected', 'allocated'].includes(event.data.kind)));
  for (const event of mine.events.filter((event) => event.data.id === receiptId && event.data.kind === 'requested'))
    assert.equal(Object.hasOwn(event.data, 'deck'), false,
      'A restoration receipt cannot reveal the entire original deck/order through the owner view.');
}

test('Generator preserves the entire deck through every private choice, then attaches to same/split filtered own Bench recipients', async () => {
  for (const sameTarget of [true, false]) {
    const f = await make(generator({ reveal: sameTarget }), (defs) => defs.find((d) => d.definitionId === 'other').mechanics.abilities = [
      reaction('every-attachment', 1), reaction('hand-only', 3, { origin: 'hand' }),
    ]);
    let ids;
    const g = board(f, (s) => { ids = setup(s); }), before = g.snapshot(), index = before.events.length;
    const remaining = before.players[0].deck.filter((id) => !ids.chosen.includes(id)), rng = [...before.rng];
    shuffleIds(rng, remaining);
    play(g, ids);
    let s = g.snapshot(), c = s.pending.data.deckChoice;
    assert.equal(s.pending.kind, 'inspect-deck'); assert.equal(s.pending.minimum, 0); assert.equal(s.pending.maximum, 2);
    assert.equal(s.pending.allowZero, true); assert.deepEqual(s.pending.options.sort(), [...ids.chosen].sort());
    assert.deepEqual(c.deck, before.players[0].deck); assert.deepEqual(c.window, ids.looked);
    assert.deepEqual(g.view(0).pending.lookedAt.map((card) => card.instanceId), ids.looked);
    const originalHand = [...s.players[0].hand];
    assertUntouched(g, before.players[0].deck, before.rng, originalHand);
    respond(g, f, ids.chosen);
    s = g.snapshot();
    assert.equal(s.pending.kind, 'deck-energy-recipient');
    assert.deepEqual(new Set(s.pending.options), new Set([ids.first, ids.second]));
    assert(!s.pending.options.includes(ids.excluded)); assert(!s.pending.options.includes(before.players[0].active.id));
    assert(!s.pending.options.includes(before.players[1].active.id));
    assertUntouched(g, before.players[0].deck, before.rng, originalHand);
    respond(g, f, [ids.first]);
    s = g.snapshot();
    assert.equal(s.pending.kind, 'deck-energy-recipient');
    assert.equal(s.pending.data.deckChoice.assignments.length, 1);
    assert(s.players[0].bench.every((m) => m.energy.length === 0));
    assertUntouched(g, before.players[0].deck, before.rng, originalHand);
    respond(g, f, [sameTarget ? ids.first : ids.second]);
    s = g.snapshot();
    assert.equal(s.pending.kind, 'trigger-order');
    const units = s.pending.data.units.filter((unit) => unit.abilityId === 'every-attachment');
    assert.equal(units.length, 2);
    assert.deepEqual(new Set(units.map((unit) => unit.event.cardId)), new Set(ids.chosen));
    assert(units.every((unit) => unit.event.kind === 'energyAttached' && unit.event.origin === 'deck' &&
      unit.event.cause.source.category === 'trainer' && unit.event.cause.source.origin === 'hand'));
    assert.equal(s.players[0].bench.reduce((count, m) => count + m.energy.length, 0), 2,
      'All allocated cards commit before the first real attachment trigger can run.');
    assert(s.players[0].bench.every((m) => m.counters === 0));
    const after = settleRestoring(g, f);
    assert.deepEqual(after.players[0].deck, remaining); assert.deepEqual(after.rng, rng);
    assert.equal(after.players[0].flags.energy, before.players[0].flags.energy);
    assert.deepEqual(after.players[0].hand, originalHand);
    assert(after.players[0].discard.includes(ids.item));
    assert.equal(triggerLogs(g, index, 'every-attachment').length, 2);
    assert.equal(triggerLogs(g, index, 'hand-only').length, 0);
    assert.equal(attachedLogs(g, index).length, 2);
    const first = after.players[0].bench.find((m) => m.id === ids.first);
    const second = after.players[0].bench.find((m) => m.id === ids.second);
    assert.equal(first.counters, sameTarget ? 2 : 1); assert.equal(second.counters, sameTarget ? 0 : 1);
    assert.deepEqual(new Set([...first.energy, ...second.energy]), new Set(ids.chosen));
    assert.equal(logSince(g, index, 'effects.shuffle').filter((event) => event.data.player === 0).length, 1);
    const reveals = logSince(g, index, 'effects.search').filter((event) => event.data.kind === 'revealed');
    assert.equal(reveals.length, sameTarget ? 1 : 0);
    if (sameTarget) {
      const [revealed] = reveals;
      assert.equal(revealed.visibility, 'public');
      assert.deepEqual(revealed.data.revealed, ids.chosen.map((id) => after.cards[id]));
      for (const viewer of [0, 1]) {
        const projected = g.view(viewer).events.filter((event) => event.data.id === c.id && event.data.kind === 'revealed');
        assert.equal(projected.length, 1);
        assert.deepEqual(projected[0].data.revealed, ids.chosen.map((id) => after.cards[id]));
        assert.equal(Object.hasOwn(projected[0].data, 'window'), false);
        assert.equal(Object.hasOwn(projected[0].data, 'deck'), false);
        for (const id of [...ids.looked.filter((cardId) => !ids.chosen.includes(cardId)), ids.outside])
          assert(!JSON.stringify(projected[0].data).includes(JSON.stringify(id)),
            'Revealing successful attachments publishes only chosen cards, never unselected window/lower-deck cards.');
      }
    }
  }
});

test('private raw deck/window receipts are not public deck-order knowledge in either player view', async () => {
  const f = await make(); let ids;
  const g = board(f, (s) => { ids = setup(s); });
  play(g, ids);
  const receiptId = g.snapshot().pending.data.deckChoice.id;
  assertSafeOwnerProjection(g, 0, receiptId);
  respond(g, f, ids.chosen); assertSafeOwnerProjection(g, 0, receiptId);
  respond(g, f, [ids.first]); assertSafeOwnerProjection(g, 0, receiptId);
  respond(g, f, [ids.first]); settleRestoring(g, f);
  assertSafeOwnerProjection(g, 0, receiptId);
});

test('Generator can inspect a nonempty hidden miss or choose zero; actual hidden matches do not determine canUse', async () => {
  for (const miss of [true, false]) {
    const f = await make(); let ids;
    const g = board(f, (s) => {
      ids = setup(s, { window: miss ? ['research', 'double', 'tool', 'stadium', 'poison'] : undefined });
    });
    const before = g.snapshot(), index = before.events.length, expected = [...before.players[0].deck], rng = [...before.rng];
    assert(g.view(0).legalActions.some((action) => action.type === 'playTrainer' && action.cardId === ids.item));
    shuffleIds(rng, expected);
    play(g, ids);
    const pending = g.snapshot();
    assert.equal(pending.pending.kind, 'inspect-deck');
    assert.equal(pending.pending.options.length, miss ? 0 : 2);
    assert.equal(pending.pending.minimum, 0); assert.equal(pending.pending.allowZero, true);
    respond(g, f, []);
    const after = settleRestoring(g, f);
    assert.deepEqual(after.players[0].deck, expected); assert.deepEqual(after.rng, rng);
    assert.equal(attachedLogs(g, index).length, 0);
    assert.equal(logSince(g, index, 'effects.shuffle').length, 1);
    assert.equal(after.players[0].flags.energy, false);
  }
});

test('Charge full-search exact one can find an Energy below top five and attaches to the actual user, never through hand', async () => {
  for (const failToFind of [true, false]) {
    const f = await make(); let ids;
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); ids = setup(s);
    });
    const before = g.snapshot(), actor = before.players[0].active.id, originalHand = [...before.players[0].hand], index = before.events.length;
    assert(!ids.looked.includes(ids.outside));
    command(g, { type: 'attack', attackId: 'base:charge' });
    let s = g.snapshot();
    assert.equal(s.pending.kind, 'inspect-deck'); assert.equal(s.pending.minimum, 0); assert.equal(s.pending.maximum, 1);
    assert.equal(s.pending.data.deckChoice.window.length, before.players[0].deck.length);
    assert(s.pending.options.includes(ids.outside));
    assertUntouched(g, before.players[0].deck, before.rng, originalHand);
    respond(g, f, failToFind ? [] : [ids.outside]);
    if (!failToFind) {
      s = g.snapshot();
      assert.equal(s.pending.kind, 'deck-energy-recipient'); assert.deepEqual(s.pending.options, [actor]);
      assertUntouched(g, before.players[0].deck, before.rng, originalHand);
      respond(g, f, [actor]);
    }
    const after = settleRestoring(g, f);
    assert.equal(after.current, 1);
    assert.deepEqual(after.players[0].hand, originalHand);
    assert.equal(after.players[0].flags.energy, before.players[0].flags.energy);
    assert.equal(after.players[0].active.energy.includes(ids.outside), !failToFind);
    assert.equal(attachedLogs(g, index).length, failToFind ? 0 : 1);
    assert(!logSince(g, index, 'trigger.before-hand').some((event) => event.data.performed));
  }
});

test('ordinary attachment remains available after Generator, and already spending it does not block deck attachment', async () => {
  for (const alreadySpent of [true, false]) {
    const f = await make(); let ids;
    const g = board(f, (s) => { ids = setup(s); });
    if (alreadySpent) command(g, { type: 'attachEnergy', cardId: ids.manual, pokemonId: g.snapshot().players[0].active.id });
    const before = g.snapshot();
    assert.equal(before.players[0].flags.energy, alreadySpent);
    assert(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === ids.item));
    play(g, ids); respond(g, f, ids.chosen); respond(g, f, [ids.first]); respond(g, f, [ids.second]);
    const after = settleRestoring(g, f);
    assert.equal(after.players[0].flags.energy, alreadySpent);
    assert.equal(after.players[0].bench.reduce((count, m) => count + m.energy.length, 0), 2);
    assert.equal(after.players[0].active.energy.includes(ids.manual), alreadySpent);
    if (!alreadySpent) {
      assert(g.view(0).legalActions.some((a) => a.type === 'attachEnergy' && a.cardId === ids.manual));
      command(g, { type: 'attachEnergy', cardId: ids.manual, pokemonId: after.players[0].active.id });
      assert.equal(g.snapshot().players[0].flags.energy, true);
    }
  }
});

test('one multi-unit Special Energy is one deck attachment; hand-only eligibility/acquisition do not run, retention still does', async () => {
  const action = generator({ lookTop: null, selector: { kind: 'energy', category: 'special' }, quantity: { kind: 'exact', count: 1 } });
  for (const retained of [true, false]) {
    const f = await make(action, (defs) => {
      defs.find((d) => d.definitionId === 'other').mechanics.abilities = [reaction('every-attachment', 1), reaction('hand-only', 3, { origin: 'hand' })];
      const e = defs.find((d) => d.definitionId === 'double').mechanics;
      e.handAttachTo = { kind: 'pokemon', nameKeys: ['base'] };
      e.remainOn = { kind: 'pokemon', nameKeys: [retained ? 'other' : 'base'] };
      e.effects = [{
        ...binding('cn.counters@1', { side: 'own', target: 'active', count: 1 }, 'must-not-acquire'),
        trigger: { event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'any', optional: false, afterUse: 'hand' },
      }];
    });
    let ids;
    const g = board(f, (s) => { ids = setup(s); }), before = g.snapshot(), index = before.events.length;
    const special = ids.looked.find((id) => before.cards[id].definitionId === 'double');
    assert(!g.view(0).legalActions.some((a) => a.type === 'attachEnergy' && a.cardId === special && a.pokemonId === ids.first));
    play(g, ids); respond(g, f, [special]); respond(g, f, [ids.first]);
    const after = settleRestoring(g, f), target = after.players[0].bench.find((m) => m.id === ids.first);
    assert.equal(target.energy.includes(special), retained);
    assert.equal(after.players[0].discard.includes(special), !retained);
    assert.equal(target.counters, 1, 'Two provided units remain one real physical-card attachment event.');
    assert.equal(triggerLogs(g, index, 'every-attachment').length, 1);
    assert.equal(triggerLogs(g, index, 'hand-only').length, 0);
    assert.equal(attachedLogs(g, index).length, 1);
    assert(!logSince(g, index, 'trigger.before-hand').some((event) => event.data.performed));
    assert.equal(after.players[0].active.counters, 0); assert.equal(after.players[0].flags.energy, false);
    assert(!after.players[0].hand.includes(special));
  }
});

test('Trainer protection blocks the effect, not the legal target choice, and blocked Energy remains in the shuffled deck', async () => {
  for (const blocked of [true, false]) {
    const f = await make(generator(), (defs) => defs.find((d) => d.definitionId === 'other').mechanics.effects.push(
      binding('cn.protection@1', { effect: {
        op: 'protection', useRule: 'ordinary', channel: 'effects', scope: 'self', from: blocked ? 'own' : 'opponent', categories: ['trainer'],
        trainerCategories: ['item'], trainerOrigins: ['hand'],
      } }, 'deck-shield')));
    let ids;
    const g = board(f, (s) => { ids = setup(s); }), before = g.snapshot(), index = before.events.length;
    play(g, ids); respond(g, f, ids.chosen);
    assert(g.snapshot().pending.options.includes(ids.first));
    respond(g, f, [ids.first]); respond(g, f, [ids.first]);
    const after = settleRestoring(g, f), target = after.players[0].bench.find((m) => m.id === ids.first);
    assert.equal(target.energy.length, blocked ? 0 : 2);
    assert.equal(attachedLogs(g, index).length, blocked ? 0 : 2);
    assert.equal(logSince(g, index, 'effects.protection').length, blocked ? 2 : 0);
    for (const id of ids.chosen) assert.equal(after.players[0].deck.includes(id), blocked);
    assert.equal(after.players[0].deck.length, before.players[0].deck.length - (blocked ? 0 : 2));
    assert.equal(logSince(g, index, 'effects.shuffle').length, 1);
  }
});

test('the final whole-deck shuffle handles zero/one remaining cards and never invents RNG samples', async () => {
  for (const [cards, selectedCount, expectedRemaining, expectedShuffles] of [
    [1, 1, 0, 0], [2, 1, 1, 1], [1, 0, 1, 1],
  ]) {
    const f = await make(); let ids;
    const g = board(f, (s) => { ids = setup(s, { window: Array(cards).fill('water'), only: true }); });
    const before = g.snapshot(), index = before.events.length;
    assert.equal(before.players[0].deck.length, cards);
    play(g, ids); respond(g, f, ids.chosen.slice(0, selectedCount));
    if (selectedCount) respond(g, f, [ids.first]);
    const after = settleRestoring(g, f);
    assert.equal(after.players[0].deck.length, expectedRemaining); assert.deepEqual(after.rng, before.rng);
    const shuffles = logSince(g, index, 'effects.shuffle').filter((event) => event.data.player === 0);
    assert.equal(shuffles.length, expectedShuffles);
    if (expectedShuffles) assert.equal(shuffles[0].data.count, 1);
  }
  const f = await make(); let ids;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); ids = setup(s, { window: [], only: true }); });
  const before = g.snapshot(), index = before.events.length;
  assert.equal(before.players[0].deck.length, 0);
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === ids.item));
  command(g, { type: 'attack', attackId: 'base:charge' });
  assert.equal(g.snapshot().pending.kind, 'inspect-deck');
  assert.deepEqual(g.snapshot().pending.options, []);
  respond(g, f, []); settleRestoring(g, f);
  assert.equal(logSince(g, index, 'effects.shuffle').filter((event) => event.data.player === 0).length, 0);
  assert.deepEqual(g.snapshot().rng, before.rng);
});

test('bad selections, recipient choices, wrong player/request and stale revision are atomic at every private stage', async () => {
  const f = await make(); let ids;
  const g = board(f, (s) => { ids = setup(s); });
  play(g, ids);
  for (const selected of [[ids.outside], [ids.looked.find((id) => !ids.chosen.includes(id))], [ids.chosen[0], ids.chosen[0]],
    [...ids.chosen, ids.outside]]) invalidAnswer(g, () => answer(g, selected));
  let s = g.snapshot();
  invalidAnswer(g, () => g.dispatch({ player: 1, expectedRevision: s.revision,
    action: { type: 'answer', requestId: s.pending.id, selected: [] } }));
  invalidAnswer(g, () => g.dispatch({ player: 0, expectedRevision: s.revision,
    action: { type: 'answer', requestId: 'wrong-request', selected: [] } }));
  invalidAnswer(g, () => g.dispatch({ player: 0, expectedRevision: s.revision - 1,
    action: { type: 'answer', requestId: s.pending.id, selected: [] } }));
  respond(g, f, ids.chosen);
  for (const selected of [[], [ids.excluded], [g.snapshot().players[0].active.id], [g.snapshot().players[1].active.id],
    [ids.first, ids.second], [ids.chosen[0]]]) invalidAnswer(g, () => answer(g, selected));
  respond(g, f, [ids.first]);
  invalidAnswer(g, () => answer(g, [ids.excluded]));
  respond(g, f, [ids.second]); settleRestoring(g, f);
});

test('JSON restore rejects modified original deck/window/owner/bounds and replayed private deck continuations', async () => {
  const f = await make(); let ids;
  const g = board(f, (s) => { ids = setup(s); });
  play(g, ids);
  const check = (label, mutate) => {
    const saved = g.snapshot(), invalid = copy(saved);
    mutate(invalid);
    assert.throws(() => restore(invalid, f), (error) => error instanceof EngineError, label);
    assert.deepEqual(g.snapshot(), saved);
  };
  const request = (s) => s.events.find((event) => event.ruleId === 'effects.search' &&
    event.data.kind === 'requested' && event.data.id === s.pending.data.deckChoice.id);
  for (const [label, mutate] of [
    ['live deck permutation', (s) => { s.players[0].deck.reverse(); }],
    ['saved original deck', (s) => { s.pending.data.deckChoice.deck.reverse(); }],
    ['bounded original window', (s) => { s.pending.data.deckChoice.window.reverse(); }],
    ['future clock', (s) => { s.pending.data.deckChoice.turn++; }],
    ['private request removed', (s) => { s.events.splice(s.events.indexOf(request(s)), 1); }],
    ['private request visibility', (s) => { request(s).visibility = 1; }],
    ['private request window', (s) => { request(s).data.window.reverse(); }],
    ['private request source', (s) => { request(s).data.source.owner = 1; }],
    ['unearned preselection', (s) => { s.pending.data.deckChoice.chosen = [ids.chosen[0]]; }],
    ['wrong current request owner', (s) => { s.pending.player = 1; }],
    ['wrong source reference owner', (s) => { s.pending.data.source.owner = 1; }],
    ['changed source card holder', (s) => { s.pending.data.source.cardOwner = 1; }],
    ['arbitrary public lower bound', (s) => { s.pending.minimum = 1; }],
    ['changed maximum', (s) => { s.pending.maximum = 1; }],
    ['changed zero permission', (s) => { s.pending.allowZero = false; }],
    ['forged eligible options', (s) => { s.pending.options = [ids.outside, ids.chosen[0]]; }],
    ['queued replay', (s) => { s.queue.unshift({ op: 'effect-choice', data: copy(s.pending.data) }); }],
  ]) check(label, mutate);
  respond(g, f, ids.chosen);
  check('chosen order changed after selection receipt', (s) => { s.pending.data.deckChoice.chosen.reverse(); });
  check('selection receipt tamper', (s) => {
    s.events.find((event) => event.ruleId === 'effects.search' && event.data.kind === 'selected' &&
      event.data.id === s.pending.data.deckChoice.id).data.selected.reverse();
  });
  respond(g, f, [ids.first]);
  check('valid but unchosen target', (s) => { s.pending.data.deckChoice.assignments[0].targetId = ids.second; });
  check('private allocation receipt tamper', (s) => {
    s.events.find((event) => event.ruleId === 'effects.attach' && event.data.kind === 'allocated' &&
      event.data.id === s.pending.data.deckChoice.id).data.assignments[0].targetId = ids.second;
  });
  check('allocation card tamper', (s) => { s.pending.data.deckChoice.assignments[0].instanceId = ids.chosen[1]; });
  check('foreign allocation target', (s) => { s.pending.data.deckChoice.assignments[0].targetId = s.players[1].active.id; });
  check('queued assigned replay', (s) => { s.queue.unshift({ op: 'effect-choice', data: copy(s.pending.data) }); });
  respond(g, f, [ids.second]); settleRestoring(g, f);
});

test('no-recipient remains a needsRuling engine boundary, not an imported official illegality/default inspection', async () => {
  const f = await make(generator(), (defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.types = ['Water'];
    defs.find((d) => d.definitionId === 'base').mechanics.attacks[0].effects =
      [binding('cn.attachDeckEnergy@1', generator(), 'unresolved-generator-attack')];
  });
  let ids;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); ids = setup(s); });
  const before = g.snapshot();
  const ctx = { state: before, definitions: Object.fromEntries(f.catalog.definitions().map((d) => [d.definitionId, d])),
    effectivePokemon: Object.fromEntries(g.view(0).players.flatMap((p) => [p.active, ...p.bench].filter(Boolean))
      .map((m) => [m.id, m.effective])),
    source: { owner: 0, pokemonId: null } };
  assert.equal(deckEnergyWindow(ctx, generator()).status, 'needsRuling');
  assert.equal(f.catalog.handler('cn.attachDeckEnergy@1').canUse(ctx, generator()), false);
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === ids.item));
  assert.throws(() => command(g, { type: 'attack', attackId: 'base:charge' }),
    (error) => error instanceof EngineError && error.code === 'unresolved-deck-energy-receiver');
  assert.deepEqual(g.snapshot(), before, 'Unsupported no-receiver semantics cannot inspect, shuffle or commit a guessed outcome.');
});
