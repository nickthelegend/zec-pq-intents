// Real MCP client ↔ pqi-mcp (stdio) ↔ a desk serving the published record over HTTP ↔ live testnet
// (the anchor memo is re-read through lightwalletd).
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanBinary } from '@pqi/node';

const ROOT = resolve(__dirname, '../../..');
const d = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet.json'), 'utf8'));
const PORT = '8414';
let desk: ChildProcess;
let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}, c = client) => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError, text: r.content[0].text };
};
const connect = async (extra: Record<string, string>) => {
  const c = new Client({ name: 't', version: '0' });
  await c.connect(new StdioClientTransport({ command: resolve(__dirname, '../node_modules/.bin/tsx'), args: [resolve(__dirname, '../src/main.ts')], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PQI_SCAN_BIN: scanBinary(), ...extra } }));
  return c;
};

beforeAll(async () => {
  desk = spawn(resolve(ROOT, 'packages/node/node_modules/.bin/tsx'), [resolve(ROOT, 'packages/node/src/serve.ts')], { env: { ...process.env, PQI_PUBLISHED: resolve(ROOT, 'deployments/testnet.json'), PQI_PORT: PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((ok, fail) => {
    desk.stdout!.on('data', (b) => String(b).includes('pqi desk on') && ok());
    desk.on('exit', (c) => fail(new Error(`desk exited ${c}`)));
  });
  client = await connect({ PQI_DESK_URL: `http://127.0.0.1:${PORT}` });
});
afterAll(async () => {
  await client?.close();
  desk?.kill();
});

describe('pqi-mcp', () => {
  it('lists quote, submit_intent, status, verify_log', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['quote', 'status', 'submit_intent', 'verify_log']);
  });

  it('verify_log: every signature and link verifies, and the anchor memo is on-chain and matches', async () => {
    const r = JSON.parse((await call('verify_log')).text);
    expect(r).toMatchObject({ ok: true, entries: 10, counts: { SETTLED: 2, REJECTED: 6, REFUNDED: 1, ANCHORED: 1 }, verifier: d.keys.verifier.id });
    expect(r.anchor).toMatchObject({ txid: d.anchor.txid, memo_on_chain: true, anchored_head_matches_log: true });
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

  it('submit_intent: Setup required without an agent identity; a published desk refuses intents', async () => {
    const r = await call('submit_intent', { pay_zat: 60_000, min_out_zat: 40_000, deadline_blocks: 20 });
    expect(r).toMatchObject({ isError: true, text: 'Setup required: PQI_AGENT_FILE' });
  });

  it('no desk: Setup required naming the URL', async () => {
    const c = await connect({ PQI_DESK_URL: 'http://127.0.0.1:9' });
    const r = await call('verify_log', {}, c);
    await c.close();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Setup required: PQI_DESK_URL/);
  });
});
