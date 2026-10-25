// 小茂's difficulty and the Professor's estimates on the table. The website under test runs without its own AI
// (playwright.config.mjs --ai-workers 0); here the page's AI requests go to a real AI server started for this test
// (scripts/ai-server.mjs), so the table, the requests it sends and what it shows are the real ones.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';

const LEVELS = ['新手', '训练家', '道馆馆主', '四天王', '宝可梦大师'];
let server, aiUrl;
const requests = [];
test.beforeAll(async () => {
  server = spawn(process.execPath, ['scripts/ai-server.mjs', '--port', '0', '--workers', '2'], { stdio: ['ignore', 'pipe', 'inherit'] });
  aiUrl = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { const m = /AI server: (http:\/\/\S+?)\/ /.exec(String(d)); if (m) resolve(m[1]); });
    server.on('exit', (code) => reject(new Error(`the AI server stopped (${code})`)));
  });
});
test.afterAll(() => server?.kill());

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.route('**/api/engine', (route) => route.fulfill({ json: { engine: 'search', ready: true, where: 'remote',
    levels: LEVELS.map((name, i) => ({ level: i + 1, name })) } }));
  for (const kind of ['decide', 'rate']) await page.route(`**/api/${kind}`, async (route) => {
    const body = route.request().postData();
    requests.push({ kind, body: JSON.parse(body) });
    const r = await fetch(`${aiUrl}/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    await route.fulfill({ status: r.status, json: await r.json() });
  });
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

test('小茂 plays at the chosen difficulty; the Professor gives each move a chance to win and reasons', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/?seed=11,22,33,44&speed=fast');
  // The start bar offers the five levels; the choice is remembered.
  const level = page.locator('#start-engine #opt-level');
  await expect(level.locator('option')).toHaveText(['新手', '训练家', '道馆馆主', '四天王', '宝可梦大师']);
  await level.selectOption('3');
  expect(await page.evaluate(() => localStorage.getItem('ai-level'))).toBe('3');

  await page.locator('.deck[data-deck="csvh1c-pikachu"]').click();
  await page.locator('#opt-opp').selectOption('raging-bolt-679141');
  await page.locator('#btn-start').click();
  await expect(page.locator('#table')).toBeVisible();
  await expect(page.locator('#engine-badge')).toHaveText('小茂 · 道馆馆主');
  await untilYourMove(page);
  await expect(page.locator('#log')).toContainText('小茂的难度：道馆馆主。');
  // Settings shows the five levels and what the chosen one does.
  await page.locator('#engine-badge').click();
  await expect(page.locator('#engine-box .eng-tab')).toHaveCount(5);
  await expect(page.locator('#engine-box .eng-tab.on')).toContainText('道馆馆主');
  await expect(page.locator('#engine-box .eng-desc')).toContainText('道馆馆主');
  await page.locator('#settings-close').click();

  // On your move the Professor estimates every move: his pick in the bar, a chance on each move, the reasons with it.
  await expect(page.locator('#coach-msg')).toContainText(/我建议：.*胜算约 \d+%/, { timeout: 60_000 });
  await expect(page.locator('#win-label')).toContainText(/约 \d+%/);
  const rate = requests.find((r) => r.kind === 'rate');
  expect(rate.body.player).toBe(0);
  expect(rate.body.snapshot.players).toHaveLength(2);
  const keys = rate.body.actions.map((a) => a.key);
  expect(keys.length).toBeGreaterThan(1);
  await expect(page.locator('#end-slot .k-end .pct')).toHaveText(/\d+%/);
  const card = page.locator('#hand .hcard:not(.unplayable)').first();
  if (await card.count()) {
    await card.click();
    await expect(page.locator('.act-menu .act .pct').first()).toHaveText(/\d+%/);
    await page.keyboard.press('Escape');
  }

  // 小茂 plays his turn at level 3: every request carries the level and the game's snapshot, and he says how he rates it.
  await page.locator('#end-slot .k-end').click();
  await untilYourMove(page);
  const decides = requests.filter((r) => r.kind === 'decide');
  expect(decides.length).toBeGreaterThan(0);
  for (const d of decides) expect([d.body.level, d.body.player, typeof d.body.snapshot.revision]).toEqual([3, 1, 'number']);
  await expect(page.locator('#log')).not.toContainText('决策引擎出错');
  expect(errors).toEqual([]);
});
