// The verifier: holds the escrow wallet and the log key. It decides, from what the chain shows
// through viewing keys and what the signatures say, whether an intent is SETTLED (escrow released to
// the solver), REFUNDED (deadline passed, escrow back to the user) or REJECTED, and appends an
// ML-DSA-65 signed entry for every decision. It is trusted to act on its decisions (it holds the
// escrow); anyone can re-check every decision and signature from the published log.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { appendEntry, intentHash, memo, ProtocolError, verifyFill, verifyIntent, verifyLog, type FillClaim, type LogEntry, type LogStatus, type SignedIntent, type SigningKey } from '@pqi/protocol';
import { scan, type ScanResult } from './scan.js';
import { quicksend, type ZingoConfig } from './zingo.js';

/** The escrow keeps this much of each deposit to pay the release/refund transaction fee. */
export const FEE_BUDGET_ZAT = 15_000n;

export interface VerifierState {
  log: LogEntry[];
  /** user key id → nonce → the intent hash that used it (set when that intent settles or is refunded) */
  nonces: Record<string, Record<string, string>>;
  /** intent hash → final status */
  closed: Record<string, 'SETTLED' | 'REFUNDED'>;
  /** decisions already paid out on-chain, so a restart never pays twice: key → txid */
  payouts: Record<string, string>;
}

export interface VerifierConfig {
  key: SigningKey;
  escrowWallet: string;
  escrowUa: string;
  escrowUivk: string;
  /** keyIds of the solver ML-DSA keys whose fill claims this verifier pays. A claim signed by any
   *  other key is refused, so nobody can claim a fill they did not make. */
  solvers: string[];
  zingo: ZingoConfig;
  statePath: string;
  /** current chain height */
  tip: () => Promise<number>;
}

export type Decision = { status: LogStatus; reason: string | null; entry: LogEntry; payoutTxid?: string };
/** Not decided yet (a transaction is not mined); nothing is logged. */
export type Pending = { status: 'PENDING'; reason: string };
const onlyUnconfirmed = (reasons: string[]) => reasons.length > 0 && reasons.every((r) => r === 'NOT_CONFIRMED');

export class Verifier {
  readonly state: VerifierState;
  constructor(private readonly c: VerifierConfig) {
    this.state = existsSync(c.statePath) ? JSON.parse(readFileSync(c.statePath, 'utf8')) : { log: [], nonces: {}, closed: {}, payouts: {} };
    const check = verifyLog(this.state.log, c.key.publicKey);
    if (!check.ok) throw new Error(`stored log does not verify at entry ${check.error?.seq}: ${check.error?.problem}`);
  }

  private save() {
    writeFileSync(`${this.c.statePath}.tmp`, JSON.stringify(this.state, null, 2));
    renameSync(`${this.c.statePath}.tmp`, this.c.statePath);
  }

  private async log(status: LogStatus, intent_hash: string | null, reason: string | null, refs: Record<string, string>): Promise<LogEntry> {
    const e = appendEntry(this.state.log, this.c.key, { status, intent_hash, reason, refs, at_height: await this.c.tip() });
    this.save();
    return e;
  }

  private reject = async (hash: string | null, reason: string, refs: Record<string, string> = {}): Promise<Decision> => ({ status: 'REJECTED', reason, entry: await this.log('REJECTED', hash, reason, refs) });

  /** Pays once per key: the txid is stored before the decision is logged. */
  private async payOnce(key: string, to: string, amount: bigint, m: string): Promise<string> {
    if (this.state.payouts[key]) return this.state.payouts[key];
    for (let i = 0; ; i++) {
      try {
        const [txid] = await quicksend(this.c.zingo, this.c.escrowWallet, [{ address: to, amount, memo: m }]);
        this.state.payouts[key] = txid;
        this.save();
        return txid;
      } catch (e) {
        if (!/Insufficient balance/.test((e as Error).message) || i >= 20) throw e;
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
  }

  private async funding(hash: string, fundingTxid: string, payZat: bigint): Promise<ScanResult> {
    return scan(this.c.escrowUivk, fundingTxid, payZat, memo.funding(hash));
  }

  /** Common checks on the user's signed intent: signature, key binding, nonce, funding. */
  /** `forRefund`: a deposit mined after the deadline still has to be refundable, so skip that check. */
  private async admit(s: SignedIntent, fundingTxid: string, forRefund = false): Promise<{ hash: string; fund: ScanResult } | Decision | Pending> {
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
    if (this.state.closed[hash]) return this.reject(hash, `ALREADY_${this.state.closed[hash]}`, { funding_txid: fundingTxid });
    const firstUse = this.state.nonces[s.intent.user]?.[s.intent.nonce];
    if (firstUse && firstUse !== hash) return this.reject(hash, 'NONCE_REUSED', { funding_txid: fundingTxid, first_use: firstUse });
    if (s.intent.escrow !== this.c.escrowUa) return this.reject(hash, 'WRONG_ESCROW', { funding_txid: fundingTxid });
    const fund = await this.funding(hash, fundingTxid, BigInt(s.intent.pay_zat));
    if (onlyUnconfirmed(fund.reasons)) return { status: 'PENDING', reason: 'funding not mined yet' };
    if (!fund.ok) return this.reject(hash, `NOT_FUNDED:${fund.reasons.join('+')}`, { funding_txid: fundingTxid });
    if (!forRefund && fund.height !== null && fund.height > s.intent.deadline_height) return this.reject(hash, 'FUNDED_AFTER_DEADLINE', { funding_txid: fundingTxid });
    return { hash, fund };
  }

  private remember(s: SignedIntent, hash: string) {
    (this.state.nonces[s.intent.user] ??= {})[s.intent.nonce] = hash;
    this.save();
  }

  /** A solver claims it filled `s`. On success the escrow pays the solver and the entry is SETTLED. */
  async settle(s: SignedIntent, fundingTxid: string, claim: FillClaim): Promise<Decision | Pending> {
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
    const fill = await scan(s.intent.receive_uivk, claim.fill_txid, BigInt(s.intent.min_out_zat), memo.fill(hash));
    if (onlyUnconfirmed(fill.reasons)) return { status: 'PENDING', reason: 'fill not mined yet' };
    if (!fill.ok) return this.reject(hash, `FILL_NOT_CREDITED:${fill.reasons.join('+')}`, { fill_txid: claim.fill_txid });
    if (fill.height === null || fill.height > s.intent.deadline_height) return this.reject(hash, 'EXPIRED', { fill_txid: claim.fill_txid, fill_height: String(fill.height), deadline: String(s.intent.deadline_height) });
    this.remember(s, hash);
    const out = BigInt(s.intent.pay_zat) - FEE_BUDGET_ZAT;
    const release = await this.payOnce(`release:${hash}`, claim.solver_ua, out, memo.release(hash));
    this.state.closed[hash] = 'SETTLED';
    const entry = await this.log('SETTLED', hash, null, { user: s.intent.user, nonce: s.intent.nonce, funding_txid: fundingTxid, fill_txid: claim.fill_txid, release_txid: release, solver: claim.solver, released_zat: out.toString() });
    return { status: 'SETTLED', reason: null, entry, payoutTxid: release };
  }

  /** The user asks for its escrow back. Only after the deadline and if nothing settled it. */
  async refund(s: SignedIntent, fundingTxid: string): Promise<Decision | Pending> {
    const a = await this.admit(s, fundingTxid, true);
    if ('status' in a) return a;
    const { hash } = a;
    const tip = await this.c.tip();
    if (tip <= s.intent.deadline_height) return this.reject(hash, 'NOT_EXPIRED_YET', { tip: String(tip), deadline: String(s.intent.deadline_height) });
    this.remember(s, hash);
    const out = BigInt(s.intent.pay_zat) - FEE_BUDGET_ZAT;
    const refund = await this.payOnce(`refund:${hash}`, s.intent.refund_ua, out, memo.refund(hash));
    this.state.closed[hash] = 'REFUNDED';
    const entry = await this.log('REFUNDED', hash, null, { user: s.intent.user, nonce: s.intent.nonce, funding_txid: fundingTxid, refund_txid: refund, refunded_zat: out.toString() });
    return { status: 'REFUNDED', reason: null, entry, payoutTxid: refund };
  }

  /** Puts the current head in a shielded memo to the public anchor address, then logs that. */
  async anchor(anchorUa: string, amountZat = 10_000n): Promise<{ entry: LogEntry; txid: string; head: string; seq: number }> {
    const head = this.state.log[this.state.log.length - 1]?.hash;
    if (!head) throw new Error('nothing to anchor');
    const seq = this.state.log.length - 1;
    const txid = await this.payOnce(`anchor:${seq}:${head}`, anchorUa, amountZat, memo.anchor(seq, head));
    const entry = await this.log('ANCHORED', null, null, { anchor_txid: txid, anchored_seq: String(seq), anchored_head: head });
    return { entry, txid, head, seq };
  }
}
