// Real MCP client ↔ pqi-mcp (stdio) ↔ a desk serving the published record over HTTP ↔ live testnet
// (the anchor memo is re-read through lightwalletd).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendEntry, keyId, newSigningKey, toB64, type LogEntry } from '@pqi/protocol';
import { scanBinary } from '@pqi/node';

const ROOT = resolve(__dirname, '../../..');
const d = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet.json'), 'utf8'));
const PORT = '8414';
const FORGED_PORT = '8415';
let desk: ChildProcess;
let forgedDesk: ChildProcess;
let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}, c = client) => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError, text: r.content[0].text };
};
const connect = async (extra: Record<string, string>) => {
  const c = new Client({ name: 't', version: '0' });
  await c.connect(new StdioClientTransport({ command: resolve(__dirname, '../node_modules/.bin/tsx'), args: [resolve(__dirname, '../src/main.ts')], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PQI_SCAN_BIN: scanBinary(), PQI_VERIFIER_ID: d.keys.verifier.id, ...extra } }));
  return c;
};
const serve = async (record: string, port: string) => {
  const p = spawn(resolve(ROOT, 'packages/node/node_modules/.bin/tsx'), [resolve(ROOT, 'packages/node/src/serve.ts')], { env: { ...process.env, PQI_PUBLISHED: record, PQI_PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
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
  it('lists quote, submit_intent, status, verify_log', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['quote', 'status', 'submit_intent', 'verify_log']);
  });

  it('verify_log: every signature and link verifies, and the anchor memo is on-chain and matches', async () => {
    const r = JSON.parse((await call('verify_log')).text);
    expect(r).toMatchObject({ ok: true, entries: 10, counts: { SETTLED: 2, REJECTED: 6, REFUNDED: 1, ANCHORED: 1 }, verifier: d.keys.verifier.id });
    expect(r.anchor).toMatchObject({ txid: d.anchor.txid, memo_on_chain: true, anchored_head_matches_log: true, anchored_through: 8, entries_after_anchor: 1 });
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

  it('status and quote from the desk', async () => {
    const a = JSON.parse((await call('status', { intent_hash: d.intents.A.hash })).text);
    expect(a.stage).toBe('settled');
    expect(a.log[0].refs.release_txid).toMatch(/^[0-9a-f]{64}$/);
    const c = JSON.parse((await call('status', { intent_hash: d.intents.C.hash })).text);
    expect(c.log.map((e: { status: string; reason: string | null }) => e.reason ?? e.status)).toEqual(['FILL_NOT_CREDITED:MEMO_MISMATCH+AMOUNT_TOO_LOW', 'EXPIRED', 'REFUNDED']);
    expect(JSON.parse((await call('quote', { pay_zat: 60_000, min_out_zat: 40_000 })).text)).toMatchObject({ accept: true, fee_zat: 20_000 });
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
