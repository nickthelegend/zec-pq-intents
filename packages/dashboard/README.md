# dashboard (Yaksok terminal)

A dark trading-terminal view of the published run (`deployments/testnet.json`), re-verified in the
tab with `@pqi/protocol`:

- **Ticker and status bar:** every decision of the run; signatures verified so far in this tab.
- **Intent book:** A, B and C with escrow, delivery share, deadline and outcome. Pick one to see its
  steps (signed, sealed with the measured ML-KEM/AES-GCM sizes, funded, filled, released or
  refunded), each a testnet transaction link.
- **Attestation tape:** the log prints entry by entry as each hash, link, verifier key id and
  ML-DSA-65 signature is checked. Pick an entry to open it in the inspector.
- **Anchor and keys:** the anchored head is recomputed here. The memo itself is on-chain and needs
  lightwalletd, so the tab labels it "found by the run script; re-read by `pnpm test`".
- **Attack console:** change any field of intent A, or verify the attacker's intent, with the same
  check the verifier runs.
- **Refused on testnet:** the six signed refusals, each one opening its entry.

```sh
pnpm --filter @pqi/dashboard dev   # http://localhost:5181
```

Onest + Red Hat Mono, plum-black / copper / lilac. 375 px without horizontal scroll, and reduced
motion is respected.
