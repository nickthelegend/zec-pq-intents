# Testing zec-pq-intents

No mocked clients, no stub RPCs. Chain-touching tests read Zcash testnet through a real lightwalletd
(`testnet.zec.rocks`); they are read-only (refusals never pay, so no wallet is used).

| Package | Runs against | Tests | What |
|---|---|---|---|
| protocol | local | 11 | FIPS 203/204 sizes; deterministic keygen; encodings; one base64 spelling per value (a re-spelled key is `BAD_ENCODING`); every intent field change breaks hash and signature; other-key signatures (`WRONG_KEY`); malformed intents; envelope opens only with the solver key, fails on a flipped bit or swapped hash; fill attestations; log edits, drops, reorders, foreign key, flipped signature bit caught |
| scan (Rust) | local | 3 + doc | payment rules (from zpay-verify) |
| node `live.test.ts` | Zcash testnet | 11 | published log verifies; funding of A/B/C seen by the escrow key; fills, wrong-memo fill, late fill seen by the receive key; releases, refund, anchor seen by their keys; a fresh verifier refuses BAD_SIGNATURE, WRONG_KEY, FILL_NOT_CREDITED, EXPIRED, ALREADY_SETTLED, NONCE_REUSED; **a claim on A's real fill by another key → FILL_UNKNOWN_SOLVER**; **settle + refund of A at once, and two settles of B at once, pay once**; **C one block after its deadline → CLAIM_WINDOW_OPEN** (clock held at deadline + 1, funding read from testnet), after the window → REFUNDED |
| node `desk.test.ts` | Zcash testnet + local | 4 | **a junk envelope under A's hash is refused**; **two ticks at once settle A once**; **a declined C is refunded after the claim window**; **POSTs need JSON ≤ 64 KiB and get no CORS header** |
| node `solver.test.ts` | local | 2 | **declines with < 3 blocks to the deadline**; minimum fee |
| mcp | stdio MCP client + desk + testnet | 6 | tools; `verify_log` (signatures, links, anchor memo on-chain, 1 entry after the anchor); **a desk serving a log re-signed by another key fails against `PQI_VERIFIER_ID`; unpinned is Setup required**; `status`, `quote`; **`submit_intent` refuses a desk whose escrow is not the pinned one, before signing or paying**; no desk → Setup required |
| **Total** | | **37 + doc** | 0 skipped |

Bold rows were added on Oct 21 with the fixes in `docs/JUDGE-2026-10-21.md`. Each one fails on
the code before its fix (checked by running it against the old file).

**How tests that reach a payout stay read-only:** the verifier never pays a payout key twice, so
the tests record every release and refund key up front with a marker. A decision that gets as far
as paying gets the marker back and sends nothing. The wallet paths in tests do not exist.

Independent check of the ML-DSA-65 implementation (`@noble/post-quantum` 0.6.1): NEAR testnet's `ml_dsa_verify` accepted its signatures on-chain: the near-qday-recovery recovery [`5bA1eV5T…`](https://testnet.nearblocks.io/txns/5bA1eV5TJC58ycGKb4MejB19tuEwyFrUxjXp7Pnq6nPQ) and the near-null-402 settlement [`Duu6wRkh…`](https://testnet.nearblocks.io/txns/Duu6wRkhCM5XSNFHV2MzNe2gTQ6bo632pYUsS8e3pAeK) both verify ML-DSA-65 signatures made with this library.

## Live run (not part of `pnpm test`)

`PQI_FUNDER_WALLET=… pnpm --filter @pqi/examples run-live` — new transactions; the README table.
The dashboard and the landing re-verify all 10 entries in the browser and recompute the anchored head (Oct 21, 1280 and 375 px; screenshots in `grokbot/shots/yaksok/`).
