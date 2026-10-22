// Local: the solver's quote. No chain, no wallet (the receive address and key are the published
// run's, decoded by the scan binary).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newKemKey, newSigningKey, signIntent } from '@pqi/protocol';
import { MIN_BLOCKS_LEFT, Solver, zingoConfig } from '../src/index.js';

const W = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8')).wallets as Record<string, { address: string; uivk: string }>;
const solver = new Solver({ sign: newSigningKey(), kem: newKemKey(), wallet: '/nonexistent', ua: W.solver.address, escrowUivk: W.escrow.uivk, zingo: zingoConfig(), minFeeZat: 15_000n });
const intent = (deadline: number, pay = '60000') =>
  signIntent(newSigningKey(), { escrow: W.escrow.address, pay_zat: pay, min_out_zat: '40000', receive_ua: W.receive.address, receive_uivk: W.receive.uivk, refund_ua: W.user.address, deadline_height: deadline });

describe('solver quote', () => {
  it(`declines when fewer than ${MIN_BLOCKS_LEFT} blocks are left (a fill it sends would land after the deadline)`, async () => {
    const s = intent(1_000);
    expect(await solver.quote(s, 999)).toMatchObject({ accept: false });
    expect(await solver.quote(s, 1_000 - MIN_BLOCKS_LEFT + 1)).toMatchObject({ accept: false });
    expect(await solver.quote(s, 1_000 - MIN_BLOCKS_LEFT)).toEqual({ accept: true, feeZat: 20_000n, payTo: W.receive.address });
  });

  it('declines a fee under its minimum', async () => {
    expect(await solver.quote(intent(1_000, '50000'), 900)).toMatchObject({ accept: false, reason: 'fee 10000 zat is below 15000' });
  });
});
