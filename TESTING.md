# Testing zec-pq-intents

No mocked clients, no stub RPCs. Chain-touching tests read Zcash testnet through a real lightwalletd
(`testnet.zec.rocks`); they are read-only (refusals never pay, so no wallet is used).

| Package | Runs against | Tests | What |
|---|---|---|---|
| protocol | local | 16 | FIPS 203/204 sizes; deterministic keygen; encodings; one base64 spelling per value (a re-spelled key is `BAD_ENCODING`); every intent field change breaks hash and signature; other-key signatures (`WRONG_KEY`); malformed intents; envelope opens only with the solver key, fails on a flipped bit or swapped hash; fill attestations; log edits, drops, reorders, foreign key, flipped signature bit caught; ***fill memos name their solver***; ***anchor chain: one chain passes, anchors past the log's end are `later`; a fork is caught whichever log is shown, plus the hidden anchor and the head mismatch; a broken link and an anchor the escrow never sent are caught; two logs signed by one key that differ are found (`findEquivocation`)*** |
| scan (Rust) | local | 3 + doc | payment rules (from zpay-verify) |
| node `live.test.ts` | Zcash testnet | 18 | published log verifies; funding of A/B/C seen by the escrow key; fills, wrong-memo fill, late fill seen by the receive key; releases, refund, anchor seen by their keys; a fresh verifier refuses BAD_SIGNATURE, WRONG_KEY, FILL_NOT_CREDITED, EXPIRED, ALREADY_SETTLED, NONCE_REUSED; **a claim on A's real fill by another key → FILL_UNKNOWN_SOLVER**; ***two configured solvers: A's Oct 20 fill (memo names no solver) is paid to neither → FILL_NOT_SOLVER_BOUND; unbound fills are legacy only for the listed Oct 20 intents and are marked `legacy-single-solver`***; ***observed height held: funding at 2 confirmations → PENDING, fill at 2 → PENDING, fill at 3 → SETTLED; with N = 6 the fill at 5 is PENDING***; **settle + refund of A at once, and two settles of B at once, pay once**; **C one block after its deadline → CLAIM_WINDOW_OPEN**, after the window → REFUNDED; ***pass 2: the log extends the Oct 20 log with the same key; D's fill memo names the solver, a fresh verifier with two solver keys refuses the other (FILL_BY_OTHER_SOLVER) and pays the recorded claim; the killed process's write-ahead memo is the release on-chain, written only at 3 fill confirmations*** |
| node `desk.test.ts` | Zcash testnet + local | 5 | **a junk envelope under A's hash is refused**; ***the solver does not deliver against a funding with fewer than 3 confirmations (height held)***; **two ticks at once settle A once**; **a declined C is refunded after the claim window**; **POSTs need JSON ≤ 64 KiB and get no CORS header** |
| node `crash.test.ts` | Zcash testnet (view-only escrow wallet) + a real child process | 2 | ***a verifier process killed with SIGKILL after its write-ahead record: the record is on disk, nothing logged; the restarted verifier finds A's release in the escrow's history by memo and settles with that txid, sending nothing***; ***a record whose payout is not on-chain → PENDING `PAYOUT_UNRECONCILED` until the expiry height; after it, a fresh record and a new attempt*** |
| node `anchors.test.ts` | Zcash testnet (view-only escrow wallet) | 5 | ***every anchor the escrow sent, from its history: the Oct 20 log checks out; a dropped ANCHORED entry → ANCHOR_NOT_IN_LOG, a re-written log → ANCHOR_HEAD_MISMATCH; the pass-2 anchor names the Oct 20 one (one chain of two); the killed process's release went out exactly once; the verifier links each anchor to the one before*** |
| node `solver.test.ts` | local | 2 | **declines with < 3 blocks to the deadline**; minimum fee |
| mcp | stdio MCP client + desk + testnet | 6 | tools; `verify_log` (signatures, links, every anchor memo on-chain ***and linked to the one before***, 1 entry after the anchor); **a desk serving a log re-signed by another key fails against `PQI_VERIFIER_ID`; unpinned is Setup required**; `status`, `quote`; **`submit_intent` refuses a desk whose escrow is not the pinned one, before signing or paying**; no desk → Setup required |
| **Total** | | **57 + doc** | 0 skipped |

Bold items were added on Oct 21 with the first round of fixes in `docs/JUDGE-2026-10-21.md`, bold
italic ones with the second (multi-solver fills, confirmations, write-ahead payouts, anchor chain).
Each one fails on the code before its fix (checked by running it against the old file).

**How tests that reach a payout stay read-only:** the verifier never pays a payout key twice, so
the tests record every release and refund key up front with a marker. A decision that gets as far
as paying gets the marker back and sends nothing. The wallet paths in tests do not exist, or are a
view-only wallet made from the escrow's published full viewing key, which cannot sign.

**The crash test is a real kill.** `crash.test.ts` runs the verifier in a child `node` process with
`PQI_TEST_CRASH_AT=payout-before-broadcast`; the verifier sends itself SIGKILL right after the
write-ahead record is flushed, and the test restarts from what is on disk. The crash after a real
broadcast is in the live pass-2 run (`PQI_TEST_CRASH_AT=payout-after-broadcast`), not in `pnpm test`.

**Slow parts:** `crash.test.ts` and `anchors.test.ts` each sync a view-only wallet through zingo-cli
(about 30 s per call), so `pnpm test` takes a few minutes.

Independent check of the ML-DSA-65 implementation (`@noble/post-quantum` 0.6.1): NEAR testnet's `ml_dsa_verify` accepted its signatures on-chain: the near-qday-recovery recovery [`5bA1eV5T…`](https://testnet.nearblocks.io/txns/5bA1eV5TJC58ycGKb4MejB19tuEwyFrUxjXp7Pnq6nPQ) and the near-null-402 settlement [`Duu6wRkh…`](https://testnet.nearblocks.io/txns/Duu6wRkhCM5XSNFHV2MzNe2gTQ6bo632pYUsS8e3pAeK) both verify ML-DSA-65 signatures made with this library.

## Live run (not part of `pnpm test`)

`PQI_FUNDER_WALLET=… pnpm --filter @pqi/examples run-live` — new transactions; the README table.
`pnpm --filter @pqi/examples pass2` — the Oct 21 pass-2 run (intent D, the kill after the release
broadcast, the second solver's claim, the chained anchor); `deployments/testnet-pass2.json`.
The dashboard and the landing re-verify all 10 entries in the browser and recompute the anchored head (Oct 21, 1280 and 375 px; screenshots in `grokbot/shots/yaksok/`).
