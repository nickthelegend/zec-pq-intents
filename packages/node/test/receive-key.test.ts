// The receive viewing key must derive the receive address. The verifier reads a fill with
// receive_uivk; if that key belongs to another wallet, a delivery to receive_ua is invisible to it,
// the fill is refused, and the escrow is refunded on top of the delivery. Local: the scan binary
// decodes the published run's addresses and keys; no chain is read and nothing is sent.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyId, newKemKey, newSigningKey, signFill, signIntent } from '@pqi/protocol';
import { owns, Solver, Verifier, zingoConfig } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const W = d.wallets as Record<string, { address: string; uivk: string }>;
const TIP = 4_600_000;
const solverKey = newSigningKey();
const solver = new Solver({ sign: solverKey, kem: newKemKey(), wallet: '/nonexistent/solver-wallet-never-used', ua: W.solver.address, escrowUivk: W.escrow.uivk, zingo: zingoConfig(), minFeeZat: 15_000n });
/** An intent to the published receive address, with the given receive viewing key. */
const intent = (receive_uivk: string) =>
  signIntent(newSigningKey(), { escrow: W.escrow.address, pay_zat: '60000', min_out_zat: '40000', receive_ua: W.receive.address, receive_uivk, refund_ua: W.user.address, deadline_height: TIP + 100 });

describe('receive_uivk must derive receive_ua', () => {
  it('the scan binary: the receive key covers the receive address, the anchor wallet’s key does not', async () => {
    expect(await owns(W.receive.uivk, W.receive.address)).toEqual({ address: W.receive.address, receivers: ['orchard'], covered: ['orchard'], pay_to: W.receive.address });
    expect(await owns(W.anchor.uivk, W.receive.address)).toMatchObject({ covered: [], pay_to: null });
    expect(await owns(W.receive.uivk, 'utest1notanaddress')).toMatchObject({ covered: [], pay_to: null, invalid: expect.stringMatching(/^not a testnet unified address/) });
  });

  it('the solver declines an intent whose receive key is another wallet’s (RECEIVE_KEY_MISMATCH) and accepts the matching pair, paying that receiver', async () => {
    expect(await solver.quote(intent(W.anchor.uivk), TIP)).toMatchObject({ accept: false, reason: expect.stringMatching(/^RECEIVE_KEY_MISMATCH/) });
    expect(await solver.quote(intent(W.receive.uivk), TIP)).toEqual({ accept: true, feeZat: 20_000n, payTo: W.receive.address });
  });

  it('the solver refuses to deliver to it before any payment is attempted', async () => {
    const s = intent(W.anchor.uivk);
    await expect(solver.deliver('ab'.repeat(32), s)).rejects.toThrow(/^RECEIVE_KEY_MISMATCH/);
  });

  it('the verifier refuses a fill claim on it with a signed RECEIVE_KEY_MISMATCH entry, before reading any fill', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'pqi-rk-')), 'state.json');
    writeFileSync(statePath, JSON.stringify({ log: [], nonces: {}, closed: {}, payouts: {}, sending: {} }));
    const v = new Verifier({ key: newSigningKey(), escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [keyId(solverKey.publicKey)], zingo: zingoConfig(), statePath, tip: async () => TIP });
    const s = intent(W.anchor.uivk);
    const r = await v.settle(s, 'cd'.repeat(32), signFill(solverKey, 'ef'.repeat(32), 'ab'.repeat(32), W.solver.address));
    expect(r).toMatchObject({ status: 'REJECTED', reason: 'RECEIVE_KEY_MISMATCH' });
    expect(v.state.log.map((e) => e.reason)).toEqual(['RECEIVE_KEY_MISMATCH']);
  });
});
