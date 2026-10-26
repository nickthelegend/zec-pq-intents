// Curl the published desks. Saves redacted status lines and bodies only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.cwd();
const VERIFIER = 'f60f130579386479043287fb68c2c1726a0a210be77aee46b355adb1287f1445';
const A = '48a440a659848bcf73cd912be8616be34491132aaf5b277e59e962becf085ca2';
const ZEROS = '0'.repeat(64);
const SETUP = 'Setup required: this desk serves a published record (PQI_PUBLISHED); run it with PQI_STATE to accept intents';
const HOST_ERR = 'Host "evil.example" is not this desk; use 127.0.0.1 or localhost';
const outDir = join(repo, 'audit/desk');
const lines = [];
const say = (s) => {
  const t = String(s).replace(/\buivk[0-9a-z]{8,}/gi, '[redacted-uivk]').replace(/\bufvk[0-9a-z]{8,}/gi, '[redacted-ufvk]');
  if (/\b(uivk|ufvk)[0-9a-z]{8,}/i.test(t)) throw new Error('refusing to record a viewing key');
  lines.push(t);
};

const load = (f) => JSON.parse(readFileSync(join(repo, f), 'utf8'));
const published = {
  oct20: load('deployments/testnet.json').log,
  pass2: load('deployments/testnet-pass2.json').log,
  pass3: load('deployments/testnet-pass3.json').log,
};

function curl(url, opt = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pqi-curl-'));
  const hdr = join(dir, 'h');
  const body = join(dir, 'b');
  const args = ['-sS', '--http1.1', '--max-redirs', '0', '--max-time', '45', '-D', hdr, '-o', body, '-w', '%{http_code}'];
  if (opt.method) args.push('-X', opt.method);
  for (const [k, v] of Object.entries(opt.headers ?? {})) args.push('-H', `${k}: ${v}`);
  if (opt.dataFile) args.push('--data-binary', `@${opt.dataFile}`);
  else if (opt.data !== undefined) args.push('--data-binary', opt.data);
  args.push(url);
  const readMaybe = (p) => {
    try { return readFileSync(p, 'utf8'); } catch { return ''; }
  };
  let code = '';
  let error = '';
  try {
    code = execFileSync('curl', args, { encoding: 'utf8' }).trim();
  } catch (e) {
    error = String(e.stderr || e.message || e).slice(0, 400);
  }
  const headerText = readMaybe(hdr);
  const statusLine = headerText.split(/\r?\n/)[0] ?? '';
  const headers = {};
  for (const line of headerText.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const raw = readMaybe(body);
  rmSync(dir, { recursive: true, force: true });
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  return { code, error, statusLine, headers, raw, json };
}

const acao = (r) => r.headers['access-control-allow-origin'];
const ctype = (r) => r.headers['content-type'] ?? '';
const big = join(tmpdir(), 'pqi-big.json');
writeFileSync(big, `{"pad":"${'a'.repeat(70000)}"}`);

function logCount(base) {
  const r = curl(`${base}/api/info`);
  return { r, n: r.json?.log_entries };
}

function summarizeLog(log) {
  return (log ?? []).map((e) => `#${e.seq} ${e.status}${e.reason ? ' ' + e.reason : ''}`).join(', ');
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const desks = [
  ['oct20', 'http://127.0.0.1:8404', 8404, 10, 'oct20'],
  ['pass2', 'http://127.0.0.1:8405', 8405, 13, 'pass2'],
  ['pass3', 'http://127.0.0.1:8406', 8406, 15, 'pass3'],
];

const bucket = {};
const note = (id, ok, text) => {
  bucket[id] ??= [];
  bucket[id].push({ ok, text });
  say(`${ok ? 'OK' : 'NO'} ${id} ${text}`);
};

function judge(id) {
  const parts = bucket[id] ?? [];
  if (parts.some((p) => p.untested)) return { status: 'UNTESTED', observed: parts.map((p) => p.text).join(' ') };
  const ok = parts.length > 0 && parts.every((p) => p.ok);
  return { status: ok ? 'PASS' : 'FAIL', observed: parts.map((p) => p.text).join(' ') };
}

say('=== local desks ===');
for (const [name, base, port, n, which] of desks) {
  const info = curl(`${base}/api/info`);
  note('D-local-info', info.code === '200' && ctype(info).startsWith('application/json') && info.json?.mode === 'published (read-only)' && info.json?.verifier?.id === VERIFIER && info.json?.log_entries === n && info.json?.min_fee_zat === '15000',
    `${name} ${info.statusLine} ctype=${ctype(info).split(';')[0]} mode=${info.json?.mode} verifier.id=${info.json?.verifier?.id} log_entries=${info.json?.log_entries} min_fee_zat=${JSON.stringify(info.json?.min_fee_zat)}`);

  const log = curl(`${base}/api/log`);
  const arr = log.json?.log;
  const reasons = [3, 4, 6, 7].map((i) => `#${i}=${arr?.[i]?.reason}`).join(' ');
  const ten = name === 'oct20' ? true : arr?.[10]?.reason === 'FILL_BY_OTHER_SOLVER';
  const equal = Array.isArray(arr) && sameJson(arr, published[which]);
  note('D-local-log', log.code === '200' && arr?.length === n && arr?.[3]?.reason === 'BAD_SIGNATURE' && arr?.[4]?.reason === 'ALREADY_SETTLED' && arr?.[6]?.reason === 'WRONG_KEY' && arr?.[7]?.reason === 'EXPIRED' && ten && equal,
    `${name} ${log.statusLine} len=${arr?.length} ${reasons} #10=${arr?.[10]?.reason ?? 'absent'} equalToPublished=${equal}`);

  const intent = curl(`${base}/api/intents/${A}`);
  const ents = intent.json?.log ?? [];
  note('D-local-intent', intent.code === '200' && intent.json?.hash === A && intent.json?.stage === 'settled' && ents.length === 2 && ents[0]?.seq === 0 && ents[0]?.status === 'SETTLED' && ents[1]?.seq === 4 && ents[1]?.status === 'REJECTED' && ents[1]?.reason === 'ALREADY_SETTLED',
    `${name} ${intent.statusLine} hash=${intent.json?.hash} stage=${intent.json?.stage} entries=${ents.map((e) => `#${e.seq} ${e.status}/${e.reason}`).join(',')}`);

  const miss = curl(`${base}/api/intents/${ZEROS}`);
  note('D-local-missing-intent', miss.code === '200' && miss.json?.hash === ZEROS && miss.json?.stage === 'unknown' && Array.isArray(miss.json?.log) && miss.json.log.length === 0,
    `${name} ${miss.statusLine} ${JSON.stringify(miss.json)}`);

  const badHash = curl(`${base}/api/intents/not-a-hash`);
  note('D-local-invalid-hash', badHash.code === '200' && sameJson(badHash.json, { hash: 'not-a-hash', stage: 'unknown', log: [] }),
    `${name} ${badHash.statusLine} ${JSON.stringify(badHash.json)}`);

  const nope = curl(`${base}/api/nope`);
  note('D-local-404', nope.code === '404' && nope.raw === '{"error":"not found"}',
    `${name} ${nope.statusLine} body=${nope.raw}`);

  const opt = curl(`${base}/api/intents`, { method: 'OPTIONS' });
  const postInfo = curl(`${base}/api/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: '{}' });
  note('D-local-options', opt.code === '404' && acao(opt) === undefined && postInfo.code === '404' && acao(postInfo) === undefined,
    `${name} OPTIONS ${opt.statusLine} acao=${acao(opt) ?? 'absent'} POST /api/info ${postInfo.statusLine} acao=${acao(postInfo) ?? 'absent'}`);

  const before = logCount(base).n;
  const p415 = curl(`${base}/api/intents`, { method: 'POST', headers: { 'content-type': 'text/plain' }, data: 'hello' });
  const t415 = curl(`${base}/api/tick`, { method: 'POST', headers: { 'content-type': 'text/plain' }, data: 'hello' });
  note('D-local-post-415', p415.code === '415' && p415.json?.error === 'POST bodies must be application/json' && acao(p415) === undefined,
    `${name} POST /api/intents ${p415.statusLine} error=${JSON.stringify(p415.json?.error)} acao=${acao(p415) ?? 'absent'}`);

  const p400 = curl(`${base}/api/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: '{not json' });
  const t400 = curl(`${base}/api/tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: '{not json' });
  note('D-local-post-400', p400.code === '400' && typeof p400.json?.error === 'string' && p400.json.error.length > 0 && acao(p400) === undefined,
    `${name} POST /api/intents ${p400.statusLine} error=${JSON.stringify(p400.json?.error)} acao=${acao(p400) ?? 'absent'}`);

  const p503 = curl(`${base}/api/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: '{}' });
  const t503 = curl(`${base}/api/tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: '{}' });
  note('D-local-post-setup', p503.code === '503' && p503.json?.error === SETUP,
    `${name} POST /api/intents ${p503.statusLine} error=${JSON.stringify(p503.json?.error)}`);
  note('D-local-tick-readonly', t503.code === '503' && t503.json?.error === SETUP,
    `${name} POST /api/tick ${t503.statusLine} error=${JSON.stringify(t503.json?.error)}`);

  const p413 = curl(`${base}/api/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, dataFile: big });
  const t413 = curl(`${base}/api/tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, dataFile: big });
  note('D-local-post-413', p413.code === '413' && p413.json?.error === 'body over 65536 bytes' && (p413.headers.connection ?? '').toLowerCase() === 'close' && acao(p413) === undefined,
    `${name} POST /api/intents ${p413.statusLine} error=${JSON.stringify(p413.json?.error)} connection=${p413.headers.connection ?? 'absent'} acao=${acao(p413) ?? 'absent'}`);

  const corsOk = [p415, p413, p400, p503, t415, t413, t400, t503].every((r) => acao(r) === undefined);
  const getLog = curl(`${base}/api/log`);
  note('D-local-cors', corsOk && getLog.headers['access-control-allow-origin'] === '*',
    `${name} write acao absent=${corsOk} (intents/tick 415,413,400,503) GET /api/log acao=${getLog.headers['access-control-allow-origin'] ?? 'absent'}`);
  note('D-local-tick-input', t415.code === '415' && t413.code === '413' && t400.code === '400' && acao(t415) === undefined && acao(t413) === undefined && acao(t400) === undefined,
    `${name} tick 415=${t415.code} 413=${t413.code} 400=${t400.code} acao absent`);

  const hGet = curl(`${base}/api/log`, { headers: { Host: 'evil.example' } });
  const hPost = curl(`${base}/api/intents`, { method: 'POST', headers: { Host: 'evil.example', 'content-type': 'application/json' }, data: '{}' });
  const localH = curl(`${base}/api/info`, { headers: { Host: `localhost:${port}` } });
  const ipH = curl(`${base}/api/info`, { headers: { Host: `127.0.0.1:${port}` } });
  const hostOk = hGet.code === '403' && hGet.json?.error === HOST_ERR && acao(hGet) === undefined && hPost.code === '403' && hPost.json?.error === HOST_ERR && acao(hPost) === undefined && localH.code === '200' && ipH.code === '200';
  note('D-local-host-403', hostOk,
    `${name} GET evil ${hGet.statusLine} error=${JSON.stringify(hGet.json?.error)} acao=${acao(hGet) ?? 'absent'}; POST evil ${hPost.statusLine} error=${JSON.stringify(hPost.json?.error)} acao=${acao(hPost) ?? 'absent'}; localhost:${port} ${localH.statusLine}; 127.0.0.1:${port} ${ipH.statusLine}`);

  const after = logCount(base).n;
  const preserved = before === n && after === n;
  note('D-local-post-setup', preserved, `${name} log_entries before=${before} after=${after}`);
  note('D-local-tick-readonly', preserved, `${name} log_entries stayed ${after}`);
  note('D-local-tick-input', preserved, `${name} published log length stayed ${after}`);
  note('D-local-post-415', preserved, `${name} log_entries stayed ${after}`);
  note('D-local-post-413', preserved, `${name} log_entries stayed ${after}`);
  note('D-local-post-400', preserved, `${name} log_entries stayed ${after}`);
  say(`${name} log summary ${summarizeLog(getLog.json?.log).slice(0, 240)}`);
}

say('=== live desk ===');
const live = 'https://yaksok-api.201-18-198-162.sslip.io';
{
  const info = curl(`${live}/api/info`);
  note('D-live-info', info.code === '200' && ctype(info).startsWith('application/json') && info.json?.mode === 'published (read-only)' && info.json?.verifier?.id === VERIFIER && info.json?.log_entries === 15 && info.json?.min_fee_zat === '15000',
    `live ${info.statusLine} ctype=${ctype(info).split(';')[0]} mode=${info.json?.mode} verifier.id=${info.json?.verifier?.id} log_entries=${info.json?.log_entries} min_fee_zat=${JSON.stringify(info.json?.min_fee_zat)}`);

  const log = curl(`${live}/api/log`);
  const arr = log.json?.log;
  const equal = Array.isArray(arr) && sameJson(arr, published.pass3);
  note('D-live-log', log.code === '200' && arr?.length === 15 && arr?.[3]?.reason === 'BAD_SIGNATURE' && arr?.[4]?.reason === 'ALREADY_SETTLED' && arr?.[6]?.reason === 'WRONG_KEY' && arr?.[7]?.reason === 'EXPIRED' && arr?.[10]?.reason === 'FILL_BY_OTHER_SOLVER' && equal,
    `live ${log.statusLine} len=${arr?.length} #3=${arr?.[3]?.reason} #4=${arr?.[4]?.reason} #6=${arr?.[6]?.reason} #7=${arr?.[7]?.reason} #10=${arr?.[10]?.reason} equalToPass3=${equal}`);

  const intent = curl(`${live}/api/intents/${A}`);
  const ents = intent.json?.log ?? [];
  note('D-live-intent', intent.code === '200' && intent.json?.hash === A && intent.json?.stage === 'settled' && ents.length === 2 && ents[0]?.seq === 0 && ents[0]?.status === 'SETTLED' && ents[1]?.seq === 4 && ents[1]?.status === 'REJECTED' && ents[1]?.reason === 'ALREADY_SETTLED',
    `live ${intent.statusLine} hash=${intent.json?.hash} stage=${intent.json?.stage} entries=${ents.map((e) => `#${e.seq} ${e.status}/${e.reason}`).join(',')}`);

  const miss = curl(`${live}/api/intents/${ZEROS}`);
  note('D-live-missing-intent', miss.code === '200' && miss.json?.hash === ZEROS && miss.json?.stage === 'unknown' && miss.json?.log?.length === 0,
    `live ${miss.statusLine} ${JSON.stringify(miss.json)}`);

  const badHash = curl(`${live}/api/intents/not-a-hash`);
  note('D-live-invalid-hash', badHash.code === '200' && sameJson(badHash.json, { hash: 'not-a-hash', stage: 'unknown', log: [] }),
    `live ${badHash.statusLine} ${JSON.stringify(badHash.json)}`);

  const nope = curl(`${live}/api/nope`);
  note('D-live-404', nope.code === '404' && nope.raw === '{"error":"not found"}', `live ${nope.statusLine} body=${nope.raw}`);

  const opt = curl(`${live}/api/intents`, { method: 'OPTIONS' });
  const postInfo = curl(`${live}/api/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: '{}' });
  note('D-live-options', opt.code === '404' && acao(opt) === undefined && postInfo.code === '404' && acao(postInfo) === undefined,
    `live OPTIONS ${opt.statusLine} acao=${acao(opt) ?? 'absent'} POST /api/info ${postInfo.statusLine} acao=${acao(postInfo) ?? 'absent'}`);

  const before = logCount(live).n;
  const p415 = curl(`${live}/api/intents`, { method: 'POST', headers: { 'content-type': 'text/plain' }, data: 'hello' });
  const t415 = curl(`${live}/api/tick`, { method: 'POST', headers: { 'content-type': 'text/plain' }, data: 'hello' });
  note('D-live-post-415', p415.code === '415' && p415.json?.error === 'POST bodies must be application/json' && acao(p415) === undefined,
    `live POST /api/intents ${p415.statusLine} error=${JSON.stringify(p415.json?.error)} acao=${acao(p415) ?? 'absent'}`);

  const p400 = curl(`${live}/api/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: '{not json' });
  const t400 = curl(`${live}/api/tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: '{not json' });
  note('D-live-post-400', p400.code === '400' && typeof p400.json?.error === 'string' && p400.json.error.length > 0 && acao(p400) === undefined,
    `live POST /api/intents ${p400.statusLine} error=${JSON.stringify(p400.json?.error)} acao=${acao(p400) ?? 'absent'}`);

  const p503 = curl(`${live}/api/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: '{}' });
  const t503 = curl(`${live}/api/tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: '{}' });
  note('D-live-post-setup', p503.code === '503' && p503.json?.error === SETUP, `live POST /api/intents {} ${p503.statusLine} error=${JSON.stringify(p503.json?.error)}`);
  note('D-live-tick-readonly', t503.code === '503' && t503.json?.error === SETUP, `live POST /api/tick {} ${t503.statusLine} error=${JSON.stringify(t503.json?.error)}`);

  const p413 = curl(`${live}/api/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, dataFile: big });
  const t413 = curl(`${live}/api/tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, dataFile: big });
  note('D-live-post-413', p413.code === '413' && p413.json?.error === 'body over 65536 bytes' && (p413.headers.connection ?? '').toLowerCase() === 'close' && acao(p413) === undefined,
    `live POST /api/intents ${p413.statusLine} error=${JSON.stringify(p413.json?.error)} connection=${p413.headers.connection ?? 'absent'} acao=${acao(p413) ?? 'absent'}`);

  const corsOk = [p415, p413, p400, p503, t415, t413, t400, t503].every((r) => acao(r) === undefined);
  const getLog = curl(`${live}/api/log`);
  note('D-live-cors', corsOk && getLog.headers['access-control-allow-origin'] === '*',
    `live write acao absent=${corsOk} GET /api/log acao=${getLog.headers['access-control-allow-origin'] ?? 'absent'}`);
  note('D-live-tick-input', t415.code === '415' && t413.code === '413' && t400.code === '400' && [t415, t413, t400].every((r) => acao(r) === undefined),
    `live tick 415=${t415.code} 413=${t413.code} 400=${t400.code} acao absent`);

  const after = logCount(live).n;
  const preserved = before === 15 && after === 15;
  for (const id of ['D-live-post-setup', 'D-live-tick-readonly', 'D-live-tick-input', 'D-live-post-415', 'D-live-post-413', 'D-live-post-400']) {
    note(id, preserved, `live log_entries before=${before} after=${after}`);
  }

  // The 403 probe is the local handler. The live call uses the configured hostname.
  const localBits = (bucket['D-local-host-403'] ?? []).map((p) => p.text).join(' | ');
  const localOk = (bucket['D-local-host-403'] ?? []).every((p) => p.ok);
  note('D-live-host-403', localOk && info.code === '200',
    `live allowed hostname yaksok-api.201-18-198-162.sslip.io ${info.statusLine} mode=${info.json?.mode}. 403 probe is the local handler, not a reverse-proxy response. ${localBits}`);

  // Replay / expiry / nonce for the protocol rows, from the live published log.
  const e3 = arr?.[3];
  const e4 = arr?.[4];
  const e5 = arr?.[5];
  const e6 = arr?.[6];
  const e7 = arr?.[7];
  say(`P-desk #3 ${e3?.status} ${e3?.reason}`);
  say(`P-desk #4 ${e4?.status} ${e4?.reason} intent_hash=${e4?.intent_hash}`);
  say(`P-desk #5 ${e5?.status} ${e5?.reason} first_use=${e5?.refs?.first_use}`);
  say(`P-desk #6 ${e6?.status} ${e6?.reason}`);
  say(`P-desk #7 ${e7?.status} ${e7?.reason} fill_height=${e7?.refs?.fill_height} deadline=${e7?.refs?.deadline}`);
}

say('=== empty desk ===');
let empty = [];
try {
  empty = JSON.parse(readFileSync('/tmp/yaksok-final/empty.json', 'utf8'));
} catch {
  empty = [];
}
for (const row of empty) {
  say(`${row.id} exit=${row.status} stdout=${JSON.stringify(row.stdout)} stderr=${JSON.stringify(row.stderr)}`);
  note(row.id, row.ok, row.observed);
}
say('DOCKER not started');
bucket.DOCKER = [{ ok: false, text: 'needs a running Docker daemon and the external coolify network; docker info cannot connect to the local Docker daemon. Docker was not exercised (required UNTESTED).', untested: true }];

const ids = [
  'D-local-info', 'D-local-log', 'D-local-intent', 'D-local-missing-intent', 'D-local-post-415', 'D-local-post-413', 'D-local-post-400', 'D-local-post-setup', 'D-local-host-403', 'D-local-cors', 'D-local-tick-readonly', 'D-local-404', 'D-local-invalid-hash', 'D-local-options', 'D-local-tick-input',
  'D-live-info', 'D-live-log', 'D-live-intent', 'D-live-missing-intent', 'D-live-post-415', 'D-live-post-413', 'D-live-post-400', 'D-live-post-setup', 'D-live-host-403', 'D-live-cors', 'D-live-tick-readonly', 'D-live-404', 'D-live-invalid-hash', 'D-live-options', 'D-live-tick-input',
  'D-local-empty', 'D-local-missing-record', 'DOCKER',
];
const rows = ids.map((id) => ({ id, ...judge(id) }));
writeFileSync(join(outDir, 'curl.log'), lines.join('\n') + '\n');
writeFileSync('/tmp/yaksok-final/desk-rows.json', JSON.stringify(rows, null, 2));
const fails = rows.filter((r) => r.status !== 'PASS').map((r) => r.id);
console.log(`desk rows ${rows.length} fails=${fails.join(',') || 'none'}`);
rmSync(big, { force: true });
