// zec-pq-intents protocol. Browser- and Node-safe (no node: imports).
//
// An intent asks a solver to deliver `min_out_zat` to the user's `receive_ua` before
// `deadline_height`, against `pay_zat` the user escrows. It is
//   - canonically encoded and hashed (sha256 over "pqi1:intent:" ‖ canonical JSON),
//   - signed with the user's ML-DSA-65 key (FIPS 204),
//   - sealed to the solver with ML-KEM-768 (FIPS 203) + HKDF-SHA256 + AES-256-GCM.
// The verifier keeps an append-only log: each entry names the previous entry's hash and is signed
// with the verifier's ML-DSA-65 key; the head hash is anchored in a shielded memo.
// These are application-layer post-quantum primitives; Zcash spends themselves stay ECC-based.
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

export { bytesToHex, hexToBytes, randomBytes };

const enc = new TextEncoder();
const dec = new TextDecoder();
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 3) {
    const n = (u[i] << 16) | ((u[i + 1] ?? 0) << 8) | (u[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < u.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < u.length ? B64[n & 63] : '=');
  }
  return s;
}

export function fromB64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) throw new ProtocolError('BAD_ENCODING', 'not base64');
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  // One spelling per value: padding bits must be zero ("QR==" and "QQ==" would both be 0x41), so a
  // signature or key string cannot be rewritten into another that verifies the same.
  if (toB64(out) !== s) throw new ProtocolError('BAD_ENCODING', 'non-canonical base64');
  return out;
}

export class ProtocolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ProtocolError';
  }
}

export const sha256Hex = (data: Uint8Array | string) => bytesToHex(sha256(typeof data === 'string' ? enc.encode(data) : data));

/** Sorted keys, no whitespace; only strings, safe integers, booleans, null, arrays and objects. */
export function canonical(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new ProtocolError('BAD_ENCODING', `non-integer number ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  throw new ProtocolError('BAD_ENCODING', `unsupported ${typeof v}`);
}

// ---------- keys ----------

export interface SigningKey {
  scheme: 'ML-DSA-65';
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}
export interface KemKey {
  scheme: 'ML-KEM-768';
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export const signingKeyFromSeed = (seed32: Uint8Array): SigningKey => ({ scheme: 'ML-DSA-65', ...ml_dsa65.keygen(seed32) });
export const kemKeyFromSeed = (seed64: Uint8Array): KemKey => ({ scheme: 'ML-KEM-768', ...ml_kem768.keygen(seed64) });
export const newSigningKey = () => signingKeyFromSeed(randomBytes(32));
export const newKemKey = () => kemKeyFromSeed(randomBytes(64));
/** Fingerprint used inside intents and log entries: sha256 of the public key, hex. */
export const keyId = (publicKey: Uint8Array) => sha256Hex(publicKey);

export function sign(key: SigningKey, domain: string, message: string): string {
  return toB64(ml_dsa65.sign(enc.encode(`${domain}${message}`), key.secretKey));
}

export function verifySig(publicKey: Uint8Array, domain: string, message: string, sigB64: string): boolean {
  try {
    return ml_dsa65.verify(fromB64(sigB64), enc.encode(`${domain}${message}`), publicKey);
  } catch {
    return false;
  }
}

// ---------- intents ----------

export interface Intent {
  v: 1;
  kind: 'delivery';
  chain: 'zcash-testnet';
  /** escrow unified address the user funds */
  escrow: string;
  pay_zat: string;
  min_out_zat: string;
  receive_ua: string;
  /** incoming viewing key of receive_ua, so the verifier can see the fill (shared with solver + verifier only) */
  receive_uivk: string;
  refund_ua: string;
  deadline_height: number;
  /** 16 random bytes, hex; never reused by the same user key */
  nonce: string;
  /** keyId of the user's ML-DSA-65 public key */
  user: string;
}

const INTENT_KEYS = ['chain', 'deadline_height', 'escrow', 'kind', 'min_out_zat', 'nonce', 'pay_zat', 'receive_ua', 'receive_uivk', 'refund_ua', 'user', 'v'];

export function checkIntentShape(i: unknown): asserts i is Intent {
  const o = i as Record<string, unknown>;
  if (!o || typeof o !== 'object') throw new ProtocolError('BAD_INTENT', 'not an object');
  const keys = Object.keys(o).sort();
  if (keys.join() !== INTENT_KEYS.join()) throw new ProtocolError('BAD_INTENT', `fields must be exactly ${INTENT_KEYS.join(', ')}`);
  if (o.v !== 1 || o.kind !== 'delivery' || o.chain !== 'zcash-testnet') throw new ProtocolError('BAD_INTENT', 'unsupported version, kind or chain');
  for (const k of ['pay_zat', 'min_out_zat']) if (typeof o[k] !== 'string' || !/^[1-9]\d{0,15}$/.test(o[k] as string)) throw new ProtocolError('BAD_INTENT', `${k} must be a positive whole number of zatoshi`);
  for (const k of ['escrow', 'receive_ua', 'refund_ua']) if (typeof o[k] !== 'string' || !/^utest1[0-9a-z]+$/.test(o[k] as string)) throw new ProtocolError('BAD_INTENT', `${k} must be a testnet unified address`);
  if (typeof o.receive_uivk !== 'string' || !/^uivktest1[0-9a-z]+$/.test(o.receive_uivk)) throw new ProtocolError('BAD_INTENT', 'receive_uivk must be a testnet incoming viewing key');
  if (!Number.isSafeInteger(o.deadline_height) || (o.deadline_height as number) <= 0) throw new ProtocolError('BAD_INTENT', 'deadline_height must be a block height');
  if (typeof o.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(o.nonce)) throw new ProtocolError('BAD_INTENT', 'nonce must be 16 bytes hex');
  if (typeof o.user !== 'string' || !/^[0-9a-f]{64}$/.test(o.user)) throw new ProtocolError('BAD_INTENT', 'user must be a key id');
}

export const intentHash = (i: Intent) => sha256Hex(`pqi1:intent:${canonical(i)}`);

export interface SignedIntent {
  intent: Intent;
  /** the user's ML-DSA-65 public key, base64 */
  user_pk: string;
  sig: string;
}

export function signIntent(user: SigningKey, fields: Omit<Intent, 'v' | 'kind' | 'chain' | 'user' | 'nonce'> & { nonce?: string }): SignedIntent {
  const intent: Intent = { v: 1, kind: 'delivery', chain: 'zcash-testnet', ...fields, nonce: fields.nonce ?? bytesToHex(randomBytes(16)), user: keyId(user.publicKey) };
  checkIntentShape(intent);
  return { intent, user_pk: toB64(user.publicKey), sig: sign(user, 'pqi1:intent:', canonical(intent)) };
}

/** Throws ProtocolError BAD_INTENT / WRONG_KEY / BAD_SIGNATURE; returns the intent hash. */
export function verifyIntent(s: SignedIntent): string {
  checkIntentShape(s.intent);
  const pk = fromB64(s.user_pk);
  if (keyId(pk) !== s.intent.user) throw new ProtocolError('WRONG_KEY', 'the signing key is not the key the intent names');
  if (!verifySig(pk, 'pqi1:intent:', canonical(s.intent), s.sig)) throw new ProtocolError('BAD_SIGNATURE', 'ML-DSA-65 signature does not verify over this intent');
  return intentHash(s.intent);
}

// ---------- envelope to the solver ----------

export interface Envelope {
  v: 1;
  kem: 'ML-KEM-768';
  aead: 'AES-256-GCM';
  /** keyId of the solver's KEM public key */
  to: string;
  intent_hash: string;
  kem_ct: string;
  iv: string;
  ct: string;
}

function envelopeKey(shared: Uint8Array, hash: string) {
  return hkdf(sha256, shared, enc.encode('pqi1:envelope:v1'), enc.encode(hash), 32);
}

export function seal(s: SignedIntent, solverKemPk: Uint8Array): Envelope {
  const hash = verifyIntent(s);
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(solverKemPk);
  const iv = randomBytes(12);
  const ct = gcm(envelopeKey(sharedSecret, hash), iv, enc.encode(hash)).encrypt(enc.encode(canonical(s)));
  return { v: 1, kem: 'ML-KEM-768', aead: 'AES-256-GCM', to: keyId(solverKemPk), intent_hash: hash, kem_ct: toB64(cipherText), iv: toB64(iv), ct: toB64(ct) };
}

/** Decrypts with the solver's KEM key and re-verifies the user signature and the hash. */
export function open(e: Envelope, solver: KemKey): SignedIntent {
  if (e.to !== keyId(solver.publicKey)) throw new ProtocolError('NOT_FOR_ME', 'envelope is sealed to another KEM key');
  let plain: Uint8Array;
  try {
    const shared = ml_kem768.decapsulate(fromB64(e.kem_ct), solver.secretKey);
    plain = gcm(envelopeKey(shared, e.intent_hash), fromB64(e.iv), enc.encode(e.intent_hash)).decrypt(fromB64(e.ct));
  } catch {
    throw new ProtocolError('BAD_ENVELOPE', 'decryption failed (wrong key or tampered ciphertext)');
  }
  const s = JSON.parse(dec.decode(plain)) as SignedIntent;
  if (verifyIntent(s) !== e.intent_hash) throw new ProtocolError('BAD_ENVELOPE', 'decrypted intent does not hash to the envelope hash');
  return s;
}

// ---------- memos ----------

export const memo = {
  funding: (hash: string) => `pqi1:${hash}`,
  /** A fill names the key id (sha256 of the ML-DSA-65 public key) of the solver that paid it. Only
   *  the sender of a shielded transaction writes its memo, so no other solver can put its own key
   *  on a delivery it did not make; the fill claim is then signed by that same key. */
  fill: (hash: string, solver: string) => `pqi1:${hash}:fill:${solver}`,
  /** The Oct 20, 2026 run's fill memo, which names no solver. A verifier accepts it only for intents
   *  it lists as legacy, and only while it pays a single solver key. */
  legacyFill: (hash: string) => `pqi1:${hash}:fill`,
  release: (hash: string) => `pqi1:${hash}:release`,
  refund: (hash: string) => `pqi1:${hash}:refund`,
  /** The log head at `seq`, and the txid of the previous anchor (GENESIS for the first), so anchors
   *  form one chain: two anchors naming the same previous anchor are a visible fork. Without `prev`,
   *  the Oct 20, 2026 form, which names no previous anchor. */
  anchor: (seq: number, head: string, prev?: string) => `pqi1:anchor:${seq}:${head}${prev === undefined ? '' : `:${prev}`}`,
};

/** What a memo says about a fill of `hash`: the solver key id it names (null for the legacy form),
 *  or null if it is not a fill memo for this intent at all. */
export function readFillMemo(m: string | null | undefined, hash: string): { solver: string | null } | null {
  if (!m) return null;
  const legacy = memo.legacyFill(hash);
  if (m === legacy) return { solver: null };
  const id = m.startsWith(`${legacy}:`) ? m.slice(legacy.length + 1) : '';
  return /^[0-9a-f]{64}$/.test(id) ? { solver: id } : null;
}

// ---------- fill attestation (solver) ----------

export interface FillClaim {
  intent_hash: string;
  fill_txid: string;
  /** where the escrow should be released to */
  solver_ua: string;
  solver: string;
  solver_pk: string;
  sig: string;
}

export function signFill(solver: SigningKey, intent_hash: string, fill_txid: string, solver_ua: string): FillClaim {
  const body = { intent_hash, fill_txid, solver_ua, solver: keyId(solver.publicKey) };
  return { ...body, solver_pk: toB64(solver.publicKey), sig: sign(solver, 'pqi1:fill:', canonical(body)) };
}

export function verifyFill(f: FillClaim): void {
  const pk = fromB64(f.solver_pk);
  if (keyId(pk) !== f.solver) throw new ProtocolError('WRONG_KEY', 'fill signed by a key other than the one it names');
  const body = { intent_hash: f.intent_hash, fill_txid: f.fill_txid, solver_ua: f.solver_ua, solver: f.solver };
  if (!verifySig(pk, 'pqi1:fill:', canonical(body), f.sig)) throw new ProtocolError('BAD_SIGNATURE', 'fill attestation signature does not verify');
}

// ---------- attestation log ----------

export type LogStatus = 'FUNDED' | 'SETTLED' | 'REFUNDED' | 'REJECTED' | 'ANCHORED';

export interface LogBody {
  seq: number;
  prev: string;
  status: LogStatus;
  intent_hash: string | null;
  reason: string | null;
  refs: Record<string, string>;
  at_height: number;
  verifier: string;
}

export interface LogEntry extends LogBody {
  hash: string;
  sig: string;
}

export const GENESIS = '0'.repeat(64);
export const entryHash = (b: LogBody) => sha256Hex(`pqi1:log:${canonical(b)}`);

export function appendEntry(log: LogEntry[], verifier: SigningKey, e: Omit<LogBody, 'seq' | 'prev' | 'verifier'>): LogEntry {
  const body: LogBody = { ...e, seq: log.length, prev: log.length ? log[log.length - 1].hash : GENESIS, verifier: keyId(verifier.publicKey) };
  const hash = entryHash(body);
  const entry = { ...body, hash, sig: sign(verifier, 'pqi1:log:', hash) };
  log.push(entry);
  return entry;
}

export interface LogCheck {
  ok: boolean;
  head: string;
  entries: number;
  /** first problem, if any: index and what is wrong */
  error: { seq: number; problem: string } | null;
}

/** Re-verifies every hash, link and ML-DSA signature against the verifier's public key. */
export function verifyLog(log: LogEntry[], verifierPk: Uint8Array): LogCheck {
  const vid = keyId(verifierPk);
  let prev = GENESIS;
  for (let i = 0; i < log.length; i++) {
    const { hash, sig, ...body } = log[i];
    const bad = (problem: string): LogCheck => ({ ok: false, head: prev, entries: i, error: { seq: i, problem } });
    if (body.seq !== i) return bad(`sequence ${body.seq}, expected ${i}`);
    if (body.prev !== prev) return bad('does not link to the previous entry');
    if (body.verifier !== vid) return bad('names another verifier key');
    if (entryHash(body) !== hash) return bad('content does not match its hash');
    if (!verifySig(verifierPk, 'pqi1:log:', hash, sig)) return bad('ML-DSA-65 signature does not verify');
    prev = hash;
  }
  return { ok: true, head: prev, entries: log.length, error: null };
}

// ---------- anchor chain ----------

/** What an anchor memo says: the anchored sequence number and head, and the previous anchor's txid
 *  (null for the legacy form that names none). Null if it is not an anchor memo. */
export function readAnchorMemo(m: string | null | undefined): { seq: number; head: string; prev: string | null } | null {
  const r = /^pqi1:anchor:(0|[1-9]\d{0,8}):([0-9a-f]{64})(?::([0-9a-f]{64}))?$/.exec(m ?? '');
  return r ? { seq: Number(r[1]), head: r[2], prev: r[3] ?? null } : null;
}

/** An anchor transaction as the escrow's own history shows it (every payment out of the escrow). */
export interface AnchorSeen {
  txid: string;
  memo: string;
}

/** The Oct 20, 2026 anchor (seq 8), sent before anchors named their predecessor. It is the only
 *  anchor in the legacy form that checkAnchors accepts by default, and only as the chain's root. */
export const OCT20_LEGACY_ANCHOR = 'a7d960386f2d8dc926003e700b15bcc761b6e72419765ea6f958a85d73a65a73';

export type AnchorProblem =
  | { kind: 'ANCHOR_FORK'; txids: [string, string]; detail: string }
  | { kind: 'ANCHOR_LEGACY_LATE'; txid: string; seq: number }
  | { kind: 'ANCHOR_ORPHAN'; txid: string; seq: number }
  | { kind: 'ANCHOR_PREV_UNKNOWN'; txid: string; prev: string }
  | { kind: 'ANCHOR_SEQ_NOT_INCREASING'; txid: string; seq: number; prevSeq: number }
  | { kind: 'ANCHOR_HEAD_MISMATCH'; txid: string; seq: number; detail: string }
  | { kind: 'ANCHOR_NOT_IN_HISTORY'; txid: string; seq: number }
  | { kind: 'ANCHOR_NOT_IN_LOG'; txid: string; seq: number }
  | { kind: 'LOG_BEHIND_ANCHORS'; anchors: { txid: string; seq: number }[]; detail: string };

export interface AnchorCheck {
  ok: boolean;
  /** anchors in chain order (oldest first) */
  chain: { txid: string; seq: number; head: string; prev: string | null }[];
  /** anchors past the end of this log: it is behind (cut short, or older than the escrow's newest
   *  anchors), and they cannot be checked against it. A problem (LOG_BEHIND_ANCHORS) unless
   *  `allowBehind` is set, so a desk cannot hide its latest decisions by serving a shorter log. */
  later: { txid: string; seq: number }[];
  /** log entries after the last anchor this log covers */
  unanchored: number;
  problems: AnchorProblem[];
}

/**
 * Checks a log against every anchor the escrow ever sent (`sent`, from its full history, which the
 * published full viewing key shows to anyone):
 *  - each anchor names the previous one by txid (the first names GENESIS), and no two name the same
 *    one: two anchored heads for one history are ANCHOR_FORK, whichever audience was shown which. An
 *    anchor that names none (the legacy form) is accepted only if it is listed in `legacyRoots`
 *    (default: the Oct 20 anchor) and only as the root; any other is ANCHOR_LEGACY_LATE. Two roots
 *    (legacy or GENESIS) are ANCHOR_FORK. Every anchor must be on the one chain walked from the
 *    root; one that is not is ANCHOR_ORPHAN, so the chain holds every anchor or the check fails;
 *  - sequence numbers increase along the chain;
 *  - every anchor within this log's length anchors this log's entry hash at its seq, and appears in the
 *    log as an ANCHORED entry naming the same transaction (ANCHOR_HEAD_MISMATCH / ANCHOR_NOT_IN_LOG:
 *    the log shown is not the log anchored, or hides an anchor);
 *  - every ANCHORED entry in the log names a transaction in the history with the same seq, head and
 *    previous anchor (ANCHOR_NOT_IN_HISTORY);
 *  - no anchor lies past the end of the log (LOG_BEHIND_ANCHORS: the log was cut short before the
 *    escrow's newest anchors), unless `allowBehind` is set to check an older record on purpose.
 * The log itself should already have passed verifyLog.
 */
export function checkAnchors(log: LogEntry[], sent: AnchorSeen[], opts: { legacyRoots?: string[]; allowBehind?: boolean } = {}): AnchorCheck {
  const problems: AnchorProblem[] = [];
  const legacyRoots = opts.legacyRoots ?? [OCT20_LEGACY_ANCHOR];
  const anchors = sent.flatMap((a) => {
    const r = readAnchorMemo(a.memo);
    return r ? [{ txid: a.txid, ...r }] : [];
  });
  const byTxid = new Map(anchors.map((a) => [a.txid, a]));
  // Forks: two anchors after the same previous one (a legacy anchor counts as after genesis: two
  // roots are two chains), or two different heads for one seq.
  const after = new Map<string, (typeof anchors)[number]>();
  for (const a of anchors) {
    if (a.prev === null && !legacyRoots.includes(a.txid)) problems.push({ kind: 'ANCHOR_LEGACY_LATE', txid: a.txid, seq: a.seq });
    const from = a.prev ?? GENESIS;
    const twin = after.get(from);
    if (twin) problems.push({ kind: 'ANCHOR_FORK', txids: [twin.txid, a.txid], detail: `both anchor after ${from === GENESIS ? 'genesis' : from}` });
    else after.set(from, a);
    const sameSeq = anchors.find((b) => b !== a && b.seq === a.seq && b.head !== a.head && b.txid < a.txid);
    if (sameSeq) problems.push({ kind: 'ANCHOR_FORK', txids: [sameSeq.txid, a.txid], detail: `two heads anchored for entry ${a.seq}` });
    if (a.prev !== null && a.prev !== GENESIS && !byTxid.has(a.prev)) problems.push({ kind: 'ANCHOR_PREV_UNKNOWN', txid: a.txid, prev: a.prev });
    const p = a.prev && byTxid.get(a.prev);
    if (p && p.seq >= a.seq) problems.push({ kind: 'ANCHOR_SEQ_NOT_INCREASING', txid: a.txid, seq: a.seq, prevSeq: p.seq });
  }
  // The chain, oldest first: start from the anchor with no predecessor and follow the links.
  const chain: AnchorCheck['chain'] = [];
  let cur = anchors.find((a) => a.prev === null || a.prev === GENESIS);
  while (cur && chain.length < anchors.length) {
    chain.push({ txid: cur.txid, seq: cur.seq, head: cur.head, prev: cur.prev });
    const id: string = cur.txid;
    cur = anchors.find((a) => a.prev === id);
  }
  // Every anchor the escrow sent is on that one chain, or the history holds another chain.
  const onChain = new Set(chain.map((a) => a.txid));
  for (const a of anchors) if (!onChain.has(a.txid)) problems.push({ kind: 'ANCHOR_ORPHAN', txid: a.txid, seq: a.seq });
  const later: AnchorCheck['later'] = [];
  const logged = new Map(log.filter((e) => e.status === 'ANCHORED').map((e) => [e.refs.anchor_txid, e]));
  for (const a of anchors) {
    if (a.seq >= log.length) {
      later.push({ txid: a.txid, seq: a.seq });
      continue;
    }
    if (log[a.seq].hash !== a.head) problems.push({ kind: 'ANCHOR_HEAD_MISMATCH', txid: a.txid, seq: a.seq, detail: `anchors ${a.head.slice(0, 12)}…, the log has ${log[a.seq].hash.slice(0, 12)}…` });
    if (!logged.has(a.txid)) problems.push({ kind: 'ANCHOR_NOT_IN_LOG', txid: a.txid, seq: a.seq });
  }
  for (const [txid, e] of logged) {
    const a = byTxid.get(txid);
    const prevRef = e.refs.prev_anchor_txid ?? null;
    if (!a || a.seq !== Number(e.refs.anchored_seq) || a.head !== e.refs.anchored_head || a.prev !== prevRef) problems.push({ kind: 'ANCHOR_NOT_IN_HISTORY', txid, seq: Number(e.refs.anchored_seq) });
  }
  if (later.length && !opts.allowBehind) problems.push({ kind: 'LOG_BEHIND_ANCHORS', anchors: later, detail: `the escrow anchored entries up to #${Math.max(...later.map((a) => a.seq))}, but this log ends at #${log.length - 1}: it was cut short or is out of date` });
  const covered = Math.max(-1, ...anchors.filter((a) => a.seq < log.length).map((a) => a.seq));
  return { ok: problems.length === 0, chain, later, unanchored: log.length - 1 - covered, problems };
}

/** Two logs that both verify under the same verifier key and differ at some entry: the first such
 *  seq and both hashes. Each entry is ML-DSA signed, so this is the verifier's own signature on two
 *  histories. Null if one log is a prefix of the other. */
export function findEquivocation(a: LogEntry[], b: LogEntry[], verifierPk: Uint8Array): { seq: number; a: string; b: string } | null {
  for (const l of [a, b]) {
    const c = verifyLog(l, verifierPk);
    if (!c.ok) throw new ProtocolError('BAD_LOG', `a log does not verify at entry ${c.error?.seq}: ${c.error?.problem}`);
  }
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i].hash !== b[i].hash) return { seq: i, a: a[i].hash, b: b[i].hash };
  return null;
}
