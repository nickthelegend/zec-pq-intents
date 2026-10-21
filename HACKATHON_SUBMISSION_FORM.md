# Yaksok — submission draft (portfolio; DO NOT SUBMIT)

Zecathon allows one entry per team: Shielded x402. This would fit Private Markets.

**Name:** zec-pq-intents
**One line:** Intents signed with ML-DSA-65 and sealed with ML-KEM-768, settled in shielded ZEC, with a signed, hash-chained, memo-anchored decision log anyone can re-verify.
**Repo:** github.com/nickthelegend/zec-pq-intents (public before submission)
**Video:** `zec-pq-intents-demo.mp4` (shared separately until hosted)

## Proof it works (Zcash testnet, Oct 20, 2026)
- 3 intents funded in one shielded tx `1d6b3868…`; A and B filled (`2970d8ba…`, `a74b9dfe…`) and settled (releases `9800b912…`, `6b34215c…`).
- 6 signed rejections: wrong-memo fill, tampered intent, replay, nonce reuse, wrong key, late fill; C refunded (`357b7065…`).
- Log head anchored in `a7d96038…`; memo found with the anchor viewing key, equals the recomputed head.
- Pass 2 (Oct 21): intent D funded `be265ece…`, filled `7f220bd5…` with a memo naming the solver key, released `c0557316…` by a verifier process killed with SIGKILL right after the broadcast and reconciled on restart (paid once); a second solver's claim refused (`FILL_BY_OTHER_SOLVER`); anchor `694a94c7…` names the Oct 20 anchor.
- 57 tests + doc (TESTING.md); the dashboard and landing re-verify every signature in the browser.
- Oct 21 review (`docs/JUDGE-2026-10-21.md`): fill-claim theft, a settle/refund double payout, refund griefing at the deadline, board squatting, cross-site desk POSTs and a self-vouching `verify_log` were found and fixed with tests; then multi-solver fill theft, the crash-between-broadcast-and-save window, 1-confirmation acceptance and anchor equivocation.

## Honest scope
Post-quantum at the intent layer only (Zcash spends stay ECC, and their notes could be linked by a future quantum adversary). Verifier trusted for liveness; only the configured solver key that the fill memo names is paid. ZEC-only delivery intents. Testnet only. Built Oct 20, 2026.
