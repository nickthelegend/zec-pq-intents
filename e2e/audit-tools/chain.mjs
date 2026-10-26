// Read-only txid compare. Prints prefixes and match flags only. Never prints viewing keys.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const outDir = join(root, 'audit/chain');
mkdirSync(outDir, { recursive: true });

const load = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));
const oct = load('deployments/testnet.json');
const p2 = load('deployments/testnet-pass2.json');
const p3 = load('deployments/testnet-pass3.json');

const A = '48a440a659848bcf73cd912be8616be34491132aaf5b277e59e962becf085ca2';

const rows = [
  ['Z-funding', 'deployments/testnet.json', 'txs.funding', oct.txs.funding, '1d6b38683c64a5e157af4cbfed344dca3604c28242f178de83894654b68354d9', '1d6b3868'],
  ['Z-fill', 'deployments/testnet.json', `txs.fills.${A}`, oct.txs.fills[A], '2970d8ba4538bdfae599a64d016c65231e42addb544ccdc1a609f17df59448cb', '2970d8ba'],
  ['Z-release', 'deployments/testnet.json', 'txs.releases.0', oct.txs.releases[0], '9800b912682a0630a64dd4a54c245fc7c0810ee117eed7b304138fddda63b7c2', '9800b912'],
  ['Z-wrong-memo-fill', 'deployments/testnet.json', 'txs.wrongMemoFill', oct.txs.wrongMemoFill, '36d0f49acbcb0498073393f554c135697cb5c0bccc6ce788deb6b3c3a05bc33a', '36d0f49a'],
  ['Z-late-fill', 'deployments/testnet.json', 'txs.lateFill', oct.txs.lateFill, '3b81e337b0669f97ad0f8c4a02a0e332a412a65276fbb5db0088704c6c39b1bb', '3b81e337'],
  ['Z-refund', 'deployments/testnet.json', 'txs.refund', oct.txs.refund, '357b706505ae07232939aa39fe7a862363283b49a06e4a62fafc6eaa823a2966', '357b7065'],
  ['Z-anchor', 'deployments/testnet.json', 'txs.anchor', oct.txs.anchor, 'a7d960386f2d8dc926003e700b15bcc761b6e72419765ea6f958a85d73a65a73', 'a7d96038'],
  ['Z-pass2-release', 'deployments/testnet-pass2.json', 'txs.release', p2.txs.release, 'c0557316e0378e65a3d63b2996a139b88dff37f8bfe2e1ce5f3af32e8fca0db1', 'c0557316'],
  ['Z-pass2-anchor', 'deployments/testnet-pass2.json', 'txs.anchor', p2.txs.anchor, '694a94c7f81b83f396ca3f974f08eb7c43cc801663c442ff225a07a429a9b41c', '694a94c7'],
  ['Z-pass3-funding', 'deployments/testnet-pass3.json', 'txs.funding', p3.txs.funding, '3ba6409028ebb04a0331be9b9564245b4553aa9b847dec1ce21eb0532a1d3ac1', '3ba64090'],
  ['Z-pass3-fill', 'deployments/testnet-pass3.json', 'txs.fill', p3.txs.fill, '0ef36c7f68e08f1a825d5985df6b9a7efbf89f906f3e2d5f72a98caa97364b0a', '0ef36c7f'],
  ['Z-pass3-release', 'deployments/testnet-pass3.json', 'txs.release', p3.txs.release, '6b63f403ceaf79c436edb8a9457133c97ad9ff1998a5f3254b57dd469876599a', '6b63f403'],
  ['Z-pass3-anchor', 'deployments/testnet-pass3.json', 'txs.anchor', p3.txs.anchor, '7b1ce3f29e9fc14239fab38fba9d0286b2dab327f465d43f959c3d22f9766f4f', '7b1ce3f2'],
];

const logs = {
  'deployments/testnet.json': oct.log,
  'deployments/testnet-pass2.json': p2.log,
  'deployments/testnet-pass3.json': p3.log,
};

function refsFor(file, txid) {
  const hits = [];
  for (const e of logs[file]) {
    for (const [k, v] of Object.entries(e.refs ?? {})) {
      if (v === txid) hits.push(`#${e.seq} ${e.status}${e.reason ? ' ' + e.reason : ''} refs.${k}`);
    }
  }
  return hits;
}

const lines = [];
const table = [];
let bad = false;
for (const [id, file, field, got, full, prefix] of rows) {
  const same = got === full;
  const pref = typeof got === 'string' && got.startsWith(prefix);
  const inReadme = readme.includes(full) && readme.includes(prefix);
  const hits = refsFor(file, full);
  const ok = same && pref && inReadme && /^[0-9a-f]{64}$/.test(got);
  if (!ok) bad = true;
  const observed = `${file} ${field}=${got}; README prefix ${prefix} matches=${pref}; full txid equals README link=${same}; README contains full txid=${inReadme}; log refs: ${hits.join('; ') || 'none'}`;
  lines.push(`${id} ${ok ? 'PASS' : 'FAIL'}`);
  lines.push(observed);
  lines.push('');
  table.push({ id, status: ok ? 'PASS' : 'FAIL', observed });
}

const logPath = join(outDir, 'txids.log');
writeFileSync(logPath, lines.join('\n'));
const md = [
  '| ID | status | exact observed result | evidence path |',
  '| --- | --- | --- | --- |',
  ...table.map((r) => `| ${r.id} | ${r.status} | ${r.observed.replace(/\|/g, '\\|')} | audit/chain/txids.log |`),
  '',
].join('\n');
writeFileSync(join(outDir, 'results.md'), md);
console.log(`chain rows ${table.length} bad=${bad}`);
console.log(createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16));
