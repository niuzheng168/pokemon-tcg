// Machine-tier cards through the actual release, library, deck builder, game admission and persisted match record.
import { test, expect } from '@playwright/test';
import { abandonCurrent } from './server-games.mjs';

const SAMPLE = 'zh-Hans:151C:013/151';
test('machine cards remain labelled in library, saved decks, the table and match records', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await abandonCurrent(page);
  await page.goto('/play/cards.html');
  await page.locator('input[name="name"]').fill('独角虫');
  await page.locator('select[name="set"]').selectOption('151C');
  const sample = page.locator(`.lib-card[data-id="${SAMPLE}"]`);
  await expect(sample.locator('.impl-badge')).toHaveText('机器实现');
  await sample.locator('.lib-img').click();
  await expect(page.locator('.card-detail')).toContainText('未经人工逐张审核');
  await page.keyboard.press('Escape');

  // A simple mechanism fixture, not a proposed tournament deck: 4 released machine Basics and 56 Basic Grass.
  const made = await page.request.post('/api/decks', { headers: { Origin: baseURL }, data: {
    name: '机器卡浏览器测试', format: 'open', cards: [[SAMPLE, 4], ['zh-Hans:CSVE1C:GRA', 56]],
  } });
  expect(made.status()).toBe(201);
  const { deck } = await made.json();
  expect(deck.legal).toBe(true);
  await page.goto(`/play/decks.html?id=${deck.id}`);
  await expect(page.locator(`.ed-row[data-id="${SAMPLE}"] .impl-badge`)).toHaveText('机器实现');
  await expect(page.locator('#ed-check')).toContainText('可以对战');

  await page.goto(`/play/?deck=user:${deck.id}&auto=1&speed=fast&seed=3,1,4,1`);
  await expect(page.locator(`.deck.sel[data-deck="user:${deck.id}"]`)).toContainText('机器卡浏览器测试');
  // An opponent of reviewed cards only, so the game's machine printings are the sample's (some preset decks have many).
  await page.locator('#opt-opp').selectOption('csvh1c-pikachu');
  await page.locator('#btn-start').click();
  await expect(page.locator('#log')).toContainText('本局包含 1 种机器实现印刷');
  await expect.poll(() => page.evaluate(() => window.__cnTable.matchId())).not.toBeNull();
  const id = await page.evaluate(() => window.__cnTable.matchId());
  const record = await (await page.request.get(`/api/matches/${id}`)).json();
  expect(record.match.setup.implementation.machinePrintings).toEqual([SAMPLE]);
  await page.goto('/play/matches.html');
  await expect(page.locator('table tr', { hasText: `#${id}` }).locator('.impl-badge.machine')).toHaveText('含机器实现');
  expect(errors).toEqual([]);
});
