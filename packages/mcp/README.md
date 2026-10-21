# @pqi/mcp — `pqi-mcp`

| Tool | Does |
|---|---|
| `quote` | the fee `pay_zat − min_out_zat` against the solver's published minimum (local arithmetic; the solver decides when it opens the envelope, and also needs 3+ blocks before the deadline) (read-only) |
| `submit_intent` | checks the desk's escrow and solver KEM key against the agent's pinned `trust`, then signs with the agent's ML-DSA-65 key, seals to the solver's ML-KEM-768 key, funds the escrow (`pqi1:<hash>`) from the agent's wallet, posts the envelope; spends testnet funds |
| `status` | stage + signed log entries of an intent (read-only) |
| `verify_log` | checks the desk's verifier key against `PQI_VERIFIER_ID`, re-verifies every hash, link and ML-DSA-65 signature, and re-reads the latest anchor memo on-chain with the anchor's viewing key, and reports how many entries come after it (read-only) |

Env: `PQI_DESK_URL` (default `http://127.0.0.1:8404`), `PQI_VERIFIER_ID` (required by `verify_log`;
the published run's is `f60f130579386479043287fb68c2c1726a0a210be77aee46b355adb1287f1445`),
`PQI_AGENT_FILE` (only for `submit_intent`: `ml_dsa_seed`, `wallet`, `receive_ua`, `receive_uivk`,
`refund_ua`, `trust: {escrow, solver_kem}`; the seed never leaves the process), `PQI_MCP_LOG`.
Tests (`pnpm test`, 6): a real MCP client over stdio against a desk serving the published record
(the anchor is re-read on testnet) and a second desk serving a forged copy re-signed by another key.
