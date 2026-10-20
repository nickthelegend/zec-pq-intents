#!/usr/bin/env node
// Desk HTTP server.
//   live:      PQI_STATE=.demo/run-state.json  (seeds, wallets) → solver + verifier act on the chain
//   published: PQI_PUBLISHED=deployments/testnet.json            → read-only: info, log, intent status
// Env: PQI_PORT (default 8404).
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { hexToBytes, kemKeyFromSeed, keyId, signingKeyFromSeed, toB64, type LogEntry } from '@pqi/protocol';
import { chainTip, SetupRequiredError } from './scan.js';
import { Desk, serveDesk } from './desk.js';
import { Solver } from './solver.js';
import { Verifier } from './verifier.js';
import { zingoConfig } from './zingo.js';

const port = Number(process.env.PQI_PORT ?? 8404);

function published(path: string) {
  const d = JSON.parse(readFileSync(path, 'utf8')) as { keys: Record<string, { id: string; pk: string }>; wallets: Record<string, { address: string; uivk?: string }>; log: LogEntry[] };
  const info = {
    mode: 'published (read-only)',
    escrow: d.wallets.escrow,
    anchor: d.wallets.anchor,
    solver: { ua: d.wallets.solver.address, sign: d.keys.solver, kem: d.keys.solverKem },
    verifier: d.keys.verifier,
    min_fee_zat: '15000',
  };
  const json = (res: import('node:http').ServerResponse, s: number, b: unknown) => res.writeHead(s, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(b));
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/api/info') return json(res, 200, { ...info, log_entries: d.log.length });
    if (url.pathname === '/api/log') return json(res, 200, { log: d.log });
    if (url.pathname.startsWith('/api/intents/')) {
      const h = url.pathname.split('/').pop();
      const entries = d.log.filter((e) => e.intent_hash === h);
      // An intent's stage is its outcome if it has one; later refusals (a replay) do not change it.
      const final = entries.find((e) => e.status === 'SETTLED' || e.status === 'REFUNDED');
      const stage = (final ?? entries[entries.length - 1])?.status.toLowerCase() ?? 'unknown';
      return json(res, 200, { hash: h, stage, log: entries });
    }
    if (req.method === 'POST') return json(res, 503, { error: 'Setup required: this desk serves a published record (PQI_PUBLISHED); run it with PQI_STATE to accept intents' });
    return json(res, 404, { error: 'not found' });
  });
}

function live(statePath: string) {
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  if (!st.seeds || !st.addr || !st.uivk) throw new SetupRequiredError('PQI_STATE', `${statePath} has no seeds/wallets (run the examples first)`);
  const demo = dirname(statePath);
  const cfg = zingoConfig();
  const vKey = signingKeyFromSeed(hexToBytes(st.seeds.verifier));
  const sKey = signingKeyFromSeed(hexToBytes(st.seeds.solverSign));
  const kKey = kemKeyFromSeed(hexToBytes(st.seeds.solverKem));
  const verifier = new Verifier({ key: vKey, escrowWallet: resolve(demo, 'wallets/escrow'), escrowUa: st.addr.escrow, escrowUivk: st.uivk.escrow, zingo: cfg, statePath: resolve(demo, 'verifier-state.json'), tip: chainTip });
  const solver = new Solver({ sign: sKey, kem: kKey, wallet: resolve(demo, 'wallets/solver'), ua: st.addr.solver, escrowUivk: st.uivk.escrow, zingo: cfg, minFeeZat: 15_000n });
  const info = {
    mode: 'live',
    escrow: { address: st.addr.escrow, uivk: st.uivk.escrow },
    anchor: { address: st.addr.anchor, uivk: st.uivk.anchor },
    solver: { ua: st.addr.solver, sign: { id: keyId(sKey.publicKey), pk: toB64(sKey.publicKey) }, kem: { id: keyId(kKey.publicKey), pk: toB64(kKey.publicKey) } },
    verifier: { id: keyId(vKey.publicKey), pk: toB64(vKey.publicKey) },
    min_fee_zat: '15000',
  };
  const desk = new Desk({ boardPath: resolve(demo, 'board.json'), solver, verifier, tip: chainTip, info });
  // Advance open intents every 30 s (one pass at a time).
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    desk
      .tick()
      .then((r) => r.forEach((x) => console.log(`${x.hash.slice(0, 12)} ${x.result}`)))
      .catch((e: Error) => console.error(`tick: ${e.message}`))
      .finally(() => (busy = false));
  }, 30_000);
  return serveDesk(desk);
}

try {
  const server = process.env.PQI_STATE ? live(process.env.PQI_STATE) : process.env.PQI_PUBLISHED && existsSync(process.env.PQI_PUBLISHED) ? published(process.env.PQI_PUBLISHED) : null;
  if (!server) throw new SetupRequiredError('PQI_STATE or PQI_PUBLISHED');
  server.listen(port, '127.0.0.1', () => console.log(`pqi desk on http://127.0.0.1:${port} (${process.env.PQI_STATE ? 'live' : 'published'})`));
} catch (e) {
  console.error((e as Error).message);
  process.exit(e instanceof SetupRequiredError ? 2 : 1);
}
