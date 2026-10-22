// What a fresh clone hits before anything is built or installed, and what an auditor must pin: each
// missing piece is "Setup required" naming the variable to set, never a raw spawn error, and the
// anchor checker never reads the history of a key the audited source chose. Local (these all stop
// before any wallet is opened).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { address, SetupRequiredError, zingoConfig } from '../src/index.js';

const ROOT = resolve(__dirname, '../../..');
const VERIFIER = 'f60f130579386479043287fb68c2c1726a0a210be77aee46b355adb1287f1445';
const p2 = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet-pass2.json'), 'utf8'));
const ESCROW = p2.wallets.escrow.address as string;
/** Another wallet's full viewing key: a throwaway seed's, holding nothing (see packages/scan's test). */
const OTHER_UFVK = readFileSync(resolve(__dirname, 'fixtures/throwaway-ufvk.txt'), 'utf8').trim();
const checkAnchors = (env: Record<string, string>, record = resolve(ROOT, 'deployments/testnet-pass2.json')) =>
  spawnSync(resolve(__dirname, '../node_modules/.bin/tsx'), [resolve(__dirname, '../src/check-anchors.ts'), record], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, encoding: 'utf8', timeout: 60_000 });

describe('Setup required', () => {
  it('no zingo-cli binary: Setup required: PQI_ZINGO_CLI, with how to build it', async () => {
    const err = await address(zingoConfig({ PQI_ZINGO_CLI: '/nonexistent/zingo-cli' }), mkdtempSync(join(tmpdir(), 'pqi-w-'))).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SetupRequiredError);
    expect((err as Error).message).toMatch(/^Setup required: PQI_ZINGO_CLI \(no zingo-cli at \/nonexistent\/zingo-cli; build zingolib 0a5cb69ab/);
  });

  it('check-anchors without zingo-cli exits 2 with Setup required', () => {
    const r = checkAnchors({ PQI_VERIFIER_ID: VERIFIER, PQI_ESCROW_UA: ESCROW, PQI_ZINGO_CLI: '/nonexistent/zingo-cli' });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr.trim()).toMatch(/^Setup required: PQI_ZINGO_CLI/);
  });

  it('check-anchors refuses --allow-behind for a desk URL (a desk must serve its whole log) and an unknown option, exit 2', () => {
    const tsx = resolve(__dirname, '../node_modules/.bin/tsx');
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PQI_VERIFIER_ID: VERIFIER, PQI_ESCROW_UA: ESCROW };
    const desk = spawnSync(tsx, [resolve(__dirname, '../src/check-anchors.ts'), 'http://127.0.0.1:9', '--allow-behind'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(desk.status, desk.stderr).toBe(2);
    expect(desk.stderr).toMatch(/^Setup required: argument \(--allow-behind is for older record files only; a desk must serve its whole log\)/);
    const odd = spawnSync(tsx, [resolve(__dirname, '../src/check-anchors.ts'), resolve(ROOT, 'deployments/testnet.json'), '--allow-forks'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(odd.status, odd.stderr).toBe(2);
    expect(odd.stderr).toMatch(/unknown option --allow-forks/);
  });

  it('check-anchors with no pinned escrow exits 2: the source supplies the key whose history is read', () => {
    const r = checkAnchors({ PQI_VERIFIER_ID: VERIFIER });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr.trim()).toMatch(/^Setup required: PQI_ESCROW_UA \(the escrow address you trust/);
  });

  it('check-anchors on a record whose escrow full viewing key is another wallet’s exits 2 before reading any history', () => {
    const forged = join(mkdtempSync(join(tmpdir(), 'pqi-rec-')), 'record.json');
    writeFileSync(forged, JSON.stringify({ ...p2, wallets: { ...p2.wallets, escrow: { ...p2.wallets.escrow, ufvk: OTHER_UFVK } } }));
    const r = checkAnchors({ PQI_VERIFIER_ID: VERIFIER, PQI_ESCROW_UA: ESCROW, PQI_ZINGO_CLI: '/nonexistent/zingo-cli' }, forged);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr.trim()).toBe(`Setup required: PQI_ESCROW_UA (the escrow full viewing key the source supplies does not derive the escrow ${ESCROW}; its history is not that escrow's)`);
    const pinnedWrong = checkAnchors({ PQI_VERIFIER_ID: VERIFIER, PQI_ESCROW_UFVK: OTHER_UFVK, PQI_ZINGO_CLI: '/nonexistent/zingo-cli' });
    expect(pinnedWrong.status).toBe(2);
    expect(pinnedWrong.stderr).toMatch(/^Setup required: PQI_ESCROW_UFVK \(the escrow full viewing key you pinned does not derive/);
  });

  it('check-anchors refuses a source whose escrow is not the pinned one', () => {
    const r = checkAnchors({ PQI_VERIFIER_ID: VERIFIER, PQI_ESCROW_UA: p2.wallets.user.address, PQI_ZINGO_CLI: '/nonexistent/zingo-cli' });
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(`Setup required: PQI_ESCROW_UA (the source's escrow ${ESCROW} is not the pinned ${p2.wallets.user.address})`);
  });
});
