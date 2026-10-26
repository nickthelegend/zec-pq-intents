// check-anchors. Does not print the deployment record. No wallet directory is passed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.cwd();
const tsx = `${repo}/packages/node/node_modules/.bin/tsx`;
const script = `${repo}/packages/node/src/check-anchors.ts`;
const pass3 = `${repo}/deployments/testnet-pass3.json`;
const oct = `${repo}/deployments/testnet.json`;
const VERIFIER = 'f60f130579386479043287fb68c2c1726a0a210be77aee46b355adb1287f1445';
const ESCROW = 'utest1fgwtrf8nq6e2j6w7rwa06k8ggmc5llsk3v7mjjnpy5ywmdfrjzuqfvlm4wpeggn9lq7cutkum7k75v8zqg2rxlg3z0k67lcz3cmcs558';
const outDir = join(repo, 'audit/cli');
mkdirSync(outDir, { recursive: true });

const redact = (s) => String(s ?? '').replace(/\buivk[0-9a-z]{8,}/gi, '[redacted-uivk]').replace(/\bufvk[0-9a-z]{8,}/gi, '[redacted-ufvk]');

function run(args, env) {
  const r = spawnSync(tsx, [script, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    encoding: 'utf8',
    cwd: repo,
    timeout: 120000,
  });
  const stdout = redact(r.stdout);
  const stderr = redact(r.stderr);
  if (/\b(uivk|ufvk)[0-9a-z]{8,}/i.test(stdout + stderr)) throw new Error('viewing key in check-anchors output');
  return { status: r.status, stdout: stdout.trim(), stderr: stderr.trim() };
}

const lines = [];
const say = (s) => lines.push(s);
const rows = [];

function add(id, status, observed) {
  rows.push({ id, status, observed });
  say(`${id} ${status}`);
  say(observed);
  say('');
}

const bad = run(['--unknown']);
add('C-bad-flag', bad.status === 2 && bad.stderr.includes('Setup required: argument (unknown option --unknown)') ? 'PASS' : 'FAIL',
  `exit ${bad.status}; stderr ${JSON.stringify(bad.stderr)}; stdout ${JSON.stringify(bad.stdout)}`);

const noPin = run([oct]);
add('C-no-pin', noPin.status === 2 && noPin.stderr.includes('Setup required: PQI_VERIFIER_ID (the key id of the verifier you trust)') ? 'PASS' : 'FAIL',
  `exit ${noPin.status}; stderr ${JSON.stringify(noPin.stderr)}; stdout ${JSON.stringify(noPin.stdout)}`);

const noEscrow = run([oct], { PQI_VERIFIER_ID: VERIFIER });
add('C-no-escrow-pin', noEscrow.status === 2 && noEscrow.stderr.startsWith('Setup required: PQI_ESCROW_UA') ? 'PASS' : 'FAIL',
  `exit ${noEscrow.status}; stderr ${JSON.stringify(noEscrow.stderr)}; stdout ${JSON.stringify(noEscrow.stdout)}`);

const urlBehind = run(['http://127.0.0.1:8406', '--allow-behind'], { PQI_VERIFIER_ID: VERIFIER, PQI_ESCROW_UA: ESCROW });
add('C-url-allow-behind', urlBehind.status === 2 && urlBehind.stderr.includes('Setup required: argument (--allow-behind is for older record files only; a desk must serve its whole log)') ? 'PASS' : 'FAIL',
  `exit ${urlBehind.status}; stderr ${JSON.stringify(urlBehind.stderr)}; stdout ${JSON.stringify(urlBehind.stdout)}`);

const missingBin = '/tmp/yaksok-final/missing-zingo-cli';
const noZingo = run([pass3], { PQI_VERIFIER_ID: VERIFIER, PQI_ESCROW_UA: ESCROW, PQI_ZINGO_CLI: missingBin, PQI_SCAN_BIN: process.env.PQI_SCAN_BIN ?? `${repo}/packages/scan/target/release/zpay-verify` });
const zingoPass = noZingo.status === 2 && (noZingo.stderr + noZingo.stdout).includes('Setup required: PQI_ZINGO_CLI');
add('C-no-zingo', zingoPass ? 'PASS' : 'FAIL',
  `exit ${noZingo.status}; PQI_ZINGO_CLI=${missingBin} (missing file, not a wallet directory); output ${JSON.stringify((noZingo.stderr || noZingo.stdout).slice(0, 500))}`);

const reason = 'needs zingo-cli';
for (const id of ['C-pass3', 'C-behind', 'C-allow-behind']) {
  add(id, 'UNTESTED', `${reason}. Default path ~/src/zingolib/target/release/zingo-cli is absent and zingo-cli is not on PATH (rechecked in this run). The read-only escrow history check was not run. No wallet directory was passed.`);
}

writeFileSync(join(outDir, 'check-anchors.log'), lines.join('\n'));
writeFileSync('/tmp/yaksok-final/cli-rows.json', JSON.stringify(rows, null, 2));
console.log(rows.map((r) => `${r.id} ${r.status}`).join('\n'));
