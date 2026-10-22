// The verifier's own limits (local: a held tip; refusals of a property of the signed intent are
// decided before any funding is read), and what a failure right after a payout leaves behind
// (Zcash testnet: A's real funding and fill are read; payouts are recorded up front, so nothing is
// sent, and the escrow wallet path does not exist).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEntry, GENESIS, keyId, memo, newSigningKey, signFill, signIntent, type LogEntry, type SignedIntent } from '@pqi/protocol';
import { chainTip, FEE_BUDGET_ZAT, Verifier, zingoConfig, type VerifierState } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const W = d.wallets as Record<string, { address: string; uivk: string }>;
const A = d.intents.A as { hash: string; signed: SignedIntent };
const TIP = 4_600_000;
const NEVER_SENT = 'test-marker-no-payment-sent';

function verifier() {
  const statePath = join(mkdtempSync(join(tmpdir(), 'pqi-v-')), 'state.json');
  writeFileSync(statePath, JSON.stringify({ log: [], nonces: {}, closed: {}, payouts: {}, sending: {} }));
  return new Verifier({ key: newSigningKey(), escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [], zingo: zingoConfig(), statePath, tip: async () => TIP });
}

describe('verifier limits', () => {
  it(`an intent paying at most the ${FEE_BUDGET_ZAT} zat fee budget is refused (PAY_BELOW_FEE_BUDGET): a release or refund of it would pay nothing, and fail on every tick`, async () => {
    const v = verifier();
    const s = signIntent(newSigningKey(), { escrow: W.escrow.address, pay_zat: FEE_BUDGET_ZAT.toString(), min_out_zat: '1', receive_ua: W.receive.address, receive_uivk: W.receive.uivk, refund_ua: W.user.address, deadline_height: TIP - 100 });
    expect(await v.refund(s, 'ab'.repeat(32))).toMatchObject({ status: 'REJECTED', reason: 'PAY_BELOW_FEE_BUDGET' });
    expect(v.state.log[0].refs).toMatchObject({ pay_zat: '15000', fee_budget_zat: '15000' });
  });
});

describe('nothing between a payout and its entry can lose the decision (Zcash testnet)', () => {
  const statePath = (state: Partial<VerifierState>) => {
    const p = join(mkdtempSync(join(tmpdir(), 'pqi-v-')), 'state.json');
    writeFileSync(p, JSON.stringify({ log: [], nonces: {}, closed: {}, payouts: {}, sending: {}, ...state }));
    return p;
  };
  const solver = newSigningKey();
  const settleA = (v: Verifier) => v.settle(A.signed, d.txs.funding, signFill(solver, A.hash, d.txs.fills[A.hash], W.solver.address));

  it('the chain tip cannot be read right after A’s release is recorded: the SETTLED entry is still written, with that release, and A is closed only together with it', async () => {
    let paid = false;
    let failed = false;
    const v = new Verifier({ key: newSigningKey(), escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [keyId(solver.publicKey)], legacyUnboundFills: [A.hash], zingo: zingoConfig(), statePath: statePath({ payouts: { [`release:${A.hash}`]: NEVER_SENT } }), tip: async () => {
      if (paid && !failed) {
        failed = true;
        throw new Error('lightwalletd unreachable (induced by this test)');
      }
      return chainTip();
    } });
    // Notice the moment the release is looked up (and found recorded): every tip read after it fails once.
    const recorded = v.state.payouts;
    v.state.payouts = new Proxy(recorded, { get: (t, k) => ((paid ||= k === `release:${A.hash}`), Reflect.get(t, k)) });
    const first = await settleA(v).catch((e: Error) => e);
    const second = await settleA(v).catch((e: Error) => e);
    const settled = v.state.log.filter((e) => e.status === 'SETTLED' && e.intent_hash === A.hash);
    expect(settled, JSON.stringify({ first: (first as { status?: string }).status ?? String(first), second: (second as { status?: string }).status ?? String(second) })).toHaveLength(1);
    expect(settled[0].refs.release_txid).toBe(NEVER_SENT);
    expect(v.state.closed[A.hash]).toBe('SETTLED');
  });

  it('a state closed for A without its SETTLED entry (left by an older process) is finished on restart: SETTLED with the recorded release, not ALREADY_SETTLED', async () => {
    const v = new Verifier({ key: newSigningKey(), escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [keyId(solver.publicKey)], legacyUnboundFills: [A.hash], zingo: zingoConfig(), statePath: statePath({ closed: { [A.hash]: 'SETTLED' }, payouts: { [`release:${A.hash}`]: NEVER_SENT } }), tip: chainTip });
    expect(await settleA(v)).toMatchObject({ status: 'SETTLED', payoutTxid: NEVER_SENT });
    expect(v.state.log.map((e) => e.status)).toEqual(['SETTLED']);
    expect(await settleA(v)).toMatchObject({ status: 'REJECTED', reason: 'ALREADY_SETTLED' });
  });

  it('an anchor that went out but was never logged is logged before the next anchor, which names it: no fork', async () => {
    const key = newSigningKey();
    const log: LogEntry[] = [];
    appendEntry(log, key, { status: 'REJECTED', intent_hash: A.hash, reason: 'BAD_SIGNATURE', refs: {}, at_height: TIP });
    const T1 = 'a1'.repeat(32);
    const k1 = `anchor:0:${log[0].hash}`;
    // Entry 0 was anchored (T1 went out) but the process stopped before logging it; then the log grew.
    appendEntry(log, key, { status: 'REJECTED', intent_hash: A.hash, reason: 'WRONG_KEY', refs: {}, at_height: TIP });
    const v = new Verifier({ key, escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [], zingo: zingoConfig(), statePath: statePath({ log, payouts: { [k1]: T1 }, payout_memos: { [k1]: memo.anchor(0, log[0].hash, GENESIS) } }), tip: async () => TIP });
    // The next anchor cannot be paid here (no such wallet), but its write-ahead record shows what it names.
    await expect(v.anchor(W.anchor.address)).rejects.toThrow(/zingo-cli quicksend failed/);
    expect(v.state.log[2]).toMatchObject({ status: 'ANCHORED', refs: { anchor_txid: T1, anchored_seq: '0', anchored_head: log[0].hash, prev_anchor_txid: GENESIS } });
    const next = Object.values(v.state.sending ?? {})[0];
    expect(next.memo).toBe(memo.anchor(2, v.state.log[2].hash, T1));
  });
});

