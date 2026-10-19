import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

test('complete a real modern game through the Chinese UI', async ({ page }) => {
  test.skip(process.env.PLAY_FULL_GAME !== '1', 'Opt in with npm run test:game:zh');
  test.setTimeout(900_000);
  const errors = [], choices = [], snapshots = [];
  const capture = process.env.CAPTURE_ZH_SCREENSHOTS === '1';
  const research = process.env.PLAY_LOCAL_RESEARCH === '1';
  const artifact = research ? 'local-research-real-game' : 'zh-cn-real-game';
  let researchOnTable = false;
  const scenes = new Set();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript((capture) => {
    localStorage.setItem('lang', 'zh-CN');
    localStorage.setItem('opt-anim', capture ? '1' : '0');
    localStorage.setItem('tourDone', '1');
  }, capture);
  await page.goto('/play/');
  await page.locator('[data-format="modern"]').click();
  await page.locator(`[data-deck="${process.env.RESEARCH_PLAYER_DECK || 'sv-miraidon'}"]`).click();
  await page.locator('#opt-opp').selectOption(process.env.RESEARCH_OPPONENT_DECK || 'sv-ampharos');
  if (capture) await page.screenshot({ path: `test-results/${artifact}-home.png` });
  await page.locator('#btn-start').click();
  let ended = false;
  const start = Date.now();
  let lastAction = Date.now();
  for (let step = 0; step < 5000; step++) {
    if (research && !researchOnTable) {
      const privateCard = page.locator('#table img[src^="/api/research-card/"]').filter({ visible: true }).first();
      if (await privateCard.count() && await privateCard.evaluate((el) => el.complete && el.naturalWidth > 0)) {
        researchOnTable = true;
        // Local test artifacts only: never copy these into the public docs screenshots.
        await page.screenshot({ path: 'test-results/local-research-real-game.png' });
      }
    }
    if (capture) {
      for (const [name, selector] of [['attack', '.arena.cut-in'], ['prize', '.prize-ov:not(.setup-ov).revealed']]) {
        if (!scenes.has(name) && await page.locator(selector).isVisible()) {
          await page.waitForTimeout(160);
          await page.screenshot({ path: `test-results/${artifact}-${name}.png` });
          scenes.add(name);
        }
      }
    }
    if (await page.locator('#modal-body .over-title').isVisible()) { ended = true; break; }
    if (Date.now() - start > 840_000) break;
    const visible = (selector) => page.locator(selector).filter({ visible: true });
    let selected = null;
    for (const selector of [
      '.rps-pick[data-kind="rock"]', '.rps-btn',
      '.coin-ov.calling [data-call="heads"]', '.coin-ov:not(.closing) .cs-continue',
      '.st-active:not(.picked):not(.closing) .st-card', '.st-bench:not(.done):not(.closing) .st-ok',
      '.prize-ov:not(.setup-ov):not(.closing):not(.revealed) .pz-card:not(.chosen)',
      '#modal:not([hidden]) .pick-card', '#modal:not([hidden]) [data-id="none"]',
      '#modal:not([hidden]) .opt-word', '#modal:not([hidden]) .choice-words button',
    ]) {
      const target = visible(selector).first();
      if (await target.count() && await target.isEnabled()) { selected = target; break; }
    }
    if (!selected) {
      // Wait for the same CPU coach used in the actual product; do not inject or alter engine state.
      const best = visible('#actions .act.best, #end-slot .act.best').first();
      if (await best.count()) selected = best;
      else if (Date.now() - lastAction > 2500) {
        const fallback = visible('#actions .act, #end-slot .act').first();
        if (await fallback.count()) selected = fallback;
      }
    }
    if (selected) {
      const label = (await selected.innerText()).trim();
      try {
        // Animations can replace an overlay between selection and clicking.
        // Re-select the current visible controls; never force clicks through another stage.
        await selected.click({ timeout: 600 });
      } catch (error) {
        if (error.name === 'TimeoutError') continue;
        throw error;
      }
      if (label) choices.push(label);
      lastAction = Date.now();
    }
    if (choices.length > 4 && snapshots.length === 0 && await page.locator('#you-active .mon').count()
        && !await page.locator('.overlay:not(.closing), .arena').filter({ visible: true }).count()) {
      await page.screenshot({ path: `test-results/${artifact}-board.png` });
      const card = page.locator('#you-active [data-inspect]').first();
      await card.hover();
      await expect(page.locator('#preview .pv-name').first()).not.toHaveText('');
      await page.screenshot({ path: `test-results/${artifact}-preview.png` });
      snapshots.push(await page.locator('#preview').innerText());
      await page.mouse.move(2, 2);
    }
    await page.waitForTimeout(130);
  }
  const log = await page.locator('#log').innerText();
  const title = ended ? await page.locator('#modal-body .over-title').innerText() : '';
  const bodyText = await page.locator('#table').innerText();
  const foreignWords = [...new Set((log + '\n' + bodyText).match(/\b[A-Za-z][A-Za-z'-]{2,}\b/g) || [])]
    .filter((word) => !['VMAX', 'VSTAR', 'VIP', 'TAG', 'TEAM', 'GX', 'CPU', 'HP'].includes(word));
  await mkdir('test-results', { recursive: true });
  await writeFile(`test-results/${artifact}.json`, JSON.stringify({
    ended, title, elapsedSeconds: (Date.now() - start) / 1000,
    choices: choices.length, selectedMoves: choices, foreignWords, errors, log, previews: snapshots,
    localResearch: research, researchImageDisplayedOnTable: researchOnTable,
    method: 'Fresh game; legal moves and prompts clicked in the real browser UI; no injected board, damage, hand or winner.',
  }, null, 2));
  await page.locator('.prize-ov').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
  await page.screenshot({ path: `test-results/${artifact}-end.png` });
  expect(errors).toEqual([]);
  expect(ended, 'The game must actually end; reaching the first move is insufficient').toBeTruthy();
  expect(snapshots.length).toBe(1);
  expect(log).toContain('使用了');
  expect(log).toContain('伤害');
  expect(foreignWords).toEqual([]);
  if (research) expect(researchOnTable).toBeTruthy();
  if (capture) expect([...scenes].sort()).toEqual(['attack', 'prize']);
});
