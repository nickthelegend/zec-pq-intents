# @pqi/protocol

Browser- and Node-safe (no `node:` imports), so the dashboard re-verifies the log in the tab.

| Piece | What |
|---|---|
| Intent | `{v, kind: "delivery", chain, escrow, pay_zat, min_out_zat, receive_ua, receive_uivk, refund_ua, deadline_height, nonce, user}`; exact field set, strict formats; hash = sha256(`pqi1:intent:` ‖ canonical JSON) |
| User signature | ML-DSA-65 (FIPS 204, `@noble/post-quantum`) over `pqi1:intent:` ‖ canonical intent; `user` = sha256(public key) so a different key is `WRONG_KEY` |
| Envelope to the solver | ML-KEM-768 (FIPS 203) encapsulation → HKDF-SHA256 (info = intent hash) → AES-256-GCM (AAD = intent hash); opening re-verifies the signature and the hash |
| Fill attestation | the solver's ML-DSA-65 signature over `{intent_hash, fill_txid, solver_ua, solver}` |
| Log | entries `{seq, prev, status, intent_hash, reason, refs, at_height, verifier}`, hash-chained from a zero genesis, each hash signed by the verifier's ML-DSA-65 key; `verifyLog` re-checks every hash, link and signature |
| Memos | `pqi1:<hash>` funding, `pqi1:<hash>:fill`, `:release`, `:refund`, `pqi1:anchor:<seq>:<head>` |

Errors are `ProtocolError` with a code: `BAD_INTENT`, `WRONG_KEY`, `BAD_SIGNATURE`, `NOT_FOR_ME`, `BAD_ENVELOPE`, `BAD_ENCODING`.

Tests (`pnpm test`, 10): FIPS 203/204 key, signature and ciphertext sizes; deterministic keygen;
base64/canonical encoding; every intent field change breaks hash and signature; other-key
signatures; malformed intents; envelope only opens with the solver key and fails on a flipped bit
or swapped hash; fill attestation; log edits, drops, reorders, foreign keys and flipped signature
bits are caught. Independent check of the ML-DSA-65 implementation: NEAR testnet's `ml_dsa_verify`
host function accepted `@noble/post-quantum` 0.6.1 signatures in near-qday-recovery and near-null-402.
