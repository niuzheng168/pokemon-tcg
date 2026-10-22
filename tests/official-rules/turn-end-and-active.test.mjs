// Synthetic definitions only. 「如果使用了，则自己的回合结束」 (II.E-20 文例3) on a Trainer or an Ability, and the trigger
// 「当这只宝可梦从备战区被放入战斗场时」 (II.E-24's Bench-to-Active move). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { triggerRuleId } from '../../public/rules/triggers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const draw = (key) => [binding('cn.draw@1', { count: 1 }, key)];
const ability = (key, effects, extra) => ({ abilityId: `fixture:${key}`, name: `测试${key}`, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: `fixture:${key}`, limit: 1 }, effects, sourceOfTruth: EVIDENCE, ...extra });
const arrival = (key) => ({ abilityId: `fixture:${key}`, name: `测试${key}`, mode: 'triggered', usage: { period: 'turn', scope: 'pokemon',
  key: `fixture:${key}`, limit: 1 }, effects: draw(key), sourceOfTruth: EVIDENCE,
  trigger: { event: 'becameActive', subject: 'self', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true } });

test('II.E-20: a Trainer that ends the turn resolves, is discarded, then the turn ends', async () => {
  assert(requireRule(CN_V20261019, 'effects.end-turn').sourceOfTruth.some((s) => s.section === 'II.E-20'));
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.endsTurn = true; });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); s.players[0].active.counters = 3; });
  const turn = g.snapshot().turn;
  command(g, { type: 'playTrainer', cardId: card });
  restore(g, f); settle(g);
  const s = g.snapshot();
  assert.deepEqual([s.players[0].active.counters, s.players[0].discard.includes(card), s.current, s.turn], [0, true, 1, turn + 1]);
  const order = s.events.map((e) => e.ruleId);
  assert(order.lastIndexOf('turn.trainer') < order.indexOf('turn.end'), 'The card finishes before the turn ends.');
  await assert.rejects(fixture((defs) => { def(defs, 'tool').mechanics.endsTurn = true; }), /definition/i);
});

test('II.E-20 文例3: an activated Ability that ends the turn; only activated Abilities may print it', async () => {
  const f = await fixture((defs) => { def(defs, 'other').mechanics.abilities = [ability('rest', draw('rest'), { endsTurn: true })]; });
  let mon;
  const g = board(f, (s) => { mon = bench(s, 0, 'other'); });
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'useAbility', pokemonId: mon.id, abilityId: 'fixture:rest' }); settle(g);
  const s = g.snapshot();
  assert.deepEqual([s.players[0].hand.length, s.current], [before + 1, 1]);
  restore(g, f);
  await assert.rejects(fixture((defs) => { def(defs, 'other').mechanics.abilities = [{ ...ability('bad', draw('bad'), { endsTurn: true }),
    mode: 'continuous', usage: null, effects: [binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'self' }, 'bad')] }]; }), /definition/i);
});

test('「当这只宝可梦从备战区被放入战斗场时」 opens after a Retreat and after a switching effect, on the holder\'s turn', async () => {
  assert.equal(triggerRuleId('becameActive'), 'trigger.became-active');
  assert(requireRule(CN_V20261019, 'trigger.became-active').sourceOfTruth.some((s) => s.section === 'II.E-24'));
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [arrival('arrive')];
    def(defs, 'potion').mechanics.effects = [binding('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' }, 'switch')];
  });
  for (const perform of [true, false]) {
    let mon;
    const g = board(f, (s) => { mon = bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water'); });
    const before = g.snapshot().players[0].hand.length;
    command(g, { type: 'retreat' });
    settle(g, (q) => q.kind === 'trigger-optional' ? [perform ? 'perform' : 'skip'] : q.kind === 'retreat-target' ? [mon.id] :
      q.options.slice(0, Math.max(q.minimum, 1)));
    const s = g.snapshot();
    assert.equal(s.players[0].active.id, mon.id);
    assert.equal(s.players[0].hand.length, before + (perform ? 1 : 0));
    assert(s.events.some((e) => e.ruleId === 'trigger.became-active'));
    restore(g, f);
  }
  let card, mon;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); mon = bench(s, 0, 'other'); });
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'playTrainer', cardId: card });
  settle(g, (q) => q.kind === 'trigger-optional' ? ['perform'] : q.kind === 'effect-target' ? [mon.id] : q.options.slice(0, q.minimum));
  assert.deepEqual([g.snapshot().players[0].active.id, g.snapshot().players[0].hand.length], [mon.id, before - 1 + 1]);
  // On the opponent's turn the holder's 「在自己的回合」 trigger does not open.
  const gust = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [arrival('arrive')];
    def(defs, 'potion').mechanics.effects = [binding('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected' }, 'gust')];
  });
  let theirs;
  const h = board(gust, (s) => { card = hand(s, 0, 'potion'); theirs = bench(s, 1, 'other'); });
  command(h, { type: 'playTrainer', cardId: card });
  settle(h, (q) => { assert.notEqual(q.kind, 'trigger-optional'); return q.kind === 'effect-target' ? [theirs.id] : q.options.slice(0, q.minimum); });
  assert.equal(h.snapshot().players[1].active.id, theirs.id);
});
