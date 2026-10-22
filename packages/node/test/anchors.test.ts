// Anchor chain: the verifier's anchors name the previous anchor, and every anchor the escrow ever sent
// is read from its own history on Zcash testnet (a view-only wallet from the escrow's published full
// viewing key), so a log that hides an anchor, or is not the log that was anchored, is caught.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { appendEntry, checkAnchors, findEquivocation, fromB64, GENESIS, memo, newSigningKey, readAnchorMemo, type AnchorSeen, type FillClaim, type LogEntry, type SignedIntent } from '@pqi/protocol';
import { anchorHistory, openViewWallet, sentWithMemo, Verifier, zingoConfig } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const W = d.wallets as Record<string, { address: string; uivk: string; ufvk?: string; birthday?: number }>;
const log = d.log as LogEntry[];
const p2 = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet-pass2.json'), 'utf8'));
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
    // The escrow has anchored more since (pass 2 and 3), so the Oct 20 log is behind: that fails
    // unless an older record is checked on purpose.
    expect(checkAnchors(log, sent).problems).toContainEqual(expect.objectContaining({ kind: 'LOG_BEHIND_ANCHORS', anchors: expect.arrayContaining([{ txid: p2.txs.anchor, seq: 11 }]) }));
    const c = checkAnchors(log, sent, { allowBehind: true });
    expect(c.problems).toEqual([]);
    expect(c.chain[0]).toMatchObject({ txid: d.anchor.txid, seq: 8, prev: null });
    expect(c.unanchored).toBe(1);
  });

  it('a log that drops the ANCHORED entry → ANCHOR_NOT_IN_LOG; a log re-written before the anchor → ANCHOR_HEAD_MISMATCH', () => {
    expect(checkAnchors(log.slice(0, 9), sent, { allowBehind: true }).problems).toContainEqual({ kind: 'ANCHOR_NOT_IN_LOG', txid: d.anchor.txid, seq: 8 });
    // Same decisions, but A refunded instead of settled, re-signed by a key the desk made up.
    const forged: LogEntry[] = [];
    const key = newSigningKey();
    for (const e of log) appendEntry(forged, key, { status: e.seq === 0 ? 'REFUNDED' : e.status, intent_hash: e.intent_hash, reason: e.reason, refs: e.refs, at_height: e.at_height });
    expect(checkAnchors(forged, sent, { allowBehind: true }).problems).toContainEqual(expect.objectContaining({ kind: 'ANCHOR_HEAD_MISMATCH', txid: d.anchor.txid, seq: 8 }));
  });
});

describe('pass 2 in the escrow’s history (Zcash testnet)', () => {
  it('the pass-2 anchor names the Oct 20 anchor: one chain of two, the pass-2 log checks out, and the Oct 20 log sees it as later', () => {
    const c = checkAnchors(p2.log, sent, { allowBehind: true });
    expect(c.problems).toEqual([]);
    expect(c.chain.slice(0, 2).map((a) => [a.txid, a.prev])).toEqual([
      [d.anchor.txid, null],
      [p2.txs.anchor, d.anchor.txid],
    ]);
    expect(findEquivocation(log, p2.log, fromB64(d.keys.verifier.pk))).toBeNull();
    expect(checkAnchors(log, sent, { allowBehind: true }).later).toContainEqual({ txid: p2.txs.anchor, seq: 11 });
  });

  it('the release that was broadcast just before the process was killed went out of the escrow exactly once', async () => {
    const sends = await sentWithMemo(zingoConfig(), VIEW, memo.release(p2.intent.hash));
    expect(sends.map((t) => t.txid)).toEqual([p2.txs.release]);
  });
});

describe('pass 3 in the escrow’s history (Zcash testnet)', () => {
  it('three anchors, one chain (#8 → #11 → #13); the pass-3 log checks out against every anchor the escrow sent, and E’s release went out once', async () => {
    const p3 = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet-pass3.json'), 'utf8'));
    const c = checkAnchors(p3.log, sent);
    expect(c.problems).toEqual([]);
    expect(c.chain.slice(0, 3).map((a) => [a.txid, a.seq])).toEqual([
      [d.anchor.txid, 8],
      [p2.txs.anchor, 11],
      [p3.txs.anchor, 13],
    ]);
    expect(c.chain[2].prev).toBe(p2.txs.anchor);
    expect((await sentWithMemo(zingoConfig(), VIEW, memo.release(p3.intent.hash))).map((t) => t.txid)).toEqual([p3.txs.release]);
  });
});

describe('check-anchors on the published records (Zcash testnet, the escrow pinned)', () => {
  /** The CLI as a child process (async, so the test worker keeps answering while it syncs). */
  const run = (record: string, ...flags: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      execFile(
        resolve(__dirname, '../node_modules/.bin/tsx'),
        [resolve(__dirname, '../src/check-anchors.ts'), resolve(__dirname, '../../../deployments', record), ...flags],
        { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PQI_VERIFIER_ID: d.keys.verifier.id, PQI_ESCROW_UA: W.escrow.address, PQI_HISTORY_WALLET: VIEW, ...(process.env.PQI_ZINGO_CLI ? { PQI_ZINGO_CLI: process.env.PQI_ZINGO_CLI } : {}) }, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => done({ status: err ? ((err as { code?: number }).code ?? null) : 0, stdout, stderr }),
      );
    });

  it('the newest record (pass 3) exits 0; the Oct 20 record is behind the escrow’s anchors and exits 1 with LOG_BEHIND_ANCHORS, or 0 with --allow-behind', async () => {
    const p3 = await run('testnet-pass3.json');
    expect(p3.status, p3.stderr).toBe(0);
    expect(JSON.parse(p3.stdout)).toMatchObject({ ok: true, later: [], problems: [] });
    const oct20 = await run('testnet.json');
    expect(oct20.status, oct20.stderr).toBe(1);
    expect(JSON.parse(oct20.stdout).problems).toEqual([expect.objectContaining({ kind: 'LOG_BEHIND_ANCHORS' })]);
    const older = await run('testnet.json', '--allow-behind');
    expect(older.status, older.stderr).toBe(0);
    expect(JSON.parse(older.stdout)).toMatchObject({ ok: true, allow_behind: true, later: expect.arrayContaining([{ txid: p2.txs.anchor, seq: 11 }]) });
  }, 900_000);
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
