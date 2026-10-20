# zec-pq-intents

> ML-DSA-65-signed, ML-KEM-768-encrypted intents, funded from shielded notes and filled with real shielded ZEC payments on testnet; an ML-DSA-signed attestation log anchored in shielded memos.

**Status: scaffold only.** Zcash L1 has no contracts: PQ checks run in a trusted verifier service; the solver is trusted with plaintext intents. Spec: `grokbot/specs/zec-pq-intents.md`. Intended repo `nickthelegend/zec-pq-intents` (not created).

## Packages
| Package | Role |
|---|---|
| `packages/protocol` | Rust+TS lib: canonical intent encoding (domain-separated: swap/buy/sell ZEC for a quote, min-out, deadline, nonce, refund UA), ML-DSA-65 sign/verify (RustCrypto `ml-dsa` / `@noble/post-quantum`), ML-KEM-768 + AES-GCM encryption to the solver's KEM key (`ml-kem`) |
| `packages/funding` | User funds the intent from a shielded note: a real shielded payment to the escrow/settlement UA with memo `pqi1:<intent_hash>` |
| `packages/solver` | Real solver service: decrypts with ML-KEM, decides, fills with a real shielded ZEC payment on testnet to the user's UA carrying memo `pqi1:<intent_hash>:fill`, ML-DSA-signs a fill attestation |
| `packages/verifier` | Settlement/audit service: scans with viewing keys (UIVK of escrow + user-provided UIVK for fill receipt), checks user ML-DSA sig, solver attestation sig, nonce, deadline, amounts; on success releases/marks settled (shielded refund if expired); appends an ML-DSA-signed entry to an append-only attestation log (hash chain) |
| `packages/anchor` | Periodic anchoring: log head hash in a shielded memo to a public-UIVK anchor address; optional stretch: also post the head to a NEAR testnet contract that checks it with `ml_dsa_verify` |
| `packages/mcp` | MCP server: `quote`, `submit_intent`, `status`, `verify_log` — agents trade with PQ-signed intents; tests on live testnet |
| `packages/dashboard` | Intent lifecycle (encrypted → funded → filled → attested → anchored), log explorer that re-verifies signatures in-browser, attack panel (tamper, replay, expired, wrong key, wrong-memo fill) |
| `packages/examples` | e2e: 2 intents filled, 1 expired + refunded, 4 attacks |
| `packages/docs` | Protocol, threat model, trust assumptions, Zcash PQ roadmap tie-in |
| `packages/landing` | Landing |

## Live testnet deployment
_None yet._ Testnet UAs (escrow, solver, anchor) with published demo UIVKs; table of funding, fill, refund and anchor txids (Ironwood-only), verifier ML-DSA public-key fingerprint.

## Tests — real testnet, no mocked clients
| Package | Network | What | Result |
|---|---|---|---|
| protocol | local | ML-DSA/ML-KEM vectors; tampered field changes intent hash and fails verify | not run yet |
| verifier | live testnet | valid fill attested; tampered intent, replayed nonce, expired deadline, wrong-key signature each rejected and logged as REJECTED; fill with wrong memo/amount not credited | not run yet |
| solver | live testnet | real shielded fill tx found by UIVK | not run yet |
| anchor | live testnet | anchor memo hash == recomputed log head | not run yet |
| mcp | live testnet | agent submits, gets filled; no mocked clients | not run yet |

MIT.
