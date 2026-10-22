# dashboard (Yaksok terminal)

A dark trading-terminal view of the three published runs (`deployments/testnet.json`, Oct 20;
`testnet-pass2.json`, Oct 21; `testnet-pass3.json`, Oct 22), re-verified in the tab with
`@pqi/protocol`:

- **Ticker and status bar:** every decision of the three runs, with a Pause/Play button; signatures
  verified so far in this tab.
- **Intent book:** A–E with escrow, delivery share, deadline and outcome (one tab stop; the arrow
  keys move the selection). Pick one to see its
  steps (signed, sealed with the measured ML-KEM/AES-GCM sizes, funded, filled, released or
  refunded), each a testnet transaction link.
- **Attestation tape:** the log prints entry by entry as each hash, link, verifier key id and
  ML-DSA-65 signature is checked. Pick an entry to open it in the inspector.
- **Anchor and keys:** the anchored head is recomputed here. The memo itself is on-chain and needs
  lightwalletd, so the tab labels it "found by the run script; re-read by `pnpm test`".
  **Check the anchor chain** re-checks the runs as one chain: pass 3's log verifies under the same
  verifier key and extends pass 2's, which extends the Oct 20 log, and the escrow's three anchor
  memos as pass 3 recorded them (#8, #11 naming #8's txid, #13 naming #11's) pass `checkAnchors`
  with no fork. The on-chain re-read is `pnpm test` / `check-anchors`.
- **Attack console:** change any field of intent A, or verify the attacker's intent, with the same
  check the verifier runs.
- **Refused on testnet:** the signed refusals, each one opening its entry.
- **Pass 2's kill** and **pass 3's agent path** (MCP `submit_intent`, the desk killed after the fill
  broadcast, the fill found and not resent), each linking its SETTLED entry.

```sh
pnpm --filter @pqi/dashboard dev   # http://localhost:5181
```

Onest + Red Hat Mono, plum-black / copper / lilac. 375 px without horizontal scroll, and reduced
motion is respected.
