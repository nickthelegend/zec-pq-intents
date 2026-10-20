# @pqi/mcp — `pqi-mcp`

| Tool | Does |
|---|---|
| `quote` | would the solver fill `pay_zat → min_out_zat`, and its fee (read-only) |
| `submit_intent` | signs with the agent's ML-DSA-65 key, seals to the solver's ML-KEM-768 key, funds the escrow (`pqi1:<hash>`) from the agent's wallet, posts the envelope; spends testnet funds |
| `status` | stage + signed log entries of an intent (read-only) |
| `verify_log` | re-verifies every hash, link and ML-DSA-65 signature, and re-reads the latest anchor memo on-chain with the anchor's viewing key (read-only) |

Env: `PQI_DESK_URL` (default `http://127.0.0.1:8404`), `PQI_AGENT_FILE` (only for `submit_intent`;
the seed never leaves the process), `PQI_MCP_LOG`. Tests (`pnpm test`, 5): a real MCP client over
stdio against a desk serving the published record, with the anchor re-read on testnet.
