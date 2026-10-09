// The app's state and actions: transport (mixnet or dev fetch), the polls every visitor makes
// identically (head, live, catalog), the vault and the wallet.

import { Api, ApiError, DirectTransport, type Head, type Live, type PriceHistory, type Transport } from '../core/api';
import { Wallet, newWalletData, type HistoryEntry, type LocalData, type MyDuel, type Outgoing, type TopupRecord, type WalletData } from '../core/wallet';
import { blankOutputs } from '../core/blind';
import { restore, type DeltaLike } from '../core/restore';
import { SEGMENT, deltaTexts } from '../core/log';
import { yOf } from '../core/blind';
import { IdbStore, Vault, newMnemonic, seedFromMnemonic, type Wrap } from '../vault/vault';
import { createPasskey, prfSupported, unlockPasskey } from '../vault/passkey';
import { MixnetTransport, cleanupIdentities, openCage, type LinkState } from '../net/mixnet';
import { powInWorkers } from '../net/powpool';
import { config } from './config';
import { createStore } from './store';

export interface MarketMeta {
  id: string;
  page: string;
  question: string;
  outcomes: [string, string];
  rules: string;
  source: string;
  /** Polymarket's slug, for the one outbound link (the rules page). */
  slug: string;
  eventStartMs: number | null;
  endMs: number;
  keysets: [string, string];
  resolved: { den: number; num: [number, number] } | null;
  volume: number | null;
  group: string | null;
  /** The market's LMSR liquidity and fee (the same for every market of a network). */
  b: number;
  feeBp: number;
}

export interface Point {
  t: number;
  ours: number;
  ref: number;
}

export interface Position {
  market: string;
  outcome: 0 | 1;
  units: number;
  keyset: string;
}

export type VaultState = 'checking' | 'none' | 'locked' | 'unlocked';

export interface AppState {
  link: LinkState;
  head?: Head;
  live?: Live;
  markets: MarketMeta[];
  series: Record<string, Point[]>;
  /** Price history of every market, from the one file every visitor downloads. */
  prices: Record<string, PriceHistory>;
  /** Requests that got no answer and are being settled from the public log. */
  doubts: number;
  /** False after three live polls in a row got no answer: trading waits for the server. */
  reachable: boolean;
  vault: VaultState;
  wraps: Wrap[];
  balance: number;
  positions: Position[];
  history: HistoryEntry[];
  topups: TopupRecord[];
  /** Device-only back-room state from the vault (notes, stamps, scores). */
  local: LocalData;
  outbox: Outgoing[];
  duels: MyDuel[];
  /** A withdrawal (or, with mix delay on, a trade) waiting out its random delay. */
  delayUntil: number | null;
  /** Mix delay: wait a random 5–30 s before sending a bet or a sale (a preference, not data). */
  mixDelay: boolean;
  busy: string | null;
  notice: string | null;
  error: string | null;
}

export const app = createStore<AppState>({
  link: 'linking',
  markets: [],
  series: {},
  prices: {},
  doubts: 0,
  reachable: true,
  vault: 'checking',
  wraps: [],
  balance: 0,
  positions: [],
  history: [],
  topups: [],
  local: {},
  outbox: [],
  duels: [],
  delayUntil: null,
  mixDelay: readPref('bb-mixdelay'),
  busy: null,
  notice: null,
  error: null,
});

let transport: Transport;
let api: Api;
const vault = new Vault(new IdbStore());
let wallet: Wallet | undefined;

export function getApi(): Api {
  return api;
}

function refreshWallet() {
  if (!wallet) {
    app.set({ balance: 0, positions: [], history: [], topups: [], local: {}, outbox: [], duels: [], doubts: 0 });
    return;
  }
  const positions: Position[] = [];
  for (const m of app.get().markets) {
    const [a, b] = wallet.registerMarket(m.id);
    for (const [o, ks] of [[0, a], [1, b]] as const) {
      const units = wallet.balance(ks.id);
      if (units > 0) positions.push({ market: m.id, outcome: o, units, keyset: ks.id });
    }
  }
  app.set({
    balance: wallet.creditBalance(),
    positions,
    history: [...wallet.data.history],
    topups: [...wallet.data.topups],
    local: { ...wallet.data.local },
    outbox: [...(wallet.data.outbox ?? [])],
    duels: [...(wallet.data.duels ?? [])],
    doubts: wallet.inDoubt(),
  });
}

let settling = false;
let settledAt = -1;

/** Requests without an answer: look them up in the public log once per new block. */
async function settleDoubts(seq: number) {
  if (!wallet || settling || wallet.inDoubt() === 0 || seq === settledAt) return;
  settling = true;
  try {
    const n = await wallet.settleDoubts();
    settledAt = seq;
    if (n > 0) {
      refreshWallet();
      app.set({ notice: `Settled from the public log: ${n === 1 ? 'a request that got no answer' : n + ' requests that got no answer'}. Your balance is up to date.` });
    }
  } catch {
    /* retried with the next block */
  } finally {
    settling = false;
  }
}

let missed = 0;

async function pollLive() {
  try {
    const live = await api.live();
    const series = { ...app.get().series };
    for (const m of live.markets) {
      if (m.price_a_ppm === null) continue;
      const s = (series[m.id] ?? []).concat({ t: live.at_ms, ours: m.price_a_ppm / 10_000, ref: m.reference.mid_ppm / 10_000 });
      series[m.id] = s.slice(-240);
    }
    missed = 0;
    app.set({ live, series, ...(app.get().reachable ? {} : { reachable: true }) });
    void claimDuels(live);
    void notePayouts(live);
    void pollTopups();
    void settleDoubts(live.head.seq);
  } catch {
    // The lamp shows the link state; a missed poll is retried. Three in a row: the server is out.
    if (++missed >= 3 && app.get().reachable) app.set({ reachable: false });
  }
}

interface CatalogEntry {
  id: string;
  keysets: [string, string];
  end_ms: number;
  event_start_ms: number | null;
  status: { state: 'open' } | { state: 'resolved'; den: number; num: [number, number] };
  params: { b: number; fee_bp: number };
  info: { slug: string; question: string; outcomes: [string, string]; description: string; resolution_source: string; volume_24h_usd: number | null; group_item_title: string | null } | null;
}

async function pollCatalog() {
  try {
    const r = await api.transport.request('GET', '/v1/markets');
    const list = ((r.body as { markets?: CatalogEntry[] }).markets ?? []).filter((m) => m.info);
    const markets: MarketMeta[] = list.map((m, i) => ({
      id: m.id,
      page: 'P' + (201 + i),
      question: m.info!.question,
      outcomes: m.info!.outcomes,
      rules: m.info!.description,
      source: m.info!.resolution_source,
      slug: m.info!.slug,
      eventStartMs: m.event_start_ms,
      endMs: m.end_ms,
      keysets: m.keysets,
      resolved: m.status.state === 'resolved' ? { den: m.status.den, num: m.status.num } : null,
      volume: m.info!.volume_24h_usd,
      group: m.info!.group_item_title,
      b: m.params.b,
      feeBp: m.params.fee_bp,
    }));
    app.set({ markets });
    refreshWallet();
  } catch {
    /* retried */
  }
}

async function pollPrices() {
  try {
    const h = await api.json<{ markets: Record<string, PriceHistory> }>('/v1/history.json.gz');
    app.set({ prices: h.markets ?? {} });
  } catch {
    /* a fresh deployment has no history yet; retried */
  }
}

async function pollHead() {
  try {
    app.set({ head: await api.head() });
  } catch {
    /* retried */
  }
}

let started = false;

function readPref(k: string): boolean {
  try {
    return localStorage.getItem(k) === '1';
  } catch {
    return false;
  }
}

export function setMixDelay(on: boolean) {
  app.set({ mixDelay: on });
  try {
    localStorage.setItem('bb-mixdelay', on ? '1' : '0');
  } catch {
    /* private mode */
  }
}

/** With mix delay on, a trade leaves at a random moment 5–30 s later, so its time says less. */
async function mixWait() {
  if (!app.get().mixDelay) return;
  const ms = 5_000 + Math.random() * 25_000;
  app.set({ delayUntil: Date.now() + ms });
  try {
    await new Promise((r) => setTimeout(r, ms));
  } finally {
    app.set({ delayUntil: null });
  }
}

/** Connect and begin the polls every visitor makes; safe to call more than once. */
export async function start() {
  if (started) return;
  started = true;
  if (config.mixnet) {
    await cleanupIdentities();
    const mt = new MixnetTransport(config.api, config.ipr);
    mt.onState((s) => app.set({ link: s }));
    transport = mt;
    api = new Api(transport, powInWorkers);
    void mt.boot();
  } else {
    transport = new DirectTransport(config.api);
    api = new Api(transport, powInWorkers);
    app.set({ link: 'linked' });
  }
  const exists = await vault.exists();
  app.set({ vault: exists ? 'locked' : 'none', wraps: await vault.wraps() });
  await Promise.all([pollHead(), pollCatalog(), pollLive()]);
  setInterval(pollLive, 3_000);
  setInterval(pollHead, 15_000);
  setInterval(pollCatalog, 30_000);
  void pollPrices();
  setInterval(pollPrices, 300_000);
}

function openWallet(data: WalletData) {
  wallet = new Wallet(data, config.m, api, (d) => vault.save(d));
  refreshWallet();
  app.set({ vault: 'unlocked' });
}

/** A fresh vault: 12 new words, saved under a passphrase (computers) and/or a passkey. */
export function newWords(): string {
  return newMnemonic();
}

export async function createVault(words: string, passphrase: string | null, passkey: boolean, backedUp = false) {
  const data = newWalletData(seedFromMnemonic(words));
  data.mnemonic = words;
  data.local = { backedUp };
  await vault.create(data, passphrase ?? undefined);
  if (passkey) await addPasskey();
  app.set({ wraps: await vault.wraps() });
  openWallet(data);
}

export async function addPasskey(): Promise<boolean> {
  if (!prfSupported()) return false;
  const p = await createPasskey();
  if (!p) return false;
  await vault.addPrf(p.credential, p.salt, p.prf);
  app.set({ wraps: await vault.wraps() });
  return true;
}

export async function unlockWithPassphrase(passphrase: string) {
  openWallet((await vault.unlockWithPassphrase(passphrase)) as WalletData);
}

export async function unlockWithPasskey() {
  const w = app.get().wraps.find((x) => x.kind === 'prf');
  if (!w?.credential) throw new Error('no passkey on this device');
  const prf = await unlockPasskey(w.credential, w.salt);
  if (!prf) throw new Error('the passkey did not unlock');
  openWallet((await vault.unlockWithPrf(prf)) as WalletData);
}

export function lockVault() {
  vault.lock();
  wallet = undefined;
  refreshWallet();
  app.set({ vault: 'locked' });
}

/** Rebuild a vault from 12 words with zero-query restore over the public files. */
export async function restoreFromWords(words: string, passphrase: string | null, onProgress?: (s: string) => void) {
  const seed = seedFromMnemonic(words);
  onProgress?.('DOWNLOADING THE PUBLIC LOG');
  const head = await api.head();
  const texts = await deltaTexts(api, 1, head.seq, head.seq, (n, of) => onProgress?.(`DOWNLOADING THE PUBLIC LOG ${n}/${of}`));
  const deltas = texts.map((t) => JSON.parse(t) as DeltaLike);
  onProgress?.('FINDING YOUR SLIPS');
  const r = restore(seed, config.m, deltas, yOf);
  const data = newWalletData(seed);
  data.mnemonic = words.trim().toLowerCase().split(/\s+/).join(' ');
  data.local = { backedUp: true };
  data.slips = r.slips;
  data.counters = r.counters;
  data.calledNext = r.calledNext;
  await vault.create(data, passphrase ?? undefined);
  app.set({ wraps: await vault.wraps() });
  openWallet(data);
  return r;
}

async function act<T>(label: string, f: (w: Wallet) => Promise<T>): Promise<T> {
  if (!wallet) throw new Error('unlock the vault first');
  app.set({ busy: label, error: null });
  try {
    const out = await f(wallet);
    refreshWallet();
    return out;
  } catch (e) {
    const msg = e instanceof ApiError ? plainError(e) : String((e as Error)?.message ?? e);
    app.set({ error: msg });
    throw e;
  } finally {
    app.set({ busy: null });
  }
}

/** Every refusal in plain words. Refusals always happen before anything is spent. */
const PLAIN: Record<string, string> = {
  spent: 'Those slips were already spent. Nothing was taken.',
  duplicate: 'The same slip was sent twice. Nothing was taken.',
  invalid_slip: "A slip's signature didn't check out. Nothing was taken.",
  invalid_claim: 'That code was already used, or the payment is not confirmed yet.',
  bad_limit: 'That price is not allowed (1–99¢).',
  bad_amount: 'That amount is not allowed.',
  bad_withdrawal_amount: 'Withdrawals use the standard amounts only.',
  unbalanced: "The amounts don't add up (not enough balance for this). Nothing was spent.",
  unknown_market: 'That market is not listed here.',
  market_resolved: 'This market is resolved: cash in your winning slips instead.',
  not_resolved: 'This market is not resolved yet: cash-in opens when Polymarket’s result is final.',
  nothing_to_redeem: 'This outcome lost: those shares pay nothing.',
  trading_closed: 'Trading has closed for this market (the event started, or Polymarket paused it).',
  duel_unknown: 'That challenge is no longer open: someone took it, or it was cancelled.',
  duel_exists: 'That challenge already exists. Try again.',
  duel_terms: 'The challenge changed since you looked. Check it and take it again.',
  bad_duel: 'That duel is not allowed: price 1–99¢, and a positive size.',
  bad_cancel: 'Only the challenger can cancel this duel.',
  supply_guard: 'Withdrawals are paused while the operator checks the books. Your slips keep their value.',
  unavailable: 'The service is busy for a moment. Nothing was spent; try again.',
  busy: 'Too many requests right now. Nothing was spent; try again in a moment.',
  malformed_answer: "The server answered in a form this app doesn't understand. Nothing was spent.",
  'malformed code': 'That is not a judge code. Codes look like BB-XXXX-XXXX-XXXX-XXXX.',
  'claim hash already used': 'That top-up request clashed with another. Nothing was paid; start the top-up again.',
  'proof-of-work': 'The request was malformed. Nothing was spent.',
  'malformed request': 'The request was malformed. Nothing was spent.',
};

export function plainError(e: ApiError): string {
  return PLAIN[e.code] ?? `Refused (${e.code.replace(/_/g, ' ')}). Nothing was spent.`;
}

/** One cage per pending top-up: polled in the background (whatever window is open) and
 *  closed once credited or expired. */
const cages = new Map<string, Transport & { close(): void }>();
let polling = false;
async function pollTopups() {
  if (!wallet || polling) return;
  const h = app.get().head?.height ?? 0;
  const pending = wallet.data.topups.filter((t) => t.status === 'awaiting' || t.status === 'seen');
  if (!pending.length) return;
  polling = true;
  try {
    for (const t of pending) {
      if (t.status === 'awaiting' && h > t.expires_height) {
        // Nothing arrived while the address was valid: it is retired, nothing was lost.
        t.status = 'expired';
        cages.get(t.id)?.close();
        cages.delete(t.id);
        await vault.save(wallet.data);
        continue;
      }
      let w = wallet;
      if (config.mixnet) {
        let cage = cages.get(t.id);
        if (!cage) {
          cage = await openCage(config.api, config.ipr);
          cages.set(t.id, cage);
        }
        w = new Wallet(wallet.data, config.m, new Api(cage, powInWorkers), (d) => vault.save(d));
      }
      const before = t.status;
      const rec = await w.topupPoll(t.id);
      if (rec.status === 'credited' || rec.status === 'confirmed') {
        cages.get(t.id)?.close();
        cages.delete(t.id);
        app.set({ notice: `Top-up credited: +${(rec.amount_zat / 1e8).toFixed(4)} ${config.network === 'mainnet' ? 'ZEC' : 'TAZ'} is in your balance.` });
      } else if (before === 'awaiting' && rec.status === 'seen') {
        app.set({ notice: 'Top-up SEEN in the mempool: crediting…' });
      }
    }
    refreshWallet();
  } catch {
    /* retried on the next tick */
  } finally {
    polling = false;
  }
}

/** Our withdrawals paid, from the payouts every visitor polls: remembered in the vault. */
async function notePayouts(live: Live) {
  if (!wallet || !live.payouts?.length) return;
  const paid = { ...(wallet.data.local?.paid ?? {}) };
  let fresh = 0;
  for (const h of wallet.data.history) {
    const c = h.kind === 'withdraw' ? (h.stored.commitment as string | undefined) : undefined;
    if (!c || paid[c]) continue;
    const p = live.payouts.find((x) => x.commitments.includes(c));
    if (p) {
      paid[c] = p.txid;
      fresh++;
    }
  }
  if (fresh) {
    await setLocal({ paid });
    app.set({ notice: fresh === 1 ? 'Your withdrawal was paid. The address is forgotten.' : `${fresh} withdrawals were paid. The addresses are forgotten.` });
  }
}

/** Our taken duels: the challenger's signatures are in the feed every visitor polls. */
let claiming = false;
async function claimDuels(live: Live) {
  if (!wallet || claiming || !live.duel_fills?.length) return;
  const open = (wallet.data.duels ?? []).filter((d) => d.status === 'open');
  const fills = live.duel_fills.filter((f) => open.some((d) => d.duel === f.duel));
  if (!fills.length) return;
  claiming = true;
  try {
    let n = 0;
    for (const f of fills) n += await wallet.duelClaim(f.duel, f.signatures);
    refreshWallet();
    app.set({ notice: `Your duel was taken: ${(n / 100_000).toFixed(4)} shares are in your slips.` });
  } catch {
    /* retried on the next poll */
  } finally {
    claiming = false;
  }
}

/** A duel taken while we were away (older than the live feed): find our shares in the public
 *  log, the same files every visitor can download, by our own blinded outputs. */
export async function recoverDuel(duel: string): Promise<number> {
  const d = wallet?.data.duels?.find((x) => x.duel === duel && x.status === 'open');
  if (!wallet || !d) return 0;
  const pending = blankOutputs(wallet.seed, d.keyset, d.counter).pending;
  const index = new Map(pending.map((p, i) => [p.B_, i]));
  const head = await api.head();
  // Newest first, a segment at a time, back to the block the duel was opened in.
  for (let hi = head.seq; hi >= 1; ) {
    const lo = Math.floor((hi - 1) / SEGMENT) * SEGMENT + 1;
    const texts = await deltaTexts(api, lo, hi, head.seq);
    for (const t of texts.reverse()) {
      const delta = JSON.parse(t) as { issued: { id: string; amount: number; B_: string; C_: string; dleq: { e: string; s: string } }[]; events: { type: string; duel?: string }[] };
      const mine = delta.issued.filter((s) => index.has(s.B_));
      if (mine.length) {
        const n = await wallet.duelClaim(duel, mine.map((s) => ({ index: index.get(s.B_)!, amount: s.amount, id: s.id, C_: s.C_, dleq: s.dleq })));
        refreshWallet();
        return n;
      }
      if (delta.events.some((e) => e.type === 'duel_opened' && e.duel === duel)) return 0;
    }
    hi = lo - 1;
  }
  return 0;
}

export const actions = {
  voucher: (code: string) => act('REDEEMING CODE', (w) => w.voucher(code)),
  buy: (market: string, outcome: 0 | 1, units: number, limitBp: number) =>
    act('PRINTING', async (w) => {
      await mixWait();
      return w.buy(market, outcome, units, limitBp);
    }).then(async (r) => {
      if (r.fill.out > 0) await earnStamp('FIRST SLIP');
      return r;
    }),
  sell: (market: string, outcome: 0 | 1, units: number, limitBp: number) =>
    act('SELLING', async (w) => {
      await mixWait();
      return w.sell(market, outcome, units, limitBp);
    }),
  redeem: (market: string, outcome: 0 | 1) => act('CASHING IN', (w) => w.redeem(market, outcome)),
  send: (keyset: string, units: number, paper = false) => act('PREPARING SLIPS', (w) => w.send(keyset, units, paper)),
  reclaim: (code: string) => act('TAKING BACK', (w) => w.reclaim(code)),
  duelOpen: (market: string, outcome: 0 | 1, shares: number, priceBp: number) => act('OPENING THE DUEL', (w) => w.duelOpen(market, outcome, shares, priceBp)),
  duelTake: (d: { duel: string; market: string; outcome: 0 | 1; shares: number; price_bp: number; stake: number }) => act('TAKING THE DUEL', (w) => w.duelTake(d)),
  duelCancel: (duel: string) => act('CANCELLING', (w) => w.duelCancel(duel)),
  receive: (code: string) =>
    act('TAKING OVER SLIPS', (w) => w.receiveCode(code)).then(async (n) => {
      await earnStamp('PASSED IN THE DARK');
      return n;
    }),
  /** A top-up runs over its own mixnet identity (a cage), kept until it is credited: the
   *  betting tunnel never touches it. */
  async topupStart(amountZat: number) {
    return act('OPENING THE CAGE', async (w) => {
      if (!config.mixnet) return w.topupStart(amountZat);
      const cage = await openCage(config.api, config.ipr);
      try {
        const rec = await new Wallet(w.data, config.m, new Api(cage, powInWorkers), (d) => vault.save(d)).topupStart(amountZat);
        cages.set(rec.id, cage);
        return rec;
      } catch (e) {
        cage.close();
        throw e;
      }
    });
  },
  async withdraw(units: number, address: string) {
    return act('WITHDRAWING', async (w) => {
      // A random 0–60 s privacy delay before sending (PROTOCOL section 1), from a separate identity.
      const ms = config.dev ? 3_000 : Math.random() * 60_000;
      app.set({ delayUntil: Date.now() + ms });
      try {
        await new Promise((r) => setTimeout(r, ms));
      } finally {
        app.set({ delayUntil: null });
      }
      if (!config.mixnet) return w.withdraw(units, address, config.sealPk);
      const cage = await openCage(config.api, config.ipr);
      try {
        const cw = new Wallet(w.data, config.m, new Api(cage, powInWorkers), (d) => vault.save(d));
        return await cw.withdraw(units, address, config.sealPk);
      } finally {
        cage.close();
      }
    });
  },
  dismiss: () => app.set({ error: null, notice: null }),
};

/** Save device-only back-room state into the vault (a no-op while it is locked). */
export async function setLocal(patch: Partial<LocalData>) {
  if (!wallet) return;
  await wallet.setLocal(patch);
  app.set({ local: { ...wallet.data.local } });
}

/** Earn a NOBODY PASS stamp (local only). */
export async function earnStamp(name: string) {
  const have = app.get().local.stamps ?? [];
  if (!wallet || have.includes(name)) return;
  await setLocal({ stamps: [...have, name] });
}

/** The 12 words of the open vault (for a backup shown on this screen only). */
export function walletWords(): string | undefined {
  return wallet?.data.mnemonic;
}

export function walletSeedHex(): string | undefined {
  return wallet?.data.seed;
}

export function currentWallet(): Wallet | undefined {
  return wallet;
}

export { prfSupported };

// Development: the app state lives in this module, so an edit here (or below it) reloads the page
// instead of hot-swapping a fresh, unstarted copy.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
