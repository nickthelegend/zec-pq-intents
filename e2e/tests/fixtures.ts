import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as base, expect, type Locator, type Page } from '@playwright/test';

export * from './urls';
export const root = resolve(import.meta.dirname, '../..');
export const oct20 = JSON.parse(readFileSync(resolve(root, 'deployments/testnet.json'), 'utf8'));
export const pass2 = JSON.parse(readFileSync(resolve(root, 'deployments/testnet-pass2.json'), 'utf8'));
const P3 = resolve(root, 'deployments/testnet-pass3.json');
/** Pass 3 (Oct 22, the agent path), when it has been recorded. */
export const pass3 = existsSync(P3) ? JSON.parse(readFileSync(P3, 'utf8')) : null;
/** The newest record: its log holds every entry of the runs before it. */
export const latest = pass3 ?? pass2;
/** Every intent shown: A-C (Oct 20), D (pass 2), E (pass 3). */
export const INTENTS = { ...oct20.intents, D: pass2.intent, ...(pass3 ? { E: pass3.intent } : {}) } as Record<string, { hash: string; signed: { intent: Record<string, string | number> } }>;
export const FUNDING: Record<string, string> = { A: oct20.txs.funding, B: oct20.txs.funding, C: oct20.txs.funding, D: pass2.txs.funding, ...(pass3 ? { E: pass3.txs.funding } : {}) };
export const EXPLORER = 'https://testnet.zecblock.com/tx/';
export const REPO = 'https://github.com/nickthelegend/zec-pq-intents';
export const zat = (n: number | string) => Number(n).toLocaleString('en-US');
export const short = (s: string, n = 8) => `${s.slice(0, n)}…`;

type Health = { problems: string[]; expectBlocked: (url: string) => void };

/** Every test fails on a console error, an uncaught exception, or a failed same-origin request
 *  (any 127.0.0.1 port: the pages, the bundles and the desks). */
export const test = base.extend<{ health: Health }>({
  health: [
    async ({ page }, use) => {
      const problems: string[] = [];
      // A test that deliberately sends a request the browser must block (a cross-origin write) names
      // that URL; only Chrome's CORS block of that exact URL is then expected, nothing else.
      const blocked = new Set<string>();
      const same = (u: string) => u.startsWith('http://127.0.0.1:');
      const corsBlock = (text: string) => [...blocked].some((u) => text.includes(`Access to fetch at '${u}'`) && text.includes('blocked by CORS policy'));
      let blockedFailures = 0;
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        if (corsBlock(m.text())) return;
        if (blockedFailures > 0 && m.text() === 'Failed to load resource: net::ERR_FAILED') return void blockedFailures--;
        problems.push(`console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('requestfailed', (r) => {
        if (blocked.has(r.url()) && r.failure()?.errorText === 'net::ERR_FAILED') return void blockedFailures++;
        if (same(r.url())) problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`);
      });
      page.on('response', (r) => same(r.url()) && r.status() >= 400 && !blocked.has(r.url()) && problems.push(`HTTP ${r.status()}: ${r.url()}`));
      await use({ problems, expectBlocked: (u) => blocked.add(u) });
      expect(problems, 'console errors / failed same-origin requests').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export async function noHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `page is ${sw}px wide in a ${cw}px viewport`).toBeLessThanOrEqual(cw);
}

/** The element's top edge is inside the viewport (an anchor jump landed on it). */
export async function topInView(page: Page, selector: string) {
  await expect
    .poll(() => page.locator(selector).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= -2 && r.top < window.innerHeight - 40;
    }))
    .toBe(true);
}

/** The whole element is inside the viewport (it fits, and nothing of it is below the fold). */
export async function fullyInView(loc: Locator) {
  await expect
    .poll(() => loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= -2 && r.bottom <= window.innerHeight + 2;
    }))
    .toBe(true);
}

export const isMobile = (name: string) => name === 'mobile';
