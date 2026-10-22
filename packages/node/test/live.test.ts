// Live, read-only: every published transaction re-checked through its viewing key on Zcash testnet,
// and the verifier's refusals re-derived on a fresh verifier (refusals never pay, so no wallet is used).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEntry, bytesToHex, findEquivocation, fromB64, intentHash, keyId, memo, newSigningKey, randomBytes, signFill, verifyLog, type FillClaim, type LogEntry, type SignedIntent } from '@pqi/protocol';
import { chainTip, owns, scan, Verifier, zingoConfig } from '../src/index.js';

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

/** The Oct 20 intents, whose fill memos name no solver (accepted as legacy single-solver). */
const LEGACY = [I.A.hash, I.B.hash, I.C.hash];

/** A verifier with a new key and (optionally) prior state, on the published escrow. No wallet is used.
 *  An intent marked closed gets its SETTLED/REFUNDED entry too (signed by the new key), as a real
 *  verifier writes them together. */
function freshVerifier(prior?: { nonces?: Record<string, Record<string, string>>; closed?: Record<string, 'SETTLED' | 'REFUNDED'> }, opts: { tip?: () => Promise<number>; solvers?: string[]; legacy?: string[]; minConfirmations?: number } = {}) {
  const key = newSigningKey();
  const statePath = join(mkdtempSync(join(tmpdir(), 'pqi-')), 'state.json');
  const priorLog: LogEntry[] = [];
  for (const [h, st] of Object.entries(prior?.closed ?? {})) appendEntry(priorLog, key, { status: st, intent_hash: h, reason: null, refs: { [st === 'SETTLED' ? 'release_txid' : 'refund_txid']: NEVER_SENT }, at_height: 4_522_000 });
  writeFileSync(statePath, JSON.stringify({ log: priorLog, nonces: prior?.nonces ?? {}, closed: prior?.closed ?? {}, payouts: allPayouts }));
  const v = new Verifier({ key, escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: opts.solvers ?? [keyId(solver.publicKey)], legacyUnboundFills: opts.legacy ?? LEGACY, minConfirmations: opts.minConfirmations, zingo: zingoConfig(), statePath, tip: opts.tip ?? chainTip });
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
    for (const k of ['A', 'B'] as const) expect((await scan(W.receive.uivk, d.txs.fills[I[k].hash], 40_000, memo.legacyFill(I[k].hash))).ok).toBe(true);
    const wrong = await scan(W.receive.uivk, d.txs.wrongMemoFill, 40_000, memo.legacyFill(I.C.hash));
    expect(wrong.reasons).toContain('MEMO_MISMATCH');
    const late = await scan(W.receive.uivk, d.txs.lateFill, 40_000, memo.legacyFill(I.C.hash));
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

describe('fill binding: only the solver the fill memo names is paid', () => {
  it('with two solver keys configured, A’s Oct 20 fill (its memo names no solver) is paid to neither → FILL_NOT_SOLVER_BOUND', async () => {
    const second = newSigningKey();
    const { v } = freshVerifier(undefined, { solvers: [keyId(solver.publicKey), keyId(second.publicKey)] });
    const fillA = d.txs.fills[I.A.hash];
    expect(await v.settle(I.A.signed, d.txs.funding, claim(I.A.hash, fillA))).toMatchObject({ status: 'REJECTED', reason: 'FILL_NOT_SOLVER_BOUND' });
    expect(await v.settle(I.A.signed, d.txs.funding, signFill(second, I.A.hash, fillA, W.user.address))).toMatchObject({ status: 'REJECTED', reason: 'FILL_NOT_SOLVER_BOUND' });
    expect(v.state.closed[I.A.hash]).toBeUndefined();
  });

  it('an unbound fill is legacy only for the listed Oct 20 intents: unlisted → FILL_NOT_SOLVER_BOUND; listed → SETTLED, marked legacy-single-solver', async () => {
    const unlisted = freshVerifier(undefined, { legacy: [] }).v;
    expect(await unlisted.settle(I.B.signed, d.txs.funding, claim(I.B.hash, d.txs.fills[I.B.hash]))).toMatchObject({ status: 'REJECTED', reason: 'FILL_NOT_SOLVER_BOUND' });
    const listed = freshVerifier().v;
    const r = await listed.settle(I.B.signed, d.txs.funding, claim(I.B.hash, d.txs.fills[I.B.hash]));
    expect(r).toMatchObject({ status: 'SETTLED', payoutTxid: NEVER_SENT });
    expect(listed.state.log[0].refs).toMatchObject({ fill_binding: 'legacy-single-solver', solver: keyId(solver.publicKey) });
  });
});

describe('confirmations: funding and fill are acted on only at N (default 3)', () => {
  it('A with the observed height held: funding at 2 confirmations → PENDING; fill at 2 → PENDING; fill at 3 → SETTLED; nothing logged before', async () => {
    const fundH = (await scan(W.escrow.uivk, d.txs.funding, 60_000, memo.funding(I.A.hash))).height!;
    const fillH = (await scan(W.receive.uivk, d.txs.fills[I.A.hash], 40_000, memo.legacyFill(I.A.hash))).height!;
    expect(fillH).toBeGreaterThan(fundH + 2);
    let held = fundH + 1;
    const { v } = freshVerifier(undefined, { tip: async () => held });
    const settleA = () => v.settle(I.A.signed, d.txs.funding, claim(I.A.hash, d.txs.fills[I.A.hash]));
    expect(await settleA()).toEqual({ status: 'PENDING', reason: 'funding has 2 of 3 confirmations' });
    held = fillH + 1;
    expect(await settleA()).toEqual({ status: 'PENDING', reason: 'fill has 2 of 3 confirmations' });
    expect(v.state.log).toHaveLength(0);
    held = fillH + 2;
    expect(await settleA()).toMatchObject({ status: 'SETTLED', payoutTxid: NEVER_SENT });
  });

  it('N is configurable: with 6, the same fill at 5 confirmations is still PENDING', async () => {
    const fillH = (await scan(W.receive.uivk, d.txs.fills[I.B.hash], 40_000, memo.legacyFill(I.B.hash))).height!;
    const { v } = freshVerifier(undefined, { tip: async () => fillH + 4, minConfirmations: 6 });
    expect(await v.settle(I.B.signed, d.txs.funding, claim(I.B.hash, d.txs.fills[I.B.hash]))).toEqual({ status: 'PENDING', reason: 'fill has 5 of 6 confirmations' });
  });
});

describe('a fill lightwalletd does not return is not refused while it could still count', () => {
  it('A with a claim on a txid that is not on chain: PENDING (FILL_NOT_FOUND_YET) up to the end of the claim window, nothing logged; after it → REJECTED FILL_NOT_CREDITED:TX_NOT_FOUND', async () => {
    const fundH = (await scan(W.escrow.uivk, d.txs.funding, 60_000, memo.funding(I.A.hash))).height!;
    const deadline = I.A.signed.intent.deadline_height;
    const missing = bytesToHex(randomBytes(32));
    let held = fundH + 5;
    const { v } = freshVerifier(undefined, { tip: async () => held });
    const settleA = () => v.settle(I.A.signed, d.txs.funding, claim(I.A.hash, missing));
    expect(await settleA()).toMatchObject({ status: 'PENDING', reason: expect.stringMatching(/^FILL_NOT_FOUND_YET: lightwalletd does not return fill [0-9a-f]{64}; it is asked again until the claim window closes at height \d+/) });
    held = deadline + v.claimWindow;
    expect((await settleA()).status).toBe('PENDING');
    expect(v.state.log).toHaveLength(0);
    held = deadline + v.claimWindow + 1;
    expect(await settleA()).toMatchObject({ status: 'REJECTED', reason: 'FILL_NOT_CREDITED:TX_NOT_FOUND' });
    expect(v.state.closed[I.A.hash]).toBeUndefined();
  });
});

describe('one decision at a time, and a claim window before refunds', () => {
  it('a settle and a refund of A at the same time: one SETTLED, the other ALREADY_SETTLED (never both paid)', async () => {
    const { v } = freshVerifier();
    const [a, b] = await Promise.all([v.settle(I.A.signed, d.txs.funding, claim(I.A.hash, d.txs.fills[I.A.hash])), v.refund(I.A.signed, d.txs.funding)]);
    expect(a.status).toBe('SETTLED');
    expect(b).toMatchObject({ status: 'REJECTED', reason: 'ALREADY_SETTLED' });
    expect(v.state.log.map((e) => e.status)).toEqual(['SETTLED', 'REJECTED']);
  });

  it('two settles of B at the same time: one SETTLED, one ALREADY_SETTLED', async () => {
    const { v } = freshVerifier();
    const c = claim(I.B.hash, d.txs.fills[I.B.hash]);
    const r = await Promise.all([v.settle(I.B.signed, d.txs.funding, c), v.settle(I.B.signed, d.txs.funding, c)]);
    expect(r.map((x) => ('reason' in x && x.reason) || x.status)).toEqual(['SETTLED', 'ALREADY_SETTLED']);
  });

  it('C one block after its deadline → CLAIM_WINDOW_OPEN; after the window (the real tip) → REFUNDED', async () => {
    const deadline = I.C.signed.intent.deadline_height;
    // The clock is held at deadline + 1; the funding is still read from testnet.
    const early = freshVerifier(undefined, { tip: async () => deadline + 1 }).v;
    expect(await early.refund(I.C.signed, d.txs.funding)).toMatchObject({ status: 'REJECTED', reason: 'CLAIM_WINDOW_OPEN' });
    const late = freshVerifier().v;
    expect(await late.refund(I.C.signed, d.txs.funding)).toMatchObject({ status: 'REFUNDED', payoutTxid: NEVER_SENT });
  });
});

describe('pass 2 on testnet (Oct 21): a fill that names its solver, 3 confirmations, a crash mid-release', () => {
  const p2 = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet-pass2.json'), 'utf8'));
  const D = p2.intent as { hash: string; signed: SignedIntent; claim: FillClaim };
  const pk = fromB64(d.keys.verifier.pk);

  it('the pass-2 log verifies with the same verifier key and extends the Oct 20 log: FILL_BY_OTHER_SOLVER, SETTLED, ANCHORED', () => {
    const l = p2.log as LogEntry[];
    expect(verifyLog(l, pk)).toMatchObject({ ok: true, entries: log.length + 3 });
    expect(findEquivocation(log, l, pk)).toBeNull();
    expect(l.slice(log.length).map((e) => e.reason ?? e.status)).toEqual(['FILL_BY_OTHER_SOLVER', 'SETTLED', 'ANCHORED']);
    expect(l[log.length + 1].refs).toMatchObject({ fill_binding: 'solver-memo', solver: d.keys.solver.id, release_txid: p2.txs.release });
  });

  it('D’s fill names the solver’s key in its memo; a fresh verifier with two solver keys refuses the other one (FILL_BY_OTHER_SOLVER) and pays the named one', async () => {
    expect((await scan(W.receive.uivk, p2.txs.fill, 40_000, memo.fill(D.hash, d.keys.solver.id))).ok).toBe(true);
    const other = newSigningKey();
    const statePath = join(mkdtempSync(join(tmpdir(), 'pqi-')), 'state.json');
    writeFileSync(statePath, JSON.stringify({ log: [], nonces: {}, closed: {}, payouts: { [`release:${D.hash}`]: NEVER_SENT } }));
    const v = new Verifier({ key: newSigningKey(), escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [d.keys.solver.id, keyId(other.publicKey)], zingo: zingoConfig(), statePath, tip: chainTip });
    expect(await v.settle(D.signed, p2.txs.funding, signFill(other, D.hash, p2.txs.fill, W.user.address))).toMatchObject({ status: 'REJECTED', reason: 'FILL_BY_OTHER_SOLVER' });
    expect(await v.settle(D.signed, p2.txs.funding, D.claim)).toMatchObject({ status: 'SETTLED', payoutTxid: NEVER_SENT });
  });

  it('the release broadcast before the kill is on-chain once, with the memo of the write-ahead record, and is the txid the log settled with', async () => {
    expect(p2.crash).toMatchObject({ point: 'payout-after-broadcast', signal: 'SIGKILL', write_ahead: { memo: memo.release(D.hash), amount_zat: '45000', to: W.solver.address }, reconciled_txid: p2.txs.release, escrow_sends_with_release_memo: [p2.txs.release] });
    expect((await scan(W.solver.uivk, p2.txs.release, 45_000, memo.release(D.hash))).ok).toBe(true);
    // The release was written ahead only once the fill was 3 blocks deep; the run saw the funding at 1 of 3.
    const fill = await scan(W.receive.uivk, p2.txs.fill, 40_000, memo.fill(D.hash, d.keys.solver.id));
    expect(p2.crash.write_ahead.at_height - fill.height! + 1).toBeGreaterThanOrEqual(3);
    expect(p2.observedPending).toContain('waiting for funding: NOT_CONFIRMED (1 of 3)');
  });
});

describe('pass 3 on testnet (Oct 22): the agent path through MCP', () => {
  const p2 = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet-pass2.json'), 'utf8'));
  const p3 = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet-pass3.json'), 'utf8'));
  const E = p3.intent as { hash: string; signed: SignedIntent; claim: FillClaim };
  const pk = fromB64(d.keys.verifier.pk);

  it('the pass-3 log verifies with the same verifier key and extends pass 2: E SETTLED, ANCHORED; E was signed by the agent’s own key and delivered to an address none of A–D used, which the receive key derives', async () => {
    const l = p3.log as LogEntry[];
    expect(verifyLog(l, pk)).toMatchObject({ ok: true, entries: p2.log.length + 2 });
    expect(findEquivocation(p2.log, l, pk)).toBeNull();
    expect(l.slice(p2.log.length).map((e) => e.status)).toEqual(['SETTLED', 'ANCHORED']);
    expect(l[p2.log.length].refs).toMatchObject({ funding_txid: p3.txs.funding, fill_txid: p3.txs.fill, release_txid: p3.txs.release, solver: d.keys.solver.id, fill_binding: 'solver-memo', user: p3.keys.agent.id });
    expect(E.signed.intent.user).toBe(p3.keys.agent.id);
    expect(p3.agent.submit_intent).toMatchObject({ intent_hash: E.hash, funding_txid: p3.txs.funding, receive_ua: E.signed.intent.receive_ua });
    const before = [...Object.values(I).map((x) => x.signed.intent.receive_ua), p2.intent.signed.intent.receive_ua];
    expect(before).not.toContain(E.signed.intent.receive_ua);
    expect((await owns(W.receive.uivk, E.signed.intent.receive_ua)).covered).toEqual(['orchard']);
  });

  it('E’s funding, its fill to the new address naming the solver, and its release are on-chain as their keys see them; the fill the restarted desk found is the one the solver sent once', async () => {
    expect((await scan(W.escrow.uivk, p3.txs.funding, Number(E.signed.intent.pay_zat), memo.funding(E.hash))).ok).toBe(true);
    const fill = await scan(W.receive.uivk, p3.txs.fill, Number(E.signed.intent.min_out_zat), memo.fill(E.hash, d.keys.solver.id));
    expect(fill.ok).toBe(true);
    expect(fill.height!).toBeLessThanOrEqual(E.signed.intent.deadline_height);
    expect((await scan(W.solver.uivk, p3.txs.release, Number(E.signed.intent.pay_zat) - 15_000, memo.release(E.hash))).ok).toBe(true);
    expect(p3.crash).toMatchObject({ point: 'deliver-after-broadcast', signal: 'SIGKILL', board_after_kill: { stage: 'funded', fillTxid: null, delivering: { memo: memo.fill(E.hash, d.keys.solver.id), pay_to: E.signed.intent.receive_ua } }, solver_sends_with_fill_memo: [p3.txs.fill] });
    expect(p3.crash.restart[0]).toContain(`filled ${p3.txs.fill} (found in the solver's history by its memo after a restart; not sent again)`);
  });
});

