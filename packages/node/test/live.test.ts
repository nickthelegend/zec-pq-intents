// Live, read-only: every published transaction re-checked through its viewing key on Zcash testnet,
// and the verifier's refusals re-derived on a fresh verifier (refusals never pay, so no wallet is used).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromB64, intentHash, keyId, memo, newSigningKey, signFill, verifyLog, type LogEntry, type SignedIntent } from '@pqi/protocol';
import { chainTip, scan, Verifier, zingoConfig } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const I = d.intents as Record<'A' | 'B' | 'C', { hash: string; signed: SignedIntent }>;
const W = d.wallets as Record<string, { address: string; uivk: string }>;
const log = d.log as LogEntry[];

/** The solver key the fresh verifiers below accept fill claims from. */
const solver = newSigningKey();
const claim = (hash: string, txid: string) => signFill(solver, hash, txid, W.solver.address);
/** Every payout a fresh verifier could make is recorded up front under this marker, so a test that
 *  reaches a payout gets the marker back and nothing is ever sent (payOnce never pays a key twice). */
const NEVER_SENT = 'test-marker-no-payment-sent';
const allPayouts = Object.fromEntries((['A', 'B', 'C'] as const).flatMap((k) => [`release:${I[k].hash}`, `refund:${I[k].hash}`]).map((k) => [k, NEVER_SENT]));

/** A verifier with a new key and (optionally) prior state, on the published escrow. No wallet is used. */
function freshVerifier(prior?: { nonces?: Record<string, Record<string, string>>; closed?: Record<string, 'SETTLED' | 'REFUNDED'> }, opts: { tip?: () => Promise<number> } = {}) {
  const key = newSigningKey();
  const statePath = join(mkdtempSync(join(tmpdir(), 'pqi-')), 'state.json');
  writeFileSync(statePath, JSON.stringify({ log: [], nonces: prior?.nonces ?? {}, closed: prior?.closed ?? {}, payouts: allPayouts }));
  const v = new Verifier({ key, escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [keyId(solver.publicKey)], zingo: zingoConfig(), statePath, tip: opts.tip ?? chainTip });
  return { v, key };
}

describe('published run, re-checked on testnet', () => {
  it('the log verifies with the published verifier key', () => {
    const c = verifyLog(log, fromB64(d.keys.verifier.pk));
    expect(c).toMatchObject({ ok: true, entries: log.length });
    expect(log.map((e) => e.status)).toEqual(['SETTLED', 'SETTLED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED', 'REFUNDED', 'ANCHORED']);
  });

  it('the escrow key sees each intent funded with its own memo, in one transaction', async () => {
    for (const k of ['A', 'B', 'C'] as const) {
      const r = await scan(W.escrow.uivk, d.txs.funding, 60_000, memo.funding(I[k].hash));
      expect(r.ok, `${k}: ${r.reasons}`).toBe(true);
      expect(r.transparent).toBe(false);
    }
  });

  it('the receive key sees A and B delivered, C’s wrong-memo fill not credited, and C’s late fill after its deadline', async () => {
    for (const k of ['A', 'B'] as const) expect((await scan(W.receive.uivk, d.txs.fills[I[k].hash], 40_000, memo.fill(I[k].hash))).ok).toBe(true);
    const wrong = await scan(W.receive.uivk, d.txs.wrongMemoFill, 40_000, memo.fill(I.C.hash));
    expect(wrong.reasons).toContain('MEMO_MISMATCH');
    const late = await scan(W.receive.uivk, d.txs.lateFill, 40_000, memo.fill(I.C.hash));
    expect(late.ok).toBe(true);
    expect(late.height!).toBeGreaterThan(I.C.signed.intent.deadline_height);
  });

  it('the solver key sees both releases, the user key the refund, the anchor key the anchored head', async () => {
    for (const e of log.filter((x) => x.status === 'SETTLED')) expect((await scan(W.solver.uivk, e.refs.release_txid, Number(e.refs.released_zat), memo.release(e.intent_hash!))).ok).toBe(true);
    const ref = log.find((x) => x.status === 'REFUNDED')!;
    expect((await scan(W.user.uivk, ref.refs.refund_txid, Number(ref.refs.refunded_zat), memo.refund(ref.intent_hash!))).ok).toBe(true);
    const a = log.find((x) => x.status === 'ANCHORED')!;
    expect(a.refs.anchored_head).toBe(log[Number(a.refs.anchored_seq)].hash);
    expect((await scan(W.anchor.uivk, a.refs.anchor_txid, 1, memo.anchor(Number(a.refs.anchored_seq), a.refs.anchored_head))).ok).toBe(true);
  });
});

describe('a fresh verifier refuses the same attacks, from chain data alone', () => {

  it('changed intent → BAD_SIGNATURE; another key naming the user → WRONG_KEY; each a signed entry', async () => {
    const { v, key } = freshVerifier();
    const tampered = { ...I.A.signed, intent: { ...I.A.signed.intent, min_out_zat: '1' } };
    expect((await v.settle(tampered, d.txs.funding, claim(intentHash(tampered.intent), d.txs.fills[I.A.hash]))).reason).toBe('BAD_SIGNATURE');
    expect((await v.settle(d.attacks.forgedAsUser, d.txs.funding, claim(I.A.hash, d.txs.fills[I.A.hash]))).reason).toBe('WRONG_KEY');
    expect(verifyLog(v.state.log, key.publicKey)).toMatchObject({ ok: true, entries: 2 });
  });

  it('C: a fill with the wrong memo is not credited; a correct fill after the deadline is EXPIRED', async () => {
    const { v } = freshVerifier();
    expect((await v.settle(I.C.signed, d.txs.funding, claim(I.C.hash, d.txs.wrongMemoFill))).reason).toBe('FILL_NOT_CREDITED:MEMO_MISMATCH+AMOUNT_TOO_LOW');
    expect((await v.settle(I.C.signed, d.txs.funding, claim(I.C.hash, d.txs.lateFill))).reason).toBe('EXPIRED');
  });

  it('after A settled: A again → ALREADY_SETTLED; a new intent with A’s nonce → NONCE_REUSED', async () => {
    const user = I.A.signed.intent.user;
    const { v } = freshVerifier({ nonces: { [user]: { [I.A.signed.intent.nonce]: I.A.hash } }, closed: { [I.A.hash]: 'SETTLED' } });
    expect((await v.settle(I.A.signed, d.txs.funding, claim(I.A.hash, d.txs.fills[I.A.hash]))).reason).toBe('ALREADY_SETTLED');
    const reuse = d.attacks.reuse as SignedIntent;
    expect((await v.settle(reuse, d.txs.funding, claim(intentHash(reuse.intent), d.txs.fills[I.A.hash]))).reason).toBe('NONCE_REUSED');
  });
});

describe('fill claims: only the configured solver is paid', () => {
  it('a claim on A’s real fill signed by anyone else → FILL_UNKNOWN_SOLVER; the solver’s own claim settles', async () => {
    const { v } = freshVerifier();
    // The user (or anyone who learns the fill txid) signs a claim with their own key and address.
    const thief = newSigningKey();
    const stolen = signFill(thief, I.A.hash, d.txs.fills[I.A.hash], W.user.address);
    expect(await v.settle(I.A.signed, d.txs.funding, stolen)).toMatchObject({ status: 'REJECTED', reason: 'FILL_UNKNOWN_SOLVER' });
    const paid = await v.settle(I.A.signed, d.txs.funding, claim(I.A.hash, d.txs.fills[I.A.hash]));
    expect(paid).toMatchObject({ status: 'SETTLED', payoutTxid: NEVER_SENT });
    expect(v.state.log.map((e) => e.reason ?? e.status)).toEqual(['FILL_UNKNOWN_SOLVER', 'SETTLED']);
  });
});
