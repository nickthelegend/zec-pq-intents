// The verifier's own limits, local (a held tip; refusals of a property of the signed intent are
// decided before any funding is read, so no chain is touched and nothing is sent).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newSigningKey, signIntent } from '@pqi/protocol';
import { FEE_BUDGET_ZAT, Verifier, zingoConfig } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const W = d.wallets as Record<string, { address: string; uivk: string }>;
const TIP = 4_600_000;

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
