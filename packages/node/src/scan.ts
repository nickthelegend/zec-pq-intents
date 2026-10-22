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

/** Runs zpay-verify with `env` (keys go in the environment only). Exit 0 and 1 are verdicts. */
async function zpv(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  const full: Record<string, string> = { PATH: process.env.PATH ?? '', ...env };
  if (process.env.PQI_LWD_URL) full.ZPV_LWD_URL = process.env.PQI_LWD_URL;
  return new Promise((res, rej) => {
    const p = spawn(scanBinary(), args, { env: full });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (c) => res({ code: c, out, err }));
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

/** UFVK → UIVK with the scan binary (env only). */
export async function uivkFromUfvk(ufvk: string): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  return execFileSync(scanBinary(), ['derive'], { env: { PATH: process.env.PATH ?? '', ZPV_UFVK: ufvk } }).toString().trim();
}

/** Current chain height from lightwalletd. */
export async function chainTip(): Promise<number> {
  const { execFileSync } = await import('node:child_process');
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (process.env.PQI_LWD_URL) env.ZPV_LWD_URL = process.env.PQI_LWD_URL;
  return Number(execFileSync(scanBinary(), ['tip'], { env }).toString().trim());
}
