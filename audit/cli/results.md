| ID | status | exact observed result | evidence path |
| --- | --- | --- | --- |
| C-bad-flag | PASS | exit 2; stderr "Setup required: argument (unknown option --unknown)"; stdout "" | audit/cli/check-anchors.log |
| C-no-pin | PASS | exit 2; stderr "Setup required: PQI_VERIFIER_ID (the key id of the verifier you trust)"; stdout "" | audit/cli/check-anchors.log |
| C-no-escrow-pin | PASS | exit 2; stderr "Setup required: PQI_ESCROW_UA (the escrow address you trust (or PQI_ESCROW_UFVK); the source supplies the key whose history is read, so it cannot pick it)"; stdout "" | audit/cli/check-anchors.log |
| C-url-allow-behind | PASS | exit 2; stderr "Setup required: argument (--allow-behind is for older record files only; a desk must serve its whole log)"; stdout "" | audit/cli/check-anchors.log |
| C-no-zingo | PASS | exit 2; PQI_ZINGO_CLI=/tmp/yaksok-final/missing-zingo-cli (missing file, not a wallet directory); output "Setup required: PQI_ZINGO_CLI (no zingo-cli at /tmp/yaksok-final/missing-zingo-cli; build zingolib 0a5cb69ab (cargo build --release -p zingo-cli) and point PQI_ZINGO_CLI at target/release/zingo-cli)" | audit/cli/check-anchors.log |
| C-pass3 | UNTESTED | needs zingo-cli. Default path ~/src/zingolib/target/release/zingo-cli is absent and zingo-cli is not on PATH (rechecked in this run). The read-only escrow history check was not run. No wallet directory was passed. | audit/cli/check-anchors.log |
| C-behind | UNTESTED | needs zingo-cli. Default path ~/src/zingolib/target/release/zingo-cli is absent and zingo-cli is not on PATH (rechecked in this run). The read-only escrow history check was not run. No wallet directory was passed. | audit/cli/check-anchors.log |
| C-allow-behind | UNTESTED | needs zingo-cli. Default path ~/src/zingolib/target/release/zingo-cli is absent and zingo-cli is not on PATH (rechecked in this run). The read-only escrow history check was not run. No wallet directory was passed. | audit/cli/check-anchors.log |
