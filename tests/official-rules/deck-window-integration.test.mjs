/**
 * Executable HOST-CONTRACT examples using the existing real RNG implementation.
 * Not OfficialGame integration: the main agent owns runEffect, prompt escrow,
 * physical zone receipts, save authentication, projections and source approval.
 * These synthetic fixtures must never be published as approved Rika cards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectDeckWindow, planDeckInspection, assertDeckInspectionPlan,
  deckInspectionNeedsShuffle, assertDeckInspectionRemainder, assertDeckInspectionPlacement,
} from '../../public/rules/deck-window.js';
import { shuffleIds } from '../../public/rules/random.js';
import { deepFreeze } from '../../public/rules/registry.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const action = (revealSelected = false) => ({
  op: 'inspectDeck', lookTop: 4, selector: { kind: 'any' },
  quantity: { kind: 'exact', count: 2 }, revealSelected,
  remainder: { mode: 'shuffleToBottom' },
});
function context(top, rng = [123, 456, 789, 42], owner = 0) {
  const own = { deck: [...top].reverse(), hand: ['existing-hand'], flags: { supporterPlayed: false } };
  const opponent = { deck: ['opponent-secret'], hand: ['opponent-hand'], flags: { supporterPlayed: true } };
  return {
    source: { owner }, definitions: { fixture: { kind: 'trainer', name: '测试', mechanics: { category: 'item' } } },
    state: {
      current: 1 - owner, rng: [...rng],
      cards: Object.fromEntries(top.map((id) => [id, { instanceId: id, owner, definitionId: 'fixture' }])),
      players: owner === 0 ? [own, opponent] : [opponent, own],
    },
  };
}

// Test-only adapter: retain the independently captured original deck/answer,
// restore just plain JSON, use a cloned real RNG and move each ID exactly once.
// A production host must authenticate its original escrow and RNG separately.
function resolve(original, spec, answer, restore = false) {
  let plan = planDeckInspection(original, spec, answer);
  if (restore) plan = copy(plan);
  assertDeckInspectionPlan(original, spec, plan, answer);
  const rng = [...original.state.rng];
  const shuffledTop = shuffleIds(rng, [...plan.remainder]);
  assertDeckInspectionRemainder(plan, shuffledTop);
  const result = copy(original);
  const player = result.state.players[original.source.owner];
  const uninspected = player.deck.slice(0, player.deck.length - plan.window.length);
  const deckAfter = [...shuffledTop].reverse().concat(uninspected);
  assertDeckInspectionPlacement(original, spec, plan, shuffledTop, deckAfter);
  player.deck = deckAfter; player.hand.push(...plan.selected); result.state.rng = rng;
  // Count-only event, including singleton, never a shuffle-order leak.
  const publicEvent = {
    type: 'deck-inspection', player: original.source.owner,
    looked: plan.window.length, selected: plan.selected.length,
    shuffled: deckInspectionNeedsShuffle(plan),
    revealed: spec.revealSelected ? [...plan.selected] : [],
  };
  return { result, publicEvent };
}

// Deliberately minimal host projection: this is a contract demonstration, not
// evidence that the production player's view/prompt implementation is ready.
function projected(result, event, viewer) {
  return {
    players: result.state.players.map((p, owner) => ({
      deckCount: p.deck.length, hand: owner === viewer ? [...p.hand] : p.hand.length,
    })),
    events: [copy(event)],
  };
}

test('compose pure planning with real host RNG: only remainder is shuffled and unseen top sequence never changes', () => {
  const orders = new Set();
  for (let seed = 1; seed <= 128; seed++) {
    const top = ['look1', 'look2', 'look3', 'look4', 'unseen5', 'unseen6', 'unseen7'];
    const ctx = deepFreeze(context(top, [seed, Math.imul(seed, 0x9e3779b9) >>> 0, seed * 3, seed * 5]));
    const before = copy(ctx);
    const { result, publicEvent } = resolve(ctx, deepFreeze(action()), deepFreeze(['look3', 'look1']));
    const nextTop = [...result.state.players[0].deck].reverse();
    assert.deepEqual(nextTop.slice(0, 3), ['unseen5', 'unseen6', 'unseen7']);
    assert.deepEqual([...nextTop.slice(3)].sort(), ['look2', 'look4']);
    orders.add(JSON.stringify(nextTop.slice(3)));
    assert.deepEqual(result.state.players[0].hand, ['existing-hand', 'look3', 'look1']);
    assert.notDeepEqual(result.state.rng, before.state.rng);
    assert.deepEqual(result.state.players[1], before.state.players[1]);
    assert.deepEqual(result.state.players[0].flags, before.state.players[0].flags);
    assert.deepEqual(ctx, before);
    assert.deepEqual(publicEvent, {
      type: 'deck-inspection', player: 0, looked: 4, selected: 2, shuffled: true, revealed: [],
    });
    // Conservation oracle: physical occurrence counts, independently of Sets.
    for (const id of top) assert.equal([...result.state.players[0].deck, ...result.state.players[0].hand]
      .reduce((count, found) => count + Number(found === id), 0), 1);
  }
  assert.equal(orders.size, 2, 'varying real RNG seeds produces both possible remainder orders');
});

test('Rika three-card remainder is a one-card shuffle even with unchanged RNG; no remainder means no shuffle event', () => {
  for (let n = 0; n <= 3; n++) {
    const top = ['look1', 'look2', 'look3'].slice(0, n), ctx = context(top);
    const before = copy(ctx), { result, publicEvent } = resolve(ctx, action(), top.slice(0, Math.min(2, n)));
    assert.equal(publicEvent.shuffled, n === 3);
    assert.deepEqual(result.state.rng, before.state.rng,
      'Fisher-Yates requires no sample for empty or one-card remainder');
    assert.deepEqual(result.state.players[0].deck, n === 3 ? ['look3'] : []);
    assert.deepEqual(ctx, before);
  }
});

test('JSON save/restore before RNG has the same exact deck/RNG/hand result as uninterrupted planning', () => {
  const top = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (const owner of [0, 1]) for (const reveal of [true, false]) {
    const original = context(top, [789, 42, 123, 456], owner), spec = action(reveal), answer = ['d', 'b'];
    const saved = copy({ original, spec, answer });
    assert.deepEqual(resolve(original, spec, answer), resolve(saved.original, saved.spec, saved.answer, true));
    const plan = copy(planDeckInspection(original, spec, answer));
    const independentReceipt = copy(answer);
    plan.selected.reverse();
    assert.throws(() => assertDeckInspectionPlan(saved.original, saved.spec, plan, independentReceipt), TypeError);
    const changed = copy(original); changed.state.players[owner].deck.reverse();
    assert.throws(() => assertDeckInspectionPlan(changed, spec,
      planDeckInspection(original, spec, answer), independentReceipt), TypeError);
  }
});

test('inspection is owner-only; post-shuffle projections disclose neither remainder IDs/order nor RNG, even to that owner', () => {
  for (const owner of [0, 1]) for (const reveal of [false, true]) {
    const top = ['choose1', 'secret-remainder2', 'choose3', 'secret-remainder4', 'never-looked5'];
    const ctx = context(top, [123, 456, 789, 42], owner), spec = action(reveal);
    const privatePrompt = inspectDeckWindow(ctx, spec);
    assert.deepEqual(privatePrompt.window, top.slice(0, 4));
    const { result, publicEvent } = resolve(ctx, spec, ['choose1', 'choose3']);
    for (const viewer of [0, 1]) {
      const view = projected(result, publicEvent, viewer), serialized = JSON.stringify(view);
      assert(!serialized.includes('secret-remainder2')); assert(!serialized.includes('secret-remainder4'));
      assert(!serialized.includes('never-looked5')); assert(!serialized.includes('opponent-secret'));
      assert(!serialized.includes('"rng"')); assert(!serialized.includes('"window"'));
      assert(!serialized.includes('"remainder"'));
      if (viewer === owner || reveal) {
        assert(serialized.includes('choose1')); assert(serialized.includes('choose3'));
      } else {
        assert(!serialized.includes('choose1')); assert(!serialized.includes('choose3'));
      }
    }
    assert.deepEqual(publicEvent.revealed, reveal ? ['choose1', 'choose3'] : []);
  }
});

test('a valid permutation is not proof of actual RNG or production approval', () => {
  const ctx = context(['a', 'b', 'c', 'd', 'e']), spec = action();
  const plan = planDeckInspection(ctx, spec, ['a', 'c']);
  // This passes conservation despite no RNG call. The main host MUST execute
  // the real shuffle itself, not accept a player-submitted permutation/receipt.
  assert.equal(assertDeckInspectionRemainder(plan, plan.remainder), plan.remainder);
  const serialized = JSON.stringify({ plan, event: resolve(ctx, spec, ['a', 'c']).publicEvent });
  assert(!/approved|verified|trustpin|official-card/i.test(serialized));
});
