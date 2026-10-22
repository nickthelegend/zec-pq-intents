// The intent desk: a public board of sealed envelopes plus the state machine that moves each one
//   received → funded (escrow sees pqi1:<hash>) → filled (solver delivered) → settled (escrow released)
// and, once the deadline and the claim window have passed without a settlement, → refunded.
// The board holds ciphertext and the intent hash; an envelope is opened once on arrival (junk is
// refused, so nobody can squat a hash), the solver fills, the verifier decides. `tick()` advances
// every open intent by what the chain shows now; one tick runs at a time.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { keyId, memo, ProtocolError, toB64, type Envelope, type FillClaim, type SignedIntent } from '@pqi/protocol';
import { InsufficientBalanceError, type Solver } from './solver.js';
import { crashPoint, FEE_BUDGET_ZAT, TX_EXPIRY_BLOCKS, type Verifier } from './verifier.js';

export type Stage = 'received' | 'declined' | 'funded' | 'filled' | 'settled' | 'refunded' | 'rejected' | 'refund_refused';
/** Stages a tick still works on. */
const OPEN: Stage[] = ['received', 'declined', 'funded', 'filled', 'rejected'];

export interface BoardItem {
  hash: string;
  envelope: Envelope;
  fundingTxid: string;
  stage: Stage;
  note: string | null;
  fillTxid: string | null;
  claim: FillClaim | null;
  postedAt: string;
  /** errors a tick hit on this item (each is also in `note`); the tick moves on to the next item */
  failures?: number;
  /** the solver's wallet could not fund the delivery yet: not tried again before this height */
  retryAfter?: number;
  /** chain tip the first time a tick saw this item; an item with no funding seen within
   *  `unfundedTtlBlocks` of it is dropped from the board */
  firstSeen?: number;
  /** write-ahead record of a delivery about to be broadcast (saved with fsync first, removed once
   *  its txid is saved). One left after a restart means the process stopped in between: the solver's
   *  history is searched for its memo before any new attempt. */
  delivering?: { memo: string; pay_to: string; amount_zat: string; at_height: number; at: string };
}

export interface DeskConfig {
  boardPath: string;
  solver: Solver;
  verifier: Verifier;
  tip: () => Promise<number>;
  info: Record<string, unknown>;
  /** most open intents the board holds (default MAX_OPEN); a submit past it is refused (503) */
  maxOpen?: number;
  /** blocks an intent may sit on the board with no funding seen before it is dropped (default UNFUNDED_TTL_BLOCKS) */
  unfundedTtlBlocks?: number;
}

export const MAX_OPEN = 1000;
export const UNFUNDED_TTL_BLOCKS = 100;

export class Desk {
  items: BoardItem[];
  constructor(private readonly c: DeskConfig) {
    this.items = existsSync(c.boardPath) ? JSON.parse(readFileSync(c.boardPath, 'utf8')) : [];
  }

  /** Temporary file, flushed to disk, renamed over the board: a crash leaves the old or the new. */
  private save() {
    const tmp = `${this.c.boardPath}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(this.items, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.c.boardPath);
  }

  submit(envelope: Envelope, fundingTxid: string): BoardItem {
    if (!/^[0-9a-f]{64}$/.test(envelope?.intent_hash ?? '')) throw new ProtocolError('BAD_ENVELOPE', 'missing intent hash');
    if (!/^[0-9a-f]{64}$/.test(fundingTxid ?? '')) throw new ProtocolError('BAD_ENVELOPE', 'funding_txid must be 64 hex');
    // Only an envelope that opens with the solver's key, carries a valid user signature and hashes
    // to its intent_hash is stored; anything else is refused here and never takes the hash's slot.
    let opened: SignedIntent;
    try {
      opened = this.c.solver.open(envelope);
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      throw new ProtocolError('BAD_ENVELOPE', 'the envelope does not open to a signed intent');
    }
    if (BigInt(opened.intent.pay_zat) <= FEE_BUDGET_ZAT) throw new ProtocolError('PAY_BELOW_FEE_BUDGET', `pay_zat ${opened.intent.pay_zat} is not above the ${FEE_BUDGET_ZAT} zat fee budget a release or refund keeps`);
    const existing = this.items.find((i) => i.hash === envelope.intent_hash);
    if (existing) return existing;
    const max = this.c.maxOpen ?? MAX_OPEN;
    if (this.items.filter((i) => OPEN.includes(i.stage)).length >= max) throw new HttpError(503, `the board is full (${max} open intents); try again later`);
    const item: BoardItem = { hash: envelope.intent_hash, envelope, fundingTxid, stage: 'received', note: null, fillTxid: null, claim: null, postedAt: new Date().toISOString() };
    this.items.push(item);
    this.save();
    return item;
  }

  /** Advances one item as far as the chain allows at `tip`. Returns what happened. */
  async step(item: BoardItem, tip?: number): Promise<string> {
    tip ??= await this.c.tip();
    let s: SignedIntent;
    try {
      s = this.c.solver.open(item.envelope);
    } catch (e) {
      item.stage = 'declined';
      item.note = (e as Error).message;
      this.save();
      return item.note;
    }
    if (OPEN.includes(item.stage) && item.stage !== 'filled' && tip > s.intent.deadline_height + this.c.verifier.claimWindow) return this.refund(item, s);
    if (item.stage === 'received') {
      if (item.firstSeen === undefined) {
        item.firstSeen = tip;
        this.save();
      }
      const f = await this.c.solver.funded(item.hash, s, item.fundingTxid, tip);
      if (!f.ok) {
        const ttl = this.c.unfundedTtlBlocks ?? UNFUNDED_TTL_BLOCKS;
        if ((!f.found || f.paidZat === 0) && tip > item.firstSeen + ttl) return this.drop(item, `dropped: no funding seen within ${ttl} blocks (${f.reasons.join(', ')}); nothing logged`);
        return `waiting for funding: ${f.reasons.join(', ')}`;
      }
      const q = await this.c.solver.quote(s, tip);
      const room = q.accept ? await this.c.solver.capacity(s) : null;
      if (!q.accept || !room!.ok) {
        item.stage = 'declined';
        item.note = q.accept ? (room as { reason: string }).reason : q.reason;
        this.save();
        return item.note;
      }
      item.stage = 'funded';
      this.save();
    }
    if (item.stage === 'funded') return this.deliver(item, s, tip);
    if (item.stage === 'filled' && item.claim) {
      const d = await this.c.verifier.settle(s, item.fundingTxid, item.claim);
      if (d.status === 'PENDING' || d.status === 'NOT_FUNDED') return d.reason;
      item.stage = d.status === 'SETTLED' ? 'settled' : 'rejected';
      item.note = d.reason;
      this.save();
      return `${d.status}${d.reason ? ` ${d.reason}` : ''}`;
    }
    return item.stage;
  }

  /** The solver pays the user, at most once per intent. A delivery left half-done by a stopped
   *  process (write-ahead record, no txid) is looked up by its memo in the solver's history first:
   *  found → that txid is the fill, nothing is sent; not found → nothing is sent until a transaction
   *  built then has expired. Before every send the quote is run again at this tip, so a resumed or
   *  retried delivery that could no longer be mined by the deadline is declined (then refunded). */
  private async deliver(item: BoardItem, s: SignedIntent, tip: number): Promise<string> {
    if (item.delivering) {
      const found = (await this.c.solver.sentWithMemo(item.delivering.memo)).filter((t) => t.status !== 'failed');
      if (found.length) return this.filled(item, found[0].txid, `filled ${found[0].txid} (found in the solver's history by its memo after a restart; not sent again)`);
      const expires = item.delivering.at_height + 1 + TX_EXPIRY_BLOCKS;
      if (tip <= expires) return `DELIVERY_UNRECONCILED: a delivery was being sent at height ${item.delivering.at_height} when the process stopped and is not in the solver's history; a transaction sent then could be mined until height ${expires} (tip ${tip}), so it is not sent again before then`;
      delete item.delivering; // provably never mined: safe to send
      this.save();
    }
    if (item.retryAfter !== undefined && tip < item.retryAfter) return `waiting for the solver's balance until block ${item.retryAfter}`;
    const q = await this.c.solver.quote(s, tip);
    if (!q.accept) {
      item.stage = 'declined';
      item.note = q.reason;
      this.save();
      return q.reason;
    }
    item.delivering = { memo: memo.fill(item.hash, this.c.solver.id), pay_to: q.payTo, amount_zat: s.intent.min_out_zat, at_height: tip, at: new Date().toISOString() };
    this.save();
    crashPoint('deliver-before-broadcast');
    let txid: string;
    try {
      txid = await this.c.solver.deliver(item.hash, s);
    } catch (e) {
      if (!(e instanceof InsufficientBalanceError)) throw e; // outcome unknown: the record stays
      delete item.delivering; // fails while proposing: nothing was built or sent
      item.retryAfter = tip + 1;
      item.note = `waiting for the solver's balance: ${e.message}`;
      this.save();
      return item.note;
    }
    crashPoint('deliver-after-broadcast');
    return this.filled(item, txid, `filled ${txid}`);
  }

  /** Removes an item that never got funding: there is nothing to refund and nothing is logged. */
  private drop(item: BoardItem, result: string): string {
    this.items = this.items.filter((i) => i !== item);
    this.save();
    return result;
  }

  private filled(item: BoardItem, txid: string, result: string): string {
    item.fillTxid = txid;
    item.claim = this.c.solver.claim(item.hash, txid);
    item.stage = 'filled';
    item.note = null;
    delete item.delivering;
    delete item.retryAfter;
    this.save();
    return result;
  }

  /** Past the deadline and the claim window with nothing settled: the verifier refunds the escrow. */
  private async refund(item: BoardItem, s: SignedIntent): Promise<string> {
    const d = await this.c.verifier.refund(s, item.fundingTxid);
    if (d.status === 'PENDING') return d.reason;
    if (d.status === 'NOT_FUNDED') return this.drop(item, `dropped: ${d.reason}`);
    item.stage = d.status === 'REFUNDED' ? 'refunded' : 'refund_refused';
    item.note = d.reason;
    this.save();
    return `${d.status}${d.reason ? ` ${d.reason}` : ''}`;
  }

  private ticking: Promise<{ hash: string; result: string }[]> | null = null;

  /** One pass over the open intents, at one chain tip. An error on one item is written to its note
   *  and the pass goes on to the next, so one bad intent or one failed call cannot stop refunds and
   *  settlements of the others. A call while a pass is running gets that pass's result. */
  tick(): Promise<{ hash: string; result: string }[]> {
    this.ticking ??= (async () => {
      const tip = await this.c.tip();
      const out = [];
      for (const i of this.items.filter((x) => OPEN.includes(x.stage))) {
        try {
          out.push({ hash: i.hash, result: await this.step(i, tip) });
        } catch (e) {
          i.failures = (i.failures ?? 0) + 1;
          i.note = `error: ${(e as Error).message}`;
          this.save();
          out.push({ hash: i.hash, result: i.note });
        }
      }
      return out;
    })().finally(() => (this.ticking = null));
    return this.ticking;
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

/** Reads are public (CORS open); writes are not offered to other origins. */
export const json = (res: ServerResponse, status: number, body: unknown, cors = true) =>
  res.writeHead(status, { 'content-type': 'application/json', ...(cors ? { 'access-control-allow-origin': '*' } : {}) }).end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

export const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** JSON bodies only (a cross-site form or plain fetch cannot send that without a preflight, which
 *  this server never approves), and at most MAX_BODY_BYTES. */
export async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'POST bodies must be application/json');
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > MAX_BODY_BYTES) throw new HttpError(413, `body over ${MAX_BODY_BYTES} bytes`);
  }
  return JSON.parse(s || '{}');
}

/** A refused or failed write: 415/413 from body(), 400 for a bad request, 502 otherwise; never CORS. */
export function fail(res: ServerResponse, e: Error) {
  const status = e instanceof HttpError ? e.status : e instanceof ProtocolError || e instanceof SyntaxError ? 400 : 502;
  if (status === 413) res.setHeader('connection', 'close');
  json(res, status, { error: e.message }, false);
}

/** The desk listens on 127.0.0.1 only. A request whose Host is not 127.0.0.1:<port> or
 *  localhost:<port> came through a name that resolves here (DNS rebinding), and is refused (403),
 *  so a page on another site cannot reach the desk as if it were same-origin. */
export function hostAllowed(req: IncomingMessage, server: Server): boolean {
  const port = (server.address() as { port?: number } | null)?.port;
  const host = (req.headers.host ?? '').toLowerCase();
  return port !== undefined && (host === `127.0.0.1:${port}` || host === `localhost:${port}`);
}

export const refuseHost = (req: IncomingMessage, res: ServerResponse) => json(res, 403, { error: `Host ${JSON.stringify(req.headers.host ?? '')} is not this desk; use 127.0.0.1 or localhost` }, false);

/** HTTP for agents (MCP) and the dashboard. */
export function serveDesk(desk: Desk): Server {
  const server: Server = createServer((req, res) => {
    if (!hostAllowed(req, server)) return refuseHost(req, res);
    (async () => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'GET' && url.pathname === '/api/info') return json(res, 200, desk.info());
      if (req.method === 'GET' && url.pathname === '/api/log') return json(res, 200, { log: desk.log() });
      if (req.method === 'GET' && url.pathname.startsWith('/api/intents/')) return json(res, 200, desk.status(url.pathname.split('/').pop() ?? ''));
      if (req.method === 'POST' && url.pathname === '/api/intents') {
        const b = await body(req);
        return json(res, 200, desk.submit(b.envelope as Envelope, b.funding_txid as string), false);
      }
      if (req.method === 'POST' && url.pathname === '/api/tick') {
        await body(req);
        return json(res, 200, await desk.tick(), false);
      }
      return json(res, 404, { error: 'not found' }, req.method === 'GET');
    })().catch((e: Error) => fail(res, e));
  });
  return server;
}

export const publicKeyInfo = (pk: Uint8Array) => ({ id: keyId(pk), b64: toB64(pk) });
