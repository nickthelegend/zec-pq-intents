// Video demo: re-verifies the published run live. Signatures in this process; the chain through
// lightwalletd now. The solver's KEM key comes from .demo (local demo key, never printed).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromB64, hexToBytes, kemKeyFromSeed, memo, newKemKey, open, verifyIntent, verifyLog, verifySig, entryHash, type LogEntry, type SignedIntent } from '@pqi/protocol';
import { scan } from '@pqi/node';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const d = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet.json'), 'utf8'));
const st = JSON.parse(readFileSync(resolve(ROOT, '.demo/run-state.json'), 'utf8'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = async (s: string, ms = 700) => {
  console.log(s);
  await sleep(ms);
};
const short = (s: string) => `${s.slice(0, 10)}…`;

async function main() {
  const vpk = fromB64(d.keys.verifier.pk);
  await say(`1. the attestation log: ${d.log.length} entries, verifier ML-DSA-65 key ${short(d.keys.verifier.id)}`);
  let prev = '0'.repeat(64);
  for (const e of d.log as LogEntry[]) {
    const { hash, sig, ...body } = e;
    const ok = body.prev === prev && entryHash(body) === hash && verifySig(vpk, 'pqi1:log:', hash, sig);
    prev = hash;
    await say(`   #${e.seq} ${ok ? '✓' : '✗'} ${e.status.padEnd(9)} ${e.reason ?? ''}`, 250);
  }
  await say(`   whole log: ${JSON.stringify(verifyLog(d.log, vpk))}`, 1200);

  await say('\n2. intent A, signed with ML-DSA-65');
  const A = d.intents.A.signed as SignedIntent;
  await say(`   as signed: verifies, hash ${short(verifyIntent(A))}`);
  for (const [label, s] of [
    ['min_out_zat changed to 1', { ...A, intent: { ...A.intent, min_out_zat: '1' } }],
    ['signed by another key, naming the user', d.attacks.forgedAsUser],
  ] as [string, SignedIntent][]) {
    try {
      verifyIntent(s);
      await say(`   ${label}: verified (unexpected)`);
    } catch (e) {
      await say(`   ${label}: ${(e as Error).message}`);
    }
  }

  await say('\n3. the envelope sealed to the solver with ML-KEM-768');
  const env = d.intents.A.envelope;
  await say(`   ciphertext: KEM ${fromB64(env.kem_ct).length} bytes + AES-GCM ${fromB64(env.ct).length} bytes, no address or amount in clear`);
  const solverKem = kemKeyFromSeed(hexToBytes(st.seeds.solverKem));
  await say(`   opened with the solver's key: intent hash ${short(verifyIntent(open(env, solverKem)))} (same)`);
  try {
    open(env, newKemKey());
  } catch (e) {
    await say(`   any other key: ${(e as Error).message}`, 1200);
  }

  await say('\n4. the chain, read now through viewing keys (Zcash testnet, lightwalletd)');
  const a = d.log.find((e: LogEntry) => e.status === 'ANCHORED');
  const an = await scan(d.wallets.anchor.uivk, a.refs.anchor_txid, 1, memo.anchor(Number(a.refs.anchored_seq), a.refs.anchored_head));
  await say(`   anchor ${short(a.refs.anchor_txid)} block ${an.height}: memo pqi1:anchor:${a.refs.anchored_seq}:${short(a.refs.anchored_head)} on-chain ${an.ok}, = head of #0..#${a.refs.anchored_seq} ${verifyLog(d.log.slice(0, Number(a.refs.anchored_seq) + 1), vpk).head === a.refs.anchored_head}`);
  for (const e of d.log.filter((x: LogEntry) => x.status === 'SETTLED')) {
    const r = await scan(d.wallets.solver.uivk, e.refs.release_txid, Number(e.refs.released_zat), memo.release(e.intent_hash));
    await say(`   release ${short(e.refs.release_txid)} → solver: ${r.paidZat} zat, memo matches ${r.ok}`);
  }
  const rf = d.log.find((e: LogEntry) => e.status === 'REFUNDED');
  const r = await scan(d.wallets.user.uivk, rf.refs.refund_txid, Number(rf.refs.refunded_zat), memo.refund(rf.intent_hash));
  await say(`   refund ${short(rf.refs.refund_txid)} → user: ${r.paidZat} zat, memo matches ${r.ok}`, 2000);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);
