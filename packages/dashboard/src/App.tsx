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
const verifierPk = fromB64(r.keys.verifier.pk);
const short = (s: string, a = 8, b = 6) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const Tx = ({ id }: { id?: string }) =>
  id ? (
    <a href={EXPLORER + id} target="_blank" rel="noreferrer">
      <code>{short(id, 8, 4)}</code>
    </a>
  ) : (
    <span className="muted">—</span>
  );

const NAME: Record<string, string> = { A: 'Intent A', B: 'Intent B', C: 'Intent C (short deadline)' };
const label = (h: string | null) => (Object.entries(r.intents).find(([, v]) => v.hash === h)?.[0] ?? (h ? short(h, 6, 4) : '—'));

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

function Chain() {
  const checks = useLogCheck(r.log);
  const done = checks.filter((c) => c !== 'pending').length;
  const good = checks.filter((c) => c === 'ok').length;
  return (
    <>
      <p className="tally" aria-live="polite">
        {done < r.log.length ? `Verifying ${done}/${r.log.length} ML-DSA-65 signatures in this tab…` : good === r.log.length ? `All ${good} entries verify: hashes, links and ML-DSA-65 signatures.` : `${r.log.length - good} entries fail to verify.`}
      </p>
      <ol className="chain">
        {r.log.map((e, i) => (
          <li key={e.hash} className={`link st-${e.status.toLowerCase()} chk-${checks[i]}`}>
            <div className="link-head">
              <span className="seq">#{e.seq}</span>
              <span className="status">{e.status}</span>
              <span className={`sig sig-${checks[i]}`}>{checks[i] === 'ok' ? 'signature ok' : checks[i] === 'bad' ? 'does not verify' : 'checking'}</span>
            </div>
            <p className="link-what">
              {e.intent_hash ? label(e.intent_hash) : 'log head'}
              {e.reason ? <> · <strong>{e.reason}</strong></> : null}
            </p>
            <p className="link-refs">
              {Object.entries(e.refs)
                .filter(([k]) => k.endsWith('_txid'))
                .map(([k, v]) => (
                  <span key={k}>
                    {k.replace('_txid', '')} <Tx id={v} />
                  </span>
                ))}
            </p>
            <p className="link-hash">
              <code title={e.hash}>{e.hash.slice(0, 12)}</code> ← prev <code title={e.prev}>{e.prev.slice(0, 12)}</code> · block {e.at_height}
            </p>
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
        return (
          <article key={k} className="card">
            <h3>{NAME[k]}</h3>
            <p className="muted small">
              escrow {Number(i.pay_zat).toLocaleString()} zat → deliver {Number(i.min_out_zat).toLocaleString()} zat by block {i.deadline_height.toLocaleString()}
            </p>
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
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Attack</th>
              <th scope="col">Verifier's signed answer</th>
              <th scope="col">Log</th>
            </tr>
          </thead>
          <tbody>
            {recorded
              .filter(({ e }) => e && e.status === 'REJECTED')
              .map(({ k, e }) => (
                <tr key={k}>
                  <td>{ATTACK[k] ?? k}</td>
                  <td>
                    <code>{e.reason}</code>
                  </td>
                  <td>#{e.seq}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="try">
        <p className="muted small">Intent A as signed verifies here: {genuine ? 'yes' : 'no'}. Change it, or swap the key, and check again in this tab:</p>
        <div className="row">
          <label>
            Field
            <select value={field} onChange={(e) => setField(e.target.value as (typeof FIELDS)[number])}>
              {FIELDS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <button onClick={tamper}>Change it and verify</button>
          <button className="ghost" onClick={swapKey}>
            Verify the attacker's intent
          </button>
        </div>
        {result && <p className="out">{result}</p>}
      </div>
    </>
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
  return (
    <>
      <header className="top">
        <span className="brand">zec-pq-intents</span>
        <span className="muted small">Zcash testnet · run {new Date(r.ranAt).toLocaleString()}</span>
      </header>
      <main>
        <section className="hero">
          <h1>Intents signed and sealed with NIST post-quantum primitives.</h1>
          <p className="lede">
            Each intent is signed with ML-DSA-65 and sealed to the solver with ML-KEM-768. Settlement is real shielded ZEC on testnet. Every decision is a signed, hash-chained log
            entry, anchored in a shielded memo. This page re-verifies all of it.
          </p>
          <p className="muted small">
            Verifier key <code>{short(r.keys.verifier.id, 10, 6)}</code> (ML-DSA-65). Log anchored at entry #{r.anchor.seq} in <Tx id={r.anchor.txid} />; memo found on-chain:{' '}
            {r.anchor.memoSeen ? 'yes' : 'no'}, head matches: {r.anchor.recomputedHeadMatches ? 'yes' : 'no'}.
          </p>
        </section>
        <section aria-labelledby="life">
          <h2 id="life">Three intents</h2>
          <Lifecycle />
        </section>
        <section aria-labelledby="log">
          <h2 id="log">The attestation log</h2>
          <Chain />
        </section>
        <section aria-labelledby="atk">
          <h2 id="atk">Attacks</h2>
          <Attacks />
        </section>
      </main>
      <footer>
        MIT · Copyright (c) 2026 Nivesh Gajengi · testnet only · post-quantum at the intent layer; Zcash spends stay ECC
      </footer>
    </>
  );
}
