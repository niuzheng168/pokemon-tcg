// CN/V20261019 official-rules mode: a complete game against the CPU with the
// reviewed Simplified-Chinese 嗨皮组合 皮卡丘卡组, driven through the real page.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const SAVE_KEY = 'pokemon-tcg:cn-official:V20261019:save';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

async function answerPrompts(page) {
  const prompt = page.locator('#cn-prompt');
  for (let i = 0; i < 20 && await prompt.isVisible(); i++) {
    const confirm = prompt.locator('#cn-confirm');
    if (await confirm.count()) await confirm.click();
    else await prompt.locator('.cn-option').first().click();
    await page.waitForTimeout(100);
  }
}

test('the start screen links to an isolated CN official mode that plays a full game against the CPU', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/');
  const link = page.locator('#start-cn-official');
  await expect(link).toHaveAttribute('href', 'cn/');
  await link.click();
  await expect(page).toHaveURL(/\/play\/cn\/$/);
  await expect(page.locator('#cn-start-btn')).toBeEnabled();
  await expect(page.locator('#cn-deck-me')).toContainText('嗨皮组合 皮卡丘卡组');
  await expect(page.locator('#cn-deck-info')).toContainText('简中官方商品页');

  await page.goto('/play/cn/?seed=11,22,33,44&speed=fast');
  await page.locator('#cn-start-btn').click();
  await expect(page.locator('#cn-board')).toBeVisible();
  await expect(page.locator('#cn-mid')).toContainText('规则版本 CN/V20261019');

  // Setup by hand: decision, Active and Bench prompts are answered in the page.
  await expect(page.locator('#cn-prompt h2')).toBeVisible();
  for (let i = 0; i < 30 && !(await page.locator('#cn-actions button').count()); i++) {
    await answerPrompts(page);
    await page.waitForTimeout(200);
  }
  // First own main phase: the hand is Chinese and every action comes from the engine.
  await expect(page.locator('#cn-hand .cn-card').first()).toBeVisible();
  const handText = await page.locator('#cn-hand').innerText();
  expect(handText).toMatch(/皮卡丘ex|灯笼鱼|咩利羊|电飞鼠|雷电云|捷拉奥拉|聒噪鸟|基本雷能量|球|鞋|研究|妮莫|裁判|短裤小子|决心|器|交替|头带|输送/);
  await page.locator('#cn-hand .cn-card').first().click();
  await expect(page.locator('#cn-detail h3')).not.toBeEmpty();
  const attach = page.locator('#cn-actions button[data-type="attachEnergy"]').first();
  if (await attach.count()) {
    await attach.click();
    await answerPrompts(page);
  }
  await expect(page.locator('#cn-actions button[data-type="endTurn"]')).toBeVisible();
  await page.locator('#cn-actions button[data-type="endTurn"]').click();
  await answerPrompts(page);

  // The CPU plays its turn from its own player view; then a reload resumes the
  // saved official game from its separate storage key.
  await expect.poll(async () => {
    await answerPrompts(page); // e.g. promoting after the CPU's Knock Out
    return (await page.locator('#cn-log').innerText()).includes('对手的回合结束');
  }, { timeout: 60_000 }).toBe(true);
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SAVE_KEY);
  expect(saved.releaseId).toBe('cn-v20261019-reviewed-pool');
  expect(saved.snapshot.ruleset).toEqual({ region: 'CN', version: 'V20261019' });
  expect(saved.snapshot.format).toEqual({ region: 'CN', version: 'V20261019', id: 'open' });
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => k.includes('cn-official'))).toEqual([SAVE_KEY]);
  const turnBefore = await page.evaluate(() => window.__cnOfficial.view().turn);
  await page.reload();
  await expect(page.locator('#cn-resume-btn')).toBeVisible();
  await page.locator('#cn-resume-btn').click();
  await expect(page.locator('#cn-board')).toBeVisible();
  expect(await page.evaluate(() => window.__cnOfficial.view().turn)).toBeGreaterThanOrEqual(turnBefore);

  // Finish the game with the CPU playing both sides through the same UI loop.
  await page.locator('#cn-auto').check();
  await expect(page.locator('#cn-result')).toBeVisible({ timeout: 200_000 });
  await expect(page.locator('#cn-result-title')).toHaveText(/你获胜了！|对手获胜|平局/);
  const result = await page.evaluate(() => window.__cnOfficial.view().result);
  expect(['ordinary', 'deckout', 'simultaneous']).toContain(result.reason);
  expect(await page.locator('#cn-log li').count()).toBeGreaterThan(20);
  expect(await page.evaluate((key) => localStorage.getItem(key), SAVE_KEY)).toBeNull();
  expect(errors).toEqual([]);
});

test('the 猛雷鼓ex tournament deck (Standard) plays a full game against the CPU with its recorded source', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/cn/?seed=5,6,7,8&speed=fast');
  await expect(page.locator('#cn-start-btn')).toBeEnabled();
  await page.locator('#cn-deck-me').selectOption('raging-bolt-679141');
  await page.locator('#cn-deck-opp').selectOption('raging-bolt-679141');
  await expect(page.locator('#cn-deck-info')).toContainText('2026城市赛第四赛季');
  await expect(page.locator('#cn-deck-info')).toContainText('标准赛制');
  await expect(page.locator('#cn-deck-info a')).toHaveAttribute('href', 'https://omnitcg.top/api/v1/jz/deck/679141');
  await page.locator('#cn-start-btn').click();
  await expect(page.locator('#cn-board')).toBeVisible();
  await expect(page.locator('#cn-mid')).toContainText('标准赛制');
  for (let i = 0; i < 30 && !(await page.locator('#cn-actions button').count()); i++) {
    await answerPrompts(page);
    await page.waitForTimeout(200);
  }
  await expect(page.locator('#cn-hand .cn-card').first()).toBeVisible();
  const handText = await page.locator('#cn-hand').innerText();
  expect(handText).toMatch(/猛雷鼓|厄诡椪|梦幻|怒鹦哥|铁斑叶|古剑豹|吉雉鸡|拉帝亚斯|爬地翅|百变怪|球|容器|担架|宝可装置|手册|回收|捕捉器|奥琳|赤松|老大|裁判|空洞|能量/);
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SAVE_KEY);
  expect(saved.snapshot.format).toEqual({ region: 'CN', version: 'V20261019', id: 'standard' });
  await page.locator('#cn-auto').check();
  await expect(page.locator('#cn-result')).toBeVisible({ timeout: 280_000 });
  await expect(page.locator('#cn-result-title')).toHaveText(/你获胜了！|对手获胜|平局/);
  const result = await page.evaluate(() => window.__cnOfficial.view().result);
  expect(['ordinary', 'deckout', 'simultaneous']).toContain(result.reason);
  const log = await page.locator('#cn-log').innerText();
  expect(log).toMatch(/猛雷鼓ex|厄诡椪 碧草面具ex/);
  expect(errors).toEqual([]);
});

test('the 多龙巴鲁托ex tournament deck (Standard) plays a full game against the CPU with its recorded source', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/cn/?seed=9,8,7,6&speed=fast');
  await expect(page.locator('#cn-start-btn')).toBeEnabled();
  await page.locator('#cn-deck-me').selectOption('dragapult-676815');
  await page.locator('#cn-deck-opp').selectOption('raging-bolt-679141');
  await expect(page.locator('#cn-deck-info')).toContainText('梦回伊甸岗顶店');
  await expect(page.locator('#cn-deck-info a')).toHaveAttribute('href', 'https://omnitcg.top/api/v1/jz/deck/676815');
  await page.locator('#cn-start-btn').click();
  await expect(page.locator('#cn-board')).toBeVisible();
  await page.locator('#cn-auto').check();
  await expect(page.locator('#cn-result')).toBeVisible({ timeout: 280_000 });
  await expect(page.locator('#cn-result-title')).toHaveText(/你获胜了！|对手获胜|平局/);
  const result = await page.evaluate(() => window.__cnOfficial.view().result);
  expect(['ordinary', 'deckout', 'simultaneous']).toContain(result.reason);
  expect(await page.locator('#cn-log').innerText()).toMatch(/多龙|夜巡灵|彷徨夜灵|黑夜魔灵|含羞苞|愿增猿|摔角鹰人|月月熊|谢米/);
  expect(errors).toEqual([]);
});

test('幻影潜袭 lets the player place its 6 damage counters in any way through the allocation prompt', async ({ page }) => {
  // A real reviewed game, rearranged exactly like the real-card tests, then resumed in the page. It runs
  // in a plain Node process: the release pins handler sources, which the test runner's transform would change.
  const script = `
    import { reviewed, board, DRAGAPULT, STANDARD_FORMAT } from './tests/cn-cards/helpers.mjs';
    import { CN_RELEASE_ID } from './public/cn/trusted-releases.js';
    const ctx = await reviewed([1, 2, 3, 4], [DRAGAPULT, DRAGAPULT], STANDARD_FORMAT);
    const ids = {};
    const g = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
      const active = s.players[0].active;
      h.evolve(0, active, 'drakloak'); h.evolve(0, active, 'dragapult-ex');
      h.attach(0, active, 'basic-fire-energy', 'basic-psychic-energy');
      ids.a = h.bench(1, 'duskull').id; ids.b = h.bench(1, 'hawlucha').id;
    });
    console.log(JSON.stringify({ ids, saved: { releaseId: CN_RELEASE_ID, decks: ['dragapult-676815', 'dragapult-676815'], snapshot: g.snapshot() } }));`;
  const { ids, saved } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(([key, value]) => { if (!sessionStorage.getItem('seeded')) {
    localStorage.setItem(key, value); sessionStorage.setItem('seeded', '1'); } }, [SAVE_KEY, JSON.stringify(saved)]);
  await page.goto('/play/cn/?speed=fast');
  await page.locator('#cn-resume-btn').click();
  await page.locator('#cn-actions button', { hasText: '幻影潜袭' }).click();
  const prompt = page.locator('#cn-prompt');
  await expect(prompt.locator('h2')).toHaveText('以任意方式分配伤害指示物');
  await expect(prompt.locator('#cn-confirm')).toBeDisabled();
  const plus = (id) => prompt.locator(`.cn-allocation[data-option="${id}"] button`).last();
  for (let i = 0; i < 4; i++) await plus(ids.a).click();
  for (let i = 0; i < 2; i++) await plus(ids.b).click();
  await expect(prompt.locator('#cn-confirm')).toHaveText('确认（已放置6/6）');
  await prompt.locator('#cn-confirm').click();
  await answerPrompts(page);
  const view = await page.evaluate(() => window.__cnOfficial.view(1));
  const counters = Object.fromEntries([view.players[1].active, ...view.players[1].bench].map((m) => [m.id, m.counters]));
  expect([counters[ids.a], counters[ids.b]]).toEqual([4, 2]);
  await expect(page.locator('#cn-log')).toContainText('被放置了4个伤害指示物');
  expect(errors).toEqual([]);
});
