// The desk (read-only, over the published records): reads are public and match the records,
// including pass 2's other-solver claim; writes are refused for non-JSON, oversize and malformed
// bodies, never offered to another origin, and otherwise answered "Setup required" (no wallet here).
// A desk started with neither record nor state exits 2 with Setup required.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DESK, DESK2, LANDING, expect, isMobile, oct20, pass2, root, test } from './fixtures';

const SETUP = 'Setup required: this desk serves a published record (PQI_PUBLISHED); run it with PQI_STATE to accept intents';
type E = { seq: number; status: string; reason: string | null; intent_hash: string | null; hash: string };

test.describe('desk API', () => {
  test.beforeEach(() => test.skip(isMobile(test.info().project.name), 'HTTP API: once, on the desktop project'));

  test('reads: info, log and every intent match the Oct 20 record (replay and expiry refused on testnet)', async ({ request }) => {
    const info = await (await request.get(`${DESK}/api/info`)).json();
    expect(info).toMatchObject({ mode: 'published (read-only)', verifier: { id: oct20.keys.verifier.id }, log_entries: oct20.log.length, min_fee_zat: '15000' });
    const { log } = await (await request.get(`${DESK}/api/log`)).json();
    expect(log.map((e: E) => e.hash)).toEqual(oct20.log.map((e: E) => e.hash));
    const stage = { A: 'settled', B: 'settled', C: 'refunded' } as Record<string, string>;
    for (const k of ['A', 'B', 'C']) {
      const s = await (await request.get(`${DESK}/api/intents/${oct20.intents[k].hash}`)).json();
      expect(s.stage, k).toBe(stage[k]);
    }
    const a = await (await request.get(`${DESK}/api/intents/${oct20.intents.A.hash}`)).json();
    expect(a.log.map((e: E) => e.reason)).toContain('ALREADY_SETTLED'); // A replayed after it settled
    const c = await (await request.get(`${DESK}/api/intents/${oct20.intents.C.hash}`)).json();
    expect(c.log.map((e: E) => e.reason)).toEqual(expect.arrayContaining(['EXPIRED', 'FILL_NOT_CREDITED:MEMO_MISMATCH+AMOUNT_TOO_LOW']));
    for (const reason of ['BAD_SIGNATURE', 'NONCE_REUSED', 'WRONG_KEY']) expect(log.some((e: E) => e.reason === reason), reason).toBe(true);
    const unknown = await (await request.get(`${DESK}/api/intents/${'0'.repeat(64)}`)).json();
    expect(unknown).toMatchObject({ stage: 'unknown', log: [] });
    expect((await request.get(`${DESK}/api/nothing`)).status()).toBe(404);
  });

  test('pass 2: intent D settled to the bound solver after a second solver’s claim was refused (FILL_BY_OTHER_SOLVER), log extends Oct 20', async ({ request }) => {
    const { log } = await (await request.get(`${DESK2}/api/log`)).json();
    expect(log.length).toBe(pass2.log.length);
    expect(log.slice(0, oct20.log.length).map((e: E) => e.hash)).toEqual(oct20.log.map((e: E) => e.hash));
    const d = await (await request.get(`${DESK2}/api/intents/${pass2.intent.hash}`)).json();
    expect(d.stage).toBe('settled');
    expect(d.log.map((e: E) => [e.seq, e.status, e.reason])).toEqual([[10, 'REJECTED', 'FILL_BY_OTHER_SOLVER'], [11, 'SETTLED', null]]);
    expect(log[12]).toMatchObject({ status: 'ANCHORED', refs: { prev_anchor_txid: pass2.txs.previousAnchor, anchor_txid: pass2.txs.anchor } });
  });

  test('writes: non-JSON 415, oversize 413, malformed 400, JSON 503 Setup required; none carries a CORS header', async ({ request }) => {
    for (const path of ['/api/intents', '/api/tick']) {
      const plain = await request.post(`${DESK}${path}`, { headers: { 'content-type': 'text/plain' }, data: '{}' });
      expect(plain.status()).toBe(415);
      expect(await plain.json()).toEqual({ error: 'POST bodies must be application/json' });
      const form = await request.post(`${DESK}${path}`, { form: { envelope: 'x' } });
      expect(form.status()).toBe(415);
      const big = await request.post(`${DESK}${path}`, { headers: { 'content-type': 'application/json' }, data: JSON.stringify({ pad: 'a'.repeat(70_000) }) }).catch((e: Error) => e);
      expect(big instanceof Error ? big.message : big.status()).toBe(413);
      const bad = await request.post(`${DESK}${path}`, { headers: { 'content-type': 'application/json' }, data: Buffer.from('{not json') });
      expect(bad.status()).toBe(400);
      const ok = await request.post(`${DESK}${path}`, { headers: { 'content-type': 'application/json', origin: 'http://evil.test' }, data: { envelope: {} } });
      expect(ok.status()).toBe(503);
      expect(await ok.json()).toEqual({ error: SETUP });
      for (const r of [plain, form, bad, ok]) expect(r.headers()['access-control-allow-origin'], `${path} ${r.status()}`).toBeUndefined();
    }
    const pre = await request.fetch(`${DESK}/api/intents`, { method: 'OPTIONS', headers: { origin: 'http://evil.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect(pre.headers()['access-control-allow-origin']).toBeUndefined();
    expect((await request.post(`${DESK}/api/info`, { headers: { 'content-type': 'application/json' }, data: {} })).status()).toBe(404);
    expect((await request.get(`${DESK}/api/log`)).headers()['access-control-allow-origin']).toBe('*');
  });

  test('Setup required: a desk with neither PQI_STATE nor PQI_PUBLISHED exits 2 and says so', () => {
    const env = { ...process.env, PQI_STATE: '', PQI_PUBLISHED: '', PQI_PORT: '8499' };
    delete (env as Record<string, string | undefined>).PQI_STATE;
    delete (env as Record<string, string | undefined>).PQI_PUBLISHED;
    const r = spawnSync(resolve(root, 'packages/node/node_modules/.bin/tsx'), [resolve(root, 'packages/node/src/serve.ts')], { env, encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe('Setup required: PQI_STATE or PQI_PUBLISHED');
    const missing = spawnSync(resolve(root, 'packages/node/node_modules/.bin/tsx'), [resolve(root, 'packages/node/src/serve.ts')], { env: { ...env, PQI_PUBLISHED: resolve(root, 'deployments/none.json') }, encoding: 'utf8', timeout: 30_000 });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('Setup required');
  });
});

test.describe('desk from a browser page on another origin', () => {
  test('the landing’s origin can read the desk log (CORS open) but cannot write to it', async ({ page, health }) => {
    health.expectBlocked(`${DESK}/api/intents`); // the two writes below are meant to be blocked by CORS
    await page.goto(LANDING);
    const out = await page.evaluate(async (desk) => {
      const read = await fetch(`${desk}/api/log`).then((r) => r.json()).then((j) => j.log.length, (e: Error) => `read failed: ${e.message}`);
      const jsonWrite = await fetch(`${desk}/api/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => `answered ${r.status}`, (e: Error) => `blocked: ${e.name}`);
      const simpleWrite = await fetch(`${desk}/api/intents`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }).then((r) => `answered ${r.status}`, (e: Error) => `blocked: ${e.name}`);
      return { read, jsonWrite, simpleWrite };
    }, DESK);
    expect(out.read).toBe(oct20.log.length);
    expect(out.jsonWrite).toBe('blocked: TypeError'); // preflight never approved
    expect(out.simpleWrite).toBe('blocked: TypeError'); // sent, refused 415, and the answer is not readable cross-origin
  });
});
