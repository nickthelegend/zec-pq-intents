#!/usr/bin/env node
// Builds the landing from the published run, so every number and hash on the page comes from
// deployments/testnet.json:
//   index.html      the page (static; readable without JavaScript)
//   src/run.json    the log + verifier key the tape re-checks
//   assets/tape.js  src/tape.ts bundled with @pqi/protocol (esbuild)
// Usage: node packages/landing/build.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const d = JSON.parse(readFileSync(join(root, 'deployments/testnet.json'), 'utf8'));
const EXPLORER = 'https://testnet.zcashexplorer.app/transactions/';
const REPO = 'https://github.com/nickthelegend/zec-pq-intents';
const TESTS = { protocol: 16, scan: '3 + doc', node: 32, mcp: 6, total: '57 + doc' };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (h, n = 8) => `${h.slice(0, n)}…`;
const zat = (v) => Number(v).toLocaleString('en-US');
const b64len = (s) => Buffer.from(s, 'base64').length;
const tx = (id, label) => (id ? `<a class="tx" href="${EXPLORER}${id}" target="_blank" rel="noopener" aria-label="${esc(label ?? 'transaction')} ${short(id)} on the Zcash testnet explorer">${short(id)}</a>` : '<span class="muted">none</span>');
const letter = Object.fromEntries(Object.entries(d.intents).map(([k, v]) => [v.hash, k]));
const subject = (e) => (e.intent_hash ? (letter[e.intent_hash] ? `Intent ${letter[e.intent_hash]}` : `intent ${short(e.intent_hash, 6)}`) : 'log head');
const firstTx = (refs) => Object.entries(refs).find(([k]) => /(release|refund|anchor|fill)_txid$/.test(k)) ?? Object.entries(refs).find(([k]) => k.endsWith('_txid'));
const log = d.log;
const count = (s) => log.filter((e) => e.status === s).length;
const anchorEntry = log.find((e) => e.status === 'ANCHORED');
const anchoredSeq = Number(anchorEntry.refs.anchored_seq);
const ranAt = new Date(d.ranAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

const WHY = {
  2: 'The solver "filled" C with the wrong memo and too little',
  3: 'A with min_out changed to 1 after signing',
  4: 'A submitted again after it settled',
  5: 'A new intent reusing A’s nonce',
  6: 'Signed by another ML-DSA key, naming the user',
  7: 'A correct fill of C, mined after its deadline',
};
const LABEL = { 0: 'filled, escrow released', 1: 'filled, escrow released', 8: 'escrow back to the user', 9: `head of entries 0–${anchoredSeq} in a shielded memo` };

// ---------- pieces ----------
const tickerItems = log
  .map((e) => {
    const t = firstTx(e.refs);
    const what = e.status === 'REJECTED' ? `<code>${esc(e.reason.split(':')[0])}</code>` : e.status === 'ANCHORED' ? `head ${short(e.refs.anchored_head)}` : `${subject(e)} · ${zat(e.refs.released_zat ?? e.refs.refunded_zat)} zat`;
    return `<li><b>#${e.seq}</b><span class="st st-${e.status.toLowerCase()}">${e.status}</span>${what}${t ? ` ${tx(t[1], t[0].replace('_txid', ''))}` : ''}</li>`;
  })
  .concat([`<li><b>VERIFIER</b> ML-DSA-65 ${short(d.keys.verifier.id)}</li>`, `<li><b>SOLVER KEM</b> ML-KEM-768 ${short(d.keys.solverKem.id)}</li>`])
  .join('');

const bookRows = ['A', 'B', 'C']
  .map((k) => {
    const it = d.intents[k];
    const i = it.signed.intent;
    const fin = log.find((e) => e.intent_hash === it.hash && (e.status === 'SETTLED' || e.status === 'REFUNDED'));
    const st = fin ? fin.status.toLowerCase() : 'open';
    const settleTx = fin?.refs.release_txid ?? fin?.refs.refund_txid;
    const ratio = (Number(i.min_out_zat) / Number(i.pay_zat)).toFixed(3);
    return `<tr class="${st}">
      <td class="lead" data-l="Intent"><span class="letter">${k}</span>${short(it.hash)}</td>
      <td class="r" data-l="Escrow">${zat(i.pay_zat)}</td>
      <td class="r depth" style="--d:${ratio}" data-l="Deliver ≥">${zat(i.min_out_zat)}</td>
      <td class="r" data-l="Fee">${zat(Number(i.pay_zat) - Number(i.min_out_zat))}</td>
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
    return `<li data-seq="${e.seq}"><span class="seq">#${e.seq}</span><span class="blk">${zat(e.at_height)}</span><span class="st st-${e.status.toLowerCase()}">${e.status}</span><span class="what" title="${esc(what.replace(/<[^>]+>/g, ''))}">${what}</span><span class="txc">${t ? `<span class="muted">${t[0].replace('_txid', '')}</span> ${tx(t[1], t[0].replace('_txid', ''))}` : ''}</span><span class="sigcell">not checked</span></li>`;
  })
  .join('');

const refusals = log
  .filter((e) => e.status === 'REJECTED')
  .map((e) => {
    const t = firstTx(e.refs);
    return `<div class="ref"><code>${esc(e.reason)}</code><p>${esc(WHY[e.seq])}</p><small>log #${e.seq}${t ? ` · ${t[0].replace('_txid', '')} ${tx(t[1], t[0].replace('_txid', ''))}` : ''}</small></div>`;
  })
  .concat([
    `<div class="ref tested"><code>FILL_UNKNOWN_SOLVER</code><p>Someone other than the solver claims its real fill, to take the escrow.</p><small>tested on A’s real fill · not in the Oct 20 run</small></div>`,
    `<div class="ref tested"><code>CLAIM_WINDOW_OPEN</code><p>A refund asked for inside the 10 blocks after the deadline, when the solver may still claim.</p><small>tested on C · not in the Oct 20 run</small></div>`,
  ])
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

<div class="ticker" aria-label="Decisions from the Oct 20 testnet run">
  <div class="ticker-track"><ul>${tickerItems}</ul><ul aria-hidden="true">${tickerItems.replace(/<a /g, '<a tabindex="-1" ')}</ul></div>
</div>

<header class="bar">
  <a class="brand" href="#main" aria-label="Yaksok, top">${mark}<b>Yaksok</b><span lang="ko">약속</span></a>
  <div class="cells" aria-label="Run">
    <div class="cell"><small>Network</small><span><i class="dot" aria-hidden="true"></i>zcash-testnet</span></div>
    <div class="cell"><small>Run</small><span>${ranAt}</span></div>
    <div class="cell"><small>Log</small><span>${log.length} entries</span></div>
    <div class="cell"><small>Anchored</small><span>#0–${anchoredSeq} · block ${zat(anchorEntry.at_height)}</span></div>
    <div class="cell"><small>Verifier</small><span>${short(d.keys.verifier.id)}</span></div>
  </div>
  <nav class="acts" aria-label="Links">
    <a class="btn hide-s" href="${REPO}/blob/main/packages/docs/README.md">Docs</a>
    <a class="btn btn-copper" href="${REPO}">GitHub</a>
  </nav>
</header>

<main id="main">
  <div class="grid">
    <section class="p s5 hero" aria-labelledby="h1">
      <p class="kicker">Zcash · private markets · intents</p>
      <h1 id="h1">Intents signed and sealed with <em>post-quantum</em> keys, settled in shielded ZEC.</h1>
      <p class="lede">An intent is signed with ML-DSA-65 and sealed to the solver with ML-KEM-768. The user escrows testnet ZEC, the solver delivers from its own liquidity, and a verifier releases or refunds the escrow. It writes every decision as a signed, hash-chained log entry, anchored in a shielded memo. Zcash spends stay elliptic-curve. The post-quantum part is the intent layer.</p>
      <div class="ctas"><a class="btn btn-copper btn-lg" href="#tape">Watch the tape verify</a><a class="btn btn-lg" href="${REPO}/blob/main/packages/docs/README.md#trust-model">Trust model</a></div>
      <div class="kpis" aria-label="The Oct 20 run">
        <div class="kpi"><b class="st-settled">${count('SETTLED')}</b><small>settled</small></div>
        <div class="kpi"><b class="st-rejected">${count('REJECTED')}</b><small>refused, signed</small></div>
        <div class="kpi"><b class="st-refunded">${count('REFUNDED')}</b><small>refunded</small></div>
        <div class="kpi"><b class="st-anchored">${count('ANCHORED')}</b><small>anchor</small></div>
      </div>
    </section>

    <section class="p s7" aria-labelledby="book-h">
      <div class="ph"><h2 id="book-h">Intent book</h2><span class="meta">zat · 3 intents · one funding tx ${short(d.txs.funding)}</span></div>
      <table class="book stack">
        <thead><tr><th scope="col">Intent</th><th scope="col" class="r">Escrow</th><th scope="col" class="r">Deliver ≥</th><th scope="col" class="r">Fee</th><th scope="col" class="r">Deadline</th><th scope="col">Status</th><th scope="col">Payout</th></tr></thead>
        <tbody>${bookRows}</tbody>
      </table>
      <p class="book-note">The bar under “Deliver ≥” is the share of the escrow the solver must deliver. A release or refund pays the escrow minus a 15,000 zat fee budget (45,000). All three were funded in ${tx(d.txs.funding, 'funding')}.</p>
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
          <dt>Anchored head</dt><dd title="${anchorEntry.refs.anchored_head}">#${anchoredSeq} ${short(anchorEntry.refs.anchored_head, 12)}</dd>
          <dt>Head check</dt><dd id="anchor-check" data-state="idle">not checked</dd>
          <dt>Anchor memo</dt><dd>${tx(anchorEntry.refs.anchor_txid, 'anchor')} <span class="muted">found by the run; re-read by <code>pnpm test</code></span></dd>
          <dt>After the anchor</dt><dd>${log.length - 1 - anchoredSeq} entry (#${anchorEntry.seq}, the anchor itself)</dd>
        </dl>
      </div>
    </aside>

    <section class="p s12" aria-labelledby="ref-h">
      <div class="ph"><h2 id="ref-h">What the verifier refuses</h2><span class="meta">each refusal is a signed log entry</span></div>
      <div class="refusals">${refusals}</div>
    </section>

    <section class="p s6" aria-labelledby="prim-h">
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
        <div class="no"><h3>Not post-quantum</h3><ul class="plain"><li>Zcash spends and note encryption: a future quantum adversary holding the chain could read the funding and fill memos and link them</li><li>The escrow viewing key is public, so funding amounts and intent hashes are visible today</li></ul></div>
      </div>
    </section>

    <section class="p s6" aria-labelledby="mcp-h">
      <div class="ph"><h2 id="mcp-h">Agents (MCP)</h2><span class="meta">pqi-mcp · stdio</span></div>
      <div class="pb">
<pre><b>verify_log</b>     the desk vs your pinned verifier key;
               every hash, link, signature, anchor memo
<b>submit_intent</b>  sign, seal, fund: pinned escrow + KEM key only
<b>status</b>         an intent's stage and signed entries
<b>quote</b>          the fee vs the solver's published minimum</pre>
      </div>
    </section>

    <section class="p s6" id="run" aria-labelledby="run-h">
      <div class="ph"><h2 id="run-h">Run it</h2><span class="meta">${TESTS.total} tests · no mocks</span></div>
      <div class="pb">
<pre><b>pnpm install && pnpm test</b>
pnpm --filter @pqi/dashboard dev          <span class="muted"># the terminal, :5181</span>
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
          <li>The solver and the verifier read the plaintext intent. In this run, one receive address served all three intents, so those deliveries can be linked.</li>
          <li>Anchors are periodic, and each names the one before it. The escrow's full viewing key is published, so every anchor it sent can be listed and a second head is a visible fork; entries after the last anchor are not covered. Funding and fills need 3 confirmations.</li>
          <li>ZEC only, testnet only, a single verifier key, not audited. A portfolio piece: the Zecathon entry is Shielded x402.</li>
        </ul>
      </div>
    </section>
  </div>
</main>

<footer class="foot">
  <span>MIT · Copyright (c) 2026 Nivesh Gajengi</span>
  <a href="${REPO}/blob/main/deployments/testnet.json">Run record</a>
  <a href="${REPO}/blob/main/docs/JUDGE-2026-10-21.md">Review</a>
  <span>Zcash testnet · not audited</span>
</footer>
<script type="module" src="assets/tape.js"></script>
</body>
</html>
`;

writeFileSync(join(here, 'index.html'), html);
writeFileSync(join(here, 'src/run.json'), JSON.stringify({ verifier: d.keys.verifier, log, anchor: { seq: anchoredSeq, head: anchorEntry.refs.anchored_head } }));

// esbuild from the workspace store (a dependency of the dashboard's vite)
const store = join(root, 'node_modules/.pnpm');
const dir = readdirSync(store).find((x) => /^esbuild@\d/.test(x));
if (!dir) throw new Error('esbuild not found: run pnpm install');
execFileSync(join(store, dir, 'node_modules/esbuild/bin/esbuild'), [join(here, 'src/tape.ts'), '--bundle', '--format=esm', '--minify', '--target=es2022', `--outfile=${join(here, 'assets/tape.js')}`, '--log-level=warning'], { stdio: 'inherit', cwd: join(root, 'packages/protocol') });
console.log('landing built: index.html, src/run.json, assets/tape.js');
