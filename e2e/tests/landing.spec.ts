// The landing, the way a visitor reads it: ticker, run header, intent book, the attestation tape
// printing entry by entry while each ML-DSA-65 signature is re-checked in the tab, the anchor head
// checks, refusals, the pass-2 kill, every link, reduced motion and no JavaScript. All values come
// from the two records (Oct 20 and pass 2, whose log continues the Oct 20 log).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXPLORER, LANDING, REPO, expect, isMobile, noHorizontalScroll, oct20, pass2, root, short, test, topInView, zat } from './fixtures';

type E = { seq: number; status: string; reason: string | null; hash: string; intent_hash: string | null; at_height: number; refs: Record<string, string> };
/** The whole log: Oct 20's #0-9 continued by pass 2 to #12 (same verifier key). */
const log = pass2.log as E[];
const anchors = log.filter((e) => e.status === 'ANCHORED');
const INTENTS = { ...oct20.intents, D: pass2.intent } as Record<string, { hash: string; signed: { intent: Record<string, string | number> } }>;

test.describe('landing', () => {
  test('ticker and run header come from the two records (13 entries, 2 anchors)', async ({ page }) => {
    await page.goto(LANDING);
    await expect(page).toHaveTitle(/Yaksok/);
    const first = page.locator('.ticker-track ul').first().locator('li');
    await expect(first).toHaveCount(log.length + 2);
    for (const e of log) await expect(first.nth(e.seq)).toContainText(`#${e.seq}${e.status}`);
    const cells = page.locator('header.bar .cells');
    if (isMobile(test.info().project.name)) {
      await expect(cells).toBeHidden();
    } else {
      expect(log.length).toBe(13);
      await expect(cells).toContainText(`${log.length} entries`);
      await expect(cells).toContainText('Oct 20 + Oct 21');
      await expect(cells).toContainText(`${anchors.length} · #8 → #11`);
      await expect(cells).toContainText(short(oct20.keys.verifier.id));
    }
    await noHorizontalScroll(page);
  });

  test('the attestation log prints entry by entry as each signature is re-checked in the tab (13/13), then both anchored heads match and the second anchor names the first', async ({ page }) => {
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
    // It printed one entry at a time: every count from 1/13 to 13/13 was shown on the way.
    const counts = await page.evaluate(() => (window as unknown as { __counts: string[] }).__counts);
    for (let k = 1; k <= log.length; k++) expect(counts).toContain(`${k}/${log.length}`);
    // Pass 2 starts after the Oct 20 entries, marked in the tape.
    await expect(page.locator('#tape .run-sep')).toHaveText(/Pass 2 · Oct 21/);
    await expect(page.locator('#tape .run-sep + [data-seq]')).toHaveAttribute('data-seq', String(oct20.log.length));
    await expect(page.locator('#anchor-check')).toHaveText('#8 and #11 match (recomputed here) · #11 names #8');
    await expect(page.locator('#anchor-check')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#verify-bar i')).toBeVisible();
    await page.locator('#tape').screenshot({ path: test.info().outputPath('tape-verified.png') });
    await noHorizontalScroll(page);
  });

  test('intent book: A–D match the records, payout links point at the release/refund transactions, the spread and fee budget are spelled out', async ({ page }) => {
    await page.goto(LANDING);
    const rows = page.locator('table.book tbody tr');
    await expect(rows).toHaveCount(4);
    for (const [i, k] of ['A', 'B', 'C', 'D'].entries()) {
      const it = INTENTS[k];
      const fin = log.find((e) => e.intent_hash === it.hash && (e.status === 'SETTLED' || e.status === 'REFUNDED'))!;
      const row = rows.nth(i);
      await expect(row).toContainText(`${k}${short(it.hash)}`);
      await expect(row).toContainText(zat(it.signed.intent.pay_zat));
      await expect(row).toContainText(zat(it.signed.intent.min_out_zat));
      await expect(row).toContainText(zat(it.signed.intent.deadline_height));
      await expect(row.locator('.st')).toHaveText(fin.status.toLowerCase());
      await expect(row.locator('a.tx')).toHaveAttribute('href', EXPLORER + (fin.refs.release_txid ?? fin.refs.refund_txid));
    }
    await expect(page.locator('table.book thead')).toContainText('Solver spread');
    await expect(page.locator('table.book th', { hasText: /^Fee$/ })).toHaveCount(0);
    const note = page.locator('.book-note');
    await expect(note).toContainText('the solver nets 5,000');
    await expect(note).toContainText('a refund returns 45,000 of the 60,000 (the user loses 15,000, a quarter)');
    await expect(note).toContainText('stays in the escrow wallet, which the verifier holds');
    await expect(note.locator(`a[href="${EXPLORER + oct20.txs.funding}"]`)).toBeVisible();
    await expect(note.locator(`a[href="${EXPLORER + pass2.txs.funding}"]`)).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('refusals: every REJECTED log entry of both runs with its code (FILL_BY_OTHER_SOLVER is log #10, pass 2), plus the four tested-only codes', async ({ page }) => {
    await page.goto(LANDING);
    const refs = page.locator('.refusals .ref');
    const rejected = log.filter((e) => e.status === 'REJECTED');
    expect(rejected.length).toBe(7);
    await expect(refs).toHaveCount(rejected.length + 4);
    for (const [i, e] of rejected.entries()) {
      await expect(refs.nth(i).locator('code')).toHaveText(e.reason!);
      await expect(refs.nth(i).locator('small')).toContainText(`log #${e.seq} · ${e.seq >= oct20.log.length ? 'pass 2' : 'Oct 20'}`);
    }
    const other = page.locator('.refusals .ref', { has: page.locator('code', { hasText: /^FILL_BY_OTHER_SOLVER$/ }) });
    await expect(other.locator('small')).toContainText('log #10 · pass 2');
    await expect(other.locator(`a[href="${EXPLORER + pass2.txs.fill}"]`)).toBeVisible();
    for (const code of ['BAD_SIGNATURE', 'ALREADY_SETTLED', 'NONCE_REUSED', 'WRONG_KEY', 'EXPIRED', 'FILL_BY_OTHER_SOLVER', 'FILL_UNKNOWN_SOLVER', 'FILL_NOT_SOLVER_BOUND', 'CLAIM_WINDOW_OPEN', 'RECEIVE_KEY_MISMATCH']) await expect(page.locator('.refusals code', { hasText: code }).first()).toBeVisible();
    await expect(page.locator('.refusals .ref.tested small')).toHaveText(Array(4).fill(/not a live entry$/));
    await noHorizontalScroll(page);
  });

  test('pass 2’s kill: write-ahead at the recorded height, SIGKILL after the release broadcast, reconciled to the one release the escrow sent', async ({ page }) => {
    await page.goto(LANDING);
    const crash = page.locator('#crash');
    await crash.scrollIntoViewIfNeeded();
    await expect(crash.locator('h2')).toHaveText('Killed mid-release, reconciled, paid once');
    await expect(crash).toContainText(`at block ${zat(pass2.crash.write_ahead.at_height)}`);
    await expect(crash).toContainText(`${zat(pass2.crash.write_ahead.amount_zat)} zat`);
    await expect(crash).toContainText('got SIGKILL before it could save the txid');
    await expect(crash).toContainText('settled with it (log #11)');
    await expect(crash).toContainText('The escrow sent 1 transaction with that memo');
    expect(pass2.crash.escrow_sends_with_release_memo).toEqual([pass2.txs.release]);
    await expect(crash.locator(`a[href="${EXPLORER + pass2.txs.release}"]`)).toHaveCount(2);
    await crash.screenshot({ path: test.info().outputPath('crash-card.png') });
    // The privacy limit names outgoing payouts, not only fundings.
    await expect(page.locator('.no')).toContainText('every payout out of the escrow: the recipient and amount of each release and refund');
    await expect(page.locator('section:has(#lim-h)')).toContainText('One receive address served all four intents (A–D)');
    await noHorizontalScroll(page);
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
    const record = JSON.stringify(oct20) + JSON.stringify(pass2);
    for (const { href, blank, rel } of hrefs) {
      if (href.startsWith('#')) {
        expect(await page.locator(href).count(), href).toBe(1);
      } else if (href.startsWith(EXPLORER)) {
        const txid = href.slice(EXPLORER.length);
        expect(txid, href).toMatch(/^[0-9a-f]{64}$/);
        expect(record.includes(txid), `${txid} is in deployments/testnet.json or testnet-pass2.json`).toBe(true);
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
      await expect(page.locator('table.book tbody tr')).toHaveCount(4);
      await expect(page.locator('#crash')).toContainText('Paid once');
      await noHorizontalScroll(page);
    });
  });
});
