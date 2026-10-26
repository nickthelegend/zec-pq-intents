// Real MCP stdio tool calls. No PQI_AGENT_FILE, no wallet, no resubmit, no funded submit.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const repo = process.cwd();
const httpTrace = join(repo, 'audit/mcp/http.jsonl');
mkdirSync(join(repo, 'audit/mcp'), { recursive: true });
writeFileSync(httpTrace, '');
const requests = () => readFileSync(httpTrace, 'utf8').trim().split('\n').filter(Boolean).length;
const tsx = `${repo}/packages/node/node_modules/.bin/tsx`;
const main = `${repo}/packages/mcp/src/main.ts`;
const scan = process.env.PQI_SCAN_BIN ?? `${repo}/packages/scan/target/release/zpay-verify`;
const VERIFIER = 'f60f130579386479043287fb68c2c1726a0a210be77aee46b355adb1287f1445';
const A = '48a440a659848bcf73cd912be8616be34491132aaf5b277e59e962becf085ca2';
const desk = 'http://127.0.0.1:8406';
const pass3 = JSON.parse(readFileSync(join(repo, 'deployments/testnet-pass3.json'), 'utf8'));
const anchorUivk = pass3.wallets?.anchor?.uivk;
if (!anchorUivk) throw new Error('published anchor viewing key missing');

const redact = (s) => String(s ?? '')
  .replace(/\buivk[0-9a-z]{8,}/gi, '[redacted-uivk]')
  .replace(/\bufvk[0-9a-z]{8,}/gi, '[redacted-ufvk]');

const lines = [];
const say = (s) => {
  const t = redact(s);
  if (/\b(uivk|ufvk)[0-9a-z]{8,}/i.test(t)) throw new Error('refusing to record a viewing key');
  lines.push(t);
};

function baseEnv(extra) {
  return {
    PATH: process.env.PATH ?? '',
    NODE_OPTIONS: `--import=${JSON.stringify(join(repo, 'e2e/audit-tools/trace-http.mjs'))}`,
    PQI_AUDIT_HTTP_LOG: httpTrace,
    HOME: process.env.HOME ?? '',
    PQI_SCAN_BIN: scan,
    ...extra,
  };
}

async function connect(extra) {
  const client = new Client({ name: 'yaksok-audit', version: '0' });
  const transport = new StdioClientTransport({ command: tsx, args: [main], env: baseEnv(extra) });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
    return { isError: r.isError === true, text: redact(text), thrown: false };
  } catch (e) {
    return { isError: true, text: redact(e?.message ?? String(e)), thrown: true };
  }
}

const rows = [];
function add(id, status, observed) {
  rows.push({ id, status, observed: redact(observed) });
  say(`${id} ${status}`);
  say(redact(observed));
  say('');
}

const published = connect({ PQI_DESK_URL: desk, PQI_VERIFIER_ID: VERIFIER });
const client = await published;

const listed = await client.listTools();
const tools = listed.tools.map((t) => ({ name: t.name, readOnlyHint: t.annotations?.readOnlyHint === true }));
const names = tools.map((t) => t.name).sort();
const hint = (n) => tools.find((t) => t.name === n)?.readOnlyHint === true;
const toolsOk = JSON.stringify(names) === JSON.stringify(['quote', 'resubmit', 'status', 'submit_intent', 'verify_log']) && hint('quote') && hint('status') && hint('verify_log');
add('M-tools', toolsOk ? 'PASS' : 'FAIL', `tools=${JSON.stringify(tools)}`);

const q = await call(client, 'quote', { pay_zat: 60000, min_out_zat: 40000 });
let qj = {};
try { qj = JSON.parse(q.text); } catch { /* keep */ }
const quoteOk = q.isError === false && qj.accept === true && qj.fee_zat === 20000 && qj.solver_min_fee_zat === 15000 && qj.refund_if_unfilled_zat === 45000 && qj.desk_mode === 'published (read-only)';
add('M-quote', quoteOk ? 'PASS' : 'FAIL', `isError=${q.isError} accept=${qj.accept} fee_zat=${qj.fee_zat} solver_min_fee_zat=${qj.solver_min_fee_zat} refund_if_unfilled_zat=${qj.refund_if_unfilled_zat} desk_mode=${JSON.stringify(qj.desk_mode)}`);

const low = await call(client, 'quote', { pay_zat: 60000, min_out_zat: 59000 });
let lj = {};
try { lj = JSON.parse(low.text); } catch { /* keep */ }
add('M-quote-low', low.isError === false && lj.accept === false && lj.fee_zat === 1000 && lj.solver_min_fee_zat === 15000 ? 'PASS' : 'FAIL',
  `isError=${low.isError} accept=${lj.accept} fee_zat=${lj.fee_zat} solver_min_fee_zat=${lj.solver_min_fee_zat}`);

const st = await call(client, 'status', { intent_hash: A });
let sj = {};
try { sj = JSON.parse(st.text); } catch { /* keep */ }
const ents = (sj.log ?? []).map((e) => `#${e.seq} ${e.status}/${e.reason ?? ''}`);
const want = pass3.log.filter((e) => e.intent_hash === A);
const same = JSON.stringify(sj.log ?? []) === JSON.stringify(want);
add('M-status', st.isError === false && sj.hash === A && sj.stage === 'settled' && ents.length === 2 && same ? 'PASS' : 'FAIL',
  `isError=${st.isError} hash=${sj.hash} stage=${sj.stage} entries=${ents.join(',')} equalToPublishedA=${same}`);

const hitsBeforeInvalid = requests();
const schemaClient = await connect({ PQI_DESK_URL: desk, PQI_VERIFIER_ID: VERIFIER });
const badStatus = await call(schemaClient, 'status', { intent_hash: 'not-a-hash' });
const badQuotes = [];
for (const args of [{ pay_zat: 0, min_out_zat: 40000 }, { pay_zat: -1, min_out_zat: 40000 }, { pay_zat: 1.5, min_out_zat: 40000 }, { pay_zat: 60000, min_out_zat: 0 }]) {
  badQuotes.push({ args, ...(await call(schemaClient, 'quote', args)) });
}
const hitsAfterInvalid = requests();
const statusSchema = /invalid|schema|expected|string|regex|64/i.test(badStatus.text) && badStatus.isError;
add('M-status-invalid', statusSchema && hitsAfterInvalid === hitsBeforeInvalid ? 'PASS' : 'FAIL',
  `thrown=${badStatus.thrown} isError=${badStatus.isError} text=${JSON.stringify(badStatus.text.slice(0, 400))} httpRequestsBefore=${hitsBeforeInvalid} httpRequestsAfter=${hitsAfterInvalid}`);
const quoteSchema = badQuotes.every((r) => r.isError && /invalid|schema|positive|number|expected/i.test(r.text));
add('M-quote-invalid', quoteSchema && hitsAfterInvalid === hitsBeforeInvalid ? 'PASS' : 'FAIL',
  badQuotes.map((r) => `pay=${r.args.pay_zat} min=${r.args.min_out_zat} isError=${r.isError} text=${JSON.stringify(r.text.slice(0, 220))}`).join(' | ') + ` httpRequestsBefore=${hitsBeforeInvalid} httpRequestsAfter=${hitsAfterInvalid}`);

const down = await connect({ PQI_DESK_URL: 'http://127.0.0.1:18498' });
const downQ = await call(down, 'quote', { pay_zat: 60000, min_out_zat: 40000 });
const downS = await call(down, 'status', { intent_hash: A });
const downOk = downQ.isError && downQ.text.startsWith('Setup required: PQI_DESK_URL (no desk answering at') && downS.isError && downS.text.startsWith('Setup required: PQI_DESK_URL (no desk answering at');
add('M-desk-unavailable', downOk ? 'PASS' : 'FAIL', `quote=${JSON.stringify(downQ.text.slice(0, 240))} status=${JSON.stringify(downS.text.slice(0, 240))}`);

const hitsBeforeSubmit = requests();
const submit = await call(schemaClient, 'submit_intent', { pay_zat: 60000, min_out_zat: 40000, deadline_blocks: 10 });
const submitOk = submit.isError && submit.text === 'Setup required: PQI_AGENT_FILE' && requests() === hitsBeforeSubmit;
add('M-submit-setup', submitOk ? 'PASS' : 'FAIL',
  `isError=${submit.isError} text=${JSON.stringify(submit.text)} httpRequestsBefore=${hitsBeforeSubmit} httpRequestsAfter=${requests()} PQI_AGENT_FILE unset; no wallet file passed`);

add('M-submit-live', 'UNTESTED', 'needs a funded Zcash testnet send. The funded flow was not invoked.');
add('M-resubmit-live', 'UNTESTED', 'needs a funded Zcash testnet send. resubmit was not called.');

const unpinned = await connect({ PQI_DESK_URL: desk });
const pin = await call(unpinned, 'verify_log', {});
add('M-verify-pin-setup', pin.isError && pin.text.startsWith('Setup required: PQI_VERIFIER_ID (the key id of the verifier you trust; the desk cannot vouch for its own log)') ? 'PASS' : 'FAIL',
  `isError=${pin.isError} text=${JSON.stringify(pin.text.slice(0, 300))}`);

const noUivk = await connect({ PQI_DESK_URL: desk, PQI_VERIFIER_ID: VERIFIER });
const uivkMiss = await call(noUivk, 'verify_log', {});
const uivkOk = uivkMiss.isError && uivkMiss.text === 'Setup required: PQI_ANCHOR_UIVK (the log has 3 anchor(s); their memos are read with the anchor viewing key you trust, not one the desk serves)';
const noScan = await connect({ PQI_DESK_URL: desk, PQI_VERIFIER_ID: VERIFIER, PQI_ANCHOR_UIVK: anchorUivk, PQI_SCAN_BIN: '/tmp/yaksok-final/missing-zpay-verify' });
const scanMiss = await call(noScan, 'verify_log', {});
const scanOk = scanMiss.isError && scanMiss.text.includes('Setup required: PQI_SCAN_BIN');
add('M-verify-setup', uivkOk && scanOk ? 'PASS' : 'FAIL',
  `no PQI_ANCHOR_UIVK isError=${uivkMiss.isError} text=${JSON.stringify(uivkMiss.text.slice(0, 360))}; missing scanner isError=${scanMiss.isError} text=${JSON.stringify(scanMiss.text.slice(0, 300))}`);

say('M-verify starting read-only memo check');
const verified = await connect({ PQI_DESK_URL: desk, PQI_VERIFIER_ID: VERIFIER, PQI_ANCHOR_UIVK: anchorUivk, PQI_SCAN_BIN: scan });
const vr = await call(verified, 'verify_log', {});
let vj = null;
try { vj = JSON.parse(vr.text); } catch { vj = null; }
const counts = vj?.counts ?? {};
const anchor = vj?.anchor ?? {};
const verifyOk = vr.isError === false && vj?.ok === true && vj?.entries === 15 && vj?.error === null
  && counts.SETTLED === 4 && counts.REJECTED === 7 && counts.REFUNDED === 1 && counts.ANCHORED === 3
  && anchor.anchors === 3 && anchor.chain_links === true && anchor.memo_on_chain === true && anchor.anchored_through === 13 && anchor.entries_after_anchor === 1;
add('M-verify', verifyOk ? 'PASS' : (vr.text.startsWith('Setup required:') || /timed out|lightwalletd|ENOTFOUND|ECONNREFUSED/i.test(vr.text) ? 'UNTESTED' : 'FAIL'),
  vr.isError || !vj
    ? `isError=${vr.isError} text=${JSON.stringify(vr.text.slice(0, 500))}`
    : `ok=${vj.ok} entries=${vj.entries} error=${JSON.stringify(vj.error)} counts=${JSON.stringify(counts)} anchors=${anchor.anchors} chain_links=${anchor.chain_links} memo_on_chain=${anchor.memo_on_chain} anchored_through=${anchor.anchored_through} entries_after_anchor=${anchor.entries_after_anchor}`);

await Promise.all([client, schemaClient, down, unpinned, noUivk, noScan, verified].map((c) => c.close().catch(() => {})));


mkdirSync(join(repo, 'audit/mcp'), { recursive: true });
writeFileSync(join(repo, 'audit/mcp/mcp.log'), lines.join('\n') + '\n');
writeFileSync('/tmp/yaksok-final/mcp-rows.json', JSON.stringify(rows, null, 2));
console.log(rows.map((r) => `${r.id} ${r.status}`).join('\n'));
