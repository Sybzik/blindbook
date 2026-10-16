// Load and endurance runs against a live server: the devserver (crates/blindbook-api, signer
// in-process) or a deployed stack. A few wallets trade, sell, hand slips to each other and duel;
// on the devserver they also top up (its simulated payment) and withdraw. Every action is timed.
// Runs only when BB_LOAD is set, e.g.
//   BB_LOAD=http://127.0.0.1:8090 BB_LOAD_DEV=1 BB_LOAD_MINUTES=60 pnpm vitest run load.it
// Options (environment):
//   BB_LOAD_MINUTES  how long (default 10)
//   BB_LOAD_WALLETS  how many wallets (default 3)
//   BB_LOAD_PACE_MS  mean pause between one wallet's actions (default 6000)
//   BB_LOAD_CODES    voucher codes to fund the wallets, comma-separated (default DEV-0001…)
//   BB_LOAD_DEV=1    devserver: fund by simulated top-ups, withdraw, pay out with /dev/payout
//   BB_LOAD_M        the master public key M (default the devserver's)
//   BB_LOAD_OUT      a JSON-lines file for every action, and <file>.summary.json at the end
//   BB_LOAD_SETTLE_MS  at the end, keep settling requests in doubt this long, then record what is
//                    left per wallet as a 'final' row (chaos tests: nothing should be)
import { appendFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { Api, ApiError, DirectTransport, type PowFn } from './api';
import { InDoubtError, Wallet, newWalletData } from './wallet';
import { utf8 } from './bytes';
import { withPow } from './pow';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const BASE = env.BB_LOAD;
const MINUTES = Number(env.BB_LOAD_MINUTES ?? 10);
const WALLETS = Number(env.BB_LOAD_WALLETS ?? 3);
const PACE = Number(env.BB_LOAD_PACE_MS ?? 6_000);
const DEV = env.BB_LOAD_DEV === '1';
const M = env.BB_LOAD_M ?? '0204559d9106c538b0f21bd82b50c47117bfda93530ed212fb818b886321cdea3c';
const SEAL_PK = env.BB_LOAD_SEAL ?? '45a6018a2cf7c127c6ddfb1246298c9e2e09db027ab6cb4c3dc22bd7f838e745';
const PAYEE = 'utest166fy5luckyz2fnztzsznh6rwt5pe0va4mpnqm6axfklss87w53fw50aqg3rwmt2stt5nnmnzgteckxjquxx2yjuk4rmrntds7gtghekc';
const OUT = env.BB_LOAD_OUT;
const SETTLE_MS = Number(env.BB_LOAD_SETTLE_MS ?? 0);
const codes = (env.BB_LOAD_CODES ?? Array.from({ length: 90 }, (_, i) => `DEV-${String(i + 1).padStart(4, '0')}`).join(',')).split(',').filter(Boolean);
const pow: PowFn = async (body, bits) => withPow(body, bits);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

interface Row {
  t: number;
  w: number;
  kind: string;
  ms: number;
  ok: boolean;
  err?: string;
}
const rows: Row[] = [];
function record(r: Row) {
  rows.push(r);
  if (OUT) appendFileSync(OUT, JSON.stringify(r) + '\n');
}

async function timed<T>(w: number, kind: string, f: () => Promise<T>): Promise<T | undefined> {
  const t0 = performance.now();
  try {
    const v = await f();
    record({ t: Date.now(), w, kind, ms: Math.round(performance.now() - t0), ok: true });
    return v;
  } catch (e) {
    const err = e instanceof ApiError ? e.code : e instanceof InDoubtError ? 'in_doubt' : String((e as Error)?.message ?? e).slice(0, 80);
    record({ t: Date.now(), w, kind, ms: Math.round(performance.now() - t0), ok: false, err });
    return undefined;
  }
}

function summary() {
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.kind, [...(by.get(r.kind) ?? []), r]);
  const pct = (xs: number[], p: number) => (xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : 0);
  const out: Record<string, unknown> = {};
  for (const [k, rs] of by) {
    const ok = rs.filter((r) => r.ok).map((r) => r.ms);
    const errs: Record<string, number> = {};
    for (const r of rs.filter((x) => !x.ok)) errs[r.err!] = (errs[r.err!] ?? 0) + 1;
    out[k] = { n: rs.length, ok: ok.length, p50: pct([...ok], 50), p95: pct([...ok], 95), max: pct([...ok], 100), errs };
  }
  return out;
}

describe.skipIf(!BASE)('load', () => {
  it(
    `${WALLETS} wallets for ${MINUTES} min`,
    async () => {
      const api = new Api(new DirectTransport(BASE), pow);
      const ws = Array.from({ length: WALLETS }, (_, i) => new Wallet(newWalletData(sha256(utf8(`load-${i}-${Date.now()}`))), M, api, async () => {}));
      const end = Date.now() + MINUTES * 60_000;
      let codeAt = 0;
      const handed: string[] = [];

      async function fund(i: number) {
        const w = ws[i]!;
        if (w.creditBalance() >= 6_000) return;
        if (DEV) {
          const t = await timed(i, 'topup', async () => {
            const rec = await w.topupStart(10_000_000); // 0.1 TAZ = 10,000 units
            await fetch(`${BASE}/dev/pay/${rec.id}`, { method: 'POST' });
            let r = rec;
            for (let k = 0; k < 60 && r.status !== 'credited' && r.status !== 'confirmed'; k++) {
              await sleep(500);
              r = await w.topupPoll(rec.id);
            }
            if (r.status !== 'credited' && r.status !== 'confirmed') throw new Error(`top-up ${r.status}`);
            return r;
          });
          if (t) return;
        }
        if (codeAt < codes.length) await timed(i, 'voucher', () => w.voucher(codes[codeAt++]!));
      }

      async function step(i: number) {
        const w = ws[i]!;
        const live = await api.live();
        const open = live.markets.filter((m) => m.state === 'open' && m.price_a_ppm !== null);
        // As the app does with each block: settle requests in doubt, then read the new blocks
        // (slips spent elsewhere, duels taken from us), then claim what the feed still shows.
        await w.settleDoubts().catch(() => 0);
        const synced = await w.sync().catch((e) => String((e as Error)?.message ?? e).slice(0, 80));
        if (typeof synced === 'string') record({ t: Date.now(), w: i, kind: 'sync', ms: 0, ok: false, err: synced });
        for (const f of live.duel_fills ?? []) {
          if ((w.data.duels ?? []).some((d) => d.duel === f.duel && d.status === 'open')) await timed(i, 'duel_claim', () => w.duelClaim(f.duel, f.signatures));
        }
        await fund(i);
        if (!open.length) return;
        const m = pick(open);
        const positions = open.flatMap((mk) => ([0, 1] as const).map((o) => ({ m: mk.id, o, units: w.balance(w.keysetOf(mk.id, o).id) }))).filter((p) => p.units >= 1_000);
        const r = Math.random();
        if (r < 0.45) {
          const o = (Math.random() < 0.5 ? 0 : 1) as 0 | 1;
          await timed(i, 'buy', () => w.buy(m.id, o, pick([1_000, 2_000, 5_000]), 9_800));
        } else if (r < 0.7 && positions.length) {
          const p = pick(positions);
          await timed(i, 'sell', () => w.sell(p.m, p.o, p.units, 100));
        } else if (r < 0.78) {
          // Hand 1,000 units to the next wallet, which takes them over.
          const code = await timed(i, 'send', () => w.send(w.credit.id, 1_000));
          if (code) handed.push(code);
          const next = ws[(i + 1) % ws.length]!;
          const c = handed.shift();
          if (c) await timed((i + 1) % ws.length, 'receive', () => next.receiveCode(c));
        } else if (r < 0.84) {
          const o = (Math.random() < 0.5 ? 0 : 1) as 0 | 1;
          const price = Math.max(5, Math.min(95, Math.round((o === 0 ? m.price_a_ppm! : 1_000_000 - m.price_a_ppm!) / 10_000)));
          const stake = pick([1_000, 2_000]);
          const shares = Math.ceil((stake * 100) / price);
          const d = await timed(i, 'duel_open', () => w.duelOpen(m.id, o, shares, price * 100));
          if (d) {
            if (Math.random() < 0.6) {
              const taker = ws[(i + 1) % ws.length]!;
              await timed((i + 1) % ws.length, 'duel_take', () => taker.duelTake(d));
            } else {
              await sleep(1_000);
              await timed(i, 'duel_cancel', () => w.duelCancel(d.duel));
            }
          }
        } else if (r < 0.88 && DEV && w.creditBalance() >= 12_000) {
          await timed(i, 'withdraw', () => w.withdraw(10_000, PAYEE, SEAL_PK));
          await fetch(`${BASE}/dev/payout`, { method: 'POST' }).catch(() => undefined);
        } else {
          await timed(i, 'live', () => api.live());
        }
      }

      let lastReport = Date.now();
      await Promise.all(
        ws.map(async (_, i) => {
          await sleep(i * 700);
          while (Date.now() < end) {
            try {
              await step(i);
            } catch (e) {
              record({ t: Date.now(), w: i, kind: 'step', ms: 0, ok: false, err: String((e as Error)?.message ?? e).slice(0, 80) });
            }
            if (i === 0 && Date.now() - lastReport > 5 * 60_000) {
              lastReport = Date.now();
              console.log(new Date().toISOString(), JSON.stringify(summary()));
            }
            await sleep(PACE * (0.5 + Math.random()));
          }
        }),
      );
      if (SETTLE_MS) {
        const until = Date.now() + SETTLE_MS;
        while (Date.now() < until && ws.some((w) => w.watching())) {
          for (const w of ws) {
            await w.settleDoubts().catch(() => 0);
            await w.sync().catch(() => undefined);
          }
          await sleep(15_000);
        }
        ws.forEach((w, i) => {
          const left = w.watching();
          record({ t: Date.now(), w: i, kind: 'final', ms: 0, ok: left === 0, err: left ? `${w.inDoubt()} in doubt, ${(w.data.released ?? []).length} released` : undefined });
        });
      }
      const s = summary();
      console.log('final', JSON.stringify(s));
      if (OUT) writeFileSync(OUT + '.summary.json', JSON.stringify({ base: BASE, minutes: MINUTES, wallets: WALLETS, pace: PACE, dev: DEV, summary: s }, null, 2));
      expect(rows.some((r) => r.kind === 'buy' && r.ok)).toBe(true);
    },
    MINUTES * 60_000 + SETTLE_MS + 300_000,
  );
});
