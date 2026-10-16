// Bursts and abuse against a live stack (deploy test or a deployment): ~500 bets landing in one
// batch, a flood of duel offers against the limits, and a stream of junk requests, while a
// "judge" wallet keeps betting and its latency is measured. Runs only when BB_BURST is set, e.g.
//   BB_BURST=http://127.0.0.1:18081 BB_BURST_M=03… BB_BURST_CODES=BB-…,BB-… pnpm vitest run burst.it
// Options (environment):
//   BB_BURST_WALLETS  wallets for the bet burst (default 34; each needs a code, plus one for the judge)
//   BB_BURST_TRADES   bets per wallet in the burst (default 15, 0.01 TAZ each)
//   BB_BURST_JUNK_S   seconds of junk requests (default 60)
//   BB_BURST_OUT      a JSON file for the results
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { Api, ApiError, DirectTransport, type PowFn } from './api';
import { InDoubtError, Wallet, newWalletData } from './wallet';
import { utf8 } from './bytes';
import { withPow } from './pow';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const BASE = env.BB_BURST;
const M = env.BB_BURST_M ?? '0204559d9106c538b0f21bd82b50c47117bfda93530ed212fb818b886321cdea3c';
const WALLETS = Number(env.BB_BURST_WALLETS ?? 34);
const TRADES = Number(env.BB_BURST_TRADES ?? 15);
const JUNK_S = Number(env.BB_BURST_JUNK_S ?? 60);
const codes = (env.BB_BURST_CODES ?? '').split(',').filter(Boolean);
const pow: PowFn = async (body, bits) => withPow(body, bits);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errName = (e: unknown) => (e instanceof ApiError ? e.code : e instanceof InDoubtError ? 'in_doubt' : String((e as Error)?.message ?? e).slice(0, 60));
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : 0);
const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

describe.skipIf(!BASE)('burst', () => {
  it('bets, duels and junk under load, while a judge keeps betting', async () => {
    const api = new Api(new DirectTransport(BASE), pow);
    const mk = (i: number) => new Wallet(newWalletData(sha256(utf8(`burst-${i}-${Date.now()}`))), M, api, async () => {});
    const results: Record<string, unknown> = { base: BASE, wallets: WALLETS, trades: TRADES };
    const live0 = await api.live();
    const market = live0.markets.find((m) => m.state === 'open' && m.price_a_ppm !== null);
    expect(market, 'an open market').toBeTruthy();

    // ---- funding ------------------------------------------------------------------------------
    const judge = mk(-1);
    const ws = Array.from({ length: WALLETS }, (_, i) => mk(i));
    const all = [judge, ...ws];
    expect(codes.length, 'one code per wallet').toBeGreaterThanOrEqual(all.length);
    // Four at a time: every wallet's proof of work runs on this one thread, and 35 at once would
    // starve the replies' timers here (the client's limit, not the server's). Any answer still
    // lost is settled from the log, as the app does.
    const funded: string[] = [];
    for (let i = 0; i < all.length; i += 4) {
      funded.push(...(await Promise.all(all.slice(i, i + 4).map((w, k) => w.voucher(codes[i + k]!).then(() => 'true', (e) => errName(e))))));
    }
    for (let round = 0; round < 12 && all.some((w) => w.inDoubt()); round++) {
      await sleep(15_000);
      for (const w of all) await w.settleDoubts().catch(() => 0);
    }
    results.funded = { ...count(funded), still_in_doubt: all.filter((w) => w.inDoubt()).length, with_balance: all.filter((w) => w.creditBalance() > 0).length };

    // The judge bets every 8 s throughout and records how long each bet takes.
    const judgeMs: { phase: string; ms: number; ok: boolean; err?: string }[] = [];
    let phase = 'baseline';
    let stop = false;
    const judging = (async () => {
      while (!stop) {
        const t0 = performance.now();
        try {
          await judge.buy(market!.id, 0, 1_000, 9_900);
          judgeMs.push({ phase, ms: Math.round(performance.now() - t0), ok: true });
        } catch (e) {
          judgeMs.push({ phase, ms: Math.round(performance.now() - t0), ok: false, err: errName(e) });
        }
        await sleep(8_000);
      }
    })();
    await sleep(30_000);

    // ---- 1. a burst of bets -----------------------------------------------------------------------
    phase = 'bets';
    const h0 = await api.head();
    const t0 = performance.now();
    const bets: { ms: number; err?: string }[] = [];
    await Promise.all(
      ws.map(async (w, i) => {
        await sleep(i * 40);
        for (let k = 0; k < TRADES; k++) {
          const s = performance.now();
          try {
            await w.buy(market!.id, (k % 2) as 0 | 1, 1_000, 9_900);
            bets.push({ ms: Math.round(performance.now() - s) });
          } catch (e) {
            bets.push({ ms: Math.round(performance.now() - s), err: errName(e) });
          }
        }
      }),
    );
    const h1 = await api.head();
    const okBets = bets.filter((b) => !b.err).map((b) => b.ms);
    results.bets = { n: bets.length, ok: okBets.length, seconds: Math.round((performance.now() - t0) / 1000), blocks: h1.height - h0.height, published: h1.seq - h0.seq, p50: pct(okBets, 50), p95: pct(okBets, 95), max: pct(okBets, 100), errs: count(bets.filter((b) => b.err).map((b) => b.err!)) };

    // ---- 2. a flood of duel offers ------------------------------------------------------------------
    phase = 'duels';
    const price = Math.max(5, Math.min(95, Math.round(market!.price_a_ppm! / 10_000)));
    const shares = Math.ceil((1_000 * 100) / price);
    const offers: string[] = [];
    const opened: { w: Wallet; duel: string }[] = [];
    await Promise.all(
      ws.slice(0, 20).map(async (w) => {
        for (let k = 0; k < 5; k++) {
          try {
            const d = await w.duelOpen(market!.id, 0, shares, price * 100);
            opened.push({ w, duel: d.duel });
            offers.push('ok');
          } catch (e) {
            offers.push(errName(e));
          }
        }
      }),
    );
    const liveDuels = (await api.live()).duels.length;
    results.duels = { tried: offers.length, outcome: count(offers), live_board: liveDuels };
    // take the escrow back (cancels are fee-free writes too: a few blocks)
    const cancels: string[] = [];
    for (let round = 0; round < 12 && opened.length; round++) {
      const batch = opened.splice(0, opened.length);
      for (const o of batch) {
        try {
          await o.w.duelCancel(o.duel);
          cancels.push('ok');
        } catch (e) {
          const n = errName(e);
          if (n === 'busy') opened.push(o);
          else cancels.push(n);
        }
      }
      if (opened.length) await sleep(26_000);
    }
    results.cancels = { ...count(cancels), left_open: opened.length };

    // ---- 3. junk ------------------------------------------------------------------------------------
    phase = 'junk';
    const statuses: string[] = [];
    const big = 'x'.repeat(127 * 1024);
    const junk = [
      () => fetch(`${BASE}/v1/trade`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"not json' }),
      () => fetch(`${BASE}/v1/trade`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ market: market!.id, outcome: 0, amount: 1000, inputs: [], outputs: [], pow: 'bogus' }) }),
      () => fetch(`${BASE}/v1/swap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: big }) }),
      () => fetch(`${BASE}/v1/voucher`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'BB-' + Math.random().toString(36).slice(2) }) }),
      () => fetch(`${BASE}/v1/topup/${Math.random().toString(16).slice(2)}`),
      () => fetch(`${BASE}/v1/delta/99999999.json.gz`),
      () => fetch(`${BASE}/v1/nope/${Math.random()}`),
      () => fetch(`${BASE}/v1/head`),
      () => fetch(`${BASE}/v1/live`),
    ];
    const until = Date.now() + JUNK_S * 1000;
    await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        while (Date.now() < until) {
          try {
            const r = await junk[(i + statuses.length) % junk.length]!();
            await r.arrayBuffer();
            statuses.push(String(r.status));
          } catch (e) {
            statuses.push('net:' + errName(e));
          }
        }
      }),
    );
    results.junk = { requests: statuses.length, per_s: Math.round(statuses.length / JUNK_S), statuses: count(statuses) };

    phase = 'after';
    await sleep(30_000);
    stop = true;
    await judging;
    const byPhase: Record<string, unknown> = {};
    for (const ph of ['baseline', 'bets', 'duels', 'junk', 'after']) {
      const xs = judgeMs.filter((j) => j.phase === ph);
      const ok = xs.filter((j) => j.ok).map((j) => j.ms);
      byPhase[ph] = { n: xs.length, ok: ok.length, p50: pct(ok, 50), max: pct(ok, 100), errs: count(xs.filter((j) => !j.ok).map((j) => j.err!)) };
    }
    results.judge = byPhase;
    const live1 = await api.live();
    results.live_after = { bytes: JSON.stringify(live1).length, recent: live1.recent.length, duels: live1.duels.length, payouts: live1.payouts.length };
    console.log(JSON.stringify(results, null, 2));
    if (env.BB_BURST_OUT) writeFileSync(env.BB_BURST_OUT, JSON.stringify(results, null, 2));
    // The judge never fails outright; the limits answer with refusals, not crashes.
    expect(judgeMs.filter((j) => !j.ok && j.err !== 'busy').length).toBe(0);
    expect(statuses.filter((s) => s.startsWith('5') || s.startsWith('net:')).length).toBe(0);
  }, 3_600_000);
});
