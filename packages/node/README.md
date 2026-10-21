# @pqi/node

The services, as a library and a server.

| Piece | Does |
|---|---|
| `Verifier` | holds the escrow wallet and the log key. `settle(intent, fundingTxid, fillClaim)`: user signature + key binding, not already settled/refunded, nonce not used by another intent, right escrow, funding seen by the escrow's viewing key (`pqi1:<hash>`, ≥ pay), fill claim signature by a configured solver key (`FILL_UNKNOWN_SOLVER` otherwise), fill seen by the user's receive key (`pqi1:<hash>:fill`, ≥ min_out) and mined by the deadline → pays the solver `pay − 15,000` from escrow (`:release`) and logs SETTLED. `refund(intent, fundingTxid)` after the deadline and a 10-block claim window (`CLAIM_WINDOW_OPEN` before) → refund (`:refund`), REFUNDED. Decisions run one at a time. `anchor(ua)` → memo `pqi1:anchor:<seq>:<head>`, ANCHORED. Every refusal is a signed REJECTED entry with its reason; an unmined transaction is PENDING and logs nothing. Payouts are keyed and the txid is stored before the decision is logged, so a restart after the save never pays twice (a crash between broadcast and save still could). |
| `Solver` | opens envelopes with its ML-KEM key, quotes (fee ≥ minimum, at least 3 blocks before the deadline), checks escrow funding with the escrow's published viewing key, delivers to the user's receive address, signs the fill claim |
| `Desk` + `serveDesk` | board of sealed envelopes (opened on arrival; junk is refused) and the state machine received → funded → filled → settled, or → refunded after the deadline and claim window; one tick at a time; HTTP `GET /api/info`, `GET /api/log`, `GET /api/intents/:hash`, `POST /api/intents`, `POST /api/tick` (POSTs: `application/json`, ≤ 64 KiB, no CORS) |
| `serve.ts` | `PQI_STATE=.demo/run-state.json` live (ticks every 30 s), or `PQI_PUBLISHED=deployments/testnet.json` read-only |
| `scan`, `chainTip`, zingo wrapper | viewing-key checks through `packages/scan`; zingo-cli calls that never run `recovery_info` and refuse the treasury wallet path |

Tests (`pnpm test`, 17): `live.test.ts` 11 (the published run re-checked on Zcash testnet; a fresh
verifier refuses tampering, wrong key, wrong memo, late fill, replay, nonce reuse, fill theft,
overlapping settle/refund, a refund inside the claim window); `desk.test.ts` 4 (junk envelope, two
ticks at once, refund of a declined intent, HTTP rules); `solver.test.ts` 2 (local). Payouts are
recorded in the test state before each run, so no test sends a transaction.
