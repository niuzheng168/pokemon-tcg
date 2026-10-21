// Match records (public/replay.js, the table's recorder hooks in public/match.js) and the hover reasons that read this
// turn's events: a recorded game replays to the very same state, takebacks included, and a replay that no longer
// matches its record says where.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createReviewedGame, OfficialGame } from '../public/rules/engine.js';
import { TRUSTED_RELEASES } from '../public/cn/trusted-releases.js';
import { createAI } from '../public/cn/ai.js';
import { Match, ME, OPP } from '../public/match.js';
import { stateHash, effectiveMoves, mergeSteps, replayMatch } from '../public/replay.js';
import { reviewed, board, settle, play, attack, playable, command, fixtureClock, BOLT, DRAGAPULT, STANDARD_FORMAT } from './cn-cards/helpers.mjs';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const json = await read('public/data/cn/V20261019/release.json');
const meta = JSON.parse(await read('public/data/cn/V20261019/decks.json'));
const deckList = (d) => d.cards.flatMap(([id, n]) => Array(n).fill(id));
const preset = (id) => meta.decks.find((d) => d.id === id);
const actor = (game) => [ME, OPP].find((p) => { const v = game.view(p); return v.pending || v.legalActions.length; });

test('effectiveMoves: a rewind takes back the moves from its revision on; a lost rewind is inferred, a gap reported', () => {
  const a = (seq, revision) => ({ seq, type: 'action', player: 0, revision, action: { type: 'endTurn' } });
  const line = (steps) => effectiveMoves(steps).moves.map((m) => m.seq);
  assert.deepEqual(line([a(1, 0), a(2, 1), a(3, 2)]), [1, 2, 3]);
  assert.deepEqual(line([a(1, 0), a(2, 1), { seq: 3, type: 'rewind', revision: 1 }, a(4, 1)]), [1, 4]);
  assert.deepEqual(line([a(1, 0), { seq: 2, type: 'rejected', revision: 1 }, { seq: 3, type: 'error' }, a(4, 1)]), [1, 4]);
  const lost = effectiveMoves([a(1, 0), a(2, 1), a(3, 1)]);
  assert.deepEqual(lost.moves.map((m) => m.seq), [1, 3]);
  assert.equal(lost.problems.length, 1);
  const gap = effectiveMoves([a(1, 0), a(2, 2), a(3, 3)]);
  assert.deepEqual(gap.moves.map((m) => m.seq), [1]);
  assert.match(gap.problems[0].text, /reaches only 1/);
});

// A saved game holds the steps it has not sent yet; a re-issued release (new catalog id) keeps the state hashes.
test('mergeSteps adds the unsent steps once; stateHash ignores the catalog id only', () => {
  const stored = [{ seq: 1, key: 'a', type: 'action', revision: 0 }, { seq: 2, key: 'b', type: 'action', revision: 1 }];
  const pending = [{ key: 'b', step: { type: 'action', revision: 1 } }, { key: 'c', step: { type: 'rewind', revision: 1 } }];
  assert.deepEqual(mergeSteps(stored, pending).map((s) => [s.seq, s.key, s.type]), [[1, 'a', 'action'], [2, 'b', 'action'], [3, 'c', 'rewind']]);
  const state = { catalogId: 'one', revision: 3, players: [] };
  assert.equal(stateHash({ ...state, catalogId: 'two' }), stateHash(state));
  assert.notEqual(stateHash({ ...state, revision: 4 }), stateHash(state));
});

// The table's own driver records every dispatch (onDispatch); the record replays to the same final state.
test('a game recorded through the table driver replays to the same state, move by move', { timeout: 120_000 }, async () => {
  const mine = preset('raging-bolt-679141'), theirs = preset('dragapult-676815');
  const setup = { releaseId: meta.releaseId, seed: [11, 22, 33, 44], format: mine.format, matchMode: 'normal',
    decks: [mine, theirs].map((d) => ({ id: d.id, name: d.name, cards: deckList(d) })) };
  const { game, catalog } = await createReviewedGame({ json, trustedReleases: TRUSTED_RELEASES, decks: setup.decks.map((d) => d.cards),
    seed: setup.seed, format: setup.format, matchMode: 'normal' });
  const ai = createAI(catalog), steps = [];
  const human = {
    async chooseAction(m, p, actions) {
      const want = JSON.stringify(ai(game.view(ME), ME));
      return actions.find((a) => JSON.stringify(a.cmd) === want);
    },
    async choose() {
      const a = ai(game.view(ME), ME);
      return a.type === 'allocateCounters' ? { allocations: a.allocations } : a.selected;
    },
  };
  const hooks = {
    onDispatch: ({ player, revision, action }) => steps.push({ seq: steps.length + 1, type: 'action', player, revision, action,
      hash: stateHash(game.snapshot()) }),
    onError: (e) => { throw e; },
  };
  const m = new Match({ game, catalog, presentation: meta.cards, decks: [mine.id, theirs.id],
    controllers: [human, { decide: (view, p) => ai(view, p) }], hooks });
  await m.run();
  assert.equal(m.phase, 'over');
  assert.equal(steps.length, game.snapshot().revision, 'one recorded step per kernel revision');

  const replay = await replayMatch({ json, trustedReleases: TRUSTED_RELEASES, setup, steps });
  assert.equal(replay.played, steps.length);
  assert.equal(replay.diverged, null);
  assert.equal(replay.failed, null);
  assert.deepEqual(replay.game.snapshot(), game.snapshot());
  // Halfway: the same state as the live game had then.
  const half = Math.floor(steps.length / 2);
  const partial = await replayMatch({ json, trustedReleases: TRUSTED_RELEASES, setup, steps, until: half });
  assert.equal(stateHash(partial.game.snapshot()), steps[half - 1].hash);
  // A record of another game is caught at its first move that differs.
  const other = await replayMatch({ json, trustedReleases: TRUSTED_RELEASES, setup: { ...setup, seed: [1, 2, 3, 4] }, steps });
  assert.ok(other.failed || other.diverged);
});

// Undo and reload restore an earlier saved state: the record notes a rewind, and the replay follows the moves made
// after it, not the ones taken back.
test('a takeback in the record: the replay follows the moves made after the rewind', async () => {
  const setup = { releaseId: meta.releaseId, seed: [5, 6, 7, 8], format: STANDARD_FORMAT, matchMode: 'normal',
    decks: [BOLT, DRAGAPULT].map((cards, i) => ({ id: `d${i}`, name: `deck ${i}`, cards })) };
  const { game, catalog } = await createReviewedGame({ json, trustedReleases: TRUSTED_RELEASES, decks: [BOLT, DRAGAPULT],
    seed: setup.seed, format: STANDARD_FORMAT, matchMode: 'normal' });
  const ai = createAI(catalog), steps = [];
  let live = game, saved = null;
  const move = (pick = (v, p) => ai(v, p)) => {
    const p = actor(live), v = live.view(p), action = pick(v, p);
    live.dispatch({ player: p, expectedRevision: v.revision, action });
    steps.push({ seq: steps.length + 1, type: 'action', player: p, revision: v.revision, action, hash: stateHash(live.snapshot()) });
  };
  for (let i = 0; i < 30; i++) {
    if (i === 20) saved = live.snapshot();
    move();
  }
  // Back to revision 20, then a different line: the last legal move wherever there is a choice of moves.
  live = OfficialGame.restore(structuredClone(saved), { catalog });
  steps.push({ seq: steps.length + 1, type: 'rewind', revision: saved.revision, reason: 'undo' });
  for (let i = 0; i < 15; i++) move((v, p) => (v.pending ? ai(v, p) : v.legalActions.at(-1)));
  const replay = await replayMatch({ json, trustedReleases: TRUSTED_RELEASES, setup, steps });
  assert.equal(replay.played, 35);
  assert.equal(replay.diverged, null);
  assert.deepEqual(replay.game.snapshot(), live.snapshot());
});

// The hover reason for a dimmed Supporter (ui.js whyNot): 奥琳博士的气魄 with no Basic Energy in the discard pile is
// not a used Supporter — what follows 然后 happens only if some of what precedes it did (II.E-19 FAQ2).
test('hover reasons read this turn: a Supporter played, an Item lock, a Supporter that would change nothing', async () => {
  const ctx = await reviewed([1, 2, 3, 4], [BOLT, DRAGAPULT], STANDARD_FORMAT);
  const table = (g) => new Match({ game: g, catalog: ctx.catalog, presentation: meta.cards, decks: ['a', 'b'], controllers: [], hooks: {} });
  let sada, crispin;
  const empty = board(ctx, ['raging-bolt-ex', 'budew'], (s, h) => { [sada, crispin] = h.hand(0, 'professor-sadas-vitality', 'crispin'); });
  assert.equal(playable(empty, sada), false, 'Nothing to attach: the draw after 然后 does not happen either.');
  assert.equal(playable(empty, crispin), true);
  assert.equal(table(empty).playedThisTurn(ME, 'supporter'), false, 'Not a Supporter already played.');
  play(empty, crispin); settle(empty);
  assert.equal(table(empty).playedThisTurn(ME, 'supporter'), true);
  assert.equal(table(empty).playedThisTurn(OPP, 'supporter'), false);

  const ctx2 = await reviewed([1, 2, 3, 4], [DRAGAPULT, BOLT], STANDARD_FORMAT);
  const g = board(ctx2, ['budew', 'raging-bolt-ex']);
  assert.equal(table(g).lockedFrom(OPP, 'playItem'), false);
  attack(g, `${ctx2.id.budew}:itchy-pollen`); settle(g);
  assert.equal(g.snapshot().current, OPP);
  assert.equal(table(g).lockedFrom(OPP, 'playItem'), true, '痒痒花粉 locks the opponent’s Items next turn.');
  assert.equal(table(g).lockedFrom(OPP, 'playSupporter'), false);
  assert.equal(table(g).lockedFrom(ME, 'playItem'), false);
  assert.equal(table(g).playedThisTurn(ME, 'supporter'), false, 'A new turn: nothing played yet.');
});

// Report #1: 小茂's 宝可梦交替 showed as a card back. A Trainer that waits for a choice stays out of the discard pile
// while it resolves; the view names it from the moment it is played (I.B-01—04: it is played face up).
test('the opponent’s Trainer is named on the table while it waits for its choice', async () => {
  const ctx = await reviewed([1, 2, 3, 4], [DRAGAPULT, BOLT], STANDARD_FORMAT);
  let boss;
  const g = board(ctx, ['dreepy', 'raging-bolt-ex'], (s, h) => { fixtureClock(s, [0, 1, 0, 1]); [boss] = h.hand(1, 'bosss-orders'); h.bench(0, 'budew'); });
  const table = new Match({ game: g, catalog: ctx.catalog, presentation: meta.cards, decks: ['a', 'b'], controllers: [], hooks: {} });
  assert.equal(table.card(boss).kind, 'unknown', 'Hidden while in 小茂’s hand.');
  command(g, { type: 'playTrainer', cardId: boss }, 1);
  assert.equal(g.snapshot().pending?.player, 1, '老大的指令 waits for its choice.');
  assert(!g.view(0).players[1].discard.some((c) => c.instanceId === boss));
  const opened = g.view(0).events.find((e) => e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-open');
  assert.deepEqual(opened.data.card, { instanceId: boss, printingId: g.snapshot().cards[boss].printingId, definitionId: ctx.id['bosss-orders'] });
  assert.equal(g.snapshot().events.find((e) => e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-open').data.card, undefined,
    'The stored event keeps only the instance id.');
  table.index(g.view(0));
  assert.equal(table.card(boss).name, '老大的指令');
  assert.equal(table.eventLine(opened), '小茂使用了「老大的指令」。');
});
