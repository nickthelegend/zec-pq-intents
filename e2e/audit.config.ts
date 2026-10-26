import { defineConfig } from '@playwright/test';
import base from './playwright.config';
// Per-row audit-browser.mjs supplies the JPEG and full network/console evidence. Avoid recordings
// and automatic PNGs for this regression count; explicit spec screenshots stay in ignored outputs.
export default defineConfig({
  ...base,
  use: { ...base.use, video: 'off', trace: 'off', screenshot: 'off' },
  reporter: [['list'], ['json', { outputFile: '../audit/e2e/results.json' }]],
});
