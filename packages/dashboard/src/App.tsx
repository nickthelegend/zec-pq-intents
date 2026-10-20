import { useEffect, useMemo, useState } from 'react';
import { entryHash, fromB64, intentHash, keyId, verifyIntent, verifySig, type LogEntry, type SignedIntent } from '@pqi/protocol';
import run from '@deployments/testnet.json';

type Rec = {
  ranAt: string;
  wallets: Record<string, { address: string; uivk?: string }>;
  keys: Record<string, { scheme: string; id: string; pk: string }>;
  txs: { funding: string; wrongMemoFill: string; lateFill: string; fills: Record<string, string>; releases: string[]; refund: string; anchor: string };
  intents: Record<'A' | 'B' | 'C', { hash: string; signed: SignedIntent; envelope: { kem_ct: string; ct: string; to: string } }>;
  attacks: { decisions: Record<string, number>; reuse: SignedIntent; forgedAsUser: SignedIntent };
  anchor: { txid: string; head: string; seq: number; memoSeen: boolean; recomputedHeadMatches: boolean };
  log: LogEntry[];
};
const r = run as unknown as Rec;
const EXPLORER = 'https://testnet.zcashexplorer.app/transactions/';
const REPO = 'https://github.com/nickthelegend/zec-pq-intents';
const verifierPk = fromB64(r.keys.verifier.pk);
const short = (s: string, a = 8, b = 6) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const Tx = ({ id }: { id?: string }) =>
  id ? (
    <a className="tx" href={EXPLORER + id} target="_blank" rel="noreferrer" aria-label={`Transaction ${short(id, 8, 4)} on the Zcash testnet explorer`}>
      <code>{short(id, 8, 4)}</code>
      <svg className="tx-arrow" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M3.5 8.5l5-5M4.5 3.5h4v4" />
      </svg>
    </a>
  ) : (
    <span className="muted">—</span>
  );

const NAME: Record<string, string> = { A: 'Intent A', B: 'Intent B', C: 'Intent C (short deadline)' };
const label = (h: string | null) => (Object.entries(r.intents).find(([, v]) => v.hash === h)?.[0] ?? (h ? short(h, 6, 4) : '—'));
const zat = (v: string | number) => Number(v).toLocaleString();

/** A balance-style amount: the figure, then a faded unit. */
const Amount = ({ value, unit = 'zat', size = 'md' }: { value: string | number; unit?: string; size?: 'md' | 'lg' }) => (
  <span className={`amount amount-${size}`}>
    {zat(value)}
    <span className="amount-unit"> {unit}</span>
  </span>
);

type Check = 'pending' | 'ok' | 'bad';

/** Verifies entries one by one (real ML-DSA-65 work in this tab), so the chain fills in as it goes. */
function useLogCheck(log: LogEntry[]) {
  const [state, setState] = useState<Check[]>(() => log.map(() => 'pending'));
  useEffect(() => {
    let cancelled = false;
    let prev = '0'.repeat(64);
    (async () => {
      for (let i = 0; i < log.length; i++) {
        await new Promise((res) => setTimeout(res, 60));
        if (cancelled) return;
        const { hash, sig, ...body } = log[i];
        let good = false;
        try {
          good = body.prev === prev && body.seq === i && entryHash(body) === hash && verifySig(verifierPk, 'pqi1:log:', hash, sig);
        } catch {
          good = false; // a malformed entry is a failed check, not a stuck page
        }
        prev = hash;
        setState((s) => s.map((x, k) => (k === i ? (good ? 'ok' : 'bad') : x)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [log]);
  return state;
}

type Overall = 'idle' | 'checking' | 'verified' | 'failed';
function overallOf(checks: Check[]): { state: Overall; done: number; good: number; bad: number } {
  const done = checks.filter((c) => c !== 'pending').length;
  const good = checks.filter((c) => c === 'ok').length;
  const bad = done - good;
  const state: Overall = done === 0 ? 'idle' : done < checks.length ? 'checking' : good === checks.length ? 'verified' : 'failed';
  return { state, done, good, bad };
}
const OVERALL_TEXT: Record<Overall, string> = {
  idle: 'Starting',
  checking: 'Checking',
  verified: 'Verified in your browser',
  failed: 'Failed',
};

function StatePill({ state }: { state: Overall }) {
  return (
    <span className={`pill pill-${state}`}>
      <span className="pill-dot" aria-hidden="true" />
      {OVERALL_TEXT[state]}
    </span>
  );
}

const Mark = () => (
  <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="3" y="3" width="17" height="17" rx="5" fill="none" stroke="#f08a4b" strokeWidth="3.2" />
    <rect x="12" y="12" width="17" height="17" rx="5" fill="none" stroke="#efe9ff" strokeWidth="3.2" />
    <path d="M8 20h7" stroke="#1c1326" strokeWidth="6" />
    <path d="M7.5 20h8" stroke="#f08a4b" strokeWidth="3.2" />
  </svg>
);

function TopBar() {
  return (
    <header className="top">
      <a className="brand" href="#top" aria-label="Yaksok, top of the dashboard">
        <Mark />
        <span className="wordmark">Yaksok</span>
      </a>
      <nav className="nav" aria-label="Sections">
        <a href="#intents">Intents</a>
        <a href="#log">Decision log</a>
        <a href="#attacks">Attacks</a>
      </nav>
      <div className="top-actions">
        <span className="pill pill-net">
          <span className="pill-dot" aria-hidden="true" />
          Zcash testnet
        </span>
        <a className="btn btn-accent btn-sm" href={REPO} target="_blank" rel="noreferrer">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="gh">
            <path d="M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2Z" />
          </svg>
          GitHub
        </a>
      </div>
    </header>
  );
}

function Overview({ checks }: { checks: Check[] }) {
  const n = r.log.length;
  const { state, done, good, bad } = overallOf(checks);
  return (
    <section className="overview" aria-labelledby="hero-title">
      <div className="hero">
        <p className="eyebrow">ML-DSA-65 · ML-KEM-768 · shielded ZEC</p>
        <h1 id="hero-title">Intents signed and sealed with NIST post-quantum primitives.</h1>
        <p className="lede">
          Each intent is signed with ML-DSA-65 and sealed to the solver with ML-KEM-768. Settlement is real shielded ZEC on testnet. Every decision is a signed, hash-chained log entry,
          anchored in a shielded memo. This page re-verifies all of it.
        </p>
      </div>

      <aside className="panel verify-card" aria-labelledby="verify-title">
        <div className="panel-head">
          <h2 id="verify-title" className="panel-title">
            Decision log
          </h2>
          <StatePill state={state} />
        </div>
        {n === 0 ? (
          <p className="empty">This run has no log entries to verify.</p>
        ) : (
          <>
            <p className="big">
              {good}
              <span className="big-faded">/{n}</span>
            </p>
            <p className="muted small">ML-DSA-65 signatures verified in this tab{bad > 0 ? ` · ${bad} failed` : ''}</p>
            <div
              className={`meter meter-${state}`}
              role="progressbar"
              aria-label="Log entries checked"
              aria-valuemin={0}
              aria-valuemax={n}
              aria-valuenow={done}
            >
              <span style={{ width: `${(done / n) * 100}%` }} />
            </div>
          </>
        )}
        <dl className="facts">
          <div>
            <dt>Anchored at</dt>
            <dd>
              entry #{r.anchor.seq} <Tx id={r.anchor.txid} />
            </dd>
          </div>
          <div>
            <dt>Memo found on-chain</dt>
            <dd className={r.anchor.memoSeen ? 'yes' : 'no'}>{r.anchor.memoSeen ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Head matches</dt>
            <dd className={r.anchor.recomputedHeadMatches ? 'yes' : 'no'}>{r.anchor.recomputedHeadMatches ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Verifier key (ML-DSA-65)</dt>
            <dd>
              <code title={r.keys.verifier.id}>{short(r.keys.verifier.id, 10, 6)}</code>
            </dd>
          </div>
          <div>
            <dt>Run</dt>
            <dd>{new Date(r.ranAt).toLocaleString()}</dd>
          </div>
        </dl>
        <a className="btn btn-accent btn-block" href="#log">
          Open the chain
          <svg viewBox="0 0 16 16" aria-hidden="true" className="btn-icon">
            <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
          </svg>
        </a>
      </aside>
    </section>
  );
}

const STATUS_CLASS = (s: string) => `st st-${s.toLowerCase()}`;
const SIG_TEXT: Record<Check, string> = { ok: 'signature ok', bad: 'does not verify', pending: 'checking' };

function Chain({ checks }: { checks: Check[] }) {
  const done = checks.filter((c) => c !== 'pending').length;
  const good = checks.filter((c) => c === 'ok').length;
  const { state } = overallOf(checks);
  if (r.log.length === 0) return <p className="empty panel">No decisions were logged in this run, so there is nothing to verify.</p>;
  return (
    <>
      <div className={`tally tally-${state}`}>
        <StatePill state={state} />
        <p aria-live="polite">
          {done < r.log.length ? `Verifying ${done}/${r.log.length} ML-DSA-65 signatures in this tab…` : good === r.log.length ? `All ${good} entries verify: hashes, links and ML-DSA-65 signatures.` : `${r.log.length - good} entries fail to verify.`}
        </p>
      </div>
      <ol className="chain">
        {r.log.map((e, i) => (
          <li key={e.hash} id={`entry-${e.seq}`} className={`link chk-${checks[i]}`}>
            <span className={`node node-${checks[i]}`} aria-hidden="true">
              {checks[i] === 'ok' ? (
                <svg viewBox="0 0 12 12">
                  <path d="M2.5 6.2 5 8.6l4.5-5" />
                </svg>
              ) : checks[i] === 'bad' ? (
                <svg viewBox="0 0 12 12">
                  <path d="M3 3l6 6M9 3 3 9" />
                </svg>
              ) : null}
            </span>
            <div className="link-card">
              <div className="link-head">
                <span className="seq">#{e.seq}</span>
                <span className={STATUS_CLASS(e.status)}>{e.status.toLowerCase()}</span>
                <span className="link-what">
                  {e.intent_hash ? `Intent ${label(e.intent_hash)}` : 'log head'}
                </span>
                <span className={`sig sig-${checks[i]}`}>{SIG_TEXT[checks[i]]}</span>
              </div>
              {e.reason ? (
                <p className="reason">
                  <code>{e.reason}</code>
                </p>
              ) : null}
              {Object.keys(e.refs).some((k) => k.endsWith('_txid')) ? (
                <p className="link-refs">
                  {Object.entries(e.refs)
                    .filter(([k]) => k.endsWith('_txid'))
                    .map(([k, v]) => (
                      <span key={k} className="ref">
                        <span className="ref-k">{k.replace('_txid', '')}</span> <Tx id={v} />
                      </span>
                    ))}
                </p>
              ) : null}
              <p className="link-hash">
                <code title={e.hash}>{e.hash.slice(0, 12)}</code>
                <span className="muted"> ← prev </span>
                <code title={e.prev}>{e.prev.slice(0, 12)}</code>
                <span className="muted"> · block {e.at_height}</span>
              </p>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function Lifecycle() {
  const byIntent = (h: string) => r.log.filter((e) => e.intent_hash === h);
  return (
    <div className="cards">
      {(['A', 'B', 'C'] as const).map((k) => {
        const it = r.intents[k];
        const entries = byIntent(it.hash);
        const final = entries.find((e) => e.status === 'SETTLED' || e.status === 'REFUNDED');
        const i = it.signed.intent;
        const payout = final?.status === 'SETTLED' ? final.refs.released_zat : final?.status === 'REFUNDED' ? final.refs.refunded_zat : undefined;
        return (
          <article key={k} className="panel card" aria-labelledby={`intent-${k}`}>
            <div className="card-head">
              <span className={`letter letter-${k}`} aria-hidden="true">
                {k}
              </span>
              <h3 id={`intent-${k}`}>{NAME[k]}</h3>
              <span className={final ? STATUS_CLASS(final.status) : 'st st-open'}>{final ? final.status.toLowerCase() : 'open'}</span>
            </div>
            <p className="kicker">Escrow</p>
            <p className="card-amount">
              <Amount value={i.pay_zat} size="lg" />
            </p>
            <dl className="card-stats">
              <div>
                <dt>{final?.status === 'REFUNDED' ? 'Refunded' : 'Payout'}</dt>
                <dd>{payout ? <Amount value={payout} /> : <span className="muted">—</span>}</dd>
              </div>
              <div>
                <dt>Min. delivery</dt>
                <dd>
                  <Amount value={i.min_out_zat} />
                </dd>
              </div>
              <div>
                <dt>Deadline</dt>
                <dd>block {i.deadline_height.toLocaleString()}</dd>
              </div>
            </dl>
            <ol className="steps">
              <li>
                Sealed to the solver: ML-KEM-768 ciphertext {fromB64(it.envelope.kem_ct).length} bytes + {fromB64(it.envelope.ct).length} bytes AES-GCM
              </li>
              <li>
                Escrow funded <Tx id={r.txs.funding} />
              </li>
              {k === 'C' ? (
                <>
                  <li className="no">
                    Fill with a wrong memo <Tx id={r.txs.wrongMemoFill} />: not credited
                  </li>
                  <li className="no">
                    Correct fill after the deadline <Tx id={r.txs.lateFill} />: EXPIRED
                  </li>
                </>
              ) : (
                <li>
                  Solver delivered <Tx id={r.txs.fills[it.hash]} />
                </li>
              )}
              <li className={final ? 'yes' : 'no'}>
                {final?.status === 'SETTLED' ? (
                  <>
                    Settled: escrow released to the solver <Tx id={final.refs.release_txid} />
                  </>
                ) : final?.status === 'REFUNDED' ? (
                  <>
                    Refunded to the user <Tx id={final.refs.refund_txid} />
                  </>
                ) : (
                  'Open'
                )}
              </li>
            </ol>
          </article>
        );
      })}
    </div>
  );
}

const FIELDS = ['min_out_zat', 'pay_zat', 'receive_ua', 'deadline_height', 'nonce'] as const;

function Attacks() {
  const [field, setField] = useState<(typeof FIELDS)[number]>('min_out_zat');
  const [result, setResult] = useState<string>('');
  const base = r.intents.A.signed;
  function tamper() {
    const v = base.intent[field];
    const changed = { ...base.intent, [field]: typeof v === 'number' ? v + 1 : field === 'receive_ua' ? `${String(v).slice(0, -1)}q` : field === 'nonce' ? '0'.repeat(32) : String(BigInt(v as string) - 1n) };
    try {
      verifyIntent({ ...base, intent: changed });
      setResult('Verified — this should not happen.');
    } catch (e) {
      setResult(`${(e as Error).message}. Hash ${short(intentHash(changed), 8, 6)} instead of ${short(r.intents.A.hash, 8, 6)}.`);
    }
  }
  function swapKey() {
    try {
      verifyIntent(r.attacks.forgedAsUser);
      setResult('Verified — this should not happen.');
    } catch (e) {
      setResult(`${(e as Error).message}: signed by key ${short(keyId(fromB64(r.attacks.forgedAsUser.user_pk)), 8, 4)}, the intent names ${short(r.attacks.forgedAsUser.intent.user, 8, 4)}.`);
    }
  }
  const recorded = Object.entries(r.attacks.decisions).map(([k, seq]) => ({ k, e: r.log[seq] }));
  const genuine = useMemo(() => {
    try {
      return verifyIntent(base) === r.intents.A.hash;
    } catch {
      return false;
    }
  }, [base]);
  const rejected = recorded.filter(({ e }) => e && e.status === 'REJECTED');
  return (
    <div className="attacks">
      <div className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th scope="col">Attack</th>
              <th scope="col">Verifier's signed answer</th>
              <th scope="col">Log</th>
            </tr>
          </thead>
          <tbody>
            {rejected.length === 0 ? (
              <tr>
                <td colSpan={3} className="empty">
                  No rejected attempts were recorded in this run.
                </td>
              </tr>
            ) : (
              rejected.map(({ k, e }) => (
                <tr key={k}>
                  <td data-label="Attack">{ATTACK[k] ?? k}</td>
                  <td data-label="Signed answer">
                    <span className="st st-rejected st-code">
                      <code>{e.reason}</code>
                    </span>
                  </td>
                  <td data-label="Log">
                    <a className="seq-link" href={`#entry-${e.seq}`}>
                      #{e.seq}
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="panel try">
        <h3 className="panel-title">Try it in this tab</h3>
        <p className="muted small">
          Intent A as signed verifies here: <strong className={genuine ? 'yes' : 'no'}>{genuine ? 'yes' : 'no'}</strong>. Change it, or swap the key, and check again in this tab:
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
          <button className="btn btn-accent" onClick={tamper}>
            Change it and verify
          </button>
          <button className="btn btn-ghost" onClick={swapKey}>
            Verify the attacker's intent
          </button>
        </div>
        <div className="out-slot" aria-live="polite">
          {result ? (
            <p className="out">
              {result.startsWith('Verified') ? <span className="st st-open">accepted</span> : <span className="st st-rejected">refused</span>}
              <span className="out-text">{result}</span>
            </p>
          ) : (
            <p className="out-empty muted small">No check run yet. Pick a field and press a button; the result appears here.</p>
          )}
        </div>
      </div>
    </div>
  );
}

const ATTACK: Record<string, string> = {
  wrongMemo: 'C filled with the wrong memo',
  tampered: 'A with min_out changed to 1 after signing',
  replay: 'A submitted again after it settled',
  nonceReuse: 'a new intent reusing A’s nonce',
  wrongKey: 'an intent signed by another key, naming the user',
  expired: 'C filled correctly, but after its deadline',
};

export function App() {
  const checks = useLogCheck(r.log);
  return (
    <div className="page" id="top">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="app">
        <TopBar />
        <main id="main">
          <Overview checks={checks} />
          <section className="section" aria-labelledby="intents">
            <div className="section-head">
              <h2 id="intents">Three intents</h2>
              <p className="muted small">Each escrows the same amount; two settle, one runs past its deadline and is refunded.</p>
            </div>
            <Lifecycle />
          </section>
          <section className="section" aria-labelledby="log">
            <div className="section-head">
              <h2 id="log">The attestation log</h2>
              <p className="muted small">Hash-chained and signed by the verifier; every entry is re-checked below, one at a time.</p>
            </div>
            <Chain checks={checks} />
          </section>
          <section className="section" aria-labelledby="attacks">
            <div className="section-head">
              <h2 id="attacks">Attacks</h2>
              <p className="muted small">What the verifier refused on testnet, and a panel to try the same in your browser.</p>
            </div>
            <Attacks />
          </section>
        </main>
        <footer className="foot">
          <span>MIT · Copyright (c) 2026 Nivesh Gajengi</span>
          <span>testnet only · post-quantum at the intent layer; Zcash spends stay ECC</span>
        </footer>
      </div>
    </div>
  );
}
