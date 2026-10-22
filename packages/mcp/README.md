# @pqi/mcp — `pqi-mcp`

| Tool | Does |
|---|---|
| `quote` | the spread `pay_zat − min_out_zat` against the solver's published minimum, and what a refund would return (`pay_zat − 15,000`: the fee budget is kept on a refund too) (local arithmetic; the solver decides when it opens the envelope, after 3 funding confirmations, and also needs 3+ blocks before the deadline) (read-only) |
| `submit_intent` | checks the desk's escrow and solver KEM key against the agent's pinned `trust`, then signs with the agent's ML-DSA-65 key, seals to the solver's ML-KEM-768 key, **saves the signed intent and envelope** (`PQI_MCP_PENDING`, default `<PQI_AGENT_FILE>.pending.json`, mode 0600) before paying, funds the escrow (`pqi1:<hash>`) from the agent's wallet, adds the funding txid to that record, posts the envelope. Each intent is delivered to a new receive address of the agent's key (a random Orchard diversifier index of `receive_uivk`, `zpay-verify address`), so intents are not linked by their address; a `receive_ua` argument, or `"fresh_receive_address": false` in the agent file, uses a fixed one. If anything fails after signing, the error is JSON with the intent hash, funding txid (or null: nothing paid), envelope and the record's path. `deadline_blocks` ≥ 10; spends testnet funds |
| `resubmit` | posts the saved envelope and funding txid of an intent hash again (the desk keeps one entry per hash); refuses an intent that was never funded; spends nothing |
| `status` | stage + signed log entries of an intent (read-only) |
| `verify_log` | checks the desk's verifier key against `PQI_VERIFIER_ID`, re-verifies every hash, link and ML-DSA-65 signature, re-reads **every** anchor memo on-chain with the anchor viewing key you pinned (`PQI_ANCHOR_UIVK`, never one the desk serves) and checks that each names the anchor before it, and reports how many entries come after the last one (read-only). A log with anchors and no pinned key is Setup required |

Env: `PQI_DESK_URL` (default `http://127.0.0.1:8404`), `PQI_VERIFIER_ID` (required by `verify_log`;
the published run's is `f60f130579386479043287fb68c2c1726a0a210be77aee46b355adb1287f1445`),
`PQI_ANCHOR_UIVK` (required by `verify_log` once the log has an anchor: the published run's anchor
`uivk` in `deployments/testnet.json`), `PQI_MCP_PENDING`,
`PQI_AGENT_FILE` (only for `submit_intent`: `ml_dsa_seed`, `wallet`, `receive_ua`, `receive_uivk`,
`refund_ua`, `trust: {escrow, solver_kem}`; the seed never leaves the process), `PQI_MCP_LOG`.
Tests (`pnpm test`, 9): a real MCP client over stdio against a desk serving the published record (every anchor is re-read on testnet), a second desk serving a forged copy re-signed by another key, a desk that serves no anchor key (Setup required unless pinned), and a live-mode desk with throwaway keys and no wallets: `submit_intent` saves the signed intent before its payment fails, `resubmit` refuses the unfunded record and posts a funded one.