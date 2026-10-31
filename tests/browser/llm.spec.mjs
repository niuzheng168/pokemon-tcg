// 小茂 at a language-model level and the coach beside the player, on the table. This test starts a website of its own
// (server/main.mjs, a fresh database, no rule AI) with --llm naming a model behind a fake gateway here (the Responses API
// of ai/foundry.mjs's Codey gateway): it answers each question at random, judging every option when asked to coach.
// 小茂's moves are the model's; the coach's word shows on the setup choices and, in a card's menu, on each of its moves.
import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.use({ storageState: { cookies: [], origins: [] } }); // a player of this test's website

let gateway, site, siteURL, dir;
const asked = [];
let seed = 11, coachDelayMs = 0;
const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
// The fake model: the numbered options of the last question, one (or as many as asked) picked at random.
function answer(body) {
  const system = body.input[0].content, text = body.input.at(-1).content;
  asked.push({ system, text });
  const options = text.slice(text.lastIndexOf('\n\n', text.search(/^0\. /m)));
  const numbers = [...options.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  const total = Number(/合计正好 (\d+) 个/.exec(options)?.[1] ?? 0), range = /(\d+)–(\d+) (?:个|项)/.exec(options);
  const picked = [...numbers].sort(() => random() - 0.5).slice(0, total ? 1 : range ? Number(range[1]) : 1);
  return system.includes('"choose"')
    ? { ...(total ? { counts: { [picked[0]]: total } } : { choose: range ? picked : picked[0] }), why: Object.fromEntries(numbers.map((n) => [n, `教练对第${n}项的看法`])) }
    : { choice: total ? { [picked[0]]: total } : range ? picked : picked[0], reason: '假模型' };
}

const started = (child, pattern, what) => new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => { const m = pattern.exec(String(d)); if (m) resolve(m[1]); });
  child.on('exit', (code) => reject(new Error(`${what} stopped (${code})`)));
});
test.beforeAll(async () => {
  gateway = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), json = answer(body);
    if (coachDelayMs && body.input[0].content.includes('现在当教练'))
      await new Promise((r) => setTimeout(r, coachDelayMs));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(json) }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  dir = await mkdtemp(join(tmpdir(), 'cn-llm-site-'));
  await writeFile(join(dir, 'gateway.env'), 'CODEY_MODEL_API_KEY=test-key\n');
  await writeFile(join(dir, 'llm.json'), JSON.stringify({ models: { sol: { model: 'fake-sol', env: join(dir, 'gateway.env') },
    astra: { model: 'fake-astra', env: join(dir, 'gateway.env') } } }));
  execFileSync(process.execPath, ['scripts/user-admin.mjs', 'add', 'lance', '--coach', '--db', join(dir, 'accounts.db')],
    { env: { ...process.env, USER_PASSWORD: 'long-enough-1' } });
  site = spawn(process.execPath, ['server/main.mjs', '--port', '0', '--db', join(dir, 'accounts.db'), '--ai-workers', '0', '--test-seeds',
    '--llm', join(dir, 'llm.json'), '--card-library', 'tests/fixtures/card-library', '--replay-dir', join(dir, 'replays'), '--bug-report-dir', join(dir, 'reports')],
  { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, CODEY_COPILOT_PORT: String(gateway.address().port) } });
  siteURL = await started(site, /Website: (http:\/\/\S+?)\/ /, 'the website');
});
test.afterAll(async () => {
  site?.kill();
  gateway?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

const shown = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const tap = (locator) => locator.click({ timeout: 3000 }).catch(() => {});
// Answers whatever the table asks that is not a move: the opening, the setup stages, Prize cards and choices.
async function answerTable(page, { skipActive = false } = {}) {
  if (await shown(page, '#opening-ok')) return tap(page.locator('#opening-ok')).then(() => true);
  if (await shown(page, '.rps-pick')) return tap(page.locator('.rps-pick').first()).then(() => true);
  if (await shown(page, '.rps-btn')) return tap(page.locator('.rps-btn').first()).then(() => true);
  if (await shown(page, '.call-btn')) return tap(page.locator('.call-btn').first()).then(() => true);
  if (await shown(page, '.cs-continue:not([hidden])')) return tap(page.locator('.cs-continue:not([hidden])').first()).then(() => true);
  if (await shown(page, '.setup-ov.st-active:not(.picked) .st-card')) {
    if (skipActive) return false;
    return tap(page.locator('.setup-ov.st-active .st-card').first()).then(() => true);
  }
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
    if (!(await answerTable(page))) await page.waitForTimeout(100);
  }
  throw new Error('the table never offered a move');
}
async function abandonCurrent(page) {
  const { match } = await (await page.request.get(`${siteURL}/api/play/current`)).json();
  if (match) expect((await page.request.post(`${siteURL}/api/play/${match.id}/abandon`, { data: {} })).status()).toBe(200);
}

test('小茂 plays the language model\'s moves; a card\'s menu shows the coach\'s word on each move', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  expect((await page.request.post(`${siteURL}/api/auth/login`, { data: { username: 'lance', password: 'long-enough-1' } })).status()).toBe(200);
  await page.goto(`${siteURL}/play/?seed=1,1,2,3&speed=fast`);
  // Without the rule AI the start bar offers the model levels only.
  await expect(page.locator('#start-engine #opt-level option')).toHaveText(['冠军', '宝可梦大师']);
  await expect(page.locator('#start-coach-row')).toBeVisible();
  await expect(page.locator('#opt-start-coach')).toBeChecked();
  await page.locator('.deck[data-deck="raging-bolt-679141"]').click();
  // The deck's 打法要点 (what the model reads) open from the start bar, each point with its sources.
  await page.locator('#deck-playbook').click();
  await expect(page.locator('#playbook-title')).toContainText('猛雷鼓');
  await expect(page.locator('#playbook-body .pb-sec h3').first()).toHaveText('总体思路');
  await expect(page.locator('#playbook-body .pb-src a').first()).toHaveAttribute('href', /^https:/);
  await page.locator('#playbook-close').click();
  await expect(page.locator('#playbook')).toBeHidden();
  await page.locator('#opt-opp').selectOption('dragapult-676815');
  await page.locator('#btn-start').click();
  await expect(page.locator('#table')).toBeVisible();
  await expect(page.locator('#engine-badge')).toHaveText('小茂 · 冠军');

  // Setup: the coach's word on going first or second and on the Active Pokémon, the card it picks ringed.
  let ordered = false;
  for (let i = 0; i < 600 && !(await shown(page, '.setup-ov.st-active:not(.picked) .st-card')); i++) {
    if (await shown(page, '#modal:not([hidden]) [data-id="first"]')) {
      await expect(page.locator('#modal-body .choice-coach')).toContainText(/推荐「[先后]攻」：教练对第\d项的看法/);
      await expect(page.locator('#modal-body .coach-pick')).toHaveCount(1);
      ordered = true;
    }
    if (!(await answerTable(page, { skipActive: true }))) await page.waitForTimeout(100);
  }
  expect(ordered).toBe(true);
  await expect(page.locator('.setup-ov.st-active .st-coach')).toContainText(/推荐「.+」：教练对第\d+项的看法/);
  await expect(page.locator('.setup-ov.st-active .st-card.coach-pick')).toHaveCount(1);
  await untilYourMove(page);

  // The coach judges the moves of the position; a hand card's menu shows its word on each of its moves.
  await expect(page.locator('#llm-coach-msg')).toContainText('推荐', { timeout: 30_000 });
  const card = page.locator('#hand .hcard:not(.unplayable)').first();
  await card.click();
  await expect(page.locator('.act-menu .act .coach-why').first()).toContainText(/教练对第\d+项的看法/);
  await page.keyboard.press('Escape');
  const coach = asked.filter((x) => x.system.includes('现在当教练'));
  expect(coach.length).toBeGreaterThan(0);
  expect(coach[0].system).toContain('「猛雷鼓');

  // 小茂's turn: the model plays it (his deck's instruction), and the table offers your next move.
  const before = asked.filter((x) => !x.system.includes('现在当教练')).length;
  await page.locator('#end-slot .k-end').click();
  await untilYourMove(page);
  const his = asked.filter((x) => !x.system.includes('现在当教练'));
  expect(his.length).toBeGreaterThan(before);
  expect(his.at(-1).system).toContain('「多龙巴鲁托');
  await expect(page.locator('#log')).not.toContainText('决策引擎出错');
  expect(errors).toEqual([]);
});

test('coaching can be disabled at the opening and enabled immediately on the current move, with settings kept in sync', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  expect((await page.request.post(`${siteURL}/api/auth/login`, { data: { username: 'lance', password: 'long-enough-1' } })).status()).toBe(200);
  await abandonCurrent(page);
  // This test has its own browser storage; the current game from another test is deliberately replaced.
  await page.goto(`${siteURL}/play/?seed=1,1,2,3&speed=fast`);
  await expect(page.locator('#start-coach-row')).toBeVisible();
  await page.locator('#opt-start-coach').uncheck();
  await page.locator('#start-engine-change').click();
  await expect(page.locator('#opt-llm-coach')).not.toBeChecked();
  await page.locator('#settings-close').click();
  await page.locator('.deck[data-deck="raging-bolt-679141"]').click();
  await page.locator('#opt-opp').selectOption('dragapult-676815');
  const coachCalls = () => asked.filter((x) => x.system.includes('现在当教练'));
  const before = coachCalls().length;
  await page.locator('#btn-start').click();
  await untilYourMove(page);
  expect(coachCalls().length).toBe(before, 'No coach requests while the opening preference is off.');
  await expect(page.locator('#llm-coach-msg')).toHaveCount(0);
  await expect(page.locator('#btn-coach')).toHaveAttribute('aria-pressed', 'false');
  const revision = await page.evaluate(() => window.__cnTable.view().revision);
  coachDelayMs = 500;
  try {
    await page.locator('#btn-coach').click();
    await expect(page.locator('#llm-coach-msg')).toContainText('正在看');
    await page.locator('#btn-coach').click();
    await page.waitForTimeout(600); // Let the in-flight response arrive while coaching is off.
    await expect(page.locator('#llm-coach-msg')).toHaveCount(0);
    await page.locator('#btn-coach').click();
    await expect(page.locator('#llm-coach-msg')).toContainText('推荐');
  } finally { coachDelayMs = 0; }
  expect(await page.evaluate(() => window.__cnTable.view().revision)).toBe(revision);
  expect(coachCalls().length).toBe(before + 1);
  expect(coachCalls().at(-1).text).toContain('此前对战记录');
  await page.locator('#btn-settings').click();
  await expect(page.locator('#opt-llm-coach')).toBeChecked();
  // Switching off hides the current advice without requiring a move.
  await page.locator('#opt-llm-coach').uncheck();
  await expect(page.locator('#llm-coach-msg')).toHaveCount(0);
  await page.locator('#settings-close').click();
  await expect(page.locator('#btn-coach')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#btn-coach').click();
  await expect(page.locator('#llm-coach-msg')).toContainText('推荐');
  expect(coachCalls().length).toBe(before + 1, 'The current judgement can be reused on re-enable.');
  await page.locator('#btn-coach').click();
  await page.locator('#end-slot .k-end').click();
  await untilYourMove(page);
  expect(coachCalls().length).toBe(before + 1, 'No new coach requests while it is off, even as the game advances.');
  await page.locator('#btn-coach').click();
  await expect(page.locator('#llm-coach-msg')).toContainText('推荐');
  expect(coachCalls().length).toBe(before + 2);
  expect(coachCalls().at(-1).text).toContain('玩家实际选择');
  await page.locator('#btn-new').click();
  await page.locator('#new-ok').click();
  await expect(page.locator('#opt-start-coach')).toBeChecked();
  expect(errors).toEqual([]);
});

test('coaching can be enabled while a setup choice is already open, and disabled advice disappears from that choice', async ({ page }) => {
  test.setTimeout(240_000);
  expect((await page.request.post(`${siteURL}/api/auth/login`, { data: { username: 'lance', password: 'long-enough-1' } })).status()).toBe(200);
  await abandonCurrent(page);
  await page.goto(`${siteURL}/play/?seed=1,1,2,3&speed=fast`);
  await expect(page.locator('#start-coach-row')).toBeVisible();
  await page.locator('#opt-start-coach').uncheck();
  await page.locator('.deck[data-deck="raging-bolt-679141"]').click();
  await page.locator('#opt-opp').selectOption('dragapult-676815');
  await page.locator('#btn-start').click();
  for (let i = 0; i < 600 && !(await shown(page, '.setup-ov.st-active:not(.picked) .st-card')); i++) {
    if (!(await answerTable(page, { skipActive: true }))) await page.waitForTimeout(100);
  }
  const stage = page.locator('.setup-ov.st-active:not(.picked)');
  await expect(stage.locator('[data-coach-toggle]')).toHaveAttribute('aria-pressed', 'false');
  await expect(stage.locator('.st-card.coach-pick')).toHaveCount(0);
  const revision = await page.evaluate(() => window.__cnTable.view().revision);
  await stage.locator('[data-coach-toggle]').click();
  await expect(stage.locator('.st-coach')).toContainText(/推荐「.+」：教练对第\d+项的看法/);
  expect(await page.evaluate(() => window.__cnTable.view().revision)).toBe(revision);
  await expect(stage.locator('.st-card.coach-pick')).toHaveCount(1);
  await stage.locator('[data-coach-toggle]').click();
  await expect(stage.locator('.st-coach')).not.toContainText('推荐');
  await expect(stage.locator('.st-card.coach-pick')).toHaveCount(0);
  await untilYourMove(page);
  // A search choice can also enable the coach without first answering it. Its whole deck inspection is known now.
  await page.locator('#hand .hcard:has(img[alt="巢穴球"])').first().click();
  await page.locator('.act-menu .act', { hasText: '使用巢穴球' }).click();
  const sheet = page.locator('#modal-body');
  await expect(sheet.locator('.choice-grid.inline')).toBeVisible();
  const view = await page.evaluate(() => window.__cnTable.view());
  expect(view.pending.lookedAt.length).toBe(view.players[0].deckCount);
  await sheet.locator('[data-coach-toggle]').click();
  await expect(sheet.locator('.choice-coach')).toContainText('推荐');
  expect(await page.evaluate(() => window.__cnTable.view().revision)).toBe(view.revision);
  const said = asked.filter((x) => x.system.includes('现在当教练')).at(-1).text;
  expect(said).toContain('你的奖赏卡（看过整副牌库，由此可知）');
  expect(said).toContain('你的牌库（');
  await sheet.locator('[data-coach-toggle]').click();
  await expect(sheet.locator('.choice-coach')).not.toContainText('推荐');
  await expect(sheet.locator('.pick-card.coach-pick')).toHaveCount(0);
  await untilYourMove(page);
  await page.locator('#btn-new').click();
  await page.locator('#new-ok').click();
});

test('an unapproved account has no coach settings and cannot call the coach directly, even with a model configured', async ({ page }) => {
  const registered = await page.request.post(`${siteURL}/api/auth/register`, {
    data: { username: 'uncoached', password: 'long-enough-1', coachEnabled: true },
  });
  expect(registered.status()).toBe(201);
  expect((await registered.json()).user.coachEnabled).toBe(false);
  await page.goto(`${siteURL}/play/`);
  await expect(page.locator('#start-engine #opt-level option')).toHaveText(['冠军', '宝可梦大师']);
  await expect(page.locator('#start-coach-row')).toBeHidden();
  await page.locator('#start-engine-change').click();
  await expect(page.locator('#settings')).toBeVisible();
  await expect(page.locator('#llm-coach-row')).toBeHidden();
  expect((await page.request.post(`${siteURL}/api/play/1/coach`, { data: { revision: 0 } })).status()).toBe(403);
});

test('PvP coach controls follow the separate permission for both players, never spectators', async ({ browser }) => {
  test.setTimeout(180_000);
  const contexts = [], players = [], errors = [], replies = [];
  let matchId;
  const grant = (username) => execFileSync(process.execPath, ['scripts/user-admin.mjs', 'pvp-coach', username, 'on', '--db', join(dir, 'accounts.db')]);
  try {
    for (const username of ['pvp-lance', 'pvp-karen', 'pvp-watcher']) {
      const context = await browser.newContext({ baseURL: siteURL, viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      expect((await context.request.post('/api/auth/register', { data: { username, password: 'long-enough-1' } })).status()).toBe(201);
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('response', (r) => { if (/\/coach$/.test(r.url())) replies.push({ username, status: r.status() }); });
      await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      players.push(page);
    }
    // The host and spectator have only PvP coaching; the guest has only CPU coaching at first.
    grant('pvp-lance');
    grant('pvp-watcher');
    execFileSync(process.execPath, ['scripts/user-admin.mjs', 'coach', 'pvp-karen', 'on', '--db', join(dir, 'accounts.db')]);
    const [host, guest, spectator] = players;
    const opened = await host.request.post('/api/rooms', { data: { deck: 'raging-bolt-679141', seed: [1, 1, 2, 3] } });
    expect(opened.status()).toBe(201);
    const room = (await opened.json()).room;
    const joined = await guest.request.post(`/api/rooms/${room.id}/join`, { data: { deck: 'dragapult-676815' } });
    expect(joined.status()).toBe(201);
    matchId = (await joined.json()).match.id;
    await Promise.all([host, guest].map((page) => page.goto('/play/?speed=fast')));
    await expect(host.locator('#table')).toBeVisible();
    await expect(guest.locator('#table')).toBeVisible();
    await expect(host.locator('#btn-coach')).toBeVisible();
    await expect(guest.locator('#btn-coach')).toBeHidden();
    await expect(guest.locator('[data-coach-toggle]')).toHaveCount(0);
    grant('pvp-karen');
    await guest.reload();
    await expect(guest.locator('#btn-coach')).toBeVisible();

    // Both seats reach their own turn and can turn advice off and back on without making a move.
    const coached = new Set();
    for (let n = 0; n < 400 && coached.size < 2; n++) {
      for (const [seat, page] of [host, guest].entries()) {
        if (await shown(page, 'body.your-move') && !coached.has(seat)) {
          await expect(page.locator('#llm-coach-msg')).toContainText('推荐：', { timeout: 15_000 });
          const revision = await page.evaluate(() => window.__cnTable.view().revision);
          await page.locator('#btn-coach').click();
          await expect(page.locator('#btn-coach')).toHaveAttribute('aria-pressed', 'false');
          await expect(page.locator('#llm-coach-msg')).toHaveCount(0);
          await page.locator('#btn-coach').click();
          await expect(page.locator('#llm-coach-msg')).toContainText('推荐：');
          expect(await page.evaluate(() => window.__cnTable.view().revision)).toBe(revision);
          coached.add(seat);
          if (coached.size < 2) await page.locator('#end-slot .k-end').click();
        } else await answerTable(page);
      }
      if (coached.size < 2) await host.waitForTimeout(100);
    }
    expect([...coached].sort()).toEqual([0, 1]);
    expect(replies.filter((r) => r.status === 200).map((r) => r.username)).toEqual(expect.arrayContaining(['pvp-lance', 'pvp-karen']));
    expect(replies.every((r) => r.status === 200)).toBe(true);

    await spectator.goto(`/play/?watch=${matchId}&speed=fast`);
    await expect(spectator.locator('#table')).toBeVisible();
    await expect(spectator.locator('#btn-coach')).toBeHidden();
    await expect(spectator.locator('[data-coach-toggle]')).toHaveCount(0);
    expect(replies.filter((r) => r.username === 'pvp-watcher')).toEqual([]);
    expect((await spectator.request.post(`/api/play/${matchId}/coach`, { data: { revision: 0 } })).status()).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    if (matchId) await contexts[0].request.post(`/api/play/${matchId}/concede`, { data: {} });
    await Promise.all(contexts.map((c) => c.close()));
  }
});
