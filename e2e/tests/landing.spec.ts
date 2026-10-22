// The landing, the way a visitor reads it: ticker, run header, intent book, the attestation tape
// printing entry by entry while each ML-DSA-65 signature is re-checked in the tab, the anchor head
// checks, refusals, the pass-2 kill, every link, reduced motion and no JavaScript. All values come
// from the two records (Oct 20 and pass 2, whose log continues the Oct 20 log).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXPLORER, FUNDING, INTENTS, LANDING, REPO, expect, isMobile, latest, noHorizontalScroll, oct20, pass2, pass3, root, short, test, topInView, zat } from './fixtures';

type E = { seq: number; status: string; reason: string | null; hash: string; intent_hash: string | null; at_height: number; refs: Record<string, string> };
/** The whole log: Oct 20's #0-9 continued by pass 2 to #12 and by pass 3 (same verifier key). */
const log = latest.log as E[];
const anchors = log.filter((e) => e.status === 'ANCHORED');
const anchorPath = anchors.map((a) => `#${a.refs.anchored_seq}`).join(' → ');
const LETTERS = Object.keys(INTENTS);

test.describe('landing', () => {
  test('ticker and run header come from the records (every entry, every anchor)', async ({ page }) => {
    await page.goto(LANDING);
    await expect(page).toHaveTitle(/Yaksok/);
    const first = page.locator('.ticker-track ul').first().locator('li');
    await expect(first).toHaveCount(log.length + 2);
    for (const e of log) await expect(first.nth(e.seq)).toContainText(`#${e.seq}${e.status}`);
    const cells = page.locator('header.bar .cells');
    if (isMobile(test.info().project.name)) {
      await expect(cells).toBeHidden();
    } else {
      expect(log.length).toBeGreaterThanOrEqual(13);
      await expect(cells).toContainText(`${log.length} entries`);
      await expect(cells).toContainText(pass3 ? 'Oct 20 + Oct 21 + Oct 22' : 'Oct 20 + Oct 21');
      await expect(cells).toContainText(`${anchors.length} · ${anchorPath}`);
      await expect(cells).toContainText(short(oct20.keys.verifier.id));
    }
    await noHorizontalScroll(page);
  });

  test('the attestation log prints entry by entry as each signature is re-checked in the tab, then every anchored head matches and each anchor names the one before', async ({ page }) => {
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
    // It printed one entry at a time: every count from 1/N to N/N was shown on the way.
    const counts = await page.evaluate(() => (window as unknown as { __counts: string[] }).__counts);
    for (let k = 1; k <= log.length; k++) expect(counts).toContain(`${k}/${log.length}`);
    // Pass 2 starts after the Oct 20 entries, marked in the tape.
    await expect(page.locator('#tape .run-sep').first()).toHaveText(/Pass 2 · Oct 21/);
    await expect(page.locator('#tape .run-sep + [data-seq]').first()).toHaveAttribute('data-seq', String(oct20.log.length));
    if (pass3) await expect(page.locator('#tape .run-sep').nth(1)).toHaveText(/Pass 3 · Oct 22 · an agent through MCP/);
    const seqs = anchors.map((a) => `#${a.refs.anchored_seq}`);
    await expect(page.locator('#anchor-check')).toHaveText(`${seqs.join(' and ')} match (recomputed here) · ${seqs.slice(1).map((s, i) => `${s} names ${seqs[i]}`).join(', ')}`);
    await expect(page.locator('#anchor-check')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#verify-bar i')).toBeVisible();
    await page.locator('#tape').screenshot({ path: test.info().outputPath('tape-verified.png') });
    await noHorizontalScroll(page);
  });

  test('intent book: every intent matches the records, payout links point at the release/refund transactions, the spread and fee budget are spelled out', async ({ page }) => {
    await page.goto(LANDING);
    const rows = page.locator('table.book tbody tr');
    await expect(rows).toHaveCount(LETTERS.length);
    for (const [i, k] of LETTERS.entries()) {
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
    await expect(note).toContainText('For A–D (escrow 60,000, deliver 40,000) a release is 45,000');
    await expect(note).toContainText('a refund returns 45,000 of the 60,000 (the user loses 15,000, a quarter)');
    if (pass3) {
      // E's own numbers, from its record: not the A–D figures.
      const e = pass3.intent.signed.intent;
      const settledE = pass3.log.find((x: { status: string; intent_hash: string | null }) => x.status === 'SETTLED' && x.intent_hash === pass3.intent.hash);
      expect(Number(e.pay_zat) - 15_000).toBe(Number(settledE.refs.released_zat));
      await expect(note).toContainText(`For E (escrow ${zat(e.pay_zat)}, deliver ${zat(e.min_out_zat)}) the release was ${zat(settledE.refs.released_zat)}`);
      await expect(note).toContainText(`a refund would have returned ${zat(pass3.agent.quote.refund_if_unfilled_zat)} of the ${zat(e.pay_zat)}`);
    }
    await expect(note).toContainText('stays in the escrow wallet, which the verifier holds');
    await expect(note.locator(`a[href="${EXPLORER + oct20.txs.funding}"]`)).toBeVisible();
    for (const k of LETTERS) await expect(note.locator(`a[href="${EXPLORER + FUNDING[k]}"]`)).toBeVisible();
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
      await expect(refs.nth(i).locator('small')).toContainText(`log #${e.seq} · ${e.seq >= pass2.log.length ? 'pass 3' : e.seq >= oct20.log.length ? 'pass 2' : 'Oct 20'}`);
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
    await expect(page.locator('section:has(#lim-h)')).toContainText('A new address does not unlink one user’s intents: every settled or refunded entry in the public log names the user’s key id and nonce');
    await noHorizontalScroll(page);
  });

  test('pass 3: the agent’s intent E through MCP — quote, submit_intent to a new address, the desk killed after the fill broadcast, the fill found and not resent, settled, audited', async ({ page }) => {
    test.skip(!pass3, 'pass 3 not recorded');
    const p3 = pass3!;
    await page.goto(LANDING);
    const agent = page.locator('#agent');
    await agent.scrollIntoViewIfNeeded();
    await expect(agent.locator('h2')).toHaveText('An agent trades through MCP, live');
    await expect(agent).toContainText(`a new receive address (index ${zat(p3.agent.receive_index)}), not one A–D used`);
    expect([oct20.intents.A, oct20.intents.B, oct20.intents.C, pass2.intent].map((i: { signed: { intent: { receive_ua: string } } }) => i.signed.intent.receive_ua)).not.toContain(p3.agent.receive_ua);
    await expect(agent).toContainText(`got SIGKILL right after the solver’s fill broadcast, with its write-ahead record at block ${zat(p3.crash.board_after_kill.delivering.at_height)}`);
    await expect(agent).toContainText('it was adopted, sent once');
    expect(p3.crash.solver_sends_with_fill_memo).toEqual([p3.txs.fill]);
    for (const t of [p3.txs.funding, p3.txs.fill, p3.txs.release, p3.txs.anchor]) await expect(agent.locator(`a[href="${EXPLORER + t}"]`)).toBeVisible();
    await expect(agent).toContainText(`verify_log over MCP: ok, ${p3.checks.verify_log.entries} entries, ${p3.checks.verify_log.anchor.anchors} anchors`);
    await expect(agent).toContainText(`check-anchors with the escrow pinned: exit 0, ${p3.checks.check_anchors.chain.length} anchors in one chain`);
    await expect(page.locator('section:has(#mcp-h)')).toContainText('(ran live: intent E, pass 3)');
    await agent.screenshot({ path: test.info().outputPath('agent-path.png') });
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
        expect(record.includes(txid) || JSON.stringify(pass3).includes(txid), `${txid} is in a run record`).toBe(true);
        expect(blank && rel.includes('noopener'), `${href} opens in a new tab with noopener`).toBe(true);
      } else if (href === 'terminal/') {
        const r = await page.request.get(new URL(href, LANDING).toString());
        expect(r.status(), `${href} is served next to the landing`).toBe(200);
        expect(await r.text()).toContain('<title>Yaksok terminal');
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

  test('the ticker has a visible Pause/Play control (a phone has no hover) and names the runs it shows', async ({ page }) => {
    await page.goto(LANDING);
    const ticker = page.getByRole('region', { name: `Decisions from the ${pass3 ? 'three' : 'two'} testnet runs` });
    const track = ticker.locator('.ticker-track');
    await expect(track).toHaveCSS('animation-play-state', 'running');
    const away = async () => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.mouse.move(5, 700);
    };
    await ticker.getByRole('button', { name: 'Pause the scrolling decisions' }).click();
    await away();
    await expect(track).toHaveCSS('animation-play-state', 'paused');
    await ticker.getByRole('button', { name: 'Play the scrolling decisions' }).click();
    await away();
    await expect(track).toHaveCSS('animation-play-state', 'running');
  });

  test('“Open the terminal” opens the Yaksok terminal served next to the landing; it verifies 13/13 and links back', async ({ page }) => {
    await page.goto(LANDING);
    await expect(page.getByRole('navigation', { name: 'Links' }).getByRole('link', { name: 'Terminal' })).toHaveAttribute('href', 'terminal/');
    await page.getByRole('link', { name: 'Open the terminal' }).click();
    await expect(page).toHaveURL(new URL('terminal/', LANDING).toString());
    await expect(page).toHaveTitle(/Yaksok terminal/);
    await expect(page.locator('#tape-h + .meta')).toHaveText(`${log.length}/${log.length} signatures verify`, { timeout: 20_000 });
    await noHorizontalScroll(page);
    await page.getByRole('link', { name: 'Landing' }).click();
    await expect(page).toHaveURL(LANDING);
    await expect(page.locator('#verify-state')).toHaveText('verified in this tab', { timeout: 20_000 });
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
      await expect(page.locator('.ticker-toggle'), 'a control that cannot work stays hidden').toBeHidden();
      await expect(page.locator('#tape [data-seq]')).toHaveCount(log.length);
      await expect(page.locator('#tape [data-seq] .sigcell').first()).toHaveText('not checked');
      await expect(page.locator('table.book tbody tr')).toHaveCount(LETTERS.length);
      await expect(page.locator('#crash')).toContainText('Paid once');
      await noHorizontalScroll(page);
    });
  });
});
