// Synthetic definitions only. 「在自己的回合，当将这张卡牌从手牌使出放于备战区时，可使用1次，如果使用了的话，则自己的回合结束。选择自己牌库中最多2张
// 「宝可梦【VMAX】」，放于备战区。并重洗牌库。」 (effects.end-turn-trigger; JP official Q&A かがやくムゲンダイナ「クライマックスゲート」 with
// 「大口の沼」). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const gate = (extra = {}) => ({ abilityId: 'other:gate', name: '测试巅峰之门', mode: 'triggered', usage: null, endsTurn: true, sourceOfTruth: EVIDENCE,
  trigger: { event: 'bench', origin: 'hand', subject: 'self', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true },
  effects: [binding('cn.cards@1', { from: 'deck', to: 'bench', selector: { kind: 'pokemon', nameKeys: ['base'] }, quantity: { kind: 'upTo', count: 2 },
    reveal: false, lookTop: null, shuffleAfter: true }, 'gate')], ...extra });
// Another effect of the same event: the Active 'base' puts 1 damage counter on each own Pokémon played from the hand to the Bench.
const watch = { abilityId: 'base:watch', name: '测试大口沼', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
  trigger: { event: 'bench', origin: 'hand', subject: 'own', scope: 'subject', choiceOwner: 'source', optional: false },
  effects: [binding('cn.counters@1', { side: 'own', target: 'event', count: 1 }, 'watch')] };
// Test-only deck shape: more of the Basic it searches for.
const radiant = async (extra) => {
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [gate(extra)]; def(defs, 'base').mechanics.abilities = [watch]; def(defs, 'base').deckLimits.sameName = null;
  });
  for (let i = 0; i < 4; i++) f.deck[f.deck.lastIndexOf('printing:water')] = 'printing:base';
  return f;
};

test('schema: a triggered Ability may end the turn; a continuous one may not', async () => {
  await radiant();
  const sturdy = (endsTurn) => fixture((defs) => {
    const { trigger: _t, endsTurn: _e, ...rest } = gate({ mode: 'continuous', effects: [binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'self' }, 'hp')] });
    def(defs, 'other').mechanics.abilities = [{ ...rest, ...(endsTurn ? { endsTurn } : {}) }];
  });
  await sturdy(false);
  await assert.rejects(sturdy(true), /Invalid normalized card definition/);
});

for (const first of ['gate', 'watch']) test(`used: its effect and the other effect of the same event (${first} first), then the turn ends`, async () => {
  const f = await radiant();
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'other'); });
  command(g, { type: 'bench', cardId: card });
  const asked = [];
  settle(g, (q) => {
    asked.push(q.kind);
    if (q.kind === 'trigger-order') return [q.options.find((id) => g.snapshot().pending.data.units.find((u) => u.id === id).abilityId === `${first === 'gate' ? 'other' : 'base'}:${first}`)];
    if (q.kind === 'trigger-optional') return ['perform'];
    return q.options.slice(0, Math.max(q.minimum, Math.min(2, q.maximum)));
  });
  const s = g.snapshot(), p = s.players[0], benched = p.bench.find((m) => m.stack.includes(card));
  assert(asked.includes('trigger-order'));
  assert.equal(benched.counters, 1, 'The other effect of the same event still happened.');
  assert.equal(p.bench.filter((m) => s.cards[m.stack[0]].definitionId === 'base').length, 2);
  assert.equal(s.current, 1, 'The turn ended.');
  assert(s.events.some((e) => e.ruleId === 'turn.end' && e.data.player === 0));
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
});

test('not used: the turn goes on', async () => {
  const f = await radiant();
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'other'); });
  command(g, { type: 'bench', cardId: card });
  settle(g, (q) => q.kind === 'trigger-optional' ? ['skip'] : q.options.slice(0, Math.max(q.minimum, 1)));
  const s = g.snapshot();
  assert.equal(s.current, 0); assert.equal(s.phase, 'main');
  assert.equal(s.players[0].bench.find((m) => m.stack.includes(card)).counters, 1);
});
