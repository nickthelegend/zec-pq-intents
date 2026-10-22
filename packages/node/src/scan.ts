// Viewing-key checks through the zpay-verify binary (packages/scan). The key goes in the child's
// environment only. A failure to check throws; a verdict is a verdict.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ScanOutput {
  pool: string;
  value: number;
  memo: string | null;
  memo_binary: boolean;
}
export interface ScanResult {
  ok: boolean;
  reasons: string[];
  paidZat: number;
  txid: string;
  found: boolean;
  height: number | null;
  confirmations: number;
  tip: number;
  outputs: ScanOutput[];
  transparent: boolean;
}

export class SetupRequiredError extends Error {
  constructor(public readonly missing: string, detail?: string) {
    super(`Setup required: ${missing}${detail ? ` (${detail})` : ''}`);
    this.name = 'SetupRequiredError';
  }
}

export function scanBinary(env: Record<string, string | undefined> = process.env): string {
  if (env.PQI_SCAN_BIN) {
    if (!existsSync(env.PQI_SCAN_BIN)) throw new SetupRequiredError('PQI_SCAN_BIN', `${env.PQI_SCAN_BIN} does not exist`);
    return env.PQI_SCAN_BIN;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const found = [resolve(here, '../../scan/target/release/zpay-verify'), env.CARGO_TARGET_DIR ? resolve(env.CARGO_TARGET_DIR, 'release/zpay-verify') : ''].find((p) => p && existsSync(p));
  if (!found) throw new SetupRequiredError('PQI_SCAN_BIN', 'build packages/scan (cargo build --release)');
  return found;
}

/** How long one zpay-verify call may take before it is killed (PQI_SCAN_TIMEOUT_MS, default 90 s;
 *  the binary itself gives up connecting after 10 s and on a request after 60 s). */
export const scanTimeoutMs = (env: Record<string, string | undefined> = process.env) => {
  const ms = Number(env.PQI_SCAN_TIMEOUT_MS ?? 90_000);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : 90_000;
};

/** Runs zpay-verify with `env` (keys go in the environment only), asynchronously, so a slow or
 *  unreachable lightwalletd never blocks the process. Exit 0 and 1 are verdicts. A call that runs
 *  past scanTimeoutMs() is killed and rejected. */
async function zpv(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  const full: Record<string, string> = { PATH: process.env.PATH ?? '', ...env };
  if (process.env.PQI_LWD_URL) full.ZPV_LWD_URL = process.env.PQI_LWD_URL;
  const ms = scanTimeoutMs();
  return new Promise((res, rej) => {
    const p = spawn(scanBinary(), args, { env: full });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      rej(new Error(`zpay-verify ${args[0]} timed out after ${ms} ms (lightwalletd ${full.ZPV_LWD_URL ?? 'https://testnet.zec.rocks:443'})`));
    }, ms);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => (clearTimeout(timer), rej(e)));
    p.on('close', (c) => (clearTimeout(timer), res({ code: c, out, err })));
  });
}

/** Did `txid` pay the holder of `uivk` at least `amountZat` with exactly `memo`? */
export async function scan(uivk: string, txid: string, amountZat: bigint | number, memo: string | undefined, minConf = 1): Promise<ScanResult> {
  const args = ['verify', txid, '--amount', String(amountZat), '--min-conf', String(minConf)];
  if (memo !== undefined) args.push('--memo', memo);
  const { code, out, err } = await zpv(args, { ZPV_UIVK: uivk });
  if (code !== 0 && code !== 1) throw new Error(`scan failed: ${err.replace(/^error: /, '').trim()}`);
  const j = JSON.parse(out) as { report: { txid: string; found: boolean; height: number | null; confirmations: number; tip: number; outputs: ScanOutput[]; pools: { transparent: boolean } }; verdict: { ok: boolean; reasons: string[]; paid_zat: number } };
  return { ok: j.verdict.ok, reasons: j.verdict.reasons, paidZat: j.verdict.paid_zat, txid: j.report.txid, found: j.report.found, height: j.report.height, confirmations: j.report.confirmations, tip: j.report.tip, outputs: j.report.outputs, transparent: j.report.pools.transparent };
}

export interface Ownership {
  address: string;
  /** receivers the address has: orchard, sapling, transparent */
  receivers: string[];
  /** its shielded receivers that the key derives */
  covered: string[];
  /** a unified address with one covered receiver (Orchard first) to pay instead; null if none is covered */
  pay_to: string | null;
}

/** Does `uivk` derive a shielded receiver of `ua`? Local (no network). An address or key that does
 *  not decode is answered as covering nothing, with the decoder's reason. */
export async function owns(uivk: string, ua: string): Promise<Ownership & { invalid?: string }> {
  const { code, out, err } = await zpv(['owns', ua], { ZPV_UIVK: uivk });
  const why = err.replace(/^error: /, '').trim();
  if (code === 2 && /^not a testnet unified (address|incoming viewing key)/.test(why)) return { address: ua, receivers: [], covered: [], pay_to: null, invalid: why };
  if (code !== 0 && code !== 1) throw new Error(`owns check failed: ${why}`);
  return JSON.parse(out) as Ownership;
}

/** The receive address of `uivk` at Orchard diversifier `index` (local). Each index is a different
 *  address the same key sees, so every intent can be delivered to an address of its own. */
export async function addressAt(uivk: string, index: number): Promise<string> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** 32) throw new Error('the diversifier index must be a whole number below 2^32');
  const { code, out, err } = await zpv(['address', String(index)], { ZPV_UIVK: uivk });
  if (code !== 0) throw new Error(`address derivation failed: ${err.replace(/^error: /, '').trim()}`);
  return out.trim();
}

/** UFVK → UIVK with the scan binary (env only). */
export async function uivkFromUfvk(ufvk: string): Promise<string> {
  const { code, out, err } = await zpv(['derive'], { ZPV_UFVK: ufvk });
  if (code !== 0) throw new Error(`derive failed: ${err.replace(/^error: /, '').trim()}`);
  return out.trim();
}

/** Current chain height from lightwalletd (asynchronous, with the scan timeout). */
export async function chainTip(): Promise<number> {
  const { code, out, err } = await zpv(['tip'], {});
  if (code !== 0) throw new Error(`chain tip: ${err.replace(/^error: /, '').trim()}`);
  const h = Number(out.trim());
  if (!Number.isSafeInteger(h) || h <= 0) throw new Error(`chain tip: lightwalletd answered ${JSON.stringify(out.trim().slice(0, 40))}, not a block height`);
  return h;
}
