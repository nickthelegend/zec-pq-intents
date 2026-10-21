// The desk: what it accepts on its board, one tick at a time, refunds after the claim window, and its
// HTTP surface. Chain-touching cases read the published run on Zcash testnet; payouts are recorded up
// front so nothing is ever sent, and the solver's wallet path does not exist (no delivery happens).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keyId, newKemKey, newSigningKey, seal, signFill, type SignedIntent } from '@pqi/protocol';
import { chainTip, Desk, MAX_BODY_BYTES, serveDesk, Solver, Verifier, zingoConfig, type BoardItem } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const I = d.intents as Record<'A' | 'B' | 'C', { hash: string; signed: SignedIntent }>;
const W = d.wallets as Record<string, { address: string; uivk: string }>;
const NEVER_SENT = 'test-marker-no-payment-sent';

function setup(items: (kem: Uint8Array, sign: ReturnType<typeof newSigningKey>) => BoardItem[] = () => []) {
  const dir = mkdtempSync(join(tmpdir(), 'pqi-desk-'));
  const kem = newKemKey();
  const sign = newSigningKey();
  const payouts = Object.fromEntries((['A', 'B', 'C'] as const).flatMap((k) => [`release:${I[k].hash}`, `refund:${I[k].hash}`]).map((k) => [k, NEVER_SENT]));
  writeFileSync(join(dir, 'verifier.json'), JSON.stringify({ log: [], nonces: {}, closed: {}, payouts }));
  writeFileSync(join(dir, 'board.json'), JSON.stringify(items(kem.publicKey, sign)));
  const solver = new Solver({ sign, kem, wallet: '/nonexistent/solver-wallet-never-used', ua: W.solver.address, escrowUivk: W.escrow.uivk, zingo: zingoConfig(), minFeeZat: 15_000n });
  const verifier = new Verifier({ key: newSigningKey(), escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [keyId(sign.publicKey)], legacyUnboundFills: [I.A.hash, I.B.hash, I.C.hash], zingo: zingoConfig(), statePath: join(dir, 'verifier.json'), tip: chainTip });
  const desk = new Desk({ boardPath: join(dir, 'board.json'), solver, verifier, tip: chainTip, info: { mode: 'test' } });
  return { desk, verifier, kem: kem.publicKey };
}

const item = (k: 'A' | 'B' | 'C', kem: Uint8Array, stage: BoardItem['stage'], extra: Partial<BoardItem> = {}): BoardItem => ({
  hash: I[k].hash,
  envelope: seal(I[k].signed, kem),
  fundingTxid: d.txs.funding,
  stage,
  note: null,
  fillTxid: null,
  claim: null,
  postedAt: '2026-10-20T16:00:00.000Z',
  ...extra,
});

describe('board', () => {
  it('a junk envelope under A’s hash is refused, so A’s real envelope still gets the slot', () => {
    const { desk, kem } = setup();
    const junk = { ...seal(I.B.signed, kem), intent_hash: I.A.hash };
    expect(() => desk.submit(junk, d.txs.funding)).toThrow(/BAD_ENVELOPE/);
    expect(() => desk.submit(seal(I.A.signed, newKemKey().publicKey), d.txs.funding)).toThrow(/NOT_FOR_ME/);
    expect(desk.items).toHaveLength(0);
    expect(desk.submit(seal(I.A.signed, kem), d.txs.funding)).toMatchObject({ hash: I.A.hash, stage: 'received' });
  });
});

describe('ticks (Zcash testnet)', () => {
  it('two ticks at once settle A once: one SETTLED entry, no stray rejection', async () => {
    const { desk, verifier } = setup((kem, sign) => [item('A', kem, 'filled', { fillTxid: d.txs.fills[I.A.hash], claim: signFill(sign, I.A.hash, d.txs.fills[I.A.hash], W.solver.address) })]);
    await Promise.all([desk.tick(), desk.tick()]);
    expect(verifier.state.log.map((e) => e.status)).toEqual(['SETTLED']);
    expect(desk.items[0].stage).toBe('settled');
  });

  it('a declined intent past its deadline and claim window is refunded by the desk', async () => {
    const { desk, verifier } = setup((kem) => [item('C', kem, 'declined', { note: 'fee 1 zat is below 15000' })]);
    const [r] = await desk.tick();
    expect(r).toEqual({ hash: I.C.hash, result: 'REFUNDED' });
    expect(desk.items[0].stage).toBe('refunded');
    expect(verifier.state.log[0]).toMatchObject({ status: 'REFUNDED', refs: { refund_txid: NEVER_SENT } });
  });
});

describe('HTTP', () => {
  let close: () => void = () => undefined;
  afterEach(() => close());

  it('POSTs need a JSON body under the size limit and are not offered cross-origin; reads stay open', async () => {
    const { desk } = setup();
    const server = serveDesk(desk).listen(0, '127.0.0.1');
    close = () => server.close();
    await new Promise((ok) => server.once('listening', ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // What a page on another site can send without a preflight.
    const crossSite = await fetch(`${url}/api/tick`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(crossSite.status).toBe(415);
    expect(crossSite.headers.get('access-control-allow-origin')).toBeNull();

    const big = await fetch(`${url}/api/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) }) }).catch((e: Error) => e);
    expect(big instanceof Error ? big.message : big.status).toBe(413);

    const info = await fetch(`${url}/api/info`);
    expect(info.status).toBe(200);
    expect(info.headers.get('access-control-allow-origin')).toBe('*');
  });
});
