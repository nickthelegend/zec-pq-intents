// MCP tools for agents trading with post-quantum signed intents.
//   PQI_DESK_URL     desk HTTP API (default http://127.0.0.1:8404)
//   PQI_VERIFIER_ID  keyId of the verifier you trust (verify_log refuses to run without it: a desk
//                    that also supplied the key would be vouching for itself)
//   PQI_ANCHOR_UIVK  the anchor address's incoming viewing key you trust: verify_log reads every
//                    anchor memo with it, never with a key the desk serves (Setup required once the
//                    log has an anchor and this is not set)
//   PQI_AGENT_FILE   the agent's identity: {"ml_dsa_seed": hex, "wallet": zingo dir, "receive_ua", "receive_uivk", "refund_ua",
//                    "trust": {"escrow": UA, "solver_kem": keyId}} (only submit_intent needs it; the seed never leaves
//                    this process; nothing is signed or paid unless the desk's escrow and KEM key match "trust")
//   PQI_MCP_PENDING  where submit_intent saves each signed intent and envelope before paying, and the
//                    funding txid once it is known (default: <PQI_AGENT_FILE>.pending.json, mode 0600),
//                    so a desk that fails after the payment loses nothing: `resubmit` posts it again
//   PQI_MCP_LOG      one JSON line per call
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fromB64, GENESIS, hexToBytes, keyId, memo, seal, signIntent, signingKeyFromSeed, verifyLog, type Envelope, type LogEntry, type SignedIntent } from '@pqi/protocol';
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

/** The escrow keeps this much of every deposit for the release or refund transaction (and keeps it
 *  on a refund too): see packages/node FEE_BUDGET_ZAT. */
const FEE_BUDGET_ZAT = 15_000;
/** Fewest blocks submit_intent allows before the deadline: 3 funding confirmations, the solver's
 *  3-block margin, and a tick and a block of latency. */
const MIN_DEADLINE_BLOCKS = 10;

type Pending = { intent_hash: string; signed: SignedIntent; envelope: Envelope; funding_txid: string | null; posted: boolean; desk: string; at: string; error?: string };
const pendingFile = () => process.env.PQI_MCP_PENDING ?? (process.env.PQI_AGENT_FILE ? `${process.env.PQI_AGENT_FILE}.pending.json` : null);
function readPending(): Record<string, Pending> {
  const f = pendingFile();
  return f && existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, Pending>) : {};
}
/** Written to a temporary file and renamed, readable by this user only. */
function savePending(p: Pending) {
  const f = pendingFile();
  if (!f) throw new SetupRequiredError('PQI_MCP_PENDING', 'where to save signed intents before paying');
  const all = { ...readPending(), [p.intent_hash]: p };
  writeFileSync(`${f}.tmp`, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(`${f}.tmp`, 0o600);
  renameSync(`${f}.tmp`, f);
}

async function post(envelope: Envelope, funding_txid: string): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(`${desk()}/api/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope, funding_txid }) });
  } catch (e) {
    throw new Error(`no desk answering at ${desk()} (${(e as Error).message})`);
  }
  const b = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(`the desk refused the envelope (HTTP ${r.status}): ${b.error ?? 'no reason given'}`);
  return b;
}

type Info = { mode: string; escrow: { address: string; uivk?: string }; anchor: { address: string; uivk?: string }; solver: { kem: { id: string; pk: string } }; verifier: { id: string; pk: string }; min_fee_zat: string };

export function createServer(): McpServer {
  const server = new McpServer({ name: 'zec-pq-intents', version: '0.1.0' });

  server.registerTool(
    'quote',
    { title: 'Check the fee against the solver minimum', description: `Given what you would escrow (pay_zat) and want delivered (min_out_zat), checks the spread against the solver’s published minimum. Local arithmetic: the solver decides when it opens the envelope, once the funding has 3 confirmations, and also declines intents with fewer than 3 blocks before the deadline. A release or a refund pays pay_zat minus a ${FEE_BUDGET_ZAT.toLocaleString('en-US')} zat fee budget, which the escrow keeps on a refund too. Read-only.`, inputSchema: { pay_zat: z.number().int().positive(), min_out_zat: z.number().int().positive() }, annotations: { readOnlyHint: true } },
    (a) =>
      run('quote', a, async () => {
        const info = await get<Info>('/api/info');
        const fee = a.pay_zat - a.min_out_zat;
        const min = Number(info.min_fee_zat);
        return { accept: fee >= min, fee_zat: fee, solver_min_fee_zat: min, refund_if_unfilled_zat: Math.max(0, a.pay_zat - FEE_BUDGET_ZAT), escrow: info.escrow.address, desk_mode: info.mode };
      }),
  );

  server.registerTool(
    'submit_intent',
    {
      title: 'Sign, seal and fund a delivery intent',
      description: `Signs an intent with the agent’s ML-DSA-65 key, seals it to the solver’s ML-KEM-768 key, saves both (PQI_MCP_PENDING) before paying, funds the escrow with a shielded payment (memo pqi1:<hash>), and posts the sealed envelope to the desk. The solver then delivers min_out_zat to the agent’s receive address once the funding has 3 confirmations. If nothing is delivered by the deadline, the escrow is refunded after a 10-block claim window, minus the ${FEE_BUDGET_ZAT.toLocaleString('en-US')} zat fee budget. If the desk refuses after the payment, the error carries the intent hash, funding txid and envelope, and resubmit posts it again. deadline_blocks is at least ${MIN_DEADLINE_BLOCKS}. Spends real testnet funds.`,
      inputSchema: { pay_zat: z.number().int().positive().max(200_000), min_out_zat: z.number().int().positive(), deadline_blocks: z.number().int().min(MIN_DEADLINE_BLOCKS).max(500), receive_ua: z.string().regex(/^utest1[0-9a-z]+$/).optional() },
    },
    (a) =>
      run('submit_intent', a, async () => {
        const file = process.env.PQI_AGENT_FILE;
        if (!file) throw new SetupRequiredError('PQI_AGENT_FILE');
        const me = JSON.parse(readFileSync(file, 'utf8')) as { ml_dsa_seed: string; wallet: string; receive_ua: string; receive_uivk: string; refund_ua: string; trust?: { escrow?: string; solver_kem?: string } };
        // A receive address of this call's own (for example a new diversified address of the same
        // wallet, so intents are not linked by their address); it must be one receive_uivk derives,
        // or the solver declines it (RECEIVE_KEY_MISMATCH).
        const receiveUa = a.receive_ua ?? me.receive_ua;
        if (!me.trust?.escrow || !me.trust?.solver_kem) throw new SetupRequiredError('PQI_AGENT_FILE trust.escrow and trust.solver_kem', 'the escrow address and solver KEM key id you trust');
        const info = await get<Info>('/api/info');
        // The desk tells us where to pay and whom to seal to; check both against what we trust first.
        if (info.escrow.address !== me.trust.escrow) throw new Error(`refused before signing or paying: the desk's escrow ${info.escrow.address} is not the pinned ${me.trust.escrow}`);
        if (keyId(fromB64(info.solver.kem.pk)) !== me.trust.solver_kem) throw new Error(`refused before signing or paying: the desk's solver KEM key is not the pinned ${me.trust.solver_kem}`);
        if (info.mode !== 'live') throw new Error(`the desk is ${info.mode}; it cannot accept intents`);
        if (a.pay_zat - a.min_out_zat < Number(info.min_fee_zat)) throw new Error(`refused before signing: fee ${a.pay_zat - a.min_out_zat} zat is below the solver's ${info.min_fee_zat}`);
        const key = signingKeyFromSeed(hexToBytes(me.ml_dsa_seed));
        const tip = await chainTip();
        const s = signIntent(key, { escrow: info.escrow.address, pay_zat: String(a.pay_zat), min_out_zat: String(a.min_out_zat), receive_ua: receiveUa, receive_uivk: me.receive_uivk, refund_ua: me.refund_ua, deadline_height: tip + a.deadline_blocks });
        const envelope = seal(s, fromB64(info.solver.kem.pk));
        // Saved before any money moves: whatever fails next, the signed intent and envelope remain.
        const rec: Pending = { intent_hash: envelope.intent_hash, signed: s, envelope, funding_txid: null, posted: false, desk: desk(), at: new Date().toISOString() };
        savePending(rec);
        const failed = (e: Error) =>
          new Error(JSON.stringify({ error: e.message, intent_hash: rec.intent_hash, funding_txid: rec.funding_txid, envelope, pending_file: pendingFile(), next: rec.funding_txid ? 'call resubmit with this intent_hash once the desk accepts envelopes again' : 'nothing was paid' }));
        try {
          [rec.funding_txid] = await quicksend(zingoConfig(), me.wallet, [{ address: info.escrow.address, amount: BigInt(a.pay_zat), memo: memo.funding(envelope.intent_hash) }]);
          savePending(rec);
          await post(envelope, rec.funding_txid);
        } catch (e) {
          savePending({ ...rec, error: (e as Error).message });
          throw failed(e as Error);
        }
        savePending({ ...rec, posted: true });
        return { intent_hash: envelope.intent_hash, funding_txid: rec.funding_txid, receive_ua: receiveUa, deadline_height: s.intent.deadline_height, sealed_to_solver_kem: envelope.to, refund_if_unfilled_zat: a.pay_zat - FEE_BUDGET_ZAT };
      }),
  );

  server.registerTool(
    'resubmit',
    {
      title: 'Post a saved, funded intent to the desk again',
      description: 'Posts the sealed envelope and funding txid that submit_intent saved (PQI_MCP_PENDING) for this intent hash, for example after the desk refused or was down once the escrow was already funded. The desk keeps one entry per intent hash, so posting twice is harmless. Spends nothing.',
      inputSchema: { intent_hash: z.string().regex(/^[0-9a-f]{64}$/) },
    },
    (a) =>
      run('resubmit', a, async () => {
        if (!pendingFile()) throw new SetupRequiredError('PQI_AGENT_FILE or PQI_MCP_PENDING', 'where submit_intent saved its intents');
        const rec = readPending()[a.intent_hash];
        if (!rec) throw new Error(`no saved intent ${a.intent_hash} in ${pendingFile()}`);
        if (!rec.funding_txid) throw new Error(`intent ${a.intent_hash} was never funded (nothing was paid), so there is nothing to post`);
        const answer = await post(rec.envelope, rec.funding_txid);
        savePending({ ...rec, posted: true, error: undefined, desk: desk() });
        return { intent_hash: rec.intent_hash, funding_txid: rec.funding_txid, desk: answer };
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
        'Fetches the verifier’s log, checks the verifier key against the one you pinned (PQI_VERIFIER_ID), re-checks every hash, link and ML-DSA-65 signature, checks every anchor memo on-chain with the anchor viewing key you pinned (PQI_ANCHOR_UIVK, never one the desk serves) and that each names the anchor before it, and says how many entries come after the last anchor (not yet anchored). Read-only.',
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
        // The anchor memos are read with the key you pinned; one the desk serves would let it vouch for its own anchors.
        const anchorUivk = process.env.PQI_ANCHOR_UIVK;
        if (last && !anchorUivk) throw new SetupRequiredError('PQI_ANCHOR_UIVK', `the log has ${anchors.length} anchor(s); their memos are read with the anchor viewing key you trust, not one the desk serves`);
        if (last && anchorUivk) {
          // Every anchor: its memo on-chain (head, and the previous anchor's txid; the Oct 20 one names
          // none), its head equal to the log's own, and its link to the anchor before it.
          let links = true;
          let failed: LogEntry | undefined;
          let lastSeen: Awaited<ReturnType<typeof scan>> | undefined;
          for (const [i, a] of anchors.entries()) {
            const seq = Number(a.refs.anchored_seq);
            const prev = a.refs.prev_anchor_txid;
            const linked = i === 0 ? prev === undefined || prev === GENESIS : prev === anchors[i - 1].refs.anchor_txid;
            const r = await scan(anchorUivk, a.refs.anchor_txid, 1, memo.anchor(seq, a.refs.anchored_head, prev));
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
