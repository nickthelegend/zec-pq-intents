// The Yaksok terminal (dashboard), the way a user clicks through it: the tape (the attestation log of
// both runs, 13 entries) re-verifying entry by entry, every log entry opened in the inspector, every
// "log #n · open in the inspector" refusal, the intent book (A–D), the anchored heads and the anchor
// chain across both runs, the pass-2 kill, the attack console, links, reduced motion. Values are
// compared against the records.
import { EXPLORER, FUNDING, INTENTS, REPO, TERMINAL, expect, fullyInView, isMobile, latest, noHorizontalScroll, oct20, pass2, pass3, short, test, zat } from './fixtures';

type E = { seq: number; status: string; reason: string | null; hash: string; prev: string; intent_hash: string | null; at_height: number; refs: Record<string, string> };
/** Oct 20's #0-9 continued by pass 2 to #12 and by pass 3, under the same verifier key. */
const log = latest.log as E[];
const N = log.length;
const LETTERS = Object.keys(INTENTS);
const anchors = log.filter((e) => e.status === 'ANCHORED');

test.describe('terminal', () => {
  test('the attestation tape prints entry by entry as each ML-DSA-65 signature verifies; the bar ends at N/N', async ({ page }) => {
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
    expect(N).toBeGreaterThanOrEqual(13);
    const tape = page.locator('.tape li[data-check]');
    await expect(tape).toHaveCount(N);
    await expect(page.locator('#tape-h + .meta')).toHaveText(`${N}/${N} signatures verify`, { timeout: 20_000 });
    await expect(page.locator('.tape li.run-sep').first()).toHaveText(/Pass 2 · Oct 21/);
    if (pass3) await expect(page.locator('.tape li.run-sep').nth(1)).toHaveText(/Pass 3 · Oct 22/);
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
    await page.screenshot({ path: test.info().outputPath('inspector-entry-12.png') });
    await noHorizontalScroll(page);
  });

  test('every refusal button ("log #n · open in the inspector") opens that signed entry in the inspector', async ({ page }) => {
    await page.goto(TERMINAL);
    const refs = page.locator('.refusals button.ref');
    const decided = [...Object.values(oct20.attacks.decisions as Record<string, number>), pass2.theft.seq as number].filter((s) => log[s].status === 'REJECTED');
    expect(decided).toContain(10);
    await expect(refs).toHaveCount(decided.length);
    const labelled = page.locator('.refusals').getByRole('button', { name: /log #\d+/ });
    await expect(labelled).toHaveCount(decided.length);
    // more such buttons outside the refusals: the pass-2 crash panel's "log #11" and the pass-3 agent panel's (their own tests)
    await expect(page.getByRole('button', { name: /log #\d+/ })).toHaveCount(decided.length + 1 + (pass3 ? 1 : 0));
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
    for (const code of ['BAD_SIGNATURE', 'ALREADY_SETTLED', 'NONCE_REUSED', 'WRONG_KEY', 'EXPIRED', 'FILL_BY_OTHER_SOLVER']) await expect(page.locator('.refusals code', { hasText: code })).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('refusal-opened.png') });
  });

  test('intent book: every intent shows its steps, transactions and log entries from the records', async ({ page }) => {
    await page.goto(TERMINAL);
    const book = page.getByRole('radiogroup', { name: 'Intents' });
    await expect(book.getByRole('radio')).toHaveCount(LETTERS.length);
    for (const k of LETTERS) {
      const it = INTENTS[k];
      const radio = book.getByRole('radio').filter({ hasText: short(it.hash) });
      await radio.click();
      await expect(radio).toHaveAttribute('aria-checked', 'true');
      const steps = page.locator('.steps');
      await expect(steps).toContainText(`ML-DSA-65 by user ${short(it.signed.intent.user)}`);
      await expect(steps.locator(`a[href="${EXPLORER + FUNDING[k]}"]`)).toBeVisible();
      const entries = log.filter((e) => e.intent_hash === it.hash);
      await expect(page.getByText('Log entries for this intent:')).toHaveText(`Log entries for this intent: ${entries.map((e) => `#${e.seq}`).join(', ')}`);
      const fin = entries.find((e) => e.status === 'SETTLED' || e.status === 'REFUNDED')!;
      if (k === 'E') {
        await expect(steps).toContainText(`Submitted by an agent through MCP submit_intent, to a new receive address (index ${zat(pass3!.agent.receive_index)})`);
        await expect(steps.locator(`a[href="${EXPLORER + pass3!.txs.fill}"]`)).toBeVisible();
        await expect(steps).toContainText(`Released ${zat(fin.refs.released_zat)} zat to the solver`);
        await expect(steps.locator(`a[href="${EXPLORER + pass3!.txs.release}"]`)).toBeVisible();
      } else if (k === 'D') {
        await expect(steps.locator(`a[href="${EXPLORER + pass2.txs.fill}"]`)).toBeVisible();
        await expect(steps).toContainText('FILL_BY_OTHER_SOLVER (#10)');
        await expect(steps).toContainText('Killed by SIGKILL right after the release broadcast');
        await expect(steps).toContainText(`Released ${zat(fin.refs.released_zat)} zat to the solver`);
        await expect(steps.locator(`a[href="${EXPLORER + pass2.txs.release}"]`)).toBeVisible();
      } else if (k === 'C') {
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

  test('anchors: every head recomputed here; "Check the anchor chain" verifies the runs as one chain', async ({ page }) => {
    await page.goto(TERMINAL);
    const anc = page.locator('section', { has: page.locator('#anc-h') });
    await expect(anc.locator('dd[data-state]').first()).toHaveText(`${anchors.map((a) => `#${a.refs.anchored_seq}`).join(' and ')} equal the log's entries (recomputed here)`);
    await expect(anc).toContainText(`1 entry (#${anchors[anchors.length - 1].seq}, the anchor itself)`);
    await expect(anc.locator('dd[data-state]').first()).toHaveAttribute('data-state', 'ok', { timeout: 20_000 });
    await expect(anc.getByText('not checked yet')).toBeVisible();
    const btn = anc.getByRole('button', { name: 'Check the anchor chain' });
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const hist = latest.anchors.escrowHistory as { txid: string }[];
    const result = anc.locator('.chain dd');
    await expect(result).toHaveAttribute('data-state', 'ok');
    const chain = anchors.map((a) => `#${a.refs.anchored_seq}`).join(' → ');
    await expect(result).toHaveText(pass3 ? `one chain, ${hist.length} anchors, no fork: ${chain} · ${N}/${N} signatures verify` : `one chain, ${hist.length} anchors, no fork: ${chain} · ${N}/${N} pass-2 signatures verify`);
    await expect(anc.locator(`a[href="${EXPLORER + pass2.txs.previousAnchor}"]`).first()).toBeVisible();
    await expect(anc.locator(`a[href="${EXPLORER + latest.txs.anchor}"]`)).toHaveCount(2); // in "Anchor txs" and in the checked chain
    await expect(anc.locator(`a[href="${EXPLORER + latest.txs.anchor}"]`).last()).toBeVisible();
    await expect(anc).toContainText(`names ${short(latest.txs.previousAnchor)}`);
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

  test('pass 2’s kill: write-ahead, SIGKILL after the release broadcast, reconciled to the one release; its "log #11" opens the SETTLED entry', async ({ page }) => {
    await page.goto(TERMINAL);
    const crash = page.locator('#crash');
    await crash.scrollIntoViewIfNeeded();
    await expect(crash).toContainText(`saved (fsync) at block ${zat(pass2.crash.write_ahead.at_height)}`);
    await expect(crash).toContainText('then SIGKILL before its txid was saved');
    await expect(crash).toContainText('the escrow sent 1 transaction with that memo');
    await expect(crash.locator(`a[href="${EXPLORER + pass2.txs.release}"]`)).toBeVisible();
    await expect(page.locator('#tape-h + .meta')).toHaveText(`${N}/${N} signatures verify`, { timeout: 20_000 });
    await crash.getByRole('button', { name: 'log #11 · open in the inspector' }).click();
    await expect(page.locator('#ins-h')).toHaveText('Entry #11');
    await expect(page.locator('#inspector')).toContainText('SETTLED');
    await expect(page.locator(`#inspector a.tx[href="${EXPLORER + pass2.txs.release}"]`)).toBeVisible();
    await fullyInView(page.locator('#inspector'));
    await noHorizontalScroll(page);
  });

  test('pass 3: the agent panel shows E through MCP, the kill after the fill broadcast, the fill found and not resent, the audit; its "log #n" opens E’s SETTLED entry', async ({ page }) => {
    test.skip(!pass3, 'pass 3 not recorded');
    const p3 = pass3!;
    await page.goto(TERMINAL);
    const agent = page.locator('#agent');
    await agent.scrollIntoViewIfNeeded();
    await expect(agent).toContainText(`a new receive address (index ${zat(p3.agent.receive_index)})`);
    await expect(agent).toContainText(`SIGKILL right after the solver's fill broadcast (write-ahead at block ${zat(p3.crash.board_after_kill.delivering.at_height)})`);
    await expect(agent).toContainText('sent once');
    await expect(agent).toContainText(`verify_log over MCP ok (${p3.checks.verify_log.entries} entries, ${p3.checks.verify_log.anchor.anchors} anchors)`);
    for (const t of [p3.txs.funding, p3.txs.fill, p3.txs.release]) await expect(agent.locator(`a[href="${EXPLORER + t}"]`)).toBeVisible();
    await expect(page.locator('#tape-h + .meta')).toHaveText(`${N}/${N} signatures verify`, { timeout: 20_000 });
    const e = log.find((x) => x.status === 'SETTLED' && x.intent_hash === p3.intent.hash)!;
    await agent.getByRole('button', { name: `log #${e.seq} · open in the inspector` }).click();
    await expect(page.locator('#ins-h')).toHaveText(`Entry #${e.seq}`);
    await expect(page.locator(`#inspector a.tx[href="${EXPLORER + p3.txs.release}"]`)).toBeVisible();
    await fullyInView(page.locator('#inspector'));
    await noHorizontalScroll(page);
  });

  test('the ticker has a visible Pause/Play control (touch and keyboard too) and names the runs it shows; the intent book is one tab stop moved with the arrow keys', async ({ page }) => {
    await page.goto(TERMINAL);
    const ticker = page.getByRole('region', { name: `Decisions from the ${pass3 ? 'three' : 'two'} testnet runs` });
    await expect(ticker).toBeVisible();
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

    const book = page.getByRole('radiogroup', { name: 'Intents' });
    const radios = book.getByRole('radio');
    await expect(radios).toHaveCount(LETTERS.length);
    await expect(book.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
    await expect(book.locator('[role="radio"][tabindex="-1"]')).toHaveCount(LETTERS.length - 1);
    await radios.nth(0).focus();
    await page.keyboard.press('ArrowDown');
    await expect(radios.nth(1)).toBeFocused();
    await expect(radios.nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(radios.nth(0)).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press('End');
    await expect(radios.nth(LETTERS.length - 1)).toBeFocused();
    await expect(radios.nth(LETTERS.length - 1)).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(radios.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(radios.nth(LETTERS.length - 1)).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Home');
    await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true');
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
    const docs = page.locator('.acts a', { hasText: 'Docs' });
    await expect(docs).toHaveAttribute('href', `${REPO}/blob/main/packages/docs/README.md`);
    if (isMobile(test.info().project.name)) await expect(docs, 'the phone bar keeps Terminal/Landing and GitHub, as the landing does').toBeHidden();
    else await expect(docs).toBeVisible();
    await expect(page.getByRole('link', { name: 'Landing' }), 'served on its own, not under the landing: no way back to show').toHaveCount(0);
    await expect(page.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', REPO);
  });

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });
    test('ticker stands still with one copy; the tape verifies without the print delay', async ({ page }) => {
      await page.goto(TERMINAL);
      await expect(page.locator('.ticker-track')).toHaveCSS('animation-name', 'none');
      await expect(page.locator('.ticker-track ul[aria-hidden]')).toBeHidden();
      await expect(page.locator('#tape-h + .meta')).toHaveText(`${N}/${N} signatures verify`, { timeout: 5_000 });
      await expect(page.locator('.tape li[data-check]').first()).toHaveCSS('transition-duration', '0s');
      await noHorizontalScroll(page);
    });
  });
});
