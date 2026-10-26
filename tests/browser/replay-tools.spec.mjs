// The replay's controls (ui.js ?replay=<id>[&at=<n>]): a move back or forward, jumping to a move, taking the game over
// from the move on view as a new game with a match number of its own, and 报告问题, which the server keeps as a file
// with the game's record. Records are files of the replay directory too (server/record-files.mjs).
import { test, expect } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPLAY_DIR, BUG_REPORT_DIR } from '../../playwright.config.mjs';
import { abandonCurrent } from './server-games.mjs';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await abandonCurrent(page);
});

// A game played on the server through its API (/api/play): the player answers each question with its first options and
// ends each turn at once, 小茂 makes his own moves; after MOVES moves the player concedes, so the game is over and its
// record (MOVES + 1 moves) can be replayed and taken over.
const MOVES = 16, TOTAL = MOVES + 1;
async function playedGame(page) {
  const call = async (path, data) => {
    const r = await page.request.post(path, { data });
    if (!r.ok()) throw new Error(`${path}: ${await r.text()}`);
    return r.json();
  };
  let u = await call('/api/play', { deck: 'raging-bolt-679141', opponent: 'dragapult-676815', seed: [3, 1, 4, 1] });
  const id = u.match.id;
  for (let n = 0; n < MOVES; n++) {
    const { status, view } = u, q = view.pending;
    if (status.actor === 1) { u = await call(`/api/play/${id}/cpu`, { revision: status.revision }); continue; }
    const action = q ? { type: 'answer', requestId: q.id, selected: q.options.slice(0, q.minimum) }
      : view.legalActions.find((a) => a.type === 'endTurn') ?? view.legalActions[0];
    u = await call(`/api/play/${id}/move`, { revision: status.revision, action });
  }
  await call(`/api/play/${id}/move`, { revision: u.status.revision, action: { type: 'concede' } });
  return id;
}

const files = async (dir, start) => (await readdir(dir)).filter((f) => f.startsWith(start));

test('a replay goes back, forward and to any move; taken over, it plays on as a new match; 报告问题 keeps a file', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const id = await playedGame(page);
  const { match: played, steps } = await (await page.request.get(`/api/matches/${id}`)).json();
  const actions = steps.filter((s) => s.type === 'action');
  expect([played.status, actions.length, steps.at(-1).type]).toEqual(['over', TOTAL, 'end']);
  // The record is a file of the replay directory too.
  const [replayFile] = await files(REPLAY_DIR, `match-${id}-`);
  expect(JSON.parse(await readFile(join(REPLAY_DIR, replayFile), 'utf8')).steps).toHaveLength(steps.length);

  // ?at= opens the replay paused at that move.
  const progress = page.locator('#rp-progress'), at = async () => page.evaluate(() => [window.__cnTable.replay().pos, window.__cnTable.view().revision]);
  await page.goto(`/play/?replay=${id}&at=10&speed=fast`);
  await expect(progress).toHaveText(`第 10 / ${TOTAL} 步`, { timeout: 60_000 });
  expect(await at()).toEqual([10, 10]);
  await expect(page.locator('#rp-play')).toContainText('继续');
  // The controls are in the bar between the mats; the log is a column opened from there (its lines, as shown, are compared).
  await expect(page.locator('#hint .rp-title')).toHaveText(`回放 · 对局 #${id}`);
  await page.locator('#btn-log').click();
  await expect(page.locator('#log-panel')).toBeVisible();
  const logAt10 = await page.locator('#log').innerText();

  // A move back and forward, by button and by ← / →; going back shows the log as it stood at that move.
  await page.locator('#rp-back').click();
  await expect(progress).toHaveText(`第 9 / ${TOTAL} 步`);
  expect(await at()).toEqual([9, 9]);
  expect(logAt10.startsWith(await page.locator('#log').innerText())).toBe(true);
  await page.locator('#rp-step').click();
  await expect(progress).toHaveText(`第 10 / ${TOTAL} 步`);
  await expect.poll(async () => page.locator('#log').innerText()).toBe(logAt10);
  await page.keyboard.press('ArrowLeft');
  await expect(progress).toHaveText(`第 9 / ${TOTAL} 步`);
  await page.keyboard.press('ArrowRight');
  await expect(progress).toHaveText(`第 10 / ${TOTAL} 步`);

  // Jumping: to a move, past the end (the last move), back to the start.
  const jump = async (n) => { await page.locator('#rp-at').fill(String(n)); await page.locator('#rp-jump button').click(); };
  await jump(3);
  await expect(progress).toHaveText(`第 3 / ${TOTAL} 步`);
  expect(await at()).toEqual([3, 3]);
  const logAt3 = await page.locator('#log').innerText();
  await jump(99);
  await expect(progress).toHaveText(`第 ${TOTAL} / ${TOTAL} 步`);
  await expect(page.locator('#log')).toContainText('回放结束');
  await expect(page.locator('#rp-step')).toBeDisabled();
  await jump(0);
  await expect(progress).toHaveText(`第 0 / ${TOTAL} 步`);
  await expect(page.locator('#rp-back')).toBeDisabled();
  await jump(3);
  await expect(progress).toHaveText(`第 3 / ${TOTAL} 步`);
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
    .toEqual(['回放第 3 步：测试报告', id, true, 3, 3, id, steps.length]);
  expect(report.log.join('\n')).toBe(logAt3);
  expect(report.page).toMatch(new RegExp(`\\?replay=${id}&at=3(&|$)`));

  // Taken over at move 5: a new match whose record starts with the first 5 moves, played on at the table. The player's
  // game still going on the server gives way to it, its record marked abandoned.
  const unfinished = (await (await page.request.post('/api/play', { data: { deck: 'csvh1c-pikachu' } })).json()).match.id;
  await jump(5);
  await expect(progress).toHaveText(`第 5 / ${TOTAL} 步`);
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
  expect(record.match.setup.seed).toBeNull(); // a game still being played keeps its seed on the server
  expect(record.steps.slice(0, 5).map((s) => [s.type, s.revision, s.player, s.action, s.hash]))
    .toEqual(actions.slice(0, 5).map((s) => ['action', s.revision, s.player, s.action, s.hash]));
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
