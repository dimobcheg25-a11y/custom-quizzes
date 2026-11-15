import { defineConfig } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run build && npx tsx src/server/index.ts',
    port: PORT,
    reuseExistingServer: false,
    env: { PORT: String(PORT), PACKS_DIR: 'tests/fixtures/packs' },
    timeout: 120_000,
  },
});
