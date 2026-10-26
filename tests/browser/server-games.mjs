// The browser tests' games on the server (/api/play, server/play.mjs). The player's game still on from an earlier test
// is abandoned, so the table opens on its start screen; a test's position is put on the server the way the 调试台 puts
// one, by the administrator, as the next move of a new game of the player's.
import { request } from '@playwright/test';
import { ADMIN } from '../../playwright.config.mjs';

export async function abandonCurrent(page) {
  const { match } = await (await page.request.get('/api/play/current')).json();
  if (match) await page.request.post(`/api/play/${match.id}/abandon`, { data: {} });
}

// A new game of the player's with `deck`, at `snapshot` (a reviewed game's state, tests/cn-cards/helpers.mjs board).
export async function gameAt(page, baseURL, { deck, snapshot }) {
  const started = await page.request.post('/api/play', { data: { deck } });
  if (started.status() !== 201) throw new Error(`no game: ${await started.text()}`);
  const { match, status } = await started.json();
  const admin = await request.newContext({ baseURL });
  try {
    await admin.post('/api/auth/login', { data: ADMIN });
    const edit = await admin.post(`/api/play/${match.id}/state`,
      { data: { state: { ...snapshot, revision: status.revision + 1 }, command: '/test', lines: [] } });
    if (!edit.ok()) throw new Error(`the position was refused: ${await edit.text()}`);
  } finally {
    await admin.dispose();
  }
  return match.id;
}
