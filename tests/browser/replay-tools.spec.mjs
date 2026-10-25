// The replay's controls (ui.js ?replay=<id>[&at=<n>]): a move back or forward, jumping to a move, taking the game over
// from the move on view as a new game with a match number of its own, and 报告问题, which the server keeps as a file
// with the game's record. Records are files of the replay directory too (server/record-files.mjs).
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPLAY_DIR, BUG_REPORT_DIR } from '../../playwright.config.mjs';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

// The first MOVES moves of a game the CPU plays on both sides, recorded the way the table records them (recorder.js). It
// runs in a plain Node process: the release pins handler sources, which the test runner's transform would change.
const MOVES = 16;
function recordedGame() {
  const script = `
    import { readFile } from 'node:fs/promises';
    import { createReviewedGame } from './public/rules/engine.js';
    import { loadRelease } from './server/catalog.mjs';
    import { createAI } from './public/cn/ai.js';
    import { stateHash } from './public/replay.js';
    import { releaseIdentity } from './public/release-identity.js';
    const meta = JSON.parse(await readFile('public/data/cn/V20261019/decks.json', 'utf8'));
    const deck = (id) => meta.decks.find((d) => d.id === id), list = (d) => d.cards.flatMap(([id, n]) => Array(n).fill(id));
    const [a, b] = [deck('raging-bolt-679141'), deck('dragapult-676815')];
    const setup = { releaseId: meta.releaseId, seed: [3, 1, 4, 1], format: a.format, matchMode: 'normal',
      decks: [a, b].map((d) => ({ id: d.id, name: d.name, cards: list(d) })) };
    const { game, catalog, approval } = await createReviewedGame({ release: await loadRelease(), decks: setup.decks.map((d) => d.cards),
      seed: setup.seed, format: setup.format, matchMode: 'normal' });
    setup.approval = releaseIdentity(approval);
    const ai = createAI(catalog), steps = [];
    while (steps.length < ${MOVES}) {
      const p = [0, 1].find((q) => { const v = game.view(q); return v.pending || v.legalActions.length; });
      const revision = game.snapshot().revision, action = ai(game.view(p), p);
      game.dispatch({ player: p, expectedRevision: revision, action });
      steps.push({ key: 'gen.' + revision, step: { type: 'action', player: p, revision, action, hash: stateHash(game.snapshot()) } });
    }
    console.log(JSON.stringify({ setup, steps }));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
}

const files = async (dir, start) => (await readdir(dir)).filter((f) => f.startsWith(start));

test('a replay goes back, forward and to any move; taken over, it plays on as a new match; 报告问题 keeps a file', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { setup, steps } = recordedGame();
  const id = (await (await page.request.post('/api/matches', { data: { setup } })).json()).match.id;
  expect((await (await page.request.post(`/api/matches/${id}/steps`, { data: { steps, turn: 2 } })).json()).added).toBe(MOVES);
  // The record is a file of the replay directory too.
  const [replayFile] = await files(REPLAY_DIR, `match-${id}-`);
  expect(JSON.parse(await readFile(join(REPLAY_DIR, replayFile), 'utf8')).steps).toHaveLength(MOVES);

  // ?at= opens the replay paused at that move.
  const progress = page.locator('#rp-progress'), at = async () => page.evaluate(() => [window.__cnTable.replay().pos, window.__cnTable.view().revision]);
  await page.goto(`/play/?replay=${id}&at=10&speed=fast`);
  await expect(progress).toHaveText(`第 10 / ${MOVES} 步`, { timeout: 60_000 });
  expect(await at()).toEqual([10, 10]);
  await expect(page.locator('#rp-play')).toContainText('继续');
  // The controls are in the bar between the mats; the log is a column opened from there (its lines, as shown, are compared).
  await expect(page.locator('#hint .rp-title')).toHaveText(`回放 · 对局 #${id}`);
  await page.locator('#btn-log').click();
  await expect(page.locator('#log-panel')).toBeVisible();
  const logAt10 = await page.locator('#log').innerText();

  // A move back and forward, by button and by ← / →; going back shows the log as it stood at that move.
  await page.locator('#rp-back').click();
  await expect(progress).toHaveText(`第 9 / ${MOVES} 步`);
  expect(await at()).toEqual([9, 9]);
  expect(logAt10.startsWith(await page.locator('#log').innerText())).toBe(true);
  await page.locator('#rp-step').click();
  await expect(progress).toHaveText(`第 10 / ${MOVES} 步`);
  await expect.poll(async () => page.locator('#log').innerText()).toBe(logAt10);
  await page.keyboard.press('ArrowLeft');
  await expect(progress).toHaveText(`第 9 / ${MOVES} 步`);
  await page.keyboard.press('ArrowRight');
  await expect(progress).toHaveText(`第 10 / ${MOVES} 步`);

  // Jumping: to a move, past the end (the last move), back to the start.
  const jump = async (n) => { await page.locator('#rp-at').fill(String(n)); await page.locator('#rp-jump button').click(); };
  await jump(3);
  await expect(progress).toHaveText(`第 3 / ${MOVES} 步`);
  expect(await at()).toEqual([3, 3]);
  const logAt3 = await page.locator('#log').innerText();
  await jump(99);
  await expect(progress).toHaveText(`第 ${MOVES} / ${MOVES} 步`);
  await expect(page.locator('#log')).toContainText('回放结束');
  await expect(page.locator('#rp-step')).toBeDisabled();
  await jump(0);
  await expect(progress).toHaveText(`第 0 / ${MOVES} 步`);
  await expect(page.locator('#rp-back')).toBeDisabled();
  await jump(3);
  await expect(progress).toHaveText(`第 3 / ${MOVES} 步`);
  expect(await page.locator('#log').innerText()).toBe(logAt3);
  await expect(page.locator('#log')).not.toContainText('不一致');
  await expect(page).toHaveURL(/[?&]at=3(&|$)/); // the address follows the move on view

  // 报告问题 while watching: the report names the replay and the move on view.
  await page.locator('#btn-report').click();
  await page.locator('.report-form textarea').fill('回放第 3 步：测试报告');
  await page.locator('.report-form button.primary').click();
  await expect(page.locator('.acct-dialog')).toContainText(/已保存问题报告 bug-\d{8}T\d{6}Z-match-\d+/);
  await page.locator('.acct-dialog [data-act="ok"]').click();
  const [watched] = await files(BUG_REPORT_DIR, 'bug-');
  const report = JSON.parse(await readFile(join(BUG_REPORT_DIR, watched), 'utf8'));
  expect([report.description, report.matchId, report.replay, report.move, report.state.revision, report.match.id, report.steps.length])
    .toEqual(['回放第 3 步：测试报告', id, true, 3, 3, id, MOVES]);
  expect(report.log.join('\n')).toBe(logAt3);
  expect(report.page).toMatch(new RegExp(`\\?replay=${id}&at=3(&|$)`));

  // Taken over at move 5: a new match whose record starts with the first 5 moves, played on at the table. A game still
  // going on this browser gives way to it, its record marked abandoned.
  const unfinished = (await (await page.request.post('/api/matches', { data: { setup } })).json()).match.id;
  await page.evaluate(({ id: recordId, releaseId }) => localStorage.setItem(window.__cnTable.saveKey(),
    JSON.stringify({ releaseId, approval: {}, snapshot: {}, record: { id: recordId, pending: [] } })), { id: unfinished, releaseId: setup.releaseId });
  await jump(5);
  await expect(progress).toHaveText(`第 5 / ${MOVES} 步`);
  await page.locator('#rp-takeover').click();
  await expect(page.locator('.acct-dialog')).toContainText(`从对局 #${id} 的第 5 步接管`);
  await expect(page.locator('.acct-dialog')).toContainText('还没下完的对局会结束');
  await page.locator('.acct-dialog [data-act="yes"]').click();
  await expect(page).toHaveURL(/\/play\/$/);
  await expect(page.locator('#log')).toContainText(`从对局 #${id} 的第 5 步接管`, { timeout: 60_000 });
  const taken = await page.evaluate(() => window.__cnTable.matchId());
  expect(taken).not.toBe(id);
  expect(await page.evaluate(() => window.__cnTable.view().revision)).toBeGreaterThanOrEqual(5);
  const record = await (await page.request.get(`/api/matches/${taken}`)).json();
  expect(record.match.setup.takeover).toEqual({ match: id, move: 5 });
  expect(record.match.setup.seed).toEqual(setup.seed);
  expect(record.steps.slice(0, 5).map((s) => [s.type, s.revision, s.player, s.action, s.hash]))
    .toEqual(steps.slice(0, 5).map(({ step: s }) => ['action', s.revision, s.player, s.action, s.hash]));
  expect((await (await page.request.get(`/api/matches/${unfinished}`)).json()).match.status).toBe('abandoned');

  // 报告问题 in the game taken over: the record sent goes up to the move on the table.
  await page.locator('#btn-report').click();
  await page.locator('.report-form textarea').fill('接管后的测试报告');
  await page.locator('.report-form button.primary').click();
  await expect(page.locator('.acct-dialog')).toContainText(`已保存问题报告 bug-`);
  const live = JSON.parse(await readFile(join(BUG_REPORT_DIR, (await files(BUG_REPORT_DIR, 'bug-')).find((f) => f.includes(`match-${taken}`))), 'utf8'));
  expect([live.matchId, live.replay, live.match.setup.takeover]).toEqual([taken, false, { match: id, move: 5 }]);
  expect(live.move).toBeGreaterThanOrEqual(5);
  expect(live.steps.filter((s) => s.type === 'action').length).toBeGreaterThanOrEqual(live.move);

  // 对局记录 links the new game back to the move it was taken over at.
  await page.goto('/play/matches.html');
  await expect(page.locator(`#matches a[href="./?replay=${id}&at=5"]`)).toHaveText(`接管自 #${id} 第 5 步`);
  expect(errors).toEqual([]);
});
