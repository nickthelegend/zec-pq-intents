# zec-pq-intents — submission draft (portfolio; DO NOT SUBMIT)

Zecathon allows one entry per team: Shielded x402. This would fit Private Markets.

**Name:** zec-pq-intents
**One line:** Intents signed with ML-DSA-65 and sealed with ML-KEM-768, settled in shielded ZEC, with a signed, hash-chained, memo-anchored decision log anyone can re-verify.
**Repo:** github.com/nickthelegend/zec-pq-intents (public before submission)
**Video:** `zec-pq-intents-demo.mp4` (shared separately until hosted)

## Proof it works (Zcash testnet, Oct 20, 2026)
- 3 intents funded in one shielded tx `1d6b3868…`; A and B filled (`2970d8ba…`, `a74b9dfe…`) and settled (releases `9800b912…`, `6b34215c…`).
- 6 signed rejections: wrong-memo fill, tampered intent, replay, nonce reuse, wrong key, late fill; C refunded (`357b7065…`).
- Log head anchored in `a7d96038…`; memo found with the anchor viewing key, equals the recomputed head.
- 25 tests + doc (TESTING.md); dashboard re-verifies every signature in the browser.

## Honest scope
Post-quantum at the intent layer only (Zcash spends stay ECC). Verifier trusted for liveness. ZEC-only delivery intents. Testnet only. Built Oct 20, 2026.
