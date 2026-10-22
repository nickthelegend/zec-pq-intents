// Run by crash.test.ts in a process of its own: a desk with one 'funded' intent ticks once with
// PQI_TEST_CRASH_AT set, so the solver's delivery kills this process with SIGKILL at that point.
// The solver's spending wallet does not exist, so nothing can be sent from here.
//   tsx deliver-crash-child.ts <board path> <verifier state path> <solver sign seed hex> <solver kem seed hex>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hexToBytes, kemKeyFromSeed, keyId, newSigningKey, signingKeyFromSeed } from '@pqi/protocol';
import { chainTip, Desk, Solver, Verifier, zingoConfig } from '../../src/index.js';

const [boardPath, statePath, signSeed, kemSeed] = process.argv.slice(2);
const d = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../deployments/testnet.json'), 'utf8'));
const sign = signingKeyFromSeed(hexToBytes(signSeed));
const solver = new Solver({ sign, kem: kemKeyFromSeed(hexToBytes(kemSeed)), wallet: '/nonexistent/solver-wallet-never-used', ua: d.wallets.solver.address, escrowUivk: d.wallets.escrow.uivk, zingo: zingoConfig(), minFeeZat: 15_000n });
const verifier = new Verifier({ key: newSigningKey(), escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: d.wallets.escrow.address, escrowUivk: d.wallets.escrow.uivk, solvers: [keyId(sign.publicKey)], zingo: zingoConfig(), statePath, tip: chainTip });
const desk = new Desk({ boardPath, solver, verifier, tip: chainTip, info: {} });
console.log(JSON.stringify(await desk.tick()));
