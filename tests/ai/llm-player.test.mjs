// What the language model (ai/llm-player.mjs: 小茂 at a model level, the coach beside the player) is told of the cards
// its player cannot see, with a fake model: once the player has looked through the whole deck, its Prize cards and what
// is left in the deck (bug-20261029T122207Z-match-7: the coach kept saying to search the deck for a Prize card).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../../public/rules/engine.js';
import { llmPlayer } from '../../ai/llm-player.mjs';
import { reviewed, board, BOLT, DECK, STANDARD_FORMAT } from '../cn-cards/helpers.mjs';

// The model: judges the first option the one to choose; every question it is asked is kept.
function fakeModel() {
  const asked = [];
  const ask = async (system, user) => {
    const text = typeof user === 'string' ? user : user.at(-1).content;
    asked.push(text);
    const options = [...text.matchAll(/^(\d+)\. /gm)].map((m) => ({ option: Number(m[1]), choose: m[1] === '0', reason: '假模型' }));
    return { json: { options }, usage: {}, items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ options }) }] }] };
  };
  return { asked, ask };
}
const row = (text, label) => text.split('\n').find((l) => l.startsWith(label)) ?? null;

test('after a search shows the whole deck the model knows its Prize cards and what is left in the deck, and only then', async () => {
  const ctx = await reviewed([1, 3, 5, 7], [BOLT, DECK], { ...STANDARD_FORMAT, id: 'open' });
  let ball;
  const game = board(ctx, ['raging-bolt', 'mareep'], (s, h) => {
    const p = s.players[0], [latias] = h.hand(0, 'latias-ex');
    p.hand.pop(); p.deck.push(p.prizes.shift()); p.prizes.push(latias);
    [ball] = h.hand(0, 'nest-ball', 'nest-ball');
  });
  let sim = new Simulation(game.snapshot(), ctx.catalog);
  // (As server/play.mjs reads its mirror: a position made again from a snapshot keeps the seats.)
  const table = { get state() { return sim.state; }, get actor() { return sim.actor; }, view: (p, o) => sim.view(p, o) };
  const name = (id) => ctx.catalog.definition(sim.state.cards[id].definitionId).name;
  const names = (ids) => [...new Set(ids.map(name))];
  const coach = fakeModel(), alone = fakeModel(), seats = [
    llmPlayer(table, ctx.catalog, 0, { deck: 'raging-bolt-679141', advisor: true, explain: true, ask: coach.ask }),
    llmPlayer(table, ctx.catalog, 0, { deck: 'raging-bolt-679141', session: false, ask: alone.ask })];
  const move = (action) => {
    const before = sim.view(0);
    assert.equal(sim.attempt(0, action), null);
    for (const seat of seats) seat.played(0, action, before);
  };

  for (const seat of seats) await seat.decide(0);
  for (const { asked } of [coach, alone]) {
    assert.equal(row(asked.at(-1), '你的奖赏卡'), null, 'Before looking at the deck the Prizes are not known.');
    assert.equal(row(asked.at(-1), '你的牌库'), null);
  }

  // 巢穴球: the request shows every card of the deck; the Prizes are what is not there.
  move({ type: 'playTrainer', cardId: ball });
  for (let q; (q = sim.view(0).pending); ) {
    if (q.kind === 'select-cards') assert.equal(q.lookedAt.length, sim.state.players[0].deck.length, 'The search shows the whole deck.');
    move({ type: 'answer', requestId: q.id, selected: q.options.slice(0, Math.max(q.minimum ?? 0, 1)) });
  }
  for (const seat of seats) await seat.decide(1);
  const p = sim.state.players[0];
  for (const { asked } of [coach, alone]) {
    assert.equal(asked.length, 2);
    const prizes = row(asked.at(-1), '你的奖赏卡'), deck = row(asked.at(-1), '你的牌库');
    assert.match(prizes, /^你的奖赏卡（看过整副牌库，由此可知）：/);
    assert.ok(prizes.includes('拉帝亚斯ex'), prizes);
    assert.deepEqual(prizes.replace(/^.*?：/, '').split('、').map((x) => x.replace(/×\d+$/, '')).sort(), names(p.prizes).sort());
    assert.match(deck, new RegExp(`^你的牌库（${p.deck.length}张）：`));
    assert.ok(!deck.includes('拉帝亚斯ex'), deck);
    assert.deepEqual(deck.replace(/^.*?：/, '').split('、').map((x) => x.replace(/×\d+$/, '')).sort(), names(p.deck).sort());
  }

  // A Prize card swapped face down for the deck's top card: the new one is only counted, with what is left in the deck.
  const s = structuredClone(sim.snapshot()), q = s.players[0], [gone] = q.prizes.splice(0, 1, q.deck.pop());
  q.deck.push(gone);
  sim = new Simulation(s, ctx.catalog);
  seats[0].reset();
  await seats[0].decide(2);
  const prizes = row(coach.asked.at(-1), '你的奖赏卡'), deck = row(coach.asked.at(-1), '你的牌库');
  assert.match(prizes, /，另有1张后来放进去的不知道是什么$/);
  assert.match(deck, new RegExp(`^你的牌库（${q.deck.length}张）和那1张不知道的奖赏卡：`));
});
