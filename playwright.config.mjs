import { defineConfig } from '@playwright/test';
// The site runs behind the account server's login gate. The server starts on a fresh database with one
// administrator and the small test card library (tests/fixtures/card-library); the 'setup' project registers a player
// through the login page and the other tests reuse that session.
export const ADMIN = { username: 'admin', password: 'admin-pass-1' };
export const PLAYER_STATE = 'playwright/.auth/player.json';
const DB = '.data/playwright.db';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: { baseURL: 'http://127.0.0.1:8791', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.mjs/ },
    { name: 'site', testMatch: /\.spec\.mjs/, dependencies: ['setup'], use: { storageState: PLAYER_STATE } },
  ],
  webServer: {
    command: `npm run web:build && rm -f ${DB} ${DB}-wal ${DB}-shm && node scripts/user-admin.mjs add ${ADMIN.username} --admin --db ${DB} && node server/main.mjs --db ${DB} --card-library tests/fixtures/card-library`,
    env: { PORT: '8791', USER_PASSWORD: ADMIN.password },
    url: 'http://127.0.0.1:8791/play/login.html',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
