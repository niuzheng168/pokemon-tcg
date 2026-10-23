// Synthetic definitions only. 「这张卡牌，可以从2个效果中选择1个使用。◆… ◆…」 and 「选择1种特殊状态，使对手的战斗宝可梦陷入该特殊状态」
// (effects.choose-one); a Stadium's 「可将自己的1张手牌放于弃牌区。在这种情况下，…。如果使用了这个效果，则自己的回合结束」 (stadium.use,
// effects.end-turn); 「选择放于双方场上宝可梦身上的1张「宝可梦道具」，放于弃牌区」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { advanceEffectExecution } from '../../public/rules/effect-execution.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers();
const draw = { handlerId: 'cn.draw@1', parameters: { count: 2 } };
const swap = { handlerId: 'cn.switch@1', parameters: { side: 'own', chooser: 'self', affected: 'active' } };
const condition = (c) => ({ handlerId: 'cn.condition@1', parameters: { side: 'opponent', condition: c } });
const discardOne = { handlerId: 'cn.cards@1', parameters: { from: 'hand', to: 'discard', selector: { kind: 'any' },
  quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: null, shuffleAfter: false } };
const then = { handlerId: 'cn.then@1', parameters: { first: discardOne, next: draw } };

test('「从2个效果中选择1个使用」: schema', () => {
  const valid = (p) => handlers.get('cn.chooseOne@1').validateParameters(clone(p));
  assert(valid({ options: [then, swap] }));
  assert(valid({ options: ['asleep', 'paralyzed', 'confused', 'poisoned', 'burned'].map(condition) }));
  const juniper = [{ handlerId: 'cn.discardHand@1', parameters: {} }, { handlerId: 'cn.draw@1', parameters: { count: 5 } }];
  const shuffleDraw = (side) => ({ handlerId: 'cn.handDeckDraw@1', parameters: { side, ownDraw: side === 'own' ? 4 : 0, opponentDraw: side === 'own' ? 0 : 4 } });
  assert(valid({ options: [juniper, swap] }));
  assert(valid({ options: [shuffleDraw('own'), shuffleDraw('opponent')] }));
  assert(!valid({ options: [{ handlerId: 'cn.handDeckDraw@1', parameters: { side: 'own', ownDraw: { kind: 'remainingPrizes' }, opponentDraw: 0 } }, swap] }),
    'A Prize-dependent count is not a static option.');
  assert(!valid({ options: [[draw], swap] }), 'A list option has at least two entries.');
  for (const bad of [{ options: [draw] }, { options: [draw, draw] }, { options: [draw, { handlerId: 'cn.chooseOne@1', parameters: { options: [draw, swap] } }] },
    { options: [draw, { handlerId: 'cn.draw@1', parameters: { count: 0 } }] }]) assert(!valid(bad), JSON.stringify(bad));
  const stadium = (p) => handlers.get('cn.stadiumUse@1').validateParameters(clone(p));
  assert(stadium({ key: 'fixture:use', effect: then, endsTurn: true }));
  assert(stadium({ key: 'fixture:use', effect: draw }));
  assert(!stadium({ key: 'fixture:use', effect: draw, endsTurn: false }));
  const tools = (p) => handlers.get('cn.discardTools@1').validateParameters(clone(p));
  assert(tools({ side: 'both', target: 'any', quantity: { kind: 'upTo', count: 2 } }));
  assert(!tools({ side: 'both', target: 'self', quantity: { kind: 'upTo', count: 2 } }));
});

test('the user picks one option that could change something; the choice replays', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.chooseOne@1', { options: [then, swap] }, 'choose')];
  });
  let card;
  let g = board(f, (s) => { card = hand(s, 0, 'potion'); hand(s, 0, 'research'); bench(s, 0, 'other'); });
  command(g, { type: 'playTrainer', cardId: card });
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'choose-effect'); assert.deepEqual(q.options, ['0', '1']);
  assert.deepEqual(OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog }).view(0), g.view(0));
  answer(g, ['1']); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].active.stack.map((id) => s.cards[id].definitionId)[0], 'other', 'Switched.');
  assert(s.events.some((e) => e.ruleId === 'effects.choose-one' && e.data.option === 1));
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
  g = board(f, (s) => { card = hand(s, 0, 'potion'); hand(s, 0, 'research'); });
  command(g, { type: 'playTrainer', cardId: card });
  q = g.snapshot().pending;
  assert.deepEqual(q.options, ['0'], 'No Bench: the switch cannot be chosen.');
  assert.throws(() => answer(g, ['1']));
  const before = g.snapshot().players[0].hand.length;
  answer(g, ['0']); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, before - 1 + 2);
  g = board(f, (s) => { card = hand(s, 0, 'potion'); const p = s.players[0]; p.discard.push(...p.hand.filter((id) => id !== card)); p.hand = [card]; });
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card), 'Neither option could change anything.');
  const step = { action: { op: 'choose', options: [{ entries: [{ handlerId: 'cn.draw@1', parameters: { count: 1 } }], effect: { op: 'draw', count: 1 } },
    { entries: [{ handlerId: 'cn.draw@1', parameters: { count: 2 } }], effect: { op: 'draw', count: 2 } }] }, frames: [] };
  const advance = (data) => advanceEffectExecution({ id: 'program1', index: 0, step },
    { ruleId: 'effects.execution', visibility: 'private', data: { kind: 'advance', id: 'program1', index: 0, ...data } });
  assert.deepEqual(advance({ mode: 'chosen', performed: true, option: 1 }).step.action, { op: 'draw', count: 2 });
  assert.equal(advance({ mode: 'complete', performed: false }).step, null);
  assert.throws(() => advance({ mode: 'chosen', performed: true, option: 2 }));
  assert.throws(() => advance({ mode: 'complete', performed: true }));
  assert.throws(() => advanceEffectExecution({ id: 'program1', index: 0, step: { action: { op: 'draw', count: 1 }, frames: [] } },
    { ruleId: 'effects.execution', visibility: 'private', data: { kind: 'advance', id: 'program1', index: 0, mode: 'chosen', performed: true, option: 0 } }));
});

test('◆ options of several entries and whole-hand pairs; 「选择自己或对手」', async () => {
  const juniper = [{ handlerId: 'cn.discardHand@1', parameters: {} }, { handlerId: 'cn.draw@1', parameters: { count: 5 } }];
  const shuffleDraw = (side) => ({ handlerId: 'cn.handDeckDraw@1', parameters: { side, ownDraw: side === 'own' ? 4 : 0, opponentDraw: side === 'own' ? 0 : 4 } });
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.chooseOne@1', { options: [juniper, swap] }, 'choose')];
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [binding('cn.chooseOne@1', { options: [shuffleDraw('own'), shuffleDraw('opponent')] }, 'who')];
  });
  let card;
  let g = board(f, (s) => { card = hand(s, 0, 'potion'); hand(s, 0, 'tool'); });
  command(g, { type: 'playTrainer', cardId: card });
  assert.deepEqual(g.snapshot().pending.options, ['0']);
  answer(g, ['0']); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].hand.length, 5); assert(s.players[0].discard.some((id) => s.cards[id].definitionId === 'tool'));
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
  g = board(f, (s) => { card = hand(s, 0, 'research'); });
  command(g, { type: 'playTrainer', cardId: card });
  assert.deepEqual(g.snapshot().pending.options, ['0', '1']);
  answer(g, ['1']); settle(g);
  s = g.snapshot();
  assert.equal(s.players[1].hand.length, 4, 'The chosen player shuffles in their hand and draws 4.');
});

test('「抛掷1次硬币如果为正面，则选择1种特殊状态」 in an attack', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:pick', name: '测试选择', cost: [],
      printedDamage: null, effects: [binding('cn.chooseOne@1', { options: ['asleep', 'confused', 'poisoned'].map(condition) }, 'pick')], sourceOfTruth: EVIDENCE });
  });
  const g = board(f);
  command(g, { type: 'attack', attackId: 'base:pick' });
  assert.deepEqual(g.snapshot().pending.options, ['0', '1', '2']);
  answer(g, ['2']); settle(g);
  assert.notEqual(g.snapshot().players[1].active.conditions.poison, null);
});

test('a Stadium use with 「在这种情况下」 that ends the turn; Tools on both sides', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.stadiumUse@1', { key: 'fixture:use', effect: then, endsTurn: true }, 'use')];
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.discardTools@1',
      { side: 'both', target: 'any', quantity: { kind: 'upTo', count: 2 } }, 'tools')];
  });
  let g = board(f, (s) => {
    const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id;
    hand(s, 0, 'research');
  });
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'useStadium' }); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].hand.length, before - 1 + 2);
  assert.equal(s.current, 1, "Its user's turn ended.");
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
  let card;
  g = board(f, (s) => {
    card = hand(s, 0, 'potion');
    s.players[0].active.tools.push(hand(s, 0, 'tool')); s.players[0].hand.pop();
    s.players[1].active.tools.push(hand(s, 1, 'hp-tool')); s.players[1].hand.pop();
  });
  command(g, { type: 'playTrainer', cardId: card });
  assert.equal(g.snapshot().pending.options.length, 2, "Either player's Tool.");
  settle(g, (q) => q.options);
  s = g.snapshot();
  assert.equal(s.players[0].active.tools.length + s.players[1].active.tools.length, 0);
  assert(s.players[1].discard.some((id) => s.cards[id].definitionId === 'hp-tool'), "Each Tool goes to its owner's discard pile.");
});
