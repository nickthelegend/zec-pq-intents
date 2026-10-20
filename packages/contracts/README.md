# contracts

`pq_settlement` (near-sdk-rs): registers user/solver ML-DSA-65 pubkeys; escrows NEP-141 deposits via ft_on_transfer; `settle(intent, user_sig, solver_attestation, solver_sig)` verifies both with `env::ml_dsa_verify`, checks nonce (per-user bitmap/set), deadline (block timestamp), token/amount/min-out match, then releases escrow; plus two test NEP-141 tokens (tUSD, tNEAR) for the demo

_Placeholder — not built yet._
