// Protocol checks against published records and the library. Prints codes and short hashes only.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendEntry,
  checkAnchors,
  checkIntentShape,
  fromB64,
  intentHash,
  memo,
  newKemKey,
  newSigningKey,
  open,
  seal,
  signIntent,
  toB64,
  verifyIntent,
  verifyLog,
  type LogEntry,
  type SignedIntent,
} from '../../packages/protocol/src/index.ts';

const root = join(import.meta.dirname, '../..');
const repo = process.cwd();
const outDir = join(repo, 'audit/protocol');
mkdirSync(outDir, { recursive: true });

const safe = (s: unknown) =>
  String(s)
    .replace(/uivktest1[0-9a-z]+/gi, '[redacted-uivk]')
    .replace(/\buivk[0-9a-z]{10,}/gi, '[redacted-uivk]')
    .replace(/\bufvk[0-9a-z]{10,}/gi, '[redacted-ufvk]');

const lines: string[] = [];
const say = (s: string) => {
  const t = safe(s);
  if (/\b(uivk|ufvk)[0-9a-z]{10,}/i.test(t)) throw new Error('refusing to record a viewing key');
  lines.push(t);
};

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERR';
  }
};

const load = (f: string) => JSON.parse(readFileSync(join(repo, f), 'utf8'));
const oct = load('deployments/testnet.json');
const p2 = load('deployments/testnet-pass2.json');
const p3 = load('deployments/testnet-pass3.json');

say('=== vitest ===');
const vitest = readFileSync('/tmp/yaksok-final/protocol-vitest.log', 'utf8')
  .split('\n')
  .filter((l) => /✓|Test Files|Tests |FAIL|×/.test(l) && !/NO_COLOR|Warning|trace-warnings/.test(l));
for (const l of vitest) say(l.trim());

say('=== quoted assertions from packages/protocol/test/protocol.test.ts (executed by vitest) ===');
const testSrc = readFileSync(join(repo, 'packages/protocol/test/protocol.test.ts'), 'utf8').split('\n');
for (const n of [71, 80, 99, 106, 107]) say(`L${n}: ${testSrc[n - 1].trim()}`);

say('=== P-encoding re-exec ===');
for (const s of ['QR==', 'QUJ=', 'QUI', 'Q===']) say(`fromB64 ${JSON.stringify(s)} -> ${code(() => fromB64(s))}`);
{
  const user = newSigningKey();
  const UA = (c: string) => `utest1${c.repeat(40)}`;
  const fields = { escrow: UA('e'), pay_zat: '60000', min_out_zat: '40000', receive_ua: UA('r'), receive_uivk: `uivktest1${'k'.repeat(40)}`, refund_ua: UA('f'), deadline_height: 4_600_000 };
  const s = signIntent(user, fields);
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const respelled = s.user_pk.slice(0, -2) + B64[B64.indexOf(s.user_pk.at(-2)!) ^ 1] + '=';
  say(`respelled differs=${respelled !== s.user_pk} verify=${code(() => verifyIntent({ ...s, user_pk: respelled }))} original=${code(() => verifyIntent(s))}`);
}

say('=== P-tamper published A ===');
{
  const s = structuredClone(oct.intents.A.signed) as SignedIntent;
  const before = intentHash(s.intent);
  s.intent.min_out_zat = String(BigInt(s.intent.min_out_zat) + 1n);
  const after = intentHash(s.intent);
  say(`before_prefix=${before.slice(0, 8)} after_prefix=${after.slice(0, 8)} differs=${after !== before} code=${code(() => verifyIntent(s))} original_ok_prefix=${verifyIntent(oct.intents.A.signed).slice(0, 8)}`);
}

say('=== P-wrong-key published forgedAsUser ===');
say(`code=${code(() => verifyIntent(oct.attacks.forgedAsUser as SignedIntent))}`);

say('=== recorded refusals (not fresh payout claims) ===');
for (const seq of [3, 4, 5, 6, 7]) {
  const e = p3.log[seq];
  say(`#${seq} ${e.status} ${e.reason} intent_hash=${e.intent_hash} first_use=${e.refs.first_use ?? ''} fill_height=${e.refs.fill_height ?? ''} deadline=${e.refs.deadline_height ?? ''}`);
}
say('=== P-envelope ===');
{
  const user = newSigningKey();
  const solver = newKemKey();
  const UA = (c: string) => `utest1${c.repeat(40)}`;
  const s = signIntent(user, { escrow: UA('e'), pay_zat: '60000', min_out_zat: '40000', receive_ua: UA('r'), receive_uivk: `uivktest1${'k'.repeat(40)}`, refund_ua: UA('f'), deadline_height: 4_600_000 });
  const e = seal(s, solver.publicKey);
  const opened = open(e, solver);
  say(`open_hash_prefix=${intentHash(opened.intent).slice(0, 8)} original_prefix=${intentHash(s.intent).slice(0, 8)} match=${intentHash(opened.intent) === intentHash(s.intent)}`);
  say(`other_key=${code(() => open(e, newKemKey()))}`);
  const ct = fromB64(e.ct);
  ct[5] ^= 1;
  say(`flipped_ct=${code(() => open({ ...e, ct: toB64(ct) }, solver))}`);
  say(`swapped_hash=${code(() => open({ ...e, intent_hash: 'ab'.repeat(32) }, solver))}`);
}

say('=== P-log published records ===');
function checkRecord(name: string, d: { log: LogEntry[]; keys: { verifier: { pk: string } } }) {
  const pk = fromB64(d.keys.verifier.pk);
  const v = verifyLog(d.log, pk);
  say(`${name} ok=${v.ok} entries=${v.entries} problem=${v.error ? safe(v.error.problem) : 'null'}`);
  const edited = d.log.map((e, i) => (i === 0 ? { ...e, status: e.status === 'SETTLED' ? 'REFUNDED' : 'SETTLED' } : e));
  const ev = verifyLog(edited, pk);
  say(`${name} content_edit ok=${ev.ok} seq=${ev.error?.seq} problem_nonempty=${Boolean(ev.error?.problem)}`);
  const dropped = verifyLog([d.log[0], ...d.log.slice(2)], pk);
  say(`${name} drop ok=${dropped.ok} seq=${dropped.error?.seq} problem_nonempty=${Boolean(dropped.error?.problem)}`);
  const reordered = verifyLog([d.log[1], d.log[0], ...d.log.slice(2)], pk);
  say(`${name} reorder ok=${reordered.ok} seq=${reordered.error?.seq} problem_nonempty=${Boolean(reordered.error?.problem)}`);
  const foreign = verifyLog(d.log, newSigningKey().publicKey);
  say(`${name} foreign_verifier ok=${foreign.ok} seq=${foreign.error?.seq} problem=${safe(foreign.error?.problem)}`);
  const sig = fromB64(d.log[1].sig);
  sig[0] ^= 1;
  const badSig = verifyLog([d.log[0], { ...d.log[1], sig: toB64(sig) }, ...d.log.slice(2)], pk);
  say(`${name} sig_change ok=${badSig.ok} seq=${badSig.error?.seq} problem=${safe(badSig.error?.problem)}`);
}
checkRecord('oct20', oct);
checkRecord('pass2', p2);
checkRecord('pass3', p3);

say('=== P-shape ===');
{
  const UA = (c: string) => `utest1${c.repeat(20)}`;
  const uivk = `uivktest1${'k'.repeat(40)}`;
  const user = newSigningKey();
  const base = { escrow: UA('e'), pay_zat: '60000', min_out_zat: '40000', receive_ua: UA('r'), receive_uivk: uivk, refund_ua: UA('f'), deadline_height: 4_600_000 };
  const signed = signIntent(user, base);
  const full = signed.intent;
  const cases: [string, () => unknown][] = [
    ['missing_nonce', () => { const o = { ...full }; delete (o as { nonce?: string }).nonce; checkIntentShape(o); }],
    ['extra_field', () => checkIntentShape({ ...full, extra: 1 })],
    ['bad_version', () => checkIntentShape({ ...full, v: 2 })],
    ['bad_kind', () => checkIntentShape({ ...full, kind: 'swap' })],
    ['bad_chain', () => checkIntentShape({ ...full, chain: 'zcash-mainnet' })],
    ['zero_pay', () => signIntent(user, { ...base, pay_zat: '0' })],
    ['negative_min', () => signIntent(user, { ...base, min_out_zat: '-5' })],
    ['fractional_pay', () => signIntent(user, { ...base, pay_zat: '1.5' })],
    ['bad_receive', () => signIntent(user, { ...base, receive_ua: 'tmabc' })],
    ['bad_escrow', () => signIntent(user, { ...base, escrow: 'not-an-address' })],
    ['bad_nonce', () => checkIntentShape({ ...full, nonce: 'zz' })],
    ['bad_user', () => checkIntentShape({ ...full, user: 'abc' })],
    ['fractional_deadline', () => checkIntentShape({ ...full, deadline_height: 1.5 })],
    ['zero_deadline', () => checkIntentShape({ ...full, deadline_height: 0 })],
  ];
  for (const [name, fn] of cases) say(`${name}=${code(fn)}`);
}

say('=== P-anchor-invariants ===');
{
  const anchors = (log: LogEntry[]) =>
    log
      .filter((e) => e.status === 'ANCHORED')
      .map((e) => ({
        txid: String(e.refs.anchor_txid),
        memo: e.refs.prev_anchor_txid
          ? memo.anchor(Number(e.refs.anchored_seq), String(e.refs.anchored_head), String(e.refs.prev_anchor_txid))
          : memo.anchor(Number(e.refs.anchored_seq), String(e.refs.anchored_head)),
      }));
  const sent = anchors(p3.log);
  const cut = checkAnchors(oct.log, sent);
  say(`oct20_vs_3_anchors ok=${cut.ok} kinds=${cut.problems.map((p) => p.kind).join(',')} later=${cut.later.map((a) => a.seq).join(',')} entries=${oct.log.length}`);

  const verifier = newSigningKey();
  const tx = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
  const log: LogEntry[] = [];
  appendEntry(log, verifier, { status: 'REJECTED', intent_hash: 'a'.repeat(64), reason: 'R0', refs: {}, at_height: 1 });
  appendEntry(log, verifier, { status: 'REJECTED', intent_hash: 'a'.repeat(64), reason: 'R1', refs: {}, at_height: 2 });
  const head = log[1].hash;
  const a1 = tx(1);
  appendEntry(log, verifier, { status: 'ANCHORED', intent_hash: null, reason: null, refs: { anchor_txid: a1, anchored_seq: '1', anchored_head: head, prev_anchor_txid: '00'.repeat(32) }, at_height: 3 });
  const other = log.slice(0, 2);
  appendEntry(other, verifier, { status: 'SETTLED', intent_hash: 'b'.repeat(64), reason: null, refs: {}, at_height: 4 });
  const forkTx = tx(9);
  const sentFork = [
    { txid: a1, memo: memo.anchor(1, head, '00'.repeat(32)) },
    { txid: forkTx, memo: memo.anchor(2, other[2].hash, a1) },
  ];
  const fork = checkAnchors(log, sentFork);
  say(`fork_kinds=${[...new Set(fork.problems.map((p) => p.kind))].sort().join(',')}`);
  const hidden = checkAnchors(log.slice(0, 2), sentFork);
  say(`hidden_kinds=${[...new Set(hidden.problems.map((p) => p.kind))].sort().join(',')}`);
  const late = checkAnchors([], [{ txid: tx(5), memo: memo.anchor(8, 'ab'.repeat(32)) }], { allowBehind: true });
  say(`legacy_late_kinds=${late.problems.map((p) => p.kind).join(',')}`);
}

const logPath = join(outDir, 'protocol.log');
writeFileSync(logPath, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} lines`);
