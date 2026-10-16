// The same 12 words open on two devices: each reads the public log once per block (Wallet.sync),
// so slips spent on one leave the other, slips signed on one appear on the other, and the counters
// and called-it indices move past what the other device used. Signed by a TEST mint
// (crates/blindbook-mint golden vectors), never a real key.
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as cashu from '@cashu/cashu-ts';
import golden from '../../../crates/blindbook-mint/tests/data/keysets-js.json';
import type { Api } from './api';
import { deriveOutput, yOf } from './blind';
import { toHex, utf8 } from './bytes';
import { calledItSecret, calledItTag, encodeSlips } from './codes';
import { Wallet, newWalletData } from './wallet';

const Point = secp256k1.Point;
const N = Point.Fn.ORDER;
const m = BigInt('0x' + toHex(sha256(utf8(golden.test_mint_label)))) % N;
const toBytes32 = (n: bigint) => Uint8Array.from((n.toString(16).padStart(64, '0').match(/../g) ?? []).map((h) => parseInt(h, 16)));
/** A keyset's signature on `B_` for `amount` (CREDIT unless a market and outcome are given): the
 *  key is m + t_k, t_k from the keyset preimage. */
function sign(B_hex: string, amount: number, market?: string, outcome?: 0 | 1) {
  const M = Point.fromHex(golden.m_pub);
  const id = market ? Uint8Array.from(market.match(/../g)!.map((h) => parseInt(h, 16))) : new Uint8Array(32);
  const pre = new Uint8Array([...utf8('blindbook/keyset/v1'), ...M.toBytes(true), ...id, market ? outcome! : 0xff, Math.log2(amount)]);
  const k = (m + (BigInt('0x' + toHex(sha256(pre))) % N)) % N;
  const dleq = cashu.createDLEQProof(Point.fromHex(B_hex), toBytes32(k));
  return { C_: Point.fromHex(B_hex).multiply(k).toHex(true), dleq: { e: toHex(dleq.e), s: toHex(dleq.s) } };
}

type Delta = { issued?: unknown[]; spent?: { Y: string }[]; batches?: { market: string; orders: { tag: string }[]; fills: [] }[] };

function setup() {
  const log = { seq: 10, deltas: new Map<number, Delta>(), gate: Promise.resolve() };
  const api = {
    seq: 10,
    head: async () => ({ height: 10, seq: log.seq, root: '00', pow_bits: { light: 8, heavy: 8 }, halted: false }),
    text: async (path: string) => {
      await log.gate;
      const seq = Number(/\/delta\/(\d+)\./.exec(path)?.[1]);
      if (!seq) throw new Error('only single deltas here');
      return JSON.stringify({ seq, issued: [], spent: [], batches: [], events: [], ...log.deltas.get(seq) });
    },
    trade: async () => {
      throw new Error('not in this test');
    },
  } as unknown as Api;
  const seed = sha256(utf8('two-devices'));
  const w = new Wallet(newWalletData(seed), golden.m_pub, api, async () => undefined);
  const old = { id: w.credit.id, amount: 1024, secret: 'spent-on-the-phone', C: '02'.padEnd(66, '1') };
  w.data.slips = [old];
  w.data.counters[w.credit.id] = 31;
  w.data.syncedSeq = 10;
  /** An output the other device got signed for these words at `counter`. */
  const theirs = (counter: number, amount: number) => {
    const p = deriveOutput(seed, w.credit.id, counter);
    return { id: w.credit.id, amount, B_: p.B_, ...sign(p.B_, amount) };
  };
  return { w, log, old, seed, theirs };
}

describe('the same vault on two devices', () => {
  it("takes in the other device's slips, drops the ones it spent, and moves past its counters and tags", async () => {
    const { w, log, old, seed, theirs } = setup();
    log.deltas.set(12, { issued: [theirs(40, 512), theirs(41, 256)], batches: [{ market: '00'.repeat(32), orders: [0, 1].map((i) => ({ tag: calledItTag(calledItSecret(seed, i)) })), fills: [] }] });
    log.deltas.set(13, { spent: [{ Y: yOf(old.secret) }] });
    log.seq = 13;
    expect(await w.sync()).toEqual({ gone: 1, found: 2, duels: 0, taken: 0 });
    expect(w.creditBalance()).toBe(768);
    expect(w.data.counters[w.credit.id]).toBe(41 + 1 + 31);
    expect(w.data.calledNext).toBe(2);
    expect(w.data.syncedSeq).toBe(13);
    expect(await w.sync()).toEqual({ gone: 0, found: 0, duels: 0, taken: 0 });
  });

  it("leaves the slips of this device's own requests in flight to settle as usual", async () => {
    const { w, log, old } = setup();
    w.data.inflight = [{ id: 'f1', at_ms: 0, seq: 10, inputs: [old], outs: [], entry: { at_ms: 0, kind: 'buy', stored: {} }, doubt: false }];
    log.deltas.set(11, { spent: [{ Y: yOf(old.secret) }] });
    log.seq = 11;
    expect(await w.sync()).toEqual({ gone: 0, found: 0, duels: 0, taken: 0 });
    expect(w.data.slips).toHaveLength(1);
  });

  it('a vault made here starts reading from now', async () => {
    const { w, log } = setup();
    w.data.syncedSeq = undefined;
    log.seq = 50;
    expect(await w.sync()).toEqual({ gone: 0, found: 0, duels: 0, taken: 0 });
    expect(w.data.syncedSeq).toBe(50);
  });

  it('reopened after a while, a new request waits until the log is read up to now', async () => {
    const { w, log, theirs } = setup();
    log.deltas.set(25, { issued: [theirs(31, 512)] });
    log.seq = 30;
    let open!: () => void;
    log.gate = new Promise<void>((r) => (open = r));
    const reading = w.sync();
    let asked = -1;
    const counterAsked = (w as unknown as { reserve(id: string, n: number): Promise<number> }).reserve(w.credit.id, 31).then((c) => (asked = c));
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toBe(-1);
    open();
    await reading;
    await counterAsked;
    expect(asked).toBe(31 + 1 + 31);
  });

  it('notices a code it handed over being taken over', async () => {
    const { w, log } = setup();
    const slip = { id: w.credit.id, amount: 512, secret: 'handed-over', C: '02'.padEnd(66, '3') };
    w.data.outbox = [{ code: encodeSlips([slip]), at_ms: 0, id: w.credit.id, amount: 512, paper: false }];
    log.deltas.set(11, { spent: [{ Y: yOf('handed-over') }] });
    log.seq = 11;
    expect((await w.sync()).taken).toBe(1);
    expect(w.data.outbox).toHaveLength(0);
  });

  it('collects a duel taken while it was away, from the log', async () => {
    const { w, log, seed } = setup();
    const market = 'ab'.repeat(32);
    const ks = w.keysetOf(market, 0);
    w.data.duels = [{ duel: 'd1', market, outcome: 0, shares: 2048, price_bp: 5000, stake: 1024, keyset: ks.id, counter: 31, secret: 'cancel', at_ms: 0, opened_ms: 1, status: 'open' }];
    const out = (i: number, amount: number) => {
      const p = deriveOutput(seed, ks.id, 31 + i);
      return { id: ks.id, amount, B_: p.B_, ...sign(p.B_, amount, market, 0) };
    };
    log.deltas.set(12, { issued: [out(0, 2048)] });
    log.seq = 12;
    expect((await w.sync()).duels).toBe(1);
    expect(w.data.duels?.[0]?.status).toBe('taken');
    expect(w.balance(ks.id)).toBe(2048);
  });
});
