# Yaksok — submission draft (portfolio; DO NOT SUBMIT)

Zecathon allows one entry per team: Shielded x402. This would fit Private Markets.

**Name:** zec-pq-intents
**One line:** Intents signed with ML-DSA-65 and sealed with ML-KEM-768, settled in shielded ZEC, with a signed, hash-chained, memo-anchored decision log anyone can re-verify.
**Repo:** github.com/nickthelegend/zec-pq-intents (not public yet: Nick creates it and pushes `main`)
**Live demo:** not hosted yet. `pnpm build:site` builds the landing with the terminal at `terminal/` as one static folder for GitHub Pages; until then `pnpm install && pnpm --filter @pqi/dashboard dev`.
**Video:** none current. The only clip, `zec-pq-intents-demo.mp4` (26 s, Oct 20), is a terminal-only re-verification of the Oct 20 run; it predates the Yaksok UI, pass 2 and pass 3. A ~2-minute captioned video is still to be recorded (by Nick).
**Screenshots:** `docs/img/terminal.png`, `terminal-375.png`, `landing.png`, `landing-375.png` (Google Chrome, after 15/15 signatures verified in the tab).

## Proof it works (Zcash testnet, Oct 20–22, 2026)
- 3 intents funded in one shielded tx `1d6b3868…`; A and B filled (`2970d8ba…`, `a74b9dfe…`) and settled (releases `9800b912…`, `6b34215c…`).
- 6 signed rejections: wrong-memo fill, tampered intent, replay, nonce reuse, wrong key, late fill; C refunded (`357b7065…`).
- Log head anchored in `a7d96038…`; memo found with the anchor viewing key, equals the recomputed head.
- Pass 2 (Oct 21): intent D funded `be265ece…`, filled `7f220bd5…` with a memo naming the solver key, released `c0557316…` by a verifier process killed with SIGKILL right after the broadcast and reconciled on restart (paid once); a second solver's claim refused (`FILL_BY_OTHER_SOLVER`); anchor `694a94c7…` names the Oct 20 anchor.
- Pass 3 (Oct 22), the agent path: an MCP client called `quote` and `submit_intent`, which signed intent E with the agent's own ML-DSA-65 key, delivered to a new receive address, saved it, funded `3ba64090…` and posted it to a live desk; the desk was killed (SIGKILL) right after the fill broadcast `0ef36c7f…` and the restart found the fill by memo instead of resending it; E released `6b63f403…` (log #13); anchor `7b1ce3f2…` (#14) names pass 2's; `verify_log` over MCP ok for 15 entries and 3 anchors, `check-anchors` with the escrow pinned exit 0.
- 102 tests + doc (`pnpm test`, 0 skipped; TESTING.md) and a Google Chrome E2E suite (30 tests, desktop 30 passed, mobile 24 passed + 6 desktop-only); the dashboard and landing re-verify every signature of the three runs in the browser.
- Oct 21 review (`docs/JUDGE-2026-10-21.md`): fill-claim theft, a settle/refund double payout, refund griefing at the deadline, board squatting, cross-site desk POSTs and a self-vouching `verify_log` were found and fixed with tests; then multi-solver fill theft, the crash-between-broadcast-and-save window, 1-confirmation acceptance and anchor equivocation.
- Oct 22 reviews (two judges before pass 3, two after; listed with commits at the end of `docs/JUDGE-2026-10-21.md`): the receive key not checked against the receive address, a desk one bad intent could freeze, a double delivery after a crash, a log anyone could grow over HTTP, forks hidden by legacy anchors; then a short balance declining intents for good, a fill not yet returned by lightwalletd refused and refunded, deposits that could never be refunded, a cut-short log passing `check-anchors`, and `submit_intent` claiming "nothing was paid" after a timeout. All fixed with tests.

## Honest scope
Post-quantum at the intent layer only (Zcash spends stay ECC, and their notes could be linked by a future quantum adversary). Verifier trusted for liveness; only the configured solver key that the fill memo names is paid. ZEC-only delivery intents: a private OTC delivery desk with one solver, not a market of competing quotes; the 20,000 zat spread is a testnet fee budget (15,000 for the payout transaction, 5,000 to the solver), so a refund costs the user 15,000. A new receive address per intent does not unlink one user's intents: the public log names the user's key id and nonce on every settled or refunded entry. Testnet only. Built Oct 20–22, 2026 (first live run Oct 20; pass 2, the Yaksok redesign and the browser E2E suite Oct 21–22; the fixes of the Oct 22 review and pass 3 Oct 22).
