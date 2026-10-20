# @pqi/node

The services, as a library and a server.

| Piece | Does |
|---|---|
| `Verifier` | holds the escrow wallet and the log key. `settle(intent, fundingTxid, fillClaim)`: user signature + key binding, not already settled/refunded, nonce not used by another intent, right escrow, funding seen by the escrow's viewing key (`pqi1:<hash>`, ≥ pay), fill claim signature, fill seen by the user's receive key (`pqi1:<hash>:fill`, ≥ min_out) and mined by the deadline → pays the solver `pay − 15,000` from escrow (`:release`) and logs SETTLED. `refund(intent, fundingTxid)` after the deadline → refund (`:refund`), REFUNDED. `anchor(ua)` → memo `pqi1:anchor:<seq>:<head>`, ANCHORED. Every refusal is a signed REJECTED entry with its reason; an unmined transaction is PENDING and logs nothing. Payouts are keyed and stored before logging, so a restart never pays twice. |
| `Solver` | opens envelopes with its ML-KEM key, quotes (fee ≥ minimum, deadline ahead), checks escrow funding with the escrow's published viewing key, delivers to the user's receive address, signs the fill claim |
| `Desk` + `serveDesk` | board of sealed envelopes (ciphertext + hash only) and the state machine received → funded → filled → settled; HTTP `GET /api/info`, `GET /api/log`, `GET /api/intents/:hash`, `POST /api/intents`, `POST /api/tick` |
| `serve.ts` | `PQI_STATE=.demo/run-state.json` live (ticks every 30 s), or `PQI_PUBLISHED=deployments/testnet.json` read-only |
| `scan`, `chainTip`, zingo wrapper | viewing-key checks through `packages/scan`; zingo-cli calls that never run `recovery_info` and refuse the treasury wallet path |
