// Synthetic definitions only. Coin / "或者" / E-36 hand-to-deck / in-play-count
// shapes mirror CN printed text patterns but approve no actual card or printing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import { createCoreHandlers, validateCoinEffect, validateOrElseEffect } from '../../public/rules/handlers.js';
import { advanceEffectExecution, beginEffectExecution } from '../../public/rules/effect-execution.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { randomIndex } from '../../public/rules/random.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  for (const viewer of [0, 1]) assert.deepEqual(r.view(viewer), g.view(viewer));
  return r;
};
// Pick an RNG state whose next flip is the requested face. Test setup only.
function forceCoin(s, result) {
  for (let k = 1; ; k++) {
    const rng = [k, k * 7 + 1, k * 13 + 2, k * 31 + 3];
    if (randomIndex([...rng], 2) === (result === 'heads' ? 0 : 1)) { s.rng = rng; return; }
  }
}
const coinEvents = (g) => g.snapshot().events.filter((e) => e.ruleId === 'effects.coin');
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const play = (g, cardId) => command(g, { type: 'playTrainer', cardId });
const playable = (g, cardId) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === cardId);
const setHand = (s, owner, definitions) => {
  const p = s.players[owner];
  p.discard.push(...p.hand.splice(0));
  const ids = definitions.map((id) => { const card = hand(s, owner, id); p.hand.pop(); p.resolving.push(card); return card; });
  for (const id of ids) { p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id); }
  return ids;
};
const nested = (handlerId, parameters) => ({ handlerId, parameters });
const gust = () => nested('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected' });
const paralyze = () => nested('cn.condition@1', { side: 'opponent', condition: 'paralyzed' });
const discardOwnEnergy = () => nested('cn.attachedEnergy@1', {
  op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' }, providedTypes: null,
  measure: 'cards', quantity: { kind: 'all' }, chooser: 'source',
});
const topToHand = () => nested('cn.cards@1', {
  from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'any' }, reveal: false, lookTop: 1, shuffleAfter: false,
});
const discardTopThenDraw = () => nested('cn.cardsThenDraw@1', {
  cards: { from: 'deck', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
    reveal: false, lookTop: 1, shuffleAfter: false },
  draw: 1,
});
const handDiscardThenDraw = (draw = 2) => ({
  cards: { from: 'hand', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
    reveal: false, lookTop: null, shuffleAfter: false },
  draw,
});
const fee = (count) => [{ costId: 'fee', kind: 'discardHand', count, selector: { kind: 'any' }, sourceOfTruth: EVIDENCE }];
const trainer = (id, effects, playCosts) => (defs) => {
  const m = defs.find((d) => d.definitionId === id).mechanics;
  m.effects = effects; if (playCosts) m.playCosts = playCosts;
};

test('control and count handlers carry CN sources, strict nested-leaf validation and static native programs', () => {
  const h = createCoreHandlers();
  for (const [id, rule, schema] of [
    ['cn.coin@1', 'effects.coin', 'coin'], ['cn.orElse@1', 'effects.or-else', 'orElse'],
    ['cn.handDeckDraw@1', 'effects.hand-deck', 'handDeckDraw'], ['cn.drawPokemonCount@1', 'effects.draw', 'drawPokemonCount'],
    ['cn.cardsThenDraw@1', 'effects.partial', 'cardsThenDraw'],
  ]) {
    const entry = h.get(id);
    assert.equal(entry.rulesetId, 'CN/V20261019');
    assert.equal(entry.parameterSchemaRef, `urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/${schema}`);
    for (const source of requireRule(CN_V20261019, rule).sourceOfTruth) assert(entry.sourceOfTruth.includes(source));
  }
  assert.deepEqual(h.get('cn.coin@1').operations.slice(0, 2), ['coin', 'sequence']);
  assert.deepEqual(h.get('cn.handDeckDraw@1').operations, ['then', 'shuffleHandIntoDeck', 'sequence', 'draw', 'coin', 'optional']);
  assert(validateCoinEffect({ outcome: 'heads', effect: gust() }));
  assert(validateCoinEffect({ outcome: 'tails', effect: discardOwnEnergy() }));
  assert(validateCoinEffect({ outcome: 'heads', effect: nested('cn.draw@1', { count: 1 }) }));
  assert(validateCoinEffect({ outcome: 'heads', effects: [paralyze(), nested('cn.condition@1', { side: 'opponent', condition: 'poisoned' })] }));
  for (const bad of [
    { outcome: 'edge', effect: gust() }, { outcome: 'heads', effect: nested('cn.switch@1', { side: 'nowhere' }) },
    // drawPokemonCount reads the board while compiling, damage is not a resolve leaf; one effect or a list, never both or none.
    { outcome: 'heads', effect: nested('cn.drawPokemonCount@1', { side: 'own' }) }, { outcome: 'heads' },
    { outcome: 'heads', effect: nested('cn.damage@1', { side: 'opponent', target: 'bench', amount: 20, selection: { kind: 'all' }, options: {} }) },
    { outcome: 'heads', effect: gust(), effects: [gust(), paralyze()] }, { outcome: 'heads', effects: [gust()] },
    { outcome: 'heads', effect: { ...gust(), extra: true } },
  ]) assert(!validateCoinEffect(bad));
  assert(validateOrElseEffect({ first: topToHand(), otherwise: discardTopThenDraw() }));
  assert(!validateOrElseEffect({ first: nested('cn.cards@1', {}), otherwise: discardTopThenDraw() }));
  assert(!validateOrElseEffect({ first: topToHand(), otherwise: nested('cn.cardsThenDraw@1', { draw: 1 }) }));
  assert(!h.get('cn.cardsThenDraw@1').validateParameters({ ...handDiscardThenDraw(), draw: 0 }));
  assert(!h.get('cn.handDeckDraw@1').validateParameters({ side: 'own', ownDraw: 5 }));
  assert(!h.get('cn.drawPokemonCount@1').validateParameters({ side: 'both' }));
  const ctx = { source: { owner: 1 } };
  assert.deepEqual(h.get('cn.coin@1').execute(ctx, { outcome: 'heads', effect: gust() }), [{
    op: 'coin', outcome: 'heads', effect: { op: 'sequence', steps: [{ op: 'switch', ...gust().parameters }] },
  }]);
  assert.deepEqual(h.get('cn.orElse@1').execute(ctx, { first: topToHand(), otherwise: discardTopThenDraw() }), [{
    op: 'orElse', first: { op: 'sequence', steps: [{ op: 'cards', ...topToHand().parameters }] },
    otherwise: { op: 'sequence', steps: [{ op: 'then', first: { op: 'cards', ...discardTopThenDraw().parameters.cards },
      next: { op: 'draw', count: 1 } }] },
  }]);
  assert.deepEqual(h.get('cn.handDeckDraw@1').execute(ctx, { side: 'both', ownDraw: 4, opponentDraw: 3 }), [{
    op: 'then', first: { op: 'shuffleHandIntoDeck', side: 'both' },
    next: { op: 'sequence', steps: [{ op: 'draw', player: 1, count: 4 }, { op: 'draw', player: 0, count: 3 }] },
  }]);
});

test('II.C-17 shape: a heads-only attack condition applies only on heads; the public flip marks the attack as executed', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [binding('cn.coin@1', { outcome: 'heads', effect: paralyze() })];
  });
  for (const result of ['heads', 'tails']) {
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); forceCoin(s, result); });
    attack(g); settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, 2, 'The printed damage is independent of the flip.');
    assert.equal(s.players[1].active.conditions.rotation, result === 'heads' ? 'paralyzed' : null);
    const [flip] = coinEvents(g);
    assert.equal(flip.visibility, 'public');
    assert.deepEqual([flip.data.result, flip.data.required, flip.data.player], [result, 'heads', 0]);
    assert(g.view(1).events.some((e) => e.ruleId === 'effects.coin' && e.data.result === result));
    restore(g, f);
  }
});

test('a tails-only self discard of all attached Energy happens after damage and only on tails', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [binding('cn.coin@1', { outcome: 'tails', effect: discardOwnEnergy() })];
  });
  for (const result of ['heads', 'tails']) {
    let energy;
    const g = board(f, (s) => {
      energy = [attached(s, 0, s.players[0].active, 'water'), attached(s, 0, s.players[0].active, 'water')];
      forceCoin(s, result);
    });
    attack(g);
    if (result === 'tails') {
      const q = g.view(0).pending;
      assert.equal(q.kind, 'attached-energy');
      assert.deepEqual([...q.options].sort(), [...energy].sort());
      assert.equal(q.minimum, 2);
      restore(g, f);
    }
    settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, 2);
    assert.deepEqual(s.players[0].active.energy.length, result === 'tails' ? 0 : 2);
    assert.equal(energy.every((id) => s.players[0].discard.includes(id)), result === 'tails');
  }
});

test('II.C-05 Item shape: no opposing Bench forbids the Item; heads lets the user choose, tails still uses the card', async () => {
  const f = await fixture(trainer('potion', [binding('cn.coin@1', { outcome: 'heads', effect: gust() })]));
  let item;
  const empty = board(f, (s) => { [item] = setHand(s, 0, ['potion']); });
  assert(!playable(empty, item));
  assert.throws(() => play(empty, item), EngineError);
  for (const result of ['heads', 'tails']) {
    let target;
    const g = board(f, (s) => {
      [item] = setHand(s, 0, ['potion']); target = bench(s, 1, 'other'); bench(s, 1, 'base'); forceCoin(s, result);
    });
    const before = g.snapshot().players[1].active.id;
    assert(playable(g, item)); play(g, item);
    if (result === 'heads') {
      const q = g.view(0).pending;
      assert.equal(q.kind, 'effect-target'); assert.equal(q.options.length, 2);
      assert.equal(g.view(1).pending, null, 'The effect user chooses the opposing Bench Pokémon.');
      restore(g, f);
      answer(g, [target.id]);
    }
    settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.id, result === 'heads' ? target.id : before);
    assert(s.players[0].discard.includes(item));
    assert.equal(coinEvents(g).length, 1);
  }
});

test('「或者」 shape: after looking at the top card the user either takes it, or discards it and draws one', async () => {
  const f = await fixture(trainer('potion', [binding('cn.orElse@1', { first: topToHand(), otherwise: discardTopThenDraw() })]));
  for (const take of [true, false]) {
    let item;
    const g = board(f, (s) => { [item] = setHand(s, 0, ['potion']); });
    const deck = g.snapshot().players[0].deck, top = deck.at(-1), next = deck.at(-2);
    play(g, item);
    const q = g.view(0).pending;
    assert.equal(q.kind, 'select-cards'); assert.deepEqual(q.options, [top]);
    assert.deepEqual(q.lookedAt.map((c) => c.instanceId), [top]);
    assert.equal(q.minimum, 0); assert.equal(q.allowZero, true);
    assert.equal(g.view(1).pending, null);
    restore(g, f);
    answer(g, take ? [top] : []);
    if (!take) {
      const forced = g.view(0).pending;
      assert.deepEqual([forced.kind, forced.options, forced.minimum], ['select-cards', [top], 1]);
      answer(g, [top]);
    }
    settle(g);
    const p = g.snapshot().players[0];
    assert.deepEqual(p.hand, take ? [top] : [next]);
    assert.equal(p.discard.includes(top), !take);
    assert.equal(p.deck.length, deck.length - (take ? 1 : 2));
    assert(p.discard.includes(item));
  }
  let item;
  const dry = board(f, (s) => { [item] = setHand(s, 0, ['potion']); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert(!playable(dry, item), 'Neither alternative can change an empty deck.');
});

test('E-19 then: discarding one hand card unlocks the draw, an empty hand performs neither part', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [binding('cn.cardsThenDraw@1', handDiscardThenDraw())];
  });
  for (const cards of [['potion', 'tool'], []]) {
    let ids;
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); ids = setHand(s, 0, cards); });
    const deck = g.snapshot().players[0].deck.length;
    attack(g);
    if (cards.length) {
      assert.equal(g.view(0).pending.kind, 'select-cards'); restore(g, f); answer(g, [ids[1]]);
    }
    settle(g);
    const p = g.snapshot().players[0];
    assert.equal(p.hand.length, cards.length ? 3 : 0);
    assert.equal(p.deck.length, deck - (cards.length ? 2 : 0));
    if (cards.length) assert(p.discard.includes(ids[1]) && p.hand.includes(ids[0]));
  }
  const cards = createCoreHandlers().get('cn.cardsThenDraw@1');
  const ctx = (hand) => ({ source: { owner: 0, category: 'ability', instanceId: 'x' }, definitions: { d: { kind: 'trainer' } },
    state: { cards: { a: { definitionId: 'd' } }, players: [{ hand, bench: [] }] } });
  assert.equal(cards.canUse(ctx(['a']), handDiscardThenDraw()), true);
  assert.equal(cards.canUse(ctx([]), handDiscardThenDraw()), false);
});

test('E-36 own hand-to-deck Supporter: last-card use still shuffles and draws; empty hand and deck forbid it', async () => {
  const p = { side: 'own', ownDraw: 5, opponentDraw: 0 };
  const f = await fixture(trainer('research', [binding('cn.handDeckDraw@1', p)]));
  for (const extra of [['potion', 'tool'], []]) {
    let source, ids;
    const g = board(f, (s) => { [source, ...ids] = setHand(s, 0, ['research', ...extra]); });
    const before = g.snapshot();
    assert(playable(g, source)); play(g, source); settle(g);
    const s = g.snapshot(), own = s.players[0];
    assert.equal(own.hand.length, 5);
    assert.equal(own.deck.length, before.players[0].deck.length + extra.length - 5);
    assert(own.discard.includes(source) && !own.deck.includes(source));
    assert.deepEqual(s.players[1], before.players[1]);
    const added = s.events.slice(before.events.length);
    assert.deepEqual(added.filter((e) => e.ruleId === 'effects.hand-deck').map((e) => [e.data.player, e.data.count]), [[0, extra.length]]);
    assert(added.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0 && e.data.zone === 'deck'));
    assert.notDeepEqual(s.rng, before.rng);
    restore(g, f);
  }
  let source;
  const dry = board(f, (s) => { [source] = setHand(s, 0, ['research']); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert(!playable(dry, source)); assert.throws(() => play(dry, source), EngineError);
});

test('E-36 both-player Supporter: each whole hand returns to its own deck, each deck shuffles, then each player draws', async () => {
  const f = await fixture(trainer('research', [binding('cn.handDeckDraw@1', { side: 'both', ownDraw: 4, opponentDraw: 4 })]));
  for (const opponentHand of [['water', 'other', 'tool'], []]) {
    let source;
    const g = board(f, (s) => { [source] = setHand(s, 0, ['research', 'potion']); setHand(s, 1, opponentHand); });
    const before = g.snapshot();
    play(g, source); settle(g);
    const s = g.snapshot();
    assert.deepEqual(s.players.map((p) => p.hand.length), [4, 4]);
    assert.equal(s.players[1].deck.length, before.players[1].deck.length + opponentHand.length - 4);
    const shuffled = s.events.slice(before.events.length).filter((e) => e.ruleId === 'effects.shuffle').map((e) => e.data.player);
    assert.deepEqual(shuffled, [0, 1]);
  }
  let source;
  const g = board(f, (s) => {
    [source] = setHand(s, 0, ['research']); setHand(s, 1, []);
    s.players[0].discard.push(...s.players[0].deck.splice(0));
  });
  assert(playable(g, source), 'The opposing deck alone is an actual E-36 change.');
  const solo = board(f, (s) => {
    [source] = setHand(s, 0, ['research']); setHand(s, 1, []);
    for (const p of s.players) p.discard.push(...p.deck.splice(0));
  });
  assert(!playable(solo, source));
});

test('a paid hand-to-deck Supporter counts the fee as gone before proving its E-36 change', async () => {
  const f = await fixture(trainer('research', [binding('cn.handDeckDraw@1', { side: 'own', ownDraw: 2, opponentDraw: 0 })], fee(1)));
  let ids;
  const dry = board(f, (s) => { ids = setHand(s, 0, ['research', 'potion']); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert(!playable(dry, ids[0]), 'Only the fee card would remain, and it is discarded, not shuffled.');
  const g = board(f, (s) => { ids = setHand(s, 0, ['research', 'potion', 'tool']); });
  play(g, ids[0]); answer(g, [paymentOptionId('fee', ids[1])]); settle(g);
  const p = g.snapshot().players[0];
  assert(p.discard.includes(ids[0]) && p.discard.includes(ids[1]));
  assert.equal(p.hand.length, 2);
});

test('in-play count draw uses the resolution board after the fee, and a forged receipt beyond any board is rejected', async () => {
  const f = await fixture(trainer('research', [binding('cn.drawPokemonCount@1', { side: 'opponent' })], fee(2)));
  let ids;
  const g = board(f, (s) => { ids = setHand(s, 0, ['research', 'potion', 'tool']); bench(s, 1, 'other'); bench(s, 1, 'base'); });
  assert(playable(g, ids[0]));
  play(g, ids[0]);
  answer(g, [paymentOptionId('fee', ids[1]), paymentOptionId('fee', ids[2])]); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 3);
  const forged = clone(g.snapshot());
  const opened = forged.events.find((e) => e.ruleId === 'effects.execution' && e.data.kind === 'opened' &&
    e.data.binding.handlerId === 'cn.drawPokemonCount@1');
  opened.data.program[0].count = 10;
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-execution');
  const dry = board(f, (s) => { ids = setHand(s, 0, ['research', 'potion', 'tool']); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert(!playable(dry, ids[0]));
  const count = createCoreHandlers().get('cn.drawPokemonCount@1');
  const ctx = { source: { owner: 0 }, state: { players: [{ deck: ['a'], active: null, bench: [] }, { deck: [], active: null, bench: [] }] } };
  assert.equal(count.canUse(ctx, { side: 'opponent' }), false);
  assert.deepEqual(count.execute(ctx, { side: 'own' }), [{ op: 'draw', count: 0 }]);
});

test('execution journal: coin opens like an accepted gate, orElse is a control node, and neither can be completed as performed', () => {
  const evidence = [{ sourceId: 'fixture:journal', kind: 'official-rule', url: 'https://www.pokemon.cn/', locator: 'TEST ONLY' }];
  const open = (program) => beginEffectExecution({ ruleId: 'effects.execution', visibility: 'private', data: {
    kind: 'opened', id: 'p1', turn: 0, program, origin: 'handler', event: null, local: false, entry: null, payment: null,
    source: { instanceId: 's', owner: 0, category: 'trainer', pokemonId: null, attackId: null, effectId: 'e', sourceOfTruth: evidence },
    binding: { effectId: 'e', handlerId: 'fixture@1', parameters: {}, sourceOfTruth: evidence },
  } }, ['coin', 'orElse', 'sequence', 'draw']);
  const step = (cursor, index, mode, performed) => advanceEffectExecution(cursor, { ruleId: 'effects.execution',
    visibility: 'private', data: { kind: 'advance', id: 'p1', index, mode, performed } });
  const draw = { op: 'draw', count: 1 };
  let cursor = step(open([{ op: 'coin', outcome: 'heads', effect: draw }]), 0, 'expand', null);
  assert.equal(cursor.step.action.op, 'coin');
  assert.throws(() => step(cursor, 1, 'expand', null), (e) => e.code === 'invalid-execution-transition');
  assert.throws(() => step(cursor, 1, 'complete', true), (e) => e.code === 'invalid-execution-transition');
  assert.equal(step(cursor, 1, 'complete', false).step, null);
  assert.deepEqual(step(cursor, 1, 'optional', true).step.action, draw);
  cursor = step(open([{ op: 'orElse', first: draw, otherwise: { op: 'draw', count: 2 } }]), 0, 'expand', null);
  assert.throws(() => step(cursor, 1, 'complete', false), (e) => e.code === 'invalid-execution-transition');
  assert.throws(() => step(cursor, 1, 'optional', true), (e) => e.code === 'invalid-execution-transition');
  cursor = step(cursor, 1, 'expand', null);
  assert.deepEqual(cursor.step.action, draw);
  assert.equal(step(cursor, 2, 'complete', true).step, null, 'A performed first branch skips the alternative.');
  assert.deepEqual(step(cursor, 2, 'complete', false).step.action, { op: 'draw', count: 2 });
});
