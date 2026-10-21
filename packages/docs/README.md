# Yaksok: protocol, trust model and the Zcash post-quantum roadmap

## What it is

A **delivery intent**: "deliver at least `min_out_zat` to my fresh address `receive_ua` before block
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
                            deliver to receive_ua ─────────────────────────────────────────► pqi1:<hash>:fill
                            sign fill claim ──────────────► check intent sig, nonce, funding,
                                                            claim key is a configured solver,
                                                            fill seen by receive UIVK, by deadline
                                                            release escrow to solver ──────────► pqi1:<hash>:release
                                                            append signed SETTLED entry
after deadline + 10-block claim window, nothing settled:    refund escrow to refund_ua ────────► pqi1:<hash>:refund
                                                            append signed REFUNDED entry
periodically:                                               log head in a memo ────────────────► pqi1:anchor:<seq>:<head>
```

## What the verifier rejects (each is a signed `REJECTED` entry with its reason)

| Attack | Check | Reason |
|---|---|---|
| intent changed after signing | ML-DSA-65 over the canonical intent | `BAD_SIGNATURE` |
| intent signed by another key, naming the user | sha256(signing key) must equal `intent.user` | `WRONG_KEY` |
| the same intent settled twice | closed set | `ALREADY_SETTLED` / `ALREADY_REFUNDED` |
| a new intent reusing a nonce | user → nonce → first intent | `NONCE_REUSED` |
| a fill claimed by someone who did not make it (e.g. the user, who sees the fill txid) | the claim's ML-DSA key must be one of the verifier's configured solver keys | `FILL_UNKNOWN_SOLVER` |
| fill with the wrong memo or amount | receive UIVK must see `pqi1:<hash>:fill` ≥ min_out | `FILL_NOT_CREDITED:…` |
| fill mined after the deadline | fill height ≤ deadline | `EXPIRED` |
| escrow not funded (or too little, or late) | escrow UIVK must see `pqi1:<hash>` ≥ pay by the deadline | `NOT_FUNDED:…`, `FUNDED_AFTER_DEADLINE` |
| refund before the deadline | tip > deadline | `NOT_EXPIRED_YET` |
| refund inside the claim window (a fill mined by the deadline may still be claimed) | tip > deadline + 10 | `CLAIM_WINDOW_OPEN` |
| a signature or key in a second base64 spelling | canonical base64 only | `BAD_ENCODING` |

A transaction that is not mined yet is not a decision: nothing is logged (`PENDING`). Decisions run
one at a time, so a settle and a refund (or two settles) of the same intent cannot both pay.

**Desk rules.** An envelope is opened when it is posted. If it does not open with the solver's key to
a signed intent with that hash, it is refused and never takes the hash's place on the board. One
tick runs at a time. An intent that is declined, rejected or never filled is refunded by the
verifier once the deadline and the claim window have passed. The solver declines intents with
fewer than 3 blocks left. POSTs need an `application/json` body of at most 64 KiB, so a page on
another site cannot trigger them. Reads stay open (CORS `*`).

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
  solver keys are paid, so the user or an observer cannot claim the solver's fill (until Oct 21 any
  key could: see `docs/JUDGE-2026-10-21.md`). With several solvers, one configured solver could
  still claim another's fill. The fix is a fill memo that names the solver, and it is not built.
- **Board:** holds ciphertext, intent hashes and funding txids.
- **What ML-KEM protects, and what it does not.** The envelope (receive address, its viewing key,
  refund address, amounts, deadline) is sealed with ML-KEM-768, so recording the board today and
  breaking ECC later does not open it. The on-chain legs are ordinary Zcash notes, encrypted with
  elliptic-curve keys: a future quantum adversary holding the chain could read the funding and
  fill memos (`pqi1:<hash>…`) and amounts and link them. This is the gap Zcash's own ML-KEM step
  addresses.
- **Privacy today:** the escrow's viewing key is published, so anyone can see each funding's
  amount, time and intent hash. The verifier reads the signed intent, and the published run
  includes it. The solver and verifier learn amounts and addresses. The demo run used one receive
  address for all three intents, so those deliveries are linkable. Timing can link a funding and
  a fill on a quiet testnet.
- **Anchors:** the head is anchored periodically in a memo to the verifier's own anchor address.
  Entries after the last anchor are not covered yet (`verify_log` reports how many). A verifier
  could anchor two different heads, and only a scan of every note the anchor viewing key can see
  would catch that. 1 confirmation is accepted for funding and fills.

## Zcash post-quantum roadmap (sources)

- ZIP 2005 (quantum recoverability) does "not by itself make the protocol secure against quantum
  adversaries": https://zips.z.cash/zip-2005
- Three steps: quantum recoverability, then ML-KEM with Tachyon, then a fully post-quantum pool
  (CoinDesk research): https://www.coindesk.com/research/building-the-zcash-machine-tachyon-and-quantum-readiness

## Do X → see Y

| Do | See |
|---|---|
| `pnpm --filter @pqi/protocol test` | ML-DSA/ML-KEM sizes, every tamper caught, canonical base64, the log re-verifies (11 tests) |
| `pnpm --filter @pqi/node test` | the published run re-checked on testnet; fill theft, settle/refund races and the claim window refused; desk board, ticks, refunds and HTTP rules (17 tests) |
| open the dashboard | every log entry's ML-DSA-65 signature re-verified in your browser, the chain linked |
| dashboard → "Change a field" | the intent no longer verifies (`BAD_SIGNATURE`) |
| `PQI_PUBLISHED=deployments/testnet.json pnpm --filter @pqi/node serve` + MCP `verify_log` with `PQI_VERIFIER_ID=f60f1305…` | ok, entry counts, the anchor memo found on-chain and matching the head, 1 entry after the anchor |

## Pre-existing work

Ideas from near-pq-confidential-intents (superseded) and the zec-* builds. The scan binary is copied
from zec-payment-verify-sdk; the zingo-cli wrapper from zec-sealed-bid-auction. Built Oct 20, 2026.
