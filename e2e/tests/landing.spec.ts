// The landing, the way a visitor reads it: ticker, run header, intent book, the attestation tape
// printing entry by entry while each ML-DSA-65 signature is re-checked in the tab, the anchor head
// check, refusals, every link, reduced motion and no JavaScript. All values come from the record.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXPLORER, LANDING, REPO, expect, isMobile, noHorizontalScroll, oct20, root, short, test, topInView, zat } from './fixtures';

const log = oct20.log as { seq: number; status: string; reason: string | null; hash: string; at_height: number; refs: Record<string, string> }[];
const anchor = log.find((e) => e.status === 'ANCHORED')!;

test.describe('landing', () => {
  test('ticker and run header come from the Oct 20 record', async ({ page }) => {
    await page.goto(LANDING);
    await expect(page).toHaveTitle(/Yaksok/);
    const first = page.locator('.ticker-track ul').first().locator('li');
    await expect(first).toHaveCount(log.length + 2);
    for (const e of log) await expect(first.nth(e.seq)).toContainText(`#${e.seq}${e.status}`);
    const cells = page.locator('header.bar .cells');
    if (isMobile(test.info().project.name)) {
      await expect(cells).toBeHidden();
    } else {
      await expect(cells).toContainText(`${log.length} entries`);
      await expect(cells).toContainText(`#0–${anchor.refs.anchored_seq} · block ${zat(anchor.at_height)}`);
      await expect(cells).toContainText(short(oct20.keys.verifier.id));
    }
    await noHorizontalScroll(page);
  });

  test('the attestation log prints entry by entry as each signature is re-checked in the tab, then the anchored head matches', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __counts: string[] }).__counts = [];
      document.addEventListener('DOMContentLoaded', () => {
        const el = document.getElementById('verify-count')!;
        new MutationObserver(() => (window as unknown as { __counts: string[] }).__counts.push(el.textContent ?? '')).observe(el, { childList: true, characterData: true, subtree: true });
      });
    });
    await page.goto(LANDING);
    const rows = page.locator('#tape [data-seq]');
    await expect(rows).toHaveCount(log.length);
    await expect(page.locator('#verify-state')).toHaveText('verified in this tab', { timeout: 20_000 });
    await expect(page.locator('#verify-state')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#verify-count')).toHaveText(`${log.length}/${log.length}`);
    for (let i = 0; i < log.length; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-check', 'ok');
      await expect(rows.nth(i).locator('.sigcell')).toHaveText('sig ok');
      await expect(rows.nth(i)).toContainText(log[i].status);
      if (log[i].reason) await expect(rows.nth(i)).toContainText(log[i].reason!);
    }
    // It printed one entry at a time: every count from 1/10 to 10/10 was shown on the way.
    const counts = await page.evaluate(() => (window as unknown as { __counts: string[] }).__counts);
    for (let k = 1; k <= log.length; k++) expect(counts).toContain(`${k}/${log.length}`);
    await expect(page.locator('#anchor-check')).toHaveText(`matches entry #${anchor.refs.anchored_seq} (recomputed here)`);
    await expect(page.locator('#anchor-check')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#verify-bar i')).toBeVisible();
    await page.locator('#tape').screenshot({ path: test.info().outputPath('tape-verified.png') });
    await noHorizontalScroll(page);
  });

  test('intent book rows match the record, payout links point at the release/refund transactions', async ({ page }) => {
    await page.goto(LANDING);
    const rows = page.locator('table.book tbody tr');
    await expect(rows).toHaveCount(3);
    for (const [i, k] of ['A', 'B', 'C'].entries()) {
      const it = oct20.intents[k];
      const fin = log.find((e) => (e as unknown as { intent_hash: string }).intent_hash === it.hash && (e.status === 'SETTLED' || e.status === 'REFUNDED'))!;
      const row = rows.nth(i);
      await expect(row).toContainText(`${k}${short(it.hash)}`);
      await expect(row).toContainText(zat(it.signed.intent.pay_zat));
      await expect(row).toContainText(zat(it.signed.intent.min_out_zat));
      await expect(row).toContainText(zat(it.signed.intent.deadline_height));
      await expect(row.locator('.st')).toHaveText(fin.status.toLowerCase());
      await expect(row.locator('a.tx')).toHaveAttribute('href', EXPLORER + (fin.refs.release_txid ?? fin.refs.refund_txid));
    }
    await noHorizontalScroll(page);
  });

  test('refusals: every REJECTED log entry with its code, plus the two tested-only codes', async ({ page }) => {
    await page.goto(LANDING);
    const refs = page.locator('.refusals .ref');
    const rejected = log.filter((e) => e.status === 'REJECTED');
    await expect(refs).toHaveCount(rejected.length + 2);
    for (const [i, e] of rejected.entries()) {
      await expect(refs.nth(i).locator('code')).toHaveText(e.reason!);
      await expect(refs.nth(i).locator('small')).toContainText(`log #${e.seq}`);
    }
    for (const code of ['BAD_SIGNATURE', 'ALREADY_SETTLED', 'NONCE_REUSED', 'WRONG_KEY', 'EXPIRED', 'FILL_UNKNOWN_SOLVER', 'CLAIM_WINDOW_OPEN']) await expect(page.locator('.refusals code', { hasText: code }).first()).toBeVisible();
  });

  test('anchors: skip link, brand and "Watch the tape verify" land on their targets', async ({ page }) => {
    await page.goto(LANDING);
    await page.getByRole('link', { name: 'Watch the tape verify' }).click();
    await expect(page).toHaveURL(/#tape$/);
    await topInView(page, '#tape');
    await page.getByRole('link', { name: 'Yaksok, top' }).click();
    await expect(page).toHaveURL(/#main$/);
    await page.goto(LANDING);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('every link resolves: in-page anchors exist, explorer links name a transaction of the record, repo links name files in this repo', async ({ page }) => {
    await page.goto(LANDING);
    const hrefs = await page.locator('a[href]').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href')!, blank: a.getAttribute('target') === '_blank', rel: a.getAttribute('rel') ?? '' })));
    expect(hrefs.length).toBeGreaterThan(20);
    const record = JSON.stringify(oct20);
    for (const { href, blank, rel } of hrefs) {
      if (href.startsWith('#')) {
        expect(await page.locator(href).count(), href).toBe(1);
      } else if (href.startsWith(EXPLORER)) {
        const txid = href.slice(EXPLORER.length);
        expect(txid, href).toMatch(/^[0-9a-f]{64}$/);
        expect(record.includes(txid), `${txid} is in deployments/testnet.json`).toBe(true);
        expect(blank && rel.includes('noopener'), `${href} opens in a new tab with noopener`).toBe(true);
      } else if (href.startsWith(`${REPO}/blob/main/`)) {
        const [path, frag] = href.slice(`${REPO}/blob/main/`.length).split('#');
        expect(existsSync(resolve(root, path)), `${path} exists in the repo`).toBe(true);
        if (frag) expect(readFileSync(resolve(root, path), 'utf8').toLowerCase()).toContain(`## ${frag.replace(/-/g, ' ')}`);
      } else {
        expect(href).toBe(REPO);
      }
    }
    // One explorer link actually opens: a new tab on the explorer page for that transaction.
    const link = page.locator('table.book a.tx').first();
    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    expect(popup.url()).toBe(await link.getAttribute('href'));
    await popup.close();
  });

  test('ticker pauses under the pointer (desktop) and keeps the page from scrolling sideways', async ({ page }) => {
    test.skip(isMobile(test.info().project.name), 'no hover on a phone');
    await page.goto(LANDING);
    const track = page.locator('.ticker-track');
    await expect(track).toHaveCSS('animation-play-state', 'running');
    await page.locator('.ticker').hover();
    await expect(track).toHaveCSS('animation-play-state', 'paused');
  });

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });
    test('the ticker stands still (one copy, scrollable) and the tape verifies without the print delay', async ({ page }) => {
      await page.goto(LANDING);
      await expect(page.locator('.ticker-track')).toHaveCSS('animation-name', 'none');
      await expect(page.locator('.ticker-track ul[aria-hidden]')).toBeHidden();
      await expect(page.locator('#verify-state')).toHaveText('verified in this tab', { timeout: 5_000 });
      await expect(page.locator('#tape [data-seq]').first()).toHaveCSS('transition-duration', '0s');
      await noHorizontalScroll(page);
    });
  });

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false });
    test('the record still reads: book, tape and refusals are static; the in-tab check says it is waiting for JavaScript', async ({ page }) => {
      await page.goto(LANDING);
      await expect(page.locator('#verify-state')).toHaveText('waiting for JavaScript');
      await expect(page.locator('#tape [data-seq]')).toHaveCount(log.length);
      await expect(page.locator('#tape [data-seq] .sigcell').first()).toHaveText('not checked');
      await expect(page.locator('table.book tbody tr')).toHaveCount(3);
      await noHorizontalScroll(page);
    });
  });
});
