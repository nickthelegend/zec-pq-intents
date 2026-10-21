// The solver: opens envelopes sealed to its ML-KEM key, checks the user's signature and that the
// escrow is funded (with the escrow's published viewing key), decides on a fee, delivers from its own
// shielded wallet to the user's fresh address with memo pqi1:<hash>:fill, and signs a fill claim.
import { memo, open, signFill, type Envelope, type FillClaim, type KemKey, type SignedIntent, type SigningKey } from '@pqi/protocol';
import { scan } from './scan.js';
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

  /** The escrow funding, as the escrow's viewing key sees it. */
  funded(hash: string, s: SignedIntent, fundingTxid: string) {
    return scan(this.c.escrowUivk, fundingTxid, BigInt(s.intent.pay_zat), memo.funding(hash));
  }

  /** Pays the user's receive address. `memoOverride` exists only to stage the wrong-memo attack. */
  async deliver(hash: string, s: SignedIntent, memoOverride?: string): Promise<string> {
    for (let i = 0; ; i++) {
      try {
        const [txid] = await quicksend(this.c.zingo, this.c.wallet, [{ address: s.intent.receive_ua, amount: BigInt(s.intent.min_out_zat), memo: memoOverride ?? memo.fill(hash) }]);
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
