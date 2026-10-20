// Real OfficialGame tests with synthetic card definitions/printings only.
// Coin receipts and successful fixtures are not production card approvals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { randomIndex } from '../../public/rules/random.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached,
} from './fixtures.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const lit = (value) => ({ kind: 'literal', value });
const coin = (key, field = 'heads') => ({ kind: 'coin', key, field });
const stat = (field, who = 'self') => ({ kind: 'pokemon', who, field });
const add = (...terms) => ({ kind: 'add', terms });
const mul = (left, right) => ({ kind: 'multiply', left, right });
const fixed = (key, count, extra = {}) => ({ key, spec: { kind: 'fixed', count }, ...extra });
const formula = (expression, rolls, id = 'coin-formula') => binding('cn.damageValue@1', { expression, rolls }, id);
const packet = (amount, rolls = [], extra = {}) => ({
  side: 'opponent', target: 'bench', amount, rolls, selection: { kind: 'exact', count: 1 }, options: {}, ...extra,
});
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const damageEvents = (g, from) => g.snapshot().events.slice(from).filter((e) =>
  e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'));
const publicCoins = (s, from) => s.events.slice(from).filter((e) => e.ruleId === 'damage.coins' && e.visibility === 'public');
function otherActive(s) {
  const p = s.players[1], old = p.active;
  p.hand.push(...old.stack, ...old.energy, ...old.tools);
  p.active = bench(s, 1, 'other'); p.bench.pop(); return p.active;
}
function hold(s, m) {
  const id = hand(s, 0, 'tool'); s.players[0].hand.pop(); m.tools.push(id); return id;
}
async function make(transform) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) {
      d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null;
    }
    transform(defs);
  });
}
function assertAtomic(g, fn, predicate = undefined) {
  const before = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(fn, predicate);
  assert.deepEqual(g.snapshot(), before);
  assert.deepEqual([g.view(0), g.view(1)], views);
}

// Independent oracle uses only the real low-level RNG, not rollDamageCoin,
// preparation, receipts or runtime coin leaf evaluation. Bounds below only
// guard fixture seed search/oracle execution; they impose no gameplay cap.
function seedFor(prefix) {
  for (let i = 1; i <= 8192; i++) {
    const seed = [Math.imul(i, 8000009) >>> 0, Math.imul(i, 333333331) >>> 0,
      Math.imul(i, 17) >>> 0, Math.imul(i, 37) >>> 0], rng = [...seed];
    if (prefix.every((outcome) => (randomIndex(rng, 2) === 0 ? 'heads' : 'tails') === outcome)) return seed;
  }
  throw Error('Test seed search did not find the requested finite prefix.');
}
function oracle(seed, count = null) {
  const rng = [...seed], results = [];
  while (count === null ? results.at(-1) !== 'tails' : results.length < count) {
    assert(results.length < 1024, 'Fixture oracle guard, not a production flip cap');
    results.push(randomIndex(rng, 2) === 0 ? 'heads' : 'tails');
  }
  const heads = results.reduce((n, outcome) => n + Number(outcome === 'heads'), 0);
  return { rng, results, heads, tails: results.length - heads, flips: results.length };
}
function setup(f, prefix, mutate = () => {}) {
  return board(f, (s) => {
    otherActive(s); attached(s, 0, s.players[0].active, 'water');
    mutate(s); s.rng = seedFor(prefix);
  });
}

test('fixed N, including zero, exposes exact heads/tails/flips arithmetic without changing null/times/fixed printing; zero is not revived by a Tool', async () => {
  for (const [count, printedDamage, prefix] of [
    [0, { value: 20, operator: 'fixed' }, []],
    [3, { value: 30, operator: 'times' }, ['heads', 'tails', 'heads']],
    [3, null, ['heads', 'tails', 'heads']],
    [5, { value: 90, operator: 'fixed' }, ['heads', 'tails', 'heads', 'tails', 'tails']],
  ]) {
    const expression = add(mul(coin('damage'), lit(30)), mul(coin('damage', 'tails'), lit(10)), mul(coin('damage', 'flips'), lit(10)));
    const f = await make((defs) => {
      defs[0].mechanics.attacks[0].printedDamage = clone(printedDamage);
      defs[0].mechanics.attacks[0].effects = [formula(expression, [fixed('damage', count)])];
    });
    const g = setup(f, prefix, (s) => { if (count === 0) hold(s, s.players[0].active); });
    const before = g.snapshot(), expected = oracle(before.rng, count), printed = clone(f.catalog.definition('base'));
    attack(g); settle(g);
    const amount = expected.heads * 30 + expected.tails * 10 + expected.flips * 10;
    assert.equal(g.snapshot().players[1].active.counters, amount / 10);
    assert.deepEqual(g.snapshot().rng, expected.rng);
    assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [amount]);
    assert.deepEqual(f.catalog.definition('base'), printed);
    assert.deepEqual(printed.mechanics.attacks[0].printedDamage, printedDamage);
    const published = publicCoins(g.snapshot(), before.events.length);
    assert.equal(published.length, 1, 'a real zero-count roll is a record, not a skipped key');
    assert.deepEqual(published[0].data.receipt, {
      spec: { kind: 'fixed', count }, results: expected.results, heads: expected.heads, tails: expected.tails, flips: count,
    });
    assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  }
});

test('untilTails stops at the first actual tails and supplies heads ×30, including an immediate-tail zero', async () => {
  for (const prefix of [['tails'], ['heads', 'heads', 'tails']]) {
    const f = await make((defs) => {
      defs[0].mechanics.attacks[0].printedDamage = { value: 30, operator: 'times' };
      defs[0].mechanics.attacks[0].effects = [formula(mul(coin('chain'), lit(30)), [{ key: 'chain', spec: { kind: 'untilTails' } }])];
    });
    const g = setup(f, prefix), before = g.snapshot(), expected = oracle(before.rng);
    attack(g); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, expected.heads * 3);
    assert.deepEqual(g.snapshot().rng, expected.rng);
    assert.equal(expected.tails, 1); assert.equal(expected.results.at(-1), 'tails');
    assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [expected.heads * 30]);
    const published = publicCoins(g.snapshot(), before.events.length);
    assert.equal(published.length, 1);
    assert.deepEqual(published[0].data.receipt, {
      spec: { kind: 'untilTails' }, results: expected.results, heads: expected.heads, tails: 1, flips: expected.flips,
    });
  }
});

test('dynamic fixed count uses effective Energy units, not physical Energy cards or printed base provision', async () => {
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].effects = [
      formula(mul(coin('units', 'flips'), lit(10)), [fixed('units', stat('energyUnits'))]),
    ];
    defs[0].mechanics.abilities.push({
      abilityId: 'three-water', name: '测试当前供能', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.energyProvision@1', { effect: {
        op: 'energyProvision', scope: 'self', cardSelf: false, selector: { kind: 'energy', category: 'basic', types: ['Water'] },
        units: [['Water'], ['Water'], ['Water']],
      } })],
    });
  });
  const g = setup(f, ['heads', 'tails', 'heads', 'tails', 'tails'], (s) => attached(s, 0, s.players[0].active, 'double'));
  const before = g.snapshot(), effective = g.view(0).players[0].active.effective;
  assert.equal(before.players[0].active.energy.length, 2);
  assert.equal(effective.energies.reduce((n, e) => n + e.units.length, 0), 5);
  const expected = oracle(before.rng, 5);
  attack(g); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 5); assert.deepEqual(g.snapshot().rng, expected.rng);
  assert.deepEqual(f.catalog.definition('water').mechanics.baseUnits, [['Water']]);
  assert.deepEqual(g.snapshot().players[0].active.energy, before.players[0].active.energy);
});

test('a false roll condition consumes no RNG and creates no numeric key; unconditionally reading that skipped coin rejects atomically', async () => {
  const condition = { kind: 'compare', left: stat('damageCounters'), relation: 'gt', right: lit(0) };
  const rolls = [{ key: 'conditional', spec: { kind: 'untilTails' }, condition }];
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].effects = [formula({
      kind: 'choose', condition, ifTrue: mul(coin('conditional'), lit(30)), ifFalse: lit(20),
    }, rolls)];
  });
  const g = setup(f, ['heads', 'heads', 'tails']), before = g.snapshot();
  attack(g); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.deepEqual(g.snapshot().rng, before.rng);
  assert.equal(publicCoins(g.snapshot(), before.events.length).length, 0);
  const invalid = await make((defs) => {
    defs[0].mechanics.attacks[0].effects = [formula(mul(coin('conditional'), lit(30)), rolls)];
  });
  const bad = setup(invalid, ['heads', 'tails']);
  assertAtomic(bad, () => attack(bad), { code: 'invalid-battle-facts' });
});

test('all bindings prepare rolls in attack.effects/rolls order before primary damage; root/body reuse one record and restore never rerolls', async () => {
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].effects = [
      binding('cn.damage@1', packet(add(mul(coin('root'), lit(10)), mul(coin('body-first', 'flips'), lit(10))),
        [fixed('body-first', 1)]), 'body-first'),
      formula(add(mul(coin('root'), lit(30)), mul(coin('body-first', 'tails'), lit(10)),
        mul(coin('root-extra'), lit(10)), mul(coin('last', 'flips'), lit(10))),
        [fixed('root', 2), fixed('root-extra', coin('root'), {
          condition: { kind: 'compare', left: coin('body-first'), relation: 'eq', right: lit(1) },
        })]),
      binding('cn.recoilDamage@1', packet(add(mul(coin('last'), lit(10)), mul(coin('root', 'tails'), lit(10))),
        [fixed('last', 1)], { side: 'own', target: 'self', selection: { kind: 'all' } }), 'last-recoil'),
    ];
  });
  let chosen;
  let g = setup(f, ['heads', 'tails', 'heads', 'heads', 'tails'], (s) => {
    chosen = bench(s, 1, 'base').id; bench(s, 1, 'other');
  });
  const before = g.snapshot(), first = oracle(before.rng, 1), root = oracle(first.rng, 2),
    extra = oracle(root.rng, 1), last = oracle(extra.rng, 1);
  attack(g);
  const saved = g.snapshot();
  assert.equal(saved.pending.kind, 'damage-targets');
  assert.equal(saved.players[1].active.counters, 5);
  assert.deepEqual(saved.rng, last.rng, 'even the later recoil roll is already prepared before primary damage and its first target prompt');
  assert.deepEqual(publicCoins(saved, before.events.length).map((e) => e.data.key),
    ['body-first', 'root', 'root-extra', 'last'], 'both binding order and each rolls array order are authoritative');
  for (const model of saved.attack.damageModels) assert.deepEqual(model.battleValues.coins, {
    'body-first': { heads: first.heads, tails: first.tails, flips: first.flips },
    root: { heads: root.heads, tails: root.tails, flips: root.flips },
    'root-extra': { heads: extra.heads, tails: extra.tails, flips: extra.flips },
    last: { heads: last.heads, tails: last.tails, flips: last.flips },
  });
  const direct = restore(g, f); g = restore(restore(g, f), f);
  for (const game of [g, direct]) { answer(game, [chosen]); settle(game); }
  assert.deepEqual(g.snapshot(), direct.snapshot());
  assert.deepEqual(g.snapshot().rng, last.rng);
  assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [50, 20, 10]);
  assert.equal(publicCoins(g.snapshot(), before.events.length).length, 4);
  await assert.rejects(async () => {
    const duplicate = await make((defs) => {
      defs[0].mechanics.attacks[0].effects = [
        formula(lit(10), [fixed('same', 1)]),
        binding('cn.damage@1', packet(lit(10), [fixed('same', 1)], { target: 'active', selection: { kind: 'all' } })),
      ];
    });
    const game = setup(duplicate, ['heads', 'tails']), before = game.snapshot();
    try { attack(game); } catch (e) { assert.deepEqual(game.snapshot(), before); throw e; }
  }, /key|coin|roll/i);
});

test('C-18 child and parent may use the same key with isolated records; dynamic child count belongs to the actual copier', async () => {
  const f = await make((defs) => {
    const a = defs[0].mechanics.attacks[0]; a.printedDamage = null; a.cost = ['Colorless'];
    a.effects = [
      formula(lit(0), [fixed('same', 1)]),
      binding('cn.copyAttack@1', {
        op: 'copyAttack', origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
        excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE },
      }),
    ];
    const child = defs[1].mechanics.attacks[0]; child.printedDamage = { value: 30, operator: 'times' };
    child.effects = [formula(add(mul(coin('same'), lit(30)), mul(coin('same', 'flips'), lit(10))),
      [fixed('same', stat('energyUnits'))])];
  });
  let g = board(f, (s) => {
    otherActive(s); attached(s, 0, s.players[0].active, 'double'); attached(s, 1, s.players[1].active, 'water');
    s.rng = seedFor(['tails', 'heads', 'heads']);
  });
  const before = g.snapshot(), parent = oracle(before.rng, 1), child = oracle(parent.rng, 2);
  attack(g); assert.equal(g.snapshot().pending.kind, 'copy-attack');
  assert.deepEqual(g.snapshot().rng, parent.rng);
  const option = g.view(0).pending.attacks.find((a) => a.attackId === 'other:strike'); assert(option);
  g = restore(g, f); answer(g, [option.optionId]); settle(g);
  assert.deepEqual(g.snapshot().rng, child.rng);
  assert.equal(g.snapshot().players[1].active.counters, 8,
    'child uses actual copier units2 and its own HH, not content-holder units1 or the parent T');
  assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [0, 80]);
  assert.equal(publicCoins(g.snapshot(), before.events.length).length, 2);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
});

test('ownFailure is checked before preparing damage coins: failed declaration consumes only its check, successful declaration rolls damage once', async () => {
  const f = await make((defs) => {
    const a = defs[0].mechanics.attacks[0]; a.specialRule = 'GX';
    a.failureCheck = { coin: { mode: 'fixed', count: 1, minimumHeads: 1 }, sourceOfTruth: EVIDENCE };
    a.effects = [formula(mul(coin('damage'), lit(30)), [fixed('damage', 2)])];
  });
  for (const [prefix, passed] of [
    [['tails', 'heads', 'heads'], false], [['heads', 'tails', 'heads'], true],
  ]) {
    const g = setup(f, prefix), before = g.snapshot(), check = oracle(before.rng, 1), damage = oracle(check.rng, 2);
    attack(g); settle(g);
    assert.deepEqual(g.snapshot().rng, passed ? damage.rng : check.rng);
    assert.equal(g.snapshot().players[1].active.counters, passed ? damage.heads * 3 : 0);
    assert.equal(g.snapshot().players[0].gxUsed, true,
      'ownFailure is still a used GX; only its damage rolls/body are skipped, unlike an earlier imposed/Confusion failure');
    assert.equal(publicCoins(g.snapshot(), before.events.length).length, passed ? 1 : 0);
    if (!passed) assert(!g.snapshot().events.slice(before.events.length).some((e) => e.ruleId === 'damage.coins'));
  }
});

test('private preparation binds source/frame/copy/turn and exact RNG/receipts; player views expose only actual outcomes and restored choices do not reroll', async () => {
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].effects = [
      formula(mul(coin('saved'), lit(30)), [fixed('saved', 2)]),
      binding('cn.damage@1', packet(mul(coin('saved'), lit(10)))),
    ];
  });
  let chosen;
  let g = setup(f, ['heads', 'tails'], (s) => { chosen = bench(s, 1, 'base').id; bench(s, 1, 'other'); });
  const before = g.snapshot(), expected = oracle(before.rng, 2);
  attack(g); const saved = g.snapshot();
  assert.equal(saved.pending.kind, 'damage-targets');
  const preparation = saved.attack.execution.damageCoins;
  assert(preparation);
  assert.deepEqual(preparation.rngBefore, before.rng); assert.deepEqual(preparation.rngAfter, expected.rng);
  assert.equal(preparation.entries.length, 1);
  assert.equal(preparation.entries[0].key, 'saved');
  assert.deepEqual(preparation.entries[0].receipt, {
    spec: { kind: 'fixed', count: 2 }, results: expected.results, heads: expected.heads,
    tails: expected.tails, flips: expected.flips,
  });
  const receiptIndex = saved.events.findIndex((e) => e.ruleId === 'damage.coins' && e.visibility === 'private');
  assert(receiptIndex >= 0);
  const journal = saved.events[receiptIndex];
  assert.equal(journal.data.frameId, saved.attack.id); assert.equal(journal.data.copyId, saved.attack.execution.copyId);
  assert.equal(journal.data.turn, saved.turn);
  assert.equal(journal.data.source.owner, 0);
  assert.equal(journal.data.source.pokemonId, before.players[0].active.id);
  assert.equal(journal.data.source.instanceId, before.players[0].active.stack.at(-1));
  assert.deepEqual(journal.data.data, preparation);
  for (const viewer of [0, 1]) {
    const serialized = JSON.stringify(g.view(viewer));
    assert(!serialized.includes('"rngBefore"')); assert(!serialized.includes('"rngAfter"'));
    assert(!serialized.includes(JSON.stringify(before.rng))); assert(!serialized.includes(JSON.stringify(expected.rng)));
    assert(!g.view(viewer).events.some((e) => e.visibility === 'private'));
    assert(serialized.includes(`"results":${JSON.stringify(expected.results)}`));
  }
  for (const mutate of [
    (s) => { delete s.attack.execution.damageCoins; },
    (s) => { s.attack.execution.damageCoins = null; },
    (s) => { s.attack.execution.damageCoins.entries[0].key = 'different'; },
    (s) => { s.attack.execution.damageCoins.entries[0].receipt.heads++; },
    (s) => { s.attack.execution.damageCoins.rngBefore[0] = (s.attack.execution.damageCoins.rngBefore[0] ^ 1) >>> 0; },
    (s) => { s.attack.execution.damageCoins.rngAfter[0] = (s.attack.execution.damageCoins.rngAfter[0] ^ 1) >>> 0; },
    (s) => { s.rng[0] = (s.rng[0] ^ 1) >>> 0; },
    (s) => { s.events.splice(receiptIndex, 1); },
    (s) => { s.events[receiptIndex].visibility = 'public'; },
    (s) => { s.events[receiptIndex].data.frameId = 'wrong-frame'; },
    (s) => { s.events[receiptIndex].data.copyId = 'wrong-copy'; },
    (s) => { s.events[receiptIndex].data.turn++; },
    (s) => { s.events[receiptIndex].data.source.owner = 1; },
  ]) {
    const broken = clone(saved); mutate(broken);
    assert.throws(() => OfficialGame.restore(broken, { catalog: f.catalog }));
    assert.deepEqual(g.snapshot(), saved);
  }
  g = restore(restore(g, f), f); assert.deepEqual(g.snapshot().rng, expected.rng);
  answer(g, [chosen]); settle(g);
  assert.deepEqual(g.snapshot().rng, expected.rng);
  assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [30, 10]);
  assert.equal(publicCoins(g.snapshot(), before.events.length).length, 1);
});
