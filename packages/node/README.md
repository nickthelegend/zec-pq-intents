# @pqi/node

The services, as a library and a server.

| Piece | Does |
|---|---|
| `Verifier` | holds the escrow wallet and the log key. `settle(intent, fundingTxid, fillClaim)`: user signature + key binding, not already settled/refunded, nonce not used by another intent, right escrow, funding seen by the escrow's viewing key (`pqi1:<hash>`, ≥ pay), fill claim signature by a configured solver key (`FILL_UNKNOWN_SOLVER` otherwise), fill seen by the user's receive key with a memo naming that same key (`pqi1:<hash>:fill:<solver key id>`, ≥ min_out; `FILL_BY_OTHER_SOLVER` if it names another solver, `FILL_NOT_SOLVER_BOUND` if it names none, except the Oct 20 intents while one solver key is configured, recorded as `fill_binding: legacy-single-solver`), funding and fill each 3 blocks deep (`minConfirmations`; `PENDING` before, nothing logged), fill mined by the deadline → pays the solver `pay − 15,000` from escrow (`:release`) and logs SETTLED. `refund(intent, fundingTxid)` after the deadline and a 10-block claim window (`CLAIM_WINDOW_OPEN` before) → refund (`:refund`), REFUNDED. Decisions run one at a time. `anchor(ua)` → memo `pqi1:anchor:<seq>:<head>:<previous anchor txid>`, ANCHORED. Every refusal is a signed REJECTED entry with its reason. **Payouts are write-ahead:** recipient, amount, unique memo and height are saved (fsync) before the broadcast and replaced by the txid after it; a record left by a stopped process is looked up by its memo in the escrow's history first (found → that txid, nothing sent; not found → `PAYOUT_UNRECONCILED` until a transaction built then has expired, 120 blocks, then a new attempt). |
| `Solver` | opens envelopes with its ML-KEM key, quotes (fee ≥ minimum, at least 3 and at most 1,000 blocks before the deadline, `receive_uivk` derives `receive_ua`; then `min_out` within its spendable balance), checks escrow funding with the escrow's published viewing key and waits until it is 3 blocks deep, delivers to the user's receive address with a memo naming its key, signs the fill claim |
| `Desk` + `serveDesk` | board of sealed envelopes (opened on arrival; junk is refused) and the state machine received → funded → filled → settled, or → refunded after the deadline and claim window; one tick at a time, at one tip, an error on one intent written to its note while the tick goes on; each delivery quoted again right before it is sent and written ahead (memo, recipient, amount, height; fsync), so after a restart the solver's history is searched for that memo before any new send (`DELIVERY_UNRECONCILED` until a transaction built then has expired); HTTP `GET /api/info`, `GET /api/log`, `GET /api/intents/:hash`, `POST /api/intents`, `POST /api/tick` (POSTs: `application/json`, ≤ 64 KiB, no CORS) |
| `serve.ts` | `PQI_STATE=.demo/run-state.json` live (ticks every 30 s), or `PQI_PUBLISHED=deployments/testnet.json` read-only |
| `scan`, `chainTip`, zingo wrapper | viewing-key checks through `packages/scan`; zingo-cli calls that never run `recovery_info` and refuse the treasury wallet path; `sentWithMemo` (a wallet's sent history by memo); `openViewWallet` (a view-only wallet from a full viewing key: it cannot spend) |
| `anchorHistory` + `check-anchors` | every anchor the escrow sent, from its history (the escrow's full viewing key is published), checked against a log with `checkAnchors`: `PQI_VERIFIER_ID=… PQI_ESCROW_UA=… pnpm --filter @pqi/node check-anchors "$PWD/deployments/testnet-pass3.json"`; an anchor past the end of the log is `LOG_BEHIND_ANCHORS` (exit 1), and `--allow-behind` checks an older record file on purpose (never a desk URL). The escrow address (or its full viewing key) is pinned: the key the source supplies must derive it, and the source's intents must name it, or the check stops with Setup required (exit 2) before reading any history |

Tests (`pnpm test`, 67): `live.test.ts` 23 (the three published runs re-checked on Zcash testnet; a fresh
verifier refuses tampering, wrong key, wrong memo, late fill, replay, nonce reuse, fill theft, a fill
that names another solver or none, overlapping settle/refund, a refund inside the claim window, and
waits for 3 confirmations; a fill lightwalletd does not return stays PENDING until the claim window
closes; deposits that fail a settlement check are refunded with that reason); `desk.test.ts` 14 (junk envelope, the fee-budget door, the solver's
funding depth, two ticks at once, refund of a declined intent, one failing item does not stop the
tick, a late delivery is declined right before sending, a blackholed lightwalletd times out while the
desk keeps answering, 50 unfunded envelopes leave no log entry, the board cap and unfunded eviction,
HTTP rules, the Host check, a short spendable balance retried instead of declined, no refund while a
fill that was not found could still be mined); `crash.test.ts` 6 (a verifier killed with SIGKILL after its write-ahead
record finds the Oct 20 release by memo; a record not on chain waits for the expiry height; the
solver's balance check; a desk killed after a delivery's write-ahead record sends nothing until it
would have expired and is not refunded meanwhile; a recorded delivery found in the history is
adopted); `anchors.test.ts` 7 (every anchor the escrow sent, read from its history on testnet,
against the logs; the `check-anchors` CLI fails the Oct 20 record as behind unless `--allow-behind`); `receive-key.test.ts` 4 (`RECEIVE_KEY_MISMATCH` at the solver and the verifier);
`verifier.test.ts` 4 (the fee floor; nothing between a payout and its entry can lose it; the anchor
repair); `setup.test.ts` 6 (Setup required without zingo-cli; `check-anchors` pins and options); `solver.test.ts`
3 (local). Payouts are recorded in the test state before each run, or go through a view-only wallet
that cannot spend, or a wallet path that does not exist, so no test sends a transaction.
