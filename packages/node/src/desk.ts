// The intent desk: a public board of sealed envelopes plus the state machine that moves each one
//   received → funded (escrow sees pqi1:<hash>) → filled (solver delivered) → settled (escrow released)
// The board only ever holds ciphertext and the intent hash; the solver opens envelopes, the verifier
// decides. `tick()` advances every open intent by what the chain shows now; it is idempotent.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { keyId, ProtocolError, toB64, type Envelope, type FillClaim, type SignedIntent } from '@pqi/protocol';
import type { Solver } from './solver.js';
import type { Verifier } from './verifier.js';

export type Stage = 'received' | 'declined' | 'funded' | 'filled' | 'settled' | 'refunded' | 'rejected';

export interface BoardItem {
  hash: string;
  envelope: Envelope;
  fundingTxid: string;
  stage: Stage;
  note: string | null;
  fillTxid: string | null;
  claim: FillClaim | null;
  postedAt: string;
}

export interface DeskConfig {
  boardPath: string;
  solver: Solver;
  verifier: Verifier;
  tip: () => Promise<number>;
  info: Record<string, unknown>;
}

export class Desk {
  items: BoardItem[];
  constructor(private readonly c: DeskConfig) {
    this.items = existsSync(c.boardPath) ? JSON.parse(readFileSync(c.boardPath, 'utf8')) : [];
  }

  private save() {
    writeFileSync(`${this.c.boardPath}.tmp`, JSON.stringify(this.items, null, 2));
    renameSync(`${this.c.boardPath}.tmp`, this.c.boardPath);
  }

  submit(envelope: Envelope, fundingTxid: string): BoardItem {
    if (!/^[0-9a-f]{64}$/.test(envelope?.intent_hash ?? '')) throw new ProtocolError('BAD_ENVELOPE', 'missing intent hash');
    if (!/^[0-9a-f]{64}$/.test(fundingTxid ?? '')) throw new ProtocolError('BAD_ENVELOPE', 'funding_txid must be 64 hex');
    const existing = this.items.find((i) => i.hash === envelope.intent_hash);
    if (existing) return existing;
    const item: BoardItem = { hash: envelope.intent_hash, envelope, fundingTxid, stage: 'received', note: null, fillTxid: null, claim: null, postedAt: new Date().toISOString() };
    this.items.push(item);
    this.save();
    return item;
  }

  /** Advances one item as far as the chain allows now. Returns what happened. */
  async step(item: BoardItem): Promise<string> {
    const tip = await this.c.tip();
    let s: SignedIntent;
    try {
      s = this.c.solver.open(item.envelope);
    } catch (e) {
      item.stage = 'declined';
      item.note = (e as Error).message;
      this.save();
      return item.note;
    }
    if (item.stage === 'received') {
      const f = await this.c.solver.funded(item.hash, s, item.fundingTxid);
      if (!f.ok) return `waiting for funding: ${f.reasons.join(', ')}`;
      const q = this.c.solver.quote(s, tip);
      if (!q.accept) {
        item.stage = 'declined';
        item.note = q.reason;
        this.save();
        return q.reason;
      }
      item.stage = 'funded';
      this.save();
    }
    if (item.stage === 'funded') {
      item.fillTxid = await this.c.solver.deliver(item.hash, s);
      item.claim = this.c.solver.claim(item.hash, item.fillTxid);
      item.stage = 'filled';
      this.save();
      return `filled ${item.fillTxid}`;
    }
    if (item.stage === 'filled' && item.claim) {
      const d = await this.c.verifier.settle(s, item.fundingTxid, item.claim);
      if (d.status === 'PENDING') return d.reason;
      item.stage = d.status === 'SETTLED' ? 'settled' : 'rejected';
      item.note = d.reason;
      this.save();
      return `${d.status}${d.reason ? ` ${d.reason}` : ''}`;
    }
    return item.stage;
  }

  async tick(): Promise<{ hash: string; result: string }[]> {
    const out = [];
    for (const i of this.items.filter((x) => ['received', 'funded', 'filled'].includes(x.stage))) out.push({ hash: i.hash, result: await this.step(i) });
    return out;
  }

  status(hash: string) {
    const item = this.items.find((i) => i.hash === hash) ?? null;
    const entries = this.c.verifier.state.log.filter((e) => e.intent_hash === hash);
    return { hash, stage: item?.stage ?? (entries.length ? 'logged' : 'unknown'), note: item?.note ?? null, funding_txid: item?.fundingTxid ?? null, fill_txid: item?.fillTxid ?? null, log: entries };
  }

  info() {
    return { ...this.c.info, intents: this.items.length, log_entries: this.c.verifier.state.log.length };
  }

  log() {
    return this.c.verifier.state.log;
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const c of req) s += c;
  return JSON.parse(s || '{}');
}

/** HTTP for agents (MCP) and the dashboard. */
export function serveDesk(desk: Desk): Server {
  return createServer((req, res) => {
    (async () => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'GET' && url.pathname === '/api/info') return json(res, 200, desk.info());
      if (req.method === 'GET' && url.pathname === '/api/log') return json(res, 200, { log: desk.log() });
      if (req.method === 'GET' && url.pathname.startsWith('/api/intents/')) return json(res, 200, desk.status(url.pathname.split('/').pop() ?? ''));
      if (req.method === 'POST' && url.pathname === '/api/intents') {
        const b = await body(req);
        return json(res, 200, desk.submit(b.envelope as Envelope, b.funding_txid as string));
      }
      if (req.method === 'POST' && url.pathname === '/api/tick') return json(res, 200, await desk.tick());
      return json(res, 404, { error: 'not found' });
    })().catch((e: Error) => json(res, e instanceof ProtocolError || e instanceof SyntaxError ? 400 : 502, { error: e.message }));
  });
}

export const publicKeyInfo = (pk: Uint8Array) => ({ id: keyId(pk), b64: toB64(pk) });
