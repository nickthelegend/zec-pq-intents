// Yaksok terminal: the three published testnet runs, re-verified in this tab. Everything shown comes
// from deployments/testnet.json (Oct 20: intents A-C, entries #0-9), deployments/testnet-pass2.json
// (Oct 21: intent D, the same verifier's log continued to #12, a second anchor) and
// deployments/testnet-pass3.json (Oct 22: intent E submitted by an agent through MCP, a third
// anchor); every signature,
// hash, link and anchored head is re-computed here with @pqi/protocol. Values the tab cannot check
// (an on-chain memo) are labelled as recorded.
import { useEffect, useMemo, useState } from 'react';
import { checkAnchors, entryHash, fromB64, GENESIS, intentHash, keyId, verifyIntent, verifyLog, verifySig, type AnchorCheck, type AnchorSeen, type LogEntry, type SignedIntent } from '@pqi/protocol';
import run from '@deployments/testnet.json';
import pass2Run from '@deployments/testnet-pass2.json';
import pass3Run from '@deployments/testnet-pass3.json';

type K = 'A' | 'B' | 'C' | 'D' | 'E';
type IntentRec = { hash: string; signed: SignedIntent; envelope: { kem_ct: string; ct: string; to: string } };
type Rec = {
  ranAt: string;
  keys: Record<string, { scheme: string; id: string; pk: string }>;
  txs: { funding: string; wrongMemoFill: string; lateFill: string; fills: Record<string, string> };
  intents: Record<'A' | 'B' | 'C', IntentRec>;
  attacks: { decisions: Record<string, number>; reuse: SignedIntent; forgedAsUser: SignedIntent };
  log: LogEntry[];
};
const r = run as unknown as Rec;
/** Pass 2 (Oct 21): the same verifier's log continued from entry 10, intent D, the kill after D's
 *  release broadcast, and the escrow's sent anchors as that run read them. */
const p2 = pass2Run as unknown as {
  ranAt: string;
  keys: { verifier: { id: string; pk: string } };
  log: LogEntry[];
  intent: IntentRec;
  txs: { funding: string; fill: string; release: string; anchor: string; previousAnchor: string };
  theft: { status: string; reason: string; seq: number; solver: string };
  crash: { signal: string; write_ahead: { amount_zat: string; memo: string; at_height: number }; reconciled_txid: string; escrow_sends_with_release_memo: string[] };
  anchors?: { escrowHistory: AnchorSeen[] };
};
/** Pass 3 (Oct 22): an agent's intent E through MCP to a live desk, killed after the fill broadcast. */
const p3 = pass3Run as unknown as {
  ranAt: string;
  log: LogEntry[];
  intent: IntentRec;
  txs: { funding: string; fill: string; release: string; anchor: string; previousAnchor: string };
  agent: { quote: { fee_zat: number; refund_if_unfilled_zat: number }; receive_ua: string; receive_index: number };
  crash: { signal: string; board_after_kill: { delivering: { at_height: number } }; solver_sends_with_fill_memo: string[] };
  checks: { verify_log: { ok: boolean; entries: number; anchor: { anchors: number } }; check_anchors: { exit: number; chain: unknown[] } };
};
const EXPLORER = 'https://testnet.zcashexplorer.app/transactions/';
const REPO = 'https://github.com/nickthelegend/zec-pq-intents';
const LETTERS: K[] = ['A', 'B', 'C', 'D', 'E'];
/** How many published runs the page shows, in words. */
const RUNS = 'three';
const INTENTS: Record<K, IntentRec> = { ...r.intents, D: p2.intent, E: p3.intent };
const FUNDING: Record<K, string> = { A: r.txs.funding, B: r.txs.funding, C: r.txs.funding, D: p2.txs.funding, E: p3.txs.funding };
/** The whole log: Oct 20's #0-9, pass 2's #10-12, then pass 3's (the tab checks each extends the last). */
const LOG = p3.log;
const PASS2_FROM = r.log.length;
const PASS3_FROM = p2.log.length;
const short = (s: string, n = 8) => (s && s.length > n + 1 ? `${s.slice(0, n)}…` : s);
const zat = (v: string | number) => Number(v).toLocaleString('en-US');
const letterOf = (h: string | null) => LETTERS.find((k) => INTENTS[k].hash === h) ?? null;
const subject = (h: string | null) => (h ? (letterOf(h) ? `Intent ${letterOf(h)}` : `intent ${short(h, 6)}`) : 'log head');
const ANCHORS = LOG.filter((e) => e.status === 'ANCHORED');
const anchorEntry = ANCHORS[ANCHORS.length - 1] ?? null;
const anchoredSeq = anchorEntry ? Number(anchorEntry.refs.anchored_seq) : null;
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const Tx = ({ id, label }: { id?: string; label: string }) =>
  id ? (
    <a className="tx" href={EXPLORER + id} target="_blank" rel="noreferrer" aria-label={`${label} ${short(id)} on the Zcash testnet explorer`}>
      {short(id)}
    </a>
  ) : (
    <span className="faint">none</span>
  );

type Check = 'pending' | 'ok' | 'bad';

/** Real ML-DSA-65 work, one entry at a time, so the tape prints as it verifies. */
function useLogCheck(log: LogEntry[]) {
  const [checks, setChecks] = useState<Check[]>(() => log.map(() => 'pending'));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    (async () => {
      const pk = fromB64(r.keys.verifier.pk);
      let prev = GENESIS;
      for (let i = 0; i < log.length; i++) {
        await new Promise((ok) => setTimeout(ok, reduced ? 0 : 110));
        if (cancelled) return;
        const { hash, sig, ...body } = log[i];
        let good = false;
        try {
          good = body.seq === i && body.prev === prev && body.verifier === r.keys.verifier.id && entryHash(body) === hash && verifySig(pk, 'pqi1:log:', hash, sig);
        } catch {
          good = false; // a malformed entry is a failed check, not a stuck page
        }
        prev = hash;
        setChecks((c) => c.map((x, k) => (k === i ? (good ? 'ok' : 'bad') : x)));
      }
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [log]);
  return { checks, error };
}

const Mark = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <rect x="3" y="3" width="17" height="17" rx="2" fill="none" stroke="#f08a4b" strokeWidth="3.2" />
    <rect x="12" y="12" width="17" height="17" rx="2" fill="none" stroke="#efe9ff" strokeWidth="3.2" />
  </svg>
);

function Ticker() {
  const items = LOG.map((e) => (
    <li key={e.seq}>
      <b>#{e.seq}</b>
      <span className={`st st-${e.status.toLowerCase()}`}>{e.status}</span>
      {e.status === 'REJECTED' ? <code>{e.reason?.split(':')[0]}</code> : e.status === 'ANCHORED' ? `head ${short(e.refs.anchored_head)}` : `${subject(e.intent_hash)} · ${zat(e.refs.released_zat ?? e.refs.refunded_zat)} zat`}
    </li>
  ));
  const [paused, setPaused] = useState(false);
  return (
    <section className={`ticker${paused ? ' paused' : ''}`} aria-label={`Decisions from the ${RUNS} testnet runs`}>
      <div className="ticker-track">
        <ul>{items}</ul>
        <ul aria-hidden="true">{items}</ul>
      </div>
      <button type="button" className="ticker-toggle" data-paused={paused} onClick={() => setPaused((p) => !p)}>
        {paused ? 'Play' : 'Pause'}
        <span className="sr-only"> the scrolling decisions</span>
      </button>
    </section>
  );
}

function Bar({ good, done, n }: { good: number; done: number; n: number }) {
  const state = done < n ? 'checking' : good === n ? 'ok' : 'bad';
  return (
    <header className="bar">
      <a className="brand" href="#main" aria-label="Yaksok terminal, top">
        <Mark />
        <b>Yaksok</b>
        <span>terminal</span>
      </a>
      <div className="cells">
        <div className="cell">
          <small>Network</small>
          <span>
            <i className="dot" aria-hidden="true" />
            zcash-testnet
          </span>
        </div>
        <div className="cell">
          <small>Runs</small>
          <span>
            {day(r.ranAt)} + {day(p2.ranAt)} + {day(p3.ranAt)}
          </span>
        </div>
        <div className="cell">
          <small>Signatures</small>
          <span data-state={state}>
            {good}/{n} {state === 'checking' ? 'checking' : state === 'ok' ? 'verified here' : 'failed'}
          </span>
        </div>
        <div className="cell">
          <small>Verifier</small>
          <span>{short(r.keys.verifier.id)}</span>
        </div>
      </div>
      <nav className="acts" aria-label="Links">
        {/* Served under the landing (site/terminal/): a way back to it. */}
        {location.pathname.replace(/\/index\.html$/, '/').endsWith('/terminal/') ? (
          <a className="btn" href="../">
            Landing
          </a>
        ) : null}
        <a className="btn hide-s" href={`${REPO}/blob/main/packages/docs/README.md`}>
          Docs
        </a>
        <a className="btn btn-copper" href={REPO}>
          GitHub
        </a>
      </nav>
    </header>
  );
}

function Book({ sel, onSel }: { sel: K; onSel: (k: K) => void }) {
  const it = INTENTS[sel];
  const i = it.signed.intent;
  const entries = LOG.filter((e) => e.intent_hash === it.hash);
  const fin = entries.find((e) => e.status === 'SETTLED' || e.status === 'REFUNDED');
  const kemCt = fromB64(it.envelope.kem_ct).length;
  const ct = fromB64(it.envelope.ct).length;
  return (
    <section className="p s5" aria-labelledby="book-h">
      <div className="ph">
        <h2 id="book-h">Intent book</h2>
        <span className="meta">zat · {LETTERS.length} intents · 3 runs · pick one</span>
      </div>
      <div className="book" role="radiogroup" aria-label="Intents" onKeyDown={(e) => {
        // One tab stop for the group; the arrow keys (and Home/End) move the selection, as radios do.
        const i = LETTERS.indexOf(sel);
        const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: LETTERS.length - 1 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        const k = LETTERS[(next + LETTERS.length) % LETTERS.length];
        onSel(k);
        (e.currentTarget.querySelector(`[data-letter="${k}"]`) as HTMLElement | null)?.focus();
      }}>
        <div className="book-head" aria-hidden="true">
          <span>Intent</span>
          <span className="r">Escrow</span>
          <span className="r">Deliver ≥</span>
          <span className="r">Deadline</span>
          <span>Status</span>
        </div>
        {LETTERS.map((k) => {
          const x = INTENTS[k];
          const f = LOG.find((e) => e.intent_hash === x.hash && (e.status === 'SETTLED' || e.status === 'REFUNDED'));
          const st = f ? f.status.toLowerCase() : 'open';
          const ratio = Number(x.signed.intent.min_out_zat) / Number(x.signed.intent.pay_zat);
          return (
            <button key={k} role="radio" aria-checked={sel === k} tabIndex={sel === k ? 0 : -1} data-letter={k} className={`book-row ${st}${sel === k ? ' on' : ''}`} onClick={() => onSel(k)}>
              <span>
                <span className="letter">{k}</span>
                {short(x.hash)}
              </span>
              <span className="r">{zat(x.signed.intent.pay_zat)}</span>
              <span className="r depth" style={{ ['--d' as string]: ratio }}>
                {zat(x.signed.intent.min_out_zat)}
              </span>
              <span className="r">{zat(x.signed.intent.deadline_height)}</span>
              <span className={`st st-${st}`}>{st}</span>
            </button>
          );
        })}
      </div>
      <div className="pb detail">
        <ol className="steps">
          <li className="ok">
            <b>Signed</b> ML-DSA-65 by user {short(i.user)} · nonce {short(i.nonce)}
          </li>
          <li className="ok">
            <b>Sealed</b> ML-KEM-768 ct {zat(kemCt)} B + AES-GCM {zat(ct)} B to solver KEM {short(it.envelope.to)}
          </li>
          <li className="ok">
            <b>Funded</b> {zat(i.pay_zat)} zat <Tx id={FUNDING[sel]} label="funding" />
            {sel === 'D' || sel === 'E' ? ' · waited for 3 confirmations' : ''}
          </li>
          {sel === 'E' ? (
            <>
              <li className="ok">
                <b>Submitted</b> by an agent through MCP submit_intent, to a new receive address (index {zat(p3.agent.receive_index)})
              </li>
              <li className="ok">
                <b>Killed</b> by {p3.crash.signal} right after the fill broadcast; the restart found <Tx id={p3.txs.fill} label="fill" /> in the solver's history, not sent again
              </li>
            </>
          ) : sel === 'D' ? (
            <>
              <li className="ok">
                <b>Filled</b> {zat(i.min_out_zat)} zat, memo names the solver key <Tx id={p2.txs.fill} label="fill" />
              </li>
              <li className="bad">
                <b>Claim</b> by a second configured solver refused: FILL_BY_OTHER_SOLVER (#{p2.theft.seq})
              </li>
              <li className="ok">
                <b>Killed</b> by {p2.crash.signal} right after the release broadcast; the restart found it by memo
              </li>
            </>
          ) : sel === 'C' ? (
            <>
              <li className="bad">
                <b>Fill</b> wrong memo <Tx id={r.txs.wrongMemoFill} label="wrong-memo fill" /> not credited
              </li>
              <li className="bad">
                <b>Fill</b> correct but after block {zat(i.deadline_height)} <Tx id={r.txs.lateFill} label="late fill" /> expired
              </li>
            </>
          ) : (
            <li className="ok">
              <b>Filled</b> {zat(i.min_out_zat)} zat by the solver <Tx id={r.txs.fills[it.hash]} label="fill" />
            </li>
          )}
          <li className={fin ? 'ok' : 'wait'}>
            {fin?.status === 'SETTLED' ? (
              <>
                <b>Released</b> {zat(fin.refs.released_zat)} zat to the solver <Tx id={fin.refs.release_txid} label="release" />
              </>
            ) : fin?.status === 'REFUNDED' ? (
              <>
                <b>Refunded</b> {zat(fin.refs.refunded_zat)} zat to the user <Tx id={fin.refs.refund_txid} label="refund" />
              </>
            ) : (
              <>
                <b>Open</b> no settlement logged
              </>
            )}
          </li>
        </ol>
        <p className="faint small">Log entries for this intent: {entries.map((e) => `#${e.seq}`).join(', ') || 'none'}</p>
      </div>
    </section>
  );
}

function Tape({ checks, error, sel, onSel }: { checks: Check[]; error: string | null; sel: number; onSel: (n: number) => void }) {
  const done = checks.filter((c) => c !== 'pending').length;
  const N = LOG.length;
  return (
    <section className="p s7" aria-labelledby="tape-h">
      <div className="ph">
        <h2 id="tape-h">Attestation tape</h2>
        <span className="meta" aria-live="polite">
          {error ? `check failed: ${error}` : done < N ? `verifying ${done}/${N}…` : `${checks.filter((c) => c === 'ok').length}/${N} signatures verify`}
        </span>
      </div>
      {N === 0 ? (
        <p className="pb faint">This run has no log entries, so there is nothing to verify.</p>
      ) : (
        <>
          <div className="tape-head" aria-hidden="true">
            <span>#</span>
            <span>Block</span>
            <span>Status</span>
            <span>Decision</span>
            <span>Sig</span>
          </div>
          <ol className="tape">
            {LOG.map((e, i) => [
              e.seq === PASS2_FROM ? (
                <li key="pass2" className="run-sep" aria-hidden="true">
                  Pass 2 · {day(p2.ranAt)} · same verifier key, the log continues
                </li>
              ) : e.seq === PASS3_FROM ? (
                <li key="pass3" className="run-sep" aria-hidden="true">
                  Pass 3 · {day(p3.ranAt)} · an agent through MCP, same verifier key
                </li>
              ) : null,
              <li key={e.hash} data-check={checks[i]}>
                <button className={sel === i ? 'on' : ''} aria-pressed={sel === i} onClick={() => onSel(i)}>
                  <span className="seq">#{e.seq}</span>
                  <span className="blk">{zat(e.at_height)}</span>
                  <span className={`st st-${e.status.toLowerCase()}`}>{e.status}</span>
                  <span className="what">
                    {subject(e.intent_hash)}
                    {e.reason ? <code> {e.reason}</code> : null}
                  </span>
                  <span className="sig">{checks[i] === 'ok' ? 'sig ok' : checks[i] === 'bad' ? 'fails' : '…'}</span>
                </button>
              </li>,
            ])}
          </ol>
        </>
      )}
    </section>
  );
}

function Inspector({ e, check }: { e: LogEntry | undefined; check: Check }) {
  if (!e) return null;
  return (
    <section className="p s4" id="inspector" aria-labelledby="ins-h">
      <div className="ph">
        <h2 id="ins-h">Entry #{e.seq}</h2>
        <span className={`st st-${e.status.toLowerCase()}`}>{e.status}</span>
      </div>
      <dl className="kv pb">
        <dt>Subject</dt>
        <dd>{e.intent_hash ? <span title={e.intent_hash}>{subject(e.intent_hash)} {short(e.intent_hash, 12)}</span> : 'log head'}</dd>
        <dt>Reason</dt>
        <dd>{e.reason ? <code className="no">{e.reason}</code> : <span className="faint">none</span>}</dd>
        <dt>Block</dt>
        <dd>{zat(e.at_height)}</dd>
        {Object.entries(e.refs).map(([k, v]) => (
          <div className="kv-row" key={k}>
            <dt>{k.replace(/_/g, ' ')}</dt>
            <dd>{k.endsWith('_txid') ? <Tx id={v} label={k.replace('_txid', '')} /> : <span title={v}>{/^\d{1,12}$/.test(v) ? zat(v) : v.length > 20 ? short(v, 12) : v}</span>}</dd>
          </div>
        ))}
        <dt>Hash</dt>
        <dd title={e.hash}>{short(e.hash, 16)}</dd>
        <dt>Prev</dt>
        <dd title={e.prev}>{short(e.prev, 16)}</dd>
        <dt>Signature</dt>
        <dd data-state={check === 'ok' ? 'ok' : check === 'bad' ? 'bad' : 'checking'}>{check === 'ok' ? `ML-DSA-65 verifies (${zat(fromB64(e.sig).length)} B)` : check === 'bad' ? 'does not verify' : 'checking…'}</dd>
      </dl>
    </section>
  );
}

function Anchor({ allOk }: { allOk: boolean }) {
  if (!anchorEntry || anchoredSeq === null) {
    return (
      <section className="p s4" aria-labelledby="anc-h">
        <div className="ph">
          <h2 id="anc-h">Anchor</h2>
        </div>
        <p className="pb faint">No anchor in this run yet.</p>
      </section>
    );
  }
  // Every anchored head is the log's own entry at its seq, recomputed here.
  const headOk = ANCHORS.every((a) => LOG[Number(a.refs.anchored_seq)]?.hash === a.refs.anchored_head);
  const seqs = ANCHORS.map((a) => `#${a.refs.anchored_seq}`);
  return (
    <section className="p s4" aria-labelledby="anc-h">
      <div className="ph">
        <h2 id="anc-h">Anchors and keys</h2>
        <span className="meta">{ANCHORS.length} anchors · memo pqi1:anchor</span>
      </div>
      <dl className="kv pb">
        <dt>Anchored heads</dt>
        <dd>
          {ANCHORS.map((a, i) => (
            <span key={a.seq} title={a.refs.anchored_head}>
              {i ? ' · ' : ''}#{a.refs.anchored_seq} {short(a.refs.anchored_head, 8)}
            </span>
          ))}
        </dd>
        <dt>Head check</dt>
        <dd data-state={headOk && allOk ? 'ok' : headOk ? 'checking' : 'bad'}>{headOk ? `${seqs.join(' and ')} equal the log's entries (recomputed here)` : 'an anchored head does not match the log'}</dd>
        <dt>Anchor txs</dt>
        <dd>
          {ANCHORS.map((a, i) => (
            <span key={a.seq}>
              {i ? ' → ' : ''}
              <Tx id={a.refs.anchor_txid} label={`anchor of #${a.refs.anchored_seq}`} />
            </span>
          ))}
        </dd>
        <dt>Memos on-chain</dt>
        <dd className="faint">found by the runs; re-read by pnpm test and check-anchors (needs lightwalletd, not this tab)</dd>
        <dt>After the anchor</dt>
        <dd>{LOG.length - 1 - anchoredSeq} entry (#{anchorEntry.seq}, the anchor itself)</dd>
        <AnchorChain />
        <dt>Verifier</dt>
        <dd title={r.keys.verifier.id}>ML-DSA-65 {short(r.keys.verifier.id, 12)}</dd>
        <dt>Solver</dt>
        <dd title={r.keys.solver.id}>ML-DSA-65 {short(r.keys.solver.id, 12)}</dd>
        <dt>Solver KEM</dt>
        <dd title={r.keys.solverKem.id}>ML-KEM-768 {short(r.keys.solverKem.id, 12)}</dd>
      </dl>
    </section>
  );
}

type ChainResult = { ok: true; check: AnchorCheck } | { ok: false; problem: string; check?: AnchorCheck };

/** The anchor chain across both runs, re-checked in this tab: pass 2's log verifies under the same
 *  verifier key, extends the Oct 20 log entry for entry, and every anchor in the escrow history that
 *  pass 2 recorded forms one chain with the log (protocol checkAnchors). */
function checkChain(): ChainResult {
  const hist = (p3 as unknown as { anchors?: { escrowHistory: AnchorSeen[] } }).anchors?.escrowHistory;
  if (!hist?.length) return { ok: false, problem: 'pass 3 recorded no escrow history to check' };
  const v = verifyLog(p3.log, fromB64(r.keys.verifier.pk));
  if (!v.ok) return { ok: false, problem: `log entry ${v.error?.seq}: ${v.error?.problem}` };
  const fork2 = r.log.findIndex((e, i) => p2.log[i]?.hash !== e.hash);
  if (fork2 !== -1) return { ok: false, problem: `pass 2 does not extend the Oct 20 log at entry #${fork2}` };
  const fork3 = p2.log.findIndex((e, i) => p3.log[i]?.hash !== e.hash);
  if (fork3 !== -1) return { ok: false, problem: `pass 3 does not extend the pass-2 log at entry #${fork3}` };
  const check = checkAnchors(p3.log, hist);
  if (!check.ok) return { ok: false, problem: check.problems.map((x) => x.kind).join(', '), check };
  return { ok: true, check };
}
const HISTORY_LEN = (p3 as unknown as { anchors?: { escrowHistory: AnchorSeen[] } }).anchors?.escrowHistory?.length ?? 0;

function AnchorChain() {
  const [res, setRes] = useState<ChainResult | 'checking' | null>(null);
  const check = () => {
    setRes('checking');
    setTimeout(() => {
      try {
        setRes(checkChain());
      } catch (e) {
        setRes({ ok: false, problem: (e as Error).message });
      }
    }, 30);
  };
  return (
    <>
      <dt>Anchor chain</dt>
      <dd>
        <button className="btn" onClick={check} disabled={res === 'checking'}>
          {res && res !== 'checking' ? 'Check the anchor chain again' : 'Check the anchor chain'}
        </button>
      </dd>
      <div className="kv-row chain" aria-live="polite">
        <dt>Both runs</dt>
        {res === null ? (
          <dd className="faint">the three runs' log + the {HISTORY_LEN} anchors pass 3 read from the escrow; not checked yet</dd>
        ) : res === 'checking' ? (
          <dd data-state="checking">checking {p3.log.length} signatures and the links…</dd>
        ) : res.ok ? (
          <dd data-state="ok">
            one chain, {res.check.chain.length} anchors, no fork: {res.check.chain.map((a) => `#${a.seq}`).join(' → ')} · {p3.log.length}/{p3.log.length} signatures verify
          </dd>
        ) : (
          <dd data-state="bad">does not hold: {res.problem}</dd>
        )}
      </div>
      {res && res !== 'checking' && res.check
        ? res.check.chain.map((a) => (
            <div className="kv-row" key={a.txid}>
              <dt>Anchor #{a.seq}</dt>
              <dd>
                <Tx id={a.txid} label={`anchor ${a.seq}`} /> <span className="faint">{a.prev ? `names ${short(a.prev)}` : 'first anchor'}</span>
              </dd>
            </div>
          ))
        : null}
      <dt>Escrow history</dt>
      <dd className="faint">as recorded by pass 3; re-read on-chain by pnpm test and check-anchors (needs lightwalletd, not this tab)</dd>
    </>
  );
}

const FIELDS = ['min_out_zat', 'pay_zat', 'receive_ua', 'deadline_height', 'nonce'] as const;
type Line = { at: string; ok: boolean; text: string };

function Console() {
  const [field, setField] = useState<(typeof FIELDS)[number]>('min_out_zat');
  const [lines, setLines] = useState<Line[]>([]);
  const base = r.intents.A.signed;
  const genuine = useMemo(() => {
    try {
      return verifyIntent(base) === r.intents.A.hash;
    } catch {
      return false;
    }
  }, [base]);
  const push = (ok: boolean, text: string) => setLines((l) => [{ at: new Date().toLocaleTimeString('en-GB'), ok, text }, ...l].slice(0, 8));
  function tamper() {
    const v = base.intent[field];
    const changed = { ...base.intent, [field]: typeof v === 'number' ? v + 1 : field === 'receive_ua' ? `${String(v).slice(0, -1)}q` : field === 'nonce' ? '0'.repeat(32) : String(BigInt(v as string) - 1n) };
    try {
      verifyIntent({ ...base, intent: changed });
      push(true, `A with ${field} changed: ACCEPTED (this should not happen)`);
    } catch (e) {
      push(false, `A with ${field} changed → ${(e as Error).message.split(':')[0]} · hash ${short(intentHash(changed))} ≠ ${short(r.intents.A.hash)}`);
    }
  }
  function swapKey() {
    const f = r.attacks.forgedAsUser;
    try {
      verifyIntent(f);
      push(true, 'attacker intent: ACCEPTED (this should not happen)');
    } catch (e) {
      push(false, `attacker intent → ${(e as Error).message.split(':')[0]} · signed by ${short(keyId(fromB64(f.user_pk)))}, names ${short(f.intent.user)}`);
    }
  }
  function original() {
    try {
      push(true, `A as signed → verifies · hash ${short(verifyIntent(base))}`);
    } catch (e) {
      push(false, `A as signed → ${(e as Error).message}`);
    }
  }
  return (
    <section className="p s4" aria-labelledby="con-h">
      <div className="ph">
        <h2 id="con-h">Attack console</h2>
        <span className="meta">runs in this tab</span>
      </div>
      <div className="pb">
        <p className="faint small" style={{ marginTop: 0 }}>
          Intent A as signed verifies here: <b data-state={genuine ? 'ok' : 'bad'}>{genuine ? 'yes' : 'no'}</b>. Change a field or swap the key, and the same check the verifier runs refuses it.
        </p>
        <label className="field">
          <span>Field</span>
          <select value={field} onChange={(e) => setField(e.target.value as (typeof FIELDS)[number])}>
            {FIELDS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <div className="row">
          <button className="btn btn-copper" onClick={tamper}>
            Change and verify
          </button>
          <button className="btn" onClick={swapKey}>
            Attacker's key
          </button>
          <button className="btn" onClick={original}>
            Original
          </button>
        </div>
        <ol className="out" aria-live="polite">
          {lines.length === 0 ? (
            <li className="faint">No checks run yet. The results print here, newest first.</li>
          ) : (
            lines.map((l, i) => (
              <li key={i + l.at + l.text}>
                <span className="faint">{l.at}</span> <span data-state={l.ok ? 'ok' : 'bad'}>{l.ok ? 'OK ' : 'REF'}</span> {l.text}
              </li>
            ))
          )}
        </ol>
      </div>
    </section>
  );
}

const ATTACK: Record<string, string> = {
  wrongMemo: 'C filled with the wrong memo',
  tampered: 'A with min_out changed to 1 after signing',
  replay: 'A submitted again after it settled',
  nonceReuse: 'a new intent reusing A’s nonce',
  wrongKey: 'an intent signed by another key, naming the user',
  expired: 'C filled correctly, after its deadline',
  otherSolver: 'a second configured solver claims D’s fill; the memo names the first (pass 2)',
};

function Refusals({ onSel }: { onSel: (n: number) => void }) {
  const rows = [...Object.entries(r.attacks.decisions), ['otherSolver', p2.theft.seq] as [string, number]]
    .map(([k, seq]) => ({ k, e: LOG[seq] }))
    .filter(({ e }) => e?.status === 'REJECTED');
  return (
    <section className="p s12" aria-labelledby="ref-h">
      <div className="ph">
        <h2 id="ref-h">Refused on testnet</h2>
        <span className="meta" title="Each refusal is a signed log entry, #2-7 from the Oct 20 run and #10 from pass 2. Also tested, not live entries: FILL_UNKNOWN_SOLVER, FILL_NOT_SOLVER_BOUND, CLAIM_WINDOW_OPEN, RECEIVE_KEY_MISMATCH.">each one a signed log entry · tested too: FILL_UNKNOWN_SOLVER, FILL_NOT_SOLVER_BOUND, CLAIM_WINDOW_OPEN, RECEIVE_KEY_MISMATCH</span>
      </div>
      {rows.length === 0 ? (
        <p className="pb faint">No refusals were recorded in this run.</p>
      ) : (
        <div className="refusals">
          {rows.map(({ k, e }) => (
            <button key={k} className="ref" onClick={() => onSel(e.seq)}>
              <code>{e.reason}</code>
              <span>{ATTACK[k] ?? k}</span>
              <small>log #{e.seq} · open in the inspector</small>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Pass 2's kill: the verifier stopped right after broadcasting D's release and reconciled it. */
function Crash({ onSel }: { onSel: (n: number) => void }) {
  const c = p2.crash;
  const settled = LOG.find((e) => e.refs.release_txid === c.reconciled_txid);
  return (
    <section className="p s12" id="crash" aria-labelledby="crash-h">
      <div className="ph">
        <h2 id="crash-h">Killed mid-release, reconciled, paid once</h2>
        <span className="meta">pass 2 · intent D · live on testnet</span>
      </div>
      <ol className="crash">
        <li>
          <b>Write-ahead</b> recipient, {zat(c.write_ahead.amount_zat)} zat and memo <code>pqi1:{short(p2.intent.hash, 6)}:release</code> saved (fsync) at block {zat(c.write_ahead.at_height)}
        </li>
        <li>
          <b>Killed</b> the release was broadcast, then {c.signal} before its txid was saved
        </li>
        <li>
          <b>Reconciled</b> the restart found that memo in the escrow's history in <Tx id={c.reconciled_txid} label="release" /> and settled with it{' '}
          {settled ? (
            <button className="linkish" onClick={() => onSel(settled.seq)}>
              log #{settled.seq} · open in the inspector
            </button>
          ) : null}
        </li>
        <li>
          <b>Paid once</b> the escrow sent {c.escrow_sends_with_release_memo.length} transaction with that memo
        </li>
      </ol>
    </section>
  );
}

/** Pass 3: an agent's intent through MCP, the desk killed after the fill broadcast, audited. */
function Agent({ onSel }: { onSel: (n: number) => void }) {
  const settled = LOG.find((e) => e.status === 'SETTLED' && e.intent_hash === p3.intent.hash);
  return (
    <section className="p s12" id="agent" aria-labelledby="agent-h">
      <div className="ph">
        <h2 id="agent-h">An agent trades through MCP, live</h2>
        <span className="meta">pass 3 · intent E · {day(p3.ranAt)}</span>
      </div>
      <ol className="crash agent">
        <li>
          <b>quote</b> accept, spread {zat(p3.agent.quote.fee_zat)} zat; a refund would return {zat(p3.agent.quote.refund_if_unfilled_zat)}
        </li>
        <li>
          <b>submit_intent</b> signed with the agent's own ML-DSA-65 key, saved, funded <Tx id={p3.txs.funding} label="funding" />, posted; a new receive address (index {zat(p3.agent.receive_index)})
        </li>
        <li>
          <b>Killed</b> {p3.crash.signal} right after the solver's fill broadcast (write-ahead at block {zat(p3.crash.board_after_kill.delivering.at_height)})
        </li>
        <li>
          <b>Found, not resent</b> the restart found <Tx id={p3.txs.fill} label="fill" /> in the solver's history; sent {p3.crash.solver_sends_with_fill_memo.length === 1 ? 'once' : `${p3.crash.solver_sends_with_fill_memo.length} times`}
        </li>
        <li>
          <b>Settled</b> released <Tx id={p3.txs.release} label="release" />{' '}
          {settled ? (
            <button className="linkish" onClick={() => onSel(settled.seq)}>
              log #{settled.seq} · open in the inspector
            </button>
          ) : null}
        </li>
        <li>
          <b>Audited</b> verify_log over MCP {p3.checks.verify_log.ok ? 'ok' : 'failed'} ({p3.checks.verify_log.entries} entries, {p3.checks.verify_log.anchor.anchors} anchors); check-anchors exit {p3.checks.check_anchors.exit}, {p3.checks.check_anchors.chain.length} anchors in one chain
        </li>
      </ol>
    </section>
  );
}

export function App() {
  const { checks, error } = useLogCheck(LOG);
  const [intent, setIntent] = useState<K>('A');
  const [entry, setEntry] = useState(0);
  const good = checks.filter((c) => c === 'ok').length;
  const done = checks.filter((c) => c !== 'pending').length;
  // Bring the whole inspector panel into view after it shows the picked entry. Scrolling to its
  // heading with block 'nearest' left the panel below the fold on a phone (only its top edge showed).
  const pick = (n: number) => {
    setEntry(n);
    requestAnimationFrame(() => document.getElementById('inspector')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  };
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Ticker />
      <Bar good={good} done={done} n={LOG.length} />
      <main id="main" className="grid">
        <Book sel={intent} onSel={setIntent} />
        <Tape checks={checks} error={error} sel={entry} onSel={pick} />
        <Inspector e={LOG[entry]} check={checks[entry] ?? 'pending'} />
        <Anchor allOk={done === LOG.length && good === LOG.length} />
        <Console />
        <Refusals onSel={pick} />
        <Crash onSel={pick} />
        <Agent onSel={pick} />
      </main>
      <footer className="foot">
        <span>MIT · Copyright (c) 2026 Nivesh Gajengi</span>
        <span>run records: deployments/testnet.json, testnet-pass2.json, testnet-pass3.json</span>
        <span>post-quantum at the intent layer; Zcash spends stay ECC</span>
        <span>testnet · not audited</span>
      </footer>
    </>
  );
}
