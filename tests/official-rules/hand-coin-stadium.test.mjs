// Synthetic definitions only. 「将自己的手牌全部放回牌库并重洗牌库。然后，抛掷1次硬币，如果为正面，则从牌库上方抽取8张卡牌，如果为反面，
// 则…抽取3张卡牌」 and 「双方玩家各抛掷1次硬币」 (drawCount coin); Stadiums 「可将自己的手牌全部放回牌库并重洗牌库。在这种情况下，可从
// 自己的牌库上方抽取5张卡牌。如果使用了这个效果的话，自己的回合结束」, 「可抛掷1次硬币。如果为正面，则…」 and 「在这个回合，从手牌使出了
// 支援者的玩家，可…」 (stadium.use); 「对手若希望，可从牌库上方抽取1张卡牌。在这种情况下，自己额外从牌库上方抽取1张卡牌」
// (selection.opponent-optional); 「抛掷与自己场上的「X」数量相同次数的硬币」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers, validateOptionalEffect } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const coins = (s) => s.events.filter((e) => e.ruleId === 'effects.coin');
const supporter = (...effects) => fixture((defs) => { def(defs, 'research').mechanics.effects = effects; });
const stadium = (effect, extra = {}) => fixture((defs) => {
  def(defs, 'stadium').mechanics.effects = [binding('cn.stadiumUse@1', { key: 'fixture:use', effect, ...extra }, 'use')];
});
const inPlay = (s) => { const id = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = id; };
const canUseStadium = (g) => g.view(g.snapshot().current).legalActions.some((a) => a.type === 'useStadium');
const coin = { kind: 'flip', heads: 8, tails: 3 };

test('schema: a coin draw count only where the hands go back by themselves', () => {
  const valid = handlers.get('cn.handDeckDraw@1').validateParameters;
  assert(valid({ side: 'own', ownDraw: coin, opponentDraw: 0 }));
  assert(!valid({ side: 'own', ownDraw: { kind: 'flip', heads: 8 }, opponentDraw: 0 }));
  assert(handlers.get('cn.handBottomDraw@1').validateParameters({ side: 'both', ownDraw: coin, opponentDraw: coin }));
  assert(!validateOptionalEffect({ effect: leaf('cn.handDeckDraw@1', { side: 'own', ownDraw: coin, opponentDraw: 0 }) }));
});

test('「然后，抛掷1次硬币，如果为正面…8张，如果为反面…3张」: flipped after the hand went back', async () => {
  const f = await supporter(binding('cn.handDeckDraw@1', { side: 'own', ownDraw: coin, opponentDraw: 0 }, 'shuffle'));
  for (const seed of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]]) {
    let card;
    const g = board({ ...f, seed }, (s) => { card = hand(s, 0, 'research'); });
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    const s = g.snapshot(), [flip] = coins(s);
    assert.equal(flip.data.player, 0);
    assert.equal(s.players[0].hand.length, flip.data.result === 'heads' ? 8 : 3);
    const shuffled = s.events.findIndex((e) => e.ruleId === 'effects.hand-deck'), flipped = s.events.indexOf(flip);
    assert(shuffled >= 0 && shuffled < flipped);
    restore(g, f);
  }
});

test('「双方玩家各抛掷1次硬币」: each player flips and draws by their own coin', async () => {
  const both = { side: 'both', ownDraw: { kind: 'flip', heads: 6, tails: 3 }, opponentDraw: { kind: 'flip', heads: 6, tails: 3 } };
  for (const id of ['cn.handDeckDraw@1', 'cn.handBottomDraw@1']) {
    const f = await supporter(binding(id, both, 'both'));
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'research'); });
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    const s = g.snapshot(), flips = coins(s);
    assert.deepEqual(flips.map((e) => e.data.player), [0, 1]);
    for (const [player, flip] of flips.entries()) assert.equal(s.players[player].hand.length, flip.data.result === 'heads' ? 6 : 3);
    restore(g, f);
  }
});

test('a Stadium: 「可将自己的手牌全部放回牌库并重洗牌库。在这种情况下，…抽取5张。如果使用了这个效果的话，自己的回合结束」', async () => {
  const f = await stadium(leaf('cn.handDeckDraw@1', { side: 'own', ownDraw: 5, opponentDraw: 0 }), { endsTurn: true });
  const g = board(f, inPlay);
  assert(canUseStadium(g));
  command(g, { type: 'useStadium' }); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[0].hand.length, 5); assert.equal(s.current, 1, 'The turn ended.');
  restore(g, f);
  // An empty hand still lets the deck be shuffled and drawn from.
  const empty = board(f, (s) => { inPlay(s); s.players[0].deck.push(...s.players[0].hand.splice(0)); });
  assert(canUseStadium(empty));
});

test('a Stadium: 「可抛掷1次硬币。如果为正面，则选择自己牌库中的1张宝可梦…加入手牌」', async () => {
  const search = leaf('cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 },
    reveal: true, lookTop: null, shuffleAfter: true });
  const f = await stadium(leaf('cn.coin@1', { outcome: 'heads', effect: search }));
  const results = new Set();
  for (const seed of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]]) {
    const g = board({ ...f, seed }, inPlay), before = g.snapshot().players[0].hand.length;
    command(g, { type: 'useStadium' }); settle(g, (q) => q.options.slice(0, q.maximum));
    const s = g.snapshot(), [flip] = coins(s);
    results.add(flip.data.result);
    assert.equal(s.players[0].hand.length, before + (flip.data.result === 'heads' ? 1 : 0));
    assert(!canUseStadium(g), 'Once this turn, whatever the coin showed.');
  }
  assert.equal(results.size, 2);
});

test('a Stadium: 「在这个回合，从手牌使出了支援者的玩家，可…」', async () => {
  const played = { kind: 'historyFact', fact: 'supporterPlayed' };
  const f = await stadium(leaf('cn.when@1', { condition: played, effect: leaf('cn.draw@1', { count: 1 }) }));
  let card;
  const g = board(f, (s) => { inPlay(s); card = hand(s, 0, 'research'); });
  assert(!canUseStadium(g));
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  assert(canUseStadium(g));
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'useStadium' }); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, before + 1);
  restore(g, f);
});

test('「对手若希望，可从牌库上方抽取1张卡牌。在这种情况下，自己额外从牌库上方抽取1张卡牌」: the opponent decides', async () => {
  const valid = handlers.get('cn.opponentMayDraw@1').validateParameters;
  assert(valid({ count: 1 })); assert(valid({ count: 1, ownDraw: 1 })); assert(!valid({ count: 0 }));
  const f = await supporter(binding('cn.draw@1', { count: 3 }, 'draw'), binding('cn.opponentMayDraw@1', { count: 1, ownDraw: 1 }, 'offer'));
  for (const accept of [true, false]) {
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'research'); });
    const [mine, theirs] = g.snapshot().players.map((p) => p.hand.length);
    command(g, { type: 'playTrainer', cardId: card });
    const q = g.snapshot().pending;
    assert.equal(q.kind, 'optional-effect'); assert.equal(q.player, 1);
    restore(g, f); answer(g, [accept ? 'perform' : 'skip']); settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].hand.length, theirs + (accept ? 1 : 0));
    assert.equal(s.players[0].hand.length, mine - 1 + 3 + (accept ? 1 : 0));
    assert(s.events.some((e) => e.ruleId === 'selection.optional' && e.data.chooser === 1 && e.data.performed === accept));
  }
  // The opponent's empty deck: nothing to offer, and alone it cannot be played.
  const alone = await supporter(binding('cn.opponentMayDraw@1', { count: 1 }, 'offer'));
  let card;
  const g = board(alone, (s) => { card = hand(s, 0, 'research'); s.players[1].discard.push(...s.players[1].deck.splice(0)); });
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card));
});

test('「抛掷与自己场上的「X」数量相同次数的硬币」: as many flips as the count when they start', async () => {
  const count = { kind: 'pokemonCount', side: 'own', zone: 'field', selector: { kind: 'pokemon', nameKeys: ['other'] } };
  const flips = { kind: 'count', value: count };
  const valid = handlers.get('cn.coins@1').validateParameters;
  const p = { flips, face: 'heads', apply: { kind: 'scale' }, effect: leaf('cn.draw@1', { count: 1 }) };
  assert(valid(p)); assert(!valid({ ...p, flips: { kind: 'count' } }));
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.coins@1', p, 'coins')]; });
  for (const others of [0, 2]) {
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'potion'); for (let i = 0; i < others; i++) bench(s, 0, 'other'); });
    const playable = g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
    assert.equal(playable, others > 0, 'No such Pokémon: no flip could change anything.');
    if (!others) continue;
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    const [flip] = coins(g.snapshot());
    assert.equal(flip.data.receipt.flips, 2);
    restore(g, f);
  }
});
