// The desk: what it accepts on its board, one tick at a time, refunds after the claim window, and its
// HTTP surface. Chain-touching cases read the published run on Zcash testnet; payouts are recorded up
// front so nothing is ever sent, and the solver's wallet path does not exist (no delivery happens).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bytesToHex, keyId, memo, newKemKey, newSigningKey, randomBytes, seal, signFill, signIntent, type SignedIntent } from '@pqi/protocol';
import { chainTip, Desk, HttpError, InsufficientBalanceError, MAX_BODY_BYTES, scan, serveDesk, Solver, Verifier, zingoConfig, type BoardItem } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const I = d.intents as Record<'A' | 'B' | 'C', { hash: string; signed: SignedIntent }>;
const W = d.wallets as Record<string, { address: string; uivk: string }>;
const NEVER_SENT = 'test-marker-no-payment-sent';

function setup(items: (kem: Uint8Array, sign: ReturnType<typeof newSigningKey>) => BoardItem[] = () => [], SolverClass: typeof Solver = Solver, deskOpts: { maxOpen?: number; unfundedTtlBlocks?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pqi-desk-'));
  const kem = newKemKey();
  const sign = newSigningKey();
  const payouts = Object.fromEntries((['A', 'B', 'C'] as const).flatMap((k) => [`release:${I[k].hash}`, `refund:${I[k].hash}`]).map((k) => [k, NEVER_SENT]));
  writeFileSync(join(dir, 'verifier.json'), JSON.stringify({ log: [], nonces: {}, closed: {}, payouts }));
  writeFileSync(join(dir, 'board.json'), JSON.stringify(items(kem.publicKey, sign)));
  const solver = new SolverClass({ sign, kem, wallet: '/nonexistent/solver-wallet-never-used', ua: W.solver.address, escrowUivk: W.escrow.uivk, zingo: zingoConfig(), minFeeZat: 15_000n });
  const verifier = new Verifier({ key: newSigningKey(), escrowWallet: '/nonexistent/escrow-wallet-never-used', escrowUa: W.escrow.address, escrowUivk: W.escrow.uivk, solvers: [keyId(sign.publicKey)], legacyUnboundFills: [I.A.hash, I.B.hash, I.C.hash], zingo: zingoConfig(), statePath: join(dir, 'verifier.json'), tip: chainTip });
  const desk = new Desk({ boardPath: join(dir, 'board.json'), solver, verifier, tip: chainTip, info: { mode: 'test' }, ...deskOpts });
  return { desk, verifier, solver, kem: kem.publicKey, boardPath: join(dir, 'board.json') };
}

const item = (k: 'A' | 'B' | 'C', kem: Uint8Array, stage: BoardItem['stage'], extra: Partial<BoardItem> = {}): BoardItem => ({
  hash: I[k].hash,
  envelope: seal(I[k].signed, kem),
  fundingTxid: d.txs.funding,
  stage,
  note: null,
  fillTxid: null,
  claim: null,
  postedAt: '2026-10-20T16:00:00.000Z',
  ...extra,
});

describe('board', () => {
  it('a junk envelope under A’s hash is refused, so A’s real envelope still gets the slot', () => {
    const { desk, kem } = setup();
    const junk = { ...seal(I.B.signed, kem), intent_hash: I.A.hash };
    expect(() => desk.submit(junk, d.txs.funding)).toThrow(/BAD_ENVELOPE/);
    expect(() => desk.submit(seal(I.A.signed, newKemKey().publicKey), d.txs.funding)).toThrow(/NOT_FOR_ME/);
    expect(desk.items).toHaveLength(0);
    expect(desk.submit(seal(I.A.signed, kem), d.txs.funding)).toMatchObject({ hash: I.A.hash, stage: 'received' });
  });

  it('an envelope paying no more than the 15,000 zat fee budget is refused at the door (PAY_BELOW_FEE_BUDGET)', () => {
    const { desk, kem } = setup();
    const s = signIntent(newSigningKey(), { escrow: W.escrow.address, pay_zat: '15000', min_out_zat: '1', receive_ua: W.receive.address, receive_uivk: W.receive.uivk, refund_ua: W.user.address, deadline_height: 5_000_000 });
    expect(() => desk.submit(seal(s, kem), d.txs.funding)).toThrow(/^PAY_BELOW_FEE_BUDGET: pay_zat 15000 is not above the 15000 zat fee budget/);
    expect(desk.items).toHaveLength(0);
  });
});

describe('solver: funding depth (Zcash testnet)', () => {
  it('the solver does not deliver against a funding with fewer than 3 confirmations (observed height held)', async () => {
    const { solver } = setup();
    const fundH = (await scan(W.escrow.uivk, d.txs.funding, 60_000, memo.funding(I.A.hash))).height!;
    expect(await solver.funded(I.A.hash, I.A.signed, d.txs.funding, fundH + 1)).toMatchObject({ ok: false, reasons: ['NOT_CONFIRMED (2 of 3)'] });
    expect(await solver.funded(I.A.hash, I.A.signed, d.txs.funding, fundH + 2)).toMatchObject({ ok: true });
  });
});

describe('ticks (Zcash testnet)', () => {
  it('two ticks at once settle A once: one SETTLED entry, no stray rejection', async () => {
    const { desk, verifier } = setup((kem, sign) => [item('A', kem, 'filled', { fillTxid: d.txs.fills[I.A.hash], claim: signFill(sign, I.A.hash, d.txs.fills[I.A.hash], W.solver.address) })]);
    await Promise.all([desk.tick(), desk.tick()]);
    expect(verifier.state.log.map((e) => e.status)).toEqual(['SETTLED']);
    expect(desk.items[0].stage).toBe('settled');
  });

  it('a declined intent past its deadline and claim window is refunded by the desk', async () => {
    const { desk, verifier } = setup((kem) => [item('C', kem, 'declined', { note: 'fee 1 zat is below 15000' })]);
    const [r] = await desk.tick();
    expect(r).toEqual({ hash: I.C.hash, result: 'REFUNDED' });
    expect(desk.items[0].stage).toBe('refunded');
    expect(verifier.state.log[0]).toMatchObject({ status: 'REFUNDED', refs: { refund_txid: NEVER_SENT } });
  });
});

/** A new intent on the published escrow and receive address, due `ahead` blocks after `tip`. */
const fresh = (tip: number, ahead = 100) => signIntent(newSigningKey(), { escrow: W.escrow.address, pay_zat: '60000', min_out_zat: '40000', receive_ua: W.receive.address, receive_uivk: W.receive.uivk, refund_ua: W.user.address, deadline_height: tip + ahead });
const freshItem = (s: SignedIntent, kem: Uint8Array, stage: BoardItem['stage'], e = seal(s, kem)): BoardItem => ({ hash: e.intent_hash, envelope: e, fundingTxid: bytesToHex(randomBytes(32)), stage, note: null, fillTxid: null, claim: null, postedAt: new Date().toISOString() });

describe('one bad item does not stop the desk (Zcash testnet)', () => {
  it('a delivery that throws on the first item is written to its note, and the tick still refunds the second', async () => {
    /** The solver's wallet call fails for every delivery (as a zingo-cli error or timeout would). */
    class FailingDelivery extends Solver {
      override async deliver(): Promise<string> {
        throw new Error('zingo-cli quicksend failed: wallet unreachable (induced by this test)');
      }
    }
    const tip = await chainTip();
    const { desk, verifier, solver, boardPath } = setup((kem) => [freshItem(fresh(tip), kem, 'funded'), item('C', kem, 'declined', { note: 'fee 1 zat is below 15000' })], FailingDelivery);
    const out = await desk.tick();
    expect(out).toEqual([
      { hash: desk.items[0].hash, result: 'error: zingo-cli quicksend failed: wallet unreachable (induced by this test)' },
      { hash: I.C.hash, result: 'REFUNDED' },
    ]);
    expect(desk.items[0]).toMatchObject({ stage: 'funded', failures: 1, note: expect.stringMatching(/^error: zingo-cli quicksend failed/) });
    expect(desk.items[1].stage).toBe('refunded');
    expect(verifier.state.log.map((e) => e.status)).toEqual(['REFUNDED']);
    // Saved, so a restart sees the same note.
    expect(new Desk({ boardPath, solver, verifier, tip: chainTip, info: {} }).items[0].failures).toBe(1);
  });
});

describe('a momentary shortfall in the solver’s balance is retried, not declined (Zcash testnet)', () => {
  it('A funded and received, with the clock held at 3 funding confirmations: the first tick finds the spendable balance short and waits a block; the next takes A on and tries to deliver', async () => {
    /** The wallet's spendable balance is short once (change notes of the previous delivery not yet
     *  spendable), then enough; every send fails while proposing (as "Insufficient balance" does), so
     *  nothing is ever sent. */
    class ShortOnce extends Solver {
      checks = 0;
      sends = 0;
      override async capacity(): Promise<{ ok: true } | { ok: false; reason: string }> {
        return this.checks++ === 0 ? { ok: false, reason: 'min_out 40000 zat is above the solver’s spendable balance 12000 zat' } : { ok: true };
      }
      override async deliver(): Promise<string> {
        this.sends++;
        throw new InsufficientBalanceError('Insufficient balance (induced by this test; nothing is sent)');
      }
    }
    const fundH = (await scan(W.escrow.uivk, d.txs.funding, 60_000, memo.funding(I.A.hash))).height!;
    const tip = fundH + 2; // 3 confirmations
    expect(I.A.signed.intent.deadline_height - tip).toBeGreaterThanOrEqual(3);
    const { desk, solver, verifier } = setup((kem) => [item('A', kem, 'received')], ShortOnce);
    const first = await desk.step(desk.items[0], tip);
    expect(first).toMatch(/^waiting for the solver's balance: min_out 40000 zat is above/);
    expect(desk.items[0]).toMatchObject({ stage: 'received', retryAfter: tip + 1 });
    expect(await desk.step(desk.items[0], tip)).toBe(`waiting for the solver's balance until block ${tip + 1}`);
    const second = await desk.step(desk.items[0], tip + 1);
    expect(second).toMatch(/^waiting for the solver's balance: Insufficient balance/);
    expect(desk.items[0]).toMatchObject({ stage: 'funded', retryAfter: tip + 2 });
    expect(desk.items[0].delivering).toBeUndefined();
    expect((solver as ShortOnce).checks).toBe(2);
    expect((solver as ShortOnce).sends).toBe(1);
    expect(verifier.state.log).toHaveLength(0);
  });
});

describe('a delivery is quoted again right before it is sent', () => {
  it('a funded intent whose deadline is now 1 block away is declined, and the solver sends nothing', async () => {
    class Recording extends Solver {
      sends = 0;
      override async deliver(): Promise<string> {
        this.sends++;
        throw new Error('this test sends nothing');
      }
    }
    const tip = await chainTip();
    const { desk, solver } = setup((kem) => [freshItem(fresh(tip, 1), kem, 'funded')], Recording);
    const result = await desk.step(desk.items[0], tip);
    expect(result).toMatch(/^deadline \d+ is 1 block\(s\) away/);
    expect(desk.items[0]).toMatchObject({ stage: 'declined', fillTxid: null });
    expect((solver as Recording).sends).toBe(0);
  });
});

describe('an unreachable lightwalletd times out instead of blocking the desk', () => {
  const saved = { lwd: process.env.PQI_LWD_URL, ms: process.env.PQI_SCAN_TIMEOUT_MS };
  afterEach(() => {
    for (const [k, v] of [['PQI_LWD_URL', saved.lwd], ['PQI_SCAN_TIMEOUT_MS', saved.ms]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it('chainTip and scan reject after PQI_SCAN_TIMEOUT_MS, and GET /api/info answers while a tick waits on them', async () => {
    process.env.PQI_LWD_URL = 'http://10.255.255.1:9067'; // a blackhole: connections hang
    process.env.PQI_SCAN_TIMEOUT_MS = '2000';
    let t = Date.now();
    await expect(chainTip()).rejects.toThrow(/^zpay-verify tip timed out after 2000 ms \(lightwalletd http:\/\/10\.255\.255\.1:9067\)/);
    expect(Date.now() - t).toBeLessThan(5_000);
    t = Date.now();
    await expect(scan(W.escrow.uivk, d.txs.funding, 1, undefined)).rejects.toThrow(/^zpay-verify verify timed out after 2000 ms/);
    expect(Date.now() - t).toBeLessThan(5_000);

    const { desk } = setup((kem) => [item('C', kem, 'declined')]);
    const server = serveDesk(desk).listen(0, '127.0.0.1');
    await new Promise((ok) => server.once('listening', ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const tick = fetch(`${url}/api/tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await new Promise((r) => setTimeout(r, 300)); // the tick is now waiting on the chain tip
      t = Date.now();
      const info = await fetch(`${url}/api/info`);
      expect(info.status).toBe(200);
      expect(Date.now() - t, 'answered while the tick waits').toBeLessThan(1_000);
      const r = await tick;
      expect(r.status).toBe(502);
      expect((await r.json()).error).toMatch(/timed out after 2000 ms/);
    } finally {
      server.close();
    }
  });
});

describe('junk on the board costs nothing and leaves nothing (Zcash testnet)', () => {
  it('50 self-signed envelopes nobody funded, past their deadline: the tick drops all 50 and the signed log grows by 0', async () => {
    const { desk, verifier, kem } = setup();
    for (let n = 0; n < 50; n++) {
      // 10 of them name another escrow, which used to be refused (and signed) before funding was read.
      const s = signIntent(newSigningKey(), { escrow: n < 10 ? W.user.address : W.escrow.address, pay_zat: '60000', min_out_zat: '40000', receive_ua: W.receive.address, receive_uivk: W.receive.uivk, refund_ua: W.user.address, deadline_height: 1 });
      desk.submit(seal(s, kem), bytesToHex(randomBytes(32)));
    }
    expect(desk.items).toHaveLength(50);
    const out = await desk.tick();
    expect(out.every((r) => /^dropped: NOT_FUNDED:TX_NOT_FOUND/.test(r.result)), JSON.stringify(out.slice(0, 2))).toBe(true);
    expect(verifier.state.log).toHaveLength(0);
    expect(desk.items).toHaveLength(0);
  }, 600_000);

  it('the board holds at most maxOpen open intents, and one with no funding seen for unfundedTtlBlocks is dropped unlogged', async () => {
    const tip = await chainTip();
    const { desk, verifier, kem } = setup(() => [], Solver, { maxOpen: 2, unfundedTtlBlocks: 5 });
    const a = seal(fresh(tip), kem);
    desk.submit(a, bytesToHex(randomBytes(32)));
    desk.submit(seal(fresh(tip), kem), bytesToHex(randomBytes(32)));
    expect(desk.submit(a, bytesToHex(randomBytes(32))).hash).toBe(a.intent_hash); // same hash: the item it has
    const full = (() => {
      try {
        desk.submit(seal(fresh(tip), kem), bytesToHex(randomBytes(32)));
      } catch (e) {
        return e;
      }
    })();
    expect(full).toBeInstanceOf(HttpError);
    expect(full).toMatchObject({ status: 503, message: 'the board is full (2 open intents); try again later' });
    // First seen 6 blocks ago, still nothing with its memo at the escrow: dropped, nothing logged.
    desk.items[0].firstSeen = tip - 6;
    desk.items[1].firstSeen = tip;
    const out = await desk.tick();
    expect(out[0].result).toMatch(/^dropped: no funding seen within 5 blocks \(TX_NOT_FOUND\); nothing logged$/);
    expect(out[1].result).toBe('waiting for funding: TX_NOT_FOUND');
    expect(desk.items.map((i) => i.hash)).not.toContain(a.intent_hash);
    expect(verifier.state.log).toHaveLength(0);
  });
});

describe('HTTP', () => {
  let close: () => void = () => undefined;
  afterEach(() => close());

  it('POSTs need a JSON body under the size limit and are not offered cross-origin; reads stay open', async () => {
    const { desk } = setup();
    const server = serveDesk(desk).listen(0, '127.0.0.1');
    close = () => server.close();
    await new Promise((ok) => server.once('listening', ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // What a page on another site can send without a preflight.
    const crossSite = await fetch(`${url}/api/tick`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(crossSite.status).toBe(415);
    expect(crossSite.headers.get('access-control-allow-origin')).toBeNull();

    const big = await fetch(`${url}/api/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) }) }).catch((e: Error) => e);
    expect(big instanceof Error ? big.message : big.status).toBe(413);

    const info = await fetch(`${url}/api/info`);
    expect(info.status).toBe(200);
    expect(info.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('a request whose Host is not 127.0.0.1 or localhost (a DNS-rebinding page) is refused 403, reads and writes alike', async () => {
    const { desk } = setup();
    const server = serveDesk(desk).listen(0, '127.0.0.1');
    close = () => server.close();
    await new Promise((ok) => server.once('listening', ok));
    const port = (server.address() as AddressInfo).port;
    const send = (method: string, path: string, host: string) =>
      new Promise<{ status: number; body: string; cors: unknown }>((ok, fail) => {
        const r = request({ host: '127.0.0.1', port, method, path, headers: { host, 'content-type': 'application/json' } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c)).on('end', () => ok({ status: res.statusCode!, body, cors: res.headers['access-control-allow-origin'] }));
        });
        r.on('error', fail);
        r.end(method === 'POST' ? '{}' : undefined);
      });
    for (const [method, path] of [['POST', '/api/tick'], ['POST', '/api/intents'], ['GET', '/api/info']]) {
      const r = await send(method, path, 'evil.example');
      expect(r, `${method} ${path}`).toMatchObject({ status: 403, body: JSON.stringify({ error: 'Host "evil.example" is not this desk; use 127.0.0.1 or localhost' }), cors: undefined });
    }
    expect((await send('GET', '/api/info', `127.0.0.1:${port}`)).status).toBe(200);
    expect((await send('GET', '/api/info', `localhost:${port}`)).status).toBe(200);
    expect((await send('GET', '/api/info', `127.0.0.1:${port + 1}`)).status).toBe(403);
  });
});
