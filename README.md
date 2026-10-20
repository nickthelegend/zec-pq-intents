# near-pq-confidential-intents

> PQ Confidential Intents (NEAR) — REFERENCE BUILD, portfolio

**Status: scaffold only — nothing built or deployed yet.** Spec: `grokbot/specs/near-pq-confidential-intents.md`. Intended repo: `nickthelegend/near-pq-confidential-intents` (not created).

## Packages
| Package | Role |
|---|---|
| [`packages/lib`](./packages/lib) | Intent schema + ML-DSA-65 signing + optional encryption to solver key |
| [`packages/contracts`](./packages/contracts) | Testnet verifier contract (ml_dsa_verify), rejects tampered intents |
| [`packages/dashboard`](./packages/dashboard) | UI labelled 'Reference build — not live NEAR Intents' |
| [`packages/docs`](./packages/docs) | What would need to ship in Intents |
| [`packages/landing`](./packages/landing) | Landing |

## Live testnet deployment
_None yet._ Verifier contract on NEAR testnet; txids of accepted and rejected intents.

## Run the whole thing
_To be written once packages exist._

## Tests — real testnet, no mocked clients
| Package | Network | What | Result |
|---|---|---|---|
| lib | local | tampered/wrong-key rejected | not run yet |
| contracts | near-workspaces + testnet | same on-chain | not run yet |

MIT — Copyright (c) 2026 Nivesh Gajengi.
