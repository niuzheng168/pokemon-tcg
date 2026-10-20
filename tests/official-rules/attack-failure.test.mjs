import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACK_FAILURE_RULE_IDS, assertFailureCoin, rollFailureCoin, assertFailureReceipt, groupImposedChecks,
} from '../../public/rules/attack-failure.js';
import { assertDefinitionShape } from '../../public/rules/card-schema.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { randomIndex } from '../../public/rules/random.js';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const fixed = (count = 1, minimumHeads = 1) => ({ mode: 'fixed', count, minimumHeads });
const untilTails = (minimumHeads = 1) => ({ mode: 'untilTails', minimumHeads });
const selfCheck = (coin = fixed()) => ({ coin, sourceOfTruth: EVIDENCE });
const imposed = (coin = fixed(), extra = {}) => ({ op: 'attackCheck', scope: 'all', coin, ...extra });
const lasting = (effect, extra = {}) => ({ side: 'opponent', target: 'active', effect,
  duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true, ...extra });
const receipt = (results, heads, tails, passed) => ({ results, heads, tails, passed });
const clone = (value) => structuredClone(value);
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const attack = (g, attackId = 'base:strike') => command(g, { type: 'attack', attackId });
const hold = (s, owner, m, definitionId = 'tool') => {
  const id = hand(s, owner, definitionId); s.players[owner].hand.pop(); m.tools.push(id); return id;
};
const activeOther = (s, owner = 1) => {
  const p = s.players[owner], old = p.active;
  p.hand.push(...old.stack, ...old.energy, ...old.tools);
  p.active = bench(s, owner, 'other'); p.bench.pop(); return p.active;
};
const chooseCopy = (g, attackId = 'other:strike') => {
  assert.equal(g.snapshot().pending?.kind, 'copy-attack');
  const option = g.view(g.snapshot().pending.player).pending.attacks.find((a) => a.attackId === attackId);
  assert(option, `Missing copy option ${attackId}`); return answer(g, [option.optionId]);
};
const copySpec = (extra = {}) => ({ op: 'copyAttack',
  origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }],
  excludeUser: false, coin: 'none', energy: 'ignore',
  special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE }, ...extra });
const copier = (defs, extra = {}) => {
  const a = defs[0].mechanics.attacks[0];
  a.printedDamage = null; a.effects = [binding('cn.copyAttack@1', copySpec(extra))]; return a;
};
const reviewed = (extra) => ({ rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
  validateParameters: (p) => Object.keys(p).length === 0, ...extra });

// This oracle uses only the existing RNG, never rollFailureCoin or a receipt
// produced by the code being tested. The search bound is a fixture guard.
const seedFor = (coins) => {
  for (let i = 1; i <= 8192; i++) {
    const seed = [Math.imul(i, 8000009) >>> 0, Math.imul(i, 333333331) >>> 0,
      Math.imul(i, 17) >>> 0, Math.imul(i, 37) >>> 0], rng = [...seed];
    if (coins.every((heads) => (randomIndex(rng, 2) === 0) === heads)) return seed;
  }
  throw new Error(`Fixture could not find the requested coin prefix ${coins}`);
};
const consumed = (seed, count) => {
  const rng = [...seed]; for (let i = 0; i < count; i++) randomIndex(rng, 2); return rng;
};
const withCoins = (f, coins, mutate = () => {}) => board(f, (s) => {
  attached(s, 0, s.players[0].active, 'water'); mutate(s); s.rng = seedFor(coins);
});

test('attack-failure rules carry CN sources, and card data cannot embed runtime results', async () => {
  for (const id of ATTACK_FAILURE_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  const f = await fixture(), original = f.catalog.definition('base');
  for (const coin of [fixed(), fixed(3, 2), untilTails(2)]) {
    const d = clone(original); d.mechanics.attacks[0].failureCheck = selfCheck(coin);
    assert.doesNotThrow(() => assertDefinitionShape(d));
  }
  for (const value of [
    { coin: fixed(), sourceOfTruth: [] }, { coin: fixed() },
    { ...selfCheck(), failureReceipt: receipt(['heads'], 1, 0, true) },
    { ...selfCheck(), passed: true },
  ]) {
    const d = clone(original); d.mechanics.attacks[0].failureCheck = value;
    assert.throws(() => assertDefinitionShape(d), `Reject malformed self-check ${JSON.stringify(value)}`);
  }
  await assert.rejects(() => fixture((defs) => {
    defs[0].mechanics.attacks[0].failureCheck = selfCheck(fixed(1, 2));
  }), /attainable/);
  await assert.rejects(() => fixture((defs) => {
    defs[0].mechanics.attacks[0].failureCheck = { coin: fixed(), sourceOfTruth: [
      { ...EVIDENCE[0], kind: 'official-rule' },
    ] };
  }), /evidence|definition/i);
  assert(!Object.hasOwn(original.mechanics.attacks[0], 'failureCheck'));
});

test('catalog admission rejects an unattainable attackCheck inside cn.lasting parameters before any game or payment', async () => {
  await assert.rejects(() => fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [binding('cn.lasting@1', lasting(imposed(fixed(1, 2))))];
    assert.doesNotThrow(() => assertDefinitionShape(defs[0]), 'Cross-field attainability is an execution-admission check, not just JSON shape.');
  }), (e) => e instanceof TypeError && /attainable/.test(e.message));
});

test('pure: coin descriptors are explicit, attainable, safe positive integers and immutable', () => {
  for (const coin of [fixed(), fixed(3, 2), fixed(Number.MAX_SAFE_INTEGER, 1),
    untilTails(), untilTails(Number.MAX_SAFE_INTEGER)]) {
    const before = clone(coin); assert.doesNotThrow(() => assertFailureCoin(freeze(coin))); assert.deepEqual(coin, before);
  }
  for (const coin of [
    undefined, null, false, 'heads', [], {}, { mode: 'fixed' }, { mode: 'untilTails' },
    { count: 1, minimumHeads: 1 }, { mode: 'heads', count: 1, minimumHeads: 1 },
    fixed(0), fixed(-1), fixed(1.5), fixed(Number.MAX_SAFE_INTEGER + 1),
    fixed(2, 0), fixed(2, -1), fixed(2, 1.5), fixed(2, 3), fixed(2, Infinity),
    fixed(2, NaN), untilTails(0), untilTails(-1), untilTails(1.5),
    untilTails(Number.MAX_SAFE_INTEGER + 1), { ...untilTails(), count: 2 },
    { ...fixed(), group: 'not-a-coin-property' }, { ...fixed(), result: 'heads' },
  ]) assert.throws(() => assertFailureCoin(coin), TypeError);
});

test('pure: fixed checks always roll the exact count, even after success or failure is already inevitable', () => {
  for (const [coin, outcomes, expected] of [
    [fixed(3, 2), [true, false, true], receipt(['heads', 'tails', 'heads'], 2, 1, true)],
    [fixed(3, 1), [true, false, false], receipt(['heads', 'tails', 'tails'], 1, 2, true)],
    [fixed(3, 3), [false, true, true], receipt(['tails', 'heads', 'heads'], 2, 1, false)],
    [fixed(), [false], receipt(['tails'], 0, 1, false)],
  ]) {
    const before = clone(coin), coins = freeze([...outcomes]); let calls = 0;
    assert.deepEqual(rollFailureCoin(freeze(coin), () => {
      assert(calls < coins.length, 'No extra random outcome may be consumed.'); return coins[calls++];
    }), expected);
    assert.equal(calls, coins.length); assert.deepEqual(coin, before);
  }
});

test('pure: until-Tails checks end only at the first Tails, without truncating 21+ consecutive Heads', () => {
  for (const [coin, outcomes, expected] of [
    [untilTails(), [false], receipt(['tails'], 0, 1, false)],
    [untilTails(2), [true, false], receipt(['heads', 'tails'], 1, 1, false)],
    [untilTails(2), [true, true, false], receipt(['heads', 'heads', 'tails'], 2, 1, true)],
    [untilTails(1), [...Array(32).fill(true), false], receipt([...Array(32).fill('heads'), 'tails'], 32, 1, true)],
    [untilTails(33), [...Array(32).fill(true), false], receipt([...Array(32).fill('heads'), 'tails'], 32, 1, false)],
  ]) {
    let calls = 0;
    assert.deepEqual(rollFailureCoin(freeze(coin), () => {
      assert(calls < outcomes.length, 'A terminal Tails must stop the check.'); return outcomes[calls++];
    }), expected);
    assert.equal(calls, outcomes.length);
  }
});

test('pure: flips must be actual booleans from an authoritative function; no truthiness or client outcomes', () => {
  for (const coin of [fixed(), untilTails()]) {
    for (const flip of [undefined, null, false, true, 0, [], { heads: true }])
      assert.throws(() => rollFailureCoin(coin, flip), TypeError);
    for (const result of [undefined, null, 0, 1, 'heads', 'tails', [], {}, new Boolean(true), Promise.resolve(true)])
      assert.throws(() => rollFailureCoin(coin, () => result), TypeError);
    const failure = new Error('randomness unavailable');
    assert.throws(() => rollFailureCoin(coin, () => { throw failure; }), (e) => e === failure);
  }
  let called = false;
  assert.throws(() => rollFailureCoin(fixed(1, 2), () => { called = true; return true; }), TypeError);
  assert.equal(called, false, 'Invalid reviewed conditions must fail before consuming randomness.');
});

test('pure: receipts are revalidated without rerolling; failed receipts are legal only when mustPass is false', () => {
  const good = freeze(receipt(['heads', 'tails', 'heads'], 2, 1, true));
  const bad = freeze(receipt(['tails', 'tails', 'heads'], 1, 2, false));
  assert.doesNotThrow(() => assertFailureReceipt(freeze(fixed(3, 2)), good));
  assert.doesNotThrow(() => assertFailureReceipt(fixed(3, 2), good, true));
  assert.doesNotThrow(() => assertFailureReceipt(fixed(3, 2), bad));
  assert.doesNotThrow(() => assertFailureReceipt(fixed(3, 2), bad, false));
  assert.doesNotThrow(() => assertFailureReceipt(fixed(3, 2), bad, undefined));
  assert.throws(() => assertFailureReceipt(fixed(3, 2), bad, true), TypeError);
  assert.doesNotThrow(() => assertFailureReceipt(undefined, null));
  assert.doesNotThrow(() => assertFailureReceipt(undefined, null, undefined));
  assert.doesNotThrow(() => assertFailureReceipt(undefined, null, true));
  for (const extra of [undefined, {}, good, bad, false, []])
    assert.throws(() => assertFailureReceipt(undefined, extra), TypeError);
  for (const invalidCoin of [null, false, true, 0, '', [], {}])
    assert.throws(() => assertFailureReceipt(invalidCoin, null), TypeError);
  for (const policy of [null, 0, 1, '', 'false', 'true', [], {}, new Boolean(false)]) {
    assert.throws(() => assertFailureReceipt(fixed(3, 2), good, policy), TypeError);
    assert.throws(() => assertFailureReceipt(fixed(3, 2), bad, policy), TypeError);
    assert.throws(() => assertFailureReceipt(undefined, null, policy), TypeError);
  }
  assert.deepEqual(good, receipt(['heads', 'tails', 'heads'], 2, 1, true));
});

test('pure: fixed receipts reject forged counts, pass flags, unknown properties and extra or missing flips', () => {
  for (const value of [
    undefined, null, false, [], {},
    receipt([], 0, 0, false), receipt(['heads'], 1, 0, true),
    receipt(['heads', 'heads', 'heads', 'tails'], 3, 1, true),
    receipt(['heads', 'tails', 'heads'], 1, 1, true),
    receipt(['heads', 'tails', 'heads'], 2, 0, true),
    receipt(['heads', 'tails', 'heads'], 2, 1, false),
    receipt(['tails', 'tails', 'heads'], 1, 2, true),
    receipt(['heads', 'tails', 'heads'], -1, 1, true),
    receipt(['heads', 'tails', 'heads'], 2, 1.5, true),
    receipt(['heads', 'tails', 'heads'], 2, 1, 'true'),
    receipt(['heads', 'tails', 'Heads'], 2, 1, true),
    receipt(['heads', 'tails', true], 2, 1, true),
    { ...receipt(['heads', 'tails', 'heads'], 2, 1, true), coin: fixed(3, 2) },
    { results: ['heads', 'tails', 'heads'], heads: 2, passed: true },
  ]) assert.throws(() => assertFailureReceipt(fixed(3, 2), value), TypeError);
  assert.throws(() => assertFailureReceipt(fixed(1, 2), receipt(['heads'], 1, 0, true)), TypeError);
});

test('pure: until-Tails receipts reject a premature Tails, post-terminal flips and an unterminated run', () => {
  for (const [coin, r] of [
    [untilTails(), receipt(['tails'], 0, 1, false)],
    [untilTails(2), receipt(['heads', 'tails'], 1, 1, false)],
    [untilTails(2), receipt(['heads', 'heads', 'tails'], 2, 1, true)],
    [untilTails(32), receipt([...Array(32).fill('heads'), 'tails'], 32, 1, true)],
  ]) {
    const before = clone(r); assert.doesNotThrow(() => assertFailureReceipt(freeze(coin), freeze(r)));
    assert.deepEqual(r, before);
  }
  for (const value of [
    receipt(['heads'], 1, 0, true), receipt(Array(32).fill('heads'), 32, 0, true),
    receipt(['tails', 'heads', 'tails'], 1, 2, true),
    receipt(['heads', 'tails', 'tails'], 1, 2, true),
    receipt(['tails', 'heads'], 1, 1, true),
    receipt(['heads', 'heads', 'tails'], 1, 2, true),
  ]) assert.throws(() => assertFailureReceipt(untilTails(), value), TypeError);
  assert.throws(() => assertFailureReceipt(untilTails(3), receipt(['heads', 'heads', 'tails'], 2, 1, false), true), TypeError);
});

test('pure: imposed checks preserve entries and sources, merging only an explicit equivalent group', () => {
  assert.deepEqual(groupImposedChecks(freeze([])), []);
  const one = freeze([{ id: 'e1', spec: imposed(), source: { instanceId: 'a' } }]);
  assert.deepEqual(groupImposedChecks(one), one);
  const entries = freeze([
    { id: 'e1', spec: imposed(fixed(2, 1), { group: 'reviewed:one-check' }), source: { instanceId: 'a' } },
    { id: 'e2', spec: imposed(fixed(2, 1), { group: 'reviewed:one-check' }), source: { instanceId: 'b' } },
  ]), before = clone(entries);
  assert.deepEqual(groupImposedChecks(entries), entries); assert.deepEqual(entries, before);
  assert.throws(() => groupImposedChecks([{ id: 'bad', spec: imposed(fixed(1, 2)) }]), TypeError);
});

test('pure: equivalent conditions do not depend on JSON property insertion order', () => {
  const entries = freeze([
    { id: 'a', spec: imposed(fixed(2, 1), { group: 'same' }) },
    { id: 'b', spec: imposed({ minimumHeads: 1, count: 2, mode: 'fixed' }, { group: 'same' }) },
  ]);
  assert.deepEqual(groupImposedChecks(entries), entries);
});

test('pure: distinct imposed groups and conflicting same-group conditions await CN ordering evidence', () => {
  for (const [first, second] of [
    [imposed(), imposed()],
    [imposed(fixed(), { group: 'a' }), imposed(fixed(), { group: 'b' })],
    [imposed(fixed(), { group: 'a' }), imposed()],
    [imposed(fixed(), { group: 'entry:b' }), imposed()],
    [imposed(fixed(), { group: 'a' }), imposed(fixed(2, 1), { group: 'a' })],
    [imposed(fixed(2, 1), { group: 'a' }), imposed(fixed(2, 2), { group: 'a' })],
    [imposed(fixed(), { group: 'a' }), imposed(untilTails(), { group: 'a' })],
  ]) {
    const entries = freeze([{ id: 'a', spec: first }, { id: 'b', spec: second }]), before = clone(entries);
    assert.throws(() => groupImposedChecks(entries), TypeError); assert.deepEqual(entries, before);
  }
});

test('pure: repeated entry IDs are not an implicit reviewed nonstacking group', () => {
  assert.throws(() => groupImposedChecks([
    { id: 'same-untrusted-id', spec: imposed() }, { id: 'same-untrusted-id', spec: imposed() },
  ]), TypeError);
});

test('self-failure is still a used GX/VSTAR, but no damage, bonus, counters, condition, heal or draw is executed', async () => {
  for (const specialRule of [undefined, 'GX', 'VSTAR']) for (const passed of [false, true]) {
    const f = await fixture((defs) => {
      defs[0].mechanics.hp = defs[1].mechanics.hp = 300;
      const a = defs[0].mechanics.attacks[0]; a.failureCheck = selfCheck();
      if (specialRule) a.specialRule = specialRule;
      a.effects = [
        binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 20, selection: { kind: 'all' }, options: {} }),
        binding('cn.counters@1', { side: 'opponent', target: 'active', count: 1 }),
        binding('cn.condition@1', { side: 'opponent', condition: 'poisoned', poisonCounters: 1 }),
        binding('cn.heal@1', { target: 'self', amount: 20 }),
        binding('cn.draw@1', { count: 2 }),
      ];
    });
    const g = withCoins(f, [passed], (s) => {
      activeOther(s); bench(s, 1, 'other'); hold(s, 0, s.players[0].active);
      s.players[0].active.counters = 4;
      s.players[0].active.facts.lastUsedAttack = { turn: 2, attackId: 'base:strike' };
    }), before = g.snapshot(), printed = clone(f.catalog.definition('base')), definitions = clone(f.definitions);
    attack(g); settle(g);
    const s = g.snapshot(), p = s.players[0], foe = s.players[1];
    assert.equal(foe.active.counters, passed ? 7 : 0, '20 + Tool 30, plus one text counter and one Poison checkup only on success.');
    assert.equal(foe.bench[0].counters, passed ? 5 : 0, 'Bench damage and its attack bonus are also part of the failed text.');
    assert.equal(foe.active.conditions.poison, passed ? 1 : null);
    assert.equal(p.active.counters, passed ? 2 : 4);
    assert.equal(p.hand.length, before.players[0].hand.length + (passed ? 2 : 0));
    assert.equal(foe.hand.length, before.players[1].hand.length + 1, 'The next turn still begins normally.');
    assert.equal(p.gxUsed, specialRule === 'GX'); assert.equal(p.vstarUsed, specialRule === 'VSTAR');
    assert.deepEqual(p.active.facts.lastUsedAttack, { turn: 5, attackId: 'base:strike' });
    assert(!Object.hasOwn(p.active.facts, 'lastSuccessfulAttack'));
    assert.deepEqual(s.rng, consumed(before.rng, 1));
    assert.equal(s.current, 1); assert.equal(s.turn, 6); assert.equal(s.attack, null);
    assert.equal(s.events.slice(before.events.length).filter((e) => e.ruleId === 'turn.end').length, 1);
    if (!passed) assert(!s.events.slice(before.events.length).some((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage')));
    assert.deepEqual(f.catalog.definition('base'), printed); assert.deepEqual(f.definitions, definitions);
    assert.deepEqual(restore(g, f).snapshot(), s);
  }
});

test('seeded fixed and until-Tails self-checks consume exactly their own outcomes, independent of the success threshold', async () => {
  for (const [coin, coins, passed] of [
    [fixed(3, 2), [true, false, true], true],
    [fixed(3, 3), [false, true, true], false],
    [untilTails(2), [false], false],
    [untilTails(2), [true, false], false],
    [untilTails(2), [true, true, false], true],
  ]) {
    const f = await fixture((defs) => { defs[0].mechanics.attacks[0].failureCheck = selfCheck(coin); });
    const g = withCoins(f, coins), before = g.snapshot(); attack(g); settle(g);
    assert.deepEqual(g.snapshot().rng, consumed(before.rng, coins.length));
    assert.equal(g.snapshot().players[1].active.counters, passed ? 2 : 0);
    assert.deepEqual(g.snapshot().players[0].active.facts.lastUsedAttack, { turn: 5, attackId: 'base:strike' });
  }
});

async function imposedBoard(checks = [imposed()], victim = () => {}, options = {}) {
  const f = await fixture((defs) => {
    defs[0].mechanics.hp = defs[1].mechanics.hp = 300;
    defs[0].mechanics.attacks[0].printedDamage = null;
    defs[0].mechanics.attacks[0].effects = checks.map((spec, i) => binding('cn.lasting@1', lasting(spec, options), `check:${i}`));
    victim(defs[1].mechanics.attacks[0], defs);
  });
  const g = board(f, (s) => {
    activeOther(s); attached(s, 0, s.players[0].active, 'water'); attached(s, 1, s.players[1].active, 'water');
    s.players[1].active.facts.lastUsedAttack = { turn: 2, attackId: 'other:strike' };
  });
  attack(g); settle(g); assert.equal(g.snapshot().current, 1);
  return { f, g };
}

test('I.A-01 2-a imposed check precedes Confusion, which precedes self-failure and quota/usage/body resolution', async () => {
  for (const specialRule of ['GX', 'VSTAR']) for (const [coins, count, used, dealt, selfCounters, rules] of [
    [[false, true, true], 1, false, 0, 0, ['attack.failure.imposed']],
    [[true, false, true], 2, false, 0, 3, ['attack.failure.imposed', 'status.confusion']],
    [[true, true, false], 3, true, 0, 0, ['attack.failure.imposed', 'status.confusion', 'attack.failure.self']],
    [[true, true, true], 3, true, 2, 0, ['attack.failure.imposed', 'status.confusion', 'attack.failure.self']],
  ]) {
    const { f, g: applied } = await imposedBoard([imposed()], (a) => {
      a.failureCheck = selfCheck(); a.specialRule = specialRule; a.effects = [binding('cn.draw@1', { count: 2 })];
    });
    const state = applied.snapshot(); state.rng = seedFor(coins); state.players[1].active.conditions.rotation = 'confused';
    const g = OfficialGame.restore(state, { catalog: f.catalog }), before = g.snapshot();
    assert(g.view(1).legalActions.some((a) => a.attackId === 'other:strike'), 'An imposed conditional check is not a declaration prohibition.');
    attack(g, 'other:strike'); settle(g);
    const s = g.snapshot(), p = s.players[1], traces = s.events.slice(before.events.length);
    assert.deepEqual(s.rng, consumed(before.rng, count), 'A failed earlier check prevents all later flips.');
    assert.equal(p.active.counters, selfCounters); assert.equal(s.players[0].active.counters, dealt);
    assert.equal(p.gxUsed, used && specialRule === 'GX'); assert.equal(p.vstarUsed, used && specialRule === 'VSTAR');
    assert.deepEqual(p.active.facts.lastUsedAttack, { turn: used ? 6 : 2, attackId: 'other:strike' });
    assert.equal(p.hand.length, before.players[1].hand.length + (dealt ? 2 : 0));
    assert.deepEqual(traces.filter((e) => ['attack.failure.imposed', 'status.confusion', 'attack.failure.self'].includes(e.ruleId)).map((e) => e.ruleId), rules);
    assert.equal(s.current, 0); assert.equal(s.turn, 7); assert.equal(s.attack, null);
    assert.equal(traces.filter((e) => e.ruleId === 'turn.end').length, 1);
    assert.equal(s.ongoing.length, 0, 'nextOpponentTurn expires at this turn end, before checkup.');
    assert.deepEqual(restore(g, f).snapshot(), s);
  }
});

test('equivalent explicitly grouped imposed effects share one check; ungrouped or different groups do not gain an invented order', async () => {
  for (const sameGroup of [true, false]) {
    const checks = [imposed(fixed(), { group: 'one' }), imposed(fixed(), { group: sameGroup ? 'one' : 'two' })];
    const { f, g: applied } = await imposedBoard(checks);
    const state = applied.snapshot(); state.rng = seedFor([true, false]);
    const g = OfficialGame.restore(state, { catalog: f.catalog }), before = g.snapshot();
    if (!sameGroup) {
      assert.throws(() => attack(g, 'other:strike'), (e) => e.code === 'unsupported-attack-checks');
      assert.deepEqual(g.snapshot(), before, 'Unsupported ordering rejects atomically without a flip or usage.');
    } else {
      attack(g, 'other:strike'); settle(g);
      assert.deepEqual(g.snapshot().rng, consumed(before.rng, 1));
      assert.equal(g.snapshot().players[0].active.counters, 2);
      assert.equal(g.snapshot().events.slice(before.events.length).filter((e) => e.ruleId === 'attack.failure.imposed').length, 1);
    }
  }
  const { f, g: applied } = await imposedBoard([imposed(), imposed()]);
  const state = applied.snapshot(); state.rng = seedFor([true]);
  const g = OfficialGame.restore(state, { catalog: f.catalog }), before = g.snapshot();
  assert.throws(() => attack(g, 'other:strike'), (e) => e.code === 'unsupported-attack-checks');
  assert.deepEqual(g.snapshot(), before);
});

test('same-named imposed groups with different coin conditions reject atomically before any flip, quota or usage', async () => {
  for (const [first, second] of [
    [fixed(), fixed(2, 1)],
    [fixed(2, 1), fixed(2, 2)],
    [fixed(), untilTails()],
  ]) {
    const checks = [first, second].map((coin) => imposed(coin, { group: 'reviewed:conflicting-name' }));
    const { f, g: applied } = await imposedBoard(checks, (a) => {
      a.specialRule = 'GX'; a.failureCheck = selfCheck();
    });
    const state = applied.snapshot(); state.rng = seedFor([true, true, true]);
    state.players[1].active.conditions.rotation = 'confused';
    const g = OfficialGame.restore(state, { catalog: f.catalog }), before = g.snapshot();
    assert.equal(before.ongoing.length, 2);
    assert.throws(() => attack(g, 'other:strike'), (e) => e.code === 'unsupported-attack-checks');
    assert.deepEqual(g.snapshot(), before, 'A conflicting explicit group cannot choose one condition or consume even the first check.');
  }
});

test('Pokémon effect protection prevents imposing an attackCheck, while damage-only protection does not', async () => {
  for (const channel of ['effects', 'damage']) {
    const { f, g: applied } = await imposedBoard([imposed()], (_attack, defs) => {
      defs[0].mechanics.attacks[0].printedDamage = { value: 20, operator: 'fixed' };
      defs[1].mechanics.effects.push(binding('cn.protection@1', { effect: {
        op: 'protection', useRule: 'ordinary', scope: 'self', channel, from: 'opponent', categories: ['attack'],
      } }));
    });
    const protectedState = applied.snapshot(), protectedId = protectedState.players[1].active.id;
    assert.equal(protectedState.players[1].active.counters, channel === 'effects' ? 2 : 0,
      'Damage and persistent effect prevention must use separate channels.');
    assert.equal(protectedState.ongoing.length, channel === 'effects' ? 0 : 1);
    assert.equal(protectedState.events.some((e) => e.ruleId === 'effects.protection' && e.data.targetId === protectedId), channel === 'effects');
    protectedState.rng = seedFor([false]);
    const g = OfficialGame.restore(protectedState, { catalog: f.catalog }), before = g.snapshot();
    attack(g, 'other:strike'); settle(g);
    const s = g.snapshot(), wasEffectProtected = channel === 'effects';
    assert.deepEqual(s.rng, wasEffectProtected ? before.rng : consumed(before.rng, 1));
    assert.equal(s.players[0].active.counters, wasEffectProtected ? 2 : 0,
      'A blocked imposed condition must not resurface as a declaration failure next turn.');
    assert.deepEqual(s.players[1].active.facts.lastUsedAttack, wasEffectProtected ?
      { turn: 6, attackId: 'other:strike' } : before.players[1].active.facts.lastUsedAttack);
    assert.equal(s.events.slice(before.events.length).filter((e) => e.ruleId === 'attack.failure.imposed').length, wasEffectProtected ? 0 : 1);
    assert.equal(s.ongoing.length, 0); assert.equal(s.current, 0);
  }
});

test('imposed checks obey explicit Bench/evolution clearing and do not become part of the printed attack', async () => {
  for (const transition of ['retreat', 'evolve']) for (const clears of [true, false]) {
    const f = await fixture((defs) => {
      defs[0].mechanics.attacks[0].printedDamage = null;
      defs[0].mechanics.attacks[0].effects = [binding('cn.lasting@1', lasting(imposed(), {
        clearOnBench: clears, clearOnEvolution: clears,
      }))];
    });
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); attached(s, 1, s.players[1].active, 'water');
      bench(s, 1, 'other'); hand(s, 1, 'evolution');
    });
    const printed = clone(f.catalog.definition('base')); attack(g); settle(g);
    assert.equal(g.snapshot().ongoing.length, 1);
    assert.deepEqual(restore(g, f).view(1), g.view(1));
    if (transition === 'retreat') {
      command(g, { type: 'retreat' }); answer(g, g.snapshot().pending.options); settle(g);
    } else {
      const action = g.view(1).legalActions.find((a) => a.type === 'evolve' && a.pokemonId === g.snapshot().players[1].active.id);
      assert(action); command(g, action);
    }
    assert.equal(g.snapshot().ongoing.length, clears ? 0 : 1);
    assert.deepEqual(f.catalog.definition('base'), printed);
    assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  }
});

test('an unused next-opponent-turn imposed check still expires without consuming random outcomes', async () => {
  const { f, g } = await imposedBoard(), before = g.snapshot();
  end(g);
  assert.equal(g.snapshot().ongoing.length, 0); assert.deepEqual(g.snapshot().rng, before.rng);
  assert(g.snapshot().events.slice(before.events.length).some((e) => e.data.expiredAt === 'turn-end'));
  assert.deepEqual(g.snapshot().players[1].active.facts.lastUsedAttack, before.players[1].active.facts.lastUsedAttack);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
});

test('own and imposed failure still end the turn and check Poison on both sides, without executing attack text', async () => {
  for (const kind of ['self', 'imposed']) {
    let f, g;
    if (kind === 'self') {
      f = await fixture((defs) => {
        const a = defs[0].mechanics.attacks[0]; a.failureCheck = selfCheck(); a.specialRule = 'GX';
        a.effects = [binding('cn.draw@1', { count: 3 })];
      });
      g = withCoins(f, [false], (s) => {
        s.players[0].active.facts.lastUsedAttack = { turn: 2, attackId: 'base:strike' };
      });
    } else {
      ({ f, g } = await imposedBoard([imposed()], (a) => {
        a.specialRule = 'GX'; a.effects = [binding('cn.draw@1', { count: 3 })];
      }));
    }
    const state = g.snapshot(), owner = state.current, foe = 1 - owner;
    state.rng = seedFor([false, true]);
    state.players[owner].active.conditions.poison = 2;
    state.players[foe].active.conditions.poison = 1;
    if (kind === 'imposed') state.players[owner].active.conditions.rotation = 'confused';
    g = OfficialGame.restore(state, { catalog: f.catalog });
    const before = g.snapshot(); attack(g, kind === 'self' ? 'base:strike' : 'other:strike'); settle(g);
    const s = g.snapshot(), p = s.players[owner], q = s.players[foe], traces = s.events.slice(before.events.length);
    assert.equal(p.active.counters, 2, 'Poison is checkup damage, not the failed attack or a skipped Confusion roll.');
    assert.equal(q.active.counters, 1);
    assert.equal(p.hand.length, before.players[owner].hand.length, 'No attack draw is performed.');
    assert.equal(q.hand.length, before.players[foe].hand.length + 1, 'The following normal turn draws one card.');
    assert.equal(p.gxUsed, kind === 'self');
    assert.deepEqual(p.active.facts.lastUsedAttack, kind === 'self' ? { turn: 5, attackId: 'base:strike' } :
      before.players[owner].active.facts.lastUsedAttack);
    assert.deepEqual(s.rng, consumed(before.rng, 1), 'The imposed failure prevents the following Confusion flip.');
    const turnEnd = traces.findIndex((e) => e.ruleId === 'turn.end');
    const poison = traces.map((e, i) => ({ e, i })).filter(({ e }) => e.ruleId === 'status.poison');
    const checkupEnd = traces.findIndex((e) => e.ruleId === 'checkup.order');
    assert.equal(poison.length, 2); assert(poison.every(({ i }) => i > turnEnd && i < checkupEnd));
    assert.equal(s.current, foe); assert.equal(s.turn, before.turn + 1); assert.equal(s.attack, null);
    assert.deepEqual(restore(g, f).snapshot(), s);
  }
});

test('a passed self-check is persisted through a pending effect and must match the exact approved attack on restore', async () => {
  for (const coin of [fixed(3, 2), untilTails(2)]) {
    const coins = coin.mode === 'fixed' ? [true, false, true] : [true, true, false];
    const expected = coin.mode === 'fixed' ? receipt(['heads', 'tails', 'heads'], 2, 1, true) :
      receipt(['heads', 'heads', 'tails'], 2, 1, true);
    const f = await fixture((defs) => {
      const a = defs[0].mechanics.attacks[0]; a.failureCheck = selfCheck(coin);
      a.effects = [binding('cn.heal@1', { target: 'self', amount: 10 }), binding('cn.draw@1', { count: 1 })];
    });
    const g = withCoins(f, coins, (s) => { s.players[0].active.counters = 2; }); attack(g);
    assert.equal(g.snapshot().pending.kind, 'effect-target');
    assert.deepEqual(g.snapshot().attack.execution.failureReceipt, expected);
    const r = restore(g, f); assert.deepEqual(r.snapshot(), g.snapshot());
    for (const mutate of [
      (s) => { s.attack.execution.failureReceipt = null; },
      (s) => { delete s.attack.execution.failureReceipt; },
      (s) => { s.attack.execution.failureReceipt.heads++; },
      (s) => { s.attack.execution.failureReceipt.tails++; },
      (s) => { s.attack.execution.failureReceipt.passed = false; },
      (s) => { s.attack.execution.failureReceipt.results.push('tails'); },
      (s) => { s.attack.execution.failureReceipt.extra = true; },
      (s) => { s.attack.attack.failureCheck.coin.minimumHeads = 1; },
    ]) {
      const bad = g.snapshot(); mutate(bad);
      assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /receipt|failure|attack|schema|condition/i);
    }
    settle(g); settle(r); assert.deepEqual(r.snapshot(), g.snapshot());
    assert.deepEqual(g.snapshot().rng, consumed(seedFor(coins), coins.length), 'Restoring or answering may not reroll a passed check.');
  }
});

test('attacks without a self-check save a null receipt, and clients cannot add outcomes or the obsolete success-only fact', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [binding('cn.heal@1', { target: 'self', amount: 10 })];
  });
  const g = withCoins(f, [true], (s) => { s.players[0].active.counters = 2; }), before = g.snapshot();
  assert.throws(() => command(g, { type: 'attack', attackId: 'base:strike', failureReceipt: receipt(['heads'], 1, 0, true) }));
  assert.deepEqual(g.snapshot(), before);
  const old = g.snapshot(); old.players[0].active.facts.lastSuccessfulAttack = { turn: 2, attackId: 'base:strike' };
  assert.throws(() => OfficialGame.restore(old, { catalog: f.catalog }), /schema/i);
  attack(g); assert.equal(g.snapshot().attack.execution.failureReceipt, null);
  const forged = g.snapshot(); forged.attack.execution.failureReceipt = receipt(['heads'], 1, 0, true);
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), /receipt|failure|attack/i);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
});

test('static Tool and dynamic Ability grants use the same self-failure, actual-user usage and GX/VSTAR rules', async () => {
  for (const provider of ['tool', 'ability']) for (const passed of [false, true]) {
    const specialRule = provider === 'tool' ? 'GX' : 'VSTAR', id = provider === 'tool' ? 'tool:check' : 'other:strike';
    const f = await fixture((defs) => {
      const content = clone(defs[1].mechanics.attacks[0]);
      Object.assign(content, { attackId: id, specialRule, failureCheck: selfCheck(), effects: [
        binding('cn.heal@1', { target: 'self', amount: 10 }), binding('cn.draw@1', { count: 2 }),
      ] });
      if (provider === 'tool') defs.find((d) => d.definitionId === 'tool').mechanics.grantedAttacks = [content];
      else {
        defs[1].mechanics.attacks[0] = content;
        defs[0].mechanics.abilities = [{ abilityId: 'grant', name: '测试失败检查授予', mode: 'continuous', usage: null,
          sourceOfTruth: EVIDENCE, effects: [binding('cn.attackGrant@1', {
            op: 'attackGrant', scope: 'self', targetSelector: { kind: 'pokemon' },
            origins: [{ side: 'own', zone: 'discard', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
            excludeUser: false,
          })] }];
      }
    });
    const g = withCoins(f, [passed], (s) => {
      s.players[0].active.counters = 2;
      if (provider === 'tool') hold(s, 0, s.players[0].active);
      else { const card = hand(s, 0, 'other'); s.players[0].hand.pop(); s.players[0].discard.push(card); }
    }), before = g.snapshot(), printed = clone(f.catalog.definition('base'));
    const action = g.view(0).legalActions.find((a) => a.type === 'attack' && a.attackId === id); assert(action);
    command(g, action);
    if (passed) {
      assert.deepEqual(g.snapshot().attack.execution.failureReceipt, receipt(['heads'], 1, 0, true));
      const r = restore(g, f); settle(g); settle(r); assert.deepEqual(r.snapshot(), g.snapshot());
    } else settle(g);
    const s = g.snapshot(), p = s.players[0];
    assert.equal(s.players[1].active.counters, passed ? provider === 'tool' ? 5 : 2 : 0);
    assert.equal(p.active.counters, passed ? 1 : 2);
    assert.equal(p.hand.length, before.players[0].hand.length + (passed ? 2 : 0));
    assert.deepEqual(p.active.facts.lastUsedAttack, { turn: 5, attackId: id });
    assert.equal(p.gxUsed, specialRule === 'GX'); assert.equal(p.vstarUsed, specialRule === 'VSTAR');
    assert.deepEqual(s.rng, consumed(before.rng, 1)); assert.equal(s.current, 1);
    assert.deepEqual(f.catalog.definition('base'), printed);
    assert(!s.events.slice(before.events.length).some((e) => e.ruleId === 'attack.copy'), 'A grant is not implemented as copying.');
  }
});

test('an imposed failure on the actual user prevents a granted self-check and preserves its unused VSTAR quota', async () => {
  const { f, g: applied } = await imposedBoard([imposed()], (a, defs) => {
    const granted = clone(a);
    Object.assign(granted, { attackId: 'tool:imposed-check', specialRule: 'VSTAR', failureCheck: selfCheck() });
    defs.find((d) => d.definitionId === 'tool').mechanics.grantedAttacks = [granted];
  });
  const state = applied.snapshot(); hold(state, 1, state.players[1].active);
  state.rng = seedFor([false, true]); state.players[1].active.conditions.rotation = 'confused';
  const g = OfficialGame.restore(state, { catalog: f.catalog }), before = g.snapshot();
  assert(g.view(1).legalActions.some((a) => a.attackId === 'tool:imposed-check'));
  attack(g, 'tool:imposed-check'); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].vstarUsed, false);
  assert.deepEqual(s.players[1].active.facts.lastUsedAttack, before.players[1].active.facts.lastUsedAttack);
  assert.equal(s.players[1].active.counters, 0, 'The Confusion check was not reached.');
  assert.equal(s.players[0].active.counters, 0, 'A Tool damage bonus cannot revive failed damage.');
  assert.deepEqual(s.rng, consumed(before.rng, 1));
  assert(!s.events.slice(before.events.length).some((e) => e.ruleId === 'attack.failure.self'));
  assert.equal(s.current, 0);
});

test('C-18 copied self-failure keeps the original used identity and ends the entire attack only once', async () => {
  for (const passed of [false, true]) {
    const f = await fixture((defs) => {
      const root = copier(defs); root.specialRule = 'GX';
      defs[1].mechanics.attacks[0].failureCheck = selfCheck();
      defs[1].mechanics.attacks[0].effects = [binding('cn.draw@1', { count: 1 })];
    });
    const g = withCoins(f, [passed], (s) => activeOther(s)), before = g.snapshot();
    attack(g); assert.deepEqual(g.snapshot().rng, before.rng, 'The selected content has not run at the copy prompt.');
    assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
    chooseCopy(g); settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, passed ? 2 : 0);
    assert.equal(s.players[0].hand.length, before.players[0].hand.length + (passed ? 1 : 0));
    assert.deepEqual(s.players[0].active.facts.lastUsedAttack, { turn: 5, attackId: 'base:strike' });
    assert.equal(s.players[0].gxUsed, true); assert.equal(s.players[1].gxUsed, false);
    assert.equal(s.players[1].active.facts.lastUsedAttack, undefined);
    assert.deepEqual(s.rng, consumed(before.rng, 1)); assert.equal(s.attack, null); assert.equal(s.current, 1);
    assert.equal(s.events.slice(before.events.length).filter((e) => e.ruleId === 'turn.end').length, 1);
  }
});

test('a pure 24-level C-18 chain reaches a failing printed attack without fabricated rollback or a twenty-level cap', async () => {
  const f = await fixture((defs) => {
    copier(defs, { attackIds: ['other:strike'] });
    const inner = defs[1].mechanics.attacks[0], finish = clone(inner);
    finish.attackId = 'other:finish'; finish.failureCheck = selfCheck();
    finish.effects = [binding('cn.draw@1', { count: 3 })];
    inner.printedDamage = null;
    inner.effects = [binding('cn.copyAttack@1', copySpec({ attackIds: ['other:strike', 'other:finish'] }))];
    defs[1].mechanics.attacks.push(finish);
  });
  const g = withCoins(f, [false], (s) => activeOther(s)), before = g.snapshot();
  attack(g);
  for (let i = 0; i < 24; i++) {
    chooseCopy(g); assert.equal(g.snapshot().attack.copies.length, i + 1);
    assert.equal(g.snapshot().pending.kind, 'copy-attack');
  }
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  chooseCopy(g, 'other:finish'); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.counters, 0); assert.equal(s.players[0].hand.length, before.players[0].hand.length);
  assert.deepEqual(s.players[0].active.facts.lastUsedAttack, { turn: 5, attackId: 'base:strike' });
  assert.equal(s.events.slice(before.events.length).filter((e) => e.ruleId === 'attack.copy' && e.data.kind === 'selected').length, 25);
  assert.equal(s.events.slice(before.events.length).filter((e) => e.ruleId === 'turn.end').length, 1);
  assert.deepEqual(s.rng, consumed(before.rng, 1)); assert.equal(s.attack, null); assert.equal(s.current, 1);
});

test('a pure copy gate may flip before the borrowed self-check, including a zero printed-damage ancestor', async () => {
  for (const passed of [false, true]) {
    const f = await fixture((defs) => {
      const root = copier(defs, { coin: 'heads' }); root.printedDamage = { value: 0, operator: 'fixed' };
      defs[1].mechanics.attacks[0].failureCheck = selfCheck();
    });
    const g = withCoins(f, [true, passed], (s) => activeOther(s)), before = g.snapshot();
    attack(g); assert.equal(g.snapshot().pending.kind, 'copy-attack');
    assert.deepEqual(g.snapshot().rng, consumed(before.rng, 1));
    const r = restore(g, f); chooseCopy(g); chooseCopy(r); settle(g); settle(r);
    assert.deepEqual(r.snapshot(), g.snapshot());
    assert.deepEqual(g.snapshot().rng, consumed(before.rng, 2));
    assert.equal(g.snapshot().players[1].active.counters, passed ? 2 : 0);
    assert.deepEqual(g.snapshot().players[0].active.facts.lastUsedAttack, { turn: 5, attackId: 'base:strike' });
    assert.equal(g.snapshot().events.slice(before.events.length).filter((e) => e.ruleId === 'turn.end').length, 1);
  }
});

test('copied self-check receipts match selected content, including when the root attack has no check', async () => {
  const f = await fixture((defs) => {
    copier(defs); defs[1].mechanics.attacks[0].failureCheck = selfCheck(fixed(2, 2));
    defs[1].mechanics.attacks[0].effects = [binding('cn.heal@1', { target: 'self', amount: 10 })];
  });
  const g = withCoins(f, [true, true], (s) => { activeOther(s); s.players[0].active.counters = 2; });
  attack(g); chooseCopy(g); assert.equal(g.snapshot().pending.kind, 'effect-target');
  assert.deepEqual(g.snapshot().attack.execution.failureReceipt, receipt(['heads', 'heads'], 2, 0, true));
  assert.equal(g.snapshot().attack.copies[0].execution.failureReceipt, null);
  for (const mutate of [
    (s) => { s.attack.execution.failureReceipt = receipt(['heads'], 1, 0, true); },
    (s) => { s.attack.execution.failureReceipt = null; },
    (s) => { s.attack.copies[0].execution.failureReceipt = receipt(['heads'], 1, 0, true); },
    (s) => { s.attack.execution.failureReceipt.results[0] = 'tails'; s.attack.execution.failureReceipt.heads = 1; s.attack.execution.failureReceipt.tails = 1; s.attack.execution.failureReceipt.passed = false; },
  ]) {
    const bad = g.snapshot(); mutate(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /receipt|failure|attack|condition/i);
  }
  const r = restore(g, f); settle(g); settle(r); assert.deepEqual(r.snapshot(), g.snapshot());
  assert.deepEqual(g.snapshot().rng, consumed(seedFor([true, true]), 2));
});

test('copying failure-prone content after an already performed effect or damage explicitly rejects unresolved timing', async () => {
  for (const previous of ['damage', 'draw']) for (const nextCoin of [false, true]) {
    const f = await fixture((defs) => {
      const root = copier(defs);
      if (previous === 'damage') root.printedDamage = { value: 20, operator: 'fixed' };
      else root.effects.unshift(binding('cn.draw@1', { count: 1 }));
      defs[1].mechanics.attacks[0].failureCheck = selfCheck();
    });
    const g = withCoins(f, [nextCoin], (s) => activeOther(s)), before = g.snapshot();
    attack(g); assert.equal(g.snapshot().pending.kind, 'copy-attack');
    assert.equal(g.snapshot().players[1].active.counters, previous === 'damage' ? 2 : 0);
    assert.equal(g.snapshot().players[0].hand.length, before.players[0].hand.length + (previous === 'draw' ? 1 : 0));
    const checkpoint = g.snapshot();
    assert.throws(() => chooseCopy(g), (e) => e.code === 'unresolved-copy-failure');
    assert.deepEqual(g.snapshot(), checkpoint, 'Reject only the attempted answer; do not invent rollback of the previously committed phase.');
  }
});

test('unreviewed mixed copy bindings reject borrowed failure even if the extra binding would have run later', async () => {
  const f = await fixture((defs) => {
    copier(defs).effects.push(binding('cn.draw@1', { count: 1 }));
    defs[1].mechanics.attacks[0].failureCheck = selfCheck();
  });
  const g = withCoins(f, [false], (s) => activeOther(s)); attack(g);
  const before = g.snapshot();
  assert.throws(() => chooseCopy(g), (e) => e.code === 'unresolved-copy-failure');
  assert.deepEqual(g.snapshot(), before, 'Unsupported cancellation scope is rejected before the borrowed self-check flip.');
});

test('self-failure combined with beforeDamage effects requires explicit reviewed timing, not a guessed ordering', async () => {
  const h = reviewed({ timing: 'beforeDamage', operations: ['draw'], execute: () => [{ op: 'draw', count: 1 }] });
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].failureCheck = selfCheck();
    defs[0].mechanics.attacks[0].effects = [binding('fixture:before-failure-timing', {})];
  }, new Map([['fixture:before-failure-timing', h]]));
  assert.throws(() => {
    const g = withCoins(f, [true]), before = g.snapshot();
    try { attack(g); }
    catch (e) { assert.deepEqual(g.snapshot(), before, 'An unresolved timing rejection is atomic.'); throw e; }
  }, (e) => e.code === 'unsupported-failure-timing');
});
