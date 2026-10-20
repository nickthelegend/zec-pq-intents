# Testing zec-pq-intents

No mocked clients, no stub RPCs. Chain-touching tests read Zcash testnet through a real lightwalletd
(`testnet.zec.rocks`); they are read-only (refusals never pay, so no wallet is used).

| Package | Runs against | Tests | What |
|---|---|---|---|
| protocol | local | 10 | FIPS 203/204 sizes; deterministic keygen; encodings; every intent field change breaks hash and signature; other-key signatures (`WRONG_KEY`); malformed intents; envelope opens only with the solver key, fails on a flipped bit or swapped hash; fill attestations; log edits, drops, reorders, foreign key, flipped signature bit caught |
| scan (Rust) | local | 3 + doc | payment rules (from zpay-verify) |
| node | Zcash testnet | 7 | published log verifies; funding of A/B/C seen by the escrow key; fills, wrong-memo fill, late fill seen by the receive key; releases, refund, anchor seen by their keys; a fresh verifier refuses BAD_SIGNATURE, WRONG_KEY, FILL_NOT_CREDITED, EXPIRED, ALREADY_SETTLED, NONCE_REUSED from chain data |
| mcp | stdio MCP client + desk + testnet | 5 | tools; `verify_log` (signatures, links, anchor memo on-chain); `status`, `quote`; Setup required paths |
| **Total** | | **25 + doc** | 0 skipped |

Independent check of the ML-DSA-65 implementation (`@noble/post-quantum` 0.6.1): NEAR testnet's `ml_dsa_verify` accepted its signatures on-chain: the near-qday-recovery recovery [`5bA1eV5T…`](https://testnet.nearblocks.io/txns/5bA1eV5TJC58ycGKb4MejB19tuEwyFrUxjXp7Pnq6nPQ) and the near-null-402 settlement [`Duu6wRkh…`](https://testnet.nearblocks.io/txns/Duu6wRkhCM5XSNFHV2MzNe2gTQ6bo632pYUsS8e3pAeK) both verify ML-DSA-65 signatures made with this library.

## Live run (not part of `pnpm test`)

`PQI_FUNDER_WALLET=… pnpm --filter @pqi/examples run-live` — new transactions; the README table.
The dashboard re-verified all 10 entries in the browser (light/dark, 375 px).
