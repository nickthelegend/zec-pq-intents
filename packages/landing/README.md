# landing

One static page in the trading-terminal layout: a ticker of the run's decisions, the intent book,
and the attestation tape. The tape re-checks every entry's hash, link and ML-DSA-65 signature in
the browser (`@pqi/protocol`, bundled), then recomputes the anchored head. Also: the refusals, the
primitives with their measured sizes, what is and is not post-quantum, agents, and limits.

Everything on it is generated from `deployments/testnet.json`:

```sh
node packages/landing/build.mjs   # writes index.html, src/run.json, assets/tape.js
```

Edit `build.mjs` (markup), `assets/landing.css` (style) or `src/tape.ts` (the check), not
`index.html`. Fonts: Onest and Red Hat Mono. Works without JavaScript, minus the in-tab check.
