// MCP tools for agents trading with post-quantum signed intents.
//   PQI_DESK_URL     desk HTTP API (default http://127.0.0.1:8404)
//   PQI_VERIFIER_ID  keyId of the verifier you trust (verify_log refuses to run without it: a desk
//                    that also supplied the key would be vouching for itself)
//   PQI_AGENT_FILE   the agent's identity: {"ml_dsa_seed": hex, "wallet": zingo dir, "receive_ua", "receive_uivk", "refund_ua",
//                    "trust": {"escrow": UA, "solver_kem": keyId}} (only submit_intent needs it; the seed never leaves
//                    this process; nothing is signed or paid unless the desk's escrow and KEM key match "trust")
//   PQI_MCP_LOG      one JSON line per call
import { appendFileSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fromB64, GENESIS, hexToBytes, keyId, memo, seal, signIntent, signingKeyFromSeed, verifyLog, type LogEntry } from '@pqi/protocol';
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
    { title: 'Check the fee against the solver minimum', description: 'Given what you would escrow (pay_zat) and want delivered (min_out_zat), checks the fee against the solver’s published minimum. Local arithmetic: the solver decides when it opens the envelope, and also declines intents with fewer than 3 blocks before the deadline. Read-only.', inputSchema: { pay_zat: z.number().int().positive(), min_out_zat: z.number().int().positive() }, annotations: { readOnlyHint: true } },
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
        const me = JSON.parse(readFileSync(file, 'utf8')) as { ml_dsa_seed: string; wallet: string; receive_ua: string; receive_uivk: string; refund_ua: string; trust?: { escrow?: string; solver_kem?: string } };
        if (!me.trust?.escrow || !me.trust?.solver_kem) throw new SetupRequiredError('PQI_AGENT_FILE trust.escrow and trust.solver_kem', 'the escrow address and solver KEM key id you trust');
        const info = await get<Info>('/api/info');
        // The desk tells us where to pay and whom to seal to; check both against what we trust first.
        if (info.escrow.address !== me.trust.escrow) throw new Error(`refused before signing or paying: the desk's escrow ${info.escrow.address} is not the pinned ${me.trust.escrow}`);
        if (keyId(fromB64(info.solver.kem.pk)) !== me.trust.solver_kem) throw new Error(`refused before signing or paying: the desk's solver KEM key is not the pinned ${me.trust.solver_kem}`);
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
      description:
        'Fetches the verifier’s log, checks the verifier key against the one you pinned (PQI_VERIFIER_ID), re-checks every hash, link and ML-DSA-65 signature, checks every anchor memo on-chain with the anchor address’s published viewing key and that each names the anchor before it, and says how many entries come after the last anchor (not yet anchored). Read-only.',
      annotations: { readOnlyHint: true },
    },
    () =>
      run('verify_log', {}, async () => {
        const pinned = process.env.PQI_VERIFIER_ID;
        if (!pinned || !/^[0-9a-f]{64}$/.test(pinned)) throw new SetupRequiredError('PQI_VERIFIER_ID', 'the key id of the verifier you trust; the desk cannot vouch for its own log');
        const [info, { log }] = await Promise.all([get<Info>('/api/info'), get<{ log: LogEntry[] }>('/api/log')]);
        const pk = fromB64(info.verifier.pk);
        const counts = log.reduce<Record<string, number>>((m, e) => ((m[e.status] = (m[e.status] ?? 0) + 1), m), {});
        if (keyId(pk) !== pinned) return { ok: false, entries: 0, head: null, error: { seq: null, problem: `the desk serves verifier key ${keyId(pk)}, not the pinned ${pinned}` }, counts, verifier: keyId(pk), anchor: 'not checked' };
        const check = verifyLog(log, pk);
        const anchors = log.filter((e) => e.status === 'ANCHORED');
        const last = anchors[anchors.length - 1];
        let anchor: unknown = 'no anchor yet';
        let anchorOk = true;
        if (last && info.anchor.uivk) {
          // Every anchor: its memo on-chain (head, and the previous anchor's txid; the Oct 20 one names
          // none), its head equal to the log's own, and its link to the anchor before it.
          let links = true;
          let failed: LogEntry | undefined;
          let lastSeen: Awaited<ReturnType<typeof scan>> | undefined;
          for (const [i, a] of anchors.entries()) {
            const seq = Number(a.refs.anchored_seq);
            const prev = a.refs.prev_anchor_txid;
            const linked = i === 0 ? prev === undefined || prev === GENESIS : prev === anchors[i - 1].refs.anchor_txid;
            const r = await scan(info.anchor.uivk, a.refs.anchor_txid, 1, memo.anchor(seq, a.refs.anchored_head, prev));
            const headOk = verifyLog(log.slice(0, seq + 1), pk).head === a.refs.anchored_head;
            links &&= linked;
            if (!(r.ok && headOk && linked)) failed ??= a;
            lastSeen = r;
          }
          const seq = Number(last.refs.anchored_seq);
          anchorOk = !failed;
          anchor = {
            txid: last.refs.anchor_txid,
            memo_on_chain: lastSeen!.ok,
            height: lastSeen!.height,
            anchored_head_matches_log: verifyLog(log.slice(0, seq + 1), pk).head === last.refs.anchored_head,
            anchored_through: seq,
            entries_after_anchor: log.length - 1 - seq,
            anchors: anchors.length,
            chain_links: links,
            escrow_history: 'not read here; `pnpm --filter @pqi/node check-anchors` lists every anchor the escrow sent (its full viewing key) and catches a fork',
          };
          if (failed) anchor = { ...(anchor as object), first_bad_anchor: failed.refs.anchor_txid };
        }
        const error = check.error ?? (anchorOk ? null : { seq: Number(last?.refs.anchored_seq), problem: 'an anchor memo is missing on-chain, does not match the log, or does not link to the anchor before it' });
        return { ok: check.ok && anchorOk, entries: check.entries, head: check.head, error, counts, verifier: keyId(pk), anchor };
      }),
  );
  return server;
}
