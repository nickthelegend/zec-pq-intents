// Live end-to-end run on Zcash testnet; writes deployments/testnet.json. Resumable: every key,
// intent and txid is saved in .demo/ before it is used, so a rerun never pays twice.
//   PQI_FUNDER_WALLET=<zingo data dir of a funded demo wallet> pnpm --filter @pqi/examples run-live
//
//  A, B  funded, filled by the solver, settled by the verifier (escrow released to the solver)
//  C     short deadline: a "fill" with the wrong memo is not credited; a correct fill after the
//        deadline is rejected as EXPIRED; the user gets the escrow back (REFUNDED)
//  attacks with no new transaction: A with a changed field (BAD_SIGNATURE), A again (ALREADY_SETTLED),
//        a new intent reusing A's nonce (NONCE_REUSED), an intent signed by another key (WRONG_KEY)
//  anchor the log head in a shielded memo to a published-UIVK address, then re-read it
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex, hexToBytes, intentHash, kemKeyFromSeed, keyId, memo, randomBytes, seal, signIntent, signingKeyFromSeed, toB64, verifyLog, type SignedIntent } from '@pqi/protocol';
import { chainTip, Desk, scan, Solver, uivkFromUfvk, Verifier, address, exportUfvk, quicksend, spendable, zingoConfig, type Receiver } from '@pqi/node';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO = resolve(ROOT, '.demo');
const W = (n: string) => resolve(DEMO, 'wallets', n);
const STATE = resolve(DEMO, 'run-state.json');
const cfg = zingoConfig();
const PAY = 60_000n;
const OUT = 40_000n;
mkdirSync(resolve(DEMO, 'wallets'), { recursive: true, mode: 0o700 });

type State = Record<string, any>;
const st: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
st.tx ??= {};
st.decisions ??= {};
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 2), { mode: 0o600 });
const say = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendOnce(label: string, from: string, to: Receiver[]): Promise<string> {
  if (st.tx[label]) return st.tx[label];
  for (let i = 0; ; i++) {
    try {
      const [txid] = await quicksend(cfg, from, to);
      st.tx[label] = txid;
      save();
      say(`  sent ${label}: ${txid}`);
      return txid;
    } catch (e) {
      if (!/Insufficient balance/.test((e as Error).message) || i >= 25) throw e;
      say(`  … ${label}: notes not spendable yet, waiting a block`);
      await sleep(60_000);
    }
  }
}

async function mined(uivk: string, txid: string, label: string) {
  for (let i = 0; i < 80; i++) {
    const r = await scan(uivk, txid, 0, undefined);
    if (r.confirmations >= 1) return r;
    if (i % 3 === 0) say(`  … ${label} ${txid.slice(0, 10)} ${r.found ? 'in the mempool' : 'not seen yet'}`);
    await sleep(20_000);
  }
  throw new Error(`${label} ${txid} not mined after ~27 minutes`);
}

/** A decision's log sequence number, printed; a pending one is a bug here (everything was mined first). */
function logged(d: { status: string; reason: string | null; entry?: { seq: number } }): number {
  if (d.status === 'PENDING' || !d.entry) throw new Error(`still pending: ${d.reason}`);
  say(`  verifier: ${d.status}${d.reason ? ` ${d.reason}` : ''} (log #${d.entry.seq})`);
  return d.entry.seq;
}

async function main() {
  // ---- keys (seeds stay in .demo/run-state.json, mode 0600; only public keys are published) ----
  st.seeds ??= { user: bytesToHex(randomBytes(32)), mallory: bytesToHex(randomBytes(32)), solverSign: bytesToHex(randomBytes(32)), solverKem: bytesToHex(randomBytes(64)), verifier: bytesToHex(randomBytes(32)) };
  save();
  const user = signingKeyFromSeed(hexToBytes(st.seeds.user));
  const mallory = signingKeyFromSeed(hexToBytes(st.seeds.mallory));
  const solverSign = signingKeyFromSeed(hexToBytes(st.seeds.solverSign));
  const solverKem = kemKeyFromSeed(hexToBytes(st.seeds.solverKem));
  const verifierKey = signingKeyFromSeed(hexToBytes(st.seeds.verifier));

  // ---- wallets ----
  st.addr ??= {};
  st.uivk ??= {};
  for (const n of ['user', 'receive', 'solver', 'escrow', 'anchor']) {
    st.addr[n] ??= await address(cfg, W(n));
    st.uivk[n] ??= await uivkFromUfvk(await exportUfvk(cfg, W(n)));
    save();
  }
  say(`wallets: ${Object.entries(st.addr).map(([k, v]) => `${k} ${(v as string).slice(0, 14)}…`).join('  ')}`);

  if (!st.tx.fund) {
    const funder = process.env.PQI_FUNDER_WALLET;
    if (!funder) throw new Error('Setup required: PQI_FUNDER_WALLET (zingo data dir of a funded demo testnet wallet)');
    say(`funder spendable ${await spendable(cfg, funder)} zat`);
    await sendOnce('fund', funder, [
      { address: st.addr.user, amount: 300_000n },
      ...Array.from({ length: 4 }, () => ({ address: st.addr.solver, amount: 80_000n })),
      { address: st.addr.escrow, amount: 60_000n },
    ]);
  }
  await mined(st.uivk.user, st.tx.fund, 'fund');

  const verifier = new Verifier({ key: verifierKey, escrowWallet: W('escrow'), escrowUa: st.addr.escrow, escrowUivk: st.uivk.escrow, zingo: cfg, statePath: resolve(DEMO, 'verifier-state.json'), tip: chainTip });
  const solver = new Solver({ sign: solverSign, kem: solverKem, wallet: W('solver'), ua: st.addr.solver, escrowUivk: st.uivk.escrow, zingo: cfg, minFeeZat: 15_000n });
  const desk = new Desk({ boardPath: resolve(DEMO, 'board.json'), solver, verifier, tip: chainTip, info: {} });

  // ---- intents ----
  if (!st.intents) {
    const tip = await chainTip();
    const base = { escrow: st.addr.escrow, pay_zat: PAY.toString(), min_out_zat: OUT.toString(), receive_ua: st.addr.receive, receive_uivk: st.uivk.receive, refund_ua: st.addr.user };
    st.intents = {
      A: signIntent(user, { ...base, deadline_height: tip + 60 }),
      B: signIntent(user, { ...base, deadline_height: tip + 60 }),
      C: signIntent(user, { ...base, deadline_height: tip + 12 }),
    };
    st.createdAtTip = tip;
    save();
  }
  const I = st.intents as Record<'A' | 'B' | 'C', SignedIntent>;
  const H = { A: intentHash(I.A.intent), B: intentHash(I.B.intent), C: intentHash(I.C.intent) };
  for (const k of ['A', 'B', 'C'] as const) say(`intent ${k} ${H[k].slice(0, 16)}… deadline ${I[k].intent.deadline_height}`);
  const env = { A: seal(I.A, solverKem.publicKey), B: seal(I.B, solverKem.publicKey), C: seal(I.C, solverKem.publicKey) };
  st.envelopes ??= env;
  save();

  // ---- the user funds all three in one shielded transaction ----
  const funding = await sendOnce('funding', W('user'), (['A', 'B', 'C'] as const).map((k) => ({ address: st.addr.escrow, amount: PAY, memo: memo.funding(H[k]) })));
  await mined(st.uivk.escrow, funding, 'funding');

  // ---- C: the solver "fills" with the wrong memo before the deadline ----
  const wrong = st.tx.wrongMemoFill ?? (st.tx.wrongMemoFill = await solver.deliver(H.C, I.C, `pqi1:${H.C}:fll`));
  save();

  // ---- A, B through the desk: solver checks funding, delivers, claims; verifier settles ----
  desk.submit(st.envelopes.A, funding);
  desk.submit(st.envelopes.B, funding);
  for (let round = 0; round < 60; round++) {
    const r = await desk.tick();
    for (const x of r) say(`  desk ${x.hash.slice(0, 10)}: ${x.result}`);
    if (desk.items.every((i) => !['received', 'funded', 'filled'].includes(i.stage))) break;
    await sleep(30_000);
  }
  for (const i of desk.items) if (i.stage !== 'settled') throw new Error(`intent ${i.hash} ended ${i.stage}: ${i.note}`);
  const itemA = desk.items.find((i) => i.hash === H.A)!;

  // ---- C, wrong-memo fill claimed ----
  await mined(st.uivk.receive, wrong, 'wrong-memo fill');
  st.decisions.wrongMemo ??= logged(await verifier.settle(I.C, funding, solver.claim(H.C, wrong)));
  save();

  // ---- attacks with no new transaction ----
  if (st.decisions.tampered === undefined) {
    const tampered: SignedIntent = { ...I.A, intent: { ...I.A.intent, min_out_zat: '1' } };
    st.decisions.tampered = logged(await verifier.settle(tampered, funding, itemA.claim!));
    st.decisions.replay = logged(await verifier.settle(I.A, funding, itemA.claim!));
    const reuse = signIntent(user, { escrow: st.addr.escrow, pay_zat: PAY.toString(), min_out_zat: OUT.toString(), receive_ua: st.addr.receive, receive_uivk: st.uivk.receive, refund_ua: st.addr.user, deadline_height: I.A.intent.deadline_height + 1, nonce: I.A.intent.nonce });
    st.decisions.nonceReuse = logged(await verifier.settle(reuse, funding, solver.claim(intentHash(reuse.intent), itemA.fillTxid!)));
    const forged = signIntent(mallory, { escrow: st.addr.escrow, pay_zat: PAY.toString(), min_out_zat: OUT.toString(), receive_ua: st.addr.receive, receive_uivk: st.uivk.receive, refund_ua: st.addr.user, deadline_height: I.B.intent.deadline_height });
    const forgedAsUser: SignedIntent = { ...forged, intent: { ...forged.intent, user: keyId(user.publicKey) } };
    st.decisions.wrongKey = logged(await verifier.settle(forgedAsUser, funding, itemA.claim!));
    st.attacks = { reuse, forgedAsUser };
    save();
  }

  // ---- C after its deadline: a correct fill is too late; the user is refunded ----
  while ((await chainTip()) <= I.C.intent.deadline_height) {
    say(`  … waiting for C's deadline ${I.C.intent.deadline_height}`);
    await sleep(45_000);
  }
  const late = st.tx.lateFill ?? (st.tx.lateFill = await solver.deliver(H.C, I.C));
  save();
  await mined(st.uivk.receive, late, 'late fill');
  st.decisions.expired ??= logged(await verifier.settle(I.C, funding, solver.claim(H.C, late)));
  save();
  const refund = await verifier.refund(I.C, funding);
  if (refund.status === 'PENDING') throw new Error(refund.reason);
  st.decisions.refund ??= refund.entry.seq;
  save();

  // ---- anchor ----
  st.anchor ??= await verifier.anchor(st.addr.anchor);
  save();
  const a = st.anchor as { txid: string; head: string; seq: number };
  await mined(st.uivk.anchor, a.txid, 'anchor');
  const anchorSeen = await scan(st.uivk.anchor, a.txid, 1, memo.anchor(a.seq, a.head));
  const recomputed = verifyLog(verifier.state.log.slice(0, a.seq + 1), verifierKey.publicKey);
  say(`anchor ${a.txid}: memo seen ${anchorSeen.ok}; recomputed head of entries 0..${a.seq} = anchored head: ${recomputed.head === a.head}`);

  // ---- re-check the payouts with viewing keys ----
  const settled = verifier.state.log.filter((e) => e.status === 'SETTLED');
  const releaseChecks = [];
  for (const e of settled) {
    await mined(st.uivk.solver, e.refs.release_txid, 'release');
    releaseChecks.push({ intent: e.intent_hash, ...(await scan(st.uivk.solver, e.refs.release_txid, BigInt(e.refs.released_zat), memo.release(e.intent_hash!))) });
  }
  await mined(st.uivk.user, refund.payoutTxid!, 'refund');
  const refundCheck = await scan(st.uivk.user, refund.payoutTxid!, PAY - 15_000n, memo.refund(H.C));
  const full = verifyLog(verifier.state.log, verifierKey.publicKey);
  say(`log: ${full.entries} entries, verifies ${full.ok}; releases seen by the solver key ${releaseChecks.every((r) => r.ok)}; refund seen by the user key ${refundCheck.ok}`);
  for (const e of verifier.state.log) say(`  #${e.seq} ${e.status}${e.reason ? ` ${e.reason}` : ''}${e.intent_hash ? ` ${e.intent_hash.slice(0, 10)}…` : ''}`);
  if (!full.ok || !anchorSeen.ok || recomputed.head !== a.head || !refundCheck.ok || !releaseChecks.every((r) => r.ok)) throw new Error('final checks failed');

  writeFileSync(
    resolve(ROOT, 'deployments/testnet.json'),
    JSON.stringify(
      {
        network: 'zcash-testnet',
        ranAt: new Date().toISOString(),
        note: 'Demo-only testnet wallets. Incoming viewing keys and the signed intents are published so anyone can re-check every decision; in real use intents stay sealed to the solver.',
        wallets: Object.fromEntries(Object.keys(st.addr).map((k) => [k, { address: st.addr[k], uivk: k === 'user' || k === 'solver' || k === 'escrow' || k === 'anchor' || k === 'receive' ? st.uivk[k] : undefined }])),
        keys: {
          user: { scheme: 'ML-DSA-65', id: keyId(user.publicKey), pk: toB64(user.publicKey) },
          attacker: { scheme: 'ML-DSA-65', id: keyId(mallory.publicKey), pk: toB64(mallory.publicKey) },
          solver: { scheme: 'ML-DSA-65', id: keyId(solverSign.publicKey), pk: toB64(solverSign.publicKey) },
          solverKem: { scheme: 'ML-KEM-768', id: keyId(solverKem.publicKey), pk: toB64(solverKem.publicKey) },
          verifier: { scheme: 'ML-DSA-65', id: keyId(verifierKey.publicKey), pk: toB64(verifierKey.publicKey) },
        },
        txs: { fund: st.tx.fund, funding, wrongMemoFill: wrong, lateFill: late, fills: Object.fromEntries(desk.items.map((i) => [i.hash, i.fillTxid])), releases: releaseChecks.map((r) => r.txid), refund: refund.payoutTxid, anchor: a.txid },
        intents: { A: { hash: H.A, signed: I.A, envelope: st.envelopes.A }, B: { hash: H.B, signed: I.B, envelope: st.envelopes.B }, C: { hash: H.C, signed: I.C, envelope: st.envelopes.C } },
        attacks: { decisions: st.decisions, reuse: st.attacks.reuse, forgedAsUser: st.attacks.forgedAsUser },
        anchor: { ...a, memoSeen: anchorSeen.ok, recomputedHeadMatches: recomputed.head === a.head },
        checks: { logVerifies: full.ok, releases: releaseChecks.map((r) => ({ txid: r.txid, ok: r.ok, paidZat: r.paidZat, height: r.height })), refund: { ok: refundCheck.ok, paidZat: refundCheck.paidZat, height: refundCheck.height } },
        log: verifier.state.log,
      },
      null,
      2,
    ) + '\n',
  );
  say('wrote deployments/testnet.json');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);
