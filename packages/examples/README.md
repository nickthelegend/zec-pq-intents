# examples

- `run-live` — the live testnet run (resumable; state in `.demo/run-state.json`, never pays twice):
  three intents funded in one shielded transaction, A and B delivered by the solver and settled, C
  attacked with a wrong-memo fill and a late fill and then refunded, four more attacks refused with no
  transaction (changed intent, replay, nonce reuse, wrong key), and the log anchored. Writes
  `deployments/testnet.json`.
- `demo` — the video: re-verifies the published log, the attacks and the envelope, and re-reads the
  anchor, releases and refund on testnet (no new transactions).

```sh
CARGO_TARGET_DIR=<where packages/scan is built> PQI_FUNDER_WALLET=<zingo data dir of a funded demo wallet> pnpm --filter @pqi/examples run-live
pnpm --filter @pqi/examples demo
```
