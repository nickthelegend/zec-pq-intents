# Yaksok — post-quantum intents, settled in shielded ZEC

**Post-quantum intents, settled in shielded ZEC.** An intent is signed with **ML-DSA-65** (FIPS 204)
and sealed to the solver with **ML-KEM-768** (FIPS 203). The user escrows real testnet ZEC, the
solver delivers from its own liquidity to the user's fresh address, and a verifier releases the
escrow or refunds it, writing every decision as an ML-DSA-signed, hash-chained log entry whose head
is anchored in a shielded memo. Anyone can re-verify all of it.

Zcash spends stay elliptic-curve based: this is post-quantum **at the intent layer**, using the NIST
primitives Zcash's roadmap introduces later (ML-KEM with Tachyon). Not trustless: the verifier holds
the escrow (see [docs](packages/docs/README.md)).

**Review, Oct 21:** [`docs/JUDGE-2026-10-21.md`](docs/JUDGE-2026-10-21.md) found that any key could
claim a solver's fill and that settle and refund could both pay. Both are fixed with tests, along
with the claim window, the desk's board, ticks, refunds and HTTP rules, the MCP trust pins and
canonical base64. The review also lists what is still open.

## Live on Zcash testnet

Run of Oct 20, 2026 (`deployments/testnet.json`). Demo-only wallets; their incoming viewing keys
and the signed intents are published so every decision can be re-checked. Verifier key
`f60f130579…` (ML-DSA-65), solver KEM key `7dded232ab…` (ML-KEM-768).

Three intents (escrow 60,000 zat → deliver 40,000 zat; a release or refund pays 60,000 − 15,000 fee budget = 45,000 zat), funded together in one shielded transaction:
**A** (`48a440a6…`) and **B** (`85de1ac4…`) were filled and settled; **C** (`0c9bdfce…`, 12-block
deadline) was attacked twice and refunded.

| # | Entry | Reason | Transactions |
|---|---|---|---|
| 0 | SETTLED | — | funding [`1d6b3868…`](https://testnet.zcashexplorer.app/transactions/1d6b38683c64a5e157af4cbfed344dca3604c28242f178de83894654b68354d9), fill [`2970d8ba…`](https://testnet.zcashexplorer.app/transactions/2970d8ba4538bdfae599a64d016c65231e42addb544ccdc1a609f17df59448cb), release [`9800b912…`](https://testnet.zcashexplorer.app/transactions/9800b912682a0630a64dd4a54c245fc7c0810ee117eed7b304138fddda63b7c2) |
| 1 | SETTLED | — | funding [`1d6b3868…`](https://testnet.zcashexplorer.app/transactions/1d6b38683c64a5e157af4cbfed344dca3604c28242f178de83894654b68354d9), fill [`a74b9dfe…`](https://testnet.zcashexplorer.app/transactions/a74b9dfe4a74304078f77b80eb27c7a2653f263562874dc14bb6a6a072307dd1), release [`6b34215c…`](https://testnet.zcashexplorer.app/transactions/6b34215c46c7aff1e2924a8f8608b0cc17f376f254e10c4f027ad766111718d9) |
| 2 | REJECTED | FILL_NOT_CREDITED:MEMO_MISMATCH+AMOUNT_TOO_LOW | fill [`36d0f49a…`](https://testnet.zcashexplorer.app/transactions/36d0f49acbcb0498073393f554c135697cb5c0bccc6ce788deb6b3c3a05bc33a) |
| 3 | REJECTED | BAD_SIGNATURE | funding [`1d6b3868…`](https://testnet.zcashexplorer.app/transactions/1d6b38683c64a5e157af4cbfed344dca3604c28242f178de83894654b68354d9) |
| 4 | REJECTED | ALREADY_SETTLED | funding [`1d6b3868…`](https://testnet.zcashexplorer.app/transactions/1d6b38683c64a5e157af4cbfed344dca3604c28242f178de83894654b68354d9) |
| 5 | REJECTED | NONCE_REUSED | funding [`1d6b3868…`](https://testnet.zcashexplorer.app/transactions/1d6b38683c64a5e157af4cbfed344dca3604c28242f178de83894654b68354d9) |
| 6 | REJECTED | WRONG_KEY | funding [`1d6b3868…`](https://testnet.zcashexplorer.app/transactions/1d6b38683c64a5e157af4cbfed344dca3604c28242f178de83894654b68354d9) |
| 7 | REJECTED | EXPIRED | fill [`3b81e337…`](https://testnet.zcashexplorer.app/transactions/3b81e337b0669f97ad0f8c4a02a0e332a412a65276fbb5db0088704c6c39b1bb) |
| 8 | REFUNDED | — | funding [`1d6b3868…`](https://testnet.zcashexplorer.app/transactions/1d6b38683c64a5e157af4cbfed344dca3604c28242f178de83894654b68354d9), refund [`357b7065…`](https://testnet.zcashexplorer.app/transactions/357b706505ae07232939aa39fe7a862363283b49a06e4a62fafc6eaa823a2966) |
| 9 | ANCHORED | — | anchor [`a7d96038…`](https://testnet.zcashexplorer.app/transactions/a7d960386f2d8dc926003e700b15bcc761b6e72419765ea6f958a85d73a65a73) |

What the rejections were: #2 the solver "filled" C with the wrong memo; #3 A with `min_out` changed
to 1 after signing; #4 A again after it settled; #5 a new intent reusing A's nonce; #6 an intent
signed by another ML-DSA key but naming the user; #7 a correct fill of C mined after its deadline.
The anchor memo `pqi1:anchor:8:<head>` was found on-chain with the anchor's viewing key and equals
the recomputed head of entries 0–8. Every payout was re-read with the recipient's viewing key.

## Packages

| Package | What |
|---|---|
| [`packages/protocol`](packages/protocol) | canonical intents, ML-DSA-65 signatures, ML-KEM-768 + AES-256-GCM envelopes, fill attestations, signed hash-chained log (browser-safe) |
| [`packages/node`](packages/node) | verifier (escrow, checks, payouts, log), solver (open, quote, deliver, claim), desk (board + state machine + HTTP), live/published server |
| [`packages/scan`](packages/scan) | `zpay-verify` (copy): viewing-key checks of every funding, fill, payout and anchor; `tip` |
| [`packages/mcp`](packages/mcp) | `pqi-mcp`: `quote`, `submit_intent`, `status`, `verify_log` |
| [`packages/examples`](packages/examples) | the resumable live run above |
| [`packages/dashboard`](packages/dashboard) | the Yaksok terminal: intent book, attestation tape re-verified in the browser, inspector, anchor, attack console |
| [`packages/docs`](packages/docs) | protocol, rejections, trust model, roadmap sources |
| [`packages/landing`](packages/landing) | one-page landing generated from the run record; its tape re-verifies in the browser too |

## Run it

Needs Node 22+, pnpm 10, Rust 1.89 (pinned in `packages/scan`).

```sh
pnpm install
pnpm test                                    # 37 tests + doc: protocol 11, scan 3 + doc, node 17, mcp 6 (node and mcp read Zcash testnet)
pnpm --filter @pqi/dashboard dev             # http://localhost:5181
PQI_PUBLISHED=deployments/testnet.json pnpm --filter @pqi/node serve    # read-only desk for the MCP server
# MCP server: node packages/mcp/dist/main.js with PQI_VERIFIER_ID=f60f1305… (verify_log needs the key you trust)
node packages/landing/build.mjs              # regenerate the landing from deployments/testnet.json
PQI_FUNDER_WALLET=<demo wallet> pnpm --filter @pqi/examples run-live    # a new live run
```

Demo video: `zec-pq-intents-demo.mp4` (shared separately until hosted).

## Honest limits

- The verifier holds the escrow and is trusted for liveness (it could withhold a payout); it cannot
  fake the record without the signatures, links or anchors showing it.
- The solver and the verifier see plaintext intents. The escrow viewing key is public, so funding
  amounts and intent hashes are visible. The run used one receive address for all three intents.
  The on-chain notes are ECC-encrypted, so a future quantum adversary could link funding and fill.
- Only configured solver keys are paid. With several solvers, one could still claim another's fill.
- Anchors are periodic and go to the verifier's own address (equivocation would need a full scan to
  catch). One confirmation is accepted, and a crash between broadcast and save could pay twice.
- Only ZEC on testnet: delivery intents, no cross-asset leg.
- Testnet only, not audited, single verifier key. Portfolio piece; the Zecathon entry is Shielded x402.

MIT — Copyright (c) 2026 Nivesh Gajengi.
