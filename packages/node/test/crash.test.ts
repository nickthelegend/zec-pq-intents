// A verifier process killed (SIGKILL) between saving a payout's write-ahead record and saving its
// txid, then restarted: it reads the escrow's history on-chain before any new attempt. The history is
// read through a view-only zingo wallet made from the escrow's published full viewing key, which
// cannot spend, so no test here can pay.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, kemKeyFromSeed, keyId, memo, newKemKey, newSigningKey, randomBytes, seal, signFill, signIntent, signingKeyFromSeed, hexToBytes, type LogEntry, type SignedIntent } from '@pqi/protocol';
import { chainTip, Desk, openViewWallet, Solver, spendable, TX_EXPIRY_BLOCKS, Verifier, zingoConfig, type BoardItem, type VerifierState } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const I = d.intents as Record<'A' | 'B' | 'C', { hash: string; signed: SignedIntent }>;
const W = d.wallets as Record<string, { address: string; uivk: string; ufvk?: string; birthday?: number }>;
const log = d.log as LogEntry[];
const p2 = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet-pass2.json'), 'utf8'));
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
    // and tries again. The view-only wallet cannot fund it ("Insufficient balance", which zingo-cli
    // reports while proposing, before anything is built), so the new record is dropped again and the
    // refund waits for balance: nothing sent, nothing logged.
    record(tip - TX_EXPIRY_BLOCKS - 5);
    const again = await verifier(statePath, solver.publicKey, { balanceRetries: 0 }).refund(I.B.signed, d.txs.funding);
    expect(again).toMatchObject({ status: 'PENDING', reason: expect.stringMatching(new RegExp(`^PAYOUT_WAITING_FOR_BALANCE: ${key} \\(zingo-cli quicksend failed: .*Insufficient balance`)) });
    const after = readState(statePath);
    expect(after.sending?.[key]).toBeUndefined();
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

describe('the solver’s delivery is write-ahead, with a real process kill', () => {
  /** A desk whose solver cannot spend (no such wallet) and reads `history` to reconcile. */
  const deskAt = (dir: string, signSeed: string, kemSeed: string, history: string) => {
    const sign = signingKeyFromSeed(hexToBytes(signSeed));
    const solver = new Solver({ sign, kem: kemKeyFromSeed(hexToBytes(kemSeed)), wallet: '/nonexistent/solver-wallet-never-used', historyWallet: history, ua: W.solver.address, escrowUivk: W.escrow.uivk, zingo: zingoConfig(), minFeeZat: 15_000n });
    const verifier = new Verifier({ key: newSigningKey(), escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [keyId(sign.publicKey)], zingo: zingoConfig(), statePath: join(dir, 'state.json'), tip: chainTip });
    return new Desk({ boardPath: join(dir, 'board.json'), solver, verifier, tip: chainTip, info: {} });
  };
  /** A 'funded' intent due 100 blocks after `tip`, sealed to the KEM key from `kemSeed`. */
  const funded = (tip: number, kemSeed: string): BoardItem => {
    const s = signIntent(newSigningKey(), { escrow: W.escrow.address, pay_zat: '60000', min_out_zat: '40000', receive_ua: W.receive.address, receive_uivk: W.receive.uivk, refund_ua: W.user.address, deadline_height: tip + 100 });
    const envelope = seal(s, kemKeyFromSeed(hexToBytes(kemSeed)).publicKey);
    return { hash: envelope.intent_hash, envelope, fundingTxid: bytesToHex(randomBytes(32)), stage: 'funded', note: null, fillTxid: null, claim: null, postedAt: new Date().toISOString() };
  };
  const readBoard = (dir: string) => JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8')) as BoardItem[];

  it('killed after the delivery’s write-ahead record, before the broadcast: the restart does not find it in the solver’s history and sends nothing until a transaction built then has expired; after that, a new record and a new attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pqi-deliver-'));
    const [signSeed, kemSeed] = [bytesToHex(randomBytes(32)), bytesToHex(randomBytes(64))];
    const tip = await chainTip();
    const it0 = funded(tip, kemSeed);
    writeFileSync(join(dir, 'board.json'), JSON.stringify([it0]));
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(__dirname, 'fixtures/deliver-crash-child.ts'), join(dir, 'board.json'), join(dir, 'state.json'), signSeed, kemSeed], { cwd: resolve(__dirname, '..'), env: { ...process.env, PQI_TEST_CRASH_AT: 'deliver-before-broadcast' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (b) => (out += b));
    child.stderr!.on('data', (b) => (out += b));
    const [code, signal] = await new Promise<[number | null, string | null]>((ok) => child.on('exit', (c, s) => ok([c, s])));
    expect({ code, signal }, out).toEqual({ code: null, signal: 'SIGKILL' });

    // What the killed process left: the record (flushed before the send), no fill.
    const [left] = readBoard(dir);
    const solverId = keyId(signingKeyFromSeed(hexToBytes(signSeed)).publicKey);
    expect(left).toMatchObject({ stage: 'funded', fillTxid: null, delivering: { memo: memo.fill(it0.hash, solverId), pay_to: W.receive.address, amount_zat: '40000' } });
    expect(left.delivering!.at_height).toBeGreaterThanOrEqual(tip);

    // Restart. The solver's history (here the escrow's view-only wallet stands in for it) has no such
    // memo, and a transaction built at that height could still be mined: nothing is sent.
    const [r] = await deskAt(dir, signSeed, kemSeed, VIEW).tick();
    expect(r.result).toMatch(new RegExp(`^DELIVERY_UNRECONCILED: a delivery was being sent at height ${left.delivering!.at_height} .* could be mined until height ${left.delivering!.at_height + 1 + TX_EXPIRY_BLOCKS} .*so it is not sent again, and the escrow not refunded, before then$`));
    expect(readBoard(dir)[0]).toMatchObject({ stage: 'funded', fillTxid: null, delivering: left.delivering });

    // Recorded long enough ago that it can no longer be mined: the record is dropped, the quote is
    // run again and a new record is written before a new attempt (which fails here: no wallet).
    writeFileSync(join(dir, 'board.json'), JSON.stringify([{ ...left, delivering: { ...left.delivering!, at_height: tip - TX_EXPIRY_BLOCKS - 5 } }]));
    const [again] = await deskAt(dir, signSeed, kemSeed, VIEW).tick();
    expect(again.result).toMatch(/^error: zingo-cli quicksend failed/);
    const after = readBoard(dir)[0];
    expect(after).toMatchObject({ stage: 'funded', fillTxid: null, failures: 1 });
    expect(after.delivering!.at_height).toBeGreaterThanOrEqual(tip);
  });

  it('past the deadline and the claim window, an intent whose delivery may have gone out is not refunded while that delivery could still be mined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pqi-deliver-'));
    const [signSeed, kemSeed] = [bytesToHex(randomBytes(32)), bytesToHex(randomBytes(64))];
    const tip = await chainTip();
    const it0 = funded(tip - 200, kemSeed); // due 100 blocks ago
    writeFileSync(join(dir, 'board.json'), JSON.stringify([{ ...it0, delivering: { memo: memo.fill(it0.hash, 'ee'.repeat(32)), pay_to: W.receive.address, amount_zat: '40000', at_height: tip - 105, at: new Date().toISOString() } }]));
    const desk = deskAt(dir, signSeed, kemSeed, VIEW);
    const [r] = await desk.tick();
    expect(r.result).toMatch(/^DELIVERY_UNRECONCILED: .*and the escrow not refunded, before then$/);
    expect(desk.items).toHaveLength(1);
    expect(desk.items[0]).toMatchObject({ stage: 'funded', fillTxid: null });
  });

  it('a delivery record whose memo the wallet’s history shows is adopted with that txid, and nothing is sent', async () => {
    // Stand-in for the solver's history: the escrow's view-only wallet, which sent pass 2's release of
    // D (memo pqi1:<D>:release) exactly once. The record names that memo; the lookup is by memo.
    const dir = mkdtempSync(join(tmpdir(), 'pqi-deliver-'));
    const [signSeed, kemSeed] = [bytesToHex(randomBytes(32)), bytesToHex(randomBytes(64))];
    const tip = await chainTip();
    const it0 = funded(tip, kemSeed);
    writeFileSync(join(dir, 'board.json'), JSON.stringify([{ ...it0, delivering: { memo: memo.release(p2.intent.hash), pay_to: W.receive.address, amount_zat: '40000', at_height: tip - 10, at: new Date().toISOString() } }]));
    const desk = deskAt(dir, signSeed, kemSeed, VIEW);
    const [r] = await desk.tick();
    expect(r.result).toBe(`filled ${p2.txs.release} (found in the solver's history by its memo after a restart; not sent again)`);
    expect(desk.items[0]).toMatchObject({ stage: 'filled', fillTxid: p2.txs.release, claim: { fill_txid: p2.txs.release } });
    expect(desk.items[0].delivering).toBeUndefined();
  });
});

