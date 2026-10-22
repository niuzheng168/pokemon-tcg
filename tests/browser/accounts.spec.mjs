// Accounts through the real pages: the login gate, registration, the card library and its filters, building a deck
// in 我的卡组 and playing with it on the table, signing out, and the administrator's 用户管理.
import { test, expect, request } from '@playwright/test';
import { ADMIN, PLAYER_STATE } from '../../playwright.config.mjs';

test.use({ storageState: { cookies: [], origins: [] } }); // these tests sign in themselves

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(() => localStorage.setItem('tourDone', '1'));
});

async function signIn(page, username, password) {
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('#auth-submit').click();
}

test('a new player registers, filters the card library, builds a deck and plays with it', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Every page needs a signed-in player; the login page brings them back where they were going.
  await page.goto('/play/cards.html');
  await expect(page).toHaveURL(/\/play\/login\.html\?next=%2Fplay%2Fcards\.html$/);
  await signIn(page, 'deckbuilder', 'wrong-pass-1');
  await expect(page.locator('.form-error')).toHaveText('用户名或密码不正确。');
  await page.locator('#tab-register').click();
  await page.locator('input[name="username"]').fill('deckbuilder');
  await page.locator('input[name="password"]').fill('build-a-deck-1');
  await page.locator('input[name="again"]').fill('build-a-deck-2');
  await page.locator('#auth-submit').click();
  await expect(page.locator('.form-error')).toHaveText('两次输入的密码不一样。');
  await page.locator('input[name="again"]').fill('build-a-deck-1');
  await page.locator('#auth-submit').click();
  await expect(page).toHaveURL(/\/play\/cards\.html$/);
  await expect(page.locator('#site-nav .user-btn')).toContainText('deckbuilder');
  await expect(page.locator('#site-nav')).not.toContainText('用户管理');

  // 卡牌库: every card of the library (the test library: some real library_v1 records plus the release), filtered by
  // name, skill, kind and category, type, format and whether its rules are implemented.
  const count = page.locator('.lib-count'), names = page.locator('.lib-card .lib-name');
  await expect(count).toHaveText(/^共 (\d+) 张（卡牌库 \1 张，其中 \d+ 张可对战）$/);
  const all = await names.count();
  expect(all).toBeGreaterThan(80);
  await page.locator('input[name="name"]').fill('皮卡丘');
  await expect(names).toContainText(['皮卡丘ex']);
  for (const n of await names.allInnerTexts()) expect(n).toContain('皮卡丘');
  await page.locator('input[name="name"]').fill('');
  await page.locator('input[name="skill"]').fill('电气发电机');
  await expect(page.locator('.lib-card[data-id="zh-Hans:CSVH1C:012/059"]')).toBeVisible();
  for (const n of await names.allInnerTexts()) expect(n).toBe('茸茸羊');
  await page.locator('input[name="skill"]').fill('');
  await page.locator('label:has(input[name="kind"][value="trainer"])').click();
  await page.locator('select[name="category"]').selectOption('supporter');
  await expect(page.locator('.lib-card .lib-sub').first()).toContainText('支援者');
  for (const s of await page.locator('.lib-card .lib-sub').allInnerTexts()) expect(s).toContain('支援者');
  await page.locator('.f-head [data-act="reset"]').click();
  await expect(names).toHaveCount(all);
  await page.locator('label:has(input[name="types"][value="Dragon"])').click();
  await page.locator('select[name="format"]').selectOption('standard');
  await expect(page.locator('.lib-card .legal-badge.no', { hasText: '标准' })).toHaveCount(0);
  await expect(names).toContainText(['多龙巴鲁托ex']);
  // The card view: the card face text.
  await page.locator('.lib-card[data-id="zh-Hans:CSV8C:159/207"] .lib-img').click();
  await expect(page.locator('.card-detail h2')).toHaveText('多龙巴鲁托ex');
  await expect(page.locator('.card-detail')).toContainText('幻影潜袭');
  await expect(page.locator('.card-detail')).toContainText('可以用于对战');
  await page.keyboard.press('Escape');
  await expect(page.locator('.card-detail')).toHaveCount(0);
  // Cards whose rules are not implemented yet are marked, and say so.
  await page.locator('.f-head [data-act="reset"]').click();
  await page.locator('label:has(input[name="play"][value="no"])').click();
  await expect(page.locator('.lib-card')).not.toHaveCount(0);
  await expect(page.locator('.lib-card:not(:has(.impl-badge))')).toHaveCount(0);
  await page.locator('input[name="name"]').fill('光辉喷火龙');
  await expect(names).toHaveText(['光辉喷火龙']);
  await page.locator('.lib-card .lib-img').click();
  await expect(page.locator('.card-detail')).toContainText('对战规则还没有实现');
  await page.keyboard.press('Escape');

  // 我的卡组: start from a preconstructed list, break it, fix it, save it.
  await page.locator('#site-nav a', { hasText: '我的卡组' }).click();
  await expect(page.locator('.my-decks')).toContainText('还没有保存的卡组');
  await page.locator('#preset').selectOption('raging-bolt-679141');
  await page.locator('#from-preset').click();
  await expect(page.locator('#ed-count')).toHaveText('60 / 60 张');
  await expect(page.locator('#ed-check')).toContainText('符合标准赛构筑规则');
  const bolt = page.locator('.ed-row', { hasText: '猛雷鼓ex' });
  await expect(bolt.locator('.ed-ctl b')).toHaveText('3');
  await bolt.locator('[data-act="remove"]').click();
  await expect(page.locator('#ed-count')).toHaveText('59 / 60 张');
  await expect(page.locator('#ed-check')).toContainText('卡组需要正好 60 张卡，现在是 59 张。');
  await page.locator('#ed-name').fill('我的猛雷鼓');
  await page.locator('#ed-save').click();
  await expect(page.locator('#ed-msg')).toHaveText('已保存（还不能对战）。');
  await expect(page).toHaveURL(/decks\.html\?id=\d+$/);
  await expect(page.locator('#ed-play')).toBeHidden();
  // Add it back from the library side; at 60 cards nothing more can be added.
  await page.locator('input[name="name"]').fill('猛雷鼓ex');
  const tile = page.locator('.lib-card[data-id="zh-Hans:CSV7C:154/204"]');
  await tile.locator('[data-act="add"]').click();
  await expect(tile.locator('.lib-n')).toHaveText('3');
  await expect(tile.locator('[data-act="add"]')).toBeDisabled();
  await expect(page.locator('#ed-check')).toContainText('可以对战');
  // A card not implemented yet makes the list unplayable until it is taken out again. (The builder shows the cards of
  // the deck's format: 阿罗拉 六尾V, Open only, is not offered for this Standard deck.)
  await tile.locator('[data-act="remove"]').click();
  await page.locator('input[name="name"]').fill('阿罗拉 六尾V');
  await expect(page.locator('.lib-empty')).toHaveText('没有符合条件的卡牌。');
  await page.locator('input[name="name"]').fill('暗码迷的解读');
  await page.locator('.lib-card', { hasText: '暗码迷的解读' }).locator('[data-act="add"]').click();
  await expect(page.locator('#ed-check')).toContainText('「暗码迷的解读」还没有实现对战规则');
  await expect(page.locator('.ed-row', { hasText: '暗码迷的解读' }).locator('.impl-badge')).toHaveText('未实现');
  await page.locator('.ed-row', { hasText: '暗码迷的解读' }).locator('[data-act="remove"]').click();
  await page.locator('input[name="name"]').fill('猛雷鼓ex');
  await tile.locator('[data-act="add"]').click();
  await expect(page.locator('#ed-check')).toContainText('可以对战');
  await page.locator('#ed-save').click();
  await expect(page.locator('#ed-msg')).toHaveText('已保存，可以对战。');

  // 去对战: the table opens with the deck picked, under 我的卡组, and starts a game with it.
  await page.locator('#ed-play').click();
  await expect(page).toHaveURL(/\/play\/\?deck=user%3A\d+$|\/play\/\?deck=user:\d+$/);
  const id = new URL(page.url()).searchParams.get('deck');
  await expect(page.locator(`.deck.sel[data-deck="${id}"]`)).toContainText('我的猛雷鼓');
  await expect(page.locator('#deck-choices .deck-section').first()).toContainText('我的卡组');
  await expect(page.locator('#deck-source')).toContainText('「我的猛雷鼓」是你保存的卡组。');
  await expect(page.locator('#match-you')).toContainText('我的猛雷鼓');
  await page.locator('#btn-start').click();
  await expect(page.locator('#log')).toContainText('你使用我的猛雷鼓');

  // Signing out (here from the card library; the opening's 猜拳 covers the table) leads back to the login page,
  // and the site stays closed.
  await page.goto('/play/cards.html');
  await page.locator('#site-nav .user-btn').click();
  await page.locator('#site-nav [data-act="logout"]').click();
  await expect(page).toHaveURL(/\/play\/login\.html$/);
  await page.goto('/play/decks.html');
  await expect(page).toHaveURL(/\/play\/login\.html\?next=/);
  expect(errors).toEqual([]);
});

test('the administrator manages users in 用户管理; players have no access', async ({ page, browser, baseURL }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const other = await request.newContext({ baseURL });
  await other.post('/api/auth/register', { data: { username: 'throwaway', password: 'throw-away-1' } });

  await page.goto('/play/admin.html');
  await signIn(page, ADMIN.username, ADMIN.password);
  await expect(page).toHaveURL(/\/play\/admin\.html$/);
  await expect(page.locator('#site-nav .role-tag')).toHaveText('管理员');
  const row = (name) => page.locator('table.users tr', { has: page.locator('td b', { hasText: new RegExp(`^${name}$`) }) });
  await expect(row('admin')).toContainText('（你）');
  await expect(row('admin').locator('[data-act="delete"]')).toBeDisabled();
  await expect(row('tester')).toBeVisible();

  await row('throwaway').locator('[data-act="role"]').selectOption('admin');
  await expect(row('throwaway').locator('[data-act="role"]')).toHaveValue('admin');
  await row('throwaway').locator('[data-act="role"]').selectOption('user');
  await expect(row('throwaway').locator('[data-act="role"]')).toHaveValue('user');

  // A reset password signs the user out; the new one works.
  await row('throwaway').locator('[data-act="password"]').click();
  await page.locator('.acct-dialog input[name="password"]').fill('new-throw-1');
  await page.locator('.acct-dialog button[type="submit"]').click();
  await expect(page.locator('.acct-dialog')).toHaveCount(0);
  expect((await other.get('/api/auth/me')).status()).toBe(401);
  expect((await other.post('/api/auth/login', { data: { username: 'throwaway', password: 'new-throw-1' } })).status()).toBe(200);

  await row('throwaway').locator('[data-act="delete"]').click();
  await page.locator('.acct-dialog [data-act="yes"]').click();
  await expect(row('throwaway')).toHaveCount(0);
  expect((await other.get('/api/auth/me')).status()).toBe(401);
  await other.dispose();

  // A player sees no 用户管理 and the page refuses them.
  const player = await browser.newContext({ storageState: PLAYER_STATE, baseURL });
  const p = await player.newPage();
  await p.goto('/play/admin.html');
  await expect(p.locator('#admin')).toHaveText('只有管理员可以访问这个页面。');
  await expect(p.locator('#site-nav')).not.toContainText('用户管理');
  await player.close();
  expect(errors).toEqual([]);
});
