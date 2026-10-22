# @pqi/node

The services, as a library and a server.

| Piece | Does |
|---|---|
| `Verifier` | holds the escrow wallet and the log key. `settle(intent, fundingTxid, fillClaim)`: user signature + key binding, not already settled/refunded, nonce not used by another intent, right escrow, funding seen by the escrow's viewing key (`pqi1:<hash>`, ≥ pay), fill claim signature by a configured solver key (`FILL_UNKNOWN_SOLVER` otherwise), fill seen by the user's receive key with a memo naming that same key (`pqi1:<hash>:fill:<solver key id>`, ≥ min_out; `FILL_BY_OTHER_SOLVER` if it names another solver, `FILL_NOT_SOLVER_BOUND` if it names none, except the Oct 20 intents while one solver key is configured, recorded as `fill_binding: legacy-single-solver`), funding and fill each 3 blocks deep (`minConfirmations`; `PENDING` before, nothing logged), fill mined by the deadline → pays the solver `pay − 15,000` from escrow (`:release`) and logs SETTLED. `refund(intent, fundingTxid)` after the deadline and a 10-block claim window (`CLAIM_WINDOW_OPEN` before) → refund (`:refund`), REFUNDED. Decisions run one at a time. `anchor(ua)` → memo `pqi1:anchor:<seq>:<head>:<previous anchor txid>`, ANCHORED. Every refusal is a signed REJECTED entry with its reason. **Payouts are write-ahead:** recipient, amount, unique memo and height are saved (fsync) before the broadcast and replaced by the txid after it; a record left by a stopped process is looked up by its memo in the escrow's history first (found → that txid, nothing sent; not found → `PAYOUT_UNRECONCILED` until a transaction built then has expired, 120 blocks, then a new attempt). |
| `Solver` | opens envelopes with its ML-KEM key, quotes (fee ≥ minimum, at least 3 and at most 1,000 blocks before the deadline, `receive_uivk` derives `receive_ua`; then `min_out` within its spendable balance), checks escrow funding with the escrow's published viewing key and waits until it is 3 blocks deep, delivers to the user's receive address with a memo naming its key, signs the fill claim |
| `Desk` + `serveDesk` | board of sealed envelopes (opened on arrival; junk is refused) and the state machine received → funded → filled → settled, or → refunded after the deadline and claim window; one tick at a time; HTTP `GET /api/info`, `GET /api/log`, `GET /api/intents/:hash`, `POST /api/intents`, `POST /api/tick` (POSTs: `application/json`, ≤ 64 KiB, no CORS) |
| `serve.ts` | `PQI_STATE=.demo/run-state.json` live (ticks every 30 s), or `PQI_PUBLISHED=deployments/testnet.json` read-only |
| `scan`, `chainTip`, zingo wrapper | viewing-key checks through `packages/scan`; zingo-cli calls that never run `recovery_info` and refuse the treasury wallet path; `sentWithMemo` (a wallet's sent history by memo); `openViewWallet` (a view-only wallet from a full viewing key: it cannot spend) |
| `anchorHistory` + `check-anchors` | every anchor the escrow sent, from its history (the escrow's full viewing key is published), checked against a log with `checkAnchors`: `PQI_VERIFIER_ID=… pnpm --filter @pqi/node check-anchors deployments/testnet-pass2.json` |

Tests (`pnpm test`, 32): `live.test.ts` 18 (the published runs re-checked on Zcash testnet; a fresh
verifier refuses tampering, wrong key, wrong memo, late fill, replay, nonce reuse, fill theft, a fill
that names another solver or none, overlapping settle/refund, a refund inside the claim window, and
waits for 3 confirmations); `desk.test.ts` 5 (junk envelope, the solver's funding depth, two ticks at
once, refund of a declined intent, HTTP rules); `crash.test.ts` 2 (a verifier process killed with
SIGKILL after its write-ahead record restarts and finds the Oct 20 release by memo; a record not on
chain waits for the expiry height); `anchors.test.ts` 5 (every anchor the escrow sent, read from its
history on testnet, against the logs); `solver.test.ts` 2 (local). Payouts are recorded in the test
state before each run, or go through a view-only wallet that cannot spend, so no test sends a
transaction.
