// REAL OfficialGame integration, not the deck-window test-only host adapter.
// All definitions/printings below are synthetic specification fixtures. Giving
// one Rika-shaped parameters does not approve any actual printing or source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { validateInspectDeckParameters } from '../../public/rules/schema-validators.js';
import { randomIndex } from '../../public/rules/random.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, settle, hand, attached, fixtureClock,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const inspect = (extra = {}) => ({
  op: 'inspectDeck', lookTop: 4, selector: { kind: 'any' },
  quantity: { kind: 'exact', count: 2 }, revealSelected: false,
  remainder: { mode: 'shuffleToBottom' }, ...extra,
});
const cost = (count = 1, selector = { kind: 'energy' }) => ({
  costId: 'fee', kind: 'discardHand', count, selector, sourceOfTruth: EVIDENCE,
});
const ability = (effects, costs = []) => ({
  abilityId: 'inspect', name: '测试私有牌库窗口', mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: 'inspect', limit: 1 },
  effects, sourceOfTruth: EVIDENCE, ...(costs.length ? { costs } : {}),
});
async function make(spec = inspect(), { slot = 'ability', costs = [] } = {}) {
  return fixture((defs) => {
    const effects = [binding('cn.inspectDeck@1', spec)];
    if (slot === 'ability') defs[0].mechanics.abilities.push(ability(effects, costs));
    else if (slot === 'attack') defs[0].mechanics.attacks[0].effects = effects;
    else {
      const supporter = defs.find((d) => d.definitionId === 'research');
      supporter.mechanics.effects = effects;
      if (costs.length) supporter.mechanics.playCosts = costs;
    }
  });
}
function use(game, slot = 'ability') {
  const s = game.snapshot(), owner = s.current;
  if (slot === 'trainer') {
    const cardId = s.players[owner].hand.find((id) => s.cards[id].definitionId === 'research');
    return command(game, { type: 'playTrainer', cardId });
  }
  return command(game, slot === 'attack' ? { type: 'attack', attackId: 'base:strike' } :
    { type: 'useAbility', pokemonId: s.players[owner].active.id, abilityId: 'inspect' });
}
const restore = (snapshot, f) => OfficialGame.restore(clone(snapshot), { catalog: f.catalog });
const shuffles = (snapshot, from) => snapshot.events.slice(from).filter((e) => e.ruleId === 'effects.shuffle');
const searches = (snapshot, from) => snapshot.events.slice(from).filter((e) => e.ruleId === 'effects.search');
const cardIds = (cards) => cards.map((c) => c.instanceId);

// Preserve the hand (including a Trainer and fees) while constructing an exact
// top-first physical window. Use plentiful Water fixtures, not virtual new IDs.
function setDeck(s, owner, length) {
  const p = s.players[owner], protectedHand = p.hand.splice(0), top = [];
  p.resolving.push(...protectedHand);
  p.discard.push(...p.deck.splice(0));
  for (let i = 0; i < length; i++) {
    const id = hand(s, owner, 'water'); p.hand.pop(); p.resolving.push(id); top.push(id);
  }
  for (const id of [...protectedHand, ...top]) p.resolving.splice(p.resolving.indexOf(id), 1);
  p.hand.push(...protectedHand); p.deck.push(...[...top].reverse());
  return top;
}
function setHand(s, owner, names) {
  const p = s.players[owner], result = [];
  p.discard.push(...p.hand.splice(0));
  for (const name of names) {
    const id = hand(s, owner, name); p.hand.pop(); p.resolving.push(id); result.push(id);
  }
  for (const id of result) p.resolving.splice(p.resolving.indexOf(id), 1);
  p.hand.push(...result);
  return result;
}
function setup(f, length, { owner = 0, slot = 'ability', seed, mutate = () => {} } = {}) {
  let top;
  const game = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    if (slot === 'trainer') hand(s, owner, 'research');
    if (slot === 'attack') attached(s, owner, s.players[owner].active, 'water');
    mutate(s);
    top = setDeck(s, owner, length);
    if (seed) s.rng = [...seed];
  });
  return { game, top };
}

// Independent physical-order oracle: erase selected IDs, work in top-first
// order, and use real RNG primitives rather than the production subset helper.
function expectedResolution(top, selected, originalRng) {
  const remainder = top.slice(0, 4), rng = [...originalRng];
  for (const id of selected) {
    const at = remainder.indexOf(id); assert(at >= 0); remainder.splice(at, 1);
  }
  let n = remainder.length;
  while (n > 1) {
    const index = randomIndex(rng, n), last = --n;
    [remainder[last], remainder[index]] = [remainder[index], remainder[last]];
  }
  return { deck: [...top.slice(4), ...remainder].reverse(), rng, remainder };
}
function strings(value, out = new Set()) {
  if (typeof value === 'string') out.add(value);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) strings(child, out);
  return out;
}
function rejectAnswerAtomically(game, selected) {
  const before = game.snapshot();
  assert.throws(() => answer(game, selected));
  assert.deepEqual(game.snapshot(), before, 'invalid answers cannot consume RNG, move cards, log events or advance revision');
}

test('registered core handler accepts the entire strict Rika-shaped action, never a legacy search parameter wrapper', () => {
  const handler = createCoreHandlers().get('cn.inspectDeck@1'), spec = inspect();
  assert.deepEqual(handler.operations, ['inspectDeck']);
  assert.equal(handler.parameterSchemaRef, 'urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/inspectDeck');
  assert(validateInspectDeckParameters(spec)); assert(handler.validateParameters(spec));
  assert.deepEqual(handler.execute({}, spec), [spec]);
  for (const invalid of [{ action: spec }, { ...spec, op: 'cards' }, { ...spec, shuffleAfter: true },
    { ...spec, reveal: true }, { ...spec, approved: true }]) assert(!handler.validateParameters(invalid));
});

test('real Supporter inspects top four, forces two arbitrary cards, survives restore, and discards only after resolution', async () => {
  const f = await make(inspect(), { slot: 'trainer' });
  let { game: g, top } = setup(f, 7, { slot: 'trainer' });
  const before = g.snapshot(), trainer = before.players[0].hand.find((id) => before.cards[id].definitionId === 'research');
  use(g, 'trainer');
  let s = g.snapshot(), q = s.pending;
  assert.equal(q.kind, 'inspect-deck'); assert.equal(q.player, 0);
  assert.deepEqual(q.options, top.slice(0, 4));
  assert.equal(q.minimum, 2); assert.equal(q.maximum, 2); assert.equal(q.allowZero, false);
  assert.deepEqual(q.data.deckChoice.deck, before.players[0].deck);
  assert.deepEqual(q.data.deckChoice.window, top.slice(0, 4));
  assert.deepEqual(s.players[0].deck, before.players[0].deck, 'prompting never moves/removes window cards');
  assert.deepEqual(s.rng, before.rng);
  assert(s.players[0].flags.supporter); assert(s.players[0].resolving.includes(trainer));
  assert(!s.players[0].discard.includes(trainer));
  assert.deepEqual(cardIds(g.view(0).pending.lookedAt), top.slice(0, 4));
  assert.equal(g.view(1).pending, null);
  g = restore(s, f);
  rejectAnswerAtomically(g, []); rejectAnswerAtomically(g, [top[0]]);
  rejectAnswerAtomically(g, [top[0], top[4]]);
  const selected = [top[3], top[1]], expected = expectedResolution(top, selected, before.rng);
  answer(g, selected); settle(g); s = g.snapshot();
  assert.equal(s.pending, null); assert.equal(s.phase, 'main');
  assert.deepEqual(s.players[0].deck, expected.deck); assert.deepEqual(s.rng, expected.rng);
  assert.deepEqual(s.players[0].hand, before.players[0].hand.filter((id) => id !== trainer).concat(selected));
  assert(s.players[0].discard.includes(trainer)); assert(!s.players[0].resolving.includes(trainer));
  assert.deepEqual(restore(s, f).snapshot(), s);
});

for (const n of [0, 1, 2, 3]) {
  test(`Rika core Trainer on a ${n}-card deck: CN shortfall and empty-deck declaration eligibility`, async () => {
    const f = await make(inspect(), { slot: 'trainer' });
    let { game: g, top } = setup(f, n, { slot: 'trainer' });
    const before = g.snapshot();
    if (n === 0) {
      assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' &&
        before.cards[a.cardId].definitionId === 'research'));
      assert.throws(() => use(g, 'trainer'), /not legal/);
      assert.deepEqual(g.snapshot(), before); assert(!g.snapshot().players[0].flags.supporter);
      return;
    }
    use(g, 'trainer'); const q = g.snapshot().pending;
    assert.deepEqual(q.options, top); assert.equal(q.minimum, Math.min(2, n));
    assert.equal(q.maximum, Math.min(2, n)); assert.equal(q.allowZero, false);
    rejectAnswerAtomically(g, []);
    if (n > 1) rejectAnswerAtomically(g, [top[0]]);
    g = restore(g.snapshot(), f); answer(g, top.slice(0, Math.min(2, n))); settle(g);
    const after = g.snapshot();
    assert.deepEqual(after.players[0].deck, n === 3 ? [top[2]] : []);
    assert.deepEqual(after.rng, before.rng, 'empty/singleton remainder uses no random words');
    const events = shuffles(after, before.events.length);
    assert.equal(events.length, n === 3 ? 1 : 0);
    if (n === 3) assert.deepEqual({ subset: events[0].data.subset, count: events[0].data.count,
      placement: events[0].data.placement }, { subset: 'looked-remainder', count: 1, placement: 'bottom' });
    assert.equal(after.result, null, 'effect resolution of a short deck is not a turn-start deckout');
  });
}

test('empty-deck attack still runs the real inspect handler, has a restorable zero-choice window, and performs no shuffle', async () => {
  const f = await make(inspect(), { slot: 'attack' });
  let { game: g } = setup(f, 0, { slot: 'attack' });
  const before = g.snapshot(); use(g, 'attack');
  assert.equal(g.snapshot().pending.kind, 'inspect-deck');
  assert.deepEqual(g.snapshot().pending.options, []);
  assert.equal(g.snapshot().pending.minimum, 0); assert(g.snapshot().pending.allowZero);
  assert.deepEqual(g.view(0).pending.lookedAt, []); assert.equal(g.view(1).pending, null);
  g = restore(g.snapshot(), f); answer(g, []); settle(g);
  const after = g.snapshot();
  assert.deepEqual(after.players[0].deck, []); assert.deepEqual(after.rng, before.rng);
  assert.equal(shuffles(after, before.events.length).length, 0);
  const effect = after.events.slice(before.events.length).find((e) =>
    e.ruleId === 'effects.partial' && e.data.operation === 'inspectDeck');
  assert.equal(effect.data.performed, false); assert.equal(after.result, null);
});

for (const matching of [false, true]) {
  test(`specific hidden selector may select zero with ${matching ? 'present' : 'absent'} matches and still shuffles all window cards`, async () => {
    const spec = inspect({ selector: matching ? { kind: 'energy', category: 'basic', types: ['Water'] } : { kind: 'pokemon' } });
    const f = await make(spec);
    let { game: g, top } = setup(f, 6);
    const before = g.snapshot(); use(g);
    assert.equal(g.snapshot().pending.minimum, 0); assert(g.snapshot().pending.allowZero);
    assert.equal(g.snapshot().pending.options.length, matching ? 4 : 0);
    assert.deepEqual(cardIds(g.view(0).pending.lookedAt), top.slice(0, 4));
    assert.equal(g.view(1).pending, null);
    g = restore(g.snapshot(), f); answer(g, []); settle(g);
    const after = g.snapshot(), expected = expectedResolution(top, [], before.rng);
    assert.deepEqual(after.players[0].hand, before.players[0].hand);
    assert.deepEqual(after.players[0].deck, expected.deck); assert.deepEqual(after.rng, expected.rng);
    assert.notDeepEqual(after.rng, before.rng);
    assert.equal(shuffles(after, before.events.length).length, 1);
    assert.equal(shuffles(after, before.events.length)[0].data.count, 4);
  });
}

test('real RNG shuffles only unselected window cards: independent exact-order oracle, untouched lower segment and conservation', async () => {
  const f = await make(), orders = new Set();
  for (let seed = 1; seed <= 32; seed++) {
    const { game: g, top } = setup(f, 8, { seed: [seed, Math.imul(seed, 0x9e3779b9) >>> 0, seed * 3, seed * 5] });
    const before = g.snapshot(), selected = [top[3], top[0]], expected = expectedResolution(top, selected, before.rng);
    use(g); answer(g, selected); settle(g);
    const after = g.snapshot(), deckTop = [...after.players[0].deck].reverse();
    assert.deepEqual(after.players[0].deck, expected.deck); assert.deepEqual(after.rng, expected.rng);
    assert.deepEqual(deckTop.slice(0, 4), top.slice(4));
    assert.deepEqual(deckTop.slice(4), expected.remainder);
    orders.add(expected.remainder.indexOf(top[1]));
    assert.deepEqual(after.players[1], before.players[1]);
    assert.deepEqual(after.cards, before.cards);
    for (const id of top) assert.equal([...after.players[0].deck, ...after.players[0].hand]
      .reduce((count, found) => count + Number(found === id), 0), 1);
    const event = shuffles(after, before.events.length);
    assert.equal(event.length, 1);
    assert.deepEqual(Object.keys(event[0].data).sort(), ['count', 'effectId', 'placement', 'player', 'subset', 'zone']);
    assert.equal(event[0].data.count, 2); assert.equal(event[0].data.placement, 'bottom');
  }
  assert.equal(orders.size, 2, 'real seed variation reaches both legal permutations; identity is not rejected');
});

for (const owner of [0, 1]) for (const revealSelected of [false, true]) {
  test(`actor ${owner}, revealSelected=${revealSelected}: private prompt contains exactly the top-four window and options`, async () => {
    const f = await make(inspect({ revealSelected }));
    const { game: g, top } = setup(f, 7, { owner });
    const before = g.snapshot(), window = top.slice(0, 4);
    use(g);
    assert.deepEqual(cardIds(g.view(owner).pending.lookedAt), window);
    assert.deepEqual(cardIds(g.view(owner).pending.cards), window);
    assert.equal(g.view(1 - owner).pending, null);
    // Normal prompt/projection boundary only. Historical full-deck request
    // redaction/visibility has its dedicated deck-receipt-privacy test owner.
    for (const viewer of [0, 1]) {
      const view = g.view(viewer), disclosed = strings(view.pending);
      for (const id of top.slice(4)) assert(!disclosed.has(id), 'uninspected card entered the prompt');
      if (viewer !== owner) for (const id of window) assert(!disclosed.has(id), 'opponent received an inspected card');
      assert(!Object.hasOwn(view, 'rng')); assert(!Object.hasOwn(view, 'queue'));
      assert(!Object.hasOwn(view.players[owner], 'deck'));
    }
    assert.deepEqual(g.snapshot().players[owner].deck, before.players[owner].deck);
  });

  test(`actor ${owner}, revealSelected=${revealSelected}: resolved selection visibility and neither player sees new shuffle order`, async () => {
    const f = await make(inspect({ revealSelected }));
    const { game: g, top } = setup(f, 7, { owner });
    const before = g.snapshot(), selected = [top[0], top[2]], window = top.slice(0, 4);
    use(g);
    const prompted = g.snapshot();
    answer(g, selected); settle(g);
    const after = g.snapshot(), resolved = searches(after, before.events.length).find((e) => e.data.kind === 'resolved');
    assert.deepEqual(cardIds(resolved.data.revealed ?? []), revealSelected ? selected : []);
    const remainder = window.filter((id) => !selected.includes(id));
    for (const viewer of [0, 1]) {
      const view = g.view(viewer);
      // Filter using the known pre-answer visible-event count, not reference
      // identity: views intentionally clone their records.
      const visibleBefore = prompted.events.filter((e) => e.visibility === 'public' || e.visibility === viewer).length;
      const tail = view.events.slice(visibleBefore);
      const leaked = strings({ pending: view.pending, events: tail });
      for (const id of remainder) assert(!leaked.has(id), 'shuffle result must not publish remainder identities/order');
      assert.equal(view.pending, null);
      assert(!Object.hasOwn(view, 'rng'));
      const publicSelection = strings(tail);
      if (viewer !== owner) for (const id of selected) assert.equal(publicSelection.has(id), revealSelected);
      if (viewer === owner) assert(selected.every((id) => cardIds(view.players[owner].hand).includes(id)));
    }
    assert.deepEqual(restore(after, f).snapshot(), after);
  });
}

test('pending selection restores exactly, then rejects isolated window/deck/source/turn/request/prompt tampering and queued replay', async (t) => {
  const f = await make();
  const { game: g, top } = setup(f, 7);
  use(g); const saved = g.snapshot();
  assert.deepEqual(restore(saved, f).snapshot(), saved);
  const receipt = (s) => s.events.find((e) => e.ruleId === 'effects.search' &&
    e.data.kind === 'requested' && e.data.id === s.pending.data.deckChoice.id);
  const mutations = [
    ['window omitted card', (s) => { s.pending.data.deckChoice.window.pop(); }],
    ['window reordered', (s) => { s.pending.data.deckChoice.window.reverse(); }],
    ['window contains fifth card', (s) => { s.pending.data.deckChoice.window[0] = top[4]; }],
    ['window and request jointly reordered but live deck unchanged', (s) => {
      s.pending.data.deckChoice.window.reverse(); receipt(s).data.window.reverse();
    }],
    ['original deck receipt changed', (s) => { s.pending.data.deckChoice.deck.reverse(); }],
    ['live unseen cards reordered', (s) => {
      const d = s.players[0].deck; [d[0], d[1]] = [d[1], d[0]];
    }],
    ['live deck and claimed original changed without original request', (s) => {
      const d = s.players[0].deck; [d[0], d[1]] = [d[1], d[0]];
      s.pending.data.deckChoice.deck = [...d];
    }],
    ['source owner', (s) => { s.pending.data.source.owner = 1; }],
    ['source physical identity', (s) => { s.pending.data.source.instanceId = s.players[1].active.stack.at(-1); }],
    ['source effect binding', (s) => { s.pending.data.source.effectId = 'fixture:cn.draw@1'; }],
    ['source origin', (s) => { s.pending.data.source.origin = 'hand'; }],
    ['request source changed', (s) => { receipt(s).data.source.effectId = 'not-original'; }],
    ['choice turn', (s) => { s.pending.data.deckChoice.turn++; }],
    ['request turn', (s) => { receipt(s).data.turn++; }],
    ['missing original request', (s) => { s.events.splice(s.events.indexOf(receipt(s)), 1); }],
    ['duplicate original request', (s) => { s.events.push(clone(receipt(s))); }],
    ['request action', (s) => { receipt(s).data.action.lookTop++; }],
    ['current action', (s) => { s.pending.data.action.lookTop++; }],
    ['CN minimum', (s) => { s.pending.minimum = 0; }],
    ['CN maximum', (s) => { s.pending.maximum = 3; }],
    ['CN allowZero', (s) => { s.pending.allowZero = true; }],
    ['missing option', (s) => { s.pending.options.pop(); }],
    ['reordered options', (s) => { s.pending.options.reverse(); }],
    ['fifth-card option', (s) => { s.pending.options[0] = top[4]; }],
    ['duplicate options', (s) => { s.pending.options[1] = s.pending.options[0]; }],
    ['foreign prompt player', (s) => { s.pending.player = 1; }],
    ['foreign prompt kind', (s) => { s.pending.kind = 'select-cards'; }],
    ['foreign prompt ruleId', (s) => { s.pending.ruleId = 'effects.shuffle'; }],
    ['missing deckChoice', (s) => { delete s.pending.data.deckChoice; }],
    ['missing deckChoice and stage', (s) => { delete s.pending.data.deckChoice; delete s.pending.data.stage; }],
    ['subject-local deck prompt', (s) => { s.pending.data.local = true; }],
    ['preselected pending answer', (s) => { s.pending.data.selected = top.slice(0, 2); }],
    ['preselected receipt cards', (s) => { s.pending.data.deckChoice.chosen = top.slice(0, 2); }],
    ['already resolved request replay', (s) => { s.events.push({ ruleId: 'effects.search', visibility: 'public',
      data: { kind: 'resolved', id: s.pending.data.deckChoice.id } }); }],
    ['replayed queued private work', (s) => { s.queue.unshift({ op: 'effect-choice', data: clone(s.pending.data) }); }],
    ['replayed queue replacing prompt', (s) => {
      s.queue.unshift({ op: 'effect-choice', data: clone(s.pending.data) }); s.pending = null;
    }],
    ['unstarted subject-local queued work', (s) => {
      const data = clone(s.pending.data); delete data.deckChoice; delete data.stage; data.local = true;
      s.queue.unshift({ op: 'effect-choice', data });
    }],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, () => {
      const broken = clone(saved); mutate(broken);
      assert.throws(() => restore(broken, f), undefined, label);
      assert.deepEqual(g.snapshot(), saved, `failed restore is isolated: ${label}`);
    });
  }
  const resumed = restore(saved, f);
  answer(resumed, [top[2], top[0]]); settle(resumed);
  assert.deepEqual(resumed.snapshot().players[0].hand.slice(-2), [top[2], top[0]]);
});

test('invalid answer, foreign actor, stale revision and stale request are fully atomic; valid answer remains usable afterward', async () => {
  const f = await make(), { game: g, top } = setup(f, 6);
  use(g); const saved = g.snapshot();
  for (const selected of [[], [top[0]], top.slice(0, 3), [top[0], top[0]], [top[0], top[4]],
    [top[0], saved.players[1].deck[0]], ['missing-instance', top[0]]]) rejectAnswerAtomically(g, selected);
  const q = saved.pending;
  for (const c of [
    { player: 1, expectedRevision: saved.revision, action: { type: 'answer', requestId: q.id, selected: top.slice(0, 2) } },
    { player: 0, expectedRevision: saved.revision - 1, action: { type: 'answer', requestId: q.id, selected: top.slice(0, 2) } },
    { player: 0, expectedRevision: saved.revision, action: { type: 'answer', requestId: `${q.id}-stale`, selected: top.slice(0, 2) } },
  ]) {
    assert.throws(() => g.dispatch(c)); assert.deepEqual(g.snapshot(), saved);
  }
  answer(g, [top[1], top[3]]); settle(g);
  const resolved = g.snapshot();
  assert.throws(() => command(g, { type: 'answer', requestId: q.id, selected: [top[1], top[3]] }));
  assert.deepEqual(g.snapshot(), resolved);
});

test('then observes actual execution: selected cards OR singleton shuffle succeed; empty window does not unlock then', async () => {
  for (const spec of [inspect(), inspect({ selector: { kind: 'pokemon' } })]) {
    const program = [{
      op: 'then', first: spec, next: { op: 'counters', count: 1, side: 'own', target: 'active' },
    }, { op: 'counters', count: 2, side: 'opponent', target: 'active' }];
    const wrapper = {
      rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['then', 'inspectDeck', 'counters'],
      validateParameters: (p) => Object.keys(p).length === 0, canUse: () => true, execute: () => clone(program),
    };
    const f = await fixture((defs) => defs[0].mechanics.abilities.push(
      ability([binding('fixture:inspect-then', {})])), new Map([['fixture:inspect-then', wrapper]]));
    for (const n of [0, 1, 2, 3, 4]) {
      let { game: g, top } = setup(f, n);
      const before = g.snapshot(); use(g);
      const selected = spec.selector.kind === 'any' ? top.slice(0, Math.min(2, n)) : [];
      g = restore(g.snapshot(), f); answer(g, selected); settle(g);
      const after = g.snapshot(), didExecute = n > 0, remainderCount = n - selected.length;
      assert.equal(after.players[0].active.counters, didExecute ? 1 : 0);
      assert.equal(after.players[1].active.counters, 2, 'independent subsequent text always runs');
      assert.equal(shuffles(after, before.events.length).length, remainderCount > 0 ? 1 : 0);
      const execution = after.events.slice(before.events.length).find((e) =>
        e.ruleId === 'effects.partial' && e.data.operation === 'inspectDeck');
      assert.equal(execution.data.performed, didExecute);
      if (remainderCount < 2) assert.deepEqual(after.rng, before.rng);
    }
  }
});

test('activation cost eligibility cannot pay just to inspect an empty deck, nor spend the resolving Supporter as its own cost', async () => {
  const f = await make(inspect(), { slot: 'trainer', costs: [cost(2, { kind: 'any' })] });
  for (const mode of ['short-payment', 'empty-deck']) {
    const { game: g } = setup(f, mode === 'empty-deck' ? 0 : 5, { slot: 'trainer',
      mutate: (s) => setHand(s, 0, mode === 'short-payment' ? ['research', 'water'] : ['research', 'water', 'water']) });
    const before = g.snapshot();
    assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && before.cards[a.cardId].definitionId === 'research'));
    assert.throws(() => use(g, 'trainer'), /not legal/);
    assert.deepEqual(g.snapshot(), before); assert(!g.snapshot().players[0].flags.supporter);
  }
});

test('complete cost payment precedes inspection, survives both restores, and failed payment/selection never pays twice', async () => {
  const f = await make(inspect(), { slot: 'trainer', costs: [cost(2)] });
  let ids;
  let { game: g, top } = setup(f, 6, { slot: 'trainer', mutate: (s) => { ids = setHand(s, 0, ['research', 'water', 'water']); } });
  const before = g.snapshot(); use(g, 'trainer');
  const unpaid = g.snapshot();
  assert.equal(unpaid.pending.kind, 'activation-cost');
  assert(!unpaid.players[0].flags.supporter); assert(unpaid.players[0].hand.includes(ids[0]));
  assert.equal(g.view(1).pending, null); assert.equal(g.view(0).pending.lookedAt, undefined);
  assert(!unpaid.pending.options.includes(paymentOptionId('fee', ids[0])));
  rejectAnswerAtomically(g, []);
  rejectAnswerAtomically(g, [paymentOptionId('fee', ids[1])]);
  rejectAnswerAtomically(g, [paymentOptionId('fee', ids[1]), paymentOptionId('fee', ids[1])]);
  g = restore(unpaid, f); answer(g, ids.slice(1).map((id) => paymentOptionId('fee', id)));
  const paid = g.snapshot();
  assert.equal(paid.pending.kind, 'inspect-deck'); assert(paid.players[0].flags.supporter);
  assert(paid.players[0].resolving.includes(ids[0]));
  for (const id of ids.slice(1)) assert(paid.players[0].discard.includes(id));
  assert.equal(paid.events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
  assert.deepEqual(paid.pending.data.deckChoice.deck, before.players[0].deck);
  assert.deepEqual(paid.rng, before.rng);
  rejectAnswerAtomically(g, []);
  assert.deepEqual(g.snapshot(), paid);
  g = restore(paid, f); answer(g, [top[3], top[0]]); settle(g);
  const after = g.snapshot();
  assert.equal(after.events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
  for (const id of ids) assert.equal(after.players[0].discard.filter((card) => card === id).length, 1);
  assert.deepEqual(after.players[0].hand, [top[3], top[0]]);
  assert.deepEqual(restore(after, f).snapshot(), after);
});

test('paid Ability is not eligible without a fee, records exactly one use, and keeps its fee out of the inspected window', async () => {
  const f = await make(inspect(), { costs: [cost()] });
  for (const payable of [false, true]) {
    let fee;
    let { game: g, top } = setup(f, 5, { mutate: (s) => {
      fee = setHand(s, 0, payable ? ['water'] : [])[0];
    } });
    const before = g.snapshot();
    if (!payable) {
      assert(!g.view(0).legalActions.some((a) => a.abilityId === 'inspect'));
      assert.throws(() => use(g), /not legal/); assert.deepEqual(g.snapshot(), before); continue;
    }
    use(g); assert.equal(g.snapshot().pending.kind, 'activation-cost');
    assert.equal(g.snapshot().players[0].active.used.inspect, undefined);
    g = restore(g.snapshot(), f); answer(g, [paymentOptionId('fee', fee)]);
    assert.equal(g.snapshot().pending.kind, 'inspect-deck');
    assert(!g.snapshot().pending.options.includes(fee));
    assert.deepEqual(g.snapshot().pending.options, top.slice(0, 4));
    g = restore(g.snapshot(), f); answer(g, [top[0], top[1]]); settle(g);
    const after = g.snapshot();
    assert.equal(after.players[0].active.used.inspect.length, 1);
    assert.equal(after.players[0].discard.filter((id) => id === fee).length, 1);
    assert(!g.view(0).legalActions.some((a) => a.abilityId === 'inspect'));
  }
});
