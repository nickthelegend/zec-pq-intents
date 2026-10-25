# Testing zec-pq-intents

No mocked clients, no stub RPCs. Chain-touching tests read Zcash testnet through a real lightwalletd
(`testnet.zec.rocks`); they are read-only (refusals never pay, so no wallet is used). Three tests
inject a failure into the solver (a `Solver` subclass whose `deliver` throws or counts calls, or whose
`capacity` is short once) to show the desk's handling of it; nothing external is replaced. Needs Rust 1.89 and zingo-cli (README).

| Package | Runs against | Tests | What |
|---|---|---|---|
| protocol | local | 17 | FIPS 203/204 sizes; deterministic keygen; encodings; one base64 spelling per value (a re-spelled key is `BAD_ENCODING`); every intent field change breaks hash and signature; other-key signatures (`WRONG_KEY`); malformed intents; envelope opens only with the solver key, fails on a flipped bit or swapped hash; fill attestations; log edits, drops, reorders, foreign key, flipped signature bit caught; fill memos name their solver; anchor chain: one chain passes; ✦ **a log cut short before the newest anchors fails (`LOG_BEHIND_ANCHORS`) and passes only with `allowBehind`**; a fork is caught whichever log is shown, plus the hidden anchor and the head mismatch; a broken link and an anchor the escrow never sent are caught; `findEquivocation`; ⚑ **anchors in the legacy form cannot hide a fork: a late one is `ANCHOR_LEGACY_LATE`, one off the chain `ANCHOR_ORPHAN`, two roots `ANCHOR_FORK`; only the Oct 20 anchor is accepted in that form, as the root** |
| scan (Rust) | local | 9 + doc | payment rules (from zpay-verify); ⚑ **`owns`: the receive key covers the receive address and the anchor wallet's key does not; a new diversified address of the same key is covered; a mixed address is paid only on the receiver the key covers; a non-address is refused; `address`: distinct addresses the same key covers; the throwaway-seed UFVK fixture is that seed's derivation and does not cover the escrow** |
| node `live.test.ts` | Zcash testnet | 23 | published log verifies; funding of A/B/C seen by the escrow key; fills, wrong-memo fill, late fill seen by the receive key; releases, refund, anchor seen by their keys; a fresh verifier refuses BAD_SIGNATURE, WRONG_KEY, FILL_NOT_CREDITED, EXPIRED, ALREADY_SETTLED, NONCE_REUSED; a claim on A's real fill by another key → FILL_UNKNOWN_SOLVER; two configured solvers: A's Oct 20 fill is paid to neither → FILL_NOT_SOLVER_BOUND; legacy fills only for the listed Oct 20 intents; observed height held: funding at 2 confirmations → PENDING, fill at 2 → PENDING, fill at 3 → SETTLED; settle + refund of A at once, and two settles of B at once, pay once; C one block after its deadline → CLAIM_WINDOW_OPEN, after the window → REFUNDED; pass 2: the log extends Oct 20's; FILL_BY_OTHER_SOLVER; the killed process's write-ahead memo is the release on-chain; pass 3: the log extends pass 2's (E SETTLED, ANCHORED), E was signed by the agent's own key and delivered to an address none of A–D used, which the receive key derives; E's funding, fill and release seen by their keys, the fill sent once; ✦ **a claim on a txid lightwalletd does not return is PENDING (`FILL_NOT_FOUND_YET`) until the claim window closes, then `FILL_NOT_CREDITED:TX_NOT_FOUND`**; ✦ **C's deposit is refunded with reason `WRONG_ESCROW` on a verifier whose escrow C does not name, and with `NONCE_REUSED` when its nonce was used first by another intent (the nonce stays bound to that one)** |
| node `desk.test.ts` | Zcash testnet + local | 14 | a junk envelope under A's hash is refused; ⚑ **an envelope paying no more than the fee budget is refused at the door**; the solver does not deliver against a funding with fewer than 3 confirmations; two ticks at once settle A once; a declined C is refunded after the claim window; ⚑ **a delivery that throws on the first item is written to its note and the tick still refunds the second**; ⚑ **a funded intent whose deadline is now 1 block away is declined right before sending, and nothing is sent**; ⚑ **a blackholed lightwalletd: `chainTip` and `scan` time out after `PQI_SCAN_TIMEOUT_MS`, and `GET /api/info` answers while a tick waits**; ⚑ **50 self-signed envelopes nobody funded, past their deadline: all dropped, the signed log grows by 0**; ⚑ **the board caps open intents (503) and drops one unfunded for `unfundedTtlBlocks`, unlogged**; POSTs need JSON ≤ 64 KiB and get no CORS header; ⚑ **a Host other than 127.0.0.1/localhost:<port> is refused 403**; ✦ **A funded and received with the solver's spendable balance short once: it stays received (retry next block), then is taken on and a delivery tried, never declined**; ✦ **C rejected with `TX_NOT_FOUND`, its fill broadcast 3 blocks before the deadline: not refunded until that transaction has expired, then REFUNDED** |
| node `crash.test.ts` | Zcash testnet (view-only escrow wallet) + real child processes | 6 | a verifier process killed with SIGKILL after its write-ahead record restarts and finds A's release in the escrow's history by memo; a record whose payout is not on-chain → PENDING until the expiry height; ⚑ **the solver takes on only what its wallet can pay (spendable balance)**; ⚑ **a desk process killed (SIGKILL) after the delivery's write-ahead record: on restart nothing is sent until a transaction built then has expired, then a new record and attempt**; ⚑ **past the deadline, an intent whose delivery may have gone out is not refunded while it could still be mined**; ⚑ **a delivery record whose memo the wallet's history shows is adopted with that txid and nothing is sent** |
| node `anchors.test.ts` | Zcash testnet (view-only escrow wallet) | 7 | every anchor the escrow sent, from its history: the Oct 20 log checks out (✦ **only with `allowBehind`: without it, `LOG_BEHIND_ANCHORS`**); a dropped ANCHORED entry → ANCHOR_NOT_IN_LOG, a re-written log → ANCHOR_HEAD_MISMATCH; the pass-2 anchor names the Oct 20 one; the killed process's release went out exactly once; pass 3: three anchors in one chain (#8 → #11 → #13), E's release went out once; ✦ **the `check-anchors` CLI with the escrow pinned: pass 3's record exits 0, the Oct 20 record exits 1 (`LOG_BEHIND_ANCHORS`) and 0 with `--allow-behind`**; the verifier links each anchor to the one before |
| node `receive-key.test.ts` | local (scan binary, published keys) | 4 | ⚑ **`owns` on the published keys; the solver declines an intent whose `receive_uivk` is another wallet's (`RECEIVE_KEY_MISMATCH`) and accepts the matching pair, paying that receiver; `deliver` refuses before any payment; the verifier refuses a claim on it with a signed `RECEIVE_KEY_MISMATCH` before reading any fill** |
| node `verifier.test.ts` | local + Zcash testnet | 4 | ⚑ **`PAY_BELOW_FEE_BUDGET`; the chain tip unreadable right after A's release is recorded: the SETTLED entry is still written with that release and A is closed only with it; a closed mark without its entry is finished on restart; an anchor paid but not logged is logged before the next anchor, which names it** |
| node `setup.test.ts` | local | 6 | ⚑ **no zingo-cli → `Setup required: PQI_ZINGO_CLI` (library and `check-anchors`, exit 2); `check-anchors` with no pinned escrow, with a record whose escrow full viewing key is another wallet's (a throwaway seed's), or with a source whose escrow is not the pinned one → exit 2 before reading any history**; ✦ **`--allow-behind` with a desk URL, or an unknown option → exit 2** |
| node `solver.test.ts` | local | 3 | declines with < 3 blocks to the deadline; ⚑ **declines a deadline over 1,000 blocks ahead**; minimum fee |
| mcp | stdio MCP client + desks + testnet | 9 | tools (⚑ **`resubmit`**); `verify_log` (signatures, links, every anchor memo on-chain and linked; ✦ **it says it cannot detect a log cut short, and that `check-anchors` does**); a desk serving a log re-signed by another key fails against `PQI_VERIFIER_ID`; unpinned is Setup required; ⚑ **anchor memos are read only with the pinned `PQI_ANCHOR_UIVK`: unpinned is Setup required even when the desk serves no key**; ⚑ **`deadline_blocks` below 10 is refused; both descriptions state the fee budget kept on a refund**; ⚑ **against a live-mode desk with throwaway keys: `submit_intent` saves the signed intent (0600) to a new receive address before its payment fails, the error carries hash, envelope and a null funding txid**; ✦ **a send failure that does not prove nothing went out is reported as outcome unknown after a memo lookup in the wallet's history (not "nothing was paid"); without zingo-cli it is "nothing was paid"; a `receive_ua` the receive key does not derive is refused (`RECEIVE_KEY_MISMATCH`) before anything is signed, saved or paid; `resubmit` looks the funding up by memo when no txid was recorded and posts a funded record**; `status`, `quote`; `submit_intent` refuses a desk whose escrow is not the pinned one; no desk → Setup required |
| **Total** | | **102 + doc** | 0 skipped |

Items marked ⚑ were added on Oct 22 with the fixes of two independent judges' review (the Ultra
round, listed at the end of `docs/JUDGE-2026-10-21.md`). They were written against the old code
first: the receive-key, desk-freeze, timeout, re-quote, junk-log, board-cap, Host, verifier-ordering,
legacy-anchor, Setup-required (zingo-cli) and MCP tests were run on the previous commit's source and
failed there; the rest (the slow wallet-sync ones in `crash.test.ts`, the `check-anchors` pin tests,
the 1,000-block cap and the fee-budget door) assert behaviour the old code did not have at all.
Earlier rounds' tests (Oct 21) are described in that file.

Items marked ✦ were added later on Oct 22, with the fixes of the two judges' review after pass 3
(also listed at the end of `docs/JUDGE-2026-10-21.md`). Each was run against the code before its fix
and failed there (the capacity retry, the `TX_NOT_FOUND` fill in the verifier and in the desk, the
refunds of deposits that fail a settlement check, `LOG_BEHIND_ANCHORS`, the MCP outcome and
`receive_ua` checks); the `check-anchors` option tests assert options the old CLI did not have.

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
`pnpm --filter @pqi/mcp pass3` — the Oct 22 agent path (intent E through MCP `submit_intent`, the
desk killed after the fill broadcast and reconciled, a third anchor, `verify_log` and
`check-anchors`); `deployments/testnet-pass3.json`. The dashboard and the landing re-verify every
entry of the three runs in the browser and recompute every anchored head (screenshots: `docs/img/`).

## Browser E2E (Google Chrome, not part of `pnpm test`)

`pnpm test:e2e` starts the stack (`e2e/stack.sh`: the static site :4183 (landing, terminal at `terminal/`), the terminal via `vite preview`
:5181, read-only desks over `deployments/testnet.json` :8404 and `testnet-pass2.json` :8405, all on
127.0.0.1, stopped by PID afterwards) and runs Playwright in the installed Google Chrome at 1280×800
and 375×812, with video, trace and screenshots. It covers the landing tape printing as each signature
verifies (15/15 over the three runs), every tape row and every "log #n · open in the inspector"
refusal opened fully on screen, the intent book (A–E, with E's own release and refund numbers), the
anchor heads and the three-run anchor chain, pass 2's kill and pass 3's agent panel, the attack
console codes, every link against the record and the repo, the walk landing → terminal → landing on
the one static site, the ticker's Pause/Play control and the intent book's arrow keys, reduced
motion, the landing without JavaScript, the desk reads against the Oct 20 and pass-2 records, the
write refusals (415, 413, 400, 503 Setup required, no CORS, blocked from another origin, a foreign
Host refused 403) and Setup required when the desk has no record. `e2e/shots.mjs` takes the
`docs/img/` screenshots from the same stack.

33 tests are defined (landing 16: 13 on `evidence.html`, the full record that was the landing until Oct 25, and 3 on the one-screen landing: headline, buttons, the latest intent's ticket against the record, the numbers against the log and `tests.json`, reduced motion; terminal 11, desk 6), each run in both projects.

On Oct 25, after the landing/evidence split, `landing.spec.ts` alone: 31 passed, 1 skipped (hover, mobile), 0 failed. The terminal and desk specs did not change.

| Run of Oct 23 | desktop | mobile |
|---|---|---|
| passed | 30 | 24 |
| skipped | 0 | 6 (the 5 HTTP-only desk tests run once, on desktop; hover has no phone equivalent) |
| failed | 0 | 0 |
