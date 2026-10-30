// 小茂 at a language-model level and the coach beside the player, on the table. This test starts a website of its own
// (server/main.mjs, a fresh database, no rule AI) with --llm naming a model behind a fake gateway here (the Responses API
// of ai/foundry.mjs's Codey gateway): it answers each question at random, judging every option when asked to coach.
// 小茂's moves are the model's; the coach's word shows on the setup choices and, in a card's menu, on each of its moves.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.use({ storageState: { cookies: [], origins: [] } }); // a player of this test's website

let gateway, site, siteURL, dir;
const asked = [];
let seed = 11;
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
    ? { options: numbers.map((n) => ({ option: n, choose: picked.includes(n), reason: `教练对第${n}项的看法`, ...(total ? { count: picked.includes(n) ? total : 0 } : {}) })) }
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
    const json = answer(JSON.parse(raw));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(json) }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  dir = await mkdtemp(join(tmpdir(), 'cn-llm-site-'));
  await writeFile(join(dir, 'gateway.env'), 'CODEY_MODEL_API_KEY=test-key\n');
  await writeFile(join(dir, 'llm.json'), JSON.stringify({ models: { sol: { model: 'fake-sol', env: join(dir, 'gateway.env') },
    astra: { model: 'fake-astra', env: join(dir, 'gateway.env') } } }));
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
async function answerTable(page) {
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
    if (!(await answerTable(page))) await page.waitForTimeout(100);
  }
  throw new Error('the table never offered a move');
}

test('小茂 plays the language model\'s moves; a card\'s menu shows the coach\'s word on each move', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  expect((await page.request.post(`${siteURL}/api/auth/register`, { data: { username: 'lance', password: 'long-enough-1' } })).status()).toBe(201);
  await page.goto(`${siteURL}/play/?seed=1,1,2,3&speed=fast`);
  // Without the rule AI the start bar offers the model levels only.
  await expect(page.locator('#start-engine #opt-level option')).toHaveText(['冠军', '宝可梦大师']);
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
    if (!(await answerTable(page))) await page.waitForTimeout(100);
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
