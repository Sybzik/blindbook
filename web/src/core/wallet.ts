// The slip wallet: everything a user owns is a set of slips in the vault (bearer e-cash). This
// module runs the operations; the vault (vault/) keeps WalletData encrypted at rest.
//
// Counters for deterministic outputs are reserved and saved BEFORE a request leaves, so a crash
// can never reuse them, and zero-query restore (restore.ts) finds every signed output again.

import { fromHex, toHex, randomBytes } from './bytes';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from './bytes';
import { type Pending, type Proof, BLANK_OUTPUTS, blankOutputs, makeOutputs, receive, split } from './blind';
import { type Keyset, creditKeyset, outcomeKeyset } from './keysets';
import { calledItSecret, calledItTag, decodeSlips, encodeSlips } from './codes';
import { seal } from './seal';
import type { Api, FillRecord } from './api';
import { short, trace } from './trace';

export interface HistoryEntry {
  at_ms: number;
  kind: 'voucher' | 'topup' | 'buy' | 'sell' | 'redeem' | 'withdraw' | 'receive' | 'send';
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

  balance(id: string): number {
    return this.data.slips.filter((s) => s.id === id).reduce((n, s) => n + s.amount, 0);
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
    const out = await this.blank(this.credit);
    const r = await this.api.voucher(code, out.msgs);
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
    const inputs = select(this.data.slips.filter((s) => s.id === this.credit.id), amount);
    if (!inputs) throw new Error('not enough CREDIT');
    return this.trade('buy', market, outcome, amount, limitBp, inputs, pos, this.credit);
  }

  /** Sell `shares` share-units of an outcome at no less than `limitBp`. */
  async sell(market: string, outcome: 0 | 1, shares: number, limitBp: number) {
    const pos = this.keysetOf(market, outcome);
    const inputs = select(this.data.slips.filter((s) => s.id === pos.id), shares);
    if (!inputs) throw new Error('not enough shares');
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
    const outs = await this.blank(get);
    const chg = await this.blank(change);
    const index = this.data.calledNext++;
    const tag = calledItTag(calledItSecret(this.seed, index));
    trace(() => `tag    SHA256(called-it secret #${index}) = ${short(tag)} · the only link to this bet, and only you hold the secret`);
    trace(() => `spend  ${inputs.length} slips · ${inputs.reduce((n, p) => n + p.amount, 0)} units · server sees Y = hash_to_curve(secret), never who`);
    await this.save(this.data);
    const r = await this.api.trade({ market, side, outcome, limit_bp, amount, inputs, outputs: outs.msgs, change_outputs: chg.msgs, tag });
    const got = receive(r.signatures, { outputs: outs.pending, change: chg.pending }, this.keysets(get, change));
    await this.commit(inputs, got, { at_ms: Date.now(), kind: side, stored: r.stored_record, called: { index, tag, market, outcome }, fill: r.fill });
    return r;
  }

  /** Redeem every slip of a resolved market's outcome. */
  async redeem(market: string, outcome: 0 | 1): Promise<number> {
    const pos = this.keysetOf(market, outcome);
    const inputs = this.data.slips.filter((s) => s.id === pos.id).slice(0, 64);
    if (inputs.length === 0) throw new Error('no shares of this outcome');
    const outs = await this.blank(this.credit);
    const r = await this.api.redeem(inputs, outs.msgs);
    const got = receive(r.signatures, { outputs: outs.pending }, this.keysets(this.credit));
    await this.commit(inputs, got, { at_ms: Date.now(), kind: 'redeem', stored: r.stored_record });
    return r.paid;
  }

  /** Withdraw `amount` units (a standard amount) to an address sealed to the signer. */
  async withdraw(amount: number, address: string, sealPk: string, fee = 20) {
    const inputs = select(this.data.slips.filter((s) => s.id === this.credit.id), amount + fee);
    if (!inputs) throw new Error('not enough CREDIT');
    const chg = await this.blank(this.credit);
    const sealed = await seal(sealPk, address);
    trace(() => `seal   address → X25519 + HKDF + AES-GCM to the signer's pinned key · only the signer can open it · ${sealed.sealed.slice(0, 18)}… · commitment ${short(sealed.commitment)}`);
    const r = await this.api.withdraw(inputs, amount, chg.msgs, sealed.sealed, sealed.commitment);
    const got = receive(r.signatures, { change: chg.pending }, this.keysets(this.credit));
    await this.commit(inputs, got, { at_ms: Date.now(), kind: 'withdraw', stored: r.stored_record });
    return sealed.commitment;
  }

  /** Hand over `amount` of a keyset as a bearer code; it stays in the outbox until taken back. */
  async send(id: string, amount: number, paper = false): Promise<string> {
    const ks = this.known.get(id);
    if (!ks) throw new Error('unknown keyset');
    let picked = select(this.data.slips.filter((s) => s.id === id), amount);
    if (!picked) throw new Error('not enough');
    const total = picked.reduce((n, p) => n + p.amount, 0);
    if (total !== amount) {
      // Swap into exactly `amount` + the rest, so the code carries no more than asked.
      const amounts = [...split(amount), ...split(total - amount)];
      const start = await this.reserve(id, amounts.length);
      const out = makeOutputs(this.seed, id, start, amounts);
      const r = await this.api.swap(picked, out.msgs);
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
    if (!slips.every((s) => s.id === id)) throw new Error('mixed keysets in one code');
    const ks = this.known.get(id);
    if (!ks) throw new Error("slips of a keyset we don't know");
    const total = slips.reduce((n, s) => n + s.amount, 0);
    const amounts = split(total);
    const start = await this.reserve(id, amounts.length);
    const out = makeOutputs(this.seed, id, start, amounts);
    const r = await this.api.swap(slips, out.msgs);
    const got = receive(r.signatures, { outputs: out.pending }, this.keysets(ks));
    await this.commit([], got, { at_ms: Date.now(), kind: 'receive', stored: r.stored_record });
    // Our own code coming back (or a code we were given twice) leaves the outbox.
    if (this.data.outbox?.some((o) => o.code === code)) {
      this.data.outbox = this.data.outbox.filter((o) => o.code !== code);
      await this.save(this.data);
    }
    return total;
  }

  pendingFor(id: string, counter: number): Pending[] {
    return blankOutputs(this.seed, id, counter).pending;
  }
}
