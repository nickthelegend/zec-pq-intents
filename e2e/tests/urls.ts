// The stack's URLs (e2e/stack.sh): the same YAKSOK_*_PORT variables pick the ports for both, so a
// port another program holds can be avoided; a full YAKSOK_* URL overrides a port.
const port = (name: string, dflt: number) => process.env[`YAKSOK_${name}_PORT`] ?? String(dflt);
export const LANDING = process.env.YAKSOK_LANDING ?? `http://127.0.0.1:${port('LANDING', 4183)}/`;
export const TERMINAL = process.env.YAKSOK_TERMINAL ?? `http://127.0.0.1:${port('TERMINAL', 5181)}/`;
/** read-only desk over deployments/testnet.json (Oct 20) */
export const DESK = process.env.YAKSOK_DESK ?? `http://127.0.0.1:${port('DESK', 8404)}`;
/** read-only desk over deployments/testnet-pass2.json (Oct 21, pass 2) */
export const DESK2 = process.env.YAKSOK_DESK2 ?? `http://127.0.0.1:${port('DESK2', 8405)}`;
/** The full record next to the landing (the landing until Oct 25): tape, book, refusals, limits. */
export const EVIDENCE = new URL('evidence.html', LANDING).href;
