// Synthetic definitions only. 「选择自己牌库中从自己所有备战宝可梦进化而来的卡牌各1张，分别放于各只宝可梦身上进行进化。并重洗牌库。」:
// one hidden search per Benched Pokémon in field order (each may fail to find, II.C-12), every card chosen before any Pokémon
// evolves, one shuffle. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const timing = { firstOwnTurn: 'allow', enteredThisTurn: 'allow', evolvedThisTurn: 'needsRuling' };
const each = (extra = {}) => ({ op: 'evolvePokemon', target: 'bench', targetSelector: { kind: 'pokemon' }, from: 'deck',
  selector: { kind: 'pokemon' }, relation: 'ordinary', timing, shuffleAfter: true, each: true, ...extra });
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const top = (g, m) => g.snapshot().cards[g.snapshot().players[0].bench.find((x) => x.id === m.id).stack.at(-1)].definitionId;

async function make(evolutions = 1) {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.pokemonTransition@1', each(), 'each')];
  });
  for (const id of ['base', ...Array(evolutions - 1).fill('evolution')]) f.deck[f.deck.indexOf('printing:water')] = `printing:${id}`;
  return f;
}
function play(f, benched, mutate = () => {}) {
  let card, mons;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); mons = benched.map((id) => bench(s, 0, id)); mutate(s, mons); });
  command(g, { type: 'playTrainer', cardId: card });
  return { g, mons };
}

test('evolve each: schema and the per-Pokémon search order', async () => {
  const valid = (p) => createCoreHandlers().get('cn.pokemonTransition@1').validateParameters(clone(p));
  assert(valid(each()));
  assert(!valid(each({ from: 'hand', shuffleAfter: false })), 'Only a deck search.');
  assert(!valid(each({ each: false })));
  const f = await make();
  const { g, mons } = play(f, ['base', 'other']);
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'transition-card'); assert.equal(q.minimum, 0, 'A hidden search may fail to find.');
  assert(g.view(0).pending.lookedAt.length > 0, 'The searched deck is shown to its owner.');
  assert.equal(top(g, mons[0]), 'base', 'Nothing evolves before every card is chosen.');
  answer(g, q.options);
  restore(g, f);
  q = g.snapshot().pending;
  assert.equal(q.kind, 'view-cards', '「测试宝可梦other」 has no card in the deck.');
  const rng = g.snapshot().rng;
  answer(g, ['confirm']); settle(g);
  assert.equal(top(g, mons[0]), 'evolution'); assert.equal(top(g, mons[1]), 'other');
  assert.notDeepEqual(g.snapshot().rng, rng, 'The deck is shuffled once.');
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'effects.evolve').length, 1);
});

test('evolve each: one card per Pokémon, never the same card twice; tampered plans are refused', async () => {
  let { g, mons } = play(await make(1), ['base', 'base']);
  const card = g.snapshot().pending.options[0];
  answer(g, [card]);
  assert.equal(g.snapshot().pending.kind, 'view-cards', 'The only matching card is already taken.');
  const f = await make(2);
  ({ g, mons } = play(f, ['base', 'base']));
  answer(g, [g.snapshot().pending.options[0]]);
  assert.equal(g.snapshot().pending.options.length, 1);
  for (const mutate of [
    (d) => { d.evolutionPlan[0].cardId = 'missing'; }, (d) => { d.evolutionPlan[0].topCardId = 'missing'; },
    (d) => { d.evolutionPlan[1].cardId = d.evolutionPlan[0].cardId; }, (d) => { d.lookedAt.pop(); }, (d) => { d.evolutionPlan.pop(); },
    (d) => { delete d.evolutionPlan[0].cardId; d.evolutionPlan[1].cardId = null; },
    (d) => { d.stage = 'evolution-apply'; }, (d) => { d.stage = 'evolution-empty'; },
  ]) {
    const tampered = clone(g.snapshot()); mutate(tampered.pending.data);
    assert.throws(() => OfficialGame.restore(tampered, { catalog: f.catalog }), /Saved evolution|evolution cursor/);
  }
  answer(g, g.snapshot().pending.options); settle(g);
  assert.deepEqual(mons.map((m) => top(g, m)), ['evolution', 'evolution']);
  assert.throws(() => play(f, ['base'], (s, [m]) => { m.evolvedTurn = s.turn; }), (e) => e.code === 'unresolved-evolution-timing');
});
