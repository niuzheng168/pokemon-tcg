import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: { baseURL: 'http://127.0.0.1:8791', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run web:build && node tests/serve-web.mjs',
    env: { PORT: '8791' },
    url: 'http://127.0.0.1:8791',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
