import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const repo = process.cwd();
const tsx = `${repo}/packages/node/node_modules/.bin/tsx`;
const serve = `${repo}/packages/node/src/serve.ts`;
const envBase = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
const expect = 'Setup required: PQI_STATE or PQI_PUBLISHED';

function run(extra) {
  const r = spawnSync(tsx, [serve], { env: { ...envBase, ...extra }, encoding: 'utf8' });
  const stderr = (r.stderr ?? '').trim();
  const stdout = (r.stdout ?? '').trim();
  return { status: r.status, stdout, stderr };
}

const empty = run({});
const missing = run({ PQI_PUBLISHED: '/tmp/yaksok-final/no-such-record.json' });
const row = (id, r, why) => {
  const exact = r.status === 2 && r.stderr === expect && !r.stdout.includes('pqi desk on');
  return {
    id,
    ok: exact,
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    observed: `exit ${r.status}; stderr ${JSON.stringify(r.stderr)}; stdout ${JSON.stringify(r.stdout)}; ${why}`,
  };
};
const rows = [
  row('D-local-empty', empty, 'neither PQI_PUBLISHED nor PQI_STATE; no listen line'),
  row('D-local-missing-record', missing, 'PQI_PUBLISHED names a nonexistent file and PQI_STATE is unset'),
];
writeFileSync('/tmp/yaksok-final/empty.json', JSON.stringify(rows, null, 2));
console.log(rows.map((r) => `${r.id} ${r.ok ? 'PASS' : 'FAIL'} exit=${r.status} stderr=${JSON.stringify(r.stderr)}`).join('\n'));
