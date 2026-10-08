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
// outputs signed, sees our slips spent, or sees enough blocks pass without either.

import { fromHex, toHex, randomBytes } from './bytes';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from './bytes';
import { type Pending, type Proof, type SignatureOut, BLANK_OUTPUTS, blankOutputs, deriveOutput, makeOutputs, receive, split, yOf } from './blind';
import { type Keyset, creditKeyset, outcomeKeyset } from './keysets';
import { calledItSecret, calledItTag, decodeSlips, encodeSlips } from './codes';
import { seal } from './seal';
import { ApiError, type Api, type FillRecord } from './api';
import { deltaTexts } from './log';
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
  /** The log's head seq when it left: a processed request shows up in a later delta. */
  seq: number;
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

/** Blocks after which a request that left no trace in the log never went through. */
const SETTLE_BLOCKS = 3;

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
    return this.data.slips.filter((s) => s.id === id && !held.has(s.secret));
  }

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
        await this.save(this.data);
        throw e;
      }
      f.doubt = true;
      await this.save(this.data);
      trace(() => `doubt  no answer · ${inputs.length} slips held back until the public log shows what happened`);
      throw new InDoubtError();
    }
  }

  /** Settle requests in doubt from the public log; returns how many were settled. */
  async settleDoubts(): Promise<number> {
    const doubts = (this.data.inflight ?? []).filter((f) => f.doubt);
    if (doubts.length === 0) return 0;
    const head = await this.api.head();
    const from = Math.min(...doubts.map((d) => d.seq)) + 1;
    if (from > head.seq) return 0;
    const deltas = (await deltaTexts(this.api, from, head.seq, head.seq)).map(
      (t) => JSON.parse(t) as { seq: number; issued: { id: string; amount: number; B_: string; C_: string; dleq: { e: string; s: string } }[]; spent: { Y: string }[] },
    );
    let settled = 0;
    for (const d of doubts) {
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
      const wentThrough = got.length > 0 || d.inputs.some((p) => spent.has(yOf(p.secret)));
      if (!wentThrough && head.seq < d.seq + SETTLE_BLOCKS) continue;
      this.data.inflight = (this.data.inflight ?? []).filter((x) => x.id !== d.id);
      if (wentThrough) {
        if (d.duel?.action === 'cancel') this.data.duels = (this.data.duels ?? []).map((x) => (x.duel === d.duel!.id ? { ...x, status: 'cancelled' as const } : x));
        if (d.code) this.data.outbox = (this.data.outbox ?? []).filter((o) => o.code !== d.code);
        await this.commit(d.inputs, got, { ...d.entry, at_ms: Date.now(), stored: { ...d.entry.stored, recovered_from_log: true } });
        trace(() => `doubt  settled from the public log: it went through · ${got.length} slips recovered`);
      } else {
        // Never processed: the slips are ours again, and a duel that never opened is forgotten.
        if (d.duel?.action === 'open') this.data.duels = (this.data.duels ?? []).filter((x) => x.duel !== d.duel!.id);
        await this.save(this.data);
        trace(() => `doubt  settled from the public log: it never went through · slips released`);
      }
      settled++;
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
    const start = this.data.counters[id] ?? 0;
    this.data.counters[id] = start + n;
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

  private async commit(spent: Proof[], got: Proof[], entry: HistoryEntry) {
    const gone = new Set(spent.map((p) => p.secret));
    this.data.slips = this.data.slips.filter((s) => !gone.has(s.secret)).concat(got);
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
    await this.commit([], got, { at_ms: Date.now(), kind: 'duel_won', stored: { kind: 'duel_taken', duel } });
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
