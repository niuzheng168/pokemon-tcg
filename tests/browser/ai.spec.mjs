// 小茂's difficulty and the Professor's estimates on the table. The game is played on the server, which asks the AI with
// its own state. The website of the other tests runs without an AI (playwright.config.mjs --ai-workers 0), so this test
// starts a website of its own (server/main.mjs, a fresh database) with a real AI server behind it (scripts/ai-server.mjs):
// the levels, 小茂's moves and the Professor's estimates are the real ones, and the page is seen never to send a state.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.use({ storageState: { cookies: [], origins: [] } }); // a player of this test's website

let ai, site, siteURL, dir;
const started = (child, pattern, what) => new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => { const m = pattern.exec(String(d)); if (m) resolve(m[1]); });
  child.on('exit', (code) => reject(new Error(`${what} stopped (${code})`)));
});
test.beforeAll(async () => {
  ai = spawn(process.execPath, ['scripts/ai-server.mjs', '--port', '0', '--workers', '2'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const aiURL = await started(ai, /AI server: (http:\/\/\S+?)\/ /, 'the AI server');
  dir = await mkdtemp(join(tmpdir(), 'cn-ai-site-'));
  site = spawn(process.execPath, ['server/main.mjs', '--port', '0', '--db', join(dir, 'accounts.db'), '--ai-url', aiURL, '--test-seeds',
    '--card-library', 'tests/fixtures/card-library', '--replay-dir', join(dir, 'replays'), '--bug-report-dir', join(dir, 'reports')],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  siteURL = await started(site, /Website: (http:\/\/\S+?)\/ /, 'the website');
});
test.afterAll(async () => {
  site?.kill();
  ai?.kill();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

const shown = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const tap = (locator) => locator.click({ timeout: 3000 }).catch(() => {});
// Answers whatever the table asks that is not a move: the opening, the setup stages, Prize cards and choices.
async function answer(page) {
  if (await shown(page, '.rps-pick')) return tap(page.locator('.rps-pick').first()).then(() => true);
  if (await shown(page, '.rps-btn')) return tap(page.locator('.rps-btn').first()).then(() => true);
  if (await shown(page, '.call-btn')) return tap(page.locator('.call-btn').first()).then(() => true);
  if (await shown(page, '.cs-continue:not([hidden])')) return tap(page.locator('.cs-continue:not([hidden])').first()).then(() => true);
  if (await shown(page, '.setup-ov.st-active:not(.picked) .st-card')) return tap(page.locator('.setup-ov.st-active .st-card').first()).then(() => true);
  if (await shown(page, '.setup-ov.st-bench:not(.done) .st-ok')) return tap(page.locator('.setup-ov.st-bench .st-ok')).then(() => true);
  if (await shown(page, '.prize-ov:not(.setup-ov):not(.picked) .pz-card')) return tap(page.locator('.prize-ov:not(.picked) .pz-card').first()).then(() => true);
  if (await shown(page, '#modal:not([hidden]) .dialog.sheet [data-id]')) {
    await tap(page.locator('#modal-body [data-id]').first());
    if (await page.locator('#choice-ok').count()) await tap(page.locator('#choice-ok'));
    return true;
  }
  return false;
}
async function untilYourMove(page) {
  for (let i = 0; i < 1200; i++) {
    if (await shown(page, 'body.your-move')) return;
    if (!(await answer(page))) await page.waitForTimeout(100);
  }
  throw new Error('the table never offered a move');
}

test('小茂 plays at the chosen difficulty; the Professor estimates the chance to win and rates the move you make', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const sent = [];
  page.on('request', (r) => { if (r.method() === 'POST') sent.push({ path: new URL(r.url()).pathname, body: r.postData() ?? '' }); });
  expect((await page.request.post(`${siteURL}/api/auth/register`, { data: { username: 'professor-oak', password: 'long-enough-1' } })).status()).toBe(201);
  await page.goto(`${siteURL}/play/?seed=11,22,33,44&speed=fast`);
  // The start bar offers the levels the server offers (the rule AI here: no language models); the choice is remembered.
  const level = page.locator('#start-engine #opt-level');
  await expect(level.locator('option')).toHaveText(['道馆馆主']);
  await level.selectOption('3');
  expect(await page.evaluate(() => localStorage.getItem('ai-level'))).toBe('3');

  await page.locator('.deck[data-deck="csvh1c-pikachu"]').click();
  await page.locator('#opt-opp').selectOption('raging-bolt-679141');
  await page.locator('#btn-start').click();
  await expect(page.locator('#table')).toBeVisible();
  await expect(page.locator('#engine-badge')).toHaveText('小茂 · 道馆馆主');
  await untilYourMove(page);
  await expect(page.locator('#log')).toContainText('小茂的难度：道馆馆主。');
  // Settings shows the levels offered and what the chosen one does; no language-model coach on this server.
  await page.locator('#engine-badge').click();
  await expect(page.locator('#engine-box .eng-tab')).toHaveCount(1);
  await expect(page.locator('#llm-coach-row')).toBeHidden();
  await expect(page.locator('#engine-box .eng-tab.on')).toContainText('道馆馆主');
  await expect(page.locator('#engine-box .eng-desc')).toContainText('道馆馆主');
  await page.locator('#settings-close').click();

  // On your move the Professor rates every move: the chance to win shows, and his word on the move you make follows it.
  // Which move to make is the coach's to suggest, so no move carries his pick or a chance. The page asks with the moves
  // only; the server rates them from its own state.
  await expect(page.locator('#win-label')).toContainText(/约 \d+%/, { timeout: 60_000 });
  const rate = sent.find((r) => r.path.endsWith('/rate'));
  expect(rate.path).toMatch(/^\/api\/play\/\d+\/rate$/);
  expect(JSON.parse(rate.body).actions.length).toBeGreaterThan(1);
  await expect(page.locator('#coach-msg')).toHaveCount(0);
  await expect(page.locator('#end-slot .k-end .pct, #end-slot .k-end.best')).toHaveCount(0);
  const card = page.locator('#hand .hcard:not(.unplayable)').first();
  if (await card.count()) {
    await card.click();
    await expect(page.locator('.act-menu .act').first()).toBeVisible();
    await expect(page.locator('.act-menu .act .pct, .act-menu .act .pick, .act-menu .act.best')).toHaveCount(0);
    await page.keyboard.press('Escape');
  }

  // 小茂 plays his turn at level 3, the game's level on the server; the page only asks for his moves.
  await page.locator('#end-slot .k-end').click();
  await expect(page.locator('#log')).toContainText('博士：');
  await untilYourMove(page);
  expect(sent.filter((r) => /^\/api\/play\/\d+\/cpu$/.test(r.path)).length).toBeGreaterThan(0);
  const id = Number(/\/api\/play\/(\d+)\//.exec(rate.path)[1]);
  expect((await (await page.request.get(`${siteURL}/api/matches/${id}`)).json()).match.setup.level).toBe(3);
  await expect(page.locator('#log')).not.toContainText('决策引擎出错');
  // No request of the page carries a game state: no snapshot, no deck order.
  expect(sent.filter((r) => /"(snapshot|state|rng)"/.test(r.body))).toEqual([]);
  expect(errors).toEqual([]);
});
