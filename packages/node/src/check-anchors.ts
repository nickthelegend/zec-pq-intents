#!/usr/bin/env node
// Anchor checker: lists every anchor the escrow sent (view-only wallet from its full viewing key) and
// checks a log against them: one chain, no fork, every anchor in the log, every anchored head the
// log's own entry. Exit 0 when it all holds, 1 when it does not, 2 for setup.
//   pnpm --filter @pqi/node check-anchors <record.json | desk URL>
// Env: PQI_VERIFIER_ID  key id of the verifier you trust (required; the source cannot vouch for itself)
//      PQI_ESCROW_UA    the escrow address you trust (required, or PQI_ESCROW_UFVK): the source
//                       supplies the full viewing key whose history defines "every anchor the escrow
//                       sent", so that key must derive the pinned escrow, and the source's intents
//                       must name that escrow, or nothing is read
//      PQI_ESCROW_UFVK  the escrow's full viewing key (default: the source's, checked against PQI_ESCROW_UA)
//      PQI_ESCROW_BIRTHDAY (default: the record's wallets.escrow.birthday)
//      PQI_HISTORY_WALLET  directory for the view-only wallet (default: a new temporary one)
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAnchors, fromB64, keyId, verifyLog, type LogEntry } from '@pqi/protocol';
import { anchorHistory } from './anchors.js';
import { owns, SetupRequiredError, uivkFromUfvk } from './scan.js';
import { openViewWallet, zingoConfig } from './zingo.js';

type Source = { log: LogEntry[]; pk: string; escrow?: string; intentEscrows: string[]; ufvk?: string; birthday?: number };

async function load(src: string): Promise<Source> {
  if (/^https?:\/\//.test(src)) {
    const [info, { log }] = await Promise.all([fetch(`${src}/api/info`).then((r) => r.json()), fetch(`${src}/api/log`).then((r) => r.json())]);
    return { log, pk: info.verifier.pk, escrow: info.escrow?.address, intentEscrows: [], ufvk: info.escrow?.ufvk, birthday: info.escrow?.birthday };
  }
  if (!existsSync(src)) throw new SetupRequiredError('record', `${src} does not exist`);
  const d = JSON.parse(readFileSync(src, 'utf8'));
  const intents = [...Object.values(d.intents ?? {}), ...(d.intent ? [d.intent] : [])] as { signed?: { intent?: { escrow?: string } } }[];
  return { log: d.log, pk: d.keys.verifier.pk, escrow: d.wallets?.escrow?.address, intentEscrows: intents.map((i) => i.signed?.intent?.escrow ?? ''), ufvk: d.wallets?.escrow?.ufvk, birthday: d.wallets?.escrow?.birthday };
}

/** The full viewing key whose history is read must be the escrow's you pinned: the source cannot
 *  choose whose history counts as "every anchor the escrow sent". */
async function pinnedEscrowKey(r: Source): Promise<string> {
  const pinUa = process.env.PQI_ESCROW_UA;
  const pinUfvk = process.env.PQI_ESCROW_UFVK;
  if (!pinUa && !pinUfvk) throw new SetupRequiredError('PQI_ESCROW_UA', 'the escrow address you trust (or PQI_ESCROW_UFVK); the source supplies the key whose history is read, so it cannot pick it');
  const ufvk = pinUfvk ?? r.ufvk;
  if (!ufvk) throw new SetupRequiredError('PQI_ESCROW_UFVK', 'the source publishes no escrow full viewing key');
  const escrow = pinUa ?? r.escrow;
  if (!escrow) throw new SetupRequiredError('PQI_ESCROW_UA', 'the source names no escrow address');
  if (pinUa && r.escrow && r.escrow !== pinUa) throw new SetupRequiredError('PQI_ESCROW_UA', `the source's escrow ${r.escrow} is not the pinned ${pinUa}`);
  const other = r.intentEscrows.find((e) => e !== escrow);
  if (other !== undefined) throw new SetupRequiredError('PQI_ESCROW_UA', `an intent in the source names escrow ${other}, not ${escrow}`);
  let covered = false;
  try {
    covered = (await owns(await uivkFromUfvk(ufvk), escrow)).pay_to !== null;
  } catch (e) {
    if (e instanceof SetupRequiredError) throw e;
    covered = false;
  }
  if (!covered) throw new SetupRequiredError(pinUfvk ? 'PQI_ESCROW_UFVK' : 'PQI_ESCROW_UA', `the escrow full viewing key ${pinUfvk ? 'you pinned' : 'the source supplies'} does not derive the escrow ${escrow}; its history is not that escrow's`);
  return ufvk;
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
  const ufvk = await pinnedEscrowKey(r);
  const birthday = Number(process.env.PQI_ESCROW_BIRTHDAY ?? r.birthday);
  if (!birthday) throw new SetupRequiredError('PQI_ESCROW_BIRTHDAY', 'the escrow wallet birthday');
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
