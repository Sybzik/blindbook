// The app's state and actions: transport (mixnet or dev fetch), the polls every visitor makes
// identically (head, live, catalog), the vault and the wallet.

import { Api, ApiError, DirectTransport, type Head, type Live, type PriceHistory, type Transport } from '../core/api';
import { InDoubtError, Wallet, newWalletData, type HistoryEntry, type LocalData, type MyDuel, type Outgoing, type TopupRecord, type WalletData } from '../core/wallet';
import { BLANK_OUTPUTS, blankOutputs } from '../core/blind';
import { restore, type DeltaLike } from '../core/restore';
import { SEGMENT, deltaTexts } from '../core/log';
import { yOf } from '../core/blind';
import { IdbStore, Vault, newMnemonic, seedFromMnemonic, type Wrap } from '../vault/vault';
import { createPasskey, prfSupported, unlockPasskey } from '../vault/passkey';
import { MixnetTransport, cleanupIdentities, mixnetSupported, openCage, type LinkState } from '../net/mixnet';
import { type CatalogEntry, type CatalogFile, type ChunkFile, chunksOf, toMarkets } from './catalog';
import { cue, type Cue } from './cues';
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
  /** The smallest trade and duel stake (max_trade / 200): smaller requests are refused. */
  minTrade: number;
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
  /** Why the mixnet can't link, once that's clear: this browser can't run its client (no
   *  WebAssembly: iPhone Lockdown Mode), or several rounds of tunnels in a row never answered
   *  (a network that blocks it, or Nym down). */
  linkTrouble: 'browser' | 'unreachable' | null;
  head?: Head;
  live?: Live;
  /** When the poll that brought `live` was sent (this device's clock). */
  liveSent: number;
  markets: MarketMeta[];
  /** The catalog has come at least once (an empty list then means no market is open). */
  catalogLoaded: boolean;
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
  linkTrouble: null,
  liveSent: 0,
  markets: [],
  catalogLoaded: false,
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

let syncing = false;
let syncedAt = -1;

/** The same vault may be open on another device: the public log is read once per new block. */
async function syncWallet(seq: number) {
  if (!wallet || syncing || seq === syncedAt) return;
  syncing = true;
  try {
    const { gone, found, duels, taken } = await wallet.sync();
    syncedAt = seq;
    if (taken) {
      refreshWallet();
      app.set({ notice: `${taken === 1 ? 'A code you handed over was' : `${taken} codes you handed over were`} taken over.` });
    }
    if (duels) {
      refreshWallet();
      cue('duel.taken');
      app.set({ notice: `${duels === 1 ? 'Your duel was' : `${duels} of your duels were`} taken while you were away: the shares are in your slips.` });
    }
    if (gone || found) {
      refreshWallet();
      const parts = [
        found ? `${found === 1 ? 'a slip' : `${found} slips`} this vault got on another device ${found === 1 ? 'is' : 'are'} here too` : '',
        gone ? `${gone === 1 ? 'a slip' : `${gone} slips`} spent on another device ${gone === 1 ? 'is' : 'are'} taken out` : '',
      ].filter(Boolean);
      app.set({ notice: `The same vault is open elsewhere: ${parts.join(', and ')}. Your balance is up to date.` });
    }
  } catch {
    /* read again with the next block */
  } finally {
    syncing = false;
  }
}

let settling = false;
let settledAt = -1;

/** Requests without an answer: look them up in the public log once per new block. */
async function settleDoubts(seq: number) {
  if (!wallet || settling || wallet.watching() === 0 || seq === settledAt) return;
  settling = true;
  try {
    const n = await wallet.settleDoubts();
    settledAt = seq;
    if (n > 0) {
      refreshWallet();
      app.set({ notice: `Settled from the public log: ${n === 1 ? 'a request that got no answer' : n + ' requests that got no answer'}. Your balance is up to date.` });
    }
    if (wallet.takeRedirected() > 0) {
      cue('redirected');
      app.set({
        error:
          'A request was changed on its way: the public log shows the slips it spent, and not one of the slips it asked for was signed. An honest server cannot do that. Nothing about you was revealed; the record is in your history (P600).',
      });
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
    const sent = Date.now();
    const live = await api.live();
    const series = { ...app.get().series };
    for (const m of live.markets) {
      if (m.price_a_ppm === null) continue;
      const s = (series[m.id] ?? []).concat({ t: live.at_ms, ours: m.price_a_ppm / 10_000, ref: m.reference.mid_ppm / 10_000 });
      series[m.id] = s.slice(-240);
    }
    missed = 0;
    app.set({ live, liveSent: sent, series, ...(app.get().reachable ? {} : { reachable: true }) });
    void claimDuels(live);
    void notePayouts(live);
    void pollTopups();
    void settleDoubts(live.head.seq);
    void syncWallet(live.head.seq);
  } catch {
    // The lamp shows the link state; a missed poll is retried. Three in a row: the server is out.
    if (++missed >= 3 && app.get().reachable) app.set({ reachable: false });
  }
}

/** The catalog file's markets, and the archive chunks read so far (chunk k at index k). */
let current: CatalogEntry[] = [];
const archive: CatalogEntry[][] = [];
let archiving = false;

function setCatalog() {
  const markets = toMarkets(current, archive);
  const before = new Map(app.get().markets.map((m) => [m.id, m.resolved]));
  app.set({ markets, catalogLoaded: true });
  refreshWallet();
  // A market the user holds shares of has just been settled: did their side win?
  let won = false;
  let lost = false;
  for (const m of markets) {
    if (!m.resolved || !before.has(m.id) || before.get(m.id)) continue;
    for (const p of app.get().positions.filter((x) => x.market === m.id)) {
      if (m.resolved.num[p.outcome] > 0) won = true;
      else lost = true;
    }
  }
  if (won) cue('resolved.win');
  else if (lost) cue('resolved.loss');
}

async function pollCatalog() {
  try {
    const file = await api.json<CatalogFile>('/v1/catalog.json.gz');
    if (!Array.isArray(file?.markets)) return;
    const chunks = chunksOf(file);
    // A server whose archive is shorter than the one read here has started over: read it again.
    if (chunks < archive.length) archive.length = 0;
    current = file.markets;
    setCatalog();
    void readArchive(chunks);
  } catch {
    /* retried */
  }
}

/** Read the archive chunks not read yet, one at a time and in order (a chunk never changes). */
async function readArchive(chunks: number) {
  if (archiving) return;
  archiving = true;
  try {
    while (archive.length < chunks) {
      const file = await api.json<ChunkFile>(`/v1/settled/${archive.length}.json.gz`);
      if (!Array.isArray(file?.markets)) return;
      archive.push(file.markets);
      setCatalog();
    }
  } catch {
    /* the next catalog poll goes on from here */
  } finally {
    archiving = false;
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

let mixnet: MixnetTransport | undefined;
const startedAt = Date.now();
/** For the console's status: how long the link has been tried, failed rounds, the last reason. */
export function linkInfo(): { seconds: number; rounds: number; lastError: string | null } | null {
  return mixnet ? { seconds: Math.round((Date.now() - startedAt) / 1000), rounds: mixnet.rounds, lastError: mixnet.lastError } : null;
}

/** Connect and begin the polls every visitor makes; safe to call more than once. */
export async function start() {
  if (started) return;
  started = true;
  if (config.mixnet) {
    await cleanupIdentities();
    const mt = new MixnetTransport(config.api, config.ipr, (yes) => {
      app.set({ linkTrouble: yes ? 'unreachable' : null });
      if (yes) cue('link.trouble');
    });
    mt.onState((s) => {
      const was = app.get().link;
      app.set({ link: s });
      if (s === was) return;
      if (s === 'linked') cue('link.linked');
      else if (s === 'down') cue('link.down');
      else if (s === 'relinking' && was === 'linked') cue('link.relinking');
    });
    transport = mt;
    mixnet = mt;
    // Back from the background (from the wallet app, say): check the link at once.
    let hiddenAt = 0;
    const phone = matchMedia('(pointer: coarse)').matches;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt) {
        const away = Date.now() - hiddenAt;
        hiddenAt = 0;
        void mt.wake(away, phone);
        // A top-up's own route slept too: the next poll opens a fresh one instead of waiting it out.
        if (away >= 8_000 && phone) {
          cages.forEach((c) => c.close());
          cages.clear();
        }
      }
    });
    api = new Api(transport, powInWorkers);
    if (mixnetSupported()) void mt.boot();
    else app.set({ link: 'down', linkTrouble: 'browser' });
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
  // A new vault replaces the one on this device: another tab that has it open locks first.
  await holdVault(true);
  const data = newWalletData(seedFromMnemonic(words));
  data.mnemonic = words;
  data.local = { backedUp };
  await vault.create(data, passphrase ?? undefined);
  if (passkey) await addPasskey();
  app.set({ wraps: await vault.wraps() });
  openWallet(data);
  cue('vault.created');
}

export async function addPasskey(): Promise<boolean> {
  if (!prfSupported()) return false;
  const p = await createPasskey();
  if (!p) return false;
  await vault.addPrf(p.credential, p.salt, p.prf);
  app.set({ wraps: await vault.wraps() });
  return true;
}

/** One tab at a time keeps the vault open: two would each save their own copy over the other's
 *  and could ask for the same outputs. A Web Lock marks the tab that has it open; a tab that opens
 *  it anyway asks that one to lock first (BroadcastChannel). */
const TAB_LOCK = 'blindbook-vault';
const tabs = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(TAB_LOCK);
let releaseTab: (() => void) | undefined;
tabs?.addEventListener('message', (e: MessageEvent) => {
  if (e.data !== 'take') return;
  if (!wallet) return letGoOfVault();
  lockVault();
  app.set({ notice: 'The vault was opened in another tab of this browser, so it is locked here.' });
});

export class VaultElsewhereError extends Error {
  constructor() {
    super('The vault is open in another tab of this browser. Use it there, or open it here and that tab locks.');
  }
}

/** Hold the vault for this tab. Without `take` it refuses while another tab has it open; with it,
 *  that tab is asked to lock, for up to 5 s (a tab asleep in the background can't answer). */
async function holdVault(take: boolean): Promise<void> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || releaseTab) return;
  await new Promise<void>((resolve, reject) => {
    const abort = new AbortController();
    const timer = take ? setTimeout(() => abort.abort(), 5_000) : undefined;
    locks
      .request(TAB_LOCK, take ? { signal: abort.signal } : { ifAvailable: true }, (lock) => {
        clearTimeout(timer);
        if (!lock) return reject(new VaultElsewhereError());
        resolve();
        return new Promise<void>((r) => (releaseTab = r));
      })
      .catch(() => reject(new Error('The other tab did not let go of the vault. Close it, then try again.')));
    if (take) tabs?.postMessage('take');
  });
}

function letGoOfVault() {
  releaseTab?.();
  releaseTab = undefined;
}

/** Open the vault in this tab: hold it first, let go if opening fails (a wrong passphrase). */
async function openHere(take: boolean, open: () => Promise<WalletData>) {
  await holdVault(take);
  try {
    openWallet(await open());
  } catch (e) {
    letGoOfVault();
    throw e;
  }
}

export async function unlockWithPassphrase(passphrase: string, take = false) {
  await openHere(take, async () => (await vault.unlockWithPassphrase(passphrase)) as WalletData);
  cue('vault.unlocked');
}

export async function unlockWithPasskey(take = false) {
  const w = app.get().wraps.find((x) => x.kind === 'prf');
  if (!w?.credential) throw new Error('no passkey on this device');
  await openHere(take, async () => {
    const prf = await unlockPasskey(w.credential!, w.salt);
    if (!prf) throw new Error('the passkey did not unlock');
    return (await vault.unlockWithPrf(prf)) as WalletData;
  });
  cue('vault.unlocked');
}

export function lockVault() {
  letGoOfVault();
  vault.lock();
  wallet = undefined;
  refreshWallet();
  app.set({ vault: 'locked' });
  cue('vault.locked');
}

/** Rebuild a vault from 12 words with zero-query restore over the public files. */
export async function restoreFromWords(words: string, passphrase: string | null, onProgress?: (s: string) => void) {
  const seed = seedFromMnemonic(words);
  await holdVault(true);
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
  data.syncedSeq = head.seq;
  data.scanFrom = Object.fromEntries(Object.entries(r.counters).map(([id, c]) => [id, c - BLANK_OUTPUTS]));
  data.counters = r.counters;
  data.calledNext = r.calledNext;
  await vault.create(data, passphrase ?? undefined);
  app.set({ wraps: await vault.wraps() });
  openWallet(data);
  cue('vault.restored');
  return r;
}

/** Refused at once: another action is still running (a second tap that came before the screen
 *  could disable the key). Nothing is sent and nothing is shown. */
export class StillBusy extends Error {}

async function act<T>(label: string, f: (w: Wallet) => Promise<T>): Promise<T> {
  if (!wallet) throw new Error('unlock the vault first');
  // One action at a time, decided here and not by the key's disabled state, which a burst of taps
  // can beat: ten quick REDEEMs spend the code once.
  if (app.get().busy) throw new StillBusy('another action is still running');
  app.set({ busy: label, error: null });
  try {
    const out = await f(wallet);
    refreshWallet();
    return out;
  } catch (e) {
    const pruned = e instanceof ApiError && e.code === 'spent' ? wallet.takePruned() : 0;
    const msg = pruned
      ? `Slips in this vault had been spent already: by this vault open on another device, or by a request whose answer never came. They are set aside and your balance is updated (the next block confirms it). Nothing was taken; try again.`
      : e instanceof ApiError
        ? label === 'WITHDRAWING' && e.code === 'invalid_slip'
          ? "The signer refused this withdrawal: it pays only a shielded unified address of this network (an Orchard-protocol receiver). Check the address. Nothing was taken."
          : plainError(e)
        : String((e as Error)?.message ?? e);
    if (pruned) refreshWallet();
    app.set({ error: msg });
    cue(e instanceof InDoubtError ? 'doubt' : e instanceof ApiError ? 'refused' : 'error');
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
  invalid_claim: 'That code is used up or unknown, or the payment is not confirmed yet.',
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
  too_small: 'That is below the smallest trade this market takes. Nothing was spent.',
  duels_full: 'The duel board is full right now. Nothing was spent; try again once one is taken or cancelled.',
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
      const rec = await w.topupPoll(t.id).catch((e: unknown) => {
        // A cage whose route stopped answering is replaced by a fresh one on the next tick (a new
        // identity, still not the betting one).
        cages.get(t.id)?.close();
        cages.delete(t.id);
        throw e;
      });
      if (rec.status === 'credited' || rec.status === 'confirmed') {
        cages.get(t.id)?.close();
        cages.delete(t.id);
        cue('credit');
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
    cue('payout');
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
    cue('duel.taken');
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

/** Pass a result through, sounding its cue on the way. */
const after =
  (c: Cue) =>
  <T>(v: T): T => {
    cue(c);
    return v;
  };

export const actions = {
  voucher: (code: string) => act('REDEEMING CODE', (w) => w.voucher(code)).then(after('credit')),
  buy: (market: string, outcome: 0 | 1, units: number, limitBp: number) =>
    act('PRINTING', async (w) => {
      await mixWait();
      cue('bet.sent');
      return w.buy(market, outcome, units, limitBp);
    }).then(async (r) => {
      cue(r.fill.out === 0 ? 'bet.unfilled' : r.fill.status === 'shrunk' ? 'bet.partial' : 'bet.filled');
      if (r.fill.out > 0) await earnStamp('FIRST SLIP');
      return r;
    }),
  sell: (market: string, outcome: 0 | 1, units: number, limitBp: number) =>
    act('SELLING', async (w) => {
      await mixWait();
      return w.sell(market, outcome, units, limitBp);
    }).then(after('sell.filled')),
  redeem: (market: string, outcome: 0 | 1) => act('CASHING IN', (w) => w.redeem(market, outcome)).then(after('cashin')),
  send: (keyset: string, units: number, paper = false) => act('PREPARING SLIPS', (w) => w.send(keyset, units, paper)).then(after('slip.sent')),
  reclaim: (code: string) => act('TAKING BACK', (w) => w.reclaim(code)).then(after('slip.back')),
  duelOpen: (market: string, outcome: 0 | 1, shares: number, priceBp: number) => act('OPENING THE DUEL', (w) => w.duelOpen(market, outcome, shares, priceBp)).then(after('duel.opened')),
  duelTake: (d: { duel: string; market: string; outcome: 0 | 1; shares: number; price_bp: number; stake: number }) => act('TAKING THE DUEL', (w) => w.duelTake(d)).then(after('duel.taken')),
  duelCancel: (duel: string) => act('CANCELLING', (w) => w.duelCancel(duel)).then(after('duel.cancelled')),
  receive: (code: string) =>
    act('TAKING OVER SLIPS', (w) => w.receiveCode(code)).then(async (n) => {
      cue('slip.received');
      await earnStamp('PASSED IN THE DARK');
      return n;
    }),
  /** A top-up runs over its own mixnet identity (a cage), kept until it is credited: the
   *  betting tunnel never touches it. */
  async topupStart(amountZat: number) {
    return act('OPENING THE CAGE', async (w) => {
      if (!config.mixnet) return w.topupStart(amountZat).then(after('topup.opened'));
      const cage = await openCage(config.api, config.ipr);
      try {
        const rec = await new Wallet(w.data, config.m, new Api(cage, powInWorkers), (d) => vault.save(d)).topupStart(amountZat);
        cages.set(rec.id, cage);
        cue('topup.opened');
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
      if (!config.mixnet) return w.withdraw(units, address, config.sealPk).then(after('withdraw.sent'));
      const cage = await openCage(config.api, config.ipr);
      try {
        const cw = new Wallet(w.data, config.m, new Api(cage, powInWorkers), (d) => vault.save(d));
        return await cw.withdraw(units, address, config.sealPk).then(after('withdraw.sent'));
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
