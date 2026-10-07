// Keysets derived from the pinned master public key M (PROTOCOL section 2). The browser never
// accepts a key it didn't derive itself (THREAT_MODEL P2), so no key ever comes from the server.
//
//   t_k    = SHA256("blindbook/keyset/v1" ‖ M (33) ‖ market_id (32) ‖ outcome (1) ‖ k (1)) mod n
//   public = M + t_k·G,   k = 0..30, amount 2^k
//   id     = NUT-02 v01 id with unit "bb-share" (outcome keysets) or "bb-credit" (CREDIT)

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as cashu from '@cashu/cashu-ts';
import { concat, fromHex, toHex, utf8 } from './bytes';

const Point = secp256k1.Point;
type Pt = InstanceType<typeof Point>;
const N = Point.Fn.ORDER;

export const KEYSET_DST = utf8('blindbook/keyset/v1');
export const DENOMINATIONS = 31;
export const CREDIT_OUTCOME = 0xff;

export type KeysetKind = { kind: 'credit' } | { kind: 'outcome'; market: string; outcome: 0 | 1 };

export interface Keyset {
  kind: KeysetKind;
  id: string;
  unit: 'bb-share' | 'bb-credit';
  /** Public key for amount 2^k at index k. */
  pubs: Pt[];
}

function scalar(h: Uint8Array): bigint {
  const x = BigInt('0x' + toHex(h)) % N;
  if (x === 0n) throw new Error('zero scalar');
  return x;
}

export function keysetPreimage(M: Pt, marketId: Uint8Array, outcome: number, k: number): Uint8Array {
  return concat(KEYSET_DST, M.toBytes(true), marketId, new Uint8Array([outcome, k]));
}

const cache = new Map<string, Keyset>();

/** Derive (and cache) a keyset. `market` is the 32-byte conditionId in hex (no 0x). */
export function deriveKeyset(mHex: string, kind: KeysetKind): Keyset {
  const key = mHex + JSON.stringify(kind);
  const hit = cache.get(key);
  if (hit) return hit;
  const M = Point.fromHex(mHex);
  const credit = kind.kind === 'credit';
  const marketId = credit ? new Uint8Array(32) : fromHex(kind.market.replace(/^0x/, ''));
  if (marketId.length !== 32) throw new Error('market id must be 32 bytes');
  const outcome = credit ? CREDIT_OUTCOME : kind.outcome;
  const pubs: Pt[] = [];
  for (let k = 0; k < DENOMINATIONS; k++) {
    const t = scalar(sha256(keysetPreimage(M, marketId, outcome, k)));
    pubs.push(M.add(Point.BASE.multiply(t)));
  }
  const unit = credit ? 'bb-credit' : 'bb-share';
  const keys = Object.fromEntries(pubs.map((p, k) => [(1n << BigInt(k)).toString(), p.toHex(true)]));
  const id = cashu.deriveKeysetId(keys, { versionByte: 1, unit });
  const ks: Keyset = { kind, id, unit, pubs };
  cache.set(key, ks);
  return ks;
}

export const creditKeyset = (mHex: string) => deriveKeyset(mHex, { kind: 'credit' });

export const outcomeKeyset = (mHex: string, market: string, outcome: 0 | 1) =>
  deriveKeyset(mHex, { kind: 'outcome', market: market.replace(/^0x/, ''), outcome });

/** The key for an amount, if it is a denomination 2^k, k ≤ 30. */
export function keyFor(ks: Keyset, amount: number): Pt | undefined {
  if (!Number.isInteger(amount) || amount < 1) return undefined;
  const k = Math.log2(amount);
  return Number.isInteger(k) && k <= 30 ? ks.pubs[k] : undefined;
}
