import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, playerView } from '../../public/rules/game.js';
import { validateDamageParameters } from '../../public/rules/schema-validators.js';
import { fixture, binding, EVIDENCE, board, bench, attached, command, answer, settle } from './fixtures.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const stageReceipt = (s) => s.events.find((e) =>
  e.ruleId === 'damage.expression' && e.data.kind === 'stage-snapshot');

async function pendingDamage() {
  const f = await fixture((ds) => {
    ds[0].mechanics.attacks[0].effects = [binding('cn.damage@1', {
      side: 'opponent', target: 'bench',
      amount: { kind: 'multiply', left: { kind: 'pokemon', who: 'opponentActive', field: 'damageCounters' },
        right: { kind: 'literal', value: 10 } },
      selection: { kind: 'exact', count: 1 }, options: {},
    })];
  });
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    s.players[1].active.counters = 2;
    bench(s, 1, 'other'); bench(s, 1, 'other');
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.kind, 'damage-targets');
  return { f, g };
}

test('later selected stage-four packets read frozen numeric facts, not counters already written by primary damage', async () => {
  const { f, g } = await pendingDamage(), saved = g.snapshot();
  assert.equal(saved.players[1].active.counters, 4);
  assert(saved.attack.damageModels.every((m) => m.battleValues.pokemon.opponentActive.damageCounters === 2));
  const restored = OfficialGame.restore(clone(saved), { catalog: f.catalog });
  const selected = saved.pending.options[0]; answer(restored, [selected]); settle(restored);
  assert.equal(restored.snapshot().players[1].bench.find((m) => m.id === selected).counters, 2);
  assert.deepEqual(g.snapshot(), saved);
});

test('damage snapshots cannot be changed, omitted or replayed independently of their original frame/private receipt', async () => {
  const { f, g } = await pendingDamage(), saved = g.snapshot();
  for (const mutate of [
    (s) => { s.attack.damageModels = null; },
    (s) => { s.attack.damageModels.pop(); },
    (s) => { s.attack.damageModels[0].battleValues.pokemon.opponentActive.damageCounters++; },
    (s) => { s.attack.damageModels[0].battleValues.prizes.own.count = 1; },
    (s) => { s.queue = s.queue.filter((t) => t.op !== 'resolve-attack'); },
    (s) => { s.events.splice(s.events.indexOf(stageReceipt(s)), 1); },
    (s) => { s.events.push(clone(stageReceipt(s))); },
    (s) => { stageReceipt(s).data.frameId = 'earlier-frame'; },
    (s) => { stageReceipt(s).data.copyId = 'foreign-copy'; },
    (s) => { stageReceipt(s).data.models[0].battleValues.pokemon.opponentActive.damageCounters++; },
  ]) {
    const broken = clone(saved); mutate(broken);
    assert.throws(() => OfficialGame.restore(broken, { catalog: f.catalog }), { code: 'invalid-damage-model' });
    assert.deepEqual(g.snapshot(), saved);
  }
});

test('host-only stage receipts stay out of both views and cannot become public even after the attack finishes', async () => {
  const { f, g } = await pendingDamage(), saved = g.snapshot();
  const target = saved.pending.options[0];
  for (const viewer of [0, 1])
    assert(!g.view(viewer).events.some((e) => e.ruleId === 'damage.expression' && e.data.kind === 'stage-snapshot'));
  answer(g, [target]); settle(g);
  for (const base of [saved, g.snapshot()]) for (const visibility of ['public', 0, 1]) {
    const broken = clone(base); stageReceipt(broken).visibility = visibility;
    assert.throws(() => OfficialGame.restore(broken, { catalog: f.catalog }), { code: 'invalid-damage-model' });
    for (const viewer of [0, 1])
      assert(!playerView(broken, f.catalog, viewer).events.some((e) =>
        e.ruleId === 'damage.expression' && e.data.kind === 'stage-snapshot'));
  }
});

test('only an explicit synthetic special-timing handler queries live facts after the ordinary damage stage', async () => {
  // Capability/continuation test only. No assertion that a particular real card
  // has this exceptional timing; such a binding still needs its own CN evidence.
  const h = {
    rulesetId: 'CN/V20261019', timing: 'resolve', operations: ['damage'], sourceOfTruth: EVIDENCE,
    validateParameters: validateDamageParameters, execute: (_ctx, p) => [{ op: 'damage', ...p }],
  };
  const f = await fixture((ds) => {
    ds[0].mechanics.attacks[0].effects = [binding('fixture:explicit-late-value', {
      side: 'opponent', target: 'active', selection: { kind: 'all' }, options: {},
      amount: { kind: 'multiply', left: { kind: 'pokemon', who: 'opponentActive', field: 'damageCounters' },
        right: { kind: 'literal', value: 10 } },
    })];
  }, new Map([['fixture:explicit-late-value', h]]));
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 4, '20 ordinary damage, then the explicit late calculation reads 2 × 10.');
});

test('D-17-shaped selected-target text damage keeps its blank printed column and can hit the Bench without Weakness', async () => {
  // Models the rule-book instruction, not approval of the real Zygarde printing.
  const f = await fixture((ds) => {
    ds[0].mechanics.attacks[0].printedDamage = null;
    ds[0].mechanics.attacks[0].effects = [binding('cn.damage@1', {
      side: 'opponent', target: 'any', selection: { kind: 'exact', count: 1 }, options: {},
      amount: { kind: 'multiply', left: { kind: 'prizes', side: 'opponent' },
        right: { kind: 'literal', value: 40 } },
    })];
    ds[1].mechanics.weakness = { type: 'Water', operation: 'multiply', value: 2 };
  });
  let target;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); target = bench(s, 1, 'other').id;
    s.players[1].hand.push(...s.players[1].prizes.splice(4));
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  const restored = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  answer(restored, [target]); settle(restored);
  assert.equal(restored.snapshot().players[1].bench.find((m) => m.id === target).counters, 8);
  assert.equal(restored.snapshot().players[1].active.counters, 0);
  assert.equal(f.catalog.definition('base').mechanics.attacks[0].printedDamage, null);
});
