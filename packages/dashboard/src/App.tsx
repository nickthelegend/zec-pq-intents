// Yaksok terminal: the published testnet run, re-verified in this tab. Everything shown comes from
// deployments/testnet.json; every signature, hash, link and the anchored head are re-computed here
// with @pqi/protocol. Values the tab cannot check (an on-chain memo) are labelled as recorded.
import { useEffect, useMemo, useState } from 'react';
import { entryHash, fromB64, GENESIS, intentHash, keyId, verifyIntent, verifySig, type LogEntry, type SignedIntent } from '@pqi/protocol';
import run from '@deployments/testnet.json';

type K = 'A' | 'B' | 'C';
type Rec = {
  ranAt: string;
  keys: Record<string, { scheme: string; id: string; pk: string }>;
  txs: { funding: string; wrongMemoFill: string; lateFill: string; fills: Record<string, string> };
  intents: Record<K, { hash: string; signed: SignedIntent; envelope: { kem_ct: string; ct: string; to: string } }>;
  attacks: { decisions: Record<string, number>; reuse: SignedIntent; forgedAsUser: SignedIntent };
  log: LogEntry[];
};
const r = run as unknown as Rec;
const EXPLORER = 'https://testnet.zcashexplorer.app/transactions/';
const REPO = 'https://github.com/nickthelegend/zec-pq-intents';
const LETTERS: K[] = ['A', 'B', 'C'];
const short = (s: string, n = 8) => (s && s.length > n + 1 ? `${s.slice(0, n)}…` : s);
const zat = (v: string | number) => Number(v).toLocaleString('en-US');
const letterOf = (h: string | null) => LETTERS.find((k) => r.intents[k].hash === h) ?? null;
const subject = (h: string | null) => (h ? (letterOf(h) ? `Intent ${letterOf(h)}` : `intent ${short(h, 6)}`) : 'log head');
const anchorEntry = r.log.find((e) => e.status === 'ANCHORED') ?? null;
const anchoredSeq = anchorEntry ? Number(anchorEntry.refs.anchored_seq) : null;

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
  const items = r.log.map((e) => (
    <li key={e.seq}>
      <b>#{e.seq}</b>
      <span className={`st st-${e.status.toLowerCase()}`}>{e.status}</span>
      {e.status === 'REJECTED' ? <code>{e.reason?.split(':')[0]}</code> : e.status === 'ANCHORED' ? `head ${short(e.refs.anchored_head)}` : `${subject(e.intent_hash)} · ${zat(e.refs.released_zat ?? e.refs.refunded_zat)} zat`}
    </li>
  ));
  return (
    <div className="ticker" aria-label="Decisions from the testnet run">
      <div className="ticker-track">
        <ul>{items}</ul>
        <ul aria-hidden="true">{items}</ul>
      </div>
    </div>
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
          <small>Run</small>
          <span>{new Date(r.ranAt).toISOString().replace('T', ' ').slice(0, 16)} UTC</span>
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
        <a className="btn" href={`${REPO}/blob/main/packages/docs/README.md`}>
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
  const it = r.intents[sel];
  const i = it.signed.intent;
  const entries = r.log.filter((e) => e.intent_hash === it.hash);
  const fin = entries.find((e) => e.status === 'SETTLED' || e.status === 'REFUNDED');
  const kemCt = fromB64(it.envelope.kem_ct).length;
  const ct = fromB64(it.envelope.ct).length;
  return (
    <section className="p s5" aria-labelledby="book-h">
      <div className="ph">
        <h2 id="book-h">Intent book</h2>
        <span className="meta">zat · pick one</span>
      </div>
      <div className="book" role="radiogroup" aria-label="Intents">
        <div className="book-head" aria-hidden="true">
          <span>Intent</span>
          <span className="r">Escrow</span>
          <span className="r">Deliver ≥</span>
          <span className="r">Deadline</span>
          <span>Status</span>
        </div>
        {LETTERS.map((k) => {
          const x = r.intents[k];
          const f = r.log.find((e) => e.intent_hash === x.hash && (e.status === 'SETTLED' || e.status === 'REFUNDED'));
          const st = f ? f.status.toLowerCase() : 'open';
          const ratio = Number(x.signed.intent.min_out_zat) / Number(x.signed.intent.pay_zat);
          return (
            <button key={k} role="radio" aria-checked={sel === k} className={`book-row ${st}${sel === k ? ' on' : ''}`} onClick={() => onSel(k)}>
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
            <b>Funded</b> {zat(i.pay_zat)} zat <Tx id={r.txs.funding} label="funding" />
          </li>
          {sel === 'C' ? (
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
  return (
    <section className="p s7" aria-labelledby="tape-h">
      <div className="ph">
        <h2 id="tape-h">Attestation tape</h2>
        <span className="meta" aria-live="polite">
          {error ? `check failed: ${error}` : done < r.log.length ? `verifying ${done}/${r.log.length}…` : `${checks.filter((c) => c === 'ok').length}/${r.log.length} signatures verify`}
        </span>
      </div>
      {r.log.length === 0 ? (
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
            {r.log.map((e, i) => (
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
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function Inspector({ e, check }: { e: LogEntry | undefined; check: Check }) {
  if (!e) return null;
  return (
    <section className="p s4" aria-labelledby="ins-h">
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
  const headOk = r.log[anchoredSeq]?.hash === anchorEntry.refs.anchored_head;
  return (
    <section className="p s4" aria-labelledby="anc-h">
      <div className="ph">
        <h2 id="anc-h">Anchor and keys</h2>
        <span className="meta">memo pqi1:anchor:{anchoredSeq}</span>
      </div>
      <dl className="kv pb">
        <dt>Anchored head</dt>
        <dd title={anchorEntry.refs.anchored_head}>
          #{anchoredSeq} {short(anchorEntry.refs.anchored_head, 12)}
        </dd>
        <dt>Head check</dt>
        <dd data-state={headOk && allOk ? 'ok' : headOk ? 'checking' : 'bad'}>{headOk ? `equals entry #${anchoredSeq} (recomputed here)` : 'does not match the log'}</dd>
        <dt>Anchor tx</dt>
        <dd>
          <Tx id={anchorEntry.refs.anchor_txid} label="anchor" />
        </dd>
        <dt>Memo on-chain</dt>
        <dd className="faint">found by the run script; re-read by pnpm test (needs lightwalletd, not this tab)</dd>
        <dt>After the anchor</dt>
        <dd>{r.log.length - 1 - anchoredSeq} entry, not yet anchored</dd>
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
};

function Refusals({ onSel }: { onSel: (n: number) => void }) {
  const rows = Object.entries(r.attacks.decisions)
    .map(([k, seq]) => ({ k, e: r.log[seq] }))
    .filter(({ e }) => e?.status === 'REJECTED');
  return (
    <section className="p s12" aria-labelledby="ref-h">
      <div className="ph">
        <h2 id="ref-h">Refused on testnet</h2>
        <span className="meta" title="Each refusal is a signed log entry. Also tested: FILL_UNKNOWN_SOLVER, FILL_NOT_SOLVER_BOUND, CLAIM_WINDOW_OPEN. FILL_BY_OTHER_SOLVER is entry 10 of the Oct 21 pass-2 run (deployments/testnet-pass2.json).">each one a signed log entry · tested too: FILL_UNKNOWN_SOLVER, FILL_NOT_SOLVER_BOUND, CLAIM_WINDOW_OPEN · FILL_BY_OTHER_SOLVER: pass 2</span>
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

export function App() {
  const { checks, error } = useLogCheck(r.log);
  const [intent, setIntent] = useState<K>('A');
  const [entry, setEntry] = useState(0);
  const good = checks.filter((c) => c === 'ok').length;
  const done = checks.filter((c) => c !== 'pending').length;
  const pick = (n: number) => {
    setEntry(n);
    document.getElementById('ins-h')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Ticker />
      <Bar good={good} done={done} n={r.log.length} />
      <main id="main" className="grid">
        <Book sel={intent} onSel={setIntent} />
        <Tape checks={checks} error={error} sel={entry} onSel={pick} />
        <Inspector e={r.log[entry]} check={checks[entry] ?? 'pending'} />
        <Anchor allOk={done === r.log.length && good === r.log.length} />
        <Console />
        <Refusals onSel={pick} />
      </main>
      <footer className="foot">
        <span>MIT · Copyright (c) 2026 Nivesh Gajengi</span>
        <span>run record: deployments/testnet.json</span>
        <span>post-quantum at the intent layer; Zcash spends stay ECC</span>
        <span>testnet · not audited</span>
      </footer>
    </>
  );
}
