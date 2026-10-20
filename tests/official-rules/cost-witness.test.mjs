// Independent finite payment oracle, not a real-card/cost-invariance approval.
// A proof-budget exception is unresolved SOFTWARE proof, not official illegality.
// Group identity AND the written card order within each group remain observable
// to the host's projected-state predicate; neither may be silently canonicalized.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findCostPayment, findCostPaymentWitness, ActivationProofLimitError,
} from '../../public/rules/activation-cost.js';
import { fixture, EVIDENCE } from './fixtures.mjs';

const clone = (value) => structuredClone(value);
// JSON object property order is irrelevant; group/card ARRAY order is not.
const key = (groups) => JSON.stringify(groups === null ? null :
  groups.map(({ costId, cardIds }) => ({ costId, cardIds })));
const cost = (count, kind = 'any', costId = 'a') => ({
  costId, kind: 'discardHand', count, selector: { kind }, sourceOfTruth: clone(EVIDENCE),
});
const groupsFor = (a, b) => [{ costId: 'a', cardIds: a }, { costId: 'b', cardIds: b }];
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const f = await fixture();
const definitions = {
  energy: f.catalog.definition('water'), pokemon: f.catalog.definition('base'), trainer: f.catalog.definition('potion'),
};
const cardsFor = (kinds) => kinds.map((kind, i) => ({ instanceId: `c${i}`, definition: definitions[kind] }));
const waters = (count) => cardsFor(Array(count).fill('energy'));

function* words(length, prefix = []) {
  if (length === 0) { yield prefix; return; }
  for (const kind of ['energy', 'pokemon', 'trainer']) yield* words(length - 1, [...prefix, kind]);
}
function* orderedDistinctIndices(size, count, prefix = []) {
  if (prefix.length === count) { yield prefix; return; }
  for (let i = 0; i < size; i++) if (!prefix.includes(i))
    yield* orderedDistinctIndices(size, count, [...prefix, i]);
}

// No production matching/selection helper is used in this expected-model
// calculation. Exhaust ordered physical-card slot assignments, then filter the
// small independent kind-only predicate domain. Unpaid cards occupy no slot.
function oracle(kinds, costs) {
  const total = costs[0].count + costs[1].count;
  if (total > kinds.length) return [];
  const result = [];
  for (const order of orderedDistinctIndices(kinds.length, total)) {
    const first = order.slice(0, costs[0].count), second = order.slice(costs[0].count);
    const selected = [first, second];
    if (!selected.every((indices, group) => indices.every((i) =>
      costs[group].selector.kind === 'any' || costs[group].selector.kind === kinds[i]))) continue;
    result.push(costs.map((c, group) => ({ costId: c.costId, cardIds: selected[group].map((i) => `c${i}`) })));
  }
  return result;
}
function limit(fn) {
  let caught;
  assert.throws(fn, (error) => { caught = error; return error instanceof ActivationProofLimitError; });
  assert.equal(caught.code, 'activation-proof-limit');
  assert.equal(caught.ruleId, 'effects.activation-change');
  return caught;
}

test('bounded n<=4 oracle exhausts both cost groups, all card kinds/counts, assignments and group-internal order', (t) => {
  const selectors = ['any', 'energy', 'pokemon', 'trainer'], cases = [];
  for (const a of selectors) for (const b of selectors)
    for (let first = 1; first <= 4; first++) for (let second = 1; second <= 4; second++)
      cases.push(freeze([cost(first, a, 'a'), cost(second, b, 'b')]));
  const costsBefore = clone(cases), started = performance.now();
  let configurations = 0, receipts = 0, successes = 0, infeasible = 0;
  for (let n = 0; n <= 4; n++) for (const kinds of words(n)) {
    const cards = freeze(cardsFor(kinds)), before = clone(cards);
    for (const costs of cases) {
      configurations++;
      const expected = oracle(kinds, costs), expectedKeys = expected.map(key), family = new Set(expectedKeys);
      assert.equal(family.size, expected.length, 'Independent ordered-slot oracle must not generate duplicate receipts.');
      const first = findCostPayment(costs, cards), firstKey = first && key(first);
      if (!expected.length) {
        infeasible++;
        assert.equal(first, null);
        assert.equal(findCostPaymentWitness(costs, cards, () => {
          assert.fail('An impossible complete payment cannot invoke the predicate.');
        }, { maxCandidates: 1 }), null);
        continue;
      }
      assert(family.has(firstKey));
      const visited = [];
      const result = findCostPaymentWitness(costs, cards, (groups) => {
        visited.push(key(groups)); return false;
      }, { maxCandidates: expected.length });
      assert.equal(result, null, 'Completed exhaustive all-false proof, at EXACT budget, returns null.');
      assert.equal(visited[0], firstKey, 'Try the ordinary matching witness first.');
      assert.equal(visited.length, expected.length);
      assert.equal(new Set(visited).size, visited.length, 'First matching plus traversal must not double-count a receipt.');
      assert.deepEqual([...visited].sort(), [...expectedKeys].sort());
      receipts += visited.length;
      // Every individual receipt is the ONLY successful predicate model once.
      // Thus an early false cannot stand in for another grouping or order.
      for (const wanted of expectedKeys) {
        const attempted = [];
        const found = findCostPaymentWitness(costs, cards, (groups) => {
          const candidate = key(groups); attempted.push(candidate); return candidate === wanted;
        }, { maxCandidates: expected.length });
        assert.equal(key(found), wanted);
        assert.equal(attempted[0], firstKey); assert.equal(attempted.at(-1), wanted);
        assert.equal(new Set(attempted).size, attempted.length);
        assert(attempted.every((candidate) => family.has(candidate)));
        successes++;
      }
    }
    assert.deepEqual(cards, before);
  }
  assert.deepEqual(cases, costsBefore);
  assert.equal(configurations, 30976); assert.equal(receipts, 27936); assert.equal(successes, receipts);
  assert(infeasible > 0);
  t.diagnostic(`${configurations} configurations, ${receipts} distinct complete receipts, ${successes} unique-model predicates; ${(performance.now() - started).toFixed(1)}ms.`);
});

test('first matching false does not hide a later choice of paid physical cards', () => {
  const cards = waters(3), costs = [cost(1, 'any', 'a'), cost(1, 'any', 'b')];
  const first = findCostPayment(costs, cards), paid = new Set(first.flatMap((group) => group.cardIds));
  const other = cards.find((card) => !paid.has(card.instanceId)).instanceId, visited = [];
  const result = findCostPaymentWitness(costs, cards, (groups) => {
    visited.push(key(groups)); return groups.some((group) => group.cardIds.includes(other));
  });
  assert.equal(visited[0], key(first)); assert(visited.length > 1);
  assert(result.some((group) => group.cardIds.includes(other)));
});

test('the same paid set assigned to different cost groups is a distinct predicate model', () => {
  const cards = waters(2), costs = [cost(1, 'any', 'a'), cost(1, 'any', 'b')];
  const first = findCostPayment(costs, cards), wanted = groupsFor([...first[1].cardIds], [...first[0].cardIds]);
  const visited = [];
  const result = findCostPaymentWitness(costs, cards, (groups) => {
    visited.push(key(groups)); return key(groups) === key(wanted);
  }, { maxCandidates: 2 });
  assert.deepEqual(result, wanted); assert.deepEqual(visited, [key(first), key(wanted)]);
});

test('the same assignment with a different order INSIDE either cost group must also be visited', () => {
  for (const counts of [[2, 1], [1, 2]]) {
    const cards = waters(3), costs = [cost(counts[0], 'any', 'a'), cost(counts[1], 'any', 'b')];
    const first = findCostPayment(costs, cards), wanted = clone(first);
    wanted[counts[0] === 2 ? 0 : 1].cardIds.reverse();
    assert.notEqual(key(wanted), key(first));
    const visited = [];
    const result = findCostPaymentWitness(costs, cards, (groups) => {
      visited.push(key(groups)); return key(groups) === key(wanted);
    }, { maxCandidates: 6 });
    assert.deepEqual(result, wanted); assert.equal(visited[0], key(first));
    assert(visited.length > 1);
  }
});

test('infeasible counts, selector conflicts and missing physical cards never call canExecute', () => {
  for (const [costs, cards] of [
    [[cost(1, 'any', 'a'), cost(1, 'any', 'b')], []],
    [[cost(1, 'any', 'a'), cost(1, 'any', 'b')], waters(1)],
    [[cost(1, 'pokemon', 'a'), cost(1, 'trainer', 'b')], waters(4)],
    [[cost(1, 'energy', 'a'), cost(1, 'energy', 'b')], cardsFor(['energy', 'pokemon'])],
    // A special Energy's two provided units are still one physical hand card.
    [[cost(1, 'energy', 'a'), cost(1, 'energy', 'b')],
      [{ instanceId: 'double', definition: f.catalog.definition('double') }]],
  ]) {
    let calls = 0;
    assert.equal(findCostPaymentWitness(costs, cards, () => { calls++; return true; }, { maxCandidates: 1 }), null);
    assert.equal(calls, 0);
  }
});

test('printed selector matching still constrains every candidate, not just the first feasibility witness', () => {
  const cards = ['water', 'fire', 'double'].map((id) => ({ instanceId: id, definition: f.catalog.definition(id) }));
  const costs = [
    { ...cost(1, 'energy', 'a'), selector: { kind: 'energy', category: 'basic', types: ['Water'] } },
    cost(1, 'energy', 'b'),
  ];
  const seen = [];
  assert.equal(findCostPaymentWitness(costs, cards, (groups) => {
    assert.deepEqual(groups[0].cardIds, ['water']); seen.push(groups[1].cardIds[0]); return false;
  }, { maxCandidates: 2 }), null);
  assert.deepEqual(seen.sort(), ['double', 'fire']);
});

test('default/explicit false costInvariant enumerate all; explicit host-proven true uses exactly one callback', () => {
  const costs = [cost(1, 'any', 'a'), cost(1, 'any', 'b')], cards = waters(2);
  for (const options of [undefined, { costInvariant: false }]) {
    let calls = 0;
    assert.equal(findCostPaymentWitness(costs, cards, () => { calls++; return false; }, options), null);
    assert.equal(calls, 2, 'An omitted invariance proof cannot silently mean independent.');
  }
  for (const accepted of [false, true]) {
    let calls = 0;
    const result = findCostPaymentWitness(costs, cards, () => { calls++; return accepted; },
      { maxCandidates: 1, costInvariant: true });
    assert.equal(calls, 1);
    assert.deepEqual(result, accepted ? findCostPayment(costs, cards) : null);
  }
});

test('budget 1/2 distinguishes an exhausted false proof from an unresolved proof and permits immediate success', () => {
  const two = waters(2), three = waters(3), costs = [cost(1, 'any', 'a'), cost(1, 'any', 'b')];
  const first = findCostPayment(costs, two), second = groupsFor(first[1].cardIds, first[0].cardIds);
  let calls = 0;
  assert.deepEqual(findCostPaymentWitness(costs, two, () => { calls++; return true; }, { maxCandidates: 1 }), first);
  assert.equal(calls, 1);
  calls = 0;
  limit(() => findCostPaymentWitness(costs, two, () => { calls++; return false; }, { maxCandidates: 1 }));
  assert.equal(calls, 1, 'A callback beyond the limit cannot run.');
  calls = 0;
  limit(() => findCostPaymentWitness(costs, three, () => { calls++; return false; }, { maxCandidates: 2 }));
  assert.equal(calls, 2);
  calls = 0;
  assert.equal(findCostPaymentWitness(costs, two, () => { calls++; return false; }, { maxCandidates: 2 }), null);
  assert.equal(calls, 2, 'Budget exactly equal to the complete model count can establish false.');
  const delayed = (groups) => key(groups) === key(second);
  limit(() => findCostPaymentWitness(costs, two, delayed, { maxCandidates: 1 }));
  assert.deepEqual(findCostPaymentWitness(costs, two, delayed, { maxCandidates: 2 }), second);
  const uniqueCosts = [cost(1, 'pokemon', 'a'), cost(1, 'trainer', 'b')], uniqueCards = cardsFor(['pokemon', 'trainer']);
  calls = 0;
  assert.equal(findCostPaymentWitness(uniqueCosts, uniqueCards, () => { calls++; return false; }, { maxCandidates: 1 }), null);
  assert.equal(calls, 1, 'The already-tried first witness cannot consume a second budget slot.');
});

test('default 4096 budget is a proof limit, not a false result or an arbitrary official payment cap', () => {
  // P(10,4)=5040 distinct ordered receipts, so 4096 failed candidates
  // cannot establish that no subsequent-effect witness exists.
  const cards = waters(10), costs = [cost(3, 'any', 'a'), cost(1, 'any', 'b')];
  let calls = 0;
  limit(() => findCostPaymentWitness(costs, cards, () => { calls++; return false; }));
  assert.equal(calls, 4096);
});

test('predicate returns must be synchronous booleans; thrown predicate errors are not false proofs', () => {
  const costs = [cost(1, 'any', 'a'), cost(1, 'any', 'b')], cards = waters(2);
  for (const bad of [undefined, null, 0, 1, 'true', {}, [], Promise.resolve(true)])
    assert.throws(() => findCostPaymentWitness(costs, cards, () => bad), TypeError);
  const failure = new Error('Independent host projection could not be evaluated.');
  assert.throws(() => findCostPaymentWitness(costs, cards, () => { throw failure; }), (error) => error === failure);
});

test('proof options require a positive safe budget, Boolean invariance and a callable predicate', () => {
  const costs = [cost(1, 'any', 'a'), cost(1, 'any', 'b')], cards = waters(2);
  for (const callback of [null, false, 0, {}, []])
    assert.throws(() => findCostPaymentWitness(costs, cards, callback), TypeError);
  for (const maxCandidates of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null])
    assert.throws(() => findCostPaymentWitness(costs, cards, () => true, { maxCandidates }), TypeError);
  for (const costInvariant of [null, 0, 'true', {}, []])
    assert.throws(() => findCostPaymentWitness(costs, cards, () => true, { costInvariant }), TypeError);
});

test('callbacks receive only deeply frozen detached groups; accepted return detaches again without mutating/freezing inputs', () => {
  const costs = [cost(2, 'any', 'a'), cost(1, 'any', 'b')], cards = clone(waters(3));
  const before = clone({ costs, cards }), held = [];
  const result = findCostPaymentWitness(costs, cards, function (groups) {
    assert.equal(arguments.length, 1);
    assert(Object.isFrozen(groups));
    for (const group of groups) {
      assert(Object.isFrozen(group)); assert(Object.isFrozen(group.cardIds));
      assert.deepEqual(Object.keys(group).sort(), ['cardIds', 'costId']);
    }
    assert.throws(() => groups.push({ costId: 'injected', cardIds: [] }), TypeError);
    assert.throws(() => { groups[0].costId = 'injected'; }, TypeError);
    assert.throws(() => groups[0].cardIds.reverse(), TypeError);
    held.push(groups); return held.length === 2;
  });
  assert.equal(held.length, 2); assert.notEqual(held[0], held[1]);
  assert.deepEqual(result, held[1]); assert.notEqual(result, held[1]);
  for (let i = 0; i < result.length; i++) {
    assert.notEqual(result[i], held[1][i]); assert.notEqual(result[i].cardIds, held[1][i].cardIds);
  }
  assert.deepEqual({ costs, cards }, before);
  for (const value of [costs, costs[0], costs[0].selector, costs[0].sourceOfTruth,
    cards, cards[0], cards[0].definition, cards[0].definition.mechanics]) assert(!Object.isFrozen(value));
});
