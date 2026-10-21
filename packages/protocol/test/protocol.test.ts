import { describe, expect, it } from 'vitest';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import {
  appendEntry,
  canonical,
  checkAnchors,
  findEquivocation,
  GENESIS,
  fromB64,
  hexToBytes,
  intentHash,
  kemKeyFromSeed,
  keyId,
  newKemKey,
  newSigningKey,
  memo,
  open,
  readAnchorMemo,
  readFillMemo,
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

  it('base64 has one spelling per value: non-zero padding bits are refused, so a signed intent cannot be re-spelled', () => {
    expect(fromB64('QQ==')).toEqual(Uint8Array.of(0x41));
    for (const s of ['QR==', 'QUJ=', 'QUI', 'Q===']) expect(code(() => fromB64(s))).toBe('BAD_ENCODING');
    // An ML-DSA-65 public key is 1952 bytes, so its base64 ends in one '=' with 2 padding bits.
    // Flipping one of them gives a different string for the same key.
    const s = signIntent(newSigningKey(), fields);
    const pk = s.user_pk;
    expect(pk.endsWith('=') && !pk.endsWith('==')).toBe(true);
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const respelled = pk.slice(0, -2) + B64[B64.indexOf(pk.at(-2)!) ^ 1] + '=';
    expect(respelled).not.toBe(pk);
    expect(code(() => verifyIntent({ ...s, user_pk: respelled }))).toBe('BAD_ENCODING');
    expect(code(() => verifyIntent(s))).toBe('OK');
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

  it('a fill memo names the solver key that paid it; the legacy form names none; anything else is not a fill memo', () => {
    const h = 'ab'.repeat(32);
    const id = keyId(solver.publicKey);
    expect(memo.fill(h, id)).toBe(`pqi1:${h}:fill:${id}`);
    expect(new TextEncoder().encode(memo.fill(h, id)).length).toBeLessThanOrEqual(512);
    expect(readFillMemo(memo.fill(h, id), h)).toEqual({ solver: id });
    expect(readFillMemo(memo.legacyFill(h), h)).toEqual({ solver: null });
    expect(readFillMemo(memo.fill('cd'.repeat(32), id), h)).toBeNull();
    expect(readFillMemo(`pqi1:${h}:fll`, h)).toBeNull();
    expect(readFillMemo(`${memo.legacyFill(h)}:${id.toUpperCase()}`, h)).toBeNull();
    expect(readFillMemo(`${memo.fill(h, id)}x`, h)).toBeNull();
    expect(readFillMemo(null, h)).toBeNull();
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

describe('anchor chain', () => {
  const verifier = newSigningKey();
  const tx = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
  /** A log of `n` decisions with an anchor after every `every` entries, and the escrow's history of those anchors. */
  function anchored(n: number, every: number, key = verifier) {
    const log: LogEntry[] = [];
    const sent: { txid: string; memo: string }[] = [];
    let prev = GENESIS;
    for (let i = 0; i < n; i++) {
      appendEntry(log, key, { status: 'REJECTED', intent_hash: 'a'.repeat(64), reason: `R${i}`, refs: {}, at_height: 100 + i });
      if ((i + 1) % every === 0) {
        const seq = log.length - 1;
        const head = log[seq].hash;
        const txid = tx(sent.length + 1);
        sent.push({ txid, memo: memo.anchor(seq, head, prev) });
        appendEntry(log, key, { status: 'ANCHORED', intent_hash: null, reason: null, refs: { anchor_txid: txid, anchored_seq: String(seq), anchored_head: head, prev_anchor_txid: prev }, at_height: 100 + i });
        prev = txid;
      }
    }
    return { log, sent };
  }

  it('an anchor memo names the previous anchor; the legacy form names none', () => {
    const h = 'ab'.repeat(32);
    expect(readAnchorMemo(memo.anchor(8, h, tx(7)))).toEqual({ seq: 8, head: h, prev: tx(7) });
    expect(readAnchorMemo(memo.anchor(8, h))).toEqual({ seq: 8, head: h, prev: null });
    expect(readAnchorMemo(`pqi1:anchor:08:${h}`)).toBeNull();
    expect(readAnchorMemo(`pqi1:${h}:release`)).toBeNull();
    expect(new TextEncoder().encode(memo.anchor(123456789, h, tx(7))).length).toBeLessThanOrEqual(512);
  });

  it('one chain of anchors checks out; anchors past the log’s end are reported as later, not as problems', () => {
    const { log, sent } = anchored(6, 2);
    const c = checkAnchors(log, sent);
    expect(c).toMatchObject({ ok: true, problems: [], later: [], unanchored: 1 });
    expect(c.chain.map((a) => a.txid)).toEqual([tx(1), tx(2), tx(3)]);
    expect(checkAnchors(log.slice(0, 4), sent)).toMatchObject({ ok: true, later: [{ txid: tx(2), seq: 4 }, { txid: tx(3), seq: 7 }] });
  });

  it('two heads anchored after the same anchor is a fork, whichever log is shown; a log that hides an anchor or was not the one anchored is caught', () => {
    const { log, sent } = anchored(4, 2);
    // The verifier re-writes history after the first anchor for another audience and anchors that too.
    const other = log.slice(0, 3);
    appendEntry(other, verifier, { status: 'SETTLED', intent_hash: 'b'.repeat(64), reason: null, refs: {}, at_height: 200 });
    appendEntry(other, verifier, { status: 'REJECTED', intent_hash: 'a'.repeat(64), reason: 'R3', refs: {}, at_height: 201 });
    const forkTx = tx(9);
    const otherSent = [...sent, { txid: forkTx, memo: memo.anchor(4, other[4].hash, tx(1)) }];
    appendEntry(other, verifier, { status: 'ANCHORED', intent_hash: null, reason: null, refs: { anchor_txid: forkTx, anchored_seq: '4', anchored_head: other[4].hash, prev_anchor_txid: tx(1) }, at_height: 202 });
    for (const shown of [log, other]) {
      const c = checkAnchors(shown, otherSent);
      expect(c.ok).toBe(false);
      expect(c.problems.map((p) => p.kind)).toEqual(expect.arrayContaining(['ANCHOR_FORK', 'ANCHOR_HEAD_MISMATCH', 'ANCHOR_NOT_IN_LOG']));
    }
    // Both logs verify under the verifier's key, so the two signed entries at 3 are the evidence.
    expect(findEquivocation(log, other, verifier.publicKey)).toEqual({ seq: 3, a: log[3].hash, b: other[3].hash });
    expect(findEquivocation(log, log.slice(0, 3), verifier.publicKey)).toBeNull();
  });

  it('an ANCHORED entry naming a transaction the escrow never sent, or a broken link, is caught', () => {
    const { log, sent } = anchored(4, 2);
    expect(checkAnchors(log, sent.slice(0, 1)).problems.map((p) => p.kind)).toContain('ANCHOR_NOT_IN_HISTORY');
    const relinked = [sent[0], { txid: sent[1].txid, memo: memo.anchor(3, log[3].hash, tx(42)) }];
    expect(checkAnchors(log, relinked).problems.map((p) => p.kind)).toEqual(expect.arrayContaining(['ANCHOR_PREV_UNKNOWN', 'ANCHOR_NOT_IN_HISTORY']));
  });
});
