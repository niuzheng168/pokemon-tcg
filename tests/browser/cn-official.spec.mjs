// The table (public/index.html + ui.js) on games played on the server with the CN/V20261019 official kernel: complete
// games against the CPU with the reviewed Simplified-Chinese decks, driven through the real page — the opening (猜拳 or
// 掷硬币), the setup stages, moves by button and by drag and drop, choices, reloading, and 自动代打.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { abandonCurrent, gameAt } from './server-games.mjs';

// Each player's table keeps its log under its own key (tests/browser/auth.setup.mjs signs in the player).
const saveKey = async (page) => `cn-table-save-v3:${(await (await page.request.get('/api/auth/me')).json()).user.id}`;

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await abandonCurrent(page);
});

const shown = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const tap = (locator) => locator.click({ timeout: 3000 }).catch(() => {});

// Answers whatever the table is asking that is not a move: the opening, the setup stages, Prize cards and choices.
async function answer(page) {
  if (await shown(page, '.rps-pick')) return tap(page.locator('.rps-pick').first()).then(() => true);
  if (await shown(page, '.rps-btn')) return tap(page.locator('.rps-btn').first()).then(() => true);
  if (await shown(page, '.call-btn')) return tap(page.locator('.call-btn').first()).then(() => true);
  if (await shown(page, '.cs-continue:not([hidden])')) return tap(page.locator('.cs-continue:not([hidden])').first()).then(() => true);
  if (await shown(page, '.setup-ov.st-active:not(.picked) .st-card')) return tap(page.locator('.setup-ov.st-active .st-card').first()).then(() => true);
  if (await shown(page, '.setup-ov.st-bench:not(.done) .st-ok')) return tap(page.locator('.setup-ov.st-bench .st-ok')).then(() => true);
  if (await shown(page, '.prize-ov:not(.setup-ov):not(.picked) .pz-card')) return tap(page.locator('.prize-ov:not(.picked) .pz-card').first()).then(() => true);
  if (await shown(page, '#modal:not([hidden]) .alloc')) {
    for (let i = 0; i < 40 && await page.locator('#choice-ok').isDisabled(); i++) await tap(page.locator('#modal .alloc .step[data-d="1"]').first());
    return tap(page.locator('#choice-ok')).then(() => true);
  }
  if (await shown(page, '#modal:not([hidden]) .dialog.sheet [data-id]')) {
    const options = page.locator('#modal-body [data-id]');
    await tap(options.first());
    if (await page.locator('#choice-ok').count()) {
      for (let i = 1; i < 8 && await page.locator('#choice-ok').isDisabled().catch(() => false); i++) await tap(options.nth(i));
      // Picks that still cannot be confirmed: choose none, where that is allowed.
      const stuck = await page.locator('#choice-ok').isDisabled().catch(() => false) && await page.locator('#choice-none').count();
      await tap(page.locator(stuck ? '#choice-none' : '#choice-ok'));
    }
    return true;
  }
  return false;
}

async function untilYourMove(page) {
  for (let i = 0; i < 600; i++) {
    if (await shown(page, 'body.your-move') || await shown(page, '#end-slot .k-end')) return;
    if (!(await answer(page))) await page.waitForTimeout(100);
  }
  throw new Error('the table never offered a move');
}

async function untilOver(page, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await shown(page, '.over-title')) return;
    if (!(await answer(page))) await page.waitForTimeout(250);
  }
  throw new Error('the game did not finish');
}

// A move made on the table: click its card, then the move in the menu that opens beside it.
async function move(page, card, text) {
  await page.locator(card).first().click();
  await page.locator('.act-menu .act', { hasText: text }).click();
}
// A hand card by its kernel instance id (match.js uidOf).
const handCard = (iid) => { const [, p, c] = /^p(\d)c(\d+)$/.exec(iid); return `#hand .hcard[data-card="${Number(p) * 100 + Number(c) + 1}"]`; };

async function autoPlay(page) {
  await page.locator('#btn-settings').click();
  await page.locator('#opt-auto').check();
  await page.locator('#settings-close').click();
}

test('the site opens the table, which plays a full game by hand, saves, resumes and finishes with 自动代打, recorded and replayed', async ({ page }) => {
  test.setTimeout(540_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const entry of ['/', '/play/cn/']) {
    await page.goto(entry);
    await expect(page).toHaveURL(/\/play\/$/);
  }
  await expect(page.locator('.deck')).toHaveCount(25); // the release's decks: products, tournament lists, starters
  await expect(page.locator('#deck-choices')).toContainText('嗨皮组合 皮卡丘卡组');
  await expect(page.locator('#deck-choices')).toContainText('开放赛');
  // The rules page shows damage as the official 10 / 50 / 100 markers, split like the official example
  // (60 = 50 + 10, so 80 = 50 + 10 + 10 + 10).
  await page.locator('#start-rules').click();
  await expect(page.locator('#rules-body .dc-combo')).toContainText('= 50 + 10 + 10 + 10 = 80');
  await expect(page.locator('#rules-body')).toContainText('1 个“50”加 1 个“10”');
  await page.locator('#rules-close').click();

  await page.goto('/play/?seed=11,22,33,44&speed=fast');
  await page.locator('.deck[data-deck="csvh1c-pikachu"]').click();
  await expect(page.locator('#deck-source')).toContainText('简体中文官方商品页');
  await page.locator('#opt-opp').selectOption('raging-bolt-679141');
  await page.locator('#btn-start').click();
  await expect(page.locator('#table')).toBeVisible();

  // The opening is rock-paper-scissors by default; then the setup stages, answered by hand.
  await expect(page.locator('.rps-pick').first()).toBeVisible();
  await untilYourMove(page);
  await expect(page.locator('#turn-info')).toContainText('开放赛');
  await expect(page.locator('#btn-debug')).toHaveCount(0); // the 调试台 is for administrators only
  await expect(page.locator('#log')).toContainText(/获得了决定先攻后攻的权利/);
  const hand = await page.locator('#hand .hcard img').evaluateAll((els) => els.map((e) => e.alt).join(' '));
  expect(hand).toMatch(/皮卡丘ex|灯笼鱼|咩利羊|电飞鼠|雷电云|捷拉奥拉|聒噪鸟|基本雷能量|球|鞋|研究|妮莫|裁判|短裤小子|决心|器|交替|头带|输送/);

  // Hovering a card explains it from its printed text.
  await page.locator('#hand .hcard').first().hover();
  await expect(page.locator('#preview .pv-name')).not.toBeEmpty();
  await expect(page.locator('#preview .image-language')).toContainText(/CSVH1C|CSV\d+C|SV/);

  // Drag and drop: a playable hand card dropped where it lights up makes that move.
  const playable = page.locator('#hand .hcard:not(.unplayable)');
  if (await playable.count()) {
    const before = (await page.locator('#log').innerText()).length;
    const box = await playable.first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y - 40, { steps: 4 });
    const zone = await page.locator('.drop-ok').first().boundingBox();
    await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, { steps: 6 });
    await page.mouse.up();
    if (await shown(page, '.act-menu .act')) await page.locator('.act-menu .act').first().click();
    await expect.poll(async () => (await page.locator('#log').innerText()).length).toBeGreaterThan(before);
    await untilYourMove(page);
  }
  // An Energy attached from its card's menu can be taken back while nothing new was revealed.
  const attach = (await page.evaluate(() => window.__cnTable.view().legalActions)).find((a) => a.type === 'attachEnergy');
  if (attach) {
    await page.locator(handCard(attach.cardId)).click();
    await page.locator('.act-menu .act[data-kind="energy"]').first().click();
    await untilYourMove(page);
    await expect(page.locator('#undo-btn')).toBeVisible();
  }
  // Ending the turn is a button on the table, in the bar between the two mats.
  await expect(page.locator('#board #midbar #end-slot .k-end')).toHaveText('结束回合');
  await page.locator('#end-slot .k-end').click();

  // Gary plays his turn on the server; a reload picks the game up again from there.
  await expect.poll(async () => {
    await answer(page); // e.g. promoting after a Knock Out
    return (await page.locator('#log').innerText()).includes('小茂的回合结束');
  }, { timeout: 60_000 }).toBe(true);
  await untilYourMove(page);
  // The browser keeps the table's log only: the game, its decks' order and its seed stay on the server.
  const id = await page.evaluate(() => window.__cnTable.matchId());
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), await saveKey(page));
  expect(Object.keys(saved).sort()).toEqual(['coach', 'log', 'matchId', 'releaseId']);
  expect([saved.releaseId, saved.matchId]).toEqual(['cn-v20261019-mixed-pool-v2', id]);
  const during = (await (await page.request.get(`/api/matches/${id}`)).json()).match;
  expect(during.setup.seed).toBeNull();
  expect(during.setup.format).toEqual({ region: 'CN', version: 'V20261019', id: 'open' });
  expect(during.setup.decks.map((d) => d.id)).toEqual(['csvh1c-pikachu', 'raging-bolt-679141']);
  const turnBefore = await page.evaluate(() => window.__cnTable.view().turn);
  await page.reload();
  await expect(page.locator('#table')).toBeVisible();
  await expect(page.locator('#log')).toContainText('已恢复服务器上的对局');
  expect(await page.evaluate(() => window.__cnTable.view().turn)).toBeGreaterThanOrEqual(turnBefore);
  // With nothing kept in the browser (another browser, say) the game picks up all the same, at the same move.
  await untilYourMove(page);
  const before = await page.evaluate((k) => { localStorage.removeItem(k); return window.__cnTable.view(); }, await saveKey(page));
  await page.reload();
  await expect(page.locator('#log')).toContainText('已恢复服务器上的对局');
  const after = await page.evaluate(() => window.__cnTable.view());
  expect(after.revision).toBe(before.revision);
  expect(after.players).toEqual(before.players);

  // 自动代打: the CPU engine finishes the game for you through the same table.
  await autoPlay(page);
  await untilOver(page, 240_000);
  await expect(page.locator('.over-title')).toHaveText(/你赢了！|小茂获胜|平局！/);
  const result = await page.evaluate(() => window.__cnTable.view().result);
  expect(['ordinary', 'deckout', 'simultaneous']).toContain(result.reason);
  expect(await page.locator('#log > div').count()).toBeGreaterThan(20);
  expect(await page.evaluate((key) => localStorage.getItem(key), await saveKey(page))).toBeNull();

  // The game is recorded on the server under the number the table shows; 对局记录 lists it and its replay reaches the
  // same result with every recorded state matching.
  expect(await page.evaluate(() => window.__cnTable.matchId())).toBe(id);
  await expect(page.locator('.over-match')).toContainText(`#${id}`);
  const record = async () => (await page.request.get(`/api/matches/${id}`)).json();
  await expect.poll(async () => (await record()).match.status).toBe('over');
  const { match, steps } = await record();
  expect(match.setup.decks.map((d) => d.id)).toEqual(['csvh1c-pikachu', 'raging-bolt-679141']);
  expect(match.setup.seed).toEqual([11, 22, 33, 44]);
  expect(match.result).toEqual(result);
  expect(steps.filter((s) => s.type === 'action').length).toBeGreaterThan(20);
  expect(new Set(steps.filter((s) => s.type === 'action').map((s) => s.player))).toEqual(new Set([0, 1]));
  expect(steps.at(-1).type).toBe('end');
  await page.goto('/play/matches.html');
  await expect(page.locator('#matches table')).toContainText(`#${id}`);
  await expect(page.locator(`#matches a[href="./?replay=${id}"]`)).toBeVisible();
  await page.goto(`/play/?replay=${id}&speed=fast`);
  await expect(page.locator('#hint .rp-title')).toHaveText(`回放 · 对局 #${id}`);
  await expect(page.locator('#log')).toContainText('回放结束', { timeout: 240_000 });
  await expect(page.locator('#log')).not.toContainText('不一致');
  expect(await page.evaluate(() => window.__cnTable.view().result)).toEqual(result);
  expect(await page.evaluate((key) => localStorage.getItem(key), await saveKey(page))).toBeNull();
  expect(errors).toEqual([]);
});

test('the 猛雷鼓ex tournament deck (Standard) opens with a coin toss and plays a full game with its recorded source', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/?seed=5,6,7,8&speed=fast');
  // Settings open from the start bar (更换 next to the engine); the opening is picked there.
  await page.locator('#start-engine-change').click();
  await page.locator('label:has(input[name="opening"][value="coin"])').click();
  await expect(page.locator('input[name="opening"][value="coin"]')).toBeChecked();
  await page.locator('#settings-close').click();
  await page.locator('.deck[data-deck="raging-bolt-679141"]').click();
  await expect(page.locator('#deck-source')).toContainText('2026城市赛第四赛季');
  await expect(page.locator('#deck-source a')).toHaveAttribute('href', 'https://omnitcg.top/api/v1/jz/deck/679141');
  await page.locator('#opt-opp').selectOption('dragapult-676815');
  await page.locator('#btn-start').click();
  await expect(page.locator('.call-btn').first()).toBeVisible();
  await untilYourMove(page);
  await expect(page.locator('#turn-info')).toContainText('标准赛');
  const id = await page.evaluate(() => window.__cnTable.matchId());
  const { match } = await (await page.request.get(`/api/matches/${id}`)).json();
  expect(match.setup.format).toEqual({ region: 'CN', version: 'V20261019', id: 'standard' });
  await autoPlay(page);
  await untilOver(page, 260_000);
  const log = await page.locator('#log').innerText();
  expect(log).toMatch(/猛雷鼓ex|厄诡椪 碧草面具ex/);
  expect(log).toMatch(/多龙|夜巡灵|彷徨夜灵|黑夜魔灵|含羞苞|愿增猿|摔角鹰人|月月熊|谢米/);
  expect(errors).toEqual([]);
});

test('the 多龙巴鲁托ex deck plays a full game on 自动代打 from the start (?auto=1)', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/?seed=9,8,7,6&speed=fast&auto=1');
  await page.locator('.deck[data-deck="dragapult-676815"]').click();
  await expect(page.locator('#deck-source a')).toHaveAttribute('href', 'https://omnitcg.top/api/v1/jz/deck/676815');
  await page.locator('#btn-start').click();
  await expect(page.locator('#log')).toContainText('双方将牌库洗匀');
  await untilOver(page, 280_000);
  const result = await page.evaluate(() => window.__cnTable.view().result);
  expect(['ordinary', 'deckout', 'simultaneous']).toContain(result.reason);

  // ?seed= fixed that game only: the next game in the same page is shuffled from a new random seed.
  expect(new URL(page.url()).searchParams.get('seed')).toBeNull();
  const first = await page.evaluate(() => window.__cnTable.matchId());
  await page.locator('#over-new').click();
  await page.locator('.deck[data-deck="dragapult-676815"]').click();
  await page.locator('#btn-start').click();
  await expect.poll(() => page.evaluate(() => window.__cnTable.matchId())).not.toBe(first);
  const second = await page.evaluate(() => window.__cnTable.matchId());
  const seed = async (id) => (await (await page.request.get(`/api/matches/${id}`)).json()).match.setup.seed;
  expect(await seed(first)).toEqual([9, 8, 7, 6]);
  expect(await seed(second)).toBeNull(); // still being played: its seed stays on the server
  await page.locator('#btn-new').click();
  await page.locator('#new-ok').click();
  await expect(page.locator('#start')).toBeVisible();
  await expect.poll(async () => seed(second)).not.toBeNull();
  expect(await seed(second)).not.toEqual([9, 8, 7, 6]);
  expect(errors).toEqual([]);
});

test('幻影潜袭 lets the player place its 6 damage counters in any way', async ({ page, baseURL }) => {
  // A real reviewed game, rearranged exactly like the real-card tests, put on the server as the player's game and
  // picked up by the page. It runs in a plain Node process: the release pins handler sources, which the test runner's
  // transform would change.
  const script = `
    import { reviewed, board, DRAGAPULT, STANDARD_FORMAT } from './tests/cn-cards/helpers.mjs';
    const ctx = await reviewed([1, 2, 3, 4], [DRAGAPULT, DRAGAPULT], STANDARD_FORMAT);
    const ids = {};
    const g = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
      const active = s.players[0].active;
      h.evolve(0, active, 'drakloak'); h.evolve(0, active, 'dragapult-ex');
      h.attach(0, active, 'basic-fire-energy', 'basic-psychic-energy');
      ids.a = h.bench(1, 'duskull').id; ids.b = h.bench(1, 'hawlucha').id;
    });
    console.log(JSON.stringify({ ids, snapshot: g.snapshot() }));`;
  const { ids, snapshot } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await gameAt(page, baseURL, { deck: 'dragapult-676815', snapshot });
  await page.goto('/play/?speed=fast');
  await expect(page.locator('#table')).toBeVisible();
  await move(page, '#you-active .mon', '幻影潜袭');
  const sheet = page.locator('#modal-body');
  await expect(sheet.locator('h2')).toHaveText('以任意方式放置伤害指示物');
  await expect(sheet.locator('#choice-ok')).toBeDisabled();
  const plus = (id) => sheet.locator(`.alloc[data-option="${id}"] .step[data-d="1"]`);
  for (let i = 0; i < 4; i++) await plus(ids.a).click();
  for (let i = 0; i < 2; i++) await plus(ids.b).click();
  await expect(sheet.locator('#choice-ok')).toHaveText('确认放置（6/6）');
  await sheet.locator('#choice-ok').click();
  await expect.poll(async () => {
    const view = await page.evaluate(() => window.__cnTable.view());
    const counters = Object.fromEntries([view.players[1].active, ...view.players[1].bench].filter(Boolean).map((m) => [m.id, m.counters]));
    return [counters[ids.a], counters[ids.b]];
  }).toEqual([4, 2]);
  await expect(page.locator('#log')).toContainText('被放置了4个伤害指示物');
  // Damage shows as the official 10 / 50 / 100 markers by default: 40 damage is four “10”s.
  await expect(page.locator(`[data-mon="${Number(ids.a.slice(1))}"] .dice.markers .die.marker`)).toHaveText(['10', '10', '10', '10']);
  await expect(page.locator(`[data-mon="${Number(ids.a.slice(1))}"] .dice .dsum`)).toHaveCount(0); // no separate total
  expect(errors).toEqual([]);
});

test('碧草之舞: the confirm button needs a picked card, so a stray click cannot answer "none"; 不选择 is a button of its own', async ({ page, baseURL }) => {
  // Choosing none is allowed (II.E-33), and then nothing is attached or drawn (II.E-19). It used to be the confirm
  // button itself, labelled 不选择，继续 while nothing was picked.
  const script = `
    import { reviewed, board, BOLT, STANDARD_FORMAT } from './tests/cn-cards/helpers.mjs';
    const ctx = await reviewed([1, 2, 3, 4], [BOLT, BOLT], STANDARD_FORMAT);
    const ids = {};
    const g = board(ctx, ['teal-mask-ogerpon-ex', 'raging-bolt-ex'], (s, h) => { [ids.grass] = h.hand(0, 'basic-grass-energy'); });
    console.log(JSON.stringify({ ids, snapshot: g.snapshot() }));`;
  const { ids, snapshot } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await gameAt(page, baseURL, { deck: 'raging-bolt-679141', snapshot });
  await page.goto('/play/?speed=fast');
  await expect(page.locator('#table')).toBeVisible();
  await move(page, '#you-active .mon', '碧草之舞');
  const sheet = page.locator('#modal-body'), card = sheet.locator(`[data-id="${ids.grass}"]`);
  await expect(sheet.locator('h2')).toHaveText('选择手牌中的能量');
  await expect(sheet.locator('#choice-none')).toHaveText('不选择，继续');
  await expect(sheet.locator('#choice-ok')).toBeDisabled();
  await card.click();
  await card.click(); // picked, then unpicked
  await expect(sheet.locator('#choice-ok')).toBeDisabled();
  await expect(sheet.locator('.pick-mark')).toHaveCount(0);
  await card.click();
  await expect(card.locator('.pick-mark')).toHaveCount(1);
  await expect(sheet.locator('#choice-ok')).toHaveText('确认（已选 1 项）');
  await sheet.locator('#choice-ok').click();
  await expect.poll(async () => {
    const me = (await page.evaluate(() => window.__cnTable.view())).players[0];
    return [me.active.energy.map((c) => c.instanceId), me.hand.length];
  }).toEqual([[ids.grass], 1]);
  await expect(page.locator('#log')).toContainText('你抽了1张牌');
  expect(errors).toEqual([]);
});

test('巢穴球 searches the deck in one list: Basic Pokémon are picked there, another card says why not; both discard piles open their lists', async ({ page, baseURL }) => {
  const script = `
    import { reviewed, board, DECK } from './tests/cn-cards/helpers.mjs';
    const ctx = await reviewed([1, 2, 3, 4], [DECK, DECK]);
    const ids = {};
    const g = board(ctx, ['pikachu-ex', 'pikachu-ex'], (s, h) => { [ids.ball] = h.hand(0, 'nest-ball'); h.discard(1, 'basic-lightning-energy', 2); });
    console.log(JSON.stringify({ ids, snapshot: g.snapshot() }));`;
  const { snapshot } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await gameAt(page, baseURL, { deck: 'csvh1c-pikachu', snapshot });
  await page.goto('/play/?speed=fast');
  await expect(page.locator('#table')).toBeVisible();
  await expect(page.locator('#btn-tour')).toHaveCount(0); // no guided tour
  await move(page, '#hand .hcard:has(img[alt="巢穴球"])', '使用巢穴球');

  // The whole deck is one list: no separate row of looked-at cards above the options.
  const sheet = page.locator('#modal-body');
  await expect(sheet.locator('.choice-grid.inline')).toBeVisible();
  const { pending } = await page.evaluate(() => window.__cnTable.view());
  await expect(sheet.locator('.looked')).toHaveCount(0);
  await expect(sheet.locator('[data-id]')).toHaveCount(pending.options.length);
  await expect(sheet.locator('[data-blocked]')).toHaveCount(pending.lookedAt.length - pending.options.length);
  const other = sheet.locator('[data-blocked]').first();
  await other.hover();
  await expect(page.locator('#preview .why')).toContainText('只能选择基础宝可梦');
  await other.click();
  await expect(sheet.locator('.pick-note')).toHaveText(/只能选择基础宝可梦/);
  await expect(sheet.locator('#choice-ok')).toBeDisabled();
  const basic = sheet.locator('[data-id]').first(), name = await basic.locator('img').getAttribute('alt');
  await basic.click();
  await expect(sheet.locator('.pick-note')).toBeEmpty();
  await sheet.locator('#choice-ok').click();
  await expect(page.locator('#modal')).toBeHidden();
  await expect(page.locator('#you-bench .mon img.card-img').first()).toHaveAttribute('alt', name);

  // 巢穴球 is in your discard pile now: the pile opens its list; Escape closes it. The opponent's pile opens too.
  await page.locator('#you-piles .pile[data-pile="discard"]').click();
  await expect(sheet.locator('h2')).toHaveText('你的弃牌区（1张）');
  await expect(sheet.locator('.pile-list img')).toHaveAttribute('alt', '巢穴球');
  await page.keyboard.press('Escape');
  await expect(page.locator('#modal')).toBeHidden();
  await page.locator('#opp-piles .pile[data-pile="discard"]').click();
  await expect(sheet.locator('h2')).toHaveText('小茂的弃牌区（2张）');
  await expect(sheet.locator('.pile-list img')).toHaveCount(2);
  await sheet.locator('#pile-close').click();
  await expect(page.locator('#modal')).toBeHidden();
  expect(errors).toEqual([]);
});

test('赤松: where each chosen Energy goes names that Energy over the chosen cards, not the deck; the last one, with only the hand left, is not asked', async ({ page, baseURL }) => {
  // 问题报告 bug-20261026T123330Z-match-6: the destination choice showed the whole deck again and did not say which Energy it was for.
  const script = `
    import { reviewed, board, BOLT, STANDARD_FORMAT } from './tests/cn-cards/helpers.mjs';
    const ctx = await reviewed([1, 2, 3, 4], [BOLT, BOLT], STANDARD_FORMAT);
    const ids = {};
    const g = board(ctx, ['raging-bolt-ex', 'raging-bolt-ex'], (s, h) => {
      h.hand(0, 'crispin'); h.bench(0, 'slither-wing');
      const find = (key) => s.players[0].deck.find((id) => s.cards[id].definitionId === ctx.id[key]);
      ids.lightning = find('basic-lightning-energy'); ids.fighting = find('basic-fighting-energy'); ids.active = s.players[0].active.id;
    });
    console.log(JSON.stringify({ ids, snapshot: g.snapshot() }));`;
  const { ids, snapshot } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await gameAt(page, baseURL, { deck: 'raging-bolt-679141', snapshot });
  await page.goto('/play/?speed=fast');
  await expect(page.locator('#table')).toBeVisible();
  await move(page, '#hand .hcard:has(img[alt="赤松"])', '使用赤松');
  const sheet = page.locator('#modal-body');
  await sheet.locator(`[data-id="${ids.lightning}"]`).click();
  await sheet.locator(`[data-id="${ids.fighting}"]`).click();
  await sheet.locator('#choice-ok').click();

  await expect(sheet.locator('h2')).toHaveText('选择「基本雷能量」的去向');
  await expect(sheet.locator('.choice-grid.inline')).toHaveCount(0);
  await expect(sheet.locator('.looked img')).toHaveCount(2);
  await expect(sheet.locator('.looked .pick-card.sel img')).toHaveAttribute('alt', '基本雷能量');
  await expect(sheet.locator('.choice-words')).toHaveText('加入手牌');
  await sheet.locator(`[data-id="${ids.active}"]`).click();
  await expect(page.locator('#modal')).toBeHidden();
  await expect.poll(async () => {
    const me = (await page.evaluate(() => window.__cnTable.view())).players[0];
    return [me.active.energy.map((c) => c.instanceId), me.hand.some((c) => c.instanceId === ids.fighting)];
  }).toEqual([[ids.lightning], true]);
  await expect(page.locator('#log')).toContainText('你将「基本斗能量」加入手牌');
  expect(errors).toEqual([]);
});

test('Pokémon of the same name: the Pokémon to switch in say where they are and show their Energy; 极雷轰 says which Pokémon each Energy is on', async ({ page, baseURL }) => {
  // 问题报告 bug-20261029T120054Z-match-6: two 猛雷鼓ex and three 厄诡椪 碧草面具ex could not be told apart in the choices.
  const script = `
    import { reviewed, board, BOLT, STANDARD_FORMAT } from './tests/cn-cards/helpers.mjs';
    const ctx = await reviewed([1, 2, 3, 4], [BOLT, BOLT], STANDARD_FORMAT);
    const ids = {};
    const g = board(ctx, ['raging-bolt-ex', 'raging-bolt-ex'], (s, h) => {
      h.attach(0, s.players[0].active, 'basic-lightning-energy', 'basic-fighting-energy', 'basic-grass-energy');
      h.attach(0, h.bench(0, 'teal-mask-ogerpon-ex'), 'basic-grass-energy');
      const bolt = h.bench(0, 'raging-bolt-ex');
      [ids.lightning] = h.attach(0, bolt, 'basic-lightning-energy', 'basic-fighting-energy');
      ids.bolt = bolt.id;
      h.attach(0, h.bench(0, 'teal-mask-ogerpon-ex'), 'basic-grass-energy', 'basic-grass-energy');
    });
    console.log(JSON.stringify({ ids, snapshot: g.snapshot() }));`;
  const { ids, snapshot } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await gameAt(page, baseURL, { deck: 'raging-bolt-679141', snapshot });
  await page.goto('/play/?speed=fast');
  await expect(page.locator('#table')).toBeVisible();
  const sheet = page.locator('#modal-body');

  await move(page, '#you-active .mon', '撤退');
  await expect(sheet.locator('h2')).toHaveText('选择撤退时放于弃牌区的能量');
  await expect(sheet.locator('.where')).toHaveCount(0); // all on the Active: nothing to tell apart
  for (const b of await sheet.locator('[data-id]').all()) await b.click();
  await sheet.locator('#choice-ok').click();
  await expect(sheet.locator('h2')).toHaveText('选择换到战斗场的备战宝可梦');
  await expect(sheet.locator('[data-id] .where')).toHaveText(['我方备战1 · 210/210 HP', '我方备战2 · 240/240 HP', '我方备战3 · 210/210 HP']);
  await expect(sheet.locator('[data-id]').nth(1).locator('.pick-attached .ei')).toHaveCount(2);
  await expect(sheet.locator('[data-id]').nth(2).locator('.pick-attached .ei-Grass')).toHaveCount(2);
  await sheet.locator(`[data-id="${ids.bolt}"]`).click();
  await expect(page.locator('#modal')).toBeHidden();

  await move(page, '#you-active .mon', '极雷轰');
  await expect(sheet.locator('h2')).toHaveText('选择宝可梦身上的能量');
  // The Pokémon that retreated went to the end of the Bench.
  await expect(sheet.locator('[data-id] .where')).toHaveText(['我方战斗 猛雷鼓ex', '我方战斗 猛雷鼓ex', '我方备战1 厄诡椪 碧草面具ex',
    '我方备战2 厄诡椪 碧草面具ex', '我方备战2 厄诡椪 碧草面具ex']);
  await sheet.locator(`[data-id="${ids.lightning}"]`).click();
  await sheet.locator('#choice-ok').click();
  await expect(page.locator('#log')).toContainText('「基本雷能量」被放于弃牌区');
  expect(errors).toEqual([]);
});

test('every move is made on the table: menus of hand cards and their lit targets, the Active and its attacks, reasons, badges; the log is a column you open', async ({ page, baseURL }) => {
  const script = `
    import { reviewed, board, BOLT, STANDARD_FORMAT } from './tests/cn-cards/helpers.mjs';
    const ctx = await reviewed([1, 2, 3, 4], [BOLT, BOLT], STANDARD_FORMAT);
    const ids = {};
    const g = board(ctx, ['raging-bolt-ex', 'raging-bolt-ex'], (s, h) => {
      h.attach(0, s.players[0].active, 'basic-lightning-energy');
      ids.ogerpon = h.bench(0, 'teal-mask-ogerpon-ex').id;
      [ids.grass, ids.fighting] = h.hand(0, 'basic-grass-energy', 'basic-fighting-energy');
    });
    console.log(JSON.stringify({ ids, snapshot: g.snapshot() }));`;
  const { ids, snapshot } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await gameAt(page, baseURL, { deck: 'raging-bolt-679141', snapshot });
  await page.goto('/play/?speed=fast');
  await expect(page.locator('body.your-move')).toBeVisible();
  await expect(page.locator('#actions-panel, #actions')).toHaveCount(0); // no move list beside the board
  const active = page.locator('#you-active .mon'), ogerpon = page.locator('#you-bench .mon').first(), menu = page.locator('.act-menu');

  // Pokémon with moves glow and carry a badge per kind: the Active attacks, 厄诡椪 has 碧草之舞.
  await expect(active).toHaveClass(/can-act/);
  await expect(active.locator('.act-badges .ic-swords')).toHaveCount(1);
  await expect(ogerpon.locator('.act-badges .ic-sparkles')).toHaveCount(1);

  // The Active lists its attacks; one it cannot use yet is shown greyed out.
  await active.click();
  await expect(menu.locator('.am-title')).toHaveText('猛雷鼓ex');
  await expect(menu.locator('.act[data-kind="attack"]:not(.off)')).toHaveText([/飞溅咆哮/]);
  await expect(menu.locator('.act.off')).toHaveText(/极雷轰.*现在还不能使用/);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // A hand Energy: its menu names each Pokémon it can go on, and those Pokémon light up; clicking one attaches it there.
  await page.locator(handCard(ids.fighting)).click();
  await expect(menu.locator('.act[data-kind="energy"]')).toHaveCount(2);
  await expect(active).toHaveClass(/drop-ok/);
  await expect(ogerpon).toHaveClass(/drop-ok/);
  await active.click();
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => (await page.evaluate(() => window.__cnTable.view())).players[0].active.energy.map((c) => c.instanceId))
    .toContain(ids.fighting);
  await expect(active).not.toHaveClass(/drop-ok/);

  // A card that cannot be played now says why.
  await expect(page.locator(handCard(ids.grass))).toHaveClass(/unplayable/);
  await page.locator(handCard(ids.grass)).click();
  await expect(menu.locator('.am-note')).toContainText('这回合已经从手牌附着过能量');
  await expect(menu.locator('.act')).toHaveCount(0);
  await page.locator('#midbar').click({ position: { x: 5, y: 5 } }); // a click elsewhere closes it
  await expect(menu).toHaveCount(0);

  // With both Energy attached, 极雷轰 is a move.
  await active.click();
  await expect(menu.locator('.act[data-kind="attack"]:not(.off)')).toHaveText([/飞溅咆哮/, /极雷轰/]);
  await active.click(); // the same card again closes its menu
  await expect(menu).toHaveCount(0);

  // The bar between the mats has no tips (the coach suggests the moves); the log is a column opened and closed from there.
  await expect(page.locator('#hint .tip-now, #tips-more')).toHaveCount(0);
  await expect(page.locator('#log-panel')).toBeHidden();
  await page.locator('#btn-log').click();
  await expect(page.locator('#log-panel')).toBeVisible();
  await expect(page.locator('#log')).toContainText('附着');
  await page.locator('#log-close').click();
  await expect(page.locator('#log-panel')).toBeHidden();
  expect(errors).toEqual([]);
});
