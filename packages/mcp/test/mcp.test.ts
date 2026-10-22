// Real MCP client ↔ pqi-mcp (stdio) ↔ a desk serving the published record over HTTP ↔ live testnet
// (the anchor memo is re-read through lightwalletd).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendEntry, bytesToHex, hexToBytes, kemKeyFromSeed, keyId, newSigningKey, randomBytes, toB64, type LogEntry } from '@pqi/protocol';
import { owns, scanBinary } from '@pqi/node';

const ROOT = resolve(__dirname, '../../..');
const d = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet.json'), 'utf8'));
const PORT = '8414';
const FORGED_PORT = '8415';
const NO_UIVK_PORT = '8416';
const LIVE_PORT = '8417';
let desk: ChildProcess;
let forgedDesk: ChildProcess;
let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}, c = client) => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError, text: r.content[0].text };
};
const connect = async (extra: Record<string, string>) => {
  const c = new Client({ name: 't', version: '0' });
  await c.connect(new StdioClientTransport({ command: resolve(__dirname, '../node_modules/.bin/tsx'), args: [resolve(__dirname, '../src/main.ts')], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PQI_SCAN_BIN: scanBinary(), PQI_VERIFIER_ID: d.keys.verifier.id, PQI_ANCHOR_UIVK: d.wallets.anchor.uivk, ...(process.env.PQI_ZINGO_CLI ? { PQI_ZINGO_CLI: process.env.PQI_ZINGO_CLI } : {}), ...extra } }));
  return c;
};
const serve = async (record: string | null, port: string, env: Record<string, string> = {}) => {
  const p = spawn(resolve(ROOT, 'packages/node/node_modules/.bin/tsx'), [resolve(ROOT, 'packages/node/src/serve.ts')], { env: { ...process.env, ...(record ? { PQI_PUBLISHED: record } : {}), PQI_PORT: port, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((ok, fail) => {
    p.stdout!.on('data', (b) => String(b).includes('pqi desk on') && ok());
    p.on('exit', (c) => fail(new Error(`desk exited ${c}`)));
  });
  return p;
};

/** The published record with every entry re-signed by a key the desk made up (and A's settlement
 *  turned into a refund): internally consistent, but not the verifier's log. */
function forgedRecord(): string {
  const forger = newSigningKey();
  const log: LogEntry[] = [];
  for (const e of d.log as LogEntry[]) appendEntry(log, forger, { status: e.seq === 0 ? 'REFUNDED' : e.status, intent_hash: e.intent_hash, reason: e.reason, refs: e.refs, at_height: e.at_height });
  const path = join(mkdtempSync(join(tmpdir(), 'pqi-forged-')), 'testnet.json');
  writeFileSync(path, JSON.stringify({ ...d, keys: { ...d.keys, verifier: { scheme: 'ML-DSA-65', id: keyId(forger.publicKey), pk: toB64(forger.publicKey) } }, log }));
  return path;
}

beforeAll(async () => {
  desk = await serve(resolve(ROOT, 'deployments/testnet.json'), PORT);
  forgedDesk = await serve(forgedRecord(), FORGED_PORT);
  client = await connect({ PQI_DESK_URL: `http://127.0.0.1:${PORT}` });
});
afterAll(async () => {
  await client?.close();
  desk?.kill();
  forgedDesk?.kill();
});

describe('pqi-mcp', () => {
  it('lists quote, resubmit, status, submit_intent, verify_log', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['quote', 'resubmit', 'status', 'submit_intent', 'verify_log']);
  });

  it('verify_log: every signature and link verifies, and the anchor memo is on-chain and matches', async () => {
    const r = JSON.parse((await call('verify_log')).text);
    expect(r).toMatchObject({ ok: true, entries: 10, counts: { SETTLED: 2, REJECTED: 6, REFUNDED: 1, ANCHORED: 1 }, verifier: d.keys.verifier.id });
    expect(r.anchor).toMatchObject({ txid: d.anchor.txid, memo_on_chain: true, anchored_head_matches_log: true, anchored_through: 8, entries_after_anchor: 1, anchors: 1, chain_links: true });
    // What it cannot see is said: a log cut short before the newest anchors is check-anchors' job.
    expect(r.anchor.truncation).toMatch(/^not detectable here: .* check-anchors <desk URL> fails it \(LOG_BEHIND_ANCHORS\)$/);
    expect((await client.listTools()).tools.find((t) => t.name === 'verify_log')!.description).toMatch(/cannot tell whether the desk cut its log short/);
  });

  it('verify_log: a desk serving a log signed by a key other than the pinned one fails; no pin is Setup required', async () => {
    const c = await connect({ PQI_DESK_URL: `http://127.0.0.1:${FORGED_PORT}` });
    const r = JSON.parse((await call('verify_log', {}, c)).text);
    expect(r.ok).toBe(false);
    expect(r.error.problem).toMatch(/not the pinned/);
    const unpinned = await connect({ PQI_DESK_URL: `http://127.0.0.1:${PORT}`, PQI_VERIFIER_ID: '' });
    expect(await call('verify_log', {}, unpinned)).toMatchObject({ isError: true, text: expect.stringMatching(/^Setup required: PQI_VERIFIER_ID/) });
    await Promise.all([c.close(), unpinned.close()]);
  });

  it('verify_log reads the anchor memos only with the anchor key you pinned: unpinned is Setup required, even when the desk serves no key at all', async () => {
    const noKey = join(mkdtempSync(join(tmpdir(), 'pqi-nokey-')), 'testnet.json');
    writeFileSync(noKey, JSON.stringify({ ...d, wallets: { ...d.wallets, anchor: { address: d.wallets.anchor.address } } }));
    const p = await serve(noKey, NO_UIVK_PORT);
    try {
      const unpinned = await connect({ PQI_DESK_URL: `http://127.0.0.1:${NO_UIVK_PORT}`, PQI_ANCHOR_UIVK: '' });
      expect(await call('verify_log', {}, unpinned)).toMatchObject({ isError: true, text: 'Setup required: PQI_ANCHOR_UIVK (the log has 1 anchor(s); their memos are read with the anchor viewing key you trust, not one the desk serves)' });
      const pinned = await connect({ PQI_DESK_URL: `http://127.0.0.1:${NO_UIVK_PORT}` });
      const r = JSON.parse((await call('verify_log', {}, pinned)).text);
      expect(r).toMatchObject({ ok: true, anchor: { txid: d.anchor.txid, memo_on_chain: true, anchors: 1 } });
      await Promise.all([unpinned.close(), pinned.close()]);
    } finally {
      p.kill();
    }
  });

  it('submit_intent needs at least 10 blocks before the deadline (3 funding confirmations, the solver’s 3-block margin, latency)', async () => {
    const r = await client.callTool({ name: 'submit_intent', arguments: { pay_zat: 60_000, min_out_zat: 40_000, deadline_blocks: 6 } }).then((x) => (x as { content: { text: string }[] }).content[0].text, (e: Error) => e.message);
    expect(r).toMatch(/deadline_blocks/);
    expect(r).toMatch(/10/);
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === 'submit_intent')!.description).toMatch(/15,000 zat fee budget/);
    expect(tools.find((t) => t.name === 'quote')!.description).toMatch(/keeps on a refund too/);
  });

  it('submit_intent saves the signed intent and envelope before paying; a payment whose outcome is unknown says so (not "nothing was paid"), and resubmit looks the funding up by memo, then posts a funded one to a live desk', async () => {
    // A live desk (PQI_STATE) with throwaway keys and no wallets: it accepts envelopes, it can pay nothing.
    const dir = mkdtempSync(join(tmpdir(), 'pqi-live-'));
    const seeds = { verifier: bytesToHex(randomBytes(32)), solverSign: bytesToHex(randomBytes(32)), solverKem: bytesToHex(randomBytes(64)) };
    const kemId = keyId(kemKeyFromSeed(hexToBytes(seeds.solverKem)).publicKey);
    writeFileSync(join(dir, 'run-state.json'), JSON.stringify({ seeds, addr: { escrow: d.wallets.escrow.address, solver: d.wallets.solver.address, anchor: d.wallets.anchor.address }, uivk: { escrow: d.wallets.escrow.uivk, anchor: d.wallets.anchor.uivk } }), { mode: 0o600 });
    const live = await serve(null, LIVE_PORT, { PQI_STATE: join(dir, 'run-state.json') });
    try {
      const agentFile = join(dir, 'agent.json');
      writeFileSync(agentFile, JSON.stringify({ ml_dsa_seed: bytesToHex(randomBytes(32)), wallet: '/nonexistent/agent-wallet', receive_ua: d.wallets.receive.address, receive_uivk: d.wallets.receive.uivk, refund_ua: d.wallets.user.address, trust: { escrow: d.wallets.escrow.address, solver_kem: kemId } }));
      const c = await connect({ PQI_DESK_URL: `http://127.0.0.1:${LIVE_PORT}`, PQI_AGENT_FILE: agentFile });
      const r = await call('submit_intent', { pay_zat: 60_000, min_out_zat: 40_000, deadline_blocks: 20 }, c);
      expect(r.isError).toBe(true);
      const err = JSON.parse(r.text);
      // zingo-cli failed on a wallet it cannot open: not one of the failures that prove nothing was
      // broadcast, so the funding is looked up by its memo, and that history cannot be read either.
      expect(err).toMatchObject({ error: expect.stringMatching(/^zingo-cli quicksend failed/), intent_hash: expect.stringMatching(/^[0-9a-f]{64}$/), funding_txid: null, envelope: { to: kemId }, pending_file: `${agentFile}.pending.json`, next: expect.stringMatching(/^outcome unknown: the funding may have been broadcast and the wallet history cannot be read \(zingo-cli value_transfers failed/) });
      expect(err.next).toMatch(/call resubmit with this intent_hash, which looks the funding up by its memo before posting$/);
      expect(err.envelope.intent_hash).toBe(err.intent_hash);
      const file = `${agentFile}.pending.json`;
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      expect(saved[err.intent_hash]).toMatchObject({ funding_txid: null, funding_outcome: 'unknown', wallet: '/nonexistent/agent-wallet', posted: false, receive_index: expect.any(Number), signed: { intent: { escrow: d.wallets.escrow.address, receive_uivk: d.wallets.receive.uivk } }, error: expect.stringMatching(/^zingo-cli quicksend failed/) });
      // A receive address of its own: not the run's shared one, and one the receive key derives.
      const fresh = saved[err.intent_hash].signed.intent.receive_ua as string;
      expect(fresh).not.toBe(d.wallets.receive.address);
      expect((await owns(d.wallets.receive.uivk, fresh)).covered).toEqual(['orchard']);
      expect(await call('resubmit', { intent_hash: err.intent_hash }, c)).toMatchObject({ isError: true, text: expect.stringMatching(/^funding outcome unknown for [0-9a-f]{64}: no funding txid was recorded and the wallet history cannot be read \(zingo-cli value_transfers failed.*nothing was posted$/) });

      // No zingo-cli at all: nothing can have been sent, and the error says so.
      const noCli = await connect({ PQI_DESK_URL: `http://127.0.0.1:${LIVE_PORT}`, PQI_AGENT_FILE: agentFile, PQI_ZINGO_CLI: '/nonexistent/zingo-cli' });
      const none = JSON.parse((await call('submit_intent', { pay_zat: 60_000, min_out_zat: 40_000, deadline_blocks: 20 }, noCli)).text);
      expect(none).toMatchObject({ error: expect.stringMatching(/^Setup required: PQI_ZINGO_CLI/), funding_txid: null, next: 'nothing was paid' });
      await noCli.close();

      // A receive address the agent's receive key does not derive (the anchor wallet's) is refused
      // before anything is signed, saved or paid: the solver would decline it after the funding.
      const before = Object.keys(JSON.parse(readFileSync(`${agentFile}.pending.json`, 'utf8'))).length;
      const other = await call('submit_intent', { pay_zat: 60_000, min_out_zat: 40_000, deadline_blocks: 20, receive_ua: d.wallets.anchor.address }, c);
      expect(other).toMatchObject({ isError: true, text: `RECEIVE_KEY_MISMATCH: refused before signing or paying: ${d.wallets.anchor.address} is not an address of the agent's receive_uivk, so the solver would decline it after the funding; nothing was paid` });
      expect(Object.keys(JSON.parse(readFileSync(`${agentFile}.pending.json`, 'utf8')))).toHaveLength(before);

      // As if the payment had gone out and then the desk had refused: the saved record now has a
      // funding txid, and resubmit posts the same envelope; the desk takes it.
      const FUND = bytesToHex(randomBytes(32));
      writeFileSync(file, JSON.stringify({ ...saved, [err.intent_hash]: { ...saved[err.intent_hash], funding_txid: FUND } }), { mode: 0o600 });
      const again = JSON.parse((await call('resubmit', { intent_hash: err.intent_hash }, c)).text);
      expect(again).toMatchObject({ intent_hash: err.intent_hash, funding_txid: FUND, desk: { hash: err.intent_hash, stage: 'received' } });
      expect(JSON.parse((await call('status', { intent_hash: err.intent_hash }, c)).text)).toMatchObject({ stage: 'received', funding_txid: FUND });
      expect(JSON.parse(readFileSync(file, 'utf8'))[err.intent_hash].posted).toBe(true);
      await c.close();
    } finally {
      live.kill();
    }
  });

  it('status and quote from the desk', async () => {
    const a = JSON.parse((await call('status', { intent_hash: d.intents.A.hash })).text);
    expect(a.stage).toBe('settled');
    expect(a.log[0].refs.release_txid).toMatch(/^[0-9a-f]{64}$/);
    const c = JSON.parse((await call('status', { intent_hash: d.intents.C.hash })).text);
    expect(c.log.map((e: { status: string; reason: string | null }) => e.reason ?? e.status)).toEqual(['FILL_NOT_CREDITED:MEMO_MISMATCH+AMOUNT_TOO_LOW', 'EXPIRED', 'REFUNDED']);
    expect(JSON.parse((await call('quote', { pay_zat: 60_000, min_out_zat: 40_000 })).text)).toMatchObject({ accept: true, fee_zat: 20_000, refund_if_unfilled_zat: 45_000 });
    expect(JSON.parse((await call('quote', { pay_zat: 50_000, min_out_zat: 40_000 })).text).accept).toBe(false);
  });

  it('submit_intent: Setup required without an agent identity or trust pins; a desk whose escrow is not the pinned one is refused before signing or paying', async () => {
    expect(await call('submit_intent', { pay_zat: 60_000, min_out_zat: 40_000, deadline_blocks: 20 })).toMatchObject({ isError: true, text: 'Setup required: PQI_AGENT_FILE' });
    const dir = mkdtempSync(join(tmpdir(), 'pqi-agent-'));
    const agent = (trust?: object) => {
      const f = join(dir, `agent-${Math.random().toString(36).slice(2)}.json`);
      // A throwaway identity: a random test seed and a wallet path that does not exist.
      writeFileSync(f, JSON.stringify({ ml_dsa_seed: '11'.repeat(32), wallet: '/nonexistent/agent-wallet', receive_ua: d.wallets.receive.address, receive_uivk: d.wallets.receive.uivk, refund_ua: d.wallets.user.address, ...(trust ? { trust } : {}) }));
      return f;
    };
    const noTrust = await connect({ PQI_DESK_URL: `http://127.0.0.1:${PORT}`, PQI_AGENT_FILE: agent() });
    expect((await call('submit_intent', { pay_zat: 60_000, min_out_zat: 40_000, deadline_blocks: 20 }, noTrust)).text).toMatch(/^Setup required: PQI_AGENT_FILE trust/);
    const wrong = await connect({ PQI_DESK_URL: `http://127.0.0.1:${PORT}`, PQI_AGENT_FILE: agent({ escrow: d.wallets.user.address, solver_kem: d.keys.solverKem.id }) });
    expect((await call('submit_intent', { pay_zat: 60_000, min_out_zat: 40_000, deadline_blocks: 20 }, wrong)).text).toMatch(/^refused before signing or paying: the desk's escrow .* is not the pinned/);
    const right = await connect({ PQI_DESK_URL: `http://127.0.0.1:${PORT}`, PQI_AGENT_FILE: agent({ escrow: d.wallets.escrow.address, solver_kem: d.keys.solverKem.id }) });
    expect((await call('submit_intent', { pay_zat: 60_000, min_out_zat: 40_000, deadline_blocks: 20 }, right)).text).toMatch(/the desk is published \(read-only\); it cannot accept intents/);
    await Promise.all([noTrust.close(), wrong.close(), right.close()]);
  });

  it('no desk: Setup required naming the URL', async () => {
    const c = await connect({ PQI_DESK_URL: 'http://127.0.0.1:9' });
    const r = await call('verify_log', {}, c);
    await c.close();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Setup required: PQI_DESK_URL/);
  });
});
