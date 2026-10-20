// OfficialGame persistence/security tests with synthetic cards only. Coin
// statistics and stopping-rule oracles belong to the separate pure/runtime suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError, playerView } from '../../public/rules/game.js';
import { randomIndex } from '../../public/rules/random.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, attached, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const lit = (value) => ({ kind: 'literal', value });
const coin = (key, field = 'heads') => ({ kind: 'coin', key, field });
const add = (...terms) => ({ kind: 'add', terms });
const mul = (left, right) => ({ kind: 'multiply', left, right });
const roll = (key, count, extra = {}) => ({ key, spec: { kind: 'fixed', count }, ...extra });
const formula = (expression, rolls) => binding('cn.damageValue@1',
  { expression, ...(rolls === undefined ? {} : { rolls }) }, 'state-formula');
const packet = (amount, rolls, extra = {}) => ({
  side: 'opponent', target: 'bench', amount, selection: { kind: 'exact', count: 1 }, options: {},
  ...(rolls === undefined ? {} : { rolls }), ...extra,
});
const copySpec = () => ({
  op: 'copyAttack', origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
  excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE },
});
const pause = {
  rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'resolve', operations: ['optional', 'draw'],
  validateParameters: (p) => Object.keys(p).length === 0,
  execute: () => [{ op: 'optional', effect: { op: 'draw', count: 1 } }],
};
async function make(effects, extend = () => {}) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) {
      d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null;
    }
    defs[0].mechanics.attacks[0].printedDamage = null;
    defs[0].mechanics.attacks[0].effects = effects;
    extend(defs);
  }, new Map([['fixture:coin-state-pause', pause]]));
}
function battle(f, mutate = () => {}) {
  let ids;
  const g = board(f, (s) => {
    const p = s.players[1], old = p.active;
    p.hand.push(...old.stack, ...old.energy, ...old.tools);
    p.active = bench(s, 1, 'other'); p.bench.pop();
    attached(s, 0, s.players[0].active, 'water');
    ids = [bench(s, 1, 'base').id, bench(s, 1, 'other').id];
    mutate(s);
  });
  return { g, ids };
}
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const logs = (s, kind) => s.events.filter((e) => e.ruleId === 'damage.coins' && e.data.kind === kind);
const prepared = (s, copyId = s.attack.execution.copyId) => {
  const found = logs(s, 'prepared').filter((e) => e.data.frameId === s.attack.id && e.data.copyId === copyId);
  assert.equal(found.length, 1, 'Every prepared execution has one exact host-only journal.');
  return found[0];
};
const rolled = (s, copyId = null) => logs(s, 'rolled').filter((e) => e.data.copyId === copyId);
const byKey = (envelope, key) => {
  const found = envelope.entries.filter((e) => e.key === key);
  assert.equal(found.length, 1); return found[0];
};
function restore(g, f) {
  const before = g.snapshot(), r = OfficialGame.restore(clone(before), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), before, 'Restore/audit must not re-roll or advance the actual RNG.');
  for (const viewer of [0, 1]) assert.deepEqual(r.view(viewer), g.view(viewer));
  return r;
}
function respond(g, f, selected) {
  const r = restore(g, f); answer(g, selected); answer(r, selected);
  assert.deepEqual(r.snapshot(), g.snapshot(), 'The restored continuation uses its saved rolls exactly once.');
}
function atomic(g, run) {
  const before = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(run, (e) => e instanceof EngineError);
  assert.deepEqual(g.snapshot(), before, 'Invalid answers cannot consume RNG, roll again, apply damage or alter receipts/revision.');
  assert.deepEqual([g.view(0), g.view(1)], views);
}
function rngAfter(rng, count) {
  const next = [...rng];
  for (let i = 0; i < count; i++) randomIndex(next, 2);
  return next;
}
function assertNoSecrets(view) {
  assert(!view.events.some((e) => e.ruleId === 'damage.coins' && e.data.kind === 'prepared'));
  const work = [view];
  while (work.length) {
    const v = work.pop();
    if (!v || typeof v !== 'object') continue;
    for (const [key, value] of Object.entries(v)) {
      assert(!['rng', 'rngBefore', 'rngAfter', 'damageCoins'].includes(key), `Player projection leaked ${key}.`);
      work.push(value);
    }
  }
}
function rejectsRestore(g, f, name, mutate) {
  const original = g.snapshot(), bad = clone(original); mutate(bad);
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), (e) => {
    assert(e instanceof EngineError, `${name}: restore should reject at the host state boundary, not fail accidentally.`);
    assert.match(e.code, /^invalid-/, name); return true;
  }, name);
  assert.deepEqual(g.snapshot(), original, `${name}: rejected restore cannot change the original game.`);
}
const basicEffects = () => [
  formula(mul(add(coin('shared'), lit(1)), lit(10)), [roll('shared', 2)]),
  binding('cn.damage@1', packet(mul(add(coin('shared'), coin('packet'), lit(1)), lit(10)),
    [roll('packet', { kind: 'pokemon', who: 'self', field: 'energyCards' })]), 'state-packet'),
  binding('cn.recoilDamage@1', packet(mul(add(coin('shared', 'tails'), coin('recoil')), lit(10)),
    [roll('recoil', 1)], { side: 'own', target: 'self', selection: { kind: 'all' } }), 'state-recoil'),
];
async function paused() {
  const f = await make(basicEffects()), { g, ids } = battle(f), before = g.snapshot();
  attack(g); assert.equal(g.snapshot().pending.kind, 'damage-targets');
  return { f, g, ids, before };
}

test('one execution shares native formula/damage/recoil keys; target choices and repeated JSON restores never roll twice', async () => {
  const { f, g, ids, before } = await paused(), saved = g.snapshot(), envelope = saved.attack.execution.damageCoins;
  assert.deepEqual(envelope.entries.map((e) => [e.effectId, e.key]), [
    ['fixture:state-formula', 'shared'], ['fixture:state-packet', 'packet'], ['fixture:state-recoil', 'recoil'],
  ]);
  assert.deepEqual(envelope.entries.map((e) => e.spec), [
    { kind: 'fixed', count: 2 }, { kind: 'fixed', count: 1 }, { kind: 'fixed', count: 1 },
  ]);
  assert.deepEqual(envelope.rngBefore, before.rng);
  assert.deepEqual(envelope.rngAfter, rngAfter(before.rng, 4));
  assert.deepEqual(saved.rng, envelope.rngAfter);
  assert.equal(prepared(saved).visibility, 'private');
  assert.deepEqual(prepared(saved).data.data, envelope);
  assert.deepEqual(rolled(saved).map((e) => [e.data.key, e.data.receipt]), envelope.entries.map((e) => [e.key, e.receipt]));
  assert.equal(JSON.stringify(envelope), JSON.stringify(clone(envelope)), 'Every continuation value is ordinary JSON, never a closure/BigInt/RNG callback.');
  let r = g;
  for (let i = 0; i < 5; i++) r = restore(r, f);
  assert.deepEqual(r.snapshot().rng, saved.rng);
  atomic(g, () => answer(g, ['heads']));
  atomic(g, () => answer(g, []));
  atomic(g, () => answer(g, [ids[0], ids[1]]));
  atomic(g, () => answer(g, [before.players[0].active.id]));
  const shared = byKey(envelope, 'shared').receipt, packetReceipt = byKey(envelope, 'packet').receipt;
  const recoil = byKey(envelope, 'recoil').receipt;
  respond(g, f, [ids[0]]); settle(g);
  const after = g.snapshot(), target = after.players[1].bench.find((m) => m.id === ids[0]);
  assert.equal(target.counters, shared.heads + packetReceipt.heads + 1);
  assert.equal(after.players[1].bench.find((m) => m.id === ids[1]).counters, 0);
  assert.equal(after.players[0].active.counters, shared.tails + recoil.heads);
  assert.deepEqual(after.rng, saved.rng);
  assert.equal(logs(after, 'prepared').length, 1); assert.equal(logs(after, 'rolled').length, 3);
  assert.deepEqual(logs(after, 'prepared')[0].data.data, envelope);
  restore(g, f);
});

test('a false roll condition persists null spec/receipt; no plans still retains its prepared boundary without consuming RNG', async () => {
  const falseCondition = { kind: 'compare', left: lit(0), relation: 'gt', right: lit(1) };
  const f = await make([
    formula(lit(20), [roll('skipped', { kind: 'prizes', side: 'own' }, { condition: falseCondition })]),
    binding('cn.damage@1', packet(10), 'skip-packet'),
  ]);
  const { g, ids } = battle(f, (s) => {
    // This count would need a ruling if read. A false condition must skip its
    // dynamic specification as well as the actual flips.
    s.players[0].prizes.push(s.players[0].deck.pop());
  }), before = g.snapshot(); attack(g);
  const saved = g.snapshot(), envelope = saved.attack.execution.damageCoins;
  assert.deepEqual(envelope.entries, [{ effectId: 'fixture:state-formula', key: 'skipped', spec: null, receipt: null }]);
  assert.deepEqual(envelope.rngBefore, before.rng); assert.deepEqual(envelope.rngAfter, before.rng);
  assert.deepEqual(saved.rng, before.rng); assert.equal(logs(saved, 'rolled').length, 0);
  assert.deepEqual(prepared(saved).data.data, envelope);
  respond(g, f, [ids[0]]); settle(g);
  assert.deepEqual(g.snapshot().rng, before.rng);
  const empty = await make([formula(lit(20)), binding('cn.damage@1', packet(10), 'no-coins')]);
  const plain = battle(empty), originalRng = plain.g.snapshot().rng; attack(plain.g);
  const noPlans = plain.g.snapshot(), emptyPreparation = { entries: [], rngBefore: originalRng, rngAfter: originalRng };
  // null means preparation has not happened yet, not "zero declarations".
  // An empty completed preparation still binds the exact stage/RNG boundary.
  assert.deepEqual(noPlans.attack.execution.damageCoins, emptyPreparation);
  assert.deepEqual(noPlans.rng, originalRng);
  assert.equal(prepared(noPlans).visibility, 'private');
  assert.deepEqual(prepared(noPlans).data.data, emptyPreparation);
  assert.equal(logs(noPlans, 'rolled').length, 0);
  rejectsRestore(plain.g, empty, 'discarded empty preparation', (s) => { s.attack.execution.damageCoins = null; });
  respond(plain.g, empty, [plain.ids[0]]); settle(plain.g);
  assert.deepEqual(plain.g.snapshot().rng, originalRng);
  restore(plain.g, empty);
});

test('copied executions isolate the same key, advance global RNG independently, and restore the caller’s namespace without rewinding RNG', async () => {
  const f = await make([
    formula(mul(add(coin('same'), lit(1)), lit(10)), [roll('same', 2)]),
    binding('cn.copyAttack@1', copySpec()),
    binding('fixture:coin-state-pause', {}),
  ], (defs) => {
    const a = defs[1].mechanics.attacks[0]; a.cost = ['Fire', 'Fire', 'Fire']; a.printedDamage = null;
    a.effects = [
      formula(mul(add(coin('same'), lit(1)), lit(10)), [roll('same', 3)]),
      binding('cn.damage@1', packet(mul(coin('same', 'flips'), lit(10))), 'copy-packet'),
    ];
  });
  const { g, ids } = battle(f), before = g.snapshot(); attack(g);
  assert.equal(g.snapshot().pending.kind, 'copy-attack');
  const caller = clone(g.snapshot().attack.execution.damageCoins);
  assert.deepEqual(caller.rngBefore, before.rng); assert.deepEqual(caller.rngAfter, rngAfter(before.rng, 2));
  atomic(g, () => answer(g, ['not-a-copy-option']));
  const option = g.view(0).pending.attacks.find((a) => a.attackId === 'other:strike'); assert(option);
  respond(g, f, [option.optionId]);
  const child = g.snapshot(), childId = child.attack.execution.copyId;
  assert.notEqual(childId, null); assert.equal(child.pending.kind, 'damage-targets');
  assert.equal(child.attack.copies.length, 1);
  assert.deepEqual(child.attack.copies[0].execution.damageCoins, caller);
  const borrowed = child.attack.execution.damageCoins;
  assert.deepEqual(borrowed.rngBefore, caller.rngAfter); assert.deepEqual(borrowed.rngAfter, rngAfter(caller.rngAfter, 3));
  assert.equal(byKey(caller, 'same').receipt.flips, 2);
  assert.equal(byKey(borrowed, 'same').receipt.flips, 3);
  assert.deepEqual(prepared(child, null).data.data, caller);
  assert.deepEqual(prepared(child, childId).data.data, borrowed);
  assert.equal(rolled(child, null).length, 1); assert.equal(rolled(child, childId).length, 1);
  const childSource = rolled(child, childId)[0].data.source;
  assert.equal(childSource.owner, 0); assert.equal(childSource.pokemonId, before.players[0].active.id);
  assert.equal(childSource.instanceId, before.players[0].active.stack.at(-1));
  assert.equal(childSource.contentSource.instanceId, before.players[1].active.stack.at(-1));
  assert.equal(childSource.contentSource.attackId, 'other:strike');
  rejectsRestore(g, f, 'substituting the suspended caller namespace for the child', (s) => {
    s.attack.execution.damageCoins = clone(caller);
  });
  atomic(g, () => answer(g, []));
  respond(g, f, [ids[0]]);
  const resumed = g.snapshot();
  assert.equal(resumed.pending.kind, 'optional-effect'); assert.equal(resumed.attack.execution.copyId, null);
  assert.equal(resumed.attack.copies.length, 0);
  assert.deepEqual(resumed.attack.execution.damageCoins, caller);
  assert.deepEqual(resumed.rng, borrowed.rngAfter, 'Returning from a copy restores names, not the old global random stream.');
  assert.equal(resumed.players[1].bench.find((m) => m.id === ids[0]).counters, 3);
  respond(g, f, ['skip']); settle(g);
  assert.deepEqual(g.snapshot().rng, borrowed.rngAfter);
  assert.equal(logs(g.snapshot(), 'prepared').length, 2); assert.equal(logs(g.snapshot(), 'rolled').length, 2);
  restore(g, f);
});

test('restore rejects modified outcomes/counts/specs/keys, source/clock/RNG and missing/duplicated private journals', async () => {
  const { f, g } = await paused();
  const entry = (s) => s.attack.execution.damageCoins.entries[0];
  const token = (s) => s.attack.execution.damageCoins;
  const journal = (s) => prepared(s);
  const mutations = [
    ['outcome', (s) => { entry(s).receipt.results[0] = entry(s).receipt.results[0] === 'heads' ? 'tails' : 'heads'; }],
    ['heads', (s) => { entry(s).receipt.heads++; }],
    ['tails', (s) => { entry(s).receipt.tails++; }],
    ['flips', (s) => { entry(s).receipt.flips++; }],
    ['expected spec', (s) => { entry(s).spec.count++; }],
    ['receipt spec', (s) => { entry(s).receipt.spec.count++; }],
    ['key', (s) => { entry(s).key = 'other-key'; }],
    ['binding identity', (s) => { entry(s).effectId = 'fixture:other-effect'; }],
    ['duplicate key', (s) => { token(s).entries[1].key = entry(s).key; }],
    ['missing entry', (s) => { token(s).entries.pop(); }],
    ['unexpected null plan', (s) => { s.attack.execution.damageCoins = null; }],
    ['rngBefore', (s) => { token(s).rngBefore[0] = (token(s).rngBefore[0] ^ 1) >>> 0; }],
    ['rngAfter', (s) => { token(s).rngAfter[0] = (token(s).rngAfter[0] ^ 1) >>> 0; }],
    ['actual RNG', (s) => { s.rng[0] = (s.rng[0] ^ 1) >>> 0; }],
    ['journal frame', (s) => { journal(s).data.frameId = 'old-frame'; }],
    ['journal copy', (s) => { journal(s).data.copyId = 'old-copy'; }],
    ['journal turn', (s) => { journal(s).data.turn++; }],
    ['journal source owner', (s) => { journal(s).data.source.owner = 1; }],
    ['journal physical source', (s) => { journal(s).data.source.instanceId = s.players[1].active.stack[0]; }],
    ['journal data', (s) => { journal(s).data.data.entries[0].receipt.heads++; }],
    ['missing private journal', (s) => { const j = journal(s); s.events.splice(s.events.indexOf(j), 1); }],
    ['duplicated private journal', (s) => { s.events.push(clone(journal(s))); }],
    ['journal made owner-visible', (s) => { journal(s).visibility = 0; }],
    ['journal made public', (s) => { journal(s).visibility = 'public'; }],
    ['public outcome', (s) => { rolled(s)[0].data.receipt.results[0] = 'tails'; rolled(s)[0].data.receipt.heads++; }],
    ['public source owner', (s) => { rolled(s)[0].data.source.owner = 1; }],
    ['public physical source', (s) => { rolled(s)[0].data.source.instanceId = s.players[1].active.stack[0]; }],
    ['public turn', (s) => { rolled(s)[0].data.turn++; }],
    ['missing public roll', (s) => { const e = rolled(s)[0]; s.events.splice(s.events.indexOf(e), 1); }],
    ['duplicate public roll', (s) => { s.events.push(clone(rolled(s)[0])); }],
  ];
  for (const [name, mutate] of mutations) rejectsRestore(g, f, name, mutate);
  restore(g, f);
});

test('matching edited private/public counts cannot bypass spec/seed audit, and auditing never consumes actual RNG', async () => {
  const { f, g } = await paused();
  function mirror(s) {
    const env = s.attack.execution.damageCoins;
    prepared(s).data.data = clone(env);
    for (const event of rolled(s)) {
      const item = byKey(env, event.data.key); event.data.receipt = clone(item.receipt);
    }
  }
  rejectsRestore(g, f, 'self-consistent forged results with a different random outcome', (s) => {
    const r = s.attack.execution.damageCoins.entries[0].receipt;
    r.results[0] = r.results[0] === 'heads' ? 'tails' : 'heads';
    r.heads = r.results.filter((x) => x === 'heads').length; r.tails = r.results.length - r.heads;
    mirror(s);
    // Keep the frozen numerical copies consistent too. This must be rejected
    // by deterministic RNG audit, not merely by mismatched receipt caches.
    const coins = Object.fromEntries(s.attack.execution.damageCoins.entries.map(({ key, receipt }) =>
      [key, { heads: receipt.heads, tails: receipt.tails, flips: receipt.flips }]));
    for (const model of s.attack.damageModels) model.battleValues.coins = clone(coins);
    const stage = s.events.find((e) => e.ruleId === 'damage.expression' && e.data.kind === 'stage-snapshot' &&
      e.data.frameId === s.attack.id && e.data.copyId === s.attack.execution.copyId);
    assert(stage); stage.data.models = clone(s.attack.damageModels);
  });
  rejectsRestore(g, f, 'self-consistent forged fixed-count specification', (s) => {
    const e = s.attack.execution.damageCoins.entries[0];
    e.spec.count++; e.receipt.spec.count++; e.receipt.results.push('heads'); e.receipt.heads++; e.receipt.flips++;
    mirror(s);
  });
  rejectsRestore(g, f, 're-keyed execution and matching journals', (s) => {
    s.attack.execution.damageCoins.entries[0].key = 'renamed';
    prepared(s).data.data = clone(s.attack.execution.damageCoins);
    rolled(s)[0].data.key = 'renamed';
  });
  const before = g.snapshot();
  for (let i = 0; i < 8; i++) restore(g, f);
  assert.deepEqual(g.snapshot(), before, 'RNG verification must simulate only against a clone, never the actual game state.');
});

test('a new attack frame cannot replay the previous execution’s preparation, even with the same source and roll names', async () => {
  const { f, g, ids } = await paused(), old = g.snapshot(), oldToken = clone(old.attack.execution.damageCoins);
  const oldJournal = clone(prepared(old)), oldFrame = old.attack.id;
  respond(g, f, [ids[0]]); settle(g);
  command(g, { type: 'endTurn' }); settle(g);
  assert.equal(g.snapshot().current, 0);
  attack(g); assert.equal(g.snapshot().pending.kind, 'damage-targets');
  assert.notEqual(g.snapshot().attack.id, oldFrame);
  assert.notEqual(g.snapshot().turn, old.turn);
  rejectsRestore(g, f, 'old token replay', (s) => { s.attack.execution.damageCoins = clone(oldToken); });
  rejectsRestore(g, f, 'old journal replay', (s) => {
    const current = prepared(s); current.data = clone(oldJournal.data);
  });
  rejectsRestore(g, f, 'old token and journal replay together', (s) => {
    const current = prepared(s);
    s.attack.execution.damageCoins = clone(oldToken); current.data = clone(oldJournal.data);
  });
  restore(g, f);
});

test('both public views exclude all RNG/preparation data, including historical and maliciously relabelled raw events', async () => {
  const { f, g, ids } = await paused(), saved = g.snapshot();
  const publicRolls = rolled(saved);
  assert.equal(publicRolls.length, 3); assert(publicRolls.every((e) => e.visibility === 'public'));
  for (const viewer of [0, 1]) {
    assertNoSecrets(g.view(viewer));
    assert.deepEqual(logs(g.view(viewer), 'rolled'), publicRolls);
  }
  respond(g, f, [ids[0]]); settle(g);
  const completed = g.snapshot();
  assert.equal(completed.attack, null); assert.equal(logs(completed, 'prepared').length, 1);
  for (const viewer of [0, 1]) {
    assertNoSecrets(g.view(viewer)); assert.deepEqual(logs(g.view(viewer), 'rolled'), publicRolls);
  }
  for (const visibility of [0, 1, 'public']) {
    rejectsRestore(g, f, `historical preparation visibility ${visibility}`, (s) => {
      logs(s, 'prepared')[0].visibility = visibility;
    });
    const raw = clone(completed); logs(raw, 'prepared')[0].visibility = visibility;
    for (const viewer of [0, 1]) assertNoSecrets(playerView(raw, f.catalog, viewer));
  }
  restore(g, f);
});

test('duplicate names within or across native bindings reject before any partial RNG/damage transaction commits', async () => {
  for (const effects of [
    [formula(lit(20), [roll('duplicate', 1), roll('duplicate', 2)])],
    [formula(lit(20), [roll('duplicate', 1)]),
      binding('cn.damage@1', packet(10, [roll('duplicate', 2)]), 'duplicate-second-binding')],
  ]) await assert.rejects(async () => {
    // An admission-time rejection is also valid. If admitted, the attack must
    // fail atomically; no earlier declaration may consume its coins first.
    const f = await make(effects), { g } = battle(f), before = g.snapshot();
    try { attack(g); } catch (e) {
      assert.deepEqual(g.snapshot(), before); throw e;
    }
  }, /duplicate|unique/i);
});
