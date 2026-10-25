# landing

Two static pages, both generated from the published runs (`deployments/testnet.json`, `testnet-pass2.json`,
`testnet-pass3.json`):

- `index.html`: the one-screen landing. The latest intent as an order ticket (pay, deliver, the ML-DSA-65
  signature and ML-KEM-768 ciphertext sizes measured from it, the signed log entry that settled it; its
  three stages light once, at once under reduced motion), three steps, three numbers from the log and
  `tests.json`, and what is live versus Setup required.
- `evidence.html`: the full record (the landing until Oct 25), in the trading-terminal layout: a ticker of
  the run's decisions, the intent book, and the attestation tape. The tape re-checks every entry's hash,
  link and ML-DSA-65 signature in the browser (`@pqi/protocol`, bundled), then recomputes the anchored
  head. Also: the refusals, the primitives with their measured sizes, what is and is not post-quantum,
  agents, and limits.

```sh
node packages/landing/build.mjs   # writes index.html, evidence.html, src/run.json, assets/tape.js
```

Edit `build.mjs` (markup; the landing's style is inline in it), `assets/landing.css` (the evidence page's
style) or `src/tape.ts` (the check), not the HTML. Fonts: Onest and Red Hat Mono. Both pages work without
JavaScript, minus the in-tab check.
