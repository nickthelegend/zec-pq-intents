#!/usr/bin/env node
// Anchor checker: lists every anchor the escrow sent (view-only wallet from its full viewing key) and
// checks a log against them: one chain, no fork, every anchor in the log, every anchored head the
// log's own entry. Exit 0 when it all holds, 1 when it does not, 2 for setup.
//   pnpm --filter @pqi/node check-anchors <record.json | desk URL>
// Env: PQI_VERIFIER_ID  key id of the verifier you trust (required; the source cannot vouch for itself)
//      PQI_ESCROW_UFVK  the escrow's full viewing key (default: the record's wallets.escrow.ufvk)
//      PQI_ESCROW_BIRTHDAY (default: the record's wallets.escrow.birthday)
//      PQI_HISTORY_WALLET  directory for the view-only wallet (default: a new temporary one)
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAnchors, fromB64, keyId, verifyLog, type LogEntry } from '@pqi/protocol';
import { anchorHistory } from './anchors.js';
import { SetupRequiredError } from './scan.js';
import { openViewWallet, zingoConfig } from './zingo.js';

async function load(src: string): Promise<{ log: LogEntry[]; pk: string; ufvk?: string; birthday?: number }> {
  if (/^https?:\/\//.test(src)) {
    const [info, { log }] = await Promise.all([fetch(`${src}/api/info`).then((r) => r.json()), fetch(`${src}/api/log`).then((r) => r.json())]);
    return { log, pk: info.verifier.pk, ufvk: info.escrow?.ufvk, birthday: info.escrow?.birthday };
  }
  if (!existsSync(src)) throw new SetupRequiredError('record', `${src} does not exist`);
  const d = JSON.parse(readFileSync(src, 'utf8'));
  return { log: d.log, pk: d.keys.verifier.pk, ufvk: d.wallets?.escrow?.ufvk, birthday: d.wallets?.escrow?.birthday };
}

async function main() {
  const src = process.argv[2];
  if (!src) throw new SetupRequiredError('argument', 'a record file or a desk URL');
  const pinned = process.env.PQI_VERIFIER_ID;
  if (!pinned || !/^[0-9a-f]{64}$/.test(pinned)) throw new SetupRequiredError('PQI_VERIFIER_ID', 'the key id of the verifier you trust');
  const r = await load(src);
  const pk = fromB64(r.pk);
  if (keyId(pk) !== pinned) return { ok: false, problem: `the log is signed by ${keyId(pk)}, not the pinned ${pinned}` };
  const v = verifyLog(r.log, pk);
  if (!v.ok) return { ok: false, problem: `log entry ${v.error?.seq}: ${v.error?.problem}` };
  const ufvk = process.env.PQI_ESCROW_UFVK ?? r.ufvk;
  const birthday = Number(process.env.PQI_ESCROW_BIRTHDAY ?? r.birthday);
  if (!ufvk || !birthday) throw new SetupRequiredError('PQI_ESCROW_UFVK and PQI_ESCROW_BIRTHDAY', 'the escrow full viewing key and wallet birthday');
  const wallet = process.env.PQI_HISTORY_WALLET ?? join(mkdtempSync(join(tmpdir(), 'pqi-escrow-view-')), 'wallet');
  const cfg = zingoConfig();
  await openViewWallet(cfg, wallet, ufvk, birthday);
  const sent = await anchorHistory(cfg, wallet);
  return { entries: r.log.length, anchors_in_escrow_history: sent.length, ...checkAnchors(r.log, sent) };
}

main().then(
  (out) => {
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
  },
  (e: Error) => {
    console.error(e.message);
    process.exit(e instanceof SetupRequiredError ? 2 : 1);
  },
);
