#!/usr/bin/env node
// Builds the landing from the published runs, so every number and hash on the page comes from
// deployments/testnet.json (Oct 20: intents A-C, entries #0-9), deployments/testnet-pass2.json
// (Oct 21: intent D, the same verifier's log continued to #12, a second anchor) and, when present,
// deployments/testnet-pass3.json (Oct 22: intent E submitted by an agent through MCP, the log
// continued, a third anchor):
//   index.html      the page (static; readable without JavaScript)
//   src/run.json    the log + verifier key + anchors the tape re-checks
//   assets/tape.js  src/tape.ts bundled with @pqi/protocol (esbuild)
// Usage: node packages/landing/build.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const d = JSON.parse(readFileSync(join(root, 'deployments/testnet.json'), 'utf8'));
const p2 = JSON.parse(readFileSync(join(root, 'deployments/testnet-pass2.json'), 'utf8'));
// Pass 2 continues the Oct 20 log under the same verifier key (the tab re-checks every signature).
if (p2.keys.verifier.id !== d.keys.verifier.id) throw new Error('pass 2 is signed by another verifier key');
d.log.forEach((e, i) => {
  if (p2.log[i]?.hash !== e.hash) throw new Error(`pass 2 does not extend the Oct 20 log at entry #${i}`);
});
const P3_PATH = join(root, 'deployments/testnet-pass3.json');
const p3 = existsSync(P3_PATH) ? JSON.parse(readFileSync(P3_PATH, 'utf8')) : null;
if (p3) {
  if (p3.keys.verifier.id !== d.keys.verifier.id) throw new Error('pass 3 is signed by another verifier key');
  p2.log.forEach((e, i) => {
    if (p3.log[i]?.hash !== e.hash) throw new Error(`pass 3 does not extend the pass-2 log at entry #${i}`);
  });
}
const EXPLORER = 'https://testnet.zcashexplorer.app/transactions/';
const REPO = 'https://github.com/nickthelegend/zec-pq-intents';
const TESTS = JSON.parse(readFileSync(join(here, 'tests.json'), 'utf8'));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (h, n = 8) => `${h.slice(0, n)}…`;
const zat = (v) => Number(v).toLocaleString('en-US');
const b64len = (s) => Buffer.from(s, 'base64').length;
const tx = (id, label) => (id ? `<a class="tx" href="${EXPLORER}${id}" target="_blank" rel="noopener" aria-label="${esc(label ?? 'transaction')} ${short(id)} on the Zcash testnet explorer">${short(id)}</a>` : '<span class="muted">none</span>');
const intents = { ...d.intents, D: p2.intent, ...(p3 ? { E: p3.intent } : {}) };
const LETTERS = Object.keys(intents);
const letter = Object.fromEntries(Object.entries(intents).map(([k, v]) => [v.hash, k]));
const subject = (e) => (e.intent_hash ? (letter[e.intent_hash] ? `Intent ${letter[e.intent_hash]}` : `intent ${short(e.intent_hash, 6)}`) : 'log head');
const firstTx = (refs) => Object.entries(refs).find(([k]) => /(release|refund|anchor|fill)_txid$/.test(k)) ?? Object.entries(refs).find(([k]) => k.endsWith('_txid'));
const log = (p3 ?? p2).log;
const PASS2_FROM = d.log.length;
const PASS3_FROM = p3 ? p2.log.length : Infinity;
const count = (s) => log.filter((e) => e.status === s).length;
const anchors = log.filter((e) => e.status === 'ANCHORED');
const anchorEntry = anchors[anchors.length - 1];
const anchoredSeq = Number(anchorEntry.refs.anchored_seq);
const anchorPath = anchors.map((a) => `#${a.refs.anchored_seq}`).join(' → ');
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const ranAt = [d, p2, ...(p3 ? [p3] : [])].map((r) => day(r.ranAt)).join(' + ');
const pass = (seq) => (seq >= PASS3_FROM ? 'pass 3' : seq >= PASS2_FROM ? 'pass 2' : 'Oct 20');
const p3Settled = p3 ? log.find((e) => e.status === 'SETTLED' && e.intent_hash === p3.intent.hash) : null;

const WHY = {
  2: 'The solver "filled" C with the wrong memo and too little',
  3: 'A with min_out changed to 1 after signing',
  4: 'A submitted again after it settled',
  5: 'A new intent reusing A’s nonce',
  6: 'Signed by another ML-DSA key, naming the user',
  7: 'A correct fill of C, mined after its deadline',
  10: 'A second configured solver claimed D’s fill; its memo names the first',
};
const LABEL = {
  0: 'filled, escrow released',
  1: 'filled, escrow released',
  8: 'escrow back to the user',
  9: 'head of entries 0–8 in a shielded memo',
  11: 'released once, after a SIGKILL right after the broadcast',
  12: 'head of entries 0–11; names the #8 anchor',
};
if (p3) {
  LABEL[p3Settled.seq] = 'the agent’s intent (MCP): fill found after a SIGKILL, released once';
  for (const a of log.filter((e) => e.status === 'ANCHORED' && e.seq >= PASS3_FROM)) LABEL[a.seq] = `head of entries 0–${a.refs.anchored_seq}; names the previous anchor`;
}

// ---------- pieces ----------
const tickerItems = log
  .map((e) => {
    const t = firstTx(e.refs);
    const what = e.status === 'REJECTED' ? `<code>${esc(e.reason.split(':')[0])}</code>` : e.status === 'ANCHORED' ? `head ${short(e.refs.anchored_head)}` : `${subject(e)} · ${zat(e.refs.released_zat ?? e.refs.refunded_zat)} zat`;
    return `<li><b>#${e.seq}</b><span class="st st-${e.status.toLowerCase()}">${e.status}</span>${what}${t ? ` ${tx(t[1], t[0].replace('_txid', ''))}` : ''}</li>`;
  })
  .concat([`<li><b>VERIFIER</b> ML-DSA-65 ${short(d.keys.verifier.id)}</li>`, `<li><b>SOLVER KEM</b> ML-KEM-768 ${short(d.keys.solverKem.id)}</li>`])
  .join('');

const bookRows = LETTERS
  .map((k) => {
    const it = intents[k];
    const i = it.signed.intent;
    const fin = log.find((e) => e.intent_hash === it.hash && (e.status === 'SETTLED' || e.status === 'REFUNDED'));
    const st = fin ? fin.status.toLowerCase() : 'open';
    const settleTx = fin?.refs.release_txid ?? fin?.refs.refund_txid;
    const ratio = (Number(i.min_out_zat) / Number(i.pay_zat)).toFixed(3);
    return `<tr class="${st}">
      <td class="lead" data-l="Intent"><span class="letter">${k}</span>${short(it.hash)}</td>
      <td class="r" data-l="Escrow">${zat(i.pay_zat)}</td>
      <td class="r depth" style="--d:${ratio}" data-l="Deliver ≥">${zat(i.min_out_zat)}</td>
      <td class="r" data-l="Solver spread">${zat(Number(i.pay_zat) - Number(i.min_out_zat))}</td>
      <td class="r" data-l="Deadline">${zat(i.deadline_height)}</td>
      <td data-l="Status"><span class="st st-${st}">${st}</span></td>
      <td data-l="${fin?.status === 'REFUNDED' ? 'Refund' : 'Release'}">${tx(settleTx, fin?.status === 'REFUNDED' ? 'refund' : 'release')}</td>
    </tr>`;
  })
  .join('');

const tapeRows = log
  .map((e) => {
    const t = firstTx(e.refs);
    const what = e.status === 'REJECTED' ? `${esc(WHY[e.seq] ?? subject(e))} <code>${esc(e.reason)}</code>` : `${esc(subject(e))}: ${esc(LABEL[e.seq] ?? e.status.toLowerCase())}`;
    const sep = e.seq === PASS2_FROM ? `<li class="run-sep" aria-hidden="true">Pass 2 · ${day(p2.ranAt)} · same verifier key, the log continues</li>` : e.seq === PASS3_FROM ? `<li class="run-sep" aria-hidden="true">Pass 3 · ${day(p3.ranAt)} · an agent through MCP, same verifier key</li>` : '';
    return `${sep}<li data-seq="${e.seq}"><span class="seq">#${e.seq}</span><span class="blk">${zat(e.at_height)}</span><span class="st st-${e.status.toLowerCase()}">${e.status}</span><span class="what" title="${esc(what.replace(/<[^>]+>/g, ''))}">${what}</span><span class="txc">${t ? `<span class="muted">${t[0].replace('_txid', '')}</span> ${tx(t[1], t[0].replace('_txid', ''))}` : ''}</span><span class="sigcell">not checked</span></li>`;
  })
  .join('');

const refusals = log
  .filter((e) => e.status === 'REJECTED')
  .map((e) => {
    const t = firstTx(e.refs);
    return `<div class="ref"><code>${esc(e.reason)}</code><p>${esc(WHY[e.seq])}</p><small>log #${e.seq} · ${pass(e.seq)}${t ? ` · ${t[0].replace('_txid', '')} ${tx(t[1], t[0].replace('_txid', ''))}` : ''}</small></div>`;
  })
  .concat([
    `<div class="ref tested"><code>FILL_UNKNOWN_SOLVER</code><p>Someone other than the solver claims its real fill, to take the escrow.</p><small>tested on A’s real fill · not a live entry</small></div>`,
    `<div class="ref tested"><code>FILL_NOT_SOLVER_BOUND</code><p>A fill whose memo names no solver, with two solver keys configured: paid to neither.</p><small>tested on A’s Oct 20 fill · not a live entry</small></div>`,
    `<div class="ref tested"><code>CLAIM_WINDOW_OPEN</code><p>A refund asked for inside the 10 blocks after the deadline, when the solver may still claim.</p><small>tested on C · not a live entry</small></div>`,
    `<div class="ref tested"><code>RECEIVE_KEY_MISMATCH</code><p>A receive viewing key from another wallet, so the user could keep the delivery and be refunded too.</p><small>tested on the run’s keys · not a live entry</small></div>`,
  ])
  .join('');

const agentSteps = p3
  ? [
      ['quote', `<code>quote</code> → accept, spread ${zat(p3.agent.quote.fee_zat)} zat, a refund would return ${zat(p3.agent.quote.refund_if_unfilled_zat)}.`],
      ['submit_intent', `Signed E with the agent’s own ML-DSA-65 key, saved it, funded ${tx(p3.txs.funding, 'funding')} and posted the envelope; delivered to a new receive address (index ${zat(p3.agent.receive_index)}), not one A–D used.`],
      ['Killed', `The desk got ${esc(p3.crash.signal)} right after the solver’s fill broadcast, with its write-ahead record at block ${zat(p3.crash.board_after_kill.delivering.at_height)} and no txid saved.`],
      ['Found, not resent', `On restart the solver’s history held the fill memo in ${tx(p3.txs.fill, 'fill')}; it was adopted, sent ${p3.crash.solver_sends_with_fill_memo.length === 1 ? 'once' : `${p3.crash.solver_sends_with_fill_memo.length} times`}.`],
      ['Settled', `log #${p3Settled.seq}: released ${zat(p3Settled.refs.released_zat)} zat ${tx(p3.txs.release, 'release')}; the next anchor ${tx(p3.txs.anchor, 'anchor')} names pass 2’s.`],
      ['Audited', `<code>verify_log</code> over MCP: ${p3.checks.verify_log.ok ? 'ok' : 'failed'}, ${p3.checks.verify_log.entries} entries, ${p3.checks.verify_log.anchor.anchors} anchors; <code>check-anchors</code> with the escrow pinned: exit ${p3.checks.check_anchors.exit}, ${p3.checks.check_anchors.chain.length} anchors in one chain.`],
    ]
      .map(([h, p]) => `<div><b>${h}</b><p>${p}</p></div>`)
      .join('')
  : '';

const crash = p2.crash;
const crashSteps = [
  ['Write-ahead', `Before paying D’s release, the verifier saved (fsync) the recipient, ${zat(crash.write_ahead.amount_zat)} zat and memo <code>pqi1:${short(p2.intent.hash, 6)}:release</code> at block ${zat(crash.write_ahead.at_height)}.`],
  ['Killed', `The release was broadcast and the desk process got ${esc(crash.signal)} before it could save the txid.`],
  ['Reconciled', `On restart the escrow’s history already held that memo in ${tx(crash.reconciled_txid, 'release')}, so the verifier waited for it to be mined and settled with it (log #${log.find((e) => e.refs.release_txid === crash.reconciled_txid).seq}).`],
  ['Paid once', `The escrow sent ${crash.escrow_sends_with_release_memo.length} transaction with that memo: ${crash.escrow_sends_with_release_memo.map((t) => tx(t, 'release')).join(', ')}.`],
]
  .map(([h, p]) => `<div><b>${h}</b><p>${p}</p></div>`)
  .join('');

const A = d.intents.A;
const sizes = {
  dsaPk: b64len(A.signed.user_pk),
  dsaSig: b64len(A.signed.sig),
  kemPk: b64len(d.keys.solverKem.pk),
  kemCt: b64len(A.envelope.kem_ct),
  ct: b64len(A.envelope.ct),
};

const mark = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="3" width="17" height="17" rx="2" fill="none" stroke="#f08a4b" stroke-width="3.2"/><rect x="12" y="12" width="17" height="17" rx="2" fill="none" stroke="#efe9ff" stroke-width="3.2"/></svg>`;
const favicon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%231c1326'/%3E%3Crect x='5' y='5' width='14' height='14' rx='2' fill='none' stroke='%23f08a4b' stroke-width='3'/%3E%3Crect x='13' y='13' width='14' height='14' rx='2' fill='none' stroke='%23efe9ff' stroke-width='3'/%3E%3C/svg%3E";

const html = `<!doctype html>
<!-- Generated by packages/landing/build.mjs from deployments/testnet.json. Edit build.mjs, not this file. -->
<html lang="en" class="no-js">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Yaksok: post-quantum intents, settled in shielded ZEC</title>
<meta name="description" content="Yaksok signs intents with ML-DSA-65, seals them to the solver with ML-KEM-768 and settles them in shielded testnet ZEC. Every decision is a signed, hash-chained log entry, re-checked in your browser." />
<meta name="theme-color" content="#1c1326" />
<link rel="icon" href="${favicon}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600&family=Red+Hat+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="assets/landing.css" />
<script>document.documentElement.className = 'js';</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<div class="ticker" aria-label="Decisions from the two testnet runs">
  <div class="ticker-track"><ul>${tickerItems}</ul><ul aria-hidden="true">${tickerItems.replace(/<a /g, '<a tabindex="-1" ')}</ul></div>
</div>

<header class="bar">
  <a class="brand" href="#main" aria-label="Yaksok, top">${mark}<b>Yaksok</b><span lang="ko">약속</span></a>
  <div class="cells" aria-label="Run">
    <div class="cell"><small>Network</small><span><i class="dot" aria-hidden="true"></i>zcash-testnet</span></div>
    <div class="cell"><small>Runs</small><span>${ranAt}</span></div>
    <div class="cell"><small>Log</small><span>${log.length} entries</span></div>
    <div class="cell"><small>Anchors</small><span>${anchors.length} · ${anchorPath}</span></div>
    <div class="cell"><small>Verifier</small><span>${short(d.keys.verifier.id)}</span></div>
  </div>
  <nav class="acts" aria-label="Links">
    <a class="btn" href="terminal/">Terminal</a>
    <a class="btn hide-s" href="${REPO}/blob/main/packages/docs/README.md">Docs</a>
    <a class="btn btn-copper" href="${REPO}">GitHub</a>
  </nav>
</header>

<main id="main">
  <div class="grid">
    <section class="p s5 hero" aria-labelledby="h1">
      <p class="kicker">Zcash · private markets · intents</p>
      <h1 id="h1">Intents signed and sealed with <em>post-quantum</em> keys, settled in shielded ZEC.</h1>
      <p class="lede">Why: the address you receive at is paid from the solver’s liquidity, never from the wallet you fund with, and the order itself is signed and sealed with post-quantum keys. You sign an intent with ML-DSA-65 and seal it to the solver with ML-KEM-768, escrow testnet ZEC, and a verifier releases or refunds the escrow. Every decision is a signed, hash-chained log entry, anchored in a shielded memo. Zcash spends stay elliptic-curve; the post-quantum part is the intent layer.</p>
      <div class="ctas"><a class="btn btn-copper btn-lg" href="#tape">Watch the tape verify</a><a class="btn btn-lg" href="terminal/">Open the terminal</a><a class="btn btn-lg" href="${REPO}/blob/main/packages/docs/README.md#trust-model">Trust model</a></div>
      <div class="kpis" aria-label="Both testnet runs">
        <div class="kpi"><b class="st-settled">${count('SETTLED')}</b><small>settled</small></div>
        <div class="kpi"><b class="st-rejected">${count('REJECTED')}</b><small>refused, signed</small></div>
        <div class="kpi"><b class="st-refunded">${count('REFUNDED')}</b><small>refunded</small></div>
        <div class="kpi"><b class="st-anchored">${count('ANCHORED')}</b><small>anchors</small></div>
      </div>
    </section>

    <section class="p s7" aria-labelledby="book-h">
      <div class="ph"><h2 id="book-h">Intent book</h2><span class="meta">zat · ${LETTERS.length} intents · ${p3 ? 3 : 2} runs</span></div>
      <table class="book stack">
        <thead><tr><th scope="col">Intent</th><th scope="col" class="r">Escrow</th><th scope="col" class="r">Deliver ≥</th><th scope="col" class="r">Solver spread</th><th scope="col" class="r">Deadline</th><th scope="col">Status</th><th scope="col">Payout</th></tr></thead>
        <tbody>${bookRows}</tbody>
      </table>
      <p class="book-note">The bar under “Deliver ≥” is the share of the escrow the solver must deliver. Solver spread is escrow minus delivery (20,000). A release or a refund pays the escrow minus a 15,000 zat fee budget, so a release is 45,000 and the solver nets 5,000 over what it delivered; a refund returns 45,000 of the 60,000 (the user loses 15,000, a quarter). The part of the fee budget the payout transaction does not spend stays in the escrow wallet, which the verifier holds. A, B and C were funded together in ${tx(d.txs.funding, 'funding')}; D, in pass 2, in ${tx(p2.txs.funding, 'funding')}${p3 ? `; E, by the agent in pass 3, in ${tx(p3.txs.funding, 'funding')}` : ''}.</p>
      <div class="flow">
        <div><b>Sign</b><p>ML-DSA-65 over the canonical intent; the key id is inside it.</p></div>
        <div><b>Seal</b><p>ML-KEM-768 + HKDF + AES-256-GCM to the solver's key.</p></div>
        <div><b>Settle</b><p>Shielded funding, fill and payout, each read with a viewing key.</p></div>
        <div><b>Sign the decision</b><p>The verifier's ML-DSA-65 log, hash-chained and anchored.</p></div>
      </div>
    </section>

    <section class="p s7" id="tape" aria-labelledby="tape-h">
      <div class="ph"><h2 id="tape-h">Attestation tape</h2><span class="meta">verifier ${short(d.keys.verifier.id)} · ML-DSA-65</span></div>
      <div class="tape-head" aria-hidden="true"><span>#</span><span>Block</span><span>Status</span><span>Decision</span><span>Tx</span><span>Sig</span></div>
      <ol class="tape">${tapeRows}</ol>
    </section>

    <aside class="p s5" aria-labelledby="ver-h">
      <div class="ph"><h2 id="ver-h">Checked in this tab</h2><span class="meta" id="verify-state" data-state="idle" aria-live="polite">waiting for JavaScript</span></div>
      <div class="pb">
        <p class="big num" id="verify-count">0/${log.length}</p>
        <p class="muted small" style="margin:0">Each entry's hash, link to the previous entry and ML-DSA-65 signature, re-computed by @pqi/protocol in your browser against the published verifier key.</p>
        <div class="meter" id="verify-bar" role="presentation"><i></i></div>
        <dl class="kv">
          <dt>Verifier key</dt><dd title="${d.keys.verifier.id}">${short(d.keys.verifier.id, 16)}</dd>
          <dt>Log head</dt><dd title="${log[log.length - 1].hash}">${short(log[log.length - 1].hash, 16)}</dd>
          <dt>Anchored heads</dt><dd>${anchors.map((a) => `<span title="${a.refs.anchored_head}">#${a.refs.anchored_seq} ${short(a.refs.anchored_head, 8)}</span>`).join(' · ')}</dd>
          <dt>Head check</dt><dd id="anchor-check" data-state="idle">not checked</dd>
          <dt>Anchor memos</dt><dd>${anchors.map((a) => tx(a.refs.anchor_txid, `anchor of #${a.refs.anchored_seq}`)).join(' → ')} <span class="muted">found by the runs; re-read by <code>pnpm test</code> and <code>check-anchors</code></span></dd>
          <dt>After the anchor</dt><dd>${log.length - 1 - anchoredSeq} entry (#${anchorEntry.seq}, the anchor itself)</dd>
        </dl>
      </div>
    </aside>

    <section class="p s12" aria-labelledby="ref-h">
      <div class="ph"><h2 id="ref-h">What the verifier refuses</h2><span class="meta">each refusal is a signed log entry</span></div>
      <div class="refusals">${refusals}</div>
    </section>

    <section class="p s12" id="crash" aria-labelledby="crash-h">
      <div class="ph"><h2 id="crash-h">Killed mid-release, reconciled, paid once</h2><span class="meta">pass 2 · intent D · live on testnet</span></div>
      <div class="flow crash">${crashSteps}</div>
    </section>

${p3 ? `    <section class="p s12" id="agent" aria-labelledby="agent-h">
      <div class="ph"><h2 id="agent-h">An agent trades through MCP, live</h2><span class="meta">pass 3 · intent E · ${day(p3.ranAt)}</span></div>
      <div class="flow crash agent">${agentSteps}</div>
    </section>

` : ''}    <section class="p s6" aria-labelledby="prim-h">
      <div class="ph"><h2 id="prim-h">Primitives</h2><span class="meta">bytes measured from intent A</span></div>
      <table class="stack">
        <thead><tr><th scope="col">Primitive</th><th scope="col">Standard</th><th scope="col" class="r">Bytes</th><th scope="col">Used for</th></tr></thead>
        <tbody>
          <tr><td class="lead" data-l="Primitive">ML-DSA-65</td><td data-l="Standard">FIPS 204</td><td class="r" data-l="Bytes">pk ${zat(sizes.dsaPk)} · sig ${zat(sizes.dsaSig)}</td><td class="wrap" data-l="Used for">user intent, solver claim, verifier log</td></tr>
          <tr><td class="lead" data-l="Primitive">ML-KEM-768</td><td data-l="Standard">FIPS 203</td><td class="r" data-l="Bytes">pk ${zat(sizes.kemPk)} · ct ${zat(sizes.kemCt)}</td><td class="wrap" data-l="Used for">sealing the intent to the solver</td></tr>
          <tr><td class="lead" data-l="Primitive">AES-256-GCM</td><td data-l="Standard">SP 800-38D</td><td class="r" data-l="Bytes">sealed ${zat(sizes.ct)}</td><td class="wrap" data-l="Used for">the signed intent, keyed by HKDF-SHA256</td></tr>
          <tr><td class="lead" data-l="Primitive">SHA-256</td><td data-l="Standard">FIPS 180-4</td><td class="r" data-l="Bytes">32</td><td class="wrap" data-l="Used for">intent hash, log chain, key ids</td></tr>
        </tbody>
      </table>
    </section>

    <section class="p s6" aria-labelledby="pq-h">
      <div class="ph"><h2 id="pq-h">What is post-quantum, and what is not</h2></div>
      <div class="cols2">
        <div class="yes"><h3>Post-quantum</h3><ul class="plain"><li>The intent signature (ML-DSA-65)</li><li>The sealed envelope to the solver (ML-KEM-768): recording it today does not open it later</li><li>The verifier's signatures on every decision</li></ul></div>
        <div class="no"><h3>Not post-quantum, and not private</h3><ul class="plain"><li>Zcash spends and note encryption: a future quantum adversary holding the chain could read the funding and fill memos and link them</li><li>The escrow’s full viewing key is published, so anyone sees today every funding (amount, intent hash) and every payout out of the escrow: the recipient and amount of each release and refund, including the user’s refund address next to <code>pqi1:&lt;hash&gt;:refund</code></li></ul></div>
      </div>
    </section>

    <section class="p s6" aria-labelledby="mcp-h">
      <div class="ph"><h2 id="mcp-h">Agents (MCP)</h2><span class="meta">pqi-mcp · stdio</span></div>
      <div class="pb">
<pre><b>verify_log</b>     the desk vs your pinned verifier key;
               every hash, link, signature, anchor memo
<b>submit_intent</b>  sign, seal, save, fund, post: pinned escrow
               + KEM key only; a new receive address each time${p3 ? `
               (ran live: intent E, pass 3)` : ''}
<b>resubmit</b>       post a saved, funded intent again
<b>status</b>         an intent's stage and signed entries
<b>quote</b>          the fee vs the solver's published minimum</pre>
      </div>
    </section>

    <section class="p s6" id="run" aria-labelledby="run-h">
      <div class="ph"><h2 id="run-h">Run it</h2><span class="meta">${TESTS.total} tests · no mocks</span></div>
      <div class="pb">
<pre><b>pnpm install</b>
pnpm --filter @pqi/dashboard dev          <span class="muted"># terminal, :5181</span>
pnpm test                                 <span class="muted"># + Rust, zingo-cli</span>
PQI_PUBLISHED=deployments/testnet.json \\
  pnpm --filter @pqi/node serve           <span class="muted"># read-only desk</span></pre>
        <table class="tests" style="margin-top:12px">
          <tbody>
            <tr><td>protocol</td><td class="muted">local</td><td>${TESTS.protocol}</td></tr>
            <tr><td>scan (Rust)</td><td class="muted">local</td><td>${TESTS.scan}</td></tr>
            <tr><td>node</td><td class="muted">Zcash testnet + local</td><td>${TESTS.node}</td></tr>
            <tr><td>mcp</td><td class="muted">stdio client + desk + testnet</td><td>${TESTS.mcp}</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="p s12" aria-labelledby="lim-h">
      <div class="ph"><h2 id="lim-h">Limits</h2><span class="meta">read before trusting it</span></div>
      <div class="pb">
        <ul class="plain">
          <li>Not trustless. The verifier holds the escrow and could withhold a payout. It cannot change the record without the signatures, links or anchors showing it.</li>
          <li>The solver and the verifier read the plaintext intent. One receive address served all four intents (A–D), so those deliveries can be linked${p3 ? '; E, submitted by the agent, got an address of its own' : ''}.</li>
          <li>The escrow’s full viewing key is published for auditability: it shows every payout’s recipient and amount, not only the fundings.</li>
          <li>Anchors are periodic, and each names the one before it. Every anchor the escrow sent can be listed, and a second head, an anchor that names none, or one off the chain fails the check; entries after the last anchor are not covered. Funding and fills need 3 confirmations.</li>
          <li>ZEC only, testnet only, a single verifier key, not audited. A portfolio piece: the Zecathon entry is Shielded x402.</li>
        </ul>
      </div>
    </section>
  </div>
</main>

<footer class="foot">
  <span>MIT · Copyright (c) 2026 Nivesh Gajengi</span>
  <a href="${REPO}/blob/main/deployments/testnet.json">Run record (Oct 20)</a>
  <a href="${REPO}/blob/main/deployments/testnet-pass2.json">Pass 2 (Oct 21)</a>${p3 ? `
  <a href="${REPO}/blob/main/deployments/testnet-pass3.json">Pass 3 (Oct 22)</a>` : ''}
  <a href="${REPO}/blob/main/docs/JUDGE-2026-10-21.md">Review</a>
  <span>Zcash testnet · not audited</span>
</footer>
<script type="module" src="assets/tape.js"></script>
</body>
</html>
`;

writeFileSync(join(here, 'index.html'), html);
writeFileSync(join(here, 'src/run.json'), JSON.stringify({ verifier: d.keys.verifier, log, anchors: anchors.map((a) => ({ entry: a.seq, seq: Number(a.refs.anchored_seq), head: a.refs.anchored_head, txid: a.refs.anchor_txid, prev: a.refs.prev_anchor_txid ?? null })) }));

// esbuild from the workspace store (a dependency of the dashboard's vite)
const store = join(root, 'node_modules/.pnpm');
const dir = readdirSync(store).find((x) => /^esbuild@\d/.test(x));
if (!dir) throw new Error('esbuild not found: run pnpm install');
execFileSync(join(store, dir, 'node_modules/esbuild/bin/esbuild'), [join(here, 'src/tape.ts'), '--bundle', '--format=esm', '--minify', '--target=es2022', `--outfile=${join(here, 'assets/tape.js')}`, '--log-level=warning'], { stdio: 'inherit', cwd: join(root, 'packages/protocol') });
console.log('landing built: index.html, src/run.json, assets/tape.js');
