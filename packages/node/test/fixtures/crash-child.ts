// Run by crash.test.ts in a process of its own: a verifier settles A from the published run with
// PQI_TEST_CRASH_AT set, so it kills this process with SIGKILL at that point. Nothing after the crash
// point runs; the test restarts from what is on disk.
//   tsx crash-child.ts <state path> <solver seed hex> <escrow wallet dir>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hexToBytes, keyId, newSigningKey, signFill, signingKeyFromSeed, type SignedIntent } from '@pqi/protocol';
import { chainTip, Verifier, zingoConfig } from '../../src/index.js';

const [statePath, solverSeed, escrowWallet] = process.argv.slice(2);
const d = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../deployments/testnet.json'), 'utf8'));
const A = d.intents.A as { hash: string; signed: SignedIntent };
const solver = signingKeyFromSeed(hexToBytes(solverSeed));
const v = new Verifier({ key: newSigningKey(), escrowWallet, escrowUa: d.wallets.escrow.address, escrowUivk: d.wallets.escrow.uivk, solvers: [keyId(solver.publicKey)], legacyUnboundFills: [A.hash], zingo: zingoConfig(), statePath, tip: chainTip });
const r = await v.settle(A.signed, d.txs.funding, signFill(solver, A.hash, d.txs.fills[A.hash], d.wallets.solver.address));
console.log(JSON.stringify(r));
