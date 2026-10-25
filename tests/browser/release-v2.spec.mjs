import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

test('startup is index-only and opening a game downloads exactly its approved shards', async ({ page }) => {
  const requested = [], errors = [];
  page.on('request', (r) => requested.push(new URL(r.url()).pathname));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/?speed=fast&seed=1,2,3,4');
  await expect(page.locator('.deck[data-deck="csvh1c-pikachu"]')).toBeVisible();
  expect(requested.some((p) => p.endsWith('/manifest.json'))).toBe(true);
  expect(requested.some((p) => /\/pool-index\.[a-f0-9]+\.json$/.test(p))).toBe(true);
  expect(requested.filter((p) => p.includes('/shards/'))).toEqual([]);
  expect(requested.some((p) => p.endsWith('/release.json'))).toBe(false);
  await page.locator('.deck[data-deck="csvh1c-pikachu"]').click();
  await page.locator('#opt-opp').selectOption('raging-bolt-679141');
  await page.locator('#btn-start').click();
  await expect(page.locator('#table')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__cnTable.matchId())).not.toBeNull();
  const id = await page.evaluate(() => window.__cnTable.matchId());
  const { match } = await (await page.request.get(`/api/matches/${id}`)).json();
  const shards = requested.filter((p) => p.includes('/shards/'));
  const expected = match.setup.approval.shards.map((s) => s.shardId).sort();
  expect(shards.map((p) => p.split('/').pop().replace(/\.[a-f0-9]{16}\.json$/, '')).sort()).toEqual(expected);
  expect(new Set(shards).size).toBe(shards.length);
  expect(shards.length).toBeLessThan(20);
  expect(match.setup.clientApproval.catalogId).toBe(match.setup.approval.catalogId);
  expect(match.setup.compatibility).toEqual({ catalogMatches: true, manifestMatches: true });
  expect(errors).toEqual([]);
});

test('a mismatched saved subset is visibly refused instead of silently replayed with the current pool', async ({ page }) => {
  const script = `
    import { reviewed } from './tests/cn-cards/helpers.mjs';
    const ctx = await reviewed();
    console.log(JSON.stringify({ releaseId: ctx.approval.releaseId,
      approval: { ...ctx.approval, catalogId: 'f'.repeat(64) }, decks: ['csvh1c-pikachu', 'csvh1c-pikachu'],
      snapshot: ctx.game.snapshot(), log: [] }));
  `;
  const saved = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const { user } = await (await page.request.get('/api/auth/me')).json();
  const key = `cn-table-save-v2:${user.id}`;
  await page.addInitScript(([key, saved]) => localStorage.setItem(key, JSON.stringify(saved)), [key, saved]);
  await page.goto('/play/?speed=fast');
  await expect(page.locator('#deck-choices .load-error')).toContainText('无法继续此存档');
  await expect(page.locator('#deck-choices .load-error')).toContainText('Recorded catalogId differs');
  await expect(page.locator('#table')).toBeHidden();
  expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBeNull();
});

test('a damaged shard cannot start or record a game and shows a recoverable error', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/shards/*.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('/play/?speed=fast');
  await expect(page.locator('.deck[data-deck="csvh1c-pikachu"]')).toBeVisible();
  await page.locator('.deck[data-deck="csvh1c-pikachu"]').click();
  await page.locator('#btn-start').click();
  await expect(page.locator('#deck-choices .load-error')).toContainText('pinned number of raw bytes');
  await expect(page.locator('#table')).toBeHidden();
  expect(await page.evaluate(() => window.__cnTable.matchId())).toBeNull();
  expect(errors).toEqual([]);
});

test('a late successful shard check cannot re-enable play after the deck has been edited', async ({ page, baseURL }) => {
  const meta = await (await page.request.get('/play/data/cn/V20261019/decks.json')).json();
  const preset = meta.decks.find((d) => d.id === 'csvh1c-pikachu');
  const made = await page.request.post('/api/decks', { headers: { Origin: baseURL }, data: {
    name: '异步校验回归', format: 'open', cards: preset.cards,
  } });
  expect(made.status()).toBe(201);
  const { deck } = await made.json();
  let unblock, blocked = 0;
  const gate = new Promise((resolve) => { unblock = resolve; });
  await page.route('**/shards/*.json', async (route) => { blocked++; await gate; await route.continue(); });
  try {
    await page.goto(`/play/decks.html?id=${deck.id}`);
    await expect(page.locator('#ed-check')).toContainText('由规则内核校验卡组');
    await expect.poll(() => blocked).toBeGreaterThan(0);
    await page.locator('.ed-row[data-id="zh-Hans:CSVH1C:008/059"] [data-act="remove"]').click();
    await expect(page.locator('#ed-count')).toContainText('59');
    await expect(page.locator('#ed-check')).toContainText('卡组需要正好 60 张卡');
    unblock();
    // This page has no background polling. Wait for the deliberately blocked
    // finite shard fetches to settle before checking the stale result guard.
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#ed-check')).toContainText('现在是 59 张');
    await expect(page.locator('#ed-play')).toBeHidden();
  } finally { unblock(); }
});
