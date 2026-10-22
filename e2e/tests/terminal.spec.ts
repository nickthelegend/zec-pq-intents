// The Yaksok terminal (dashboard), the way a user clicks through it: the tape (the attestation log)
// re-verifying entry by entry, every log entry opened in the inspector, every "log #n · open in the
// inspector" refusal, the intent book, the anchor head and the anchor chain across both runs, the
// attack console, links, reduced motion. Values are compared against the records.
import { EXPLORER, REPO, TERMINAL, expect, fullyInView, isMobile, noHorizontalScroll, oct20, pass2, short, test, zat } from './fixtures';

type E = { seq: number; status: string; reason: string | null; hash: string; prev: string; intent_hash: string | null; at_height: number; refs: Record<string, string> };
const log = oct20.log as E[];
const N = log.length;

test.describe('terminal', () => {
  test('the attestation tape prints entry by entry as each ML-DSA-65 signature verifies; the bar ends at 10/10', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __meta: string[] };
      w.__meta = [];
      new MutationObserver(() => {
        const m = document.querySelector('#tape-h + .meta');
        if (m && w.__meta[w.__meta.length - 1] !== m.textContent) w.__meta.push(m.textContent ?? '');
      }).observe(document, { childList: true, characterData: true, subtree: true });
    });
    await page.goto(TERMINAL);
    await expect(page).toHaveTitle(/Yaksok terminal/);
    const tape = page.locator('.tape li');
    await expect(tape).toHaveCount(N);
    await expect(page.locator('#tape-h + .meta')).toHaveText(`${N}/${N} signatures verify`, { timeout: 20_000 });
    const seen = await page.evaluate(() => (window as unknown as { __meta: string[] }).__meta);
    for (let k = 1; k < N; k++) expect(seen, 'printed one entry at a time').toContain(`verifying ${k}/${N}…`);
    for (let i = 0; i < N; i++) {
      await expect(tape.nth(i)).toHaveAttribute('data-check', 'ok');
      await expect(tape.nth(i).locator('.sig')).toHaveText('sig ok');
      await expect(tape.nth(i).locator('.st')).toHaveText(log[i].status);
    }
    if (!isMobile(test.info().project.name)) await expect(page.locator('.bar .cell', { hasText: 'Signatures' })).toContainText(`${N}/${N} verified here`);
    await noHorizontalScroll(page);
  });

  test('every tape row (log entry) opens in the inspector, fully on screen, with the entry the record has', async ({ page }) => {
    await page.goto(TERMINAL);
    await expect(page.locator('#tape-h + .meta')).toHaveText(`${N}/${N} signatures verify`, { timeout: 20_000 });
    const inspector = page.locator('#inspector');
    for (const e of log) {
      const row = page.locator('.tape li button').nth(e.seq);
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await expect(row).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#ins-h')).toHaveText(`Entry #${e.seq}`);
      await expect(inspector.locator('.ph .st')).toHaveText(e.status);
      await expect(inspector.locator('dd[title="' + e.hash + '"]')).toHaveText(short(e.hash, 16));
      await expect(inspector.locator('dd[title="' + e.prev + '"]')).toBeVisible();
      await expect(inspector).toContainText('ML-DSA-65 verifies');
      await expect(inspector).toContainText(zat(e.at_height));
      if (e.reason) await expect(inspector.locator('code.no')).toHaveText(e.reason);
      for (const [k, v] of Object.entries(e.refs)) if (k.endsWith('_txid')) await expect(inspector.locator(`a.tx[href="${EXPLORER + v}"]`)).toBeVisible();
      await fullyInView(inspector);
    }
    await page.screenshot({ path: test.info().outputPath('inspector-entry-9.png') });
    await noHorizontalScroll(page);
  });

  test('every refusal button ("log #n · open in the inspector") opens that signed entry in the inspector', async ({ page }) => {
    await page.goto(TERMINAL);
    const refs = page.locator('.refusals button.ref');
    const decided = Object.values(oct20.attacks.decisions as Record<string, number>).filter((s) => log[s].status === 'REJECTED');
    await expect(refs).toHaveCount(decided.length);
    const labelled = page.getByRole('button', { name: /log #\d+/ });
    await expect(labelled).toHaveCount(decided.length);
    for (let i = 0; i < decided.length; i++) {
      const seq = decided[i];
      const b = refs.nth(i);
      await expect(b.locator('small')).toHaveText(`log #${seq} · open in the inspector`);
      await expect(b.locator('code')).toHaveText(log[seq].reason!);
      await b.scrollIntoViewIfNeeded();
      await b.click();
      await expect(page.locator('#ins-h')).toHaveText(`Entry #${seq}`);
      await expect(page.locator('#inspector code.no')).toHaveText(log[seq].reason!);
      await expect(page.locator('.tape li button').nth(seq)).toHaveAttribute('aria-pressed', 'true');
      await fullyInView(page.locator('#inspector'));
    }
    for (const code of ['BAD_SIGNATURE', 'ALREADY_SETTLED', 'NONCE_REUSED', 'WRONG_KEY', 'EXPIRED']) await expect(page.locator('.refusals code', { hasText: code })).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('refusal-opened.png') });
  });

  test('intent book: A, B and C each show their steps, transactions and log entries from the record', async ({ page }) => {
    await page.goto(TERMINAL);
    const book = page.getByRole('radiogroup', { name: 'Intents' });
    await expect(book.getByRole('radio')).toHaveCount(3);
    for (const k of ['A', 'B', 'C']) {
      const it = oct20.intents[k];
      const radio = book.getByRole('radio').filter({ hasText: short(it.hash) });
      await radio.click();
      await expect(radio).toHaveAttribute('aria-checked', 'true');
      const steps = page.locator('.steps');
      await expect(steps).toContainText(`ML-DSA-65 by user ${short(it.signed.intent.user)}`);
      await expect(steps.locator(`a[href="${EXPLORER + oct20.txs.funding}"]`)).toBeVisible();
      const entries = log.filter((e) => e.intent_hash === it.hash);
      await expect(page.getByText('Log entries for this intent:')).toHaveText(`Log entries for this intent: ${entries.map((e) => `#${e.seq}`).join(', ')}`);
      const fin = entries.find((e) => e.status === 'SETTLED' || e.status === 'REFUNDED')!;
      if (k === 'C') {
        await expect(steps).toContainText('wrong memo');
        await expect(steps.locator(`a[href="${EXPLORER + oct20.txs.wrongMemoFill}"]`)).toBeVisible();
        await expect(steps.locator(`a[href="${EXPLORER + oct20.txs.lateFill}"]`)).toBeVisible();
        await expect(steps).toContainText(`Refunded ${zat(fin.refs.refunded_zat)} zat to the user`);
        await expect(steps.locator(`a[href="${EXPLORER + fin.refs.refund_txid}"]`)).toBeVisible();
      } else {
        await expect(steps.locator(`a[href="${EXPLORER + oct20.txs.fills[it.hash]}"]`)).toBeVisible();
        await expect(steps).toContainText(`Released ${zat(fin.refs.released_zat)} zat to the solver`);
        await expect(steps.locator(`a[href="${EXPLORER + fin.refs.release_txid}"]`)).toBeVisible();
      }
      await expect(radio.locator('.st')).toHaveText(fin.status.toLowerCase());
    }
    await page.keyboard.press('Tab'); // the book stays keyboard-usable after a pick
    await noHorizontalScroll(page);
  });

  test('anchor: head recomputed here; "Check the anchor chain" verifies both runs as one chain (#8 → #11)', async ({ page }) => {
    await page.goto(TERMINAL);
    const anc = page.locator('section', { has: page.locator('#anc-h') });
    const a = log.find((e) => e.status === 'ANCHORED')!;
    await expect(anc.locator('dd[data-state]').first()).toHaveText(`equals entry #${a.refs.anchored_seq} (recomputed here)`);
    await expect(anc.locator('dd[data-state]').first()).toHaveAttribute('data-state', 'ok', { timeout: 20_000 });
    await expect(anc.getByText('not checked yet')).toBeVisible();
    const btn = anc.getByRole('button', { name: 'Check the anchor chain' });
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const hist = pass2.anchors.escrowHistory as { txid: string }[];
    const result = anc.locator('.chain dd');
    await expect(result).toHaveAttribute('data-state', 'ok');
    await expect(result).toHaveText(`one chain, ${hist.length} anchors, no fork: #8 → #11 · ${pass2.log.length}/${pass2.log.length} pass-2 signatures verify`);
    await expect(anc.locator(`a[href="${EXPLORER + pass2.txs.previousAnchor}"]`).first()).toBeVisible();
    await expect(anc.locator(`a[href="${EXPLORER + pass2.txs.anchor}"]`)).toBeVisible();
    await expect(anc).toContainText(`names ${short(pass2.txs.previousAnchor)}`);
    await expect(anc.getByRole('button', { name: 'Check the anchor chain again' })).toBeEnabled();
    await anc.screenshot({ path: test.info().outputPath('anchor-chain.png') });
    await noHorizontalScroll(page);
  });

  test('attack console: a changed field and the attacker key are refused with the verifier codes; the original verifies', async ({ page }) => {
    await page.goto(TERMINAL);
    const con = page.locator('section', { has: page.locator('#con-h') });
    await expect(con.locator('ol.out')).toHaveText('No checks run yet. The results print here, newest first.');
    await expect(con.locator('b[data-state="ok"]')).toHaveText('yes');
    const out = con.locator('ol.out li');
    for (const f of ['min_out_zat', 'pay_zat', 'receive_ua', 'deadline_height', 'nonce']) {
      await con.getByRole('combobox').selectOption(f);
      await con.getByRole('button', { name: 'Change and verify' }).click();
      await expect(out.first()).toContainText(`A with ${f} changed → BAD_SIGNATURE`);
      await expect(out.first().locator('[data-state]')).toHaveText('REF');
      await expect(out.first()).toContainText(`≠ ${short(oct20.intents.A.hash)}`);
    }
    await con.getByRole('button', { name: "Attacker's key" }).click();
    await expect(out.first()).toContainText('attacker intent → WRONG_KEY');
    await expect(out.first()).toContainText(`names ${short(oct20.attacks.forgedAsUser.intent.user)}`);
    await con.getByRole('button', { name: 'Original' }).click();
    await expect(out.first()).toContainText(`A as signed → verifies · hash ${short(oct20.intents.A.hash)}`);
    await expect(out.first().locator('[data-state]')).toHaveText('OK');
    for (let i = 0; i < 3; i++) await con.getByRole('button', { name: 'Original' }).click();
    await expect(out).toHaveCount(8); // newest 8 kept
    await con.screenshot({ path: test.info().outputPath('attack-console.png') });
    await noHorizontalScroll(page);
  });

  test('every control labelled "log" works; links go to the repo and the explorer', async ({ page }) => {
    await page.goto(TERMINAL);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
    await expect(page.locator('#tape-h + .meta')).toHaveText(`${N}/${N} signatures verify`, { timeout: 20_000 });
    const controls = page.locator('button, a[href]').filter({ hasText: /log/i });
    const n = await controls.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const c = controls.nth(i);
      const label = (await c.innerText()).replace(/\s+/g, ' ');
      const seq = Number(/#(\d+)/.exec(label)?.[1]);
      await c.scrollIntoViewIfNeeded();
      await c.click();
      await expect(page.locator('#ins-h'), `"${label}" opens its entry`).toHaveText(`Entry #${seq}`);
      await fullyInView(page.locator('#inspector'));
    }
    await expect(page.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', `${REPO}/blob/main/packages/docs/README.md`);
    await expect(page.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', REPO);
  });

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });
    test('ticker stands still with one copy; the tape verifies without the print delay', async ({ page }) => {
      await page.goto(TERMINAL);
      await expect(page.locator('.ticker-track')).toHaveCSS('animation-name', 'none');
      await expect(page.locator('.ticker-track ul[aria-hidden]')).toBeHidden();
      await expect(page.locator('#tape-h + .meta')).toHaveText(`${N}/${N} signatures verify`, { timeout: 5_000 });
      await expect(page.locator('.tape li').first()).toHaveCSS('transition-duration', '0s');
      await noHorizontalScroll(page);
    });
  });
});
