// Synthetic definitions only. 「在自己的回合，如果将2张自己的手牌（除「查克洛」外）放于弃牌区的话，则将这张「查克洛」从弃牌区，在给对手看过之后，
// 加入手牌。（这个效果，不包含在自己的回合可以使用的支援者的张数内。）」 (trainer.discard-recall). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, EVIDENCE, board, command, answer, settle, hand, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const others = { anyOf: [{ kind: 'pokemon' }, { kind: 'trainer', excludeNameKeys: ['research'] }, { kind: 'energy' }] };
const recall = { costs: [{ costId: 'research:recall', kind: 'discardHand', count: 2, selector: others, sourceOfTruth: EVIDENCE }] };
const recalls = (g) => g.view(0).legalActions.filter((a) => a.type === 'recallCard');
const discardOne = (s, id) => { const card = hand(s, 0, id); s.players[0].hand.pop(); s.players[0].discard.push(card); return card; };

test('「如果将2张自己的手牌（除「X」外）放于弃牌区的话，则将这张「X」从弃牌区…加入手牌」: on its owner\'s turn, not playing it', async () => {
  const f = await fixture((defs) => { def(defs, 'research').mechanics.discardRecall = recall; });
  let card, a, b, other;
  const g = board(f, (s) => {
    card = discardOne(s, 'research'); a = hand(s, 0, 'potion'); b = hand(s, 0, 'water');
    s.players[0].flags.supporter = true;
  });
  assert.deepEqual(recalls(g), [{ type: 'recallCard', cardId: card }], 'Even after a Supporter this turn.');
  command(g, { type: 'recallCard', cardId: card });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'activation-cost'); assert.equal(q.minimum, 2);
  restore(g, f); answer(g, q.options.filter((o) => [a, b].includes(JSON.parse(o)[1])));
  settle(g);
  const s = g.snapshot(), p = s.players[0];
  assert(p.hand.includes(card) && !p.discard.includes(card));
  assert(p.discard.includes(a) && p.discard.includes(b));
  assert.equal(p.flags.supporter, true, 'Its own use is not a Supporter played.');
  assert(s.events.some((e) => e.ruleId === 'trainer.discard-recall' && e.data.revealed));
  restore(g, f);
  // Another copy of the same name is no payment; one other card is not enough; the opponent's turn is not its owner's.
  const short = board(f, (s) => { discardOne(s, 'research'); hand(s, 0, 'research'); other = hand(s, 0, 'potion'); });
  assert.deepEqual(recalls(short), []);
  const wait = board(f, (s) => { discardOne(s, 'research'); hand(s, 0, 'potion'); hand(s, 0, 'water'); fixtureClock(s, [0, 1, 0, 1]); });
  assert.deepEqual(wait.view(0).legalActions, []);
  assert(other);
});

test('trainer.discard-recall: the costs are checked like any activation cost', async () => {
  await assert.rejects(fixture((defs) => { def(defs, 'research').mechanics.discardRecall = { costs: [{ ...recall.costs[0], count: 0 }] }; }));
  const f = await fixture();
  let card;
  const g = board(f, (s) => { card = discardOne(s, 'research'); hand(s, 0, 'potion'); hand(s, 0, 'water'); });
  assert.deepEqual(recalls(g), [], 'Only a card that prints it.');
  assert.throws(() => command(g, { type: 'recallCard', cardId: card }), /not legal/);
});
