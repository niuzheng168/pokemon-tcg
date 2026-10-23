// Synthetic definitions only. II.D-16 剩余HP (maximum HP with its effects, less damage), read when an effect uses it:
// II.C-07 「放置伤害指示物，直到其剩余HP变为「N」」 places (remaining HP − N) ÷ 10 counters; 「剩余HP在「N」以下」 limits a
// switch or Knock Out choice. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers, validateCoinEffect } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, settle, hand, bench } from './fixtures.mjs';

const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const until = (remainingHp, target = 'active') => ({ side: 'opponent', target, remainingHp });
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);

test('「直到其剩余HP变为N」: parameters, program and the cited remaining-HP definition', () => {
  assert(requireRule(CN_V20261019, 'damage.counters').sourceOfTruth.some((s) => s.section.includes('II.D-16')));
  const h = handlers.get('cn.countersUntil@1');
  assert(h.validateParameters(until(30)));
  for (const bad of [until(35), until(0), { ...until(30), count: 1 }, { side: 'opponent', target: 'active' }])
    assert(!h.validateParameters(bad), JSON.stringify(bad));
  assert.deepEqual(h.execute({}, until(50, 'any')), [{ op: 'counters', side: 'opponent', target: 'any', untilRemainingHp: 50 }]);
  assert(validateCoinEffect({ outcome: 'heads', effect: { handlerId: 'cn.countersUntil@1', parameters: until(10) } }), 'It nests under a coin flip.');
});

test('the counters bring the remaining HP of the effective maximum HP down to N; none at N or less', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.countersUntil@1', until(30), 'until')]; });
  const run = (counters, tool) => {
    let card;
    const g = board(f, (s) => {
      card = hand(s, 0, 'potion'); s.players[1].active.counters = counters;
      if (tool) { const t = hand(s, 1, 'hp-tool'); s.players[1].hand.pop(); s.players[1].active.tools.push(t); }
    });
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    return g.snapshot();
  };
  assert.equal(run(2).players[1].active.counters, 7, 'HP 100 with 20 damage: 5 counters leave 30.');
  assert.equal(run(2, true).players[1].active.counters, 12, 'HP 150 with the HP Tool: 10 counters leave 30.');
  const none = run(8);
  assert.equal(none.players[1].active.counters, 8, 'Remaining HP 20 is already 30 or less.');
  assert(!none.events.some((e) => e.ruleId === 'damage.counters' && e.data.effectId === 'fixture:until'));
});

test('「剩余HP在「N」以下（包含「N」）」 limits a switch or Knock Out choice, never a continuous effect', async () => {
  const modifier = (targetState) => handlers.get('cn.modifier@1').validateParameters({ field: 'attackDamage', amount: 30, scope: 'self', targetState });
  assert.equal(modifier({ damaged: true }), true);
  assert.equal(modifier({ remainingHpAtMost: 30 }), false, 'A continuous effect cannot read the remaining HP.');
  assert.equal(handlers.get('cn.switch@1').validateParameters({ side: 'opponent', chooser: 'self', affected: 'selected', state: { remainingHpAtMost: 35 } }), false);
  const effect = (id, p) => fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding(id, p, 'hp')]; });
  const f = await effect('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected', state: { remainingHpAtMost: 50 } });
  let card, low, full;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); low = bench(s, 1, 'other'); full = bench(s, 1, 'other'); low.counters = 6; });
  command(g, { type: 'playTrainer', cardId: card });
  assert.deepEqual(g.snapshot().pending.options, [low.id], 'Remaining HP 40 qualifies; 100 does not.');
  const none = board(f, (s) => { card = hand(s, 0, 'potion'); bench(s, 1, 'other'); });
  assert(!playable(none, card), 'No Benched Pokémon has 50 HP or less left.');
  assert(full);
  const ctx = { source: { owner: 0 }, state: none.snapshot(), effectivePokemon: {}, definitions: {} };
  assert.throws(() => handlers.get('cn.knockOut@1').canUse(ctx, { target: 'active', side: 'opponent', state: { remainingHpAtMost: 100 } }), TypeError);
  const k = await effect('cn.knockOut@1', { target: 'active', side: 'opponent', state: { remainingHpAtMost: 100 } });
  for (const [counters, knockedOut] of [[4, false], [5, true]]) {
    const h = board(k, (s) => {
      card = hand(s, 0, 'potion'); s.players[1].active.counters = counters;
      const t = hand(s, 1, 'hp-tool'); s.players[1].hand.pop(); s.players[1].active.tools.push(t);
    });
    assert.equal(playable(h, card), knockedOut, `HP 150 with ${counters} counters.`);
    if (!knockedOut) continue;
    command(h, { type: 'playTrainer', cardId: card }); settle(h);
    assert(h.snapshot().events.some((e) => e.ruleId === 'effects.knockout' && e.data.effectId === 'fixture:hp'));
  }
});
