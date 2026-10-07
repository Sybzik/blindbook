// Zero-query restore (PROTOCOL section 3, normative client behaviour): from the seed alone, derive
// every output we could have sent, find it in the PUBLIC issuance log (which every visitor
// downloads anyway), unblind it, and drop what the public spent set already holds. No request
// about our slips is ever sent, so the server can't tell anyone restored anything.
//
// The same seed also finds our "called it" tags in the public batch records: the trade history
// comes back too.

import { type Proof, deriveOutput, receive } from './blind';
import { type Keyset, creditKeyset, outcomeKeyset } from './keysets';
import { calledItSecret, calledItTag } from './codes';

/** Consecutive unused counters after which a keyset is considered done (31 blank outputs per
 * request leave gaps of up to 30). */
export const GAP = 96;

export interface IssuedRecord {
  id: string;
  amount: number;
  B_: string;
  C_: string;
  dleq: { e: string; s: string };
}

export interface Snapshot {
  seq: number;
  height: number;
  root: string;
  credit_keyset: string;
  markets: { id: string; keysets: [string, string] }[];
  issued: IssuedRecord[];
  spent: string[];
}

export interface DeltaLike {
  seq: number;
  issued: IssuedRecord[];
  spent: { Y: string }[];
  batches: { market: string; orders: { tag: string; side: string; outcome: number; amount: number }[]; fills: { tag: string }[] }[];
}

export interface Restored {
  slips: Proof[];
  counters: Record<string, number>;
  /** Trades found by their called-it tags: secret index → market, outcome, side. */
  trades: { index: number; tag: string; market: string; outcome: number; side: string; amount: number }[];
  calledNext: number;
  /** Keysets listed with an id we didn't derive from M (never trusted). */
  foreign: string[];
}

export function restore(seed: Uint8Array, m: string, snap: Snapshot, deltas: DeltaLike[], yOf: (secret: string) => string): Restored {
  const issued = new Map<string, IssuedRecord>();
  const spent = new Set<string>(snap.spent);
  const used = new Set<string>();
  for (const r of snap.issued) {
    issued.set(r.B_, r);
    used.add(r.id);
  }
  for (const d of deltas.filter((d) => d.seq > snap.seq)) {
    for (const r of d.issued) {
      issued.set(r.B_, r);
      used.add(r.id);
    }
    for (const s of d.spent) spent.add(s.Y);
  }

  const keysets: Keyset[] = [creditKeyset(m)];
  const foreign: string[] = [];
  if (keysets[0]!.id !== snap.credit_keyset) foreign.push(snap.credit_keyset);
  for (const mk of snap.markets) {
    for (const o of [0, 1] as const) {
      const ks = outcomeKeyset(m, mk.id, o);
      if (ks.id !== mk.keysets[o]) foreign.push(mk.keysets[o]);
      keysets.push(ks);
    }
  }

  const slips: Proof[] = [];
  const counters: Record<string, number> = {};
  for (const ks of keysets) {
    if (!used.has(ks.id)) continue;
    let misses = 0;
    let last = -1;
    for (let c = 0; misses < GAP; c++) {
      const p = deriveOutput(seed, ks.id, c);
      const r = issued.get(p.B_);
      if (!r) {
        misses++;
        continue;
      }
      misses = 0;
      last = c;
      const [proof] = receive([{ list: 'outputs', index: 0, amount: r.amount, id: r.id, C_: r.C_, dleq: r.dleq }], { outputs: [p] }, new Map([[ks.id, ks]]));
      if (proof && !spent.has(yOf(proof.secret))) slips.push(proof);
    }
    // A margin of one blank list, in case a request we never heard back from is still pending.
    if (last >= 0) counters[ks.id] = last + 1 + 31;
  }

  const byTag = new Map<string, { market: string; outcome: number; side: string; amount: number }>();
  for (const d of deltas) for (const b of d.batches) for (const o of b.orders) byTag.set(o.tag, { market: b.market, outcome: o.outcome, side: o.side, amount: o.amount });
  const trades: Restored['trades'] = [];
  let misses = 0;
  let i = 0;
  for (; misses < 64; i++) {
    const tag = calledItTag(calledItSecret(seed, i));
    const hit = byTag.get(tag);
    if (!hit) {
      misses++;
      continue;
    }
    misses = 0;
    trades.push({ index: i, tag, ...hit });
  }
  const calledNext = trades.length ? trades[trades.length - 1]!.index + 1 : 0;
  return { slips, counters, trades, calledNext, foreign };
}
