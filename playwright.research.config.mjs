import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'full-game.zh-CN.spec.mjs',
  workers: 1,
  timeout: 900_000,
  use: { baseURL: 'http://127.0.0.1:8796', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run web:build && node scripts/serve-local-research.mjs',
    env: { PORT: '8796' },
    url: 'http://127.0.0.1:8796',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
