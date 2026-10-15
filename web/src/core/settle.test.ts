// Settling requests that got no answer, from the public log alone (no server): a request whose
// slips were spent while not one of the outputs it asked for was signed is reported
// (THREAT_MODEL I12); a withdrawal without change and a duel offer are not.
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as cashu from '@cashu/cashu-ts';
import golden from '../../../crates/blindbook-mint/tests/data/keysets-js.json';
import { ApiError, type Api } from './api';
import { deriveOutput, split, yOf } from './blind';
import { toHex, utf8 } from './bytes';
import { Wallet, newWalletData, type InFlight } from './wallet';

const M = '0204559d9106c538b0f21bd82b50c47117bfda93530ed212fb818b886321cdea3c';

/** A wallet holding one slip, a request in doubt that spends it, and a log whose next delta
 *  spends it and issues nothing. */
function setup(flight: Pick<InFlight, 'outs'> & Partial<InFlight>) {
  const data = newWalletData(sha256(utf8('settle')));
  const api = {
    seq: 4,
    head: async () => ({ height: 10, seq: 4, root: '00', pow_bits: { light: 8, heavy: 8 }, halted: false }),
    text: async () => JSON.stringify({ seq: 4, issued: [], spent: [{ Y: yOf('a-spent-slip') }] }),
  } as unknown as Api;
  const w = new Wallet(data, M, api, async () => undefined);
  const slip = { id: w.credit.id, amount: 1024, secret: 'a-spent-slip', C: '02'.padEnd(66, '1') };
  data.slips = [slip];
  data.inflight = [{ id: 'f1', at_ms: 0, seq: 3, inputs: [slip], entry: { at_ms: 0, kind: 'buy', stored: {} }, doubt: true, ...flight }];
  return w;
}

describe('requests settled from the public log', () => {
  it('reports slips spent while none of the requested outputs was signed', async () => {
    const w = setup({ outs: [{ counter: 0, n: 31 }] });
    expect(await w.settleDoubts()).toBe(1);
    expect(w.takeRedirected()).toBe(1);
    expect(w.takeRedirected()).toBe(0);
    expect(w.data.history.at(-1)?.stored.outputs_never_signed).toBe(true);
    expect(w.inDoubt()).toBe(0);
    expect(w.data.slips).toHaveLength(0);
  });

  it('a withdrawal without change asks for no outputs: nothing to report', async () => {
    const w = setup({ outs: [], entry: { at_ms: 0, kind: 'withdraw', stored: {} } });
    expect(await w.settleDoubts()).toBe(1);
    expect(w.takeRedirected()).toBe(0);
  });

  it("a duel offer's shares are signed at the take: nothing to report", async () => {
    const w = setup({ outs: [{ counter: 0, n: 4 }], duel: { id: 'd1', action: 'open' } });
    expect(await w.settleDoubts()).toBe(1);
    expect(w.takeRedirected()).toBe(0);
  });
});

// A request given up on may still go through: the server applies a request whose answer it lost
// before anything else, so it lands at most a block or two after the head first read after the
// failure. The wait counts from that head, not from the (possibly old) head the request left with,
// and its outputs are still looked for after its slips came back. Signed by a TEST mint
// (crates/blindbook-mint golden vectors), never a real key.
describe('requests given up on', () => {
  const Point = secp256k1.Point;
  const N = Point.Fn.ORDER;
  const m = BigInt('0x' + toHex(sha256(utf8(golden.test_mint_label)))) % N;
  const toBytes32 = (n: bigint) => Uint8Array.from((n.toString(16).padStart(64, '0').match(/../g) ?? []).map((h) => parseInt(h, 16)));
  // CREDIT's key for amount 2^k is m + t_k, t_k from the keyset preimage (keysets.ts).
  const sign = (B_hex: string, amount: number) => {
    const M = Point.fromHex(golden.m_pub);
    const pre = new Uint8Array([...utf8('blindbook/keyset/v1'), ...M.toBytes(true), ...new Uint8Array(32), 0xff, Math.log2(amount)]);
    const k = (m + (BigInt('0x' + toHex(sha256(pre))) % N)) % N;
    const dleq = cashu.createDLEQProof(Point.fromHex(B_hex), toBytes32(k));
    return { C_: Point.fromHex(B_hex).multiply(k).toHex(true), dleq: { e: toHex(dleq.e), s: toHex(dleq.s) } };
  };

  /** A wallet holding one slip, one request in doubt that spends it, and a log the test writes. */
  function setup(flight: Partial<InFlight> = {}) {
    const log = { seq: 9, deltas: new Map<number, { issued?: unknown[]; spent?: { Y: string }[] }>() };
    const api = {
      seq: 1,
      head: async () => ({ height: 10, seq: log.seq, root: '00', pow_bits: { light: 8, heavy: 8 }, halted: false }),
      text: async (path: string) => {
        const seq = Number(/\/delta\/(\d+)\./.exec(path)?.[1]);
        if (!seq) throw new Error('only single deltas here');
        return JSON.stringify({ seq, issued: [], spent: [], ...log.deltas.get(seq) });
      },
    } as unknown as Api;
    const data = newWalletData(sha256(utf8('settle-late')));
    const w = new Wallet(data, golden.m_pub, api, async () => undefined);
    const slip = { id: w.credit.id, amount: 1024, secret: 'a-slip', C: '02'.padEnd(66, '1') };
    data.slips = [slip];
    // Left with an old head (1): the log is at 9 by the time anyone looks.
    data.inflight = [{ id: 'f1', at_ms: 0, seq: 1, inputs: [slip], outs: [{ counter: 0, n: 31 }], entry: { at_ms: 0, kind: 'buy', stored: {} }, doubt: true, ...flight }];
    /** Our first outputs of the request, signed for `amount` in all. */
    const signed = (amount: number) =>
      split(amount).map((a, i) => {
        const p = deriveOutput(w.seed, w.credit.id, i);
        return { id: w.credit.id, amount: a, B_: p.B_, ...sign(p.B_, a) };
      });
    return { w, log, slip, signed };
  }

  it('waits three blocks from the first head read after the failure, however old its own', async () => {
    const { w, log } = setup();
    expect(await w.settleDoubts()).toBe(0);
    expect(w.data.inflight?.[0]?.wait_from).toBe(9);
    expect(w.creditBalance()).toBe(0);
    log.seq = 11;
    expect(await w.settleDoubts()).toBe(0);
    log.seq = 12;
    expect(await w.settleDoubts()).toBe(1);
    expect(w.inDoubt()).toBe(0);
    expect(w.creditBalance()).toBe(1024);
    expect(w.watching()).toBe(1);
  });

  it('went through after all: its outputs are ours and the slip it spent leaves', async () => {
    const { w, log, slip, signed } = setup();
    await w.settleDoubts();
    log.seq = 12;
    await w.settleDoubts();
    log.deltas.set(13, { issued: signed(1000), spent: [{ Y: yOf(slip.secret) }] });
    log.seq = 13;
    expect(await w.settleDoubts()).toBe(1);
    expect(w.watching()).toBe(0);
    expect(w.creditBalance()).toBe(1000);
    expect(w.data.slips.some((s) => s.secret === slip.secret)).toBe(false);
    expect(w.data.history.at(-1)?.stored).toMatchObject({ went_through_late: true, recovered_from_log: true });
    expect(w.takeRedirected()).toBe(0);
  });

  it('a slip given back and spent by a later request is no alarm; the watch ends', async () => {
    const { w, log, slip } = setup();
    await w.settleDoubts();
    log.seq = 12;
    await w.settleDoubts();
    log.deltas.set(13, { spent: [{ Y: yOf(slip.secret) }] });
    log.seq = 13;
    expect(await w.settleDoubts()).toBe(0);
    expect(w.takeRedirected()).toBe(0);
    expect(w.watching()).toBe(1);
    log.seq = 32;
    expect(await w.settleDoubts()).toBe(0);
    expect(w.watching()).toBe(0);
  });

  it('a duel offer given up on that opened after all comes back with its cancel secret', async () => {
    const { w, log, signed } = setup({ duel: { id: 'd1', action: 'open' }, entry: { at_ms: 0, kind: 'duel_open', stored: {} } });
    w.data.duels = [{ duel: 'd1', market: '00'.repeat(32), outcome: 0, shares: 2000, price_bp: 5000, stake: 1000, keyset: 'k', counter: 0, secret: 'cancel-me', at_ms: 0, status: 'open' }];
    await w.settleDoubts();
    log.seq = 12;
    await w.settleDoubts();
    expect(w.data.duels).toHaveLength(0);
    log.deltas.set(13, { issued: signed(24) });
    log.seq = 13;
    expect(await w.settleDoubts()).toBe(1);
    expect(w.data.duels?.[0]).toMatchObject({ duel: 'd1', secret: 'cancel-me', status: 'open' });
    expect(w.data.duels?.[0]?.opened_ms).toBeGreaterThan(0);
  });
});

// The same vault open on two devices (a 12-word restore on a phone): a slip spent on one is still in
// the other, whose next request is refused as spent. The public log shows which of its slips are
// gone; they leave the wallet, so the request after that goes through.
describe('slips spent elsewhere', () => {
  function setup() {
    const log = { seq: 20, deltas: new Map<number, { spent?: { Y: string }[] }>() };
    const api = {
      seq: 20,
      head: async () => ({ height: 10, seq: log.seq, root: '00', pow_bits: { light: 8, heavy: 8 }, halted: false }),
      text: async (path: string) => {
        const seq = Number(/\/delta\/(\d+)\./.exec(path)?.[1]);
        if (!seq) throw new Error('only single deltas here');
        return JSON.stringify({ seq, issued: [], spent: [], ...log.deltas.get(seq) });
      },
      trade: async () => {
        throw new ApiError(400, 'spent');
      },
    } as unknown as Api;
    const w = new Wallet(newWalletData(sha256(utf8('spent-elsewhere'))), M, api, async () => undefined);
    const gone = { id: w.credit.id, amount: 1024, secret: 'spent-on-the-phone', C: '02'.padEnd(66, '1') };
    const kept = { id: w.credit.id, amount: 512, secret: 'still-ours', C: '02'.padEnd(66, '2') };
    w.data.slips = [gone, kept];
    log.deltas.set(18, { spent: [{ Y: yOf(gone.secret) }] });
    return { w, gone };
  }
  const bet = (w: Wallet) => w.buy('00'.repeat(32), 0, 1024, 9_500);

  it('a refusal as spent takes the slips the log shows spent out of the wallet', async () => {
    const { w, gone } = setup();
    w.data.slipSeq = { [gone.secret]: 15, 'still-ours': 15 };
    await expect(bet(w)).rejects.toMatchObject({ code: 'spent' });
    expect(w.takePruned()).toBe(1);
    expect(w.data.slips.map((s) => s.secret)).toEqual(['still-ours']);
    expect(w.data.slipSeq).toEqual({ 'still-ours': 15 });
    expect(w.creditBalance()).toBe(512);
  });

  it('a restored vault reads from where the restore read', async () => {
    const late = setup().w;
    late.data.syncedSeq = 18;
    await expect(bet(late)).rejects.toMatchObject({ code: 'spent' });
    expect(late.data.slips).toHaveLength(2);
    const early = setup().w;
    early.data.syncedSeq = 17;
    await expect(bet(early)).rejects.toMatchObject({ code: 'spent' });
    expect(early.data.slips.map((s) => s.secret)).toEqual(['still-ours']);
  });
});

describe('a spend the log does not show yet', () => {
  it('sets the refused slips aside until the next blocks tell', async () => {
    const log = { seq: 20, deltas: new Map<number, { spent?: { Y: string }[] }>() };
    const api = {
      seq: 20,
      head: async () => ({ height: 10, seq: log.seq, root: '00', pow_bits: { light: 8, heavy: 8 }, halted: false }),
      text: async (path: string) => {
        const seq = Number(/\/delta\/(\d+)\./.exec(path)?.[1]);
        return JSON.stringify({ seq, issued: [], spent: [], batches: [], events: [], ...log.deltas.get(seq) });
      },
      trade: async () => {
        throw new ApiError(400, 'spent');
      },
    } as unknown as Api;
    const w = new Wallet(newWalletData(sha256(utf8('aside'))), M, api, async () => undefined);
    const big = { id: w.credit.id, amount: 1024, secret: 'spent-a-moment-ago', C: '02'.padEnd(66, '1') };
    const small = { id: w.credit.id, amount: 512, secret: 'never-spent', C: '02'.padEnd(66, '2') };
    w.data.slips = [big, small];
    w.data.slipSeq = { [big.secret]: 15, [small.secret]: 15 };
    w.data.syncedSeq = 20;
    await expect(w.buy('00'.repeat(32), 0, 1024, 9_500)).rejects.toMatchObject({ code: 'spent' });
    expect(w.takePruned()).toBe(1);
    expect(w.creditBalance()).toBe(512);
    // The next block shows the spend: the slip leaves for good.
    log.deltas.set(21, { spent: [{ Y: yOf(big.secret) }] });
    log.seq = 21;
    await w.sync();
    expect(w.data.slips.map((s) => s.secret)).toEqual([small.secret]);
    // A slip set aside that the log never shows spent comes back two blocks on.
    await expect(w.buy('00'.repeat(32), 0, 512, 9_500)).rejects.toMatchObject({ code: 'spent' });
    expect(w.creditBalance()).toBe(0);
    log.seq = 23;
    await w.sync();
    expect(w.creditBalance()).toBe(512);
  });
});

describe('a request in flight when the page closed', () => {
  it('is in doubt when the vault opens again, so the log settles it', () => {
    const data = newWalletData(sha256(utf8('reloaded')));
    const slip = { id: 'x', amount: 1024, secret: 'held', C: '02'.padEnd(66, '1') };
    data.inflight = [{ id: 'f1', at_ms: 0, seq: 3, inputs: [slip], outs: [{ counter: 0, n: 31 }], entry: { at_ms: 0, kind: 'buy', stored: {} }, doubt: false }];
    const w = new Wallet(data, M, {} as Api, async () => undefined);
    expect(w.inDoubt()).toBe(1);
  });
});
