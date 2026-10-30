// 在线对战 through the real pages, in two browsers: player A opens a room on the start page, player B follows A's link to
// it (/play/?room=<id>) and joins with a deck of theirs, both play through the setup and a turn each, each table showing
// only its own hand and both clocks, then A concedes and both tables show the result; B's 对局记录 lists the game with
// A's name. A third player, C, watches the game (观战) from the start page's 正在进行的对局: both hands face down, a move
// arriving, 换边, a reload, the result and the replay, C's own game untouched. B then takes the finished game over from
// its replay in B's own seat (1), 小茂 playing A's side. The server side: server/play.mjs (rooms, games between two
// players, watching, takeover) and server/events.mjs (the push channel).
import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } }); // the two players sign up themselves

const shown = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const tap = (locator) => locator.click({ timeout: 3000 }).catch(() => {});

// A new player, signed up through the login page in a browser of their own.
async function player(browser, baseURL, username) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/login.html');
  await page.locator('#tab-register').click();
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(`${username}-pass-1`);
  await page.locator('input[name="again"]').fill(`${username}-pass-1`);
  await page.locator('#auth-submit').click();
  await expect(page).toHaveURL(/\/play\/$/);
  return { context, page, errors, username, ended: false };
}

// Answers whatever the table asks that is not a move: the setup stages, Prize cards and choices.
async function answer(page) {
  if (await shown(page, '#opening-ok')) return tap(page.locator('#opening-ok')).then(() => true);
  if (await shown(page, '.setup-ov.st-active:not(.picked) .st-card')) return tap(page.locator('.setup-ov.st-active .st-card').first()).then(() => true);
  if (await shown(page, '.setup-ov.st-bench:not(.done) .st-ok')) return tap(page.locator('.setup-ov.st-bench .st-ok')).then(() => true);
  if (await shown(page, '.prize-ov:not(.setup-ov):not(.picked) .pz-card')) return tap(page.locator('.prize-ov:not(.picked) .pz-card').first()).then(() => true);
  if (await shown(page, '#modal:not([hidden]) .dialog.sheet [data-id]')) {
    const options = page.locator('#modal-body [data-id]');
    await tap(options.first());
    if (await page.locator('#choice-ok').count()) {
      for (let i = 1; i < 8 && await page.locator('#choice-ok').isDisabled().catch(() => false); i++) await tap(options.nth(i));
      const stuck = await page.locator('#choice-ok').isDisabled().catch(() => false) && await page.locator('#choice-none').count();
      await tap(page.locator(stuck ? '#choice-none' : '#choice-ok'));
    }
    return true;
  }
  return false;
}

// One step of a player's table: their first turn is ended as soon as it is offered; anything else asked is answered.
async function step(p) {
  if (!p.ended && await shown(p.page, 'body.your-move') && await shown(p.page, '#end-slot .k-end')) {
    await p.page.locator('#end-slot .k-end').click();
    p.ended = true;
    return true;
  }
  return answer(p.page);
}

// Steps both tables until one of the two players has ended a turn.
async function untilEnded(a, b) {
  for (let i = 0; i < 600 && !(a.ended || b.ended); i++) {
    const acted = [await step(a), await step(b)].some(Boolean);
    if (!acted) await a.page.waitForTimeout(100);
  }
}

test('two players: a room opened, joined from its link, setup and a turn each, own hands only, a spectator, a concession, a takeover', async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  const tag = String(Date.now() % 100000);
  const a = await player(browser, baseURL, `alice-${tag}`), b = await player(browser, baseURL, `bob-${tag}`);
  let c = null;
  try {
    // A opens a standard-format room with 10 minutes a side (a fixed seed: a test server lets any player fix it).
    await a.page.goto('/play/?seed=11,22,33,44&speed=fast');
    await a.page.locator('.deck[data-deck="raging-bolt-679141"]').click();
    await expect(a.page.locator('#lobby .room-new')).toContainText('猛雷鼓ex');
    await a.page.locator('#room-minutes').selectOption('10');
    await a.page.locator('#room-open').click();
    await expect(a.page.locator('#lobby .room.mine')).toContainText('等待对手加入');
    await expect(a.page.locator('#lobby .room.mine')).toContainText('标准赛 · 每方 10 分钟');
    const link = new URL(await a.page.locator('#room-link').inputValue());
    expect(link.searchParams.get('room')).toMatch(/^\d+$/);

    // B follows the link: the room is offered; an open-format deck cannot join a standard room, a standard one can.
    await b.page.goto(`/play/?room=${link.searchParams.get('room')}&speed=fast`);
    await expect(b.page.locator('#lobby .lobby-invite')).toContainText(`${a.username} 邀请你在线对战（标准赛 · 每方 10 分钟）`);
    const room = b.page.locator('#lobby .room.invited');
    await expect(room).toContainText(a.username);
    await b.page.locator('.deck[data-deck="csvh1c-pikachu"]').click();
    await expect(room.locator('.room-join')).toBeDisabled();
    await expect(room.locator('.room-why')).toContainText('不能用于标准赛房间');
    await b.page.locator('.deck[data-deck="dragapult-676815"]').click();
    await room.locator('.room-join').click();

    // Both tables open on the game: B's from the reply, A's from the push channel.
    for (const p of [a, b]) await expect(p.page.locator('#table')).toBeVisible({ timeout: 20_000 });
    await expect(b.page).not.toHaveURL(/room=/);
    const seats = await Promise.all([a, b].map((p) => p.page.evaluate(() => window.__cnTable.seat())));
    expect([...seats].sort()).toEqual([0, 1]);
    for (const [p, other] of [[a, b], [b, a]]) {
      await expect(p.page.locator('#engine-badge')).toHaveText('在线对战');
      await expect(p.page.locator('#log')).toContainText(`对手是${other.username}`);
      await expect(p.page.locator('#opp-clock')).toContainText(other.username);
      await expect(p.page.locator('#opp-clock .clock-time')).toHaveText(/^(10:00|0\d:\d\d)$/);
      await expect(p.page.locator('#you-clock .clock-time')).toHaveText(/^(10:00|0\d:\d\d)$/);
      await expect(p.page.locator('#btn-concede')).toBeVisible();
    }

    // The setup and one turn each, answered on both tables; whoever waits says so.
    let waited = false;
    for (let i = 0; i < 600 && !(a.ended && b.ended); i++) {
      const acted = [await step(a), await step(b)].some(Boolean);
      waited ||= await shown(a.page, '#opp-status.thinking') || await shown(b.page, '#opp-status.thinking');
      if (!acted) await a.page.waitForTimeout(100);
    }
    expect(a.ended && b.ended, 'both players ended a turn').toBe(true);
    expect(waited, 'a table waited for the other player').toBe(true);
    await expect.poll(() => a.page.evaluate(() => window.__cnTable.view().turn), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);

    // Each table holds its own hand only: the other's is a count, shown as card backs.
    for (const p of [a, b]) {
      const { seat, mine, theirs } = await p.page.evaluate(() => {
        const v = window.__cnTable.view(), s = window.__cnTable.seat();
        return { seat: s, mine: v.players[s].hand, theirs: v.players[1 - s].hand };
      });
      expect(Array.isArray(mine)).toBe(true);
      expect(mine.every((c) => c.instanceId.startsWith(`p${seat}c`))).toBe(true);
      expect(Array.isArray(theirs)).toBe(false);
      await expect(p.page.locator('#hand .hcard')).toHaveCount(mine.length);
      await expect(p.page.locator('#opp-hand .ocard')).toHaveCount(theirs.count);
      await expect(p.page.locator('#undo-btn')).toHaveCount(0);
    }

    // B reloads the page: the game picks up again in B's seat, against A.
    await b.page.reload();
    await expect(b.page.locator('#table')).toBeVisible();
    await expect(b.page.locator('#log')).toContainText('已恢复服务器上的对局');
    expect(await b.page.evaluate(() => window.__cnTable.seat())).toBe(seats[1]);
    await expect(b.page.locator('#opp-clock')).toContainText(a.username);
    const id = await a.page.evaluate(() => window.__cnTable.matchId());
    // (A, whose room it was, is seat 0.)
    expect(seats[0]).toBe(0);

    // C watches from the start page: 正在进行的对局 lists the game with both players; 观战 opens the spectator's table.
    c = await player(browser, baseURL, `carol-${tag}`);
    await c.page.goto('/play/?speed=fast');
    const listed = c.page.locator('#lobby .game-list .room.game').filter({ hasText: a.username });
    await expect(listed).toContainText(b.username, { timeout: 20_000 });
    await expect(listed).toContainText('每方 10 分钟');
    await listed.locator('.room-watch').click();
    await expect(c.page).toHaveURL(new RegExp(`[?&]watch=${id}(&|$)`));
    await expect(c.page.locator('#table')).toBeVisible({ timeout: 20_000 });
    expect(await c.page.evaluate(() => window.__cnTable.watching())).toBe(true);
    await expect(c.page.locator('#engine-badge')).toHaveText('观战中');
    await expect(c.page.locator('.watch-bar')).toContainText('观战中');
    // Both hands face down with their counts, seat 0 (A) at the bottom; nothing to play, no 认输.
    const hands = () => c.page.evaluate(() => window.__cnTable.view().players.map((p) => p.hand));
    const [h0, h1] = await hands();
    expect([h0, h1].every((h) => !Array.isArray(h) && Number.isInteger(h.count))).toBe(true);
    await expect(c.page.locator('#hand .hcard.back')).toHaveCount(h0.count);
    await expect(c.page.locator('#hand .hcard[data-card]')).toHaveCount(0);
    await expect(c.page.locator('#hand-count')).toHaveText(String(h0.count));
    await expect(c.page.locator('#opp-hand .ocard')).toHaveCount(h1.count);
    await expect(c.page.locator('#btn-concede')).toBeHidden();
    await expect(c.page.locator('#end-slot .k-end')).toHaveCount(0);
    // Both clocks, both players by name in the log (never 你 or 小茂); the players see that someone watches.
    await expect(c.page.locator('#you-clock')).toContainText(a.username);
    await expect(c.page.locator('#opp-clock')).toContainText(b.username);
    await c.page.locator('#btn-log').click();
    await expect(c.page.locator('#log')).toContainText(`${a.username}的回合结束`);
    expect(await c.page.locator('#log').innerText()).not.toMatch(/(^|\n)你|小茂/);
    await expect(c.page.locator('#watch-count')).toHaveText('1 人观战');
    for (const p of [a, b]) await expect(p.page.locator('#opp-clock .watchers')).toContainText('1 人观战', { timeout: 20_000 });
    // C's own game against 小茂, started meanwhile, and C's saved table are left alone by watching.
    const own = (await (await c.page.request.post('/api/play', { data: { deck: 'csvh1c-pikachu' } })).json()).match.id;
    const saveKey = await c.page.evaluate(() => window.__cnTable.saveKey());
    await c.page.evaluate((key) => localStorage.setItem(key, 'mine'), saveKey);

    // A move arrives: whoever must act ends their turn; C's table shows it.
    const before = await c.page.evaluate(() => window.__cnTable.view().revision);
    a.ended = b.ended = false;
    await untilEnded(a, b);
    const mover = a.ended ? a : b;
    await expect.poll(() => c.page.evaluate(() => window.__cnTable.view().revision), { timeout: 30_000 }).toBeGreaterThan(before);
    await expect(c.page.locator('#log')).toContainText(`${mover.username}的回合结束`, { timeout: 30_000 });
    await expect(c.page.locator('#opp-status')).toContainText(/正在(行动|选择)/);

    // 换边: B at the bottom.
    await c.page.locator('#watch-flip').click();
    expect(await c.page.evaluate(() => window.__cnTable.seat())).toBe(1);
    await expect(c.page.locator('#you-clock')).toContainText(b.username);
    await expect(c.page.locator('#opp-clock')).toContainText(a.username);
    const [, flipped] = await hands();
    await expect(c.page.locator('#hand .hcard.back')).toHaveCount(flipped.count);
    // A reload watches on (from seat 0 again).
    await c.page.reload();
    await expect(c.page.locator('#table')).toBeVisible({ timeout: 20_000 });
    expect(await c.page.evaluate(() => [window.__cnTable.watching(), window.__cnTable.seat(), window.__cnTable.matchId()])).toEqual([true, 0, id]);

    // A gives up: both tables show the result, and so does C's, with the replay.
    await a.page.locator('#btn-concede').click();
    await a.page.locator('.acct-dialog [data-act="yes"]').click();
    await expect(a.page.locator('.over-title')).toContainText(`${b.username}获胜`, { timeout: 20_000 });
    await expect(a.page.locator('#modal-body')).toContainText('你认输。');
    await expect(b.page.locator('.over-title')).toContainText('你赢了！', { timeout: 30_000 });
    await expect(b.page.locator('#modal-body')).toContainText(`${a.username}认输。`);
    for (const p of [a, b]) await expect(p.page.locator('#btn-concede')).toBeHidden();
    await expect(c.page.locator('.over-title')).toContainText(`${b.username}获胜`, { timeout: 30_000 });
    await expect(c.page.locator('#modal-body')).toContainText(`${a.username}认输。`);
    await c.page.locator('#over-close').click();
    await expect(c.page.locator('#watch-replay')).toHaveAttribute('href', `./?replay=${id}`);
    await expect(c.page.locator('#log')).toContainText(`${a.username}使用`);
    expect(await c.page.evaluate((key) => localStorage.getItem(key), saveKey)).toBe('mine');
    expect((await (await c.page.request.get('/api/play/current')).json()).match?.id).toBe(own);
    // 离开: back to the start page, where C's own game picks up again.
    await c.page.locator('#watch-leave').click();
    await expect(c.page).toHaveURL(/\/play\/$/);
    await expect.poll(() => c.page.evaluate(() => window.__cnTable.matchId()), { timeout: 20_000 }).toBe(own);

    // B's 对局记录: the game against A, won.
    await b.page.goto('/play/matches.html');
    const row = b.page.locator('#matches tbody tr').first();
    await expect(row).toContainText('在线对战');
    await expect(row).toContainText(a.username);
    await expect(row).toContainText('胜');
    // Its replay is seen from B's seat, the decks of both now shown.
    await row.locator('a', { hasText: '回放' }).click();
    await expect(b.page.locator('#log')).toContainText(`以 ${b.username} 的视角回放`);
    await expect(b.page.locator('#log')).toContainText(`${a.username}使用猛雷鼓ex`);
    expect(await b.page.evaluate(() => window.__cnTable.seat())).toBe(seats[1]);

    // 从这一步接管, a move before the concession: B chooses a side, each named by its player and deck, B's own seat (1)
    // chosen first; 小茂 plays A's side, and the table plays seat 1 on until 小茂 has ended a turn.
    const total = await b.page.evaluate(() => window.__cnTable.replay().total);
    await b.page.evaluate(() => localStorage.setItem('opt-anim', '0')); // the game taken over plays without animations
    await b.page.locator('#rp-at').fill(String(total - 1));
    await b.page.locator('#rp-jump button').click();
    await expect(b.page.locator('#rp-progress')).toHaveText(`第 ${total - 1} / ${total} 步`, { timeout: 60_000 });
    await b.page.locator('#rp-takeover').click();
    const sides = b.page.locator('.acct-dialog .takeover-side');
    await expect(sides).toHaveCount(2);
    await expect(sides.nth(0)).toContainText(a.username);
    await expect(sides.nth(0)).toContainText('猛雷鼓ex');
    await expect(sides.nth(1)).toContainText(b.username);
    await expect(b.page.locator('.acct-dialog input[name="takeover-seat"][value="1"]')).toBeChecked();
    await b.page.locator('.acct-dialog [data-act="yes"]').click();
    await expect(b.page).toHaveURL(/\/play\/$/);
    await expect(b.page.locator('#log')).toContainText(`从对局 #${id} 的第 ${total - 1} 步接管`, { timeout: 60_000 });
    const taken = await b.page.evaluate(() => window.__cnTable.matchId());
    expect(taken).not.toBe(id);
    expect(await b.page.evaluate(() => window.__cnTable.seat())).toBe(1);
    await expect(b.page.locator('#engine-badge')).not.toHaveText('在线对战');
    await expect(b.page.locator('#you-clock')).toBeHidden();
    b.ended = false;
    const garyEnded = async () => (await b.page.locator('#log').innerText()).includes('小茂的回合结束');
    for (let i = 0; i < 600 && !await garyEnded(); i++) if (!await step(b)) await b.page.waitForTimeout(100);
    await expect(b.page.locator('#log')).toContainText('小茂的回合结束');
    const record = await (await b.page.request.get(`/api/matches/${taken}`)).json();
    expect(record.match.setup.takeover).toEqual({ match: id, move: total - 1 });
    expect(record.steps.filter((s) => s.type === 'action' && s.player === 0).length).toBeGreaterThan(0);
    for (const p of [a, b, c]) expect(p.errors).toEqual([]);
  } finally {
    await a.context.close();
    await b.context.close();
    await c?.context.close();
  }
});
