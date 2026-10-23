// Synthetic definitions only. 「从自己的牌库下方抽取3张卡牌」 and 「查看自己牌库下方4张卡牌，将其中2张卡牌，加入手牌。将剩余的卡牌，以任意顺序重新排列后，
// 放回牌库下方」「查看自己牌库下方7张卡牌，选择其中1张宝可梦，在给对手看过之后，加入手牌。将剩余的卡牌放回牌库并重洗牌库」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const look = (extra) => clone({ from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 2 }, reveal: false, lookTop: null,
  lookBottom: 4, remainder: 'deckBottom', shuffleAfter: false, ...extra });

test('schema: a bottom window only from the deck, with no top window', () => {
  const valid = (p) => createCoreHandlers().get('cn.cards@1').validateParameters(clone(p));
  assert(valid(look())); assert(valid(look({ remainder: undefined, shuffleAfter: true, selector: { kind: 'pokemon' }, quantity: { kind: 'upTo', count: 1 } })));
  for (const p of [look({ lookTop: 3 }), look({ from: 'discard', to: 'hand', remainder: undefined }), look({ to: 'bench', remainder: undefined, shuffleAfter: true })])
    assert(!valid(p), JSON.stringify(p));
  assert(createCoreHandlers().get('cn.draw@1').validateParameters({ count: 3, bottom: true }));
  assert(!createCoreHandlers().get('cn.draw@1').validateParameters({ count: 3, bottom: false }));
});

test('「从自己的牌库下方抽取3张卡牌」 takes the bottom cards', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.draw@1', { count: 3, bottom: true }, 'under')]; });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); });
  const bottom = g.snapshot().players[0].deck.slice(0, 3);
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  const s = g.snapshot();
  assert(bottom.every((id) => s.players[0].hand.includes(id)));
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
});

test('a bottom look: two to hand, the rest back to the bottom in the chosen order; or a shuffle', async () => {
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.cards@1', look(), 'dig')];
    def(defs, 'research').mechanics.effects = [binding('cn.cards@1', look({ lookBottom: 7, remainder: undefined, shuffleAfter: true,
      selector: { kind: 'pokemon' }, quantity: { kind: 'upTo', count: 1 }, reveal: true }), 'ball')];
  });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); });
  const window = g.snapshot().players[0].deck.slice(0, 4);
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.snapshot().pending;
  assert.deepEqual([...q.options].sort(), [...window].sort());
  assert.deepEqual(g.view(0).pending.lookedAt.map((c) => c.instanceId), window, 'Shown from the bottom.');
  answer(g, [window[0], window[1]]);
  const rest = g.snapshot().pending.options;
  assert.deepEqual([...rest].sort(), [window[2], window[3]].sort());
  answer(g, [window[3], window[2]]); settle(g);
  const s = g.snapshot();
  assert([window[0], window[1]].every((id) => s.players[0].hand.includes(id)));
  assert.deepEqual(s.players[0].deck.slice(0, 2), [window[2], window[3]], 'The first chosen uppermost of the two.');
  let ball;
  const k = board(f, (s) => {
    ball = hand(s, 0, 'research');
    const p = s.players[0], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'other');
    p.deck.unshift(p.deck.splice(i, 1)[0]);
  });
  const deck = k.snapshot().players[0].deck;
  command(k, { type: 'playTrainer', cardId: ball });
  const options = k.snapshot().pending.options;
  assert(options.every((id) => deck.slice(0, 7).includes(id)));
  answer(k, [options[0]]); settle(k);
  assert(k.snapshot().players[0].hand.includes(options[0]));
  assert(k.snapshot().events.some((e) => e.ruleId === 'effects.shuffle'));
});
