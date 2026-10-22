// A verifier process killed (SIGKILL) between saving a payout's write-ahead record and saving its
// txid, then restarted: it reads the escrow's history on-chain before any new attempt. The history is
// read through a view-only zingo wallet made from the escrow's published full viewing key, which
// cannot spend, so no test here can pay.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, keyId, memo, newKemKey, newSigningKey, randomBytes, signFill, signIntent, signingKeyFromSeed, hexToBytes, type LogEntry, type SignedIntent } from '@pqi/protocol';
import { chainTip, openViewWallet, Solver, spendable, TX_EXPIRY_BLOCKS, Verifier, zingoConfig, type VerifierState } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const I = d.intents as Record<'A' | 'B' | 'C', { hash: string; signed: SignedIntent }>;
const W = d.wallets as Record<string, { address: string; uivk: string; ufvk?: string; birthday?: number }>;
const log = d.log as LogEntry[];
const VIEW = join(mkdtempSync(join(tmpdir(), 'pqi-escrow-view-')), 'wallet');

const readState = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as VerifierState;
const verifier = (statePath: string, solverPk: Uint8Array, extra: Partial<ConstructorParameters<typeof Verifier>[0]> = {}) =>
  new Verifier({ key: newSigningKey(), escrowWallet: VIEW, escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [keyId(solverPk)], legacyUnboundFills: [I.A.hash, I.B.hash, I.C.hash], zingo: zingoConfig(), statePath, tip: chainTip, ...extra });

beforeAll(async () => {
  await openViewWallet(zingoConfig(), VIEW, W.escrow.ufvk!, W.escrow.birthday!);
}, 600_000);

describe('write-ahead payouts, with a real process kill', () => {
  it('killed after the write-ahead record and before the broadcast; the restart finds the release on-chain by its memo and records it instead of paying again', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'pqi-crash-')), 'state.json');
    const seed = bytesToHex(randomBytes(32));
    // node itself runs the child (tsx only as a loader), so the kill reaches the verifier's own process.
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(__dirname, 'fixtures/crash-child.ts'), statePath, seed, '/nonexistent/escrow-wallet-never-used'], { cwd: resolve(__dirname, '..'), env: { ...process.env, PQI_TEST_CRASH_AT: 'payout-before-broadcast' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (b) => (out += b));
    child.stderr!.on('data', (b) => (out += b));
    const [code, signal] = await new Promise<[number | null, string | null]>((ok) => child.on('exit', (c, s) => ok([c, s])));
    expect({ code, signal }, out).toEqual({ code: null, signal: 'SIGKILL' });

    // What the killed process left: the write-ahead record, no txid, no log entry.
    const left = readState(statePath);
    expect(left.sending?.[`release:${I.A.hash}`]).toMatchObject({ to: W.solver.address, amount_zat: '45000', memo: memo.release(I.A.hash) });
    expect(left.payouts[`release:${I.A.hash}`]).toBeUndefined();
    expect(left.log).toHaveLength(0);

    // The release that record guards is on-chain: A's Oct 20 release, memo pqi1:<A>:release. The
    // restarted verifier reads the escrow's history, finds it, and settles with that txid.
    const solver = signingKeyFromSeed(hexToBytes(seed));
    const v = verifier(statePath, solver.publicKey);
    const r = await v.settle(I.A.signed, d.txs.funding, signFill(solver, I.A.hash, d.txs.fills[I.A.hash], W.solver.address));
    const oct20Release = log.find((e) => e.status === 'SETTLED' && e.intent_hash === I.A.hash)!.refs.release_txid;
    expect(r).toMatchObject({ status: 'SETTLED', payoutTxid: oct20Release });
    expect(v.state.sending).toEqual({});
    expect(v.state.payouts[`release:${I.A.hash}`]).toBe(oct20Release);
  });

  it('a record whose payout is not in the escrow’s history: no new attempt until a transaction built then has expired; after that, a fresh record and a new attempt', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'pqi-crash-')), 'state.json');
    const solver = newSigningKey();
    const tip = await chainTip();
    const key = `refund:${I.B.hash}`;
    const record = (at_height: number) => writeFileSync(statePath, JSON.stringify({ log: [], nonces: {}, closed: {}, payouts: {}, sending: { [key]: { to: W.user.address, amount_zat: '45000', memo: memo.refund(I.B.hash), at_height, at: new Date().toISOString() } } }));

    // B was never refunded, so no pqi1:<B>:refund is in the escrow's history.
    record(tip);
    const wait = await verifier(statePath, solver.publicKey).refund(I.B.signed, d.txs.funding);
    expect(wait.status).toBe('PENDING');
    expect(wait.reason).toMatch(new RegExp(`^PAYOUT_UNRECONCILED: ${key} is not in the escrow's history; a transaction sent before the stop could be mined until height ${tip + 1 + TX_EXPIRY_BLOCKS}`));
    expect(readState(statePath).log).toHaveLength(0);

    // Recorded long enough ago that anything built then has expired: the verifier writes a new record
    // and tries again (the view-only wallet cannot spend, so that attempt fails here).
    record(tip - TX_EXPIRY_BLOCKS - 5);
    await expect(verifier(statePath, solver.publicKey, { balanceRetries: 0 }).refund(I.B.signed, d.txs.funding)).rejects.toThrow(/zingo-cli quicksend failed/);
    const after = readState(statePath);
    expect(after.sending?.[key].at_height).toBeGreaterThanOrEqual(tip);
    expect(after.payouts[key]).toBeUndefined();
    expect(after.log).toHaveLength(0);
  });
});

describe('the solver takes on only what its wallet can pay', () => {
  it('declines min_out above its spendable balance (read with zingo-cli; here the view-only wallet stands in for the solver’s)', async () => {
    const have = await spendable(zingoConfig(), VIEW);
    const solver = new Solver({ sign: newSigningKey(), kem: newKemKey(), wallet: VIEW, ua: W.solver.address, escrowUivk: W.escrow.uivk, zingo: zingoConfig(), minFeeZat: 15_000n });
    const ask = (min_out: bigint) => signIntent(newSigningKey(), { escrow: W.escrow.address, pay_zat: String(min_out + 20_000n), min_out_zat: String(min_out), receive_ua: W.receive.address, receive_uivk: W.receive.uivk, refund_ua: W.user.address, deadline_height: 5_000_000 });
    expect(await solver.capacity(ask(have + 1n))).toEqual({ ok: false, reason: `min_out ${have + 1n} zat is above the solver's spendable balance ${have} zat` });
    if (have > 0n) expect(await solver.capacity(ask(have))).toEqual({ ok: true });
  });
});

