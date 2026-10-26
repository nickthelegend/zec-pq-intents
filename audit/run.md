# Final Yaksok audit run — Oct 26, 2026

The fixed public URLs were used unchanged: https://yaksok-landing.vercel.app,
https://yaksok-terminal.vercel.app and https://yaksok-api.201-18-198-162.sslip.io.
Local pages came from `e2e/stack.sh`: assembled site :4183, Vite preview :5181,
published Oct 20/pass-2 desks :8404/:8405, plus a published-only pass-3 desk :8406.
The stack and Chrome ran under `heavy-slot.sh acquire yaksok-audit-final`; an EXIT/INT/TERM
trap stops the owned stack PIDs, stops the extra desk PID, and releases that same slot name.
No deploy or push was performed.

The three source fixes were first rechecked in Chrome from page load (all 10 local landing rows
and all 13 local evidence rows passed). A fresh final browser pass then ran every L/E/T ID in
AUDIT.md order. The two anchor-chain rows were rechecked from page load after the audit locator was disambiguated (each anchor correctly appears in both the summary and chain detail); only those final captures replace their earlier captures. The final tool pass followed with D, P, M, C, S and Z checks. Funded submit,
resubmit, crash re-execution and Docker were not substituted with another test.

`e2e/audit-browser.mjs` drives installed Google Chrome through Playwright. Every local terminal
ID runs on both local terminal surfaces. It records every console message, page error, failed
request and response status, including fonts and analytics. There is no request interception.
Screenshots are viewport JPEGs, limited to 200,000 bytes; mobile rows use 375x812 and desktop
rows use 1280x800. Only this final pass's browser screenshots and logs are retained.

`e2e/audit-tools/desk.mjs` uses curl against the real published HTTP handlers; negative requests
must preserve the log length. `protocol-extra.ts` invokes the actual protocol implementation,
including seal/open, signature and encoding failures, and log edits. Protocol tests separately
assert fork, hidden-anchor, head-mismatch and legacy-anchor failures. `mcp.mjs` uses a real stdio
MCP client and the real scanner for pinned read-only anchor memo checks. Its HTTP diagnostic
subscriber observes real undici traffic without replacing it, proving invalid schemas and the
missing-agent setup case cause no HTTP lookup. `cli.mjs` exercises actual check-anchors exits;
the absent zingo-cli prevents crediting full escrow-history checks. `chain.mjs` compares recorded
txids and README links only; those rows make no fresh confirmation claim. The selected node
suite additionally re-reads recorded funding, fill, release, refund and anchor data on testnet.

The tested product uses no new mocks, stubs or fabricated fallback data. The UI labels the
published testnet runs, and actual cryptographic verification runs in the tab. Browser network
and console health is recorded per surface in `browser/logs/*.jsonl`. Deliberate curl refusals and
cross-origin-write blocks in the regression suite are expected negative probes.

Four failures remain: the public ticket lacks the intent hash and payout; public flow copy lacks
solver delivery and refund behavior; public evidence refusal cards have no inspector; and the
public proxy omits `Connection: close` on oversized POSTs. The first three are fixed in source
and pass locally. The fourth needs a deployment/proxy change; the local handler already returns
the required header. Deployment is forbidden in this run, so none was relabeled PASS.

M-submit-live, M-resubmit-live and FLOW-kill-live need a funded Zcash testnet send and were not
invoked. C-pass3, C-behind and C-allow-behind need zingo-cli. DOCKER needs a running Docker daemon
(the installed client cannot connect) and the deployment's external coolify network. The protected
wallet and .env were never opened or passed; no Zcash transaction was sent.

The authoritative Loom memory forbids worker commits. These are proposed fix commit subjects,
not claims of existing commits:

- Show the recorded intent hash and payout on the landing ticket
- Explain solver delivery and escrow release or refund on the landing
- Open signed refusal entries in the evidence inspector

The separate audit-close subject for Loom is `Record the final Yaksok audit results and evidence`.
Measured suite counts and exact commands are in TESTING.md. Resource cleanup is recorded in
`cleanup.txt` after the final checks.
