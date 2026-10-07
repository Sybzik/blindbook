// The browser wallet against the real server (crates/blindbook-api devserver, the Rust signer
// in-process). Runs when BB_DEV_API is set, e.g.
//   cargo run -p blindbook-api --features embedded-signer --example devserver
//   BB_DEV_API=http://127.0.0.1:8090 pnpm vitest run wallet.it
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { Api, DirectTransport, type PowFn } from './api';
import { Wallet, newWalletData, type WalletData } from './wallet';
import { utf8 } from './bytes';
import { withPow } from './pow';
import { restore, type DeltaLike, type Snapshot } from './restore';
import { yOf } from './blind';

const BASE = process.env.BB_DEV_API;
const M = '0204559d9106c538b0f21bd82b50c47117bfda93530ed212fb818b886321cdea3c';
const SEAL_PK = '45a6018a2cf7c127c6ddfb1246298c9e2e09db027ab6cb4c3dc22bd7f838e745';
const PAYEE = 'utest166fy5luckyz2fnztzsznh6rwt5pe0va4mpnqm6axfklss87w53fw50aqg3rwmt2stt5nnmnzgteckxjquxx2yjuk4rmrntds7gtghekc';
const pow: PowFn = async (body, bits) => withPow(body, bits);

function wallet(label: string) {
  const api = new Api(new DirectTransport(BASE), pow);
  let saved: WalletData | undefined;
  const w = new Wallet(newWalletData(sha256(utf8(label + Date.now()))), M, api, async (d) => {
    saved = structuredClone(d);
  });
  return { w, api, saved: () => saved };
}

describe.skipIf(!BASE)('wallet against the devserver', () => {
  it('voucher → buy → sell → top-up → withdraw → hand slips over', async () => {
    const { w, api, saved } = wallet('alice');
    const live = await api.live();
    expect(live.markets.length).toBe(3);
    const market = live.markets[0]!.id;
    w.registerMarket(market);

    const code = `DEV-${String(1 + Math.floor(Math.random() * 98)).padStart(4, '0')}`;
    expect(await w.voucher(code)).toBe(50_000);
    expect(w.creditBalance()).toBe(50_000);
    // Counters were reserved and saved before the request left.
    expect(saved()?.counters[w.credit.id]).toBe(31);

    const t0 = performance.now();
    const buy = await w.buy(market, 0, 2_000, 9_500);
    expect(performance.now() - t0).toBeLessThan(3_500);
    expect(['filled', 'shrunk']).toContain(buy.fill.status);
    const pos = w.keysetOf(market, 0);
    expect(w.balance(pos.id)).toBe(buy.fill.out);
    expect(w.creditBalance()).toBe(48_000 + buy.fill.refund);
    expect(w.data.history.at(-1)?.called?.tag).toBe(buy.fill.tag);

    const sell = await w.sell(market, 0, Math.floor(buy.fill.out / 2), 1);
    expect(sell.fill.kept).toBeGreaterThan(0);

    const t = await w.topupStart(1_000_000);
    expect(t.address.startsWith('utest1')).toBe(true);
    await fetch(`${BASE}/dev/pay/${t.id}`, { method: 'POST' });
    let rec = t;
    for (let i = 0; i < 40 && rec.status !== 'confirmed' && rec.status !== 'credited'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      rec = await w.topupPoll(t.id);
    }
    expect(['credited', 'confirmed']).toContain(rec.status);
    expect(rec.privacy).toBe('SHIELDED');

    const before = w.creditBalance();
    await w.withdraw(10_000, PAYEE, SEAL_PK);
    expect(w.creditBalance()).toBe(before - 10_020);
    expect(await (await fetch(`${BASE}/dev/payout`, { method: 'POST' })).text()).toMatch(/paid 1/);

    // Alice hands 1,000 units to Bob; Bob takes them over; Alice can't spend them again.
    const slipCode = await w.send(w.credit.id, 1_000);
    expect(slipCode.startsWith('bbslip1:')).toBe(true);
    const bob = wallet('bob');
    expect(await bob.w.receiveCode(slipCode)).toBe(1_000);
    expect(bob.w.creditBalance()).toBe(1_000);
    await expect(bob.w.receiveCode(slipCode)).rejects.toThrow(/spent/);

    // Zero-query restore: only public files, and the same slips and trades come back.
    const head0 = await api.head();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      if ((await api.head()).seq > head0.seq) break;
    }
    const head = await api.head();
    const snap = await api.json<Snapshot>('/v1/snapshot/latest.json.gz');
    const deltas: DeltaLike[] = [];
    for (let seq = 1; seq <= head.seq; seq++) deltas.push(await api.json<DeltaLike>(`/v1/delta/${seq}.json.gz`));
    const r = restore(w.seed, M, { ...snap, seq: 0 }, deltas, yOf);
    expect(r.foreign).toEqual([]);
    const sum = (ps: { amount: number; id: string }[], id: string) => ps.filter((p) => p.id === id).reduce((n, p) => n + p.amount, 0);
    expect(sum(r.slips, w.credit.id)).toBe(w.creditBalance());
    expect(sum(r.slips, pos.id)).toBe(w.balance(pos.id));
    expect(new Set(r.slips.map((p) => p.secret))).toEqual(new Set(w.data.slips.map((p) => p.secret)));
    expect(r.trades.map((t) => t.side)).toEqual(['buy', 'sell']);
    expect(r.calledNext).toBe(w.data.calledNext);
  }, 90_000);
});
