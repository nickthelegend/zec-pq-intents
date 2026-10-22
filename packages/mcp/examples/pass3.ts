// Pass 3, live on Zcash testnet: the agent path. An agent (a real MCP client over stdio) calls
// quote and submit_intent on pqi-mcp; submit_intent signs a new intent E with the agent's own
// ML-DSA-65 key, delivers it to a new receive address of the receive key, saves it, funds the escrow
// from the demo user wallet and posts the sealed envelope to a live desk over HTTP (serve.ts,
// PQI_STATE=.demo/run-state.json: the same solver, verifier key and log as the Oct 20 run and pass 2).
// The desk runs with PQI_TEST_CRASH_AT=deliver-after-broadcast, so it is killed (SIGKILL) right after
// the solver's fill is broadcast; the restarted desk finds the fill in the solver's history by its
// memo, does not send it again, and settles. Then a third anchor (naming pass 2's), verify_log
// through MCP and check-anchors with the escrow pinned.
// Resumable: state in .demo/pass3-state.json. Writes deployments/testnet-pass3.json.
//   pnpm --filter @pqi/mcp pass3
// Seeds and the agent's key stay in .demo (gitignored, mode 0600); nothing secret is printed.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bytesToHex, checkAnchors, findEquivocation, fromB64, hexToBytes, kemKeyFromSeed, keyId, memo, OCT20_LEGACY_ANCHOR, randomBytes, signingKeyFromSeed, toB64, verifyLog, type LogEntry } from '@pqi/protocol';
import { anchorHistory, chainTip, MIN_CONFIRMATIONS, owns, scan, sentWithMemo, Verifier, zingoConfig, type BoardItem, type VerifierState } from '@pqi/node';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO = resolve(ROOT, '.demo');
const W = (n: string) => resolve(DEMO, 'wallets', n);
const RUN = JSON.parse(readFileSync(resolve(DEMO, 'run-state.json'), 'utf8'));
const OCT20 = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet.json'), 'utf8'));
const PASS2 = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet-pass2.json'), 'utf8'));
const STATE = resolve(DEMO, 'pass3-state.json');
const AGENT = resolve(DEMO, 'pass3-agent.json');
const DESK_LOG = resolve(DEMO, 'pass3-desk.log');
const PORT = process.env.PASS3_PORT ?? '8447';
const PUBLISHED_PORT = process.env.PASS3_PUBLISHED_PORT ?? '8448';
const PAY = 40_000;
const OUT = 20_000;
const cfg = zingoConfig();

type State = Record<string, any>;
const st: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 2), { mode: 0o600 });
const say = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const verifierKey = signingKeyFromSeed(hexToBytes(RUN.seeds.verifier));
const solverSign = signingKeyFromSeed(hexToBytes(RUN.seeds.solverSign));
const solverKem = kemKeyFromSeed(hexToBytes(RUN.seeds.solverKem));

// The agent: its own ML-DSA-65 key (new for pass 3), the demo user wallet to fund from, the
// published receive key (each intent gets a new address of it), refunds to the user address.
st.agentSeed ??= bytesToHex(randomBytes(32));
save();
const agentKey = signingKeyFromSeed(hexToBytes(st.agentSeed));
writeFileSync(AGENT, JSON.stringify({ ml_dsa_seed: st.agentSeed, wallet: W('user'), receive_ua: RUN.addr.receive, receive_uivk: RUN.uivk.receive, refund_ua: RUN.addr.user, trust: { escrow: RUN.addr.escrow, solver_kem: keyId(solverKem.publicKey) } }), { mode: 0o600 });

/** The live desk (serve.ts) in a process of its own; `crash` sets PQI_TEST_CRASH_AT. */
function startDesk(env: Record<string, string>): Promise<ChildProcess> {
  const p = spawn(process.execPath, ['--import', 'tsx', resolve(ROOT, 'packages/node/src/serve.ts')], { cwd: resolve(ROOT, 'packages/node'), env: { ...process.env, PQI_PORT: PORT, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (b: Buffer) => {
    for (const line of String(b).split('\n').filter(Boolean)) {
      appendFileSync(DESK_LOG, `${new Date().toISOString()} [${p.pid}] ${line}\n`);
      say(`  [desk] ${line}`);
      (st.deskLines ??= []).push(line);
    }
  };
  p.stdout!.on('data', out);
  p.stderr!.on('data', out);
  return new Promise((ok, fail) => {
    p.stdout!.on('data', (b) => String(b).includes('pqi desk on') && ok(p));
    p.on('exit', (c, s) => fail(new Error(`desk exited before listening (${c ?? s})`)));
  });
}

async function mcp(env: Record<string, string>): Promise<Client> {
  const c = new Client({ name: 'pass3-agent', version: '0.1.0' });
  const base = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PQI_VERIFIER_ID: keyId(verifierKey.publicKey), PQI_ANCHOR_UIVK: RUN.uivk.anchor, PQI_MCP_LOG: resolve(DEMO, 'pass3-mcp.log'), ...(process.env.PQI_ZINGO_CLI ? { PQI_ZINGO_CLI: process.env.PQI_ZINGO_CLI } : {}) };
  await c.connect(new StdioClientTransport({ command: resolve(ROOT, 'packages/mcp/node_modules/.bin/tsx'), args: [resolve(ROOT, 'packages/mcp/src/main.ts')], env: { ...base, ...env } }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

async function mined(uivk: string, txid: string, label: string) {
  for (let i = 0; i < 120; i++) {
    const r = await scan(uivk, txid, 0, undefined);
    if (r.confirmations >= MIN_CONFIRMATIONS) return r;
    if (i % 4 === 0) say(`  … ${label} ${txid.slice(0, 10)} ${r.found ? `${r.confirmations} of ${MIN_CONFIRMATIONS} confirmations` : 'not seen yet'}`);
    await sleep(20_000);
  }
  throw new Error(`${label} ${txid} not ${MIN_CONFIRMATIONS} blocks deep after 40 minutes`);
}

async function main() {
  const deskEnv = { PQI_STATE: resolve(DEMO, 'run-state.json') };
  let desk: ChildProcess | null = null;
  const stopDesk = () => {
    if (desk && desk.exitCode === null && desk.signalCode === null) desk.kill('SIGTERM');
    desk = null;
  };
  process.on('exit', stopDesk);
  try {
    // ---- the agent submits E through MCP to the live desk (killed after the fill broadcast) ----
    if (!st.submit) {
      desk = await startDesk({ ...deskEnv, PQI_TEST_CRASH_AT: 'deliver-after-broadcast' });
      const agent = await mcp({ PQI_DESK_URL: `http://127.0.0.1:${PORT}`, PQI_AGENT_FILE: AGENT });
      st.tools = (await agent.listTools()).tools.map((t) => t.name).sort();
      st.quote = await call(agent, 'quote', { pay_zat: PAY, min_out_zat: OUT });
      say(`quote: ${JSON.stringify(st.quote)}`);
      st.submit = await call(agent, 'submit_intent', { pay_zat: PAY, min_out_zat: OUT, deadline_blocks: 80 });
      save();
      await agent.close();
      say(`submit_intent: ${JSON.stringify(st.submit)}`);
    }
    const H: string = st.submit.intent_hash;
    const used = [...Object.values(OCT20.intents).map((i: any) => i.signed.intent.receive_ua), PASS2.intent.signed.intent.receive_ua];
    if (used.includes(st.submit.receive_ua)) throw new Error('E was delivered to an address an earlier intent used');

    // ---- the desk works E: funding depth, quote, delivery (killed after the broadcast), restart ----
    const boardItem = () => (JSON.parse(readFileSync(resolve(DEMO, 'board.json'), 'utf8')) as BoardItem[]).find((i) => i.hash === H);
    const recordCrash = () => {
      const item = boardItem()!;
      st.crash = { point: 'deliver-after-broadcast', signal: 'SIGKILL', at: new Date().toISOString(), board_after_kill: { stage: item.stage, fillTxid: item.fillTxid, delivering: item.delivering } };
      save();
      say(`desk killed after the fill broadcast; write-ahead record: ${JSON.stringify(item.delivering)}`);
    };
    // A kill in an earlier run of this script: the board shows the write-ahead record and no fill.
    if (!st.crash && !desk && boardItem()?.delivering && !boardItem()?.fillTxid) recordCrash();
    const agent = await mcp({ PQI_DESK_URL: `http://127.0.0.1:${PORT}`, PQI_AGENT_FILE: AGENT });
    for (let round = 0; round < 200; round++) {
      const d = desk as ChildProcess | null;
      if (d && d.signalCode === 'SIGKILL') {
        if (!st.crash) recordCrash();
        desk = null;
      } else if (d && (d.exitCode !== null || d.signalCode !== null)) throw new Error(`desk exited with ${d.exitCode ?? d.signalCode}`);
      if (!desk && !st.settled) desk = await startDesk(st.crash ? deskEnv : { ...deskEnv, PQI_TEST_CRASH_AT: 'deliver-after-broadcast' });
      let s: { stage: string; note: string | null };
      try {
        s = await call(agent, 'status', { intent_hash: H });
      } catch (e) {
        say(`status: ${(e as Error).message}`);
        await sleep(5_000);
        continue;
      }
      if (s.stage !== st.lastStage) say(`E: ${s.stage}${s.note ? ` (${s.note})` : ''}`);
      st.lastStage = s.stage;
      if (s.stage === 'settled') {
        st.settled = s;
        break;
      }
      if (['refunded', 'rejected', 'refund_refused', 'declined'].includes(s.stage)) throw new Error(`E ended ${s.stage}: ${s.note}`);
      save();
      await sleep(30_000);
    }
    if (!st.settled) throw new Error('E did not settle');
    await agent.close();
    stopDesk();
    await sleep(2_000);

    const vstate = JSON.parse(readFileSync(resolve(DEMO, 'verifier-state.json'), 'utf8')) as VerifierState;
    const board = JSON.parse(readFileSync(resolve(DEMO, 'board.json'), 'utf8')) as BoardItem[];
    const item = board.find((i) => i.hash === H)!;
    const settled = vstate.log.find((e) => e.status === 'SETTLED' && e.intent_hash === H)!;
    st.tx = { funding: st.submit.funding_txid, fill: item.fillTxid, release: settled.refs.release_txid };
    st.crash.restart = (st.deskLines as string[]).filter((l) => l.includes(H.slice(0, 12)) && /found in the solver's history|DELIVERY_UNRECONCILED/.test(l));
    save();

    // ---- a third anchor, naming pass 2's ----
    if (!st.anchor) {
      const v = new Verifier({ key: verifierKey, escrowWallet: W('escrow'), escrowUa: RUN.addr.escrow, escrowUivk: RUN.uivk.escrow, solvers: [keyId(solverSign.publicKey)], zingo: cfg, statePath: resolve(DEMO, 'verifier-state.json'), tip: chainTip });
      const a = await v.anchor(RUN.addr.anchor);
      st.anchor = { txid: a.txid, seq: a.seq, head: a.head, prev: a.prev, entry: a.entry.seq };
      save();
    }
    say(`anchor ${st.anchor.txid} of #${st.anchor.seq}, names ${st.anchor.prev.slice(0, 10)}`);
    await mined(RUN.uivk.anchor, st.anchor.txid, 'anchor');
    await mined(RUN.uivk.solver, st.tx.release, 'release');

    // ---- the evidence ----
    const log = (JSON.parse(readFileSync(resolve(DEMO, 'verifier-state.json'), 'utf8')) as VerifierState).log;
    const fillMemo = memo.fill(H, keyId(solverSign.publicKey));
    const fillSends = await sentWithMemo(cfg, W('solver'), fillMemo);
    const releaseSends = await sentWithMemo(cfg, W('escrow'), memo.release(H));
    const history = await anchorHistory(cfg, W('escrow'));
    const anchors = checkAnchors(log, history, { legacyRoots: [OCT20_LEGACY_ANCHOR] });
    const full = verifyLog(log, verifierKey.publicKey);
    const extendsPass2 = findEquivocation(PASS2.log, log, verifierKey.publicKey) === null && log.length > PASS2.log.length;
    const fillSeen = await scan(RUN.uivk.receive, st.tx.fill, OUT, fillMemo);
    const fundingSeen = await scan(RUN.uivk.escrow, st.tx.funding, PAY, memo.funding(H));
    const releaseSeen = await scan(RUN.uivk.solver, st.tx.release, PAY - 15_000, memo.release(H));
    const anchorSeen = await scan(RUN.uivk.anchor, st.anchor.txid, 1, memo.anchor(st.anchor.seq, st.anchor.head, st.anchor.prev));
    const receiveOwned = await owns(RUN.uivk.receive, st.submit.receive_ua);
    const signed = JSON.parse(readFileSync(`${AGENT}.pending.json`, 'utf8'))[H];
    say(`log ${full.entries} verifies ${full.ok}, extends pass 2 ${extendsPass2}; anchors ${anchors.ok} (${anchors.chain.length} in one chain); fill sends ${fillSends.length}, release sends ${releaseSends.length}; funding ${fundingSeen.ok}, fill ${fillSeen.ok}, release ${releaseSeen.ok}, anchor memo ${anchorSeen.ok}; receive address covered ${receiveOwned.covered}`);
    if (!full.ok || !extendsPass2 || !anchors.ok || fillSends.length !== 1 || releaseSends.length !== 1 || !fundingSeen.ok || !fillSeen.ok || !releaseSeen.ok || !anchorSeen.ok || !receiveOwned.pay_to) throw new Error('final checks failed');
    st.crash.solver_sends_with_fill_memo = fillSends.map((t) => t.txid);
    st.crash.escrow_sends_with_release_memo = releaseSends.map((t) => t.txid);
    save();

    const record = (checks: Record<string, unknown>) => ({
      network: 'zcash-testnet',
      ranAt: new Date().toISOString(),
      note: 'Pass 3 (Oct 22): the agent path. An MCP client called submit_intent on pqi-mcp, which signed intent E with the agent’s own ML-DSA-65 key, used a new receive address of the receive key, saved the intent, funded the escrow and posted the envelope to a live desk over HTTP. The desk was killed (SIGKILL) right after the solver’s fill broadcast; the restarted desk found the fill in the solver’s history by its memo and did not send it again. Same verifier key, solver and escrow as deployments/testnet.json; the log continues from pass 2’s entry 12.',
      wallets: OCT20.wallets,
      keys: { ...OCT20.keys, agent: { scheme: 'ML-DSA-65', id: keyId(agentKey.publicKey), pk: toB64(agentKey.publicKey) } },
      agent: { mcp_tools: st.tools, quote: st.quote, submit_intent: st.submit, receive_ua: st.submit.receive_ua, receive_index: st.submit.receive_index, receive_ua_covered_by_receive_uivk: receiveOwned.covered, addresses_used_before: used },
      intent: { hash: H, signed: signed.signed, envelope: signed.envelope, claim: item.claim },
      txs: { funding: st.tx.funding, fill: st.tx.fill, release: st.tx.release, anchor: st.anchor.txid, previousAnchor: st.anchor.prev },
      crash: st.crash,
      anchors: { escrowHistory: history, check: anchors },
      checks: { logVerifies: full.ok, extendsPass2Log: extendsPass2, fundingSeen: fundingSeen.ok, fillSeen: fillSeen.ok, releaseSeen: releaseSeen.ok, anchorMemoSeen: anchorSeen.ok, ...checks },
      log,
    });
    const out = resolve(ROOT, 'deployments/testnet-pass3.json');
    writeFileSync(out, JSON.stringify(record({}), null, 2) + '\n');

    // ---- verify_log through MCP against a desk serving this record, and check-anchors with pins ----
    const pub = spawn(process.execPath, ['--import', 'tsx', resolve(ROOT, 'packages/node/src/serve.ts')], { cwd: resolve(ROOT, 'packages/node'), env: { ...process.env, PQI_PUBLISHED: out, PQI_PORT: PUBLISHED_PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((ok, fail) => {
      pub.stdout!.on('data', (b) => String(b).includes('pqi desk on') && ok());
      pub.on('exit', (c) => fail(new Error(`published desk exited ${c}`)));
    });
    try {
      const auditor = await mcp({ PQI_DESK_URL: `http://127.0.0.1:${PUBLISHED_PORT}` });
      st.verify_log = await call(auditor, 'verify_log');
      await auditor.close();
    } finally {
      pub.kill('SIGTERM');
    }
    const ca = spawnSync(process.execPath, ['--import', 'tsx', resolve(ROOT, 'packages/node/src/check-anchors.ts'), out], { cwd: resolve(ROOT, 'packages/node'), env: { ...process.env, PQI_VERIFIER_ID: keyId(verifierKey.publicKey), PQI_ESCROW_UA: RUN.addr.escrow }, encoding: 'utf8', timeout: 900_000 });
    st.check_anchors = { exit: ca.status, result: ca.status === 0 || ca.status === 1 ? JSON.parse(ca.stdout) : ca.stderr.trim() };
    save();
    say(`verify_log ok ${st.verify_log.ok} (${st.verify_log.entries} entries, ${st.verify_log.anchor?.anchors} anchors); check-anchors exit ${st.check_anchors.exit}`);
    if (!st.verify_log.ok || st.check_anchors.exit !== 0) throw new Error('verify_log or check-anchors failed');
    writeFileSync(out, JSON.stringify(record({ verify_log: st.verify_log, check_anchors: { exit: st.check_anchors.exit, ok: st.check_anchors.result.ok, chain: st.check_anchors.result.chain, problems: st.check_anchors.result.problems } }), null, 2) + '\n');
    say('wrote deployments/testnet-pass3.json');
  } finally {
    stopDesk();
  }
}

main().then(
  () => process.exit(0),
  (e: Error) => {
    console.error(`FAILED: ${e.message}`);
    process.exit(1);
  },
);
