// Local: the solver's quote. No chain, no wallet.
import { describe, expect, it } from 'vitest';
import { newKemKey, newSigningKey, signIntent } from '@pqi/protocol';
import { MIN_BLOCKS_LEFT, Solver, zingoConfig } from '../src/index.js';

const UA = (c: string) => `utest1${c.repeat(40)}`;
const solver = new Solver({ sign: newSigningKey(), kem: newKemKey(), wallet: '/nonexistent', ua: UA('s'), escrowUivk: `uivktest1${'k'.repeat(40)}`, zingo: zingoConfig(), minFeeZat: 15_000n });
const intent = (deadline: number, pay = '60000') =>
  signIntent(newSigningKey(), { escrow: UA('e'), pay_zat: pay, min_out_zat: '40000', receive_ua: UA('r'), receive_uivk: `uivktest1${'k'.repeat(40)}`, refund_ua: UA('f'), deadline_height: deadline });

describe('solver quote', () => {
  it(`declines when fewer than ${MIN_BLOCKS_LEFT} blocks are left (a fill it sends would land after the deadline)`, () => {
    const s = intent(1_000);
    expect(solver.quote(s, 999)).toMatchObject({ accept: false });
    expect(solver.quote(s, 1_000 - MIN_BLOCKS_LEFT + 1)).toMatchObject({ accept: false });
    expect(solver.quote(s, 1_000 - MIN_BLOCKS_LEFT)).toEqual({ accept: true, feeZat: 20_000n });
  });

  it('declines a fee under its minimum', () => {
    expect(solver.quote(intent(1_000, '50000'), 900)).toMatchObject({ accept: false, reason: 'fee 10000 zat is below 15000' });
  });
});
