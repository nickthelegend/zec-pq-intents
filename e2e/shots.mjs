// Takes the README screenshots (docs/img/) from the running stack (./stack.sh) in Google Chrome:
// the terminal and the landing at 1280 and 375 px wide, after the tape has verified every entry.
//   cd e2e && ./stack.sh && node shots.mjs; ./stack.sh stop
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const port = (n, d) => process.env[`YAKSOK_${n}_PORT`] ?? String(d);
const LANDING = `http://127.0.0.1:${port('LANDING', 4183)}/`;
const TERMINAL = `http://127.0.0.1:${port('TERMINAL', 5181)}/`;
const out = resolve(import.meta.dirname, '../docs/img');
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [name, url, done] of [
    ['terminal', TERMINAL, () => { const c = [...document.querySelectorAll('[data-check]')]; return c.length > 0 && c.every((e) => e.getAttribute('data-check') === 'ok'); }],
    ['landing', LANDING, () => document.querySelector('#verify-state')?.textContent === 'verified in this tab'],
  ]) {
    for (const [suffix, viewport, scale] of [['', { width: 1280, height: 800 }, 1], ['-375', { width: 375, height: 812 }, 2]]) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: scale, reducedMotion: 'reduce' });
      await page.goto(url);
      await page.waitForFunction(done, null, { timeout: 30_000 }); // every signature verified in the tab
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (wide) throw new Error(`${name}${suffix}: the page scrolls sideways`);
      await page.screenshot({ path: `${out}/${name}${suffix}.png` });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`screenshots in ${out}`);
