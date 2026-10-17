import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Every spec talks to the same single SQLite-backed server. Running
  // the suite in parallel makes concurrent writers contend for the
  // database lock and produces flaky failures, so keep it serial.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html']] : [['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // The SPA defaults to Chinese (see src/i18n/index.ts) unless the
    // `language` key is present in localStorage. The e2e specs match on
    // English copy (placeholders, button labels, headings), so seed the
    // key before any page script runs.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:5173',
          localStorage: [{ name: 'language', value: 'en' }],
        },
      ],
    },
  },
  globalSetup: './e2e/global-setup.ts',
  // chromium-only: the specs assert against the desktop board layout.
  // The mobile/responsive projects (Mobile Chrome/Safari) render a
  // different DOM (single-column pager, no batch-drag affordances), so
  // they are out of scope for this suite and would fail spuriously.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Both servers are managed here so `npx playwright test` is
  // self-contained. Locally an already-running instance is reused;
  // in CI Playwright starts them and waits for the URLs to answer.
  webServer: [
    {
      command: 'bash ../scripts/e2e-server.sh',
      url: 'http://localhost:8081/api/v1/health',
      reuseExistingServer: !process.env.CI,
      timeout: 180 * 1000,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
    },
  ],
});