// The app's state and actions: transport (mixnet or dev fetch), the polls every visitor makes
// identically (head, live, catalog), the vault and the wallet.

import { Api, ApiError, DirectTransport, type Head, type Live, type Transport } from '../core/api';
import { Wallet, newWalletData, type HistoryEntry, type LocalData, type Outgoing, type TopupRecord, type WalletData } from '../core/wallet';
import { restore, type DeltaLike, type Snapshot } from '../core/restore';
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
  eventStartMs: number | null;
  endMs: number;
  keysets: [string, string];
  resolved: { den: number; num: [number, number] } | null;
  volume: number | null;
  group: string | null;
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
  vault: VaultState;
  wraps: Wrap[];
  balance: number;
  positions: Position[];
  history: HistoryEntry[];
  topups: TopupRecord[];
  /** Device-only back-room state from the vault (notes, stamps, scores). */
  local: LocalData;
  outbox: Outgoing[];
  busy: string | null;
  notice: string | null;
  error: string | null;
}

export const app = createStore<AppState>({
  link: 'linking',
  markets: [],
  series: {},
  vault: 'checking',
  wraps: [],
  balance: 0,
  positions: [],
  history: [],
  topups: [],
  local: {},
  outbox: [],
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
    app.set({ balance: 0, positions: [], history: [], topups: [], local: {}, outbox: [] });
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
  });
}

async function pollLive() {
  try {
    const live = await api.live();
    const series = { ...app.get().series };
    for (const m of live.markets) {
      if (m.price_a_ppm === null) continue;
      const s = (series[m.id] ?? []).concat({ t: live.at_ms, ours: m.price_a_ppm / 10_000, ref: m.reference.mid_ppm / 10_000 });
      series[m.id] = s.slice(-240);
    }
    app.set({ live, series });
  } catch {
    // The lamp shows the link state; a missed poll is retried.
  }
}

interface CatalogEntry {
  id: string;
  keysets: [string, string];
  end_ms: number;
  event_start_ms: number | null;
  status: { state: 'open' } | { state: 'resolved'; den: number; num: [number, number] };
  info: { question: string; outcomes: [string, string]; description: string; resolution_source: string; volume_24h_usd: number | null; group_item_title: string | null } | null;
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
      eventStartMs: m.event_start_ms,
      endMs: m.end_ms,
      keysets: m.keysets,
      resolved: m.status.state === 'resolved' ? { den: m.status.den, num: m.status.num } : null,
      volume: m.info!.volume_24h_usd,
      group: m.info!.group_item_title,
    }));
    app.set({ markets });
    refreshWallet();
  } catch {
    /* retried */
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
  let snap: Snapshot = { seq: 0, height: 0, root: '', credit_keyset: '', markets: [], issued: [], spent: [] };
  try {
    snap = await api.json<Snapshot>('/v1/snapshot/latest.json.gz');
  } catch {
    /* a fresh deployment has no snapshot yet */
  }
  const deltas: DeltaLike[] = [];
  for (let seq = 1; seq <= head.seq; seq++) deltas.push(await api.json<DeltaLike>(`/v1/delta/${seq}.json.gz`));
  onProgress?.('FINDING YOUR SLIPS');
  const r = restore(seed, config.m, { ...snap, seq: 0, markets: app.get().markets.map((m) => ({ id: m.id, keysets: m.keysets })) }, deltas, yOf);
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

export function plainError(e: ApiError): string {
  switch (e.code) {
    case 'spent':
      return 'Those slips were already spent. Nothing was taken.';
    case 'invalid_claim':
      return 'That code was already used, or the payment is not confirmed yet.';
    case 'bad_limit':
    case 'bad_amount':
      return 'That amount or price is not allowed.';
    case 'market_resolved':
      return 'This market is resolved: redeem instead.';
    case 'unavailable':
      return 'The service is busy for a moment. Nothing was spent; try again.';
    case 'proof-of-work':
      return 'The request was malformed. Nothing was spent.';
    default:
      return `Refused (${e.code}). Nothing was spent.`;
  }
}

export const actions = {
  voucher: (code: string) => act('REDEEMING CODE', (w) => w.voucher(code)),
  buy: (market: string, outcome: 0 | 1, units: number, limitBp: number) =>
    act('PRINTING', (w) => w.buy(market, outcome, units, limitBp)).then(async (r) => {
      if (r.fill.out > 0) await earnStamp('FIRST SLIP');
      return r;
    }),
  sell: (market: string, outcome: 0 | 1, units: number, limitBp: number) => act('SELLING', (w) => w.sell(market, outcome, units, limitBp)),
  redeem: (market: string, outcome: 0 | 1) => act('CASHING IN', (w) => w.redeem(market, outcome)),
  send: (keyset: string, units: number, paper = false) => act('PREPARING SLIPS', (w) => w.send(keyset, units, paper)),
  reclaim: (code: string) => act('TAKING BACK', (w) => w.reclaim(code)),
  receive: (code: string) =>
    act('TAKING OVER SLIPS', (w) => w.receiveCode(code)).then(async (n) => {
      await earnStamp('PASSED IN THE DARK');
      return n;
    }),
  /** Top-ups and withdrawals run over a separate one-off mixnet identity (the cage). */
  async topupStart(amountZat: number) {
    return act('OPENING THE CAGE', async (w) => {
      if (!config.mixnet) return w.topupStart(amountZat);
      const cage = await openCage(config.api, config.ipr);
      try {
        const cw = new Wallet(w.data, config.m, new Api(cage, powInWorkers), (d) => vault.save(d));
        return await cw.topupStart(amountZat);
      } finally {
        cage.close();
      }
    });
  },
  topupPoll: (id: string) => act('CHECKING', (w) => w.topupPoll(id)),
  async withdraw(units: number, address: string) {
    return act('WITHDRAWING', async (w) => {
      // A random 0–60 s privacy delay before sending (PROTOCOL section 1), from a separate identity.
      await new Promise((r) => setTimeout(r, config.dev ? 500 : Math.random() * 60_000));
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
