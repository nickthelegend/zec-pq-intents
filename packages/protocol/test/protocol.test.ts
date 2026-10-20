import { describe, expect, it } from 'vitest';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import {
  appendEntry,
  canonical,
  fromB64,
  hexToBytes,
  intentHash,
  kemKeyFromSeed,
  keyId,
  newKemKey,
  newSigningKey,
  open,
  seal,
  signFill,
  signIntent,
  signingKeyFromSeed,
  toB64,
  verifyFill,
  verifyIntent,
  verifyLog,
  type LogEntry,
  type SignedIntent,
} from '../src/index.js';

const UA = (c: string) => `utest1${c.repeat(40)}`;
const fields = { escrow: UA('e'), pay_zat: '60000', min_out_zat: '40000', receive_ua: UA('r'), receive_uivk: `uivktest1${'k'.repeat(40)}`, refund_ua: UA('f'), deadline_height: 4_600_000 };
const code = (f: () => unknown) => {
  try {
    f();
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
};

describe('keys', () => {
  it('derive deterministically from seeds with FIPS 203/204 sizes', () => {
    const a = signingKeyFromSeed(new Uint8Array(32).fill(7));
    const b = signingKeyFromSeed(new Uint8Array(32).fill(7));
    expect(keyId(a.publicKey)).toBe(keyId(b.publicKey));
    expect([a.publicKey.length, a.secretKey.length]).toEqual([1952, 4032]);
    const k = kemKeyFromSeed(new Uint8Array(64).fill(9));
    expect([k.publicKey.length, k.secretKey.length]).toEqual([1184, 2400]);
    expect(keyId(kemKeyFromSeed(new Uint8Array(64).fill(9)).publicKey)).toBe(keyId(k.publicKey));
    // sizes of the primitives themselves
    expect(ml_dsa65.sign(new Uint8Array(1), a.secretKey).length).toBe(3309);
    expect(ml_kem768.encapsulate(k.publicKey).cipherText.length).toBe(1088);
  });

  it('base64 and canonical encoding round-trip and are stable', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33, 1952]) {
      const u = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 255);
      expect(fromB64(toB64(u))).toEqual(u);
      expect(toB64(u)).toBe(Buffer.from(u).toString('base64'));
    }
    expect(canonical({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
    expect(() => canonical({ x: 1.5 })).toThrow(/non-integer/);
  });
});

describe('intents', () => {
  const user = newSigningKey();
  const s = signIntent(user, fields);

  it('a signed intent verifies and hashes the same as its canonical form', () => {
    expect(verifyIntent(s)).toBe(intentHash(s.intent));
    expect(s.intent.user).toBe(keyId(user.publicKey));
    expect(s.intent.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changing any field changes the hash and breaks the signature', () => {
    for (const [k, v] of Object.entries({ pay_zat: '60001', min_out_zat: '40001', receive_ua: UA('x'), refund_ua: UA('y'), deadline_height: 4_600_001, nonce: '0'.repeat(32), escrow: UA('z') })) {
      const t: SignedIntent = { ...s, intent: { ...s.intent, [k]: v } };
      expect(intentHash(t.intent)).not.toBe(intentHash(s.intent));
      expect(code(() => verifyIntent(t))).toBe('BAD_SIGNATURE');
    }
  });

  it('a signature from another key is refused, whether or not it names that key', () => {
    const mallory = newSigningKey();
    const forged = signIntent(mallory, { ...fields, nonce: s.intent.nonce });
    expect(code(() => verifyIntent({ ...forged, intent: { ...forged.intent, user: s.intent.user } }))).toBe('WRONG_KEY');
    expect(code(() => verifyIntent({ ...s, user_pk: forged.user_pk }))).toBe('WRONG_KEY');
  });

  it('malformed intents are refused before any signature work', () => {
    expect(code(() => signIntent(user, { ...fields, pay_zat: '0' }))).toBe('BAD_INTENT');
    expect(code(() => signIntent(user, { ...fields, receive_ua: 'tmabc' }))).toBe('BAD_INTENT');
    expect(code(() => verifyIntent({ ...s, intent: { ...s.intent, extra: 1 } as never }))).toBe('BAD_INTENT');
  });
});

describe('envelope (ML-KEM-768 + AES-256-GCM)', () => {
  const user = newSigningKey();
  const solver = newKemKey();
  const s = signIntent(user, fields);

  it('only the solver opens it, and gets the signed intent back', () => {
    const e = seal(s, solver.publicKey);
    expect(e.ct).not.toContain('utest1');
    expect(open(e, solver)).toEqual(JSON.parse(canonical(s)));
  });

  it('another KEM key, a flipped ciphertext bit or a swapped intent hash fail', () => {
    const e = seal(s, solver.publicKey);
    expect(code(() => open(e, newKemKey()))).toBe('NOT_FOR_ME');
    const ct = fromB64(e.ct);
    ct[5] ^= 1;
    expect(code(() => open({ ...e, ct: toB64(ct) }, solver))).toBe('BAD_ENVELOPE');
    expect(code(() => open({ ...e, intent_hash: 'ab'.repeat(32) }, solver))).toBe('BAD_ENVELOPE');
  });
});

describe('fill attestation and log', () => {
  const solver = newSigningKey();
  const verifier = newSigningKey();

  it('a fill claim verifies; a changed txid or another key does not', () => {
    const f = signFill(solver, 'ab'.repeat(32), 'cd'.repeat(32), UA('s'));
    expect(code(() => verifyFill(f))).toBe('OK');
    expect(code(() => verifyFill({ ...f, fill_txid: 'ce'.repeat(32) }))).toBe('BAD_SIGNATURE');
    expect(code(() => verifyFill({ ...f, solver_pk: toB64(newSigningKey().publicKey) }))).toBe('WRONG_KEY');
  });

  it('the log verifies end to end, and editing, dropping, reordering or re-signing with another key is caught', () => {
    const log: LogEntry[] = [];
    appendEntry(log, verifier, { status: 'FUNDED', intent_hash: 'a'.repeat(64), reason: null, refs: { funding_txid: 'f'.repeat(64) }, at_height: 10 });
    appendEntry(log, verifier, { status: 'REJECTED', intent_hash: 'b'.repeat(64), reason: 'NONCE_REUSED', refs: {}, at_height: 11 });
    appendEntry(log, verifier, { status: 'SETTLED', intent_hash: 'a'.repeat(64), reason: null, refs: { release_txid: 'e'.repeat(64) }, at_height: 12 });
    const ok = verifyLog(log, verifier.publicKey);
    expect(ok).toMatchObject({ ok: true, entries: 3, head: log[2].hash });
    expect(verifyLog([{ ...log[0], status: 'SETTLED' }, ...log.slice(1)], verifier.publicKey).error).toEqual({ seq: 0, problem: 'content does not match its hash' });
    expect(verifyLog([log[0], log[2]], verifier.publicKey).error?.seq).toBe(1);
    expect(verifyLog([log[1], log[0], log[2]], verifier.publicKey).ok).toBe(false);
    expect(verifyLog(log, newSigningKey().publicKey).error?.problem).toBe('names another verifier key');
    const sig = fromB64(log[1].sig);
    sig[0] ^= 1;
    expect(verifyLog([log[0], { ...log[1], sig: toB64(sig) }, log[2]], verifier.publicKey).error).toEqual({ seq: 1, problem: 'ML-DSA-65 signature does not verify' });
    expect(hexToBytes(ok.head).length).toBe(32);
  });
});
