// zec-pq-intents protocol. Browser- and Node-safe (no node: imports).
//
// An intent asks a solver to deliver `min_out_zat` to the user's fresh `receive_ua` before
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
  fill: (hash: string) => `pqi1:${hash}:fill`,
  release: (hash: string) => `pqi1:${hash}:release`,
  refund: (hash: string) => `pqi1:${hash}:refund`,
  anchor: (seq: number, head: string) => `pqi1:anchor:${seq}:${head}`,
};

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
