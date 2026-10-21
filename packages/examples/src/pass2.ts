// Pass 2, live on Zcash testnet: the Oct 21 fixes shown with new transactions, continuing the Oct 20
// verifier (same key, same log) with the same demo wallets. Resumable: state in .demo/pass2-state.json.
// Writes deployments/testnet-pass2.json.
//   pnpm --filter @pqi/examples pass2
//
//  D      a new intent through the desk. The solver waits for the funding to be 3 blocks deep, delivers
//         with a memo that names its key (pqi1:<D>:fill:<solver key id>); the verifier waits for the
//         fill to be 3 blocks deep.
//  crash  the desk runs in a child process with PQI_TEST_CRASH_AT=payout-after-broadcast: the release is
//         broadcast and the process is killed (SIGKILL) before its txid is saved. The restarted verifier
//         finds the release in the escrow's history by its memo and records it; nothing is paid twice.
//  theft  a second configured solver signs a claim on D's fill: FILL_BY_OTHER_SOLVER.
//  anchor a new anchor that names the Oct 20 anchor, then every anchor the escrow sent is checked
//         against the log (checkAnchors).
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex, checkAnchors, findEquivocation, fromB64, hexToBytes, intentHash, kemKeyFromSeed, keyId, memo, randomBytes, seal, signFill, signIntent, signingKeyFromSeed, toB64, verifyLog, type LogEntry, type SignedIntent } from '@pqi/protocol';
import { anchorHistory, chainTip, Desk, MIN_CONFIRMATIONS, quicksend, scan, sentWithMemo, Solver, Verifier, zingoConfig, type VerifierState } from '@pqi/node';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), '../../..');
const DEMO = resolve(ROOT, '.demo');
const W = (n: string) => resolve(DEMO, 'wallets', n);
const RUN = JSON.parse(readFileSync(resolve(DEMO, 'run-state.json'), 'utf8'));
const OCT20 = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet.json'), 'utf8'));
const STATE = resolve(DEMO, 'pass2-state.json');
const VSTATE = resolve(DEMO, 'verifier-state.json');
const BOARD = resolve(DEMO, 'board-pass2.json');
const cfg = zingoConfig();
const PAY = 60_000n;
const OUT = 40_000n;

type State = Record<string, any>;
const st: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
st.tx ??= {};
st.observed ??= [];
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 2), { mode: 0o600 });
const say = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Keys: the Oct 20 seeds (the verifier continues its log); a second solver key for the theft attempt.
st.seeds ??= { solver2: bytesToHex(randomBytes(32)) };
save();
const user = signingKeyFromSeed(hexToBytes(RUN.seeds.user));
const solverSign = signingKeyFromSeed(hexToBytes(RUN.seeds.solverSign));
const solver2 = signingKeyFromSeed(hexToBytes(st.seeds.solver2));
const solverKem = kemKeyFromSeed(hexToBytes(RUN.seeds.solverKem));
const verifierKey = signingKeyFromSeed(hexToBytes(RUN.seeds.verifier));

function services() {
  const verifier = new Verifier({ key: verifierKey, escrowWallet: W('escrow'), escrowUa: RUN.addr.escrow, escrowUivk: RUN.uivk.escrow, solvers: [keyId(solverSign.publicKey), keyId(solver2.publicKey)], zingo: cfg, statePath: VSTATE, tip: chainTip });
  const solver = new Solver({ sign: solverSign, kem: solverKem, wallet: W('solver'), ua: RUN.addr.solver, escrowUivk: RUN.uivk.escrow, zingo: cfg, minFeeZat: 15_000n });
  const desk = new Desk({ boardPath: BOARD, solver, verifier, tip: chainTip, info: {} });
  return { verifier, solver, desk };
}

/** Child: tick the desk until the verifier kills this process at the release (or give up). */
async function child() {
  const { desk } = services();
  for (let round = 0; round < 120; round++) {
    for (const x of await desk.tick()) say(`desk ${x.hash.slice(0, 10)}: ${x.result}`);
    if (desk.items.every((i) => !['received', 'funded', 'filled'].includes(i.stage))) break;
    await sleep(30_000);
  }
  say('child: no crash point was reached');
  process.exit(3);
}

async function mined(uivk: string, txid: string, label: string) {
  for (let i = 0; i < 80; i++) {
    const r = await scan(uivk, txid, 0, undefined);
    if (r.confirmations >= MIN_CONFIRMATIONS) return r;
    if (i % 3 === 0) say(`  … ${label} ${txid.slice(0, 10)} ${r.found ? `${r.confirmations} of ${MIN_CONFIRMATIONS} confirmations` : 'not seen yet'}`);
    await sleep(25_000);
  }
  throw new Error(`${label} ${txid} not ${MIN_CONFIRMATIONS} blocks deep after ~33 minutes`);
}

async function main() {
  if (!existsSync(resolve(DEMO, 'verifier-state.oct20.json'))) copyFileSync(VSTATE, resolve(DEMO, 'verifier-state.oct20.json'));
  const oct20Log = OCT20.log as LogEntry[];

  // ---- D: signed, sealed, funded ----
  if (!st.D) {
    const tip = await chainTip();
    st.D = signIntent(user, { escrow: RUN.addr.escrow, pay_zat: PAY.toString(), min_out_zat: OUT.toString(), receive_ua: RUN.addr.receive, receive_uivk: RUN.uivk.receive, refund_ua: RUN.addr.user, deadline_height: tip + 60 });
    st.envelopeD = seal(st.D, solverKem.publicKey);
    save();
  }
  const D = st.D as SignedIntent;
  const H = intentHash(D.intent);
  say(`intent D ${H.slice(0, 16)}… deadline ${D.intent.deadline_height}`);
  st.tx.fundingD ??= (await quicksend(cfg, W('user'), [{ address: RUN.addr.escrow, amount: PAY, memo: memo.funding(H) }]))[0];
  save();
  say(`  funding ${st.tx.fundingD}`);

  // ---- the desk in a child process, killed after the release broadcast ----
  if (!st.crash) {
    if (!existsSync(BOARD)) writeFileSync(BOARD, '[]');
    services().desk.submit(st.envelopeD, st.tx.fundingD);
    const p = spawn(process.execPath, ['--import', 'tsx', HERE, '--child'], { cwd: resolve(ROOT, 'packages/examples'), env: { ...process.env, PQI_TEST_CRASH_AT: 'payout-after-broadcast' }, stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout!.on('data', (b: Buffer) => {
      for (const line of String(b).split('\n').filter(Boolean)) {
        say(`  [child] ${line}`);
        if (/confirmations|NOT_CONFIRMED/.test(line) && !st.observed.includes(line.replace(/^desk \w+: /, ''))) st.observed.push(line.replace(/^desk \w+: /, ''));
      }
    });
    const [code, signal] = await new Promise<[number | null, string | null]>((ok) => p.on('exit', (c, s) => ok([c, s])));
    if (signal !== 'SIGKILL') throw new Error(`the child ended with code ${code}, signal ${signal}: no crash at the release`);
    const left = JSON.parse(readFileSync(VSTATE, 'utf8')) as VerifierState;
    const record = left.sending?.[`release:${H}`];
    if (!record || left.payouts[`release:${H}`]) throw new Error('expected a write-ahead record and no saved txid after the kill');
    st.crash = { point: 'payout-after-broadcast', signal, write_ahead: record, saved_txid_before_restart: null, at: new Date().toISOString() };
    save();
  }
  say(`killed by ${st.crash.signal} after broadcasting D's release; write-ahead: ${JSON.stringify(st.crash.write_ahead)}`);

  const { verifier, desk } = services();
  const item = desk.items.find((i) => i.hash === H)!;
  st.tx.fillD = item.fillTxid;
  save();

  // ---- theft attempt: the second configured solver claims D's fill ----
  st.theft ??= await verifier.settle(D, st.tx.fundingD, signFill(solver2, H, item.fillTxid!, RUN.addr.user));
  save();
  say(`second solver's claim on D's fill: ${st.theft.status} ${st.theft.reason}`);

  // ---- restart: the desk settles D; the verifier reconciles the release instead of paying again ----
  const stage = (): string => item.stage; // changed by desk.tick
  for (let round = 0; stage() !== 'settled' && round < 60; round++) {
    for (const x of await desk.tick()) {
      say(`  desk ${x.hash.slice(0, 10)}: ${x.result}`);
      if (/PAYOUT_UNRECONCILED/.test(x.result)) st.crash.reconcile_pending ??= x.result;
    }
    save();
    if (stage() !== 'settled') await sleep(30_000);
  }
  if (stage() !== 'settled') throw new Error(`D ended ${item.stage}: ${item.note}`);
  const settled = verifier.state.log.find((e) => e.status === 'SETTLED' && e.intent_hash === H)!;
  st.tx.releaseD = settled.refs.release_txid;
  const sentRelease = await sentWithMemo(cfg, W('escrow'), memo.release(H));
  st.crash.reconciled_txid = st.tx.releaseD;
  st.crash.escrow_sends_with_release_memo = sentRelease.map((t) => t.txid);
  save();
  say(`D settled with release ${st.tx.releaseD}; the escrow sent ${sentRelease.length} transaction(s) with memo ${memo.release(H).slice(0, 24)}…`);
  if (sentRelease.length !== 1 || sentRelease[0].txid !== st.tx.releaseD) throw new Error('the release was not paid exactly once');

  // ---- anchor, chained to the Oct 20 anchor ----
  st.anchor ??= await verifier.anchor(RUN.addr.anchor);
  save();
  await mined(RUN.uivk.anchor, st.anchor.txid, 'anchor');
  await mined(RUN.uivk.solver, st.tx.releaseD, 'release');
  const history = await anchorHistory(cfg, W('escrow'));
  const log = verifier.state.log;
  const anchors = checkAnchors(log, history);
  const full = verifyLog(log, verifierKey.publicKey);
  const extendsOct20 = findEquivocation(oct20Log, log, verifierKey.publicKey) === null && log.length > oct20Log.length;
  const fillSeen = await scan(RUN.uivk.receive, item.fillTxid!, OUT, memo.fill(H, keyId(solverSign.publicKey)));
  const releaseSeen = await scan(RUN.uivk.solver, st.tx.releaseD, PAY - 15_000n, memo.release(H));
  const anchorSeen = await scan(RUN.uivk.anchor, st.anchor.txid, 1, memo.anchor(st.anchor.seq, st.anchor.head, st.anchor.prev));
  say(`log ${full.entries} entries verifies ${full.ok}, extends Oct 20 ${extendsOct20}; anchors ${anchors.ok} (${anchors.chain.length} in one chain); fill names the solver ${fillSeen.ok}; release seen ${releaseSeen.ok}; anchor memo seen ${anchorSeen.ok}`);
  for (const e of log.slice(oct20Log.length)) say(`  #${e.seq} ${e.status}${e.reason ? ` ${e.reason}` : ''}`);
  if (!full.ok || !extendsOct20 || !anchors.ok || !fillSeen.ok || !releaseSeen.ok || !anchorSeen.ok) throw new Error('final checks failed');

  writeFileSync(
    resolve(ROOT, 'deployments/testnet-pass2.json'),
    JSON.stringify(
      {
        network: 'zcash-testnet',
        ranAt: new Date().toISOString(),
        note: 'Pass 2 (Oct 21): the same demo wallets and verifier key as deployments/testnet.json; the log continues from its entry 9. Shows a solver-bound fill, 3 confirmations, a process killed after a release broadcast and reconciled on restart, a refused claim by a second solver, and an anchor chained to the Oct 20 anchor.',
        wallets: OCT20.wallets,
        keys: { ...OCT20.keys, solver2: { scheme: 'ML-DSA-65', id: keyId(solver2.publicKey), pk: toB64(solver2.publicKey) } },
        verifierConfig: { minConfirmations: MIN_CONFIRMATIONS, solvers: [keyId(solverSign.publicKey), keyId(solver2.publicKey)] },
        intent: { hash: H, signed: D, envelope: st.envelopeD, claim: item.claim },
        txs: { funding: st.tx.fundingD, fill: item.fillTxid, release: st.tx.releaseD, anchor: st.anchor.txid, previousAnchor: st.anchor.prev },
        observedPending: st.observed,
        crash: st.crash,
        theft: { status: st.theft.status, reason: st.theft.reason, seq: st.theft.entry?.seq, solver: keyId(solver2.publicKey) },
        anchors: { escrowHistory: history, check: anchors },
        checks: { logVerifies: full.ok, extendsOct20Log: extendsOct20, fillNamesSolver: fillSeen.ok, releaseSeen: releaseSeen.ok, anchorMemoSeen: anchorSeen.ok },
        log,
      },
      null,
      2,
    ) + '\n',
  );
  say('wrote deployments/testnet-pass2.json');
}

if (process.argv.includes('--child')) child().catch((e: Error) => (console.error(`child: ${e.message}`), process.exit(1)));
else
  main().then(
    () => process.exit(0),
    (e: Error) => {
      console.error(`FAILED: ${e.message}`);
      process.exit(1);
    },
  );
