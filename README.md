# near-pq-confidential-intents

> Post-quantum intents on NEAR testnet: ML-DSA-65-signed, ML-KEM-encrypted to the solver, settled by a contract that verifies signatures with `ml_dsa_verify`.

**Standalone protocol that mirrors NEAR Intents — not NEAR Intents.** Status: scaffold only. Spec: `grokbot/specs/near-pq-confidential-intents.md`.

## Packages
| Package | Role |
|---|---|
| `packages/contracts` | `pq_settlement` (near-sdk-rs): registers user/solver ML-DSA-65 pubkeys; escrows NEP-141 deposits via ft_on_transfer; `settle(intent, user_sig, solver_attestation, solver_sig)` verifies both with `env::ml_dsa_verify`, checks nonce (per-user bitmap/set), deadline (block timestamp), token/amount/min-out match, then releases escrow; plus two test NEP-141 tokens (tUSD, tNEAR) for the demo |
| `packages/protocol` | Rust+TS lib: canonical intent encoding (domain-separated, borsh), ML-DSA-65 sign/verify (RustCrypto `ml-dsa` 0.1.x / `@noble/post-quantum` 0.7.x), ML-KEM-768 encryption of the intent to the solver's KEM key (RustCrypto `ml-kem` 0.3.x) + AES-GCM |
| `packages/solver` | Real solver service (Rust/TS): receives encrypted intents, decrypts with ML-KEM, quotes from its own NEP-141 inventory, fills on testnet (ft_transfer_call), signs an ML-DSA attestation over (intent hash, fill tx, amounts), calls settle |
| `packages/sdk` | TS client: build/sign/encrypt intents, track status |
| `packages/mcp` | MCP server: `quote`, `submit_intent(swap tUSD→tNEAR, min_out, deadline)`, `status` — agents trade with PQ-signed intents; tests on live testnet |
| `packages/dashboard` | Intent lifecycle view (encrypted → filled → settled), public-vs-solver view, attack panel that fires the 4 rejection cases and shows on-chain errors |
| `packages/examples` | e2e swap + the 4 attacks |
| `packages/docs` | Protocol spec, threat model, how it mirrors NEAR Intents |
| `packages/landing` | Landing |

## Live testnet deployment
_None yet._ On NEAR testnet: `pq-settlement.<nick>.testnet`, two NEP-141 test tokens, solver account; table with account IDs, a settled-swap txid and the 4 rejection txids.

## Tests — real testnet, no mocked clients
| Package | Network | What | Result |
|---|---|---|---|
| contracts | near-workspaces sandbox + testnet | valid intent+attestation settles and releases escrow; tampered intent, replayed nonce, expired deadline, wrong-key signature each rejected on-chain (4 testnet txids) | not run yet |
| protocol | local | ML-KEM round trip; ML-DSA sign/verify vectors match the contract | not run yet |
| solver | live testnet | decrypts, fills, attests; under-fill / wrong-token attestation rejected by contract | not run yet |
| mcp | live testnet | agent submits intent and gets settled; no mocked clients | not run yet |

MIT.
