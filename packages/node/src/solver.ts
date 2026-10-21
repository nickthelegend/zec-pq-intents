// The solver: opens envelopes sealed to its ML-KEM key, checks the user's signature and that the
// escrow is funded (with the escrow's published viewing key), decides on a fee, delivers from its own
// shielded wallet to the user's receive address with memo pqi1:<hash>:fill:<its key id>, and signs a
// fill claim with that same key.
import { keyId, memo, open, signFill, type Envelope, type FillClaim, type KemKey, type SignedIntent, type SigningKey } from '@pqi/protocol';
import { scan, type ScanResult } from './scan.js';
import { confirmationsAt, MIN_CONFIRMATIONS } from './verifier.js';
import { quicksend, type ZingoConfig } from './zingo.js';

/** Blocks a fill needs to be mined by the deadline with room to spare (testnet blocks are ~75 s). */
export const MIN_BLOCKS_LEFT = 3;

export interface SolverConfig {
  sign: SigningKey;
  kem: KemKey;
  wallet: string;
  ua: string;
  escrowUivk: string;
  zingo: ZingoConfig;
  /** least the solver keeps: pay_zat - min_out_zat must cover this */
  minFeeZat: bigint;
  /** default MIN_BLOCKS_LEFT: decline an intent whose deadline is closer than this */
  minBlocksLeft?: number;
  /** default MIN_CONFIRMATIONS: the escrow funding must be this deep before the solver delivers */
  minConfirmations?: number;
}

export type Quote = { accept: true; feeZat: bigint } | { accept: false; reason: string };

export class Solver {
  constructor(private readonly c: SolverConfig) {}

  /** Decrypt and check an envelope. Throws ProtocolError if it is not for this solver or is forged. */
  open(e: Envelope): SignedIntent {
    return open(e, this.c.kem);
  }

  quote(s: SignedIntent, tip: number): Quote {
    const fee = BigInt(s.intent.pay_zat) - BigInt(s.intent.min_out_zat);
    if (fee < this.c.minFeeZat) return { accept: false, reason: `fee ${fee} zat is below ${this.c.minFeeZat}` };
    const left = s.intent.deadline_height - tip;
    const need = this.c.minBlocksLeft ?? MIN_BLOCKS_LEFT;
    if (left < need) return { accept: false, reason: `deadline ${s.intent.deadline_height} is ${left} block(s) away (tip ${tip}); a fill needs ${need} to be mined in time` };
    return { accept: true, feeZat: fee };
  }

  /** The escrow funding, as the escrow's viewing key sees it, and at least minConfirmations deep at
   *  `tip` (otherwise not ok, with reason NOT_CONFIRMED (k of N)). */
  async funded(hash: string, s: SignedIntent, fundingTxid: string, tip: number): Promise<ScanResult> {
    const r = await scan(this.c.escrowUivk, fundingTxid, BigInt(s.intent.pay_zat), memo.funding(hash));
    const need = this.c.minConfirmations ?? MIN_CONFIRMATIONS;
    const have = confirmationsAt(r.height, tip);
    if (r.ok && have < need) return { ...r, ok: false, reasons: [`NOT_CONFIRMED (${have} of ${need})`] };
    return r;
  }

  /** keyId of the solver's ML-DSA-65 key, which its fill memos name. */
  get id(): string {
    return keyId(this.c.sign.publicKey);
  }

  /** Pays the user's receive address, naming this solver in the memo. `memoOverride` exists only to
   *  stage the wrong-memo attack. */
  async deliver(hash: string, s: SignedIntent, memoOverride?: string): Promise<string> {
    for (let i = 0; ; i++) {
      try {
        const [txid] = await quicksend(this.c.zingo, this.c.wallet, [{ address: s.intent.receive_ua, amount: BigInt(s.intent.min_out_zat), memo: memoOverride ?? memo.fill(hash, this.id) }]);
        return txid;
      } catch (e) {
        if (!/Insufficient balance/.test((e as Error).message) || i >= 20) throw e;
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
  }

  claim(hash: string, fillTxid: string): FillClaim {
    return signFill(this.c.sign, hash, fillTxid, this.c.ua);
  }
}
