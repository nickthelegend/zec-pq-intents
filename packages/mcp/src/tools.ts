// MCP tools for agents trading with post-quantum signed intents.
//   PQI_DESK_URL     desk HTTP API (default http://127.0.0.1:8404)
//   PQI_AGENT_FILE   the agent's identity: {"ml_dsa_seed": hex, "wallet": zingo dir, "receive_ua", "receive_uivk", "refund_ua"}
//                    (only submit_intent needs it; the seed never leaves this process)
//   PQI_MCP_LOG      one JSON line per call
import { appendFileSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fromB64, hexToBytes, memo, seal, signIntent, signingKeyFromSeed, verifyLog, type LogEntry } from '@pqi/protocol';
import { chainTip, quicksend, scan, SetupRequiredError, zingoConfig } from '@pqi/node';

const desk = () => process.env.PQI_DESK_URL ?? 'http://127.0.0.1:8404';

async function get<T>(path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(desk() + path);
  } catch {
    throw new SetupRequiredError('PQI_DESK_URL', `no desk answering at ${desk()} (pnpm --filter @pqi/node serve)`);
  }
  const b = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
  return b;
}

function log(tool: string, args: unknown, isError: boolean, result: unknown) {
  const f = process.env.PQI_MCP_LOG;
  if (f) appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), tool, args, isError, result }) + '\n');
}

async function run(tool: string, args: unknown, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    log(tool, args, false, result);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const text = (e as Error).message;
    log(tool, args, true, text);
    return { isError: true, content: [{ type: 'text' as const, text }] };
  }
}

type Info = { mode: string; escrow: { address: string; uivk?: string }; anchor: { address: string; uivk?: string }; solver: { kem: { id: string; pk: string } }; verifier: { id: string; pk: string }; min_fee_zat: string };

export function createServer(): McpServer {
  const server = new McpServer({ name: 'zec-pq-intents', version: '0.1.0' });

  server.registerTool(
    'quote',
    { title: 'Ask whether the solver would fill', description: 'Given what you would escrow (pay_zat) and want delivered (min_out_zat), says whether the solver accepts and its fee. Read-only.', inputSchema: { pay_zat: z.number().int().positive(), min_out_zat: z.number().int().positive() }, annotations: { readOnlyHint: true } },
    (a) =>
      run('quote', a, async () => {
        const info = await get<Info>('/api/info');
        const fee = a.pay_zat - a.min_out_zat;
        const min = Number(info.min_fee_zat);
        return { accept: fee >= min, fee_zat: fee, solver_min_fee_zat: min, escrow: info.escrow.address, desk_mode: info.mode };
      }),
  );

  server.registerTool(
    'submit_intent',
    {
      title: 'Sign, seal and fund a delivery intent',
      description:
        'Signs an intent with the agent’s ML-DSA-65 key, seals it to the solver’s ML-KEM-768 key, funds the escrow with a shielded payment (memo pqi1:<hash>), and posts the sealed envelope to the desk. The solver then delivers min_out_zat to the agent’s receive address. Spends real testnet funds.',
      inputSchema: { pay_zat: z.number().int().positive().max(200_000), min_out_zat: z.number().int().positive(), deadline_blocks: z.number().int().min(6).max(500) },
    },
    (a) =>
      run('submit_intent', a, async () => {
        const file = process.env.PQI_AGENT_FILE;
        if (!file) throw new SetupRequiredError('PQI_AGENT_FILE');
        const me = JSON.parse(readFileSync(file, 'utf8')) as { ml_dsa_seed: string; wallet: string; receive_ua: string; receive_uivk: string; refund_ua: string };
        const info = await get<Info>('/api/info');
        if (info.mode !== 'live') throw new Error(`the desk is ${info.mode}; it cannot accept intents`);
        if (a.pay_zat - a.min_out_zat < Number(info.min_fee_zat)) throw new Error(`refused before signing: fee ${a.pay_zat - a.min_out_zat} zat is below the solver's ${info.min_fee_zat}`);
        const key = signingKeyFromSeed(hexToBytes(me.ml_dsa_seed));
        const tip = await chainTip();
        const s = signIntent(key, { escrow: info.escrow.address, pay_zat: String(a.pay_zat), min_out_zat: String(a.min_out_zat), receive_ua: me.receive_ua, receive_uivk: me.receive_uivk, refund_ua: me.refund_ua, deadline_height: tip + a.deadline_blocks });
        const envelope = seal(s, fromB64(info.solver.kem.pk));
        const [funding] = await quicksend(zingoConfig(), me.wallet, [{ address: info.escrow.address, amount: BigInt(a.pay_zat), memo: memo.funding(envelope.intent_hash) }]);
        const r = await fetch(`${desk()}/api/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope, funding_txid: funding }) });
        if (!r.ok) throw new Error(`desk refused the envelope: ${((await r.json()) as { error?: string }).error}`);
        return { intent_hash: envelope.intent_hash, funding_txid: funding, deadline_height: s.intent.deadline_height, sealed_to_solver_kem: envelope.to };
      }),
  );

  server.registerTool(
    'status',
    { title: 'Where an intent stands', description: 'Stage on the desk (received, funded, filled, settled, refunded, rejected) and its signed log entries. Read-only.', inputSchema: { intent_hash: z.string().regex(/^[0-9a-f]{64}$/) }, annotations: { readOnlyHint: true } },
    (a) => run('status', a, () => get(`/api/intents/${a.intent_hash}`)),
  );

  server.registerTool(
    'verify_log',
    {
      title: 'Re-verify the attestation log',
      description: 'Fetches the verifier’s log and public key, re-checks every hash, link and ML-DSA-65 signature, and checks the latest anchor memo on-chain with the anchor address’s published viewing key. Read-only.',
      annotations: { readOnlyHint: true },
    },
    () =>
      run('verify_log', {}, async () => {
        const [info, { log }] = await Promise.all([get<Info>('/api/info'), get<{ log: LogEntry[] }>('/api/log')]);
        const check = verifyLog(log, fromB64(info.verifier.pk));
        const counts = log.reduce<Record<string, number>>((m, e) => ((m[e.status] = (m[e.status] ?? 0) + 1), m), {});
        const last = [...log].reverse().find((e) => e.status === 'ANCHORED');
        let anchor: unknown = 'no anchor yet';
        if (last && info.anchor.uivk) {
          const seq = Number(last.refs.anchored_seq);
          const r = await scan(info.anchor.uivk, last.refs.anchor_txid, 1, memo.anchor(seq, last.refs.anchored_head));
          const head = verifyLog(log.slice(0, seq + 1), fromB64(info.verifier.pk)).head;
          anchor = { txid: last.refs.anchor_txid, memo_on_chain: r.ok, height: r.height, anchored_head_matches_log: head === last.refs.anchored_head };
        }
        return { ok: check.ok, entries: check.entries, head: check.head, error: check.error, counts, verifier: info.verifier.id, anchor };
      }),
  );
  return server;
}
