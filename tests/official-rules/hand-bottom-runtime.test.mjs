// Real OfficialGame execution using synthetic definitions only. Marnie/Greedent
// shaped instructions below are not approvals of any actual card or printing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { randomIndex } from '../../public/rules/random.js';
import { fixture, fixtureClock, binding, EVIDENCE, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const marnie = () => ({ side: 'both', ownDraw: 5, opponentDraw: 4 });
const greedent = () => ({ side: 'own', ownDraw: 1, opponentDraw: 0 });
const bottomDraw = (p, id = 'bottom-draw') => binding('cn.handBottomDraw@1', p, id);
const bottomOnly = (side, id = side) => binding('cn.shuffleHandToBottom@1', { side }, `bottom-${id}`);
const cost = () => ({
  costId: 'fee', kind: 'discardHand', count: 1, selector: { kind: 'energy', category: 'basic' }, sourceOfTruth: EVIDENCE,
});
const ability = (id, effects, extra = {}) => ({
  abilityId: id, name: `测试手牌洗底${id}`, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: id, limit: 1 },
  effects, sourceOfTruth: EVIDENCE, ...extra,
});
async function make(extend = () => {}, handlers = new Map()) {
  return fixture((defs) => {
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [bottomDraw(marnie(), 'marnie')];
    defs[0].mechanics.abilities = [ability('greedent', [bottomDraw(greedent(), 'greedent')])];
    extend(defs);
  }, handlers);
}

// Fetch all requested physical cards into escrow before rebuilding hand. A
// repeated definition must not accidentally fetch the same hand card twice.
function setHand(s, owner, definitions) {
  const p = s.players[owner], ids = [];
  p.discard.push(...p.hand.splice(0));
  for (const definitionId of definitions) {
    const id = hand(s, owner, definitionId);
    p.hand.splice(p.hand.indexOf(id), 1); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) { p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id); }
  return ids;
}
function putTop(s, owner, definitionId) {
  const id = hand(s, owner, definitionId), p = s.players[owner];
  p.hand.splice(p.hand.indexOf(id), 1); p.deck.push(id); return id;
}
function otherActive(s, owner) {
  const p = s.players[owner], old = p.active;
  p.hand.push(...old.stack, ...old.energy, ...old.tools);
  p.active = bench(s, owner, 'other'); p.bench.pop();
}
function conservation(s, originalCards) {
  assert.deepEqual(s.cards, originalCards, 'Moving a card cannot rewrite its identity, definition, printing or physical owner.');
  const total = [];
  for (const owner of [0, 1]) {
    const p = s.players[owner];
    const ids = ['deck', 'hand', 'discard', 'lost', 'prizes', 'resolving'].flatMap((zone) => p[zone]);
    ids.push(...[p.active, ...p.bench].filter(Boolean).flatMap((m) => [...m.stack, ...m.energy, ...m.tools]));
    if (s.stadium && s.cards[s.stadium].owner === owner) ids.push(s.stadium);
    assert.equal(ids.length, 60); assert.equal(new Set(ids).size, 60);
    assert.deepEqual(new Set(ids), new Set(Object.keys(originalCards).filter((id) => originalCards[id].owner === owner)));
    total.push(...ids);
  }
  assert.equal(new Set(total).size, 120);
}

// Independent subset-shuffle oracle. Do NOT call hand-bottom planning,
// shuffleIds, handler execution or a runtime receipt to derive expectations.
function expected(before, sourceOwner, parameters, excluded = []) {
  const rng = [...before.rng], hands = before.players.map((p) => p.hand.filter((id) => !excluded.includes(id)));
  const decks = before.players.map((p) => [...p.deck]);
  const owners = parameters.side === 'both' ? [sourceOwner, 1 - sourceOwner] :
    [parameters.side === 'own' ? sourceOwner : 1 - sourceOwner];
  const windows = owners.map((owner) => ({ owner, hand: [...hands[owner]], oldDeck: [...decks[owner]] }));
  for (const { owner, hand: subset, oldDeck } of windows) {
    const shuffled = [...subset];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = randomIndex(rng, i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    hands[owner] = []; decks[owner] = [...shuffled, ...oldDeck];
  }
  const performed = windows.some((w) => w.hand.length > 0);
  const drawn = [[], []];
  if (performed) for (const [owner, count] of [[sourceOwner, parameters.ownDraw ?? 0], [1 - sourceOwner, parameters.opponentDraw ?? 0]]) {
    for (let i = 0; i < count && decks[owner].length; i++) {
      const id = decks[owner].pop(); hands[owner].push(id); drawn[owner].push(id);
    }
  }
  return { rng, hands, decks, drawn, windows, performed };
}
function assertOutcome(g, before, oracle) {
  const s = g.snapshot();
  assert.deepEqual(s.rng, oracle.rng);
  for (const owner of [0, 1]) {
    assert.deepEqual(s.players[owner].deck, oracle.decks[owner]);
    assert.deepEqual(s.players[owner].hand, oracle.hands[owner]);
  }
  assert.equal(s.result, null);
  conservation(s, before.cards);
}
const bottomLogs = (s, from) => s.events.slice(from).filter((e) => e.ruleId === 'effects.hand-bottom');
function assertPrivateShuffle(g, before, oracle) {
  const records = bottomLogs(g.snapshot(), before.events.length);
  assert.deepEqual(records.filter((e) => e.data.count > 0).map((e) => [e.data.player, e.data.count]),
    oracle.windows.filter((w) => w.hand.length).map((w) => [w.owner, w.hand.length]));
  for (const e of records) {
    assert.equal(e.visibility, 'public');
    assert.deepEqual(Object.keys(e.data).sort(), ['count', 'effectId', 'player']);
  }
  const shuffles = g.snapshot().events.slice(before.events.length).filter((e) => e.ruleId === 'effects.shuffle');
  assert.deepEqual(shuffles.map((e) => [e.data.player, e.data.count]), records.map((e) => [e.data.player, e.data.count]));
  for (const e of shuffles) {
    assert.equal(e.visibility, 'public'); assert.equal(e.data.zone, 'hand'); assert.equal(e.data.placement, 'deck-bottom');
    assert.deepEqual(Object.keys(e.data).sort(), ['count', 'effectId', 'placement', 'player', 'zone']);
  }
  for (const viewer of [0, 1]) {
    const view = g.view(viewer);
    assert.deepEqual(bottomLogs(view, 0).slice(bottomLogs(before, 0).length), records);
    for (const p of view.players) {
      assert.equal(Object.hasOwn(p, 'deck'), false);
      assert.equal(Object.hasOwn(p, 'shuffledHand'), false);
    }
    const work = [view];
    while (work.length) {
      const value = work.pop();
      if (!value || typeof value !== 'object') continue;
      for (const [key, child] of Object.entries(value)) {
        assert(!['rng', 'rngBefore', 'rngAfter', 'shuffledBottomFirst', 'shuffledHandBottomFirst', 'deckOrder'].includes(key),
          `Player view leaked ${key}.`);
        work.push(child);
      }
    }
  }
}
function restore(g, f) {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  for (const viewer of [0, 1]) assert.deepEqual(r.view(viewer), g.view(viewer));
  return r;
}
function respond(g, f, selected) {
  const r = restore(g, f); answer(g, selected); answer(r, selected);
  assert.deepEqual(r.snapshot(), g.snapshot(), 'Restore cannot re-shuffle, re-pay, re-use, duplicate or skip a pending draw.');
}
function atomic(g, run) {
  const before = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(run, (e) => e instanceof EngineError);
  assert.deepEqual(g.snapshot(), before, 'Illegal use/answer cannot move cards, consume RNG or a once/Supporter use, or change revision.');
  assert.deepEqual([g.view(0), g.view(1)], views);
  conservation(g.snapshot(), before.cards);
}
const usable = (g, id, owner = g.snapshot().current) => g.view(owner).legalActions.find((a) =>
  a.type === 'useAbility' && a.abilityId === id && a.pokemonId === g.snapshot().players[owner].active.id);
function use(g, id = 'greedent', owner = g.snapshot().current) {
  command(g, { type: 'useAbility', abilityId: id, pokemonId: g.snapshot().players[owner].active.id }, owner);
}
const trainerAction = (g, id, owner = g.snapshot().current) => g.view(owner).legalActions.find((a) =>
  a.type === 'playTrainer' && a.cardId === id);
const play = (g, id, owner = g.snapshot().current) => command(g, { type: 'playTrainer', cardId: id }, owner);
function incoming(defs) {
  defs.find((d) => d.definitionId === 'poison').mechanics.effects = [{
    ...binding('cn.draw@1', { count: 1 }, 'incoming'),
    trigger: { event: 'beforeHand', origin: 'draw', turn: 'either', drawReason: 'effect', optional: true, afterUse: 'hand' },
  }];
}

for (const owner of [0, 1]) test(`Marnie-shaped Source${owner} shuffles both hands separately, preserves old-deck order and draws own5/opponent4`, async () => {
  const f = await make();
  let source;
  const g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    source = setHand(s, owner, ['research', 'water', 'double', 'potion'])[0];
    setHand(s, 1 - owner, ['water', 'other', 'tool', 'water']);
  }), before = g.snapshot(), oracle = expected(before, owner, marnie(), [source]);
  assert(trainerAction(g, source, owner)); play(g, source, owner); settle(g);
  assertOutcome(g, before, oracle); assertPrivateShuffle(g, before, oracle);
  assert.equal(g.snapshot().players[owner].hand.length, 5);
  assert.equal(g.snapshot().players[1 - owner].hand.length, 4);
  assert(g.snapshot().players[owner].discard.includes(source));
  assert(!g.snapshot().players[owner].deck.includes(source));
  assert.equal(g.snapshot().players[owner].flags.supporter, true);
  assert.equal(g.snapshot().players[1 - owner].flags.supporter, false);
  restore(g, f);
});

test('Greedent-shaped own1/opponent0 returns the whole hand to bottom, leaves the other player untouched and consumes one use', async () => {
  const f = await make();
  const g = board(f, (s) => {
    setHand(s, 0, ['water', 'potion', 'double']); setHand(s, 1, ['other', 'tool']);
  }), before = g.snapshot(), oracle = expected(before, 0, greedent());
  assert(usable(g, 'greedent')); use(g); settle(g);
  assertOutcome(g, before, oracle); assertPrivateShuffle(g, before, oracle);
  assert.equal(g.snapshot().players[0].hand.length, 1);
  assert.equal(g.snapshot().players[0].active.used.greedent.length, 1);
  assert(!usable(g, 'greedent'));
  assert.deepEqual(g.snapshot().players[1], before.players[1]);
  restore(g, f);
});

test('bare own/opponent shuffles serialize independent subsets; an empty requested hand is unusable and a singleton consumes no RNG', async () => {
  const f = await make((defs) => {
    defs[0].mechanics.abilities = [
      ability('own-bottom', [bottomOnly('own')]), ability('opponent-bottom', [bottomOnly('opponent')]),
    ];
  });
  for (const count of [0, 1]) {
    const g = board(f, (s) => {
      setHand(s, 0, ['water', 'double', 'potion']); setHand(s, 1, count ? ['other'] : []);
    }), before = g.snapshot();
    assert.equal(!!usable(g, 'opponent-bottom'), count === 1);
    if (!count) atomic(g, () => use(g, 'opponent-bottom'));
    const first = expected(before, 0, { side: 'own' });
    use(g, 'own-bottom'); settle(g);
    assertOutcome(g, before, first);
    const middle = g.snapshot(), second = expected(middle, 0, { side: 'opponent' });
    if (count) {
      const resumed = restore(g, f); use(resumed, 'opponent-bottom'); settle(resumed);
      assertOutcome(resumed, middle, second);
      assert.deepEqual(resumed.snapshot().rng, middle.rng, 'A one-card shuffle is performed without a random draw.');
      assert.equal(resumed.snapshot().players[0].active.used['opponent-bottom'].length, 1);
      assertPrivateShuffle(resumed, middle, second);
    } else assert.equal(g.snapshot().players[0].active.used['opponent-bottom'], undefined);
  }
});

test('E-19 FAQ2: a last-card Marnie cannot be played when both hands would be empty; an empty-hand Ability cannot declare merely to draw', async () => {
  const f = await make();
  let source;
  const g = board(f, (s) => { source = setHand(s, 0, ['research'])[0]; setHand(s, 1, []); }), before = g.snapshot();
  assert(before.players.every((p) => p.deck.length > 0));
  assert(!trainerAction(g, source)); atomic(g, () => play(g, source));
  assert.equal(g.snapshot().players[0].flags.supporter, false);
  assert(g.snapshot().players[0].hand.includes(source));
  const empty = board(f, (s) => { setHand(s, 0, []); setHand(s, 1, []); });
  assert(!usable(empty, 'greedent')); atomic(empty, () => use(empty));
  assert.equal(empty.snapshot().players[0].active.used.greedent, undefined);
  assert.equal(bottomLogs(empty.snapshot(), 0).length, 0);
});

test('one actual remaining card on either side unlocks the complete both-player then, including drawing for the empty side', async () => {
  const f = await make();
  for (const populated of [0, 1]) {
    let source;
    const g = board(f, (s) => {
      source = setHand(s, 0, populated === 0 ? ['research', 'water'] : ['research'])[0];
      setHand(s, 1, populated === 1 ? ['other'] : []);
    }), before = g.snapshot(), oracle = expected(before, 0, marnie(), [source]);
    assert(trainerAction(g, source)); play(g, source); settle(g);
    assertOutcome(g, before, oracle);
    assert.deepEqual(g.snapshot().rng, before.rng);
    assert.equal(g.snapshot().players[0].hand.length, 5);
    assert.equal(g.snapshot().players[1].hand.length, 4);
    assertPrivateShuffle(g, before, oracle);
  }
});

test('post-cost proof rejects fee-only Trainer and Ability uses before discarding, consuming Supporter/once, or sampling RNG', async () => {
  for (const kind of ['trainer', 'ability']) {
    const f = await make((defs) => {
      if (kind === 'trainer') defs.find((d) => d.definitionId === 'research').mechanics.playCosts = [cost()];
      else defs[0].mechanics.abilities = [ability('paid-bottom', [bottomDraw(greedent())], { costs: [cost()] })];
    });
    let ids;
    const g = board(f, (s) => {
      ids = setHand(s, 0, kind === 'trainer' ? ['research', 'water'] : ['water']); setHand(s, 1, []);
    });
    if (kind === 'trainer') {
      assert(!trainerAction(g, ids[0])); atomic(g, () => play(g, ids[0]));
    } else {
      assert(!usable(g, 'paid-bottom')); atomic(g, () => use(g, 'paid-bottom'));
      assert.equal(g.snapshot().players[0].active.used['paid-bottom'], undefined);
    }
    assert.equal(g.snapshot().players[0].flags.supporter, false);
    assert.deepEqual(g.snapshot().players[0].hand, ids);
    assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.activation-cost'));
  }
});

test('valid paid uses reserve the Trainer, reject invalid payment atomically, and never put the paid physical card into the deck', async () => {
  for (const kind of ['trainer', 'ability']) {
    const params = kind === 'trainer' ? marnie() : greedent();
    const f = await make((defs) => {
      if (kind === 'trainer') defs.find((d) => d.definitionId === 'research').mechanics.playCosts = [cost()];
      else defs[0].mechanics.abilities = [ability('paid-bottom', [bottomDraw(params)], { costs: [cost()] })];
    });
    let ids;
    const g = board(f, (s) => {
      ids = setHand(s, 0, kind === 'trainer' ? ['research', 'water', 'potion'] : ['water', 'potion']); setHand(s, 1, []);
    }), before = g.snapshot(), source = kind === 'trainer' ? ids[0] : null;
    const fee = kind === 'trainer' ? ids[1] : ids[0], residual = ids.at(-1);
    const oracle = expected(before, 0, params, [fee, ...(source ? [source] : [])]);
    if (source) play(g, source); else use(g, 'paid-bottom');
    assert.equal(g.snapshot().pending.kind, 'activation-cost');
    assert.equal(g.view(1).pending, null);
    assert.equal(g.snapshot().players[0].flags.supporter, false);
    assert.equal(g.snapshot().players[0].active.used['paid-bottom'], undefined);
    atomic(g, () => answer(g, []));
    atomic(g, () => answer(g, [paymentOptionId('fee', residual)]));
    atomic(g, () => answer(g, [paymentOptionId('fee', fee), paymentOptionId('fee', fee)]));
    if (source) atomic(g, () => answer(g, [paymentOptionId('fee', source)]));
    respond(g, f, [paymentOptionId('fee', fee)]); settle(g);
    assertOutcome(g, before, oracle); assertPrivateShuffle(g, before, oracle);
    assert(g.snapshot().players[0].discard.includes(fee));
    assert(!g.snapshot().players[0].deck.includes(fee)); assert(!g.snapshot().players[0].hand.includes(fee));
    assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
    if (source) {
      assert(g.snapshot().players[0].discard.includes(source));
      assert.equal(g.snapshot().players[0].flags.supporter, true);
    } else assert.equal(g.snapshot().players[0].active.used['paid-bottom'].length, 1);
    restore(g, f);
  }
});

test('E-31 pause after both hands were bottomed restores remaining draws without reshuffling, duplication, or exposing bottom order', async () => {
  const f = await make(incoming);
  let source, incomingCard;
  const g = board(f, (s) => {
    source = setHand(s, 0, ['research', 'water', 'double', 'tool'])[0];
    setHand(s, 1, ['water', 'other', 'potion']); incomingCard = putTop(s, 0, 'poison');
  }), before = g.snapshot(), oracle = expected(before, 0, marnie(), [source]);
  play(g, source);
  const paused = g.snapshot();
  assert.equal(paused.pending.kind, 'before-hand-optional'); assert.equal(paused.pending.player, 0);
  assert.equal(paused.current, 0); assert.equal(paused.phase, 'resolving');
  assert.equal(paused.players[0].hand.length, 0); assert.equal(paused.players[1].hand.length, 0);
  assert(paused.players[0].resolving.includes(incomingCard));
  assert.deepEqual(paused.rng, oracle.rng);
  assert.equal(g.view(0).pending.acquisition.card.instanceId, incomingCard); assert.equal(g.view(1).pending, null);
  conservation(paused, before.cards); assertPrivateShuffle(g, before, oracle);
  atomic(g, () => answer(g, ['heads']));
  let resumed = g;
  for (let i = 0; i < 3; i++) resumed = restore(resumed, f);
  respond(g, f, ['skip']); answer(resumed, ['skip']);
  // The other deck may also draw its physical copy of this fixture. Decline
  // every optional incoming effect, not settle()'s default first/"perform".
  for (let i = 0; g.snapshot().pending; i++) {
    assert(i < 10, 'Fixture-choice guard, not an engine draw limit.');
    assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
    respond(g, f, ['skip']); answer(resumed, ['skip']);
  }
  settle(g); settle(resumed);
  assert.deepEqual(resumed.snapshot(), g.snapshot());
  assertOutcome(g, before, oracle); assertPrivateShuffle(g, before, oracle);
  assert.equal(bottomLogs(g.snapshot(), before.events.length).filter((e) => e.data.count > 0).length, 2);
  assert.equal(g.snapshot().players[0].hand.filter((id) => id === incomingCard).length, 1);
  restore(g, f);
});

test('short effect draws stop at available cards, even with two initially empty decks, without declaring deckout', async () => {
  const f = await make();
  let source;
  const g = board(f, (s) => {
    source = setHand(s, 0, ['research'])[0]; setHand(s, 1, ['water']);
    for (const p of s.players) p.discard.push(...p.deck.splice(0));
  }), before = g.snapshot(), oracle = expected(before, 0, marnie(), [source]);
  assert(trainerAction(g, source)); play(g, source); settle(g);
  assertOutcome(g, before, oracle);
  assert.equal(g.snapshot().players[0].hand.length, 0); assert.equal(g.snapshot().players[1].hand.length, 1);
  assert.equal(g.snapshot().players[0].deck.length, 0); assert.equal(g.snapshot().players[1].deck.length, 0);
  assert.equal(g.snapshot().phase, 'main'); assert.equal(g.snapshot().current, 0);
  assert.deepEqual(g.snapshot().rng, before.rng);
  assertPrivateShuffle(g, before, oracle);
  restore(g, f);
});

test('a shared Stadium uses the actual activator’s own hand/draw, not the physical card holder’s hand', async () => {
  const core = createCoreHandlers().get('cn.handBottomDraw@1'); assert(core);
  const h = { ...core, timing: 'onUse', usage: { period: 'turn', scope: 'player', key: 'shared-bottom', limit: 1 } };
  const f = await make((defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
      binding('fixture:shared-bottom', greedent(), 'shared-bottom'),
    ];
  }, new Map([['fixture:shared-bottom', h]]));
  let source;
  const g = board(f, (s) => {
    setHand(s, 0, ['water', 'double', 'potion']); setHand(s, 1, ['other', 'tool']);
    source = hand(s, 1, 'stadium'); s.players[1].hand.splice(s.players[1].hand.indexOf(source), 1); s.stadium = source;
  }), before = g.snapshot(), oracle = expected(before, 0, greedent());
  assert.equal(before.cards[source].owner, 1);
  command(g, { type: 'useStadium' }); settle(g);
  assertOutcome(g, before, oracle); assertPrivateShuffle(g, before, oracle);
  const event = bottomLogs(g.snapshot(), before.events.length).find((e) => e.data.count > 0);
  assert.equal(event.data.player, 0); assert.equal(event.data.effectId, 'fixture:shared-bottom');
  assert.equal(g.snapshot().players[0].used['shared-bottom'].length, 1);
  assert.equal(g.snapshot().players[1].used['shared-bottom'], undefined);
  restore(g, f);
});

test('an opponent-turn trigger resolves own relative to source.owner, not current, and resumes its effect draw before turn-start draw', async () => {
  const f = await make((defs) => {
    incoming(defs);
    defs[1].mechanics.abilities = [ability('other-turn-bottom', [bottomDraw(greedent(), 'other-turn-bottom')], {
      mode: 'triggered', usage: null,
      trigger: { event: 'turnEnd', subject: 'self', endingPlayer: 'opponent', optional: false, choiceOwner: 'source', scope: 'global' },
    })];
  });
  let incomingCard;
  const g = board(f, (s) => {
    otherActive(s, 1); setHand(s, 0, ['water', 'potion']); setHand(s, 1, ['water', 'double', 'tool']);
    incomingCard = putTop(s, 1, 'poison');
  }), before = g.snapshot(), oracle = expected(before, 1, greedent());
  command(g, { type: 'endTurn' });
  const paused = g.snapshot();
  assert.equal(paused.current, 0, 'The source is player1 while the ending/current player is still player0.');
  assert.equal(paused.pending.kind, 'before-hand-optional'); assert.equal(paused.pending.player, 1);
  assert(paused.players[1].resolving.includes(incomingCard));
  assert.deepEqual(paused.players[0].hand, before.players[0].hand);
  assert.deepEqual(paused.players[0].deck, before.players[0].deck);
  assert.deepEqual(paused.rng, oracle.rng);
  const moved = bottomLogs(paused, before.events.length).find((e) => e.data.count > 0);
  assert.equal(moved.data.player, 1); assert.equal(moved.data.effectId, 'fixture:other-turn-bottom');
  conservation(paused, before.cards); assertPrivateShuffle(g, before, oracle);
  respond(g, f, ['skip']); settle(g);
  // The trigger's one effect draw was already planned. Starting player1's next
  // turn independently draws one more card; neither operation shuffles again.
  oracle.hands[1].push(oracle.decks[1].pop());
  assertOutcome(g, before, oracle); assert.equal(g.snapshot().current, 1);
  assert.equal(g.snapshot().players[1].hand.length, 2);
  assertPrivateShuffle(g, before, oracle);
  restore(g, f);
});
