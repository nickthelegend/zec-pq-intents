# Protocol, trust model and the Zcash post-quantum roadmap

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
                                                            fill seen by receive UIVK, by deadline
                                                            release escrow to solver ──────────► pqi1:<hash>:release
                                                            append signed SETTLED entry
after deadline, no valid fill:                              refund escrow to refund_ua ────────► pqi1:<hash>:refund
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
| fill with the wrong memo or amount | receive UIVK must see `pqi1:<hash>:fill` ≥ min_out | `FILL_NOT_CREDITED:…` |
| fill mined after the deadline | fill height ≤ deadline | `EXPIRED` |
| escrow not funded (or too little, or late) | escrow UIVK must see `pqi1:<hash>` ≥ pay by the deadline | `NOT_FUNDED:…`, `FUNDED_AFTER_DEADLINE` |
| refund before the deadline | tip > deadline | `NOT_EXPIRED_YET` |

A transaction that is not mined yet is not a decision: nothing is logged (`PENDING`).

## Trust model

- **Verifier:** holds the escrow wallet, so it could withhold a release or a refund. It cannot
  fake a decision without it showing: every entry is ML-DSA signed and hash-chained, the head is
  anchored on-chain, and every input (intent, signatures, funding, fill, payout) can be re-checked
  with the published keys and viewing keys. It is trusted for liveness, not for honesty of record.
- **Solver:** sees the plaintext intent (it must, to fill it) and chooses whether to fill. It
  cannot change the intent (signature), claim someone else's fill (memo binds the intent hash and
  the receive UIVK sees only real outputs), or claim late.
- **Board:** holds only ciphertext and intent hashes. ML-KEM-768 protects the intents against
  harvest-now-decrypt-later.
- **Privacy limits:** funding, fill and payouts are shielded (Ironwood), but the verifier and solver
  learn amounts and addresses. Timing can link a funding and a fill on a quiet testnet.

## Zcash post-quantum roadmap (sources)

- ZIP 2005 (quantum recoverability) does "not by itself make the protocol secure against quantum
  adversaries": https://zips.z.cash/zip-2005
- Three steps: quantum recoverability, then ML-KEM with Tachyon, then a fully post-quantum pool
  (CoinDesk research): https://www.coindesk.com/research/building-the-zcash-machine-tachyon-and-quantum-readiness

## Do X → see Y

| Do | See |
|---|---|
| `pnpm --filter @pqi/protocol test` | ML-DSA/ML-KEM sizes, every tamper caught, the log re-verifies (10 tests) |
| open the dashboard | every log entry's ML-DSA-65 signature re-verified in your browser, the chain linked |
| dashboard → "Change a field" | the intent no longer verifies (`BAD_SIGNATURE`) |
| `PQI_PUBLISHED=deployments/testnet.json pnpm --filter @pqi/node serve` + MCP `verify_log` | ok, entry counts, the anchor memo found on-chain and matching the head |

## Pre-existing work

Ideas from near-pq-confidential-intents (superseded) and the zec-* builds. The scan binary is copied
from zec-payment-verify-sdk; the zingo-cli wrapper from zec-sealed-bid-auction. Built Oct 20, 2026.
