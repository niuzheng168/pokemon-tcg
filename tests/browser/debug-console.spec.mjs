// The administrators' 调试台 on the table (public/debug-panel.js over debug-console.js): typed commands and the
// point-and-click panel rewrite the game in progress, play goes on from the new state, the record keeps every edit, and
// its replay passes through them. Players never see it.
import { test, expect } from '@playwright/test';
import { ADMIN } from '../../playwright.config.mjs';

test.use({ storageState: { cookies: [], origins: [] } }); // signs in as the administrator

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

const shown = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const tap = (locator) => locator.click({ timeout: 3000 }).catch(() => {});
// The opening and setup choices, answered with the first option.
async function untilYourMove(page) {
  for (let i = 0; i < 600; i++) {
    if (await shown(page, 'body.your-move') || await shown(page, '#end-slot .k-end')) return;
    if (await shown(page, '.call-btn')) await tap(page.locator('.call-btn').first());
    else if (await shown(page, '.rps-pick')) await tap(page.locator('.rps-pick').first());
    else if (await shown(page, '.setup-ov.st-active:not(.picked) .st-card')) await tap(page.locator('.setup-ov.st-active .st-card').first());
    else if (await shown(page, '.setup-ov.st-bench:not(.done) .st-ok')) await tap(page.locator('.setup-ov.st-bench .st-ok'));
    else if (await shown(page, '#modal:not([hidden]) .dialog.sheet [data-id]')) {
      await tap(page.locator('#modal-body [data-id]').first());
      if (await page.locator('#choice-ok').count()) await tap(page.locator('#choice-ok'));
    } else await page.waitForTimeout(100);
  }
  throw new Error('the table never offered a move');
}
const view = (page) => page.evaluate(() => window.__cnTable.view());
const BOSS = 'zh-Hans:30thDC:039/040'; // 老大的指令

test('the administrator rewrites the game from the console and the panel; the record and its replay keep the edits', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/?seed=2,7,1,8&speed=fast');
  await page.locator('input[name="username"]').fill(ADMIN.username);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('#auth-submit').click();
  await page.locator('.deck[data-deck="raging-bolt-679141"]').click();
  await page.locator('#opt-opp').selectOption('dragapult-676815');
  await page.locator('#btn-start').click();
  await untilYourMove(page);

  // Typed: the next card is 老大的指令, then draw it.
  await page.locator('#btn-debug').click();
  await expect(page.locator('.debug-panel')).toBeVisible();
  const cmd = page.locator('.debug-panel .dbg-cmd input');
  const hand = async () => (await view(page)).players[0].hand.map((c) => c.printingId);
  const before = (await hand()).filter((p) => p === BOSS).length;
  await cmd.fill('/nextcard 老大的指令');
  await cmd.press('Enter');
  await expect(page.locator('.dbg-out')).toContainText('牌库最上方');
  await cmd.fill('/draw');
  await cmd.press('Enter');
  await expect.poll(async () => (await hand()).filter((p) => p === BOSS).length).toBe(before + 1);
  await expect(page.locator('#log')).toContainText('（调试）/nextcard 老大的指令');
  // A mistake is explained, and changes nothing.
  await cmd.fill('/mon bench9 hp=10');
  await cmd.press('Enter');
  await expect(page.locator('.dbg-out .err').last()).toContainText('备战区没有第 9 只');

  // Point and click: the Active Pokémon's HP, and a deck card into the hand.
  await page.locator('.dbg-tabs [data-tab="mons"]').click();
  const hp = page.locator('.dbg-mon.active input[type=number]').first();
  await hp.fill('100');
  await hp.press('Enter');
  await expect.poll(async () => (await view(page)).players[0].active.effective.currentHp).toBe(100);
  await page.locator('.dbg-tabs [data-tab="cards"]').click();
  const size = (await view(page)).players[0].hand.length;
  await page.locator('.dbg-cards .dbg-card[data-zone="deck"]').first().click();
  await page.locator('.dbg-menu [data-run$=" hand"]').click();
  await expect.poll(async () => (await view(page)).players[0].hand.length).toBe(size + 1);

  // Play goes on from the edited state.
  await page.locator('.debug-panel .dbg-close').click();
  await page.locator('#end-slot .k-end').click();
  await untilYourMove(page);

  // The record holds the four edits with their commands (the refused one is not an edit); the replay passes through them and matches every state.
  const id = await page.evaluate(() => window.__cnTable.matchId());
  await expect.poll(async () => (await (await page.request.get(`/api/matches/${id}`)).json()).steps.filter((s) => s.type === 'edit').length).toBe(4);
  const { steps } = await (await page.request.get(`/api/matches/${id}`)).json();
  expect(steps.filter((s) => s.type === 'edit').map((s) => s.command.split(' ')[0])).toEqual(['/nextcard', '/draw', '/mon', '/move']);
  await page.goto('/play/matches.html');
  await expect(page.locator('#matches .tag-debug').first()).toContainText('调试 4');
  await page.goto(`/play/?replay=${id}&speed=fast`);
  await expect(page.locator('#log')).toContainText('回放结束', { timeout: 120_000 });
  await expect(page.locator('#log')).toContainText('调试修改：/nextcard 老大的指令');
  await expect(page.locator('#log')).not.toContainText('不一致');
  await expect(page.locator('#btn-debug')).toHaveCount(0);
  expect(errors).toEqual([]);
});
