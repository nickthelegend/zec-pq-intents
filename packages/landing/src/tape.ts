// The landing's one moving part: the attestation tape prints entry by entry as each ML-DSA-65
// signature, hash and link is re-checked in this tab (real work, @pqi/protocol), then every anchored
// head is recomputed and each anchor's link to the one before it checked. Bundled to
// ../assets/tape.js by build.mjs.
import { entryHash, GENESIS, fromB64, verifySig, type LogEntry } from '../../protocol/src/index.ts';
import run from './run.json';

type Anchor = { entry: number; seq: number; head: string; txid: string; prev: string | null };
const r = run as unknown as { verifier: { id: string; pk: string }; log: LogEntry[]; anchors: Anchor[] };
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id: string) => document.getElementById(id);
const set = (id: string, text: string, state?: string) => {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  if (state) el.dataset.state = state;
};

async function main() {
  const rows = [...document.querySelectorAll<HTMLElement>('#tape [data-seq]')];
  const pk = fromB64(r.verifier.pk);
  let prev = GENESIS;
  let good = 0;
  set('verify-state', 'checking', 'checking');
  for (let i = 0; i < r.log.length; i++) {
    if (!reduced) await new Promise((ok) => setTimeout(ok, 140));
    const { hash, sig, ...body } = r.log[i];
    let ok = false;
    try {
      ok = body.seq === i && body.prev === prev && entryHash(body) === hash && verifySig(pk, 'pqi1:log:', hash, sig);
    } catch {
      ok = false;
    }
    prev = hash;
    if (ok) good++;
    const row = rows[i];
    if (row) {
      row.dataset.check = ok ? 'ok' : 'bad';
      const cell = row.querySelector('.sigcell');
      if (cell) cell.textContent = ok ? 'sig ok' : 'fails';
    }
    set('verify-count', `${good}/${r.log.length}`);
    const bar = $('verify-bar');
    if (bar) bar.style.setProperty('--p', String((i + 1) / r.log.length));
  }
  const all = good === r.log.length;
  set('verify-state', all ? 'verified in this tab' : `${r.log.length - good} failed`, all ? 'ok' : 'bad');
  // Each anchored head is the log's own entry at that seq; each anchor names the one before it (the
  // first names none, or genesis).
  const heads = r.anchors.every((a) => r.log[a.seq]?.hash === a.head);
  const links = r.anchors.every((a, i) => (i === 0 ? a.prev === null || a.prev === GENESIS : a.prev === r.anchors[i - 1].txid));
  const seqs = r.anchors.map((a) => `#${a.seq}`);
  const text = !heads ? 'an anchored head does not match the log' : !links ? 'an anchor does not name the one before it' : `${seqs.join(' and ')} match (recomputed here)${seqs.length > 1 ? ` · ${seqs.slice(1).map((s, i) => `${s} names ${seqs[i]}`).join(', ')}` : ''}`;
  set('anchor-check', text, heads && links ? 'ok' : 'bad');
}

main().catch((e: Error) => set('verify-state', `could not run the check: ${e.message}`, 'bad'));
