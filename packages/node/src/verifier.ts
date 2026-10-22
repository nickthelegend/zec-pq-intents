// The verifier: holds the escrow wallet and the log key. It decides, from what the chain shows
// through viewing keys and what the signatures say, whether an intent is SETTLED (escrow released to
// the solver), REFUNDED (deadline passed, escrow back to the user) or REJECTED, and appends an
// ML-DSA-65 signed entry for every decision. It is trusted to act on its decisions (it holds the
// escrow); anyone can re-check every decision and signature from the published log.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { appendEntry, GENESIS, intentHash, memo, ProtocolError, readAnchorMemo, readFillMemo, verifyFill, verifyIntent, verifyLog, type FillClaim, type LogEntry, type LogStatus, type SignedIntent, type SigningKey } from '@pqi/protocol';
import { owns, scan, type ScanResult } from './scan.js';
import { quicksend, sentWithMemo, type ZingoConfig } from './zingo.js';

/** The escrow keeps this much of each deposit to pay the release/refund transaction fee. */
export const FEE_BUDGET_ZAT = 15_000n;
/** Blocks after the deadline during which only the solver can be paid: a fill mined by the deadline
 *  can still be claimed, and a refund waits until the window closes. */
export const CLAIM_WINDOW_BLOCKS = 10;
/** Confirmations a funding or a fill needs before the verifier acts on it (a shallow reorg can undo a
 *  1-confirmation payment, and the escrow would then pay out of other users' deposits). */
export const MIN_CONFIRMATIONS = 3;

/** Blocks after which a transaction the escrow built but that was never mined can no longer be mined.
 *  zingolib's expiry delta: librustzcash's 40 blocks, held at the same wall-clock time (120 blocks)
 *  once NU7's 25-second blocks are active, as they are on this testnet (wallet/expiry.rs). */
export const TX_EXPIRY_BLOCKS = 120;

/** Test hook: `PQI_TEST_CRASH_AT=<point>` kills this process with SIGKILL at that point (no cleanup,
 *  no save), so a test can restart from exactly what was on disk. */
export function crashPoint(point: 'payout-before-broadcast' | 'payout-after-broadcast' | 'deliver-before-broadcast' | 'deliver-after-broadcast') {
  if (process.env.PQI_TEST_CRASH_AT === point) process.kill(process.pid, 'SIGKILL');
}

/** Confirmations of a transaction mined at `height` when the chain tip is `tip` (0 if not mined). */
export const confirmationsAt = (height: number | null, tip: number) => (height === null ? 0 : Math.max(0, tip - height + 1));

export interface VerifierState {
  log: LogEntry[];
  /** user key id → nonce → the intent hash that used it (set when that intent settles or is refunded) */
  nonces: Record<string, Record<string, string>>;
  /** intent hash → final status */
  closed: Record<string, 'SETTLED' | 'REFUNDED'>;
  /** decisions already paid out on-chain, so a restart never pays twice: key → txid */
  payouts: Record<string, string>;
  /** the memo each payout in `payouts` carried (key → memo), so an anchor paid but not yet logged
   *  can be logged with the exact previous anchor it named */
  payout_memos?: Record<string, string>;
  /** write-ahead records: a payout about to be broadcast, saved (fsync) before the broadcast and
   *  removed once its txid is saved. One left here after a restart means the process stopped in
   *  between; it is reconciled against the escrow's on-chain history before any new attempt. */
  sending?: Record<string, PayoutIntent>;
}

export interface PayoutIntent {
  to: string;
  amount_zat: string;
  /** unique per payout key (pqi1:<hash>:release, :refund, pqi1:anchor:…): how it is found on-chain */
  memo: string;
  /** chain tip when it was recorded; a transaction built then can be mined until at_height + 1 + TX_EXPIRY_BLOCKS */
  at_height: number;
  at: string;
}

export interface VerifierConfig {
  key: SigningKey;
  escrowWallet: string;
  escrowUa: string;
  escrowUivk: string;
  /** keyIds of the solver ML-DSA keys whose fill claims this verifier pays. A claim signed by any
   *  other key is refused (FILL_UNKNOWN_SOLVER). Among these, only the key the fill's memo names is
   *  paid (FILL_BY_OTHER_SOLVER otherwise), so one solver cannot claim another's delivery. */
  solvers: string[];
  /** Intent hashes from before fills named their solver (the Oct 20, 2026 run). Their fill memo
   *  `pqi1:<hash>:fill` names nobody, so it is accepted only for these intents and only while exactly
   *  one solver key is configured; the SETTLED entry says `fill_binding: legacy-single-solver`. */
  legacyUnboundFills?: string[];
  zingo: ZingoConfig;
  statePath: string;
  /** current chain height */
  tip: () => Promise<number>;
  /** default CLAIM_WINDOW_BLOCKS */
  claimWindow?: number;
  /** default MIN_CONFIRMATIONS; counted against `tip()` */
  minConfirmations?: number;
  /** a zingo wallet whose history shows every payment out of the escrow (default: escrowWallet; a
   *  view-only wallet from the escrow's full viewing key also works). Read only to reconcile a
   *  payout that a stopped process may have broadcast. */
  historyWallet?: string;
  /** how often a payout retries "Insufficient balance" (notes not spendable yet), a minute apart; default 20 */
  balanceRetries?: number;
}

export type Decision = { status: LogStatus; reason: string | null; entry: LogEntry; payoutTxid?: string };
/** Not decided yet (a transaction is not mined); nothing is logged. */
export type Pending = { status: 'PENDING'; reason: string };
/** Nothing with the intent's memo reached the escrow: not a decision about anyone's money, so
 *  nothing is logged (anyone could otherwise grow the signed log with intents they never fund). */
export type Unfunded = { status: 'NOT_FUNDED'; reason: string };
const onlyUnconfirmed = (reasons: string[]) => reasons.length > 0 && reasons.every((r) => r === 'NOT_CONFIRMED');

export class Verifier {
  readonly state: VerifierState;
  readonly claimWindow: number;
  readonly minConfirmations: number;
  /** Decisions run one at a time, so two calls for the same intent can never both pass the checks
   *  before either closes it (which would pay the escrow out twice). */
  private queue: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
  constructor(private readonly c: VerifierConfig) {
    this.state = existsSync(c.statePath) ? JSON.parse(readFileSync(c.statePath, 'utf8')) : { log: [], nonces: {}, closed: {}, payouts: {}, sending: {} };
    const check = verifyLog(this.state.log, c.key.publicKey);
    if (!check.ok) throw new Error(`stored log does not verify at entry ${check.error?.seq}: ${check.error?.problem}`);
    this.claimWindow = c.claimWindow ?? CLAIM_WINDOW_BLOCKS;
    this.minConfirmations = c.minConfirmations ?? MIN_CONFIRMATIONS;
    if (!Number.isSafeInteger(this.minConfirmations) || this.minConfirmations < 1) throw new Error('minConfirmations must be a whole number ≥ 1');
  }

  /** Written to a temporary file, flushed to disk, then renamed over the state: a crash leaves either
   *  the old state or the new one. */
  private save() {
    const tmp = `${this.c.statePath}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(this.state, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.c.statePath);
  }

  private async log(status: LogStatus, intent_hash: string | null, reason: string | null, refs: Record<string, string>): Promise<LogEntry> {
    return this.logAt(status, intent_hash, reason, refs, await this.c.tip());
  }

  /** Appends and saves in one step, with the height read before: nothing can fail between a payout
   *  being recorded and its entry being written, and `closed` is saved in the same write. */
  private logAt(status: LogStatus, intent_hash: string | null, reason: string | null, refs: Record<string, string>, at_height: number, close?: 'SETTLED' | 'REFUNDED'): LogEntry {
    const e = appendEntry(this.state.log, this.c.key, { status, intent_hash, reason, refs, at_height });
    if (close && intent_hash) this.state.closed[intent_hash] = close;
    this.save();
    return e;
  }

  private reject = async (hash: string | null, reason: string, refs: Record<string, string> = {}): Promise<Decision> => ({ status: 'REJECTED', reason, entry: await this.log('REJECTED', hash, reason, refs) });

  /** Pays once per key. Before the broadcast, a write-ahead record (recipient, amount, unique memo,
   *  height) is saved; after it, the txid replaces the record, and only then is the decision logged.
   *  If a record is already there, a previous process stopped between the two: the escrow's history is
   *  read for that memo first. Found → that txid is the payout (nothing is sent). Not found → no new
   *  attempt until a transaction built then has expired (PENDING until that height). */
  private async payOnce(key: string, to: string, amount: bigint, m: string): Promise<string | Pending> {
    if (this.state.payouts[key]) return this.state.payouts[key];
    const sending = (this.state.sending ??= {});
    if (sending[key]) {
      const r = await this.reconcile(key, sending[key]);
      if (r !== null) return r;
    }
    sending[key] = { to, amount_zat: amount.toString(), memo: m, at_height: await this.c.tip(), at: new Date().toISOString() };
    this.save();
    crashPoint('payout-before-broadcast');
    const retries = this.c.balanceRetries ?? 20;
    for (let i = 0; ; i++) {
      try {
        const [txid] = await quicksend(this.c.zingo, this.c.escrowWallet, [{ address: to, amount, memo: m }]);
        crashPoint('payout-after-broadcast');
        this.state.payouts[key] = txid;
        (this.state.payout_memos ??= {})[key] = m;
        delete sending[key];
        this.save();
        return txid;
      } catch (e) {
        // "Insufficient balance" fails while proposing, before anything is built or broadcast, so it is
        // safe to try again. Any other failure keeps the write-ahead record.
        if (!/Insufficient balance/.test((e as Error).message)) throw e;
        if (i >= retries) {
          // Nothing went out: drop the record and come back later instead of sleeping here.
          delete sending[key];
          this.save();
          return { status: 'PENDING', reason: `PAYOUT_WAITING_FOR_BALANCE: ${key} (${(e as Error).message})` };
        }
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
  }

  /** A write-ahead record from a stopped process: the txid if the escrow's history shows the payout,
   *  PENDING if it might still be mined, null if it provably never went out (safe to send). */
  private async reconcile(key: string, p: PayoutIntent): Promise<string | Pending | null> {
    const wallet = this.c.historyWallet ?? this.c.escrowWallet;
    let found;
    try {
      found = await sentWithMemo(this.c.zingo, wallet, p.memo);
    } catch (e) {
      throw new Error(`PAYOUT_UNRECONCILED: ${key} was being sent at height ${p.at_height} when the process stopped, and the escrow's history cannot be read to see whether it went out (${(e as Error).message}). Not paying again.`);
    }
    // zingo statuses: calculated, transmitted, mempool, confirmed, failed.
    const out = found.filter((t) => t.status !== 'failed');
    const mined = out.find((t) => t.status === 'confirmed');
    if (mined) {
      this.state.payouts[key] = mined.txid;
      (this.state.payout_memos ??= {})[key] = p.memo;
      delete this.state.sending![key];
      this.save();
      return mined.txid;
    }
    if (out.length) return { status: 'PENDING', reason: `PAYOUT_UNRECONCILED: ${key} went out as ${out[0].txid} (${out[0].status}); waiting for it to be mined` };
    const expires = p.at_height + 1 + TX_EXPIRY_BLOCKS;
    const tip = await this.c.tip();
    if (tip <= expires) return { status: 'PENDING', reason: `PAYOUT_UNRECONCILED: ${key} is not in the escrow's history; a transaction sent before the stop could be mined until height ${expires} (tip ${tip}), so it is not sent again before then` };
    return null;
  }

  /** PENDING until a mined transaction has minConfirmations against the verifier's own tip. */
  private async deepEnough(r: ScanResult, what: string): Promise<Pending | null> {
    const have = confirmationsAt(r.height, await this.c.tip());
    return have >= this.minConfirmations ? null : { status: 'PENDING', reason: `${what} has ${have} of ${this.minConfirmations} confirmations` };
  }

  private async funding(hash: string, fundingTxid: string, payZat: bigint): Promise<ScanResult> {
    return scan(this.c.escrowUivk, fundingTxid, payZat, memo.funding(hash));
  }

  /** Common checks on the user's signed intent: signature, key binding, nonce, funding. */
  /** `forRefund`: a deposit mined after the deadline still has to be refundable, so skip that check. */
  private async admit(s: SignedIntent, fundingTxid: string, forRefund = false): Promise<{ hash: string; fund: ScanResult } | Decision | Pending | Unfunded> {
    let hash: string;
    try {
      hash = verifyIntent(s);
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : 'BAD_INTENT';
      let claimed: string | null = null;
      try {
        claimed = intentHash(s.intent);
      } catch {
        claimed = null;
      }
      return this.reject(claimed, code, { funding_txid: fundingTxid });
    }
    // Closed only together with its SETTLED/REFUNDED entry. A closed mark with no such entry (state
    // left by a process that stopped between the payout and the entry) is finished below instead:
    // payOnce returns the recorded payout and the entry is written.
    const closedBy = this.state.closed[hash];
    if (closedBy && this.state.log.some((e) => e.intent_hash === hash && e.status === closedBy)) return this.reject(hash, `ALREADY_${closedBy}`, { funding_txid: fundingTxid });
    const firstUse = this.state.nonces[s.intent.user]?.[s.intent.nonce];
    if (firstUse && firstUse !== hash) return this.reject(hash, 'NONCE_REUSED', { funding_txid: fundingTxid, first_use: firstUse });
    // A release or refund pays pay_zat - FEE_BUDGET_ZAT; at or below the budget there is nothing to pay.
    if (BigInt(s.intent.pay_zat) <= FEE_BUDGET_ZAT) return this.reject(hash, 'PAY_BELOW_FEE_BUDGET', { funding_txid: fundingTxid, pay_zat: s.intent.pay_zat, fee_budget_zat: FEE_BUDGET_ZAT.toString() });
    // A fill is read with receive_uivk; if that key does not derive receive_ua, a delivery to
    // receive_ua would be invisible here, refused, and the escrow refunded on top of it.
    if (!forRefund && !(await owns(s.intent.receive_uivk, s.intent.receive_ua)).pay_to) return this.reject(hash, 'RECEIVE_KEY_MISMATCH', { funding_txid: fundingTxid });
    const fund = await this.funding(hash, fundingTxid, BigInt(s.intent.pay_zat));
    if (onlyUnconfirmed(fund.reasons)) return { status: 'PENDING', reason: 'funding not mined yet' };
    if (!fund.found || fund.paidZat === 0) return { status: 'NOT_FUNDED', reason: `NOT_FUNDED:${fund.reasons.join('+')} (nothing with this intent's memo reached the escrow; not logged)` };
    // Something did reach the escrow with this memo: from here on every refusal is a signed entry.
    const shallow = await this.deepEnough(fund, 'funding');
    if (shallow) return shallow;
    if (!fund.ok) return this.reject(hash, `NOT_FUNDED:${fund.reasons.join('+')}`, { funding_txid: fundingTxid });
    if (s.intent.escrow !== this.c.escrowUa) return this.reject(hash, 'WRONG_ESCROW', { funding_txid: fundingTxid });
    if (!forRefund && fund.height !== null && fund.height > s.intent.deadline_height) return this.reject(hash, 'FUNDED_AFTER_DEADLINE', { funding_txid: fundingTxid });
    return { hash, fund };
  }

  /** A memo that names no solver is only good for a listed legacy intent with a single solver key. */
  private legacyFill(hash: string): boolean {
    return this.c.solvers.length === 1 && (this.c.legacyUnboundFills ?? []).includes(hash);
  }

  private remember(s: SignedIntent, hash: string) {
    (this.state.nonces[s.intent.user] ??= {})[s.intent.nonce] = hash;
    this.save();
  }

  /** A solver claims it filled `s`. On success the escrow pays the solver and the entry is SETTLED. */
  settle(s: SignedIntent, fundingTxid: string, claim: FillClaim): Promise<Decision | Pending | Unfunded> {
    return this.exclusive(() => this.settleNow(s, fundingTxid, claim));
  }

  private async settleNow(s: SignedIntent, fundingTxid: string, claim: FillClaim): Promise<Decision | Pending | Unfunded> {
    const a = await this.admit(s, fundingTxid);
    if ('status' in a) return a;
    const { hash } = a;
    try {
      verifyFill(claim);
    } catch (e) {
      return this.reject(hash, `FILL_${e instanceof ProtocolError ? e.code : 'INVALID'}`, { fill_txid: claim.fill_txid });
    }
    if (!this.c.solvers.includes(claim.solver)) return this.reject(hash, 'FILL_UNKNOWN_SOLVER', { fill_txid: claim.fill_txid, solver: claim.solver });
    if (claim.intent_hash !== hash) return this.reject(hash, 'FILL_FOR_OTHER_INTENT', { fill_txid: claim.fill_txid });
    // The fill must name the claiming solver in its memo: only whoever paid the fill wrote that memo.
    let fill = await scan(s.intent.receive_uivk, claim.fill_txid, BigInt(s.intent.min_out_zat), memo.fill(hash, claim.solver));
    let binding = 'solver-memo';
    if (!fill.ok && fill.reasons.includes('MEMO_MISMATCH')) {
      const named = fill.outputs.map((o) => readFillMemo(o.memo, hash)).filter((x) => x !== null);
      const other = named.find((n) => n.solver !== null && n.solver !== claim.solver);
      if (other) return this.reject(hash, 'FILL_BY_OTHER_SOLVER', { fill_txid: claim.fill_txid, solver: claim.solver, memo_solver: other.solver! });
      if (named.some((n) => n.solver === null)) {
        if (!this.legacyFill(hash)) return this.reject(hash, 'FILL_NOT_SOLVER_BOUND', { fill_txid: claim.fill_txid, solver: claim.solver });
        fill = await scan(s.intent.receive_uivk, claim.fill_txid, BigInt(s.intent.min_out_zat), memo.legacyFill(hash));
        binding = 'legacy-single-solver';
      }
    }
    if (onlyUnconfirmed(fill.reasons)) return { status: 'PENDING', reason: 'fill not mined yet' };
    if (!fill.ok) return this.reject(hash, `FILL_NOT_CREDITED:${fill.reasons.join('+')}`, { fill_txid: claim.fill_txid });
    const shallowFill = await this.deepEnough(fill, 'fill');
    if (shallowFill) return shallowFill;
    if (fill.height === null || fill.height > s.intent.deadline_height) return this.reject(hash, 'EXPIRED', { fill_txid: claim.fill_txid, fill_height: String(fill.height), deadline: String(s.intent.deadline_height) });
    this.remember(s, hash);
    const out = BigInt(s.intent.pay_zat) - FEE_BUDGET_ZAT;
    const at = await this.c.tip(); // read before paying: nothing between the payout and its entry can fail
    const release = await this.payOnce(`release:${hash}`, claim.solver_ua, out, memo.release(hash));
    if (typeof release !== 'string') return release;
    const entry = this.logAt('SETTLED', hash, null, { user: s.intent.user, nonce: s.intent.nonce, funding_txid: fundingTxid, fill_txid: claim.fill_txid, release_txid: release, solver: claim.solver, fill_binding: binding, released_zat: out.toString() }, at, 'SETTLED');
    return { status: 'SETTLED', reason: null, entry, payoutTxid: release };
  }

  /** The user asks for its escrow back. Only once the deadline and the claim window have passed, and
   *  if nothing settled it. */
  refund(s: SignedIntent, fundingTxid: string): Promise<Decision | Pending | Unfunded> {
    return this.exclusive(() => this.refundNow(s, fundingTxid));
  }

  private async refundNow(s: SignedIntent, fundingTxid: string): Promise<Decision | Pending | Unfunded> {
    const a = await this.admit(s, fundingTxid, true);
    if ('status' in a) return a;
    const { hash } = a;
    const tip = await this.c.tip();
    if (tip <= s.intent.deadline_height) return this.reject(hash, 'NOT_EXPIRED_YET', { tip: String(tip), deadline: String(s.intent.deadline_height) });
    if (tip <= s.intent.deadline_height + this.claimWindow) return this.reject(hash, 'CLAIM_WINDOW_OPEN', { tip: String(tip), deadline: String(s.intent.deadline_height), refund_after: String(s.intent.deadline_height + this.claimWindow) });
    this.remember(s, hash);
    const out = BigInt(s.intent.pay_zat) - FEE_BUDGET_ZAT;
    const refund = await this.payOnce(`refund:${hash}`, s.intent.refund_ua, out, memo.refund(hash));
    if (typeof refund !== 'string') return refund;
    const entry = this.logAt('REFUNDED', hash, null, { user: s.intent.user, nonce: s.intent.nonce, funding_txid: fundingTxid, refund_txid: refund, refunded_zat: out.toString() }, tip, 'REFUNDED');
    return { status: 'REFUNDED', reason: null, entry, payoutTxid: refund };
  }

  /** Puts the current head, and the txid of the previous anchor, in a shielded memo from the escrow
   *  to the public anchor address, then logs that. Anchors chain: a second head anchored after the
   *  same anchor is a fork anyone can see in the escrow's history (checkAnchors). */
  anchor(anchorUa: string, amountZat = 10_000n): Promise<{ entry: LogEntry; txid: string; head: string; seq: number; prev: string }> {
    return this.exclusive(() => this.anchorNow(anchorUa, amountZat));
  }

  private async anchorNow(anchorUa: string, amountZat: bigint): Promise<{ entry: LogEntry; txid: string; head: string; seq: number; prev: string }> {
    const at = await this.c.tip();
    this.logPaidAnchors(at);
    const head = this.state.log[this.state.log.length - 1]?.hash;
    if (!head) throw new Error('nothing to anchor');
    const seq = this.state.log.length - 1;
    const prev = [...this.state.log].reverse().find((e) => e.status === 'ANCHORED')?.refs.anchor_txid ?? GENESIS;
    const txid = await this.payOnce(`anchor:${seq}:${head}`, anchorUa, amountZat, memo.anchor(seq, head, prev));
    if (typeof txid !== 'string') throw new Error(txid.reason);
    const entry = this.logAt('ANCHORED', null, null, { anchor_txid: txid, anchored_seq: String(seq), anchored_head: head, prev_anchor_txid: prev }, at);
    return { entry, txid, head, seq, prev };
  }

  /** An anchor that went out but whose ANCHORED entry was never written (the process stopped in
   *  between) is logged first, with the previous anchor its memo named, so the next anchor names it
   *  and the chain does not fork. */
  private logPaidAnchors(at: number) {
    const logged = new Set(this.state.log.filter((e) => e.status === 'ANCHORED').map((e) => e.refs.anchor_txid));
    const unlogged = Object.entries(this.state.payouts)
      .filter(([k, txid]) => k.startsWith('anchor:') && !logged.has(txid))
      .map(([k, txid]) => ({ k, txid, seq: Number(k.split(':')[1]) }))
      .sort((a, b) => a.seq - b.seq);
    for (const { k, txid } of unlogged) {
      const m = readAnchorMemo(this.state.payout_memos?.[k]);
      if (!m) throw new Error(`anchor ${txid} (${k}) went out but is not in the log, and its memo is not recorded; reconcile it from the escrow's history before anchoring again`);
      this.logAt('ANCHORED', null, null, { anchor_txid: txid, anchored_seq: String(m.seq), anchored_head: m.head, ...(m.prev === null ? {} : { prev_anchor_txid: m.prev }) }, at);
    }
  }
}
