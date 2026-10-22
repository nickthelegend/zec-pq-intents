# Yaksok: protocol, trust model and the Zcash post-quantum roadmap

## What it is

A **delivery intent**: "deliver at least `min_out_zat` to my address `receive_ua` before block
`deadline_height`; I escrow `pay_zat` for it." A solver delivers from its own liquidity, so the
receiving address is funded by the solver, not by the user's wallet. The verifier then releases the
escrow to the solver, or refunds the user after the deadline. Testnet has only one asset (TAZ), so
both legs are ZEC; a cross-asset leg is not built.

The post-quantum part is the **intent layer**:

| Primitive | Standard | Used for |
|---|---|---|
| ML-DSA-65 | FIPS 204 | the user signs the intent; the solver signs its fill claim; the verifier signs every log entry |
| ML-KEM-768 | FIPS 203 | the intent is sealed to the solver's KEM key (+ HKDF-SHA256 + AES-256-GCM) |
| SHA-256 | FIPS 180-4 | intent hash, log hash chain, key ids |

Zcash spends themselves stay elliptic-curve based. This project does **not** make Zcash
post-quantum; it shows the intent layer can already use the NIST primitives that Zcash's roadmap
introduces later.

## Flow

```
user                       solver (ML-KEM key)            verifier (escrow + log key)        chain (shielded)
sign intent (ML-DSA) ──┐
seal to solver (ML-KEM)│
fund escrow ───────────┼────────────────────────────────────────────────────────────────► pqi1:<hash>
post envelope ─────────┴──► open, check signature,
                            check funding (escrow UIVK),
                            funding 3 blocks deep,
                            deliver to receive_ua ─────────────────────────────────────────► pqi1:<hash>:fill:<solver key id>
                            sign fill claim ──────────────► check intent sig, nonce, funding,
                                                            claim key is a configured solver,
                                                            fill seen by receive UIVK naming
                                                            that key, by deadline, both 3 deep
                                                            write-ahead record, then
                                                            release escrow to solver ──────────► pqi1:<hash>:release
                                                            append signed SETTLED entry
after deadline + 10-block claim window, nothing settled:    refund escrow to refund_ua ────────► pqi1:<hash>:refund
                                                            append signed REFUNDED entry
periodically:                                               log head + previous anchor ────────► pqi1:anchor:<seq>:<head>:<prev txid>
```

## What the verifier rejects (each is a signed `REJECTED` entry with its reason)

| Attack | Check | Reason |
|---|---|---|
| intent changed after signing | ML-DSA-65 over the canonical intent | `BAD_SIGNATURE` |
| intent signed by another key, naming the user | sha256(signing key) must equal `intent.user` | `WRONG_KEY` |
| the same intent settled twice | closed set | `ALREADY_SETTLED` / `ALREADY_REFUNDED` |
| a new intent reusing a nonce | user → nonce → first intent | `NONCE_REUSED` |
| a fill claimed by someone who did not make it (e.g. the user, who sees the fill txid) | the claim's ML-DSA key must be one of the verifier's configured solver keys | `FILL_UNKNOWN_SOLVER` |
| one configured solver claims a fill another solver paid | the fill memo must name the claiming key (only the payer writes the memo) | `FILL_BY_OTHER_SOLVER` |
| a fill whose memo names no solver (the Oct 20 form), outside the listed Oct 20 intents or with more than one solver key | `pqi1:<hash>:fill:<solver key id>` required | `FILL_NOT_SOLVER_BOUND` |
| a receive viewing key from another wallet (the user would keep the delivery, have the fill refused, and be refunded too) | `receive_uivk` must derive a shielded receiver of `receive_ua` (`zpay-verify owns`); the solver declines and pays only that receiver | `RECEIVE_KEY_MISMATCH` |
| fill with the wrong memo or amount | receive UIVK must see `pqi1:<hash>:fill:<solver>` ≥ min_out | `FILL_NOT_CREDITED:…` |
| fill mined after the deadline | fill height ≤ deadline | `EXPIRED` |
| escrow funded too little, or late | escrow UIVK must see `pqi1:<hash>` ≥ pay by the deadline | `NOT_FUNDED:…`, `FUNDED_AFTER_DEADLINE` (nothing at all under the memo: `NOT_FUNDED`, not signed, the intent is dropped) |
| an intent naming another escrow, funded here | `intent.escrow` must be this escrow (checked once funding is seen) | `WRONG_ESCROW` |
| an intent paying no more than the 15,000 zat fee budget (a payout of it would be zero or negative) | `pay_zat` > 15,000 | `PAY_BELOW_FEE_BUDGET` |
| refund before the deadline | tip > deadline | `NOT_EXPIRED_YET` |
| refund inside the claim window (a fill mined by the deadline may still be claimed) | tip > deadline + 10 | `CLAIM_WINDOW_OPEN` |
| a signature or key in a second base64 spelling | canonical base64 only | `BAD_ENCODING` |

A transaction that is not mined yet, or is fewer than 3 blocks deep (`minConfirmations`, counted
against the verifier's own tip), is not a decision: nothing is logged (`PENDING`). Decisions run one
at a time, so a settle and a refund (or two settles) of the same intent cannot both pay.

**Payouts are write-ahead.** Before a release, refund or anchor is broadcast, its recipient, amount,
unique memo and the height are saved and flushed to disk; the txid replaces that record after the
broadcast. If the process stops in between, the restarted verifier looks the memo up in the
escrow's history first. If it is there, that is the payout and nothing is sent. If it is not, the
verifier waits (`PAYOUT_UNRECONCILED`, `PENDING`) until a transaction built at that height has
expired (120 blocks on this testnet), so it can never be mined later, and only then tries again.

The decision's block height is read before its payout, and the intent is marked closed in the same
write that appends its SETTLED or REFUNDED entry, so nothing that can fail sits between a payout and
its entry. A state closed without its entry (from an older process) is finished on restart with the
recorded payout. An anchor that went out but was never logged is logged, with the previous anchor its
memo named, before the next anchor is sent, so the next one names it and the chain does not fork.

**Deliveries are write-ahead too.** Before the solver's fill is broadcast, the desk saves (fsync) a
record with its memo `pqi1:<hash>:fill:<solver key id>`, recipient, amount and height. After a
restart it looks that memo up in the solver's wallet history: found → that txid is the fill and
nothing is sent; not found → `DELIVERY_UNRECONCILED` until a transaction built then has expired.
Before every send, including a resumed or retried one, the solver's quote is run again at the
current tip, so a delivery that could no longer be mined by the deadline is declined and the
escrow is refunded instead.

**Desk rules.** An envelope is opened when it is posted. If it does not open with the solver's key to
a signed intent with that hash, it is refused and never takes the hash's place on the board. One
tick runs at a time, at one chain tip; an error on one intent (a failed wallet call, a timeout) is
written to that intent's note with a failure count and the tick goes on to the next, so one bad
intent cannot stop the others' settlements and refunds. Every lightwalletd call is asynchronous
and killed after `PQI_SCAN_TIMEOUT_MS` (90 s), so the desk keeps answering while the chain is slow.
A delivery the solver's wallet cannot fund yet is tried again from the next block, not slept on
inside the tick. An intent that is declined, rejected or never filled is refunded by the verifier
once the deadline and the claim window have passed. The solver declines intents with fewer than 3
blocks left, a deadline more than 1,000 blocks ahead, or `min_out` above its spendable balance.
POSTs need an `application/json` body of at most 64 KiB, and every request must name the desk as
`127.0.0.1:<port>` or `localhost:<port>` in its Host header (403 otherwise), so neither a page on
another site nor one that rebinds its own DNS name to 127.0.0.1 can trigger them. Reads stay open
(CORS `*`). **The signed log only records decisions about money that arrived:** an intent with
nothing at the escrow under its memo is dropped without a log entry (`NOT_FUNDED`, not signed),
including at refund time, and so is one with no funding seen within 100 blocks of reaching the
board; the board holds at most 1,000 open intents. Refusals that are properties of the signed
intent alone (`BAD_SIGNATURE`, `WRONG_KEY`, `PAY_BELOW_FEE_BUDGET`, `RECEIVE_KEY_MISMATCH`) are
signed when the verifier is called directly; the desk refuses those envelopes at the door or
declines them before any settle is asked for.

**Agents.** `verify_log` needs the verifier key id you trust (`PQI_VERIFIER_ID`), so the desk cannot
vouch for its own log. `submit_intent` signs and pays only if the desk's escrow and solver KEM key
match the agent's pinned ones.

## Trust model

- **Verifier:** holds the escrow wallet, so it could withhold a release or a refund. It cannot
  fake a decision without it showing: every entry is ML-DSA signed and hash-chained, the head is
  anchored on-chain, and every input (intent, signatures, funding, fill, payout) can be re-checked
  with the published keys and viewing keys. It is trusted for liveness, not for honesty of record.
- **Solver:** sees the plaintext intent (it must, to fill it) and chooses whether to fill. It
  cannot change the intent (signature) or claim late (fill height ≤ deadline). Only the configured
  solver keys are paid, and only the one the fill's memo names: only whoever paid the fill wrote
  that memo, so neither the user, an observer, nor another configured solver can claim it (see
  `docs/JUDGE-2026-10-21.md`). Before it delivers, the solver checks that the intent's
  `receive_uivk` derives a shielded receiver of `receive_ua` and pays only that receiver; the
  verifier refuses a claim on an intent where it does not (`RECEIVE_KEY_MISMATCH`), so a user
  cannot keep a delivery its own key hides and be refunded as well. The Oct 20 fills name no solver; they are honoured only as
  legacy single-solver fills, and the SETTLED entry says so.
- **Board:** holds ciphertext, intent hashes and funding txids.
- **What ML-KEM protects, and what it does not.** The envelope (receive address, its viewing key,
  refund address, amounts, deadline) is sealed with ML-KEM-768, so recording the board today and
  breaking ECC later does not open it. The on-chain legs are ordinary Zcash notes, encrypted with
  elliptic-curve keys: a future quantum adversary holding the chain could read the funding and
  fill memos (`pqi1:<hash>…`) and amounts and link them. This is the gap Zcash's own ML-KEM step
  addresses.
- **Privacy today:** the escrow's **full** viewing key is published (for auditability), so anyone
  can see every funding (amount, time, intent hash) and every payment out of the escrow: each
  release's recipient (the solver) and amount, each refund's recipient and amount, which is the
  user's refund address next to its `pqi1:<hash>:refund` memo, and each anchor. The verifier reads
  the signed intent, and the published runs include them. The solver and verifier learn amounts and
  addresses. All four live intents of the first two runs (A–D) used one receive address, so those
  deliveries are linkable; `submit_intent` now delivers each intent to a new address of the same
  receive key (an Orchard-type receiver at a random diversifier index; on this NU7 testnet the
  payments to it land in the Ironwood pool, as `zpay-verify inspect` of E's fill shows), which only
  that key links. That does not unlink one user's intents: every SETTLED or REFUNDED entry in the
  public log names the user's key id and nonce, and every refund shows the same refund address.
  Timing can link a funding and a fill on a quiet testnet.
- **Anchors:** the head is anchored periodically, from the escrow, in a memo to the public anchor
  address. Each anchor names the previous anchor's txid, so anchors form one chain. The escrow's
  full viewing key is published, and a view-only wallet made from it lists every payment out of
  the escrow, so every anchor the verifier ever sent can be listed by anyone. `checkAnchors` (CLI:
  `pnpm --filter @pqi/node check-anchors`, with the escrow address you trust pinned in
  `PQI_ESCROW_UA`: the source supplies the full viewing key, so the CLI reads nothing unless that key
  derives the pinned escrow and the source's intents name it) catches two heads anchored after the same anchor
  (`ANCHOR_FORK`), an anchor that names no previous anchor other than the Oct 20 one as the root
  (`ANCHOR_LEGACY_LATE`), any anchor that is not on the one chain (`ANCHOR_ORPHAN`), a log that hides an anchor, and a log that is not the one anchored. An anchor
  sent from any other wallet is not in the escrow's history, so a log that names one fails
  (`ANCHOR_NOT_IN_HISTORY`). Each audience has to run the check for this to hold. Not covered:
  entries after the last anchor (`verify_log` reports how many), and anchors past the end of the log
  you hold, which are listed as `later` and can only be checked with the rest of the log. Funding
  and fills need 3 confirmations; a reorg deeper than that is not handled.

## Zcash post-quantum roadmap (sources)

- ZIP 2005 (quantum recoverability) does "not by itself make the protocol secure against quantum
  adversaries": https://zips.z.cash/zip-2005
- Three steps: quantum recoverability, then ML-KEM with Tachyon, then a fully post-quantum pool
  (CoinDesk research): https://www.coindesk.com/research/building-the-zcash-machine-tachyon-and-quantum-readiness

## Do X → see Y

| Do | See |
|---|---|
| `pnpm --filter @pqi/protocol test` | ML-DSA/ML-KEM sizes, every tamper caught, canonical base64, the log re-verifies, fill memos name the solver, anchor forks caught, legacy-form anchors cannot hide one, a log cut short before the newest anchors fails (17 tests) |
| `pnpm --filter @pqi/node test` | the three published runs re-checked on testnet; fill theft by an outsider or another solver, settle/refund races, the claim window and shallow confirmations refused; a verifier process killed mid-payout reconciles on restart; every anchor the escrow sent checked against the logs; desk board, ticks, refunds and HTTP rules; the receive key checked; delivery write-ahead after a real kill; unfunded junk leaves no log entry; Setup required and the `check-anchors` pins; a short solver balance retried, a fill not yet found kept pending, deposits that fail a check refunded (67 tests) |
| `PQI_VERIFIER_ID=f60f130579386479043287fb68c2c1726a0a210be77aee46b355adb1287f1445 PQI_ESCROW_UA=utest1fgwtrf8nq6e2j6w7rwa06k8ggmc5llsk3v7mjjnpy5ywmdfrjzuqfvlm4wpeggn9lq7cutkum7k75v8zqg2rxlg3z0k67lcz3cmcs558 pnpm --filter @pqi/node check-anchors "$PWD/deployments/testnet-pass3.json"` | every anchor the escrow sent (view-only wallet from its published full viewing key, which must derive the escrow you pinned), one chain, checked against the log, none past its end (an older record needs `--allow-behind`) |
| open the dashboard | every log entry's ML-DSA-65 signature re-verified in your browser, the chain linked |
| dashboard → "Change a field" | the intent no longer verifies (`BAD_SIGNATURE`) |
| `PQI_PUBLISHED=deployments/testnet.json pnpm --filter @pqi/node serve` + MCP `verify_log` with `PQI_VERIFIER_ID=f60f130579386479043287fb68c2c1726a0a210be77aee46b355adb1287f1445` and `PQI_ANCHOR_UIVK` = the record's anchor `uivk` | ok, entry counts, every anchor memo found on-chain, matching the head and linked, 1 entry after the last anchor |

## Pre-existing work

Ideas from near-pq-confidential-intents (superseded) and the zec-* builds. The scan binary is copied
from zec-payment-verify-sdk; the zingo-cli wrapper from zec-sealed-bid-auction. Built Oct 20–22, 2026.
