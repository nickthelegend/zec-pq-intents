# dashboard

Reads the published run (`deployments/testnet.json`) and re-verifies it in the tab with `@pqi/protocol`:

- **Three intents:** sealed (ML-KEM ciphertext sizes), funded, delivered, settled or refunded, each step a testnet tx link.
- **The attestation log** as a chain: every entry's hash, link and ML-DSA-65 signature checked one by one in the browser.
- **Attacks:** the verifier's signed answers (log entries #2–#7), plus a panel that changes any field of intent A, or verifies the attacker's intent, in the tab.

```sh
pnpm --filter @pqi/dashboard dev   # http://localhost:5181
```

One dark app frame on the brand colour; 375 px without horizontal scroll.
