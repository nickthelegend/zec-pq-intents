// What a fresh clone hits before anything is built or installed: each missing piece is "Setup
// required" naming the variable to set, never a raw spawn error. Local.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { address, SetupRequiredError, zingoConfig } from '../src/index.js';

const ROOT = resolve(__dirname, '../../..');
const VERIFIER = 'f60f130579386479043287fb68c2c1726a0a210be77aee46b355adb1287f1445';
const checkAnchors = (env: Record<string, string>, record = resolve(ROOT, 'deployments/testnet-pass2.json')) =>
  spawnSync(resolve(__dirname, '../node_modules/.bin/tsx'), [resolve(__dirname, '../src/check-anchors.ts'), record], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, encoding: 'utf8', timeout: 60_000 });

describe('Setup required', () => {
  it('no zingo-cli binary: Setup required: PQI_ZINGO_CLI, with how to build it', async () => {
    const err = await address(zingoConfig({ PQI_ZINGO_CLI: '/nonexistent/zingo-cli' }), mkdtempSync(join(tmpdir(), 'pqi-w-'))).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SetupRequiredError);
    expect((err as Error).message).toMatch(/^Setup required: PQI_ZINGO_CLI \(no zingo-cli at \/nonexistent\/zingo-cli; build zingolib 0a5cb69ab/);
  });

  it('check-anchors without zingo-cli exits 2 with Setup required', () => {
    const r = checkAnchors({ PQI_VERIFIER_ID: VERIFIER, PQI_ZINGO_CLI: '/nonexistent/zingo-cli' });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr.trim()).toMatch(/^Setup required: PQI_ZINGO_CLI/);
  });
});
