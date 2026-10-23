// Synthetic definitions only. Coins beyond one flip gating one instruction: the other face's result
// (「如果为正面则A，如果为反面则B」), counted flips (「与出现正面次数相同数量」「如果全部都是正面」, II.B-02 文例2),
// and later effects decided by the coins the attack's damage already flipped (II.E-38 文例3). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { scaleEffect, EffectProgramError } from '../../public/rules/effects.js';
import { advanceEffectExecution } from '../../public/rules/effect-execution.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, answer, settle, hand, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const SEEDS = Array.from({ length: 16 }, (_, i) => [4 * i + 1, 4 * i + 2, 4 * i + 3, 4 * i + 4]);
const withAttack = (effects) => (defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
  const a = defs[0].mechanics.attacks[0]; a.printedDamage = null; a.effects = effects;
};
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const coinEvents = (g) => g.snapshot().events.filter((e) => e.ruleId === 'effects.coin');
// Play one board per seed; `run` acts and returns what to compare for that seed's flips.
function perSeed(f, mutate, act) {
  return SEEDS.map((seed) => { const g = board({ ...f, seed }, mutate); return act(g); });
}
const opponentDeck = (g) => g.snapshot().players[1].deck.length;

test('schemas and rules: the other face, counted flips, results of the damage coins', () => {
  for (const id of ['effects.coin', 'effects.coin-count', 'effects.coin-result']) assert(requireRule(CN_V20261019, id));
  assert(requireRule(CN_V20261019, 'effects.coin-result').sourceOfTruth.some((s) => s.section.includes('II.E-38 文例3')));
  const draw = leaf('cn.draw@1', { count: 1 }), sleep = leaf('cn.condition@1', { side: 'opponent', condition: 'asleep' });
  assert(valid('cn.coin@1', { outcome: 'heads', effect: sleep, otherwise: leaf('cn.condition@1', { side: 'opponent', condition: 'confused' }) }));
  assert(!valid('cn.coin@1', { outcome: 'heads', effect: sleep, otherwise: leaf('cn.draw@1', { count: 0 }) }));
  const coins = (extra) => ({ flips: { kind: 'fixed', count: 3 }, face: 'heads', apply: { kind: 'scale' }, effect: draw, ...extra });
  for (const p of [coins(), coins({ flips: { kind: 'untilTails' } }), coins({ face: 'tails' }), coins({ apply: { kind: 'all' }, effect: sleep }),
    coins({ apply: { kind: 'atLeast', count: 2 }, effect: sleep }),
    coins({ effect: leaf('cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'upTo', count: 1 },
      reveal: true, lookTop: null, shuffleAfter: false }) })])
    assert(valid('cn.coins@1', p), JSON.stringify(p));
  for (const p of [coins({ effect: sleep }), coins({ flips: { kind: 'fixed', count: 0 } }), coins({ apply: { kind: 'atLeast' } }),
    coins({ effect: leaf('cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'any' },
      reveal: true, lookTop: null, shuffleAfter: false }) }), coins({ effect: leaf('cn.draw@1', { count: 0 }) })])
    assert(!valid('cn.coins@1', p), JSON.stringify(p));
  const heads = { kind: 'compare', left: { kind: 'coin', key: 'flip', field: 'heads' }, relation: 'gt', right: lit(0) };
  assert(valid('cn.coinResult@1', { condition: heads, effect: sleep, otherwise: draw }));
  assert(valid('cn.coinResult@1', { condition: { kind: 'not', condition: heads }, effects: [sleep, draw] }));
  assert(!valid('cn.coinResult@1', { condition: { kind: 'compare', left: { kind: 'pokemon', who: 'self', field: 'damageCounters' },
    relation: 'gt', right: lit(0) }, effect: sleep }));
});

test('「如果为正面则A，如果为反面则B」: exactly one of the two printed results, from one flip', async () => {
  // Paralysis and Confusion both outlast the checkup right after this turn (Sleep could wake up there).
  const f = await fixture(withAttack([binding('cn.coin@1', { outcome: 'heads', effect: leaf('cn.condition@1', { side: 'opponent', condition: 'paralyzed' }),
    otherwise: leaf('cn.condition@1', { side: 'opponent', condition: 'confused' }) }, 'either')]));
  const seen = perSeed(f, (s) => { attached(s, 0, s.players[0].active, 'water'); }, (g) => {
    attack(g); settle(g);
    restore(g, f);
    const result = coinEvents(g)[0].data.result, rotation = g.snapshot().players[1].active.conditions.rotation;
    assert.equal(rotation, result === 'heads' ? 'paralyzed' : 'confused');
    return result;
  });
  assert.deepEqual(new Set(seen), new Set(['heads', 'tails']));
  // A Trainer whose heads result could change nothing is still playable for its other face.
  const t = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.coin@1', { outcome: 'heads',
    effect: leaf('cn.heal@1', { target: 'active', amount: 30 }), otherwise: leaf('cn.draw@1', { count: 1 }) }, 'mixed')]; });
  let card;
  const g = board(t, (s) => { card = hand(s, 0, 'potion'); });
  assert(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card));
});

test('counted flips: 「出现正面次数×3张」, until tails, and the tails count; zero performs nothing', async () => {
  const mill = await fixture(withAttack([binding('cn.coins@1', { flips: { kind: 'fixed', count: 3 }, face: 'heads', apply: { kind: 'scale' },
    effect: leaf('cn.discardDeckTop@1', { side: 'opponent', count: 3 }) }, 'mill')]));
  const heads = perSeed(mill, (s) => { attached(s, 0, s.players[0].active, 'water'); }, (g) => {
    const before = opponentDeck(g);
    attack(g); settle(g);
    const { receipt } = coinEvents(g)[0].data;
    assert.equal(receipt.flips, 3);
    // The opponent's next turn begins with a draw.
    assert.equal(before - opponentDeck(g), receipt.heads * 3 + 1);
    restore(g, mill);
    return receipt.heads;
  });
  assert(heads.includes(0) && heads.some((n) => n > 0), JSON.stringify(heads));
  const draws = await fixture(withAttack([binding('cn.coins@1', { flips: { kind: 'untilTails' }, face: 'heads', apply: { kind: 'scale' },
    effect: leaf('cn.draw@1', { count: 1 }) }, 'draws')]));
  perSeed(draws, (s) => { attached(s, 0, s.players[0].active, 'water'); }, (g) => {
    const before = g.snapshot().players[0].hand.length;
    attack(g); settle(g);
    const { receipt } = coinEvents(g)[0].data;
    assert.equal(receipt.results.at(-1), 'tails');
    assert.equal(g.snapshot().players[0].hand.length, before + receipt.heads);
  });
  const tails = await fixture(withAttack([binding('cn.coins@1', { flips: { kind: 'fixed', count: 3 }, face: 'tails', apply: { kind: 'scale' },
    effect: leaf('cn.attachedEnergy@1', { op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' }, providedTypes: null,
      measure: 'cards', quantity: { kind: 'exact', count: 1 }, chooser: 'source' }) }, 'shed')]));
  perSeed(tails, (s) => { for (let i = 0; i < 3; i++) attached(s, 0, s.players[0].active, 'water'); }, (g) => {
    attack(g); settle(g);
    const { receipt } = coinEvents(g)[0].data;
    assert.equal(g.snapshot().players[0].active.energy.length, 3 - receipt.tails);
  });
});

test('「选择…最多与出现正面次数相同数量」 bounds the choice; the scaled step survives restore, a forged count does not', async () => {
  const f = await fixture(withAttack([binding('cn.coins@1', { flips: { kind: 'fixed', count: 3 }, face: 'heads', apply: { kind: 'scale' },
    effect: leaf('cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'upTo', count: 1 },
      reveal: true, lookTop: null, shuffleAfter: false }) }, 'recover')]));
  let checked = false;
  perSeed(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    for (const id of ['potion', 'poison', 'research']) { const c = hand(s, 0, id); s.players[0].hand.pop(); s.players[0].discard.push(c); }
  }, (g) => {
    attack(g);
    const { receipt } = coinEvents(g)[0].data;
    if (!receipt.heads) { assert.equal(g.snapshot().pending?.ruleId === 'selection.up-to', false); settle(g); return; }
    const q = g.view(0).pending;
    assert.deepEqual([q.kind, q.maximum], ['select-cards', receipt.heads]);
    restore(g, f);
    const forged = clone(g.snapshot());
    const advance = forged.events.findLast((e) => e.ruleId === 'effects.execution' && e.data.mode === 'scaled');
    advance.data.times = receipt.heads === 3 ? 2 : receipt.heads + 1;
    assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }));
    answer(g, q.options.slice(0, q.maximum)); settle(g);
    checked = true;
  });
  assert(checked, 'Some seed shows heads.');
});

test('「如果全部都是正面」 and 「如果出现2次以上正面」 open only on that result', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.coins@1', { flips: { kind: 'fixed', count: 2 },
    face: 'heads', apply: { kind: 'all' }, effect: leaf('cn.draw@1', { count: 3 }) }, 'jackpot')]; });
  const results = perSeed(f, (s) => { hand(s, 0, 'potion'); }, (g) => {
    const card = g.snapshot().players[0].hand.find((id) => g.snapshot().cards[id].definitionId === 'potion');
    const before = g.snapshot().players[0].hand.length;
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    const { receipt } = coinEvents(g)[0].data;
    assert.equal(g.snapshot().players[0].hand.length, before - 1 + (receipt.heads === 2 ? 3 : 0));
    return receipt.heads === 2;
  });
  assert.deepEqual(new Set(results), new Set([true, false]));
  const most = await fixture(withAttack([binding('cn.coins@1', { flips: { kind: 'fixed', count: 4 }, face: 'heads',
    apply: { kind: 'atLeast', count: 2 }, effect: leaf('cn.condition@1', { side: 'opponent', condition: 'paralyzed' }) }, 'stun')]));
  perSeed(most, (s) => { attached(s, 0, s.players[0].active, 'water'); }, (g) => {
    attack(g); settle(g);
    const { receipt } = coinEvents(g)[0].data;
    assert.equal(g.snapshot().players[1].active.conditions.rotation, receipt.heads >= 2 ? 'paralyzed' : null);
  });
});

test('II.E-38 文例3: a later effect reads the coins the damage flipped, without flipping again', async () => {
  const flipHeads = { kind: 'compare', left: { kind: 'coin', key: 'flip', field: 'heads' }, relation: 'gt', right: lit(0) };
  const damage = binding('cn.damageValue@1', { expression: { kind: 'choose', condition: flipHeads, ifTrue: lit(50), ifFalse: lit(20) },
    rolls: [{ key: 'flip', spec: { kind: 'fixed', count: 1 } }] }, 'damage');
  const after = binding('cn.coinResult@1', { condition: flipHeads, effect: leaf('cn.heal@1', { target: 'self', amount: 30 }),
    otherwise: leaf('cn.condition@1', { side: 'opponent', condition: 'paralyzed' }) }, 'after');
  const f = await fixture(withAttack([damage, after]));
  const results = perSeed(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = 5; }, (g) => {
    attack(g); settle(g);
    const s = g.snapshot(), rolled = s.events.find((e) => e.ruleId === 'damage.coins' && e.data.kind === 'rolled').data.receipt;
    assert.equal(coinEvents(g).length, 0, 'No second flip.');
    const won = rolled.heads > 0;
    assert.deepEqual([s.players[0].active.counters, s.players[1].active.counters, s.players[1].active.conditions.rotation],
      won ? [2, 5, null] : [5, 2, 'paralyzed']);
    restore(g, f);
    return won;
  });
  assert.deepEqual(new Set(results), new Set([true, false]));
  // 「则追加造成90点伤害，使对手的战斗宝可梦陷入【混乱】状态，并…」: several results of one face, in order.
  const both = await fixture(withAttack([damage, binding('cn.coinResult@1', { condition: flipHeads, effects: [
    leaf('cn.condition@1', { side: 'opponent', condition: 'confused' }), leaf('cn.heal@1', { target: 'self', amount: 30 })] }, 'after')]));
  perSeed(both, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = 5; }, (g) => {
    attack(g); settle(g);
    const won = g.snapshot().events.find((e) => e.ruleId === 'damage.coins' && e.data.kind === 'rolled').data.receipt.heads > 0;
    assert.deepEqual([g.snapshot().players[1].active.conditions.rotation, g.snapshot().players[0].active.counters], won ? ['confused', 2] : [null, 5]);
  });
  // Load guard: attacks only, and only rolls the damage always flips.
  const catalog = { handler: (id) => handlers.get(id) };
  const mon = clone(def(f.definitions, 'base'));
  for (const effects of [[after], [binding('cn.damageValue@1', { expression: lit(20), rolls: [{ key: 'flip', spec: { kind: 'fixed', count: 1 },
    condition: { kind: 'compare', left: lit(1), relation: 'gt', right: lit(0) } }] }, 'damage'), after]]) {
    mon.mechanics.attacks[0].effects = effects;
    assert.throws(() => assertSupportedDefinition(catalog, mon), (e) => e.code === 'unsupported-condition');
  }
  mon.mechanics.attacks[0].effects = [damage, after];
  assert.doesNotThrow(() => assertSupportedDefinition(catalog, mon));
  const item = clone(def(f.definitions, 'potion'));
  item.mechanics.effects = [after];
  assert.throws(() => assertSupportedDefinition(catalog, item), (e) => e.code === 'unsupported-handler');
});

test('the execution journal opens the other face or a scaled count only for those coin nodes', () => {
  const draw = { op: 'sequence', steps: [{ op: 'draw', count: 1 }] };
  const counted = { op: 'coins', flips: { kind: 'fixed', count: 2 }, face: 'heads', apply: { kind: 'scale', path: 'count' }, effect: draw };
  assert.deepEqual(scaleEffect(counted, 2), { op: 'sequence', steps: [{ op: 'draw', count: 2 }] });
  const bundle = { ...counted, apply: { kind: 'scale', path: 'quantity' } };
  assert.throws(() => scaleEffect(bundle, 2), EffectProgramError);
  assert.throws(() => scaleEffect({ ...counted, effect: { op: 'sequence', steps: [] } }, 1), EffectProgramError);
  const cursor = (action) => ({ id: 'p', index: 0, step: { action, frames: [] } });
  const advance = (mode, extra = {}) => ({ ruleId: 'effects.execution', visibility: 'private',
    data: { kind: 'advance', id: 'p', index: 0, mode, performed: true, ...extra } });
  const coin = { op: 'coin', outcome: 'heads', effect: draw };
  assert.deepEqual(advanceEffectExecution(cursor({ ...coin, otherwise: draw }), advance('otherwise')).step.action, draw);
  assert.deepEqual(advanceEffectExecution(cursor(counted), advance('scaled', { times: 3 })).step.action.steps[0].count, 3);
  assert.deepEqual(advanceEffectExecution(cursor({ ...counted, apply: { kind: 'all' } }), advance('optional')).step.action, draw);
  for (const [action, event] of [[coin, advance('otherwise')], [coin, advance('scaled', { times: 1 })], [counted, advance('optional')]])
    assert.throws(() => advanceEffectExecution(cursor(action), event), (e) => e.code === 'invalid-execution-transition');
});

test('「抛掷1次硬币如果为正面，则选择1种特殊状态，使对手的战斗宝可梦陷入该特殊状态」: heads leads to one choice', async () => {
  const condition = (c) => leaf('cn.condition@1', { side: 'opponent', condition: c });
  const choose = leaf('cn.chooseOne@1', { options: ['asleep', 'paralyzed', 'confused', 'poisoned', 'burned'].map(condition) });
  assert(valid('cn.coin@1', { outcome: 'heads', effect: choose }));
  assert(!valid('cn.coin@1', { outcome: 'heads', effect: leaf('cn.chooseOne@1', { options: [condition('asleep')] }) }));
  assert(!valid('cn.coin@1', { outcome: 'heads', effect: condition('asleep'), otherwise: choose }), 'Only the printed result.');
  const f = await fixture(withAttack([binding('cn.coin@1', { outcome: 'heads', effect: choose }, 'gamble')]));
  const results = perSeed(f, (s) => { attached(s, 0, s.players[0].active, 'water'); }, (g) => {
    attack(g);
    const heads = coinEvents(g).at(-1)?.data.result === 'heads';
    if (heads) {
      assert.equal(g.snapshot().pending.kind, 'choose-effect');
      restore(g, f);
      answer(g, [g.snapshot().pending.options[3]]);
    }
    settle(g);
    const c = g.snapshot().players[1].active.conditions;
    assert.equal(c.poison !== null, heads);
    return heads;
  });
  assert(results.includes(true) && results.includes(false));
});
