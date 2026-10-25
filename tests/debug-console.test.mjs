// The administrators' 调试台 (public/debug-console.js): commands that rewrite a game in progress. Each result is a state
// the kernel accepts; what it refuses (a sixth copy, a status on the Bench, an edit during a choice) comes back as a
// message. A recorded edit replays (replay.js), and a /revert is a rewind past it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OfficialGame } from '../public/rules/engine.js';
import { randomIndex } from '../public/rules/random.js';
import { runCommand, parse, DebugError, COMMANDS } from '../public/debug-console.js';
import { stateHash, effectiveMoves, replayMatch } from '../public/replay.js';
import { reviewed, board, command, BOLT, DRAGAPULT, STANDARD_FORMAT, release } from './cn-cards/helpers.mjs';

const meta = JSON.parse(await readFile(new URL('../public/data/cn/V20261019/decks.json', import.meta.url), 'utf8'));
const ctx = await reviewed([1, 2, 3, 4], [BOLT, DRAGAPULT], STANDARD_FORMAT);
const { catalog } = ctx;
const start = () => board(ctx, ['raging-bolt-ex', 'dreepy'], (s, h) => { h.bench(0, 'mew-ex'); h.bench(1, 'budew'); h.hand(0, 'nest-ball'); }).snapshot();
// Runs commands one after another; each must give a state the kernel restores.
function run(snapshot, ...lines) {
  let s = snapshot, out = [];
  for (const line of lines) {
    const r = runCommand(line, { snapshot: s, catalog });
    if (r.state) { assert.equal(r.state.revision, s.revision + 1, `${line} moves the revision on`); s = r.state; OfficialGame.restore(structuredClone(s), { catalog }); }
    out = r.lines;
  }
  return { s, out };
}
const name = (s, id) => catalog.definition(s.cards[id].definitionId).name;
const refuses = (s, line, pattern) => assert.throws(() => runCommand(line, { snapshot: s, catalog }), (e) => e instanceof DebugError && pattern.test(e.message), line);

test('parse: quoted names, key=value, /help lists every command', () => {
  assert.deepEqual(parse('/Battle-Card id="厄诡椪 碧草面具ex" hp=100 opp'), { name: 'battle-card', args: ['opp'], opts: { id: '厄诡椪 碧草面具ex', hp: '100' } });
  const help = runCommand('/help', { snapshot: start(), catalog }).lines.join('\n');
  for (const c of COMMANDS) assert(help.includes(`/${c.name}`), c.name);
  assert.match(runCommand('/help nextcard', { snapshot: start(), catalog }).lines.join(), /下一张抽到/);
});

test('/nextcard: from the deck, from the Prize cards (swapped), and by turning the top card into it; the next draw is that card', () => {
  const s0 = start();
  let { s } = run(s0, '/nextcard 奥琳博士的气魄');
  assert.equal(name(s, s.players[0].deck.at(-1)), '奥琳博士的气魄');
  // Ending the turn and the opponent's turn: the kernel's own draw at the start of the next turn takes it.
  const g = OfficialGame.restore(structuredClone(s), { catalog }), top = s.players[0].deck.at(-1);
  command(g, { type: 'endTurn' }, 0);
  command(g, { type: 'endTurn' }, 1);
  assert(g.snapshot().players[0].hand.includes(top), 'drawn at the start of the turn');

  const prize = s0.players[0].prizes[2];
  ({ s } = run(s0, `/nextcard ${prize}`));
  assert.equal(s.players[0].deck.at(-1), prize);
  assert.equal(s.players[0].prizes.length, 6);
  assert.equal(s.players[0].prizes[2], s0.players[0].deck.at(-1), 'the old top card took the Prize place');

  // 小茂's deck holds no 老大的指令 copy outside play? Then the top card becomes one (the deck stays legal).
  ({ s } = run(s0, '/nextcard 奇树 opp'));
  assert.equal(name(s, s.players[1].deck.at(-1)), '奇树');
  refuses(s0, '/nextcard 不存在的卡', /卡池里没有/);
});

test('zones: /draw, /shuffle, /move, /transform keep every card and a legal deck', () => {
  const s0 = start();
  let { s, out } = run(s0, '/draw 2', '/draw 1 opp');
  assert.equal(s.players[0].hand.length, s0.players[0].hand.length + 2);
  assert.equal(s.players[1].hand.length, s0.players[1].hand.length + 1);
  ({ s } = run(s0, '/shuffle 3'));
  assert.notDeepEqual(s.players[0].deck, s0.players[0].deck);
  assert.notDeepEqual(s.players[1].deck, s0.players[1].deck);
  assert.deepEqual([...s.players[0].deck].sort(), [...s0.players[0].deck].sort());
  ({ s, out } = run(s0, '/move 老大的指令 hand', '/move 巢穴球 bottom', '/move 基本雷能量@deck discard'));
  assert(s.players[0].hand.some((id) => name(s, id) === '老大的指令'));
  assert.equal(name(s, s.players[0].deck[0]), '巢穴球');
  assert.match(out.join(), /弃牌区/);
  const card = s0.players[0].deck[0];
  ({ s } = run(s0, `/transform ${card} 老大的指令`));
  assert.equal(name(s, card), '老大的指令');
  // The list already has four 奥琳博士的气魄: a fifth breaks the deck rule, which the kernel refuses.
  refuses(s0, `/transform ${card} 奥琳博士的气魄`, /规则内核不接受/);
  refuses(s0, '/move 能量 hand', /可以指/);
});

test('Pokémon: HP, damage, Special Conditions, Energy, switching, Bench, evolution and removal', () => {
  const s0 = start();
  let { s } = run(s0, '/battle-card hp=100', '/mon active status=paralyzed poison=2 burn=on', '/mon opp.active damage=30');
  const view = OfficialGame.restore(structuredClone(s), { catalog }).view(0);
  assert.equal(view.players[0].active.effective.currentHp, 100);
  assert.deepEqual(s.players[0].active.conditions, { rotation: 'paralyzed', poison: 2, burned: true, paralysisRecoverTurn: s.players[0].turns + 1 });
  assert.equal(s.players[1].active.counters, 3);
  refuses(s0, '/mon bench1 status=asleep', /只有战斗宝可梦/);
  refuses(s0, '/mon active hp=999', /HP 需要是/);

  ({ s } = run(s0, '/attach 基本雷能量 active', '/switch bench1', '/bench 吉雉鸡ex', '/mon bench1 ready heal'));
  assert.equal(name(s, s.players[0].active.stack[0]), '梦幻ex');
  assert.equal(name(s, s.players[0].bench[0].energy[0]), '基本雷能量', 'the Energy stays with its Pokémon');
  assert.deepEqual(s.players[0].bench[0].conditions, { rotation: null, poison: null, burned: false, paralysisRecoverTurn: null });
  assert.equal(name(s, s.players[0].bench[1].stack[0]), '吉雉鸡ex');

  ({ s } = run(s0, '/evolve opp.bench1 多龙奇'));
  assert.equal(name(s, s.players[1].bench[0].stack.at(-1)), '多龙奇');
  ({ s } = run(s, '/devolve opp.bench1', '/remove opp.bench1'));
  assert.equal(s.players[1].bench.length, 0);
  ({ s } = run(s0, '/battle-card id=铁斑叶ex'));
  assert.equal(name(s, s.players[0].active.stack.at(-1)), '铁斑叶ex');
});

test('turn: flags, this turn’s limits, Stadium, Prize count, coin flips, effects', () => {
  const s0 = start();
  let { s } = run(s0, '/flags supporter=1 energy=1');
  assert.deepEqual(s.players[0].flags, { energy: true, retreat: false, supporter: true, stadium: false });
  ({ s } = run(s, '/reset-turn'));
  assert.deepEqual(s.players[0].flags, { energy: false, retreat: false, supporter: false, stadium: false });
  ({ s } = run(s0, '/stadium 零之大空洞'));
  assert.equal(name(s, s.stadium), '零之大空洞');
  ({ s } = run(s, '/stadium none'));
  assert.equal(s.stadium, null);
  ({ s } = run(s0, '/prizes opp 2', '/prizes me 3'));
  assert.deepEqual(s.players.map((p) => p.prizes.length), [3, 2]);
  // The kernel flips a coin as randomIndex(rng, 2) === 0 for heads.
  ({ s } = run(s0, '/coin tails heads tails'));
  const rng = [...s.rng];
  assert.deepEqual([0, 1, 2].map(() => randomIndex(rng, 2)), [1, 0, 1]);
  refuses(s0, '/coin maybe', /不是 heads 或 tails/);
  assert.match(run(s0, '/effects').out.join(), /没有持续效果/);
});

test('an edit waits for an open choice to finish, and never touches a finished game', () => {
  const g = OfficialGame.restore(structuredClone(start()), { catalog });
  const nest = g.snapshot().players[0].hand.find((id) => name(g.snapshot(), id) === '巢穴球');
  command(g, { type: 'playTrainer', cardId: nest }, 0);
  assert(g.snapshot().pending);
  refuses(g.snapshot(), '/draw', /选择未完成/);
  assert.match(runCommand('/show', { snapshot: g.snapshot(), catalog }).lines.join(), /手牌/, 'reading still works');
});

test('a recorded edit replays to the same state; a /revert is a rewind past it', async () => {
  const deck = (d) => d.cards.flatMap(([id, n]) => Array(n).fill(id));
  const [a, b] = ['raging-bolt-679141', 'dragapult-676815'].map((id) => meta.decks.find((d) => d.id === id));
  const setup = { releaseId: meta.releaseId, seed: [4, 4, 4, 4], format: a.format, matchMode: 'normal',
    decks: [a, b].map((d) => ({ id: d.id, name: d.name, cards: deck(d) })), approval: ctx.approval };
  const { game } = await replayMatch({ release, setup, steps: [] });
  const steps = [], ai = (await import('../public/cn/ai.js')).createAI(catalog);
  let live = game;
  const step = (x) => steps.push({ seq: steps.length + 1, ...x });
  const move = () => {
    const p = [0, 1].find((x) => { const v = live.view(x); return v.pending || v.legalActions.length; });
    const v = live.view(p), action = ai(v, p);
    live.dispatch({ player: p, expectedRevision: v.revision, action });
    step({ type: 'action', player: p, revision: v.revision, action, hash: stateHash(live.snapshot()) });
  };
  const edit = (line) => {
    const r = runCommand(line, { snapshot: live.snapshot(), catalog });
    step({ type: 'edit', revision: r.state.revision - 1, command: line, lines: r.lines, state: r.state, hash: stateHash(r.state) });
    live = OfficialGame.restore(structuredClone(r.state), { catalog });
  };
  while (!(live.snapshot().phase === 'main' && !live.snapshot().pending && live.snapshot().current === 0)) move();
  edit('/nextcard 老大的指令');
  edit('/mon opp.active damage=20');
  const before = live.snapshot();
  edit('/shuffle 3');
  step({ type: 'rewind', revision: before.revision, reason: 'revert' }); // /revert of the shuffle
  live = OfficialGame.restore(structuredClone(before), { catalog });
  for (let i = 0; i < 12; i++) move();
  const replay = await replayMatch({ release, setup, steps });
  assert.equal(replay.failed, null);
  assert.equal(replay.diverged, null);
  assert.deepEqual(replay.game.snapshot(), live.snapshot());
  assert.deepEqual(effectiveMoves(steps).moves.filter((m) => m.type === 'edit').map((m) => m.command), ['/nextcard 老大的指令', '/mon opp.active damage=20']);
});
