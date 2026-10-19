import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Language/UI tests must not download thousands of third-party card scans.
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

test('Chinese homepage, English switch, shared preference and game reload', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('h1')).toContainText('边玩边学');
  await expect(page.locator('[data-lang="zh-CN"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-lang="en"]').click();
  await expect(page.locator('h1')).toContainText('by playing it');
  await page.locator('[data-i18n="hero.play"]').click();
  await expect(page.locator('[data-i18n="ui.welcome"]')).toHaveText('Welcome, Trainer!');
  await page.locator('.start-lang [data-lang="zh-CN"]').click();
  await expect(page.locator('[data-i18n="ui.welcome"]')).toContainText('卡牌学堂');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('[data-i18n="ui.welcome"]')).toContainText('卡牌学堂');
  expect(errors).toEqual([]);
});

test('Chinese homepage uses local Chinese screenshots and practice faces, with reversible images', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-i18n="nav.brand"]')).toHaveText('宝可梦卡牌学堂');
  const localized = page.locator('img[data-zh-src]');
  expect(await localized.count()).toBe(14);
  for (const image of await localized.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect(image).toHaveAttribute('src', /^(?:screenshots\/zh-CN\/|play\/img\/zh-learning\/)/);
    await expect.poll(() => image.evaluate((el) => el.complete && el.naturalWidth > 0)).toBeTruthy();
  }
  const board = page.locator('[data-i18n-alt="alt.board"]');
  await page.locator('[data-lang="en"]').click();
  await expect(board).toHaveAttribute('src', 'screenshots/board.webp');
  await expect(board).toHaveAttribute('srcset', /screenshots\/board-800.webp/);
  await page.locator('[data-lang="zh-CN"]').click();
  await expect(board).toHaveAttribute('src', 'screenshots/zh-CN/board.webp');
  await expect(board).toHaveAttribute('srcset', /screenshots\/zh-CN\/board-800.webp/);
});

test('rules use official terms and modern decks load in Chinese', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/');
  await page.locator('#start-rules').click();
  await expect(page.locator('#rules-body')).toContainText('抗性');
  await expect(page.locator('#rules-body')).toContainText('宝可梦检查');
  await expect(page.locator('#rules-body')).toContainText('竞技场卡');
  await expect(page.locator('#rules-body')).not.toContainText('抵抗力');
  await page.locator('#rules-close').click();
  await page.locator('[data-format="modern"]').click();
  await page.locator('[data-deck="svl-mewtwo"]').click();
  await expect(page.locator('[data-deck="svl-mewtwo"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#btn-start')).toBeEnabled();
  await expect(page.locator('[data-deck="svl-mewtwo"] .d-sub')).toContainText('支援者卡');
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/zh-cn-game-home.png', fullPage: false });
});

test('Chinese game can complete setup and reach a legal move', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('opt-anim', '0');
    localStorage.setItem('tourDone', '1');
  });
  await page.goto('/play/');
  await page.locator('[data-deck="ash"]').click();
  await page.locator('#opt-opp').selectOption('brock');
  await page.locator('#btn-start').click();
  // Setup uses interactive coin and card-selection overlays; run only visible, scoped controls.
  for (let i = 0; i < 50; i++) {
    if (await page.locator('#actions .act').count()) break;
    const candidates = [
      '.coin-ov.calling [data-call="heads"]', '.coin-ov .cs-continue',
      '.st-active:not(.picked) .st-card', '.st-bench:not(.done) .st-ok',
      '#modal-body .pick-card', '#modal-body button.primary', '#modal-body .opt-word',
    ];
    for (const selector of candidates) {
      const button = page.locator(selector).filter({ visible: true }).first();
      if (await button.count() && await button.isEnabled()) { await button.click(); break; }
    }
    await page.waitForTimeout(250);
  }
  await expect(page.locator('#actions .act').first()).toBeVisible();
  await expect(page.locator('#actions-panel h2')).toHaveText('轮到你行动');
  await expect(page.locator('#log')).toContainText('回合');
  expect(errors).toEqual([]);
});

test('unavailable storage does not prevent Chinese startup', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Disabled', 'SecurityError'); } });
  });
  await page.goto('/play/');
  await expect(page.locator('[data-i18n="ui.welcome"]')).toContainText('卡牌学堂');
  await page.locator('.start-lang [data-lang="en"]').click();
  await expect(page.locator('[data-i18n="ui.welcome"]')).toHaveText('Welcome, Trainer!');
});

test('missing local scans fall back to explicitly labelled learning faces', async ({ page }) => {
  await page.route('**/img/zh-scans/**', (route) => route.abort());
  await page.goto('/play/');
  await page.locator('[data-format="modern"]').click();
  const deck = page.locator('[data-deck="svd-ninetales"]');
  await deck.scrollIntoViewIfNeeded();
  const image = deck.locator('.deck-art img').first();
  await expect(image).toHaveAttribute('src', /img\/zh-learning\/sv3pt5-38\.svg$/);
  await expect(image).toHaveAttribute('data-fallback', /非官方扫描/);
  await expect.poll(() => image.evaluate((el) => el.complete && el.naturalWidth > 0)).toBeTruthy();
});

test('ordinary static game never enables or requests restricted research assets', async ({ page }) => {
  const requests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/research-')) requests.push(request.url());
  });
  await page.goto('/play/');
  await expect(page.locator('[data-i18n="ui.welcome"]')).toContainText('卡牌学堂');
  await expect(page.locator('meta[name="tcg-private-research"]')).toHaveCount(0);
  expect(requests).toEqual([]);
  expect((await page.request.get('/api/research-scans')).status()).toBe(404);
});

test('Chinese mobile homepage and bilingual not-found page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('边玩边学');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto('/missing-page');
  await expect(page.locator('h1')).toContainText('草丛');
  await page.locator('[data-lang="en"]').click();
  await expect(page.locator('h1')).toContainText('tall grass');
});
