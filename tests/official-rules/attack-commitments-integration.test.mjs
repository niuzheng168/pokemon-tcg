import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench } from './fixtures.mjs';

// Synthetic cards and approvals ONLY. E-33's own failure is not a play cost.
const payment = (extra = {}) => ({ op: 'discardHand', count: 2,
  selector: { kind: 'energy', category: 'basic', types: ['Water'] }, ...extra });
const failure = (extra = {}) => ({ handPayment: payment(extra), sourceOfTruth: EVIDENCE });
async function paidFixture({ specialRule, effects = [], count = 2, transform = () => {} } = {}) {
  const f = await fixture((ds) => {
    const a = ds[0].mechanics.attacks[0]; a.cost = []; a.printedDamage.value = 30;
    a.failureCheck = failure({ count }); a.effects = effects;
    if (specialRule) a.specialRule = specialRule;
    transform(ds);
  });
  let fires = 2;
  f.deck = f.deck.map((id) => id === 'printing:water' && fires-- > 0 ? 'printing:fire' : id);
  return f;
}
function exactHand(s, owner, definitions) {
  const p = s.players[owner], ids = []; p.deck.push(...p.hand.splice(0));
  for (const d of definitions) {
    const id = hand(s, owner, d); p.hand.pop(); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) { p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id); }
  return ids;
}
const start = (f, definitions = ['water', 'water']) => board(f, (s) => {
  exactHand(s, 0, definitions); s.players[0].active.counters = 2;
});
const strike = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const records = (s, kind) => s.events.filter((e) => e.ruleId === 'attack.failure.hand-payment' && e.data.kind === kind);

test('E-33 permits declaring with insufficient hand cards, then offers only zero or complete payment, never partial discard', async () => {
  for (const specialRule of [undefined, 'GX', 'VSTAR']) for (const available of [0, 1, 2, 3]) {
    const f = await paidFixture({ specialRule }), g = start(f, Array(available).fill('water'));
    assert(g.view(0).legalActions.some((a) => a.attackId === 'base:strike'));
    const printed = structuredClone(f.catalog.definition('base')); strike(g);
    const waiting = g.snapshot(), view = g.view(0);
    assert.equal(waiting.pending.kind, 'attack-payment');
    assert.equal(waiting.attack.execution.phase, 'failure-check');
    assert.equal(waiting.attack.execution.failureReceipt, null);
    assert.equal(view.pending.minimum, 0); assert.equal(view.pending.maximum, available >= 2 ? 2 : 0);
    assert.deepEqual(view.pending.allowedCounts, available >= 2 ? [0, 2] : [0]);
    assert.equal(view.pending.handPayment.requiredCount, 2);
    assert.equal(view.players[0].gxUsed, specialRule === 'GX');
    assert.equal(view.players[0].vstarUsed, specialRule === 'VSTAR');
    assert.deepEqual(waiting.players[0].active.facts.lastUsedAttack, { turn: 5, attackId: 'base:strike' });
    const selected = available >= 2 ? waiting.pending.options.slice(0, 2) : [];
    answer(g, selected); settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, selected.length ? 3 : 0);
    assert.equal(s.players[0].hand.length, available - selected.length);
    assert(selected.every((id) => s.players[0].discard.includes(id)));
    assert.equal(s.players[0].flags.energy, false);
    assert.equal(s.current, 1); assert.deepEqual(s.rng, waiting.rng);
    assert.equal(records(s, 'requested').length, 1); assert.equal(records(s, 'resolved').length, 1);
    assert.equal(records(s, 'resolved')[0].data.receipt.passed, selected.length === 2);
    assert.deepEqual(f.catalog.definition('base'), printed);
    assert.deepEqual(restore(g, f).snapshot(), s);
  }
});

test('a player may voluntarily fail despite enough cards; neither printed damage nor later text happens', async () => {
  const f = await paidFixture({ specialRule: 'GX', effects: [binding('cn.draw@1', { count: 3 }),
    binding('cn.heal@1', { target: 'self', amount: 20 })] });
  const g = start(f), before = g.snapshot(); strike(g); answer(g, []); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[0].hand.length, 2); assert.equal(s.players[0].active.counters, 2);
  assert.equal(s.players[0].gxUsed, true); assert.equal(s.players[1].active.counters, 0);
  assert.deepEqual(s.rng, before.rng); assert.equal(s.current, 1);
  assert.equal(s.events.slice(before.events.length).filter((e) => e.ruleId === 'attack.used').length, 1);
});

test('invalid partial, repeated, foreign and nonmatching answers reject atomically without turning into voluntary failure', async () => {
  const f = await paidFixture(), g = start(f, ['water', 'water', 'fire']); strike(g);
  const before = g.snapshot(), water = before.pending.options;
  const fire = before.players[0].hand.find((id) => before.cards[id].definitionId === 'fire');
  for (const selected of [[water[0]], [water[0], water[0]], [water[0], fire],
    [water[0], before.players[1].hand[0]], [...water, fire]]) {
    assert.throws(() => answer(g, selected)); assert.deepEqual(g.snapshot(), before);
  }
  answer(g, water); settle(g); assert.equal(g.snapshot().players[1].active.counters, 3);
});

test('public waiting and zero-failure views do not disclose hidden eligibility; private request journals cannot be made public', async () => {
  const f = await paidFixture({ specialRule: 'GX' }), enough = start(f, ['water', 'water']), none = start(f, ['fire', 'fire']);
  strike(enough); strike(none);
  assert.deepEqual(enough.view(1), none.view(1));
  const leaked = enough.snapshot();
  records(leaked, 'requested')[0].visibility = 'public';
  assert.throws(() => OfficialGame.restore(leaked, { catalog: f.catalog }), /payment/i);
  answer(enough, []); answer(none, []); settle(enough); settle(none);
  assert.deepEqual(enough.view(1), none.view(1));
});

test('pending payments bind the unique declaration, current hand, phase, bounds and private request receipt on restore', async () => {
  const f = await paidFixture(), g = start(f); strike(g); const before = g.snapshot();
  assert.deepEqual(restore(g, f).snapshot(), before);
  for (const mutate of [
    (s) => { s.attack.id = 'other-declaration'; },
    (s) => { s.attack.execution.phase = 'body'; },
    (s) => { s.pending.data.turn--; },
    (s) => { s.pending.data.flow.frameId = 'other-declaration'; },
    (s) => { s.pending.data.hand.pop(); },
    (s) => { s.pending.data.eligible.pop(); },
    (s) => { s.pending.data.id = 'missing'; },
    (s) => { s.pending.data.selected = []; },
    (s) => { s.pending.maximum = 1; },
    (s) => { s.pending.minimum = 1; },
    (s) => { s.pending.allowZero = false; },
    (s) => { s.pending.options.pop(); },
    (s) => { s.queue.unshift({ op: 'after-attack', data: structuredClone(s.pending.data.flow) }); },
    (s) => { s.queue.unshift({ op: 'attack-payment', data: structuredClone(s.pending.data) }); },
  ]) {
    const bad = structuredClone(before); mutate(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
    assert.deepEqual(g.snapshot(), before);
  }
});

test('successful payment receipts survive later hand changes and every body choice, without paying again', async () => {
  const f = await paidFixture({ effects: [binding('cn.heal@1', { target: 'self', amount: 10 }),
    binding('cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'energy', category: 'basic', types: ['Water'] },
      quantity: { kind: 'exact', count: 2 }, reveal: true, lookTop: null, shuffleAfter: false })] });
  const g = start(f); strike(g); const chosen = g.snapshot().pending.options; answer(g, chosen);
  const body = g.snapshot(); assert.equal(body.pending.kind, 'effect-target');
  assert.equal(body.attack.execution.phase, 'body');
  assert.deepEqual(body.attack.execution.failureReceipt.selected, chosen);
  for (const mutate of [
    (s) => { s.attack.execution.failureReceipt = null; },
    (s) => { s.attack.execution.failureReceipt.passed = false; },
    (s) => { s.attack.execution.failureReceipt.selected.pop(); },
    (s) => { s.attack.execution.failureReceipt.id = 'old'; },
    (s) => { records(s, 'requested')[0].data.choice.eligible = []; },
    (s) => { records(s, 'resolved')[0].data.receipt.selected = []; },
  ]) {
    const bad = structuredClone(body); mutate(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
  }
  const r = restore(g, f);
  settle(g); settle(r); assert.deepEqual(r.snapshot(), g.snapshot());
  assert(chosen.every((id) => g.snapshot().players[0].hand.includes(id)));
  assert.equal(records(g.snapshot(), 'resolved').length, 1);
});

test('C-18 pays from the actual user hand and preserves original attack identity; zero cancels the whole pure-copy chain', async () => {
  for (const pay of [false, true]) {
    const f = await paidFixture({ specialRule: 'GX', transform: (ds) => {
      const a = ds[0].mechanics.attacks[0]; delete a.failureCheck; a.printedDamage = null;
      a.effects = [binding('cn.copyAttack@1', { op: 'copyAttack',
        origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }],
        excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE } })];
      ds[1].mechanics.hp = 300; ds[1].mechanics.attacks[0].failureCheck = failure();
      ds[1].mechanics.attacks[0].printedDamage.value = 40;
    } });
    const g = board(f, (s) => {
      exactHand(s, 0, ['water', 'water']); exactHand(s, 1, ['fire', 'fire']);
      const p = s.players[1], old = p.active; p.hand.push(...old.stack);
      p.active = bench(s, 1, 'other'); p.bench.pop();
    });
    strike(g);
    answer(g, [g.view(0).pending.attacks[0].optionId]);
    assert.equal(g.snapshot().pending.kind, 'attack-payment');
    const r = restore(g, f), selected = pay ? g.snapshot().pending.options : [];
    answer(g, selected); answer(r, selected); settle(g); settle(r);
    assert.deepEqual(r.snapshot(), g.snapshot());
    assert.equal(g.snapshot().players[1].active.counters, pay ? 4 : 0);
    assert.equal(g.snapshot().players[0].gxUsed, true);
    assert.equal(g.snapshot().players[0].active.facts.lastUsedAttack.attackId, 'base:strike');
    assert(g.snapshot().players[1].discard.every((id) => g.snapshot().cards[id].definitionId !== 'fire'));
  }
});

test('a payment receipt from an earlier declaration cannot be replayed for the same actor and printed attack', async () => {
  const f = await paidFixture({ effects: [binding('cn.heal@1', { target: 'self', amount: 10 })] });
  const g = start(f, ['water', 'water', 'water', 'water']); strike(g);
  answer(g, g.snapshot().pending.options.slice(0, 2));
  const first = structuredClone(g.snapshot().attack.execution.failureReceipt);
  settle(g); end(g); strike(g); answer(g, g.snapshot().pending.options.slice(0, 2));
  const current = g.snapshot(); assert(current.attack);
  current.attack.execution.failureReceipt = first;
  assert.throws(() => OfficialGame.restore(current, { catalog: f.catalog }), /payment|declaration/i);
});
