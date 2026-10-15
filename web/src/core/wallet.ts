// The slip wallet: everything a user owns is a set of slips in the vault (bearer e-cash). This
// module runs the operations; the vault (vault/) keeps WalletData encrypted at rest.
//
// Counters for deterministic outputs are reserved and saved BEFORE a request leaves, so a crash
// can never reuse them, and zero-query restore (restore.ts) finds every signed output again.
//
// Every spending request is recorded as in flight before it leaves. If no answer comes back (a
// mixnet route died, a deadline passed, the server answered 5xx), the request may still have
// been processed: its slips are held back, and settleDoubts() reads the public log (the same
// segments every verifier reads, so the server can't tell what we look for) until it finds our
// outputs signed, sees our slips spent, or sees enough blocks pass without either. A request given
// up on stays watched for a while longer: if its outputs turn up signed after all, they are ours
// and the slips it spent leave the wallet.
//
// The same 12 words may be open on another device. sync() reads each new block of the log: slips
// spent there leave, slips signed there come in, and the counters move past the other device's
// outputs, so the two never ask for the same outputs.

import { fromHex, toHex, randomBytes } from './bytes';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from './bytes';
import { type Pending, type Proof, type SignatureOut, BLANK_OUTPUTS, blankOutputs, deriveOutput, makeOutputs, receive, split, yOf } from './blind';
import { type Keyset, creditKeyset, outcomeKeyset } from './keysets';
import { calledItSecret, calledItTag, decodeSlips, encodeSlips } from './codes';
import { seal } from './seal';
import { ApiError, type Api, type FillRecord } from './api';
import { deltaTexts } from './log';
import { GAP, type DeltaLike } from './restore';
import { short, trace } from './trace';

export interface HistoryEntry {
  at_ms: number;
  kind: 'voucher' | 'topup' | 'buy' | 'sell' | 'redeem' | 'withdraw' | 'receive' | 'send' | 'duel_open' | 'duel_take' | 'duel_cancel' | 'duel_won';
  /** What the server stored about it (P600 "what we know"). */
  stored: Record<string, unknown>;
  /** For trades: the called-it secret index and the market/outcome. */
  called?: { index: number; tag: string; market: string; outcome: 0 | 1 };
  fill?: FillRecord;
}

export interface TopupRecord {
  id: string;
  amount_zat: number;
  address: string;
  expires_height: number;
  secret: string;
  counter: number;
  status: string;
  privacy?: string | null;
}

export interface WalletData {
  v: 1;
  /** 64-byte BIP 39 seed, hex: the root of every secret. */
  seed: string;
  /** The 12 words themselves, so an unlocked vault can show them again for a backup. */
  mnemonic?: string;
  /** Next NUT-13 counter per keyset id. */
  counters: Record<string, number>;
  calledNext: number;
  slips: Proof[];
  history: HistoryEntry[];
  topups: TopupRecord[];
  /** Back-room state that never leaves the device: dead-drop notes, NOBODY PASS stamps, scores. */
  local?: LocalData;
  /** Codes we handed over (or printed) and nobody has taken over yet: they can be taken back. */
  outbox?: Outgoing[];
  /** Blind duels we opened: the counter of the blank outputs left for our shares, the cancel
   *  secret, and where it stands. */
  duels?: MyDuel[];
  /** Spending requests sent and not settled yet (see the top of this file). */
  inflight?: InFlight[];
  /** Requests given up on (their slips came back), still looked for in the log for a while. */
  released?: InFlight[];
  /** For each slip (by secret), a head seq from before it was signed: it can only be spent later.
   *  Kept in the vault only, never sent anywhere. */
  slipSeq?: Record<string, number>;
  /** The log was read up to this head seq: slips without an entry above were unspent then, and
   *  every output signed for this seed up to it is known (see sync()). */
  syncedSeq?: number;
  /** Per keyset, the counter from which outputs of another device with these words may appear,
   *  and the counter ranges this device took since (its own: skipped when reading the log). */
  scanFrom?: Record<string, number>;
  own?: Record<string, [number, number][]>;
}

/** A range of our deterministic outputs a request asked to have signed. */
export interface OutRange {
  /** Outcome keyset (market and outcome), or CREDIT when absent. */
  market?: string;
  outcome?: 0 | 1;
  counter: number;
  n: number;
}

export interface InFlight {
  id: string;
  at_ms: number;
  /** The log's head seq when it left, as last seen: a processed request shows up in a later delta. */
  seq: number;
  /** The head seq first read after the answer failed to come. That one is current, so the wait
   *  for a trace counts from it (`seq` may be older than the head when the request left). */
  wait_from?: number;
  /** Given up on at this head seq: its slips are ours again, and its outputs are looked for until
   *  RECHECK_BLOCKS later. */
  released_at?: number;
  /** A duel offer given up on: kept, cancel secret and all, in case it opened after all. */
  parked?: MyDuel;
  /** Slips it spends (ours, or a code we take over). */
  inputs: Proof[];
  outs: OutRange[];
  entry: HistoryEntry;
  /** No answer: settled from the public log. */
  doubt: boolean;
  /** A duel opened or cancelled by it; a code taken over (or back) by it. */
  duel?: { id: string; action: 'open' | 'cancel' };
  code?: string;
}

/** A request left and no answer came back: it may or may not have gone through. */
export class InDoubtError extends Error {
  constructor() {
    super('No answer from the server yet. If it went through, the result appears here by itself within a few blocks; if not, your slips come back. Nothing is lost.');
  }
}

/** Published blocks (log deltas) after which a request that left no trace never went through. An
 *  empty block is published at least every 4th chain block, so this is at most about 12 blocks. */
const SETTLE_BLOCKS = 3;

/** Published blocks after giving up during which a request's outputs are still looked for. */
const RECHECK_BLOCKS = 20;

export interface MyDuel {
  duel: string;
  market: string;
  outcome: 0 | 1;
  shares: number;
  price_bp: number;
  stake: number;
  keyset: string;
  counter: number;
  secret: string;
  at_ms: number;
  /** When the server confirmed the offer (this device's clock). */
  opened_ms?: number;
  status: 'open' | 'taken' | 'cancelled';
}

export interface Outgoing {
  code: string;
  at_ms: number;
  id: string;
  amount: number;
  paper: boolean;
}

export interface LocalData {
  /** The 12 words were confirmed by stamping (or the vault was restored from them). */
  backedUp?: boolean;
  notes?: string;
  stamps?: string[];
  best?: Record<string, number>;
  /** Our withdrawals seen paid: commitment → payout txid. */
  paid?: Record<string, string>;
}

export function newWalletData(seed: Uint8Array): WalletData {
  return { v: 1, seed: toHex(seed), counters: {}, calledNext: 0, slips: [], history: [], topups: [] };
}

/** Pick slips covering `amount` with few inputs; null if the balance is short. */
export function select(slips: Proof[], amount: number, max = 64): Proof[] | null {
  const sorted = [...slips].sort((a, b) => b.amount - a.amount);
  if (sorted.reduce((s, p) => s + p.amount, 0) < amount) return null;
  const chosen: Proof[] = [];
  let rem = amount;
  for (const s of sorted) {
    if (rem <= 0) break;
    if (s.amount <= rem) {
      chosen.push(s);
      rem -= s.amount;
    }
  }
  if (rem > 0) {
    const rest = sorted.filter((s) => !chosen.includes(s)).sort((a, b) => a.amount - b.amount);
    const one = rest.find((s) => s.amount >= rem);
    if (one) chosen.push(one);
    else
      for (const s of rest.reverse()) {
        chosen.push(s);
        rem -= s.amount;
        if (rem <= 0) break;
      }
  }
  return chosen.length <= max ? chosen : null;
}

export class Wallet {
  readonly seed: Uint8Array;
  readonly credit: Keyset;
  /** Keysets we derived ourselves: CREDIT and both outcomes of every market we know. */
  private known = new Map<string, Keyset>();

  constructor(
    public data: WalletData,
    public readonly m: string,
    private api: Api,
    private save: (d: WalletData) => Promise<void>,
  ) {
    this.seed = fromHex(data.seed);
    this.credit = creditKeyset(m);
    this.known.set(this.credit.id, this.credit);
  }

  keysetOf(market: string, outcome: 0 | 1): Keyset {
    const ks = outcomeKeyset(this.m, market, outcome);
    this.known.set(ks.id, ks);
    return ks;
  }

  /** Derive both outcome keysets of a listed market. */
  registerMarket(market: string): [Keyset, Keyset] {
    return [this.keysetOf(market, 0), this.keysetOf(market, 1)];
  }

  keysetById(id: string): Keyset | undefined {
    return this.known.get(id);
  }

  /** Slips held back by requests in flight. */
  private locked(): Set<string> {
    return new Set((this.data.inflight ?? []).flatMap((f) => f.inputs.map((p) => p.secret)));
  }

  /** Our spendable slips of a keyset. */
  private free(id: string): Proof[] {
    const held = this.locked();
    return this.data.slips.filter((s) => s.id === id && !held.has(s.secret) && !this.aside.has(s.secret));
  }

  /** Slips refused as spent that the log doesn't show spent yet (the spend is in the block being
   *  built), by the head seq of the refusal: kept out of new requests until the log is read two
   *  blocks past it; sync() takes out the ones it shows spent. */
  private aside = new Map<string, number>();

  balance(id: string): number {
    return this.free(id).reduce((n, s) => n + s.amount, 0);
  }

  /** Requests whose outcome is being looked up in the public log. */
  inDoubt(): number {
    return (this.data.inflight ?? []).filter((f) => f.doubt).length;
  }

  /** Send a spending request as in flight: settled here on an answer, held as in doubt without. */
  private async tracked<T>(inputs: Proof[], outs: OutRange[], entry: HistoryEntry, call: () => Promise<T>, extra: Pick<InFlight, 'duel' | 'code'> = {}): Promise<T> {
    // The log's head before it leaves (a fresh transport, like a cage, asks for it once).
    const seq = this.api.seq || (await this.api.head().then((h) => h.seq, () => 0));
    const f: InFlight = { id: toHex(randomBytes(8)), at_ms: Date.now(), seq, inputs, outs, entry, doubt: false, ...extra };
    this.data.inflight = [...(this.data.inflight ?? []), f];
    await this.save(this.data);
    const drop = () => {
      this.data.inflight = (this.data.inflight ?? []).filter((x) => x.id !== f.id);
    };
    try {
      const r = await call();
      drop();
      return r;
    } catch (e) {
      // A refusal (4xx) happens before anything is spent; anything else may have gone through.
      if (e instanceof ApiError && e.status < 500) {
        drop();
        this.disown(outs);
        await this.save(this.data);
        const ours = inputs.filter((p) => this.data.slips.some((s) => s.secret === p.secret));
        if (e.code === 'spent' && ours.length && (await this.pruneSpent(ours).catch(() => 0)) === 0) {
          for (const p of ours) this.aside.set(p.secret, this.api.seq);
          this.pruned += ours.length;
        }
        throw e;
      }
      f.doubt = true;
      await this.save(this.data);
      trace(() => `doubt  no answer · ${inputs.length} slips held back until the public log shows what happened`);
      throw new InDoubtError();
    }
  }

  /** Settle requests in doubt from the public log; returns how many were settled. */
  /** Requests settled since the last call whose slips were spent while not one of the outputs
   *  they asked for was signed (THREAT_MODEL I12). */
  private redirected = 0;

  takeRedirected(): number {
    const n = this.redirected;
    this.redirected = 0;
    return n;
  }

  /** Slips taken out (or set aside) since the last call because they are spent already. */
  private pruned = 0;

  takePruned(): number {
    const n = this.pruned;
    this.pruned = 0;
    return n;
  }

  /**
   * A request was refused because a slip it spent is spent already: by this vault open on another
   * device, or by a request whose answer never came and that went through after we gave up on it.
   * The public log, read as every verifier reads it (so the server can't tell what we look for),
   * shows which of our slips are spent since the oldest refused one was signed; they leave the
   * wallet, so the next request doesn't pick them again.
   */
  private async pruneSpent(refused: Proof[]): Promise<number> {
    const head = await this.api.head();
    const seqs = this.data.slipSeq ?? {};
    const base = this.data.syncedSeq ?? 0;
    const since = (p: Proof) => seqs[p.secret] ?? base;
    const from = Math.min(...refused.map(since)) + 1;
    if (from > head.seq) return 0;
    const spent = new Set<string>();
    for (const t of await deltaTexts(this.api, from, head.seq, head.seq)) {
      for (const s of (JSON.parse(t) as { spent: { Y: string }[] }).spent) spent.add(s.Y);
    }
    // A slip is spent once: any of ours in there is gone, whenever it was signed.
    const gone = new Set(this.data.slips.filter((s) => spent.has(yOf(s.secret))).map((s) => s.secret));
    if (gone.size === 0) return 0;
    this.data.slips = this.data.slips.filter((s) => !gone.has(s.secret));
    this.data.slipSeq = Object.fromEntries(Object.entries(seqs).filter(([k]) => !gone.has(k)));
    for (const k of gone) this.aside.delete(k);
    await this.save(this.data);
    this.pruned += gone.size;
    trace(() => `spent  ${gone.size} of our slips are spent in the public log already: taken out`);
    return gone.size;
  }

  /** A refused request got nothing signed: its counter ranges are no longer ours to skip (another
   *  device with these words may use them, and its outputs there are to be found). */
  private disown(outs: OutRange[]) {
    for (const o of outs) {
      const id = o.market === undefined ? this.credit.id : this.keysetOf(o.market, o.outcome ?? 0).id;
      const own = this.data.own?.[id];
      if (own) this.data.own![id] = own.filter(([a]) => a !== o.counter);
    }
  }

  /** Our outputs, derived once (sync() reads the same counters block after block). */
  private derivedCache = new Map<string, Pending>();

  private derive(id: string, counter: number): Pending {
    const key = `${id}:${counter}`;
    let p = this.derivedCache.get(key);
    if (!p) {
      p = deriveOutput(this.seed, id, counter);
      this.derivedCache.set(key, p);
    }
    return p;
  }

  /** The first sync after opening, or after a pause: new requests wait for it (reserve()). */
  private catchingUp?: Promise<unknown>;
  private lastSync = 0;

  /**
   * Read the public log since the last look (`syncedSeq`), for these 12 words open on another
   * device: our slips spent there leave; slips signed for this seed there come in (derived from the
   * same seed, they are ours), and the counters move past its outputs with a margin for a request
   * of its still in flight. Read like every verifier reads the log, so the server can't tell.
   */
  async sync(): Promise<{ gone: number; found: number }> {
    const run = this.syncNow();
    if (Date.now() - this.lastSync > 120_000) this.catchingUp = run;
    try {
      const r = await run;
      this.lastSync = Date.now();
      return r;
    } finally {
      if (this.catchingUp === run) this.catchingUp = undefined;
    }
  }

  private async syncNow(): Promise<{ gone: number; found: number }> {
    const head = await this.api.head();
    if (this.data.syncedSeq === undefined) {
      // Made here, or before this was kept: nothing to catch up on.
      this.data.syncedSeq = head.seq;
      await this.save(this.data);
      return { gone: 0, found: 0 };
    }
    const from = this.data.syncedSeq + 1;
    if (from > head.seq) return { gone: 0, found: 0 };
    return this.readSince(from, head.seq);
  }

  private async readSince(from: number, to: number): Promise<{ gone: number; found: number }> {
    const deltas = (await deltaTexts(this.api, from, to, to)).map((t) => JSON.parse(t) as DeltaLike);
    const spent = new Set(deltas.flatMap((d) => d.spent.map((s) => s.Y)));
    const issued = new Map(deltas.flatMap((d) => d.issued).map((r) => [r.B_, r]));
    // Outputs at counters this device didn't take: another device's. Read from where one may appear
    // (past the last one seen), skipping our own ranges.
    const found: Proof[] = [];
    const scanFrom = (this.data.scanFrom ??= {});
    const ownAll = (this.data.own ??= {});
    for (const id of new Set([...issued.values()].map((r) => r.id))) {
      const ks = this.known.get(id);
      if (!ks) continue;
      const own = ownAll[id] ?? [];
      const start = scanFrom[id] ?? this.data.counters[id] ?? 0;
      let misses = 0;
      let last = -1;
      for (let c = start; misses < GAP; c++) {
        const mine = own.find(([a, b]) => c >= a && c < b);
        if (mine) {
          c = mine[1] - 1;
          continue;
        }
        const p = this.derive(id, c);
        const r = issued.get(p.B_);
        if (!r) {
          misses++;
          continue;
        }
        misses = 0;
        last = c;
        try {
          const [proof] = receive([{ list: 'outputs', index: 0, amount: r.amount, id: r.id, C_: r.C_, dleq: r.dleq }], { outputs: [p] }, this.keysets(ks));
          if (proof && !spent.has(yOf(proof.secret))) found.push(proof);
        } catch {
          /* a signature that fails its check is no slip of ours */
        }
      }
      if (last >= 0) {
        // Past its outputs, with a margin for a request of its still in flight; and the next read
        // starts right after its last one.
        this.data.counters[id] = Math.max(this.data.counters[id] ?? 0, last + 1 + BLANK_OUTPUTS);
        scanFrom[id] = Math.max(start, last + 1);
        ownAll[id] = own.filter(([, b]) => b > scanFrom[id]!);
      } else scanFrom[id] = start;
    }
    // Called-it indices used there: ours continue after them, so no two bets share a tag.
    const tags = new Set(deltas.flatMap((d) => (d.batches ?? []).flatMap((b) => b.orders.map((o) => o.tag))));
    if (tags.size) {
      for (let i = this.data.calledNext, misses = 0; misses < 64; i++) {
        if (tags.has(calledItTag(calledItSecret(this.seed, i)))) {
          this.data.calledNext = i + 1;
          misses = 0;
        } else misses++;
      }
    }
    // Spent there: out (not the slips of our own requests still in flight; they settle as usual).
    const held = this.locked();
    const gone = spent.size ? new Set(this.data.slips.filter((s) => !held.has(s.secret) && spent.has(yOf(s.secret))).map((s) => s.secret)) : new Set<string>();
    const have = new Set(this.data.slips.map((s) => s.secret));
    const fresh = found.filter((p) => !have.has(p.secret));
    this.data.slips = this.data.slips.filter((s) => !gone.has(s.secret)).concat(fresh);
    const seqs = Object.fromEntries(Object.entries(this.data.slipSeq ?? {}).filter(([k]) => !gone.has(k)));
    for (const p of fresh) seqs[p.secret] = from - 1;
    this.data.slipSeq = seqs;
    this.data.syncedSeq = Math.max(this.data.syncedSeq ?? 0, to);
    for (const [k, at] of this.aside) if (gone.has(k) || at + 2 <= to) this.aside.delete(k);
    await this.save(this.data);
    if (gone.size || fresh.length) trace(() => `sync   blocks ${from}–${to}: ${gone.size} of our slips spent elsewhere, ${fresh.length} signed elsewhere for these words`);
    return { gone: gone.size, found: fresh.length };
  }

  /** Requests the public log is still read for: in doubt, or given up on lately. */
  watching(): number {
    return this.inDoubt() + (this.data.released ?? []).length;
  }

  async settleDoubts(): Promise<number> {
    const doubts = (this.data.inflight ?? []).filter((f) => f.doubt);
    const late = this.data.released ?? [];
    if (doubts.length === 0 && late.length === 0) return 0;
    const head = await this.api.head();
    const fresh = doubts.filter((d) => d.wait_from === undefined);
    for (const d of fresh) d.wait_from = head.seq;
    if (fresh.length) await this.save(this.data);
    const from = Math.min(...[...doubts, ...late].map((d) => d.seq)) + 1;
    if (from > head.seq) return 0;
    const deltas = (await deltaTexts(this.api, from, head.seq, head.seq)).map(
      (t) => JSON.parse(t) as { seq: number; issued: { id: string; amount: number; B_: string; C_: string; dleq: { e: string; s: string } }[]; spent: { Y: string }[] },
    );
    /** Our outputs the log shows signed after the request left, and whether its slips were spent. */
    const traceOf = (d: InFlight) => {
      const after = deltas.filter((x) => x.seq > d.seq);
      const issued = new Map(after.flatMap((x) => x.issued).map((r) => [r.B_, r]));
      const spent = new Set(after.flatMap((x) => x.spent.map((s) => s.Y)));
      const got: Proof[] = [];
      for (const o of d.outs) {
        const ks = o.market === undefined ? this.credit : this.keysetOf(o.market, o.outcome ?? 0);
        const pending: Pending[] = Array.from({ length: o.n }, (_, i) => deriveOutput(this.seed, ks.id, o.counter + i));
        const sigs: SignatureOut[] = [];
        pending.forEach((p, index) => {
          const r = issued.get(p.B_);
          if (r) sigs.push({ list: 'outputs', index, amount: r.amount, id: r.id, C_: r.C_, dleq: r.dleq });
        });
        if (sigs.length) got.push(...receive(sigs, { outputs: pending }, this.keysets(ks)));
      }
      return { got, inputsSpent: d.inputs.some((p) => spent.has(yOf(p.secret))) };
    };
    /** A request that went through: what it changed, then its slips out and its outputs in. */
    const wentThrough = async (d: InFlight, got: Proof[], stored: Record<string, unknown>) => {
      if (d.parked) this.data.duels = [...(this.data.duels ?? []).filter((x) => x.duel !== d.parked!.duel), { ...d.parked, opened_ms: d.parked.opened_ms ?? Date.now() }];
      if (d.duel?.action === 'cancel') this.data.duels = (this.data.duels ?? []).map((x) => (x.duel === d.duel!.id ? { ...x, status: 'cancelled' as const } : x));
      if (d.code) this.data.outbox = (this.data.outbox ?? []).filter((o) => o.code !== d.code);
      await this.commit(d.inputs, got, { ...d.entry, at_ms: Date.now(), stored: { ...d.entry.stored, ...stored, recovered_from_log: true } }, d.seq);
    };
    let settled = 0;
    for (const d of doubts) {
      const { got, inputsSpent } = traceOf(d);
      const through = got.length > 0 || inputsSpent;
      if (!through && head.seq < (d.wait_from ?? head.seq) + SETTLE_BLOCKS) continue;
      this.data.inflight = (this.data.inflight ?? []).filter((x) => x.id !== d.id);
      // Spent, yet not one of the outputs it asked for signed: the signer signs them in the same
      // batch (a duel's shares come at the take), so the request was changed on its way.
      const redirected = through && got.length === 0 && d.outs.some((o) => o.n > 0) && d.duel?.action !== 'open';
      if (redirected) {
        this.redirected++;
        d.entry = { ...d.entry, stored: { ...d.entry.stored, outputs_never_signed: true } };
        trace(() => `doubt  ALARM: the slips were spent but none of the requested outputs was signed`);
      }
      if (through) {
        await wentThrough(d, got, {});
        trace(() => `doubt  settled from the public log: it went through · ${got.length} slips recovered`);
      } else {
        // No trace: the slips are ours again, and a duel that never opened leaves the list. Its
        // outputs are still looked for a while (only they tell: its slips may be spent again).
        const parked = d.duel?.action === 'open' ? this.data.duels?.find((x) => x.duel === d.duel!.id) : undefined;
        if (parked) this.data.duels = (this.data.duels ?? []).filter((x) => x.duel !== parked.duel);
        if (d.outs.some((o) => o.n > 0)) this.data.released = [...(this.data.released ?? []), { ...d, released_at: head.seq, parked }];
        await this.save(this.data);
        trace(() => `doubt  settled from the public log: it never went through · slips released`);
      }
      settled++;
    }
    for (const d of late) {
      const { got } = traceOf(d);
      if (got.length > 0) {
        // It went through after all, after its slips came back: they are spent, its outputs ours.
        this.data.released = (this.data.released ?? []).filter((x) => x.id !== d.id);
        await wentThrough(d, got, { went_through_late: true });
        trace(() => `doubt  a request given up on went through after all · ${got.length} slips recovered`);
        settled++;
      } else if (head.seq >= (d.released_at ?? 0) + RECHECK_BLOCKS) {
        this.data.released = (this.data.released ?? []).filter((x) => x.id !== d.id);
        await this.save(this.data);
      }
    }
    return settled;
  }

  creditBalance(): number {
    return this.balance(this.credit.id);
  }

  /** Update the device-only back-room state and persist it inside the vault. */
  async setLocal(patch: Partial<LocalData>) {
    this.data.local = { ...this.data.local, ...patch };
    await this.save(this.data);
  }

  /** Reserve `n` counters for a keyset and persist the reservation before use. */
  private async reserve(id: string, n: number): Promise<number> {
    // Reopened after a while: the counters wait for the log to be read up to now (another device
    // with these words may have used the next ones meanwhile).
    if (this.catchingUp) await this.catchingUp.catch(() => undefined);
    const start = this.data.counters[id] ?? 0;
    this.data.counters[id] = start + n;
    // Ours, so sync() never takes them for another device's.
    const scanFrom = (this.data.scanFrom ??= {});
    scanFrom[id] ??= start;
    const own = (this.data.own ??= {});
    own[id] = [...(own[id] ?? []), [start, start + n]];
    await this.save(this.data);
    return start;
  }

  private async blank(ks: Keyset) {
    const start = await this.reserve(ks.id, BLANK_OUTPUTS);
    return blankOutputs(this.seed, ks.id, start);
  }

  private keysets(...ks: Keyset[]): Map<string, Keyset> {
    return new Map(ks.map((k) => [k.id, k]));
  }

  /** Spent slips out, new ones in. `seq`: a head seq from before the new ones were signed (null:
   *  not known, so a later look-up for them reads from `syncedSeq`). */
  private async commit(spent: Proof[], got: Proof[], entry: HistoryEntry, seq: number | null = this.api.seq) {
    const gone = new Set(spent.map((p) => p.secret));
    this.data.slips = this.data.slips.filter((s) => !gone.has(s.secret)).concat(got);
    const seqs = Object.fromEntries(Object.entries(this.data.slipSeq ?? {}).filter(([k]) => !gone.has(k)));
    if (seq !== null) for (const p of got) seqs[p.secret] = seq;
    this.data.slipSeq = seqs;
    this.data.history.push(entry);
    await this.save(this.data);
  }

  async voucher(code: string): Promise<number> {
    const counter = await this.reserve(this.credit.id, BLANK_OUTPUTS);
    const out = blankOutputs(this.seed, this.credit.id, counter);
    const r = await this.tracked([], [{ counter, n: BLANK_OUTPUTS }], { at_ms: 0, kind: 'voucher', stored: { kind: 'voucher' } }, () => this.api.voucher(code, out.msgs));
    const got = receive(r.signatures, { outputs: out.pending }, this.keysets(this.credit));
    await this.commit([], got, { at_ms: Date.now(), kind: 'voucher', stored: r.stored_record });
    return got.reduce((n, p) => n + p.amount, 0);
  }

  async topupStart(amountZat: number): Promise<TopupRecord> {
    const counter = await this.reserve(this.credit.id, BLANK_OUTPUTS);
    const out = blankOutputs(this.seed, this.credit.id, counter);
    const secret = toHex(randomBytes(32));
    const r = await this.api.topup(amountZat, out.msgs, toHex(sha256(utf8(secret))));
    const rec: TopupRecord = { id: r.topup_id, amount_zat: amountZat, address: r.address, expires_height: r.expires_height, secret, counter, status: 'awaiting' };
    this.data.topups.push(rec);
    await this.save(this.data);
    return rec;
  }

  /** Poll a top-up; once credited, unblind its slips (once). */
  async topupPoll(id: string): Promise<TopupRecord> {
    const rec = this.data.topups.find((t) => t.id === id);
    if (!rec) throw new Error('unknown top-up');
    if (rec.status === 'credited' || rec.status === 'confirmed') {
      return rec;
    }
    const s = await this.api.topupStatus(id);
    rec.privacy = s.privacy;
    if ((s.status === 'credited' || s.status === 'confirmed') && s.signatures.length > 0) {
      const pending = blankOutputs(this.seed, this.credit.id, rec.counter).pending;
      const got = receive(s.signatures, { outputs: pending }, this.keysets(this.credit));
      rec.status = s.status;
      await this.commit([], got, { at_ms: Date.now(), kind: 'topup', stored: { kind: 'topup', amount_zat: rec.amount_zat } });
    } else {
      rec.status = s.status;
      await this.save(this.data);
    }
    return rec;
  }

  /** Buy `amount` CREDIT units of an outcome at no more than `limitBp` per share. */
  async buy(market: string, outcome: 0 | 1, amount: number, limitBp: number) {
    const pos = this.keysetOf(market, outcome);
    const inputs = select(this.free(this.credit.id), amount);
    if (!inputs) throw new Error('Not enough balance for this. Top up in F3 CAGE.');
    return this.trade('buy', market, outcome, amount, limitBp, inputs, pos, this.credit);
  }

  /** Sell `shares` share-units of an outcome at no less than `limitBp`. */
  async sell(market: string, outcome: 0 | 1, shares: number, limitBp: number) {
    const pos = this.keysetOf(market, outcome);
    const inputs = select(this.free(pos.id), shares);
    if (!inputs) throw new Error('You hold fewer shares than that.');
    return this.trade('sell', market, outcome, shares, limitBp, inputs, this.credit, pos);
  }

  private async trade(
    side: 'buy' | 'sell',
    market: string,
    outcome: 0 | 1,
    amount: number,
    limit_bp: number,
    inputs: Proof[],
    get: Keyset,
    change: Keyset,
  ) {
    const outsAt = await this.reserve(get.id, BLANK_OUTPUTS);
    const chgAt = await this.reserve(change.id, BLANK_OUTPUTS);
    const outs = blankOutputs(this.seed, get.id, outsAt);
    const chg = blankOutputs(this.seed, change.id, chgAt);
    const index = this.data.calledNext++;
    const tag = calledItTag(calledItSecret(this.seed, index));
    trace(() => `tag    SHA256(called-it secret #${index}) = ${short(tag)} · the only link to this bet, and only you hold the secret`);
    trace(() => `spend  ${inputs.length} slips · ${inputs.reduce((n, p) => n + p.amount, 0)} units · server sees Y = hash_to_curve(secret), never who`);
    await this.save(this.data);
    const range = (ks: Keyset, counter: number): OutRange => (ks.id === this.credit.id ? { counter, n: BLANK_OUTPUTS } : { market, outcome, counter, n: BLANK_OUTPUTS });
    const r = await this.tracked(inputs, [range(get, outsAt), range(change, chgAt)], { at_ms: 0, kind: side, stored: { kind: side, market, outcome, amount }, called: { index, tag, market, outcome } }, () =>
      this.api.trade({ market, side, outcome, limit_bp, amount, inputs, outputs: outs.msgs, change_outputs: chg.msgs, tag }),
    );
    const got = receive(r.signatures, { outputs: outs.pending, change: chg.pending }, this.keysets(get, change));
    await this.commit(inputs, got, { at_ms: Date.now(), kind: side, stored: r.stored_record, called: { index, tag, market, outcome }, fill: r.fill });
    return r;
  }

  /** Redeem every slip of a resolved market's outcome. */
  async redeem(market: string, outcome: 0 | 1): Promise<number> {
    const pos = this.keysetOf(market, outcome);
    const inputs = this.free(pos.id).slice(0, 64);
    if (inputs.length === 0) throw new Error('You hold no shares of this outcome.');
    const counter = await this.reserve(this.credit.id, BLANK_OUTPUTS);
    const outs = blankOutputs(this.seed, this.credit.id, counter);
    const r = await this.tracked(inputs, [{ counter, n: BLANK_OUTPUTS }], { at_ms: 0, kind: 'redeem', stored: { kind: 'redeem' } }, () => this.api.redeem(inputs, outs.msgs));
    const got = receive(r.signatures, { outputs: outs.pending }, this.keysets(this.credit));
    await this.commit(inputs, got, { at_ms: Date.now(), kind: 'redeem', stored: r.stored_record });
    return r.paid;
  }

  /** Withdraw `amount` units (a standard amount) to an address sealed to the signer. */
  async withdraw(amount: number, address: string, sealPk: string, fee = 20) {
    const inputs = select(this.free(this.credit.id), amount + fee);
    if (!inputs) throw new Error('Not enough balance for this. Top up in F3 CAGE.');
    const chgAt = await this.reserve(this.credit.id, BLANK_OUTPUTS);
    const chg = blankOutputs(this.seed, this.credit.id, chgAt);
    const sealed = await seal(sealPk, address);
    trace(() => `seal   address → X25519 + HKDF + AES-GCM to the signer's pinned key · only the signer can open it · ${sealed.sealed.slice(0, 18)}… · commitment ${short(sealed.commitment)}`);
    const r = await this.tracked(inputs, [{ counter: chgAt, n: BLANK_OUTPUTS }], { at_ms: 0, kind: 'withdraw', stored: { kind: 'withdraw', amount, commitment: sealed.commitment } }, () =>
      this.api.withdraw(inputs, amount, chg.msgs, sealed.sealed, sealed.commitment),
    );
    const got = receive(r.signatures, { change: chg.pending }, this.keysets(this.credit));
    await this.commit(inputs, got, { at_ms: Date.now(), kind: 'withdraw', stored: r.stored_record });
    return sealed.commitment;
  }

  /** Hand over `amount` of a keyset as a bearer code; it stays in the outbox until taken back. */
  async send(id: string, amount: number, paper = false): Promise<string> {
    const ks = this.known.get(id);
    if (!ks) throw new Error('unknown keyset');
    let picked = select(this.free(id), amount);
    if (!picked) throw new Error('Not enough of that slip to hand over.');
    const total = picked.reduce((n, p) => n + p.amount, 0);
    if (total !== amount) {
      // Swap into exactly `amount` + the rest, so the code carries no more than asked.
      const amounts = [...split(amount), ...split(total - amount)];
      const start = await this.reserve(id, amounts.length);
      const out = makeOutputs(this.seed, id, start, amounts);
      const swapIn = picked;
      const r = await this.tracked(swapIn, [{ ...this.rangeOf(id), counter: start, n: amounts.length }], { at_ms: 0, kind: 'send', stored: { kind: 'swap' } }, () => this.api.swap(swapIn, out.msgs));
      const got = receive(r.signatures, { outputs: out.pending }, this.keysets(ks));
      await this.commit(picked, got, { at_ms: Date.now(), kind: 'send', stored: r.stored_record });
      picked = select(got, amount);
      if (!picked || picked.reduce((n, p) => n + p.amount, 0) !== amount) throw new Error('exact change failed');
    }
    const gone = new Set(picked.map((p) => p.secret));
    const code = encodeSlips(picked);
    this.data.slips = this.data.slips.filter((s) => !gone.has(s.secret));
    this.data.outbox = [...(this.data.outbox ?? []), { code, at_ms: Date.now(), id, amount, paper }];
    await this.save(this.data);
    return code;
  }

  /**
   * Take back a code from the outbox. If the receiver already took it over, the swap is refused
   * as spent and the entry is cleared: that is the hand-off having worked.
   */
  async reclaim(code: string): Promise<'back' | 'taken'> {
    const drop = async () => {
      this.data.outbox = (this.data.outbox ?? []).filter((o) => o.code !== code);
      await this.save(this.data);
    };
    try {
      await this.receiveCode(code);
      await drop();
      return 'back';
    } catch (e) {
      if ((e as { code?: string }).code === 'spent') {
        await drop();
        return 'taken';
      }
      throw e;
    }
  }

  /** Take over slips someone handed us: swap them at once, so the sender can't spend them too. */
  async receiveCode(code: string): Promise<number> {
    const slips = decodeSlips(code);
    const id = slips[0]!.id;
    if (!slips.every((s) => s.id === id)) throw new Error('That code mixes different slips; ask for one code per slip.');
    const ks = this.known.get(id);
    if (!ks) throw new Error('That code is for a market this app does not list (yet).');
    const total = slips.reduce((n, s) => n + s.amount, 0);
    const amounts = split(total);
    const start = await this.reserve(id, amounts.length);
    const out = makeOutputs(this.seed, id, start, amounts);
    const r = await this.tracked(slips, [{ ...this.rangeOf(id), counter: start, n: amounts.length }], { at_ms: 0, kind: 'receive', stored: { kind: 'swap' } }, () => this.api.swap(slips, out.msgs), { code });
    const got = receive(r.signatures, { outputs: out.pending }, this.keysets(ks));
    await this.commit([], got, { at_ms: Date.now(), kind: 'receive', stored: r.stored_record });
    // Our own code coming back (or a code we were given twice) leaves the outbox.
    if (this.data.outbox?.some((o) => o.code === code)) {
      this.data.outbox = this.data.outbox.filter((o) => o.code !== code);
      await this.save(this.data);
    }
    return total;
  }

  /** Offer a blind duel: `outcome` at `priceBp` for `shares`; the stake goes into escrow. */
  async duelOpen(market: string, outcome: 0 | 1, shares: number, priceBp: number): Promise<MyDuel> {
    const pos = this.keysetOf(market, outcome);
    const stake = Math.ceil((shares * priceBp) / 10_000);
    const inputs = select(this.free(this.credit.id), stake);
    if (!inputs) throw new Error('Not enough balance for this. Top up in F3 CAGE.');
    const chgAt = await this.reserve(this.credit.id, BLANK_OUTPUTS);
    const chg = blankOutputs(this.seed, this.credit.id, chgAt);
    const counter = await this.reserve(pos.id, BLANK_OUTPUTS);
    const outs = blankOutputs(this.seed, pos.id, counter);
    const duel = toHex(randomBytes(32));
    const secret = toHex(randomBytes(32));
    const d: MyDuel = { duel, market, outcome, shares, price_bp: priceBp, stake, keyset: pos.id, counter, secret, at_ms: Date.now(), status: 'open' };
    // Saved before the request leaves: the cancel secret must never be lost.
    this.data.duels = [...(this.data.duels ?? []), d];
    await this.save(this.data);
    trace(() => `duel   offer ${shares} shares at ${priceBp / 100}¢ · stake ${stake} in escrow · ${BLANK_OUTPUTS} blank outputs left for our shares`);
    try {
      const r = await this.tracked(inputs, [{ counter: chgAt, n: BLANK_OUTPUTS }], { at_ms: 0, kind: 'duel_open', stored: { kind: 'duel_open', duel } }, () =>
        this.api.duelOpen({ duel, market, outcome, shares, price_bp: priceBp, inputs, change_outputs: chg.msgs, outputs: outs.msgs, cancel: toHex(sha256(fromHex(secret))) }),
        { duel: { id: duel, action: 'open' } },
      );
      const got = receive(r.signatures, { change: chg.pending }, this.keysets(this.credit));
      d.opened_ms = Date.now();
      await this.commit(inputs, got, { at_ms: Date.now(), kind: 'duel_open', stored: r.stored_record });
      return d;
    } catch (e) {
      // Refused: the duel never existed. In doubt: keep it (and its cancel secret) until the log says.
      if (!(e instanceof InDoubtError)) {
        this.data.duels = (this.data.duels ?? []).filter((x) => x.duel !== duel);
        await this.save(this.data);
      }
      throw e;
    }
  }

  /** Take the other side of an open duel on the terms shown. */
  async duelTake(d: { duel: string; market: string; outcome: 0 | 1; shares: number; price_bp: number; stake: number }) {
    const mine = this.keysetOf(d.market, d.outcome === 0 ? 1 : 0);
    const cost = d.shares - d.stake;
    const inputs = select(this.free(this.credit.id), cost);
    if (!inputs) throw new Error('Not enough balance for this. Top up in F3 CAGE.');
    const outsAt = await this.reserve(mine.id, BLANK_OUTPUTS);
    const chgAt = await this.reserve(this.credit.id, BLANK_OUTPUTS);
    const outs = blankOutputs(this.seed, mine.id, outsAt);
    const chg = blankOutputs(this.seed, this.credit.id, chgAt);
    const other = (d.outcome === 0 ? 1 : 0) as 0 | 1;
    const r = await this.tracked(
      inputs,
      [{ market: d.market, outcome: other, counter: outsAt, n: BLANK_OUTPUTS }, { counter: chgAt, n: BLANK_OUTPUTS }],
      { at_ms: 0, kind: 'duel_take', stored: { kind: 'duel_take', duel: d.duel } },
      () => this.api.duelTake({ duel: d.duel, outcome: d.outcome, shares: d.shares, price_bp: d.price_bp, inputs, outputs: outs.msgs, change_outputs: chg.msgs }),
    );
    const got = receive(r.signatures, { outputs: outs.pending, change: chg.pending }, this.keysets(mine, this.credit));
    await this.commit(inputs, got, { at_ms: Date.now(), kind: 'duel_take', stored: r.stored_record });
    return got.filter((p) => p.id === mine.id).reduce((n, p) => n + p.amount, 0);
  }

  /** Cancel one of our untaken duels: the stake comes back as CREDIT. */
  async duelCancel(duel: string): Promise<number> {
    const d = this.data.duels?.find((x) => x.duel === duel);
    if (!d) throw new Error('not one of our duels');
    const counter = await this.reserve(this.credit.id, BLANK_OUTPUTS);
    const outs = blankOutputs(this.seed, this.credit.id, counter);
    const r = await this.tracked([], [{ counter, n: BLANK_OUTPUTS }], { at_ms: 0, kind: 'duel_cancel', stored: { kind: 'duel_cancel', duel } }, () => this.api.duelCancel(duel, d.secret, outs.msgs), {
      duel: { id: duel, action: 'cancel' },
    });
    const got = receive(r.signatures, { outputs: outs.pending }, this.keysets(this.credit));
    d.status = 'cancelled';
    await this.commit([], got, { at_ms: Date.now(), kind: 'duel_cancel', stored: r.stored_record });
    return got.reduce((n, p) => n + p.amount, 0);
  }

  /** A taken duel's signatures (from the public live feed): unblind our shares. */
  async duelClaim(duel: string, sigs: Omit<SignatureOut, 'list'>[]): Promise<number> {
    const d = this.data.duels?.find((x) => x.duel === duel && x.status === 'open');
    if (!d) return 0;
    const ks = this.keysetOf(d.market, d.outcome);
    const got = receive(sigs.map((s) => ({ ...s, list: 'duel' as const })), { duel: blankOutputs(this.seed, ks.id, d.counter).pending }, this.keysets(ks));
    d.status = 'taken';
    await this.commit([], got, { at_ms: Date.now(), kind: 'duel_won', stored: { kind: 'duel_taken', duel } }, null);
    return got.reduce((n, p) => n + p.amount, 0);
  }

  /** The output range fields for a keyset we know (CREDIT, or a market's outcome). */
  private rangeOf(id: string): Pick<OutRange, 'market' | 'outcome'> {
    if (id === this.credit.id) return {};
    const kind = this.known.get(id)?.kind;
    if (kind?.kind === 'outcome') return { market: kind.market, outcome: kind.outcome };
    throw new Error('unknown keyset');
  }

  pendingFor(id: string, counter: number): Pending[] {
    return blankOutputs(this.seed, id, counter).pending;
  }
}
