// Anchor chain: the verifier's anchors name the previous anchor, and every anchor the escrow ever sent
// is read from its own history on Zcash testnet (a view-only wallet from the escrow's published full
// viewing key), so a log that hides an anchor, or is not the log that was anchored, is caught.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { appendEntry, checkAnchors, GENESIS, newSigningKey, readAnchorMemo, type AnchorSeen, type FillClaim, type LogEntry, type SignedIntent } from '@pqi/protocol';
import { anchorHistory, openViewWallet, Verifier, zingoConfig } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const W = d.wallets as Record<string, { address: string; uivk: string; ufvk?: string; birthday?: number }>;
const log = d.log as LogEntry[];
const VIEW = join(mkdtempSync(join(tmpdir(), 'pqi-escrow-view-')), 'wallet');
let sent: AnchorSeen[] = [];

beforeAll(async () => {
  await openViewWallet(zingoConfig(), VIEW, W.escrow.ufvk!, W.escrow.birthday!);
  sent = await anchorHistory(zingoConfig(), VIEW);
}, 600_000);

describe('anchors in the escrow’s on-chain history (Zcash testnet)', () => {
  it('the escrow’s history holds the Oct 20 anchor, and the published log checks out against every anchor it sent', () => {
    const oct20 = sent.find((a) => a.txid === d.anchor.txid);
    expect(readAnchorMemo(oct20?.memo)).toEqual({ seq: 8, head: log[8].hash, prev: null });
    const c = checkAnchors(log, sent);
    expect(c.problems).toEqual([]);
    expect(c.chain[0]).toMatchObject({ txid: d.anchor.txid, seq: 8, prev: null });
    expect(c.unanchored).toBe(1);
  });

  it('a log that drops the ANCHORED entry → ANCHOR_NOT_IN_LOG; a log re-written before the anchor → ANCHOR_HEAD_MISMATCH', () => {
    expect(checkAnchors(log.slice(0, 9), sent).problems).toContainEqual({ kind: 'ANCHOR_NOT_IN_LOG', txid: d.anchor.txid, seq: 8 });
    // Same decisions, but A refunded instead of settled, re-signed by a key the desk made up.
    const forged: LogEntry[] = [];
    const key = newSigningKey();
    for (const e of log) appendEntry(forged, key, { status: e.seq === 0 ? 'REFUNDED' : e.status, intent_hash: e.intent_hash, reason: e.reason, refs: e.refs, at_height: e.at_height });
    expect(checkAnchors(forged, sent).problems).toContainEqual(expect.objectContaining({ kind: 'ANCHOR_HEAD_MISMATCH', txid: d.anchor.txid, seq: 8 }));
  });
});

describe('the verifier chains its anchors', () => {
  it('each ANCHORED entry and memo names the previous anchor’s txid (genesis for the first)', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'pqi-anchor-')), 'state.json');
    writeFileSync(statePath, JSON.stringify({ log: [], nonces: {}, closed: {}, payouts: {}, sending: {} }));
    const v = new Verifier({ key: newSigningKey(), escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [], zingo: zingoConfig(), statePath, tip: async () => 4_600_000 });
    const A = d.intents.A.signed as SignedIntent;
    const tampered = { ...A, intent: { ...A.intent, min_out_zat: '1' } };
    const T1 = 'a1'.repeat(32);
    const T2 = 'a2'.repeat(32);
    // A changed intent is refused (BAD_SIGNATURE) before its fill claim is read, so none is needed.
    // Each anchor payout is recorded up front, so nothing is sent (payOnce never pays a key twice).
    const noClaim = {} as FillClaim;
    await v.settle(tampered, d.txs.funding, noClaim);
    v.state.payouts[`anchor:0:${v.state.log[0].hash}`] = T1;
    const first = await v.anchor(W.anchor.address);
    expect(first).toMatchObject({ txid: T1, seq: 0, prev: GENESIS });
    expect(first.entry.refs).toMatchObject({ anchor_txid: T1, anchored_seq: '0', prev_anchor_txid: GENESIS });
    await v.settle(tampered, d.txs.funding, noClaim);
    v.state.payouts[`anchor:2:${v.state.log[2].hash}`] = T2;
    const second = await v.anchor(W.anchor.address);
    expect(second.entry.refs).toMatchObject({ anchor_txid: T2, anchored_seq: '2', prev_anchor_txid: T1 });
  });
});
