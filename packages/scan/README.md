# scan

`zpay-verify` (Rust), copied unchanged in behaviour from [zec-payment-verify-sdk](https://github.com/nickthelegend/zec-payment-verify-sdk) `packages/core` (same author, MIT). The verifier and solver use it to check funding, fills, releases, refunds and anchors with incoming viewing keys: `ZPV_UIVK=… zpay-verify verify <txid> --amount <zat> --memo <memo>`.

Added here: `ZPV_UIVK=… zpay-verify owns <ua>` says which shielded receivers of a unified address the
key derives (Orchard: the key decrypts the diversifier to an index that re-derives the address;
Sapling likewise) and prints a single-receiver address to pay (`pay_to`, Orchard first). Exit 0 if a
receiver is covered, 1 if none is, 2 if the address or key does not decode. The solver and the
verifier use it to refuse an intent whose `receive_uivk` is not the key of `receive_ua`
(`RECEIVE_KEY_MISMATCH`). Tests: 7 + doc (`cargo test --release`), the `owns` cases on the published
run's addresses and keys.
