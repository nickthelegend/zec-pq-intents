import { defineConfig } from '@playwright/test';

// Real Google Chrome (channel: 'chrome') against the stack from ./stack.sh: the static landing, the
// built Yaksok terminal (vite preview) and two read-only desks serving the published testnet records
// (Oct 20 and pass 2). Nothing is mocked and no wallet or chain is touched.
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    channel: 'chrome',
    headless: true,
    video: 'on',
    trace: 'on',
    screenshot: 'on',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  ],
});
