// Real released cards whose continuous effect sits next to 零之大空洞's Bench limit. The Bench limit is read from the
// continuous effects; a continuous effect that was worked out with a full handler context read the Bench limit back,
// and the engine recursed until the stack overflowed (self-play: 伊布ex in play, and 招式学习器「退化」 devolving
// 火伊布ex back to 伊布ex). Each board here is one that used to overflow; the engine must answer it as printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewed, board, settle, answer, command, fixtureClock } from './helpers.mjs';

const FIRE = 'zh-Hans:CSVE1C:FIR';
const HOLDER = [
  ['zh-Hans:CSV9.5C:140/208', 2], // 伊布ex: 「虹色因子」 cn.evolutionPermission@1 (a 太晶 Pokémon)
  ['zh-Hans:CSV9.5C:023/208', 2], // 火伊布ex (evolves from 伊布)
  ['zh-Hans:CSV9C:175/208', 2], // 太乐巴戈斯ex (a 太晶 Pokémon)
  ['zh-Hans:CSV9.5C:141/208', 2], // 咕咕: 「不眠」 cn.conditionImmunity@1
  ['zh-Hans:CS4aC:004/132', 2], // 凯罗斯: 「钳夹教练」 cn.attackDamageOptions@1
  ['zh-Hans:CSM1aC:022/151', 2], // 比克提尼: 「胜利之星」 cn.coinReflip@1
  ['zh-Hans:CS4bC:102/132', 2], // 黏美龙: 「粘滑屋」 cn.useCoin@1
  ['zh-Hans:CS2aC:038/115', 2], // 脱壳忍者: 「脱壳束缚」 cn.enterOnlyBy@1
  ['zh-Hans:CSM1bC:058/151', 2], // 雷电兽: 「伏特启动」 cn.setupPlacement@1
  ['zh-Hans:CSV9C:207/208', 2], // 零之大空洞: cn.benchLimit@1
  [FIRE, 40],
];
const DEVOLVER = [
  ['zh-Hans:CSV7C:057/204', 4], // 雪童子
  ['zh-Hans:CSV7C:059/204', 2], // 雪妖女
  ['zh-Hans:CSV5C:120/129', 2], // 招式学习器 退化
  [FIRE, 52],
];
const list = (cards) => cards.flatMap(([printingId, n]) => Array(n).fill(printingId));

// These decks are not the fixture decks of helpers.mjs, so the board keys are the cards' printed names.
async function areaZero(seed = [5, 3, 8, 13]) {
  const decks = [list(HOLDER), list(DEVOLVER)], ctx = await reviewed(seed, decks);
  const id = Object.fromEntries(decks.flat().map((p) => ctx.catalog.definitionFor(p)).map((d) => [d.name, d.definitionId]));
  return { ...ctx, id };
}
const stadium = (s, h, owner = 0) => { const [card] = h.hand(owner, '零之大空洞'); s.players[owner].hand.pop(); s.stadium = card; };
const continuousHandlers = (catalog, definitionId) => catalog.definition(definitionId).mechanics.abilities
  .filter((a) => a.mode === 'continuous').flatMap((a) => a.effects.map((b) => b.handlerId));

test('伊布ex「虹色因子」 under 零之大空洞: an eight-Pokémon Bench and evolving into 火伊布ex are both read', async () => {
  const ctx = await areaZero();
  let flareon;
  const g = board(ctx, ['伊布ex', '雪童子'], (s, h) => { stadium(s, h); [flareon] = h.hand(0, '火伊布ex'); });
  const eevee = g.snapshot().players[0].active;
  assert.deepEqual(continuousHandlers(ctx.catalog, ctx.id['伊布ex']), ['cn.evolutionPermission@1']);
  const view = g.view(0);
  assert.deepEqual(view.players.map((p) => p.benchLimit), [8, 5], 'Only the player with a 太晶 Pokémon in play gets eight.');
  const evolve = { type: 'evolve', cardId: flareon, pokemonId: eevee.id };
  assert(view.legalActions.some((a) => JSON.stringify(a) === JSON.stringify(evolve)), '火伊布ex evolves from 伊布ex by 「虹色因子」.');
  command(g, evolve); settle(g);
  assert.deepEqual(g.snapshot().players[0].active.stack, [...eevee.stack, flareon]);
  assert.deepEqual(g.view(0).players.map((p) => p.benchLimit), [8, 5]);
});

test('招式学习器「退化」 devolving 火伊布ex to 伊布ex under 零之大空洞: the 火伊布ex goes to the hand and 伊布ex may evolve again', async () => {
  const ctx = await areaZero();
  let eevee, flareon;
  const g = board(ctx, ['伊布ex', '雪童子'], (s, h) => {
    fixtureClock(s, [0, 1, 0, 1]);
    stadium(s, h);
    eevee = s.players[0].active.stack[0];
    flareon = h.evolve(0, s.players[0].active, '火伊布ex').stack[1];
    h.tool(1, s.players[1].active, '招式学习器 退化');
    h.attach(1, s.players[1].active, '基本火能量');
  });
  const devolution = g.view(1).legalActions.find((a) => a.type === 'attack' && a.attackId === `${ctx.id['招式学习器 退化']}:g`);
  assert(devolution, 'The Tool gives its holder 「退化」.');
  command(g, devolution);
  assert.equal(g.snapshot().pending?.kind, 'devolution-count');
  answer(g, ['1']); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players[0].active.stack, [eevee], 'One Stage removed: 伊布ex stays in the Active Spot.');
  assert(s.players[0].hand.includes(flareon), 'The removed 火伊布ex goes to its owner\'s hand.');
  assert.equal(s.current, 0);
  const view = g.view(0);
  assert.deepEqual(view.players.map((p) => p.benchLimit), [8, 5]);
  assert(view.legalActions.some((a) => a.type === 'evolve' && a.cardId === flareon && a.pokemonId === s.players[0].active.id),
    '「虹色因子」 is read again once 伊布ex is the top card.');
});

// The other released continuous producers that return their reviewed parameters as printed, each in play next to
// 零之大空洞 with a 太晶 Pokémon.
for (const [name, handlerId] of [['咕咕', 'cn.conditionImmunity@1'], ['凯罗斯', 'cn.attackDamageOptions@1'], ['比克提尼', 'cn.coinReflip@1'],
  ['黏美龙', 'cn.useCoin@1'], ['脱壳忍者', 'cn.enterOnlyBy@1'], ['雷电兽', 'cn.setupPlacement@1']]) {
  test(`${name} (${handlerId}) in play under 零之大空洞: the Bench limit and the player's choices are answered`, async () => {
    const ctx = await areaZero();
    const g = board(ctx, ['太乐巴戈斯ex', '雪童子'], (s, h) => { stadium(s, h); h.bench(0, name); });
    assert.deepEqual(continuousHandlers(ctx.catalog, ctx.id[name]), [handlerId]);
    const view = g.view(0);
    assert.deepEqual(view.players.map((p) => p.benchLimit), [8, 5]);
    assert(view.legalActions.some((a) => a.type === 'endTurn'));
    command(g, { type: 'endTurn' }); settle(g);
    assert.deepEqual(g.view(1).players.map((p) => p.benchLimit), [8, 5]);
  });
}
