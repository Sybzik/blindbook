// Blinded outputs and received signatures (PROTOCOL sections 3 and 4).
//
// Secrets and blinding factors come from the vault seed by NUT-13 (v01 keyset ids, the HMAC
// derivation), keyset id + counter, so zero-query restore can find every slip again in the public
// issuance log. Every signature is checked with its DLEQ proof against the key WE derived from M
// for the amount the signer reports, never a key the server hands us.

import * as cashu from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { fromHex, toHex, utf8 } from './bytes';
import { type Keyset, keyFor } from './keysets';
import { short, trace } from './trace';

const Point = secp256k1.Point;
type Pt = InstanceType<typeof Point>;

export const BLANK_OUTPUTS = 31;

export interface BlindedMessage {
  amount: number;
  id: string;
  B_: string;
}

export interface Proof {
  amount: number;
  id: string;
  secret: string;
  C: string;
}

/** What we keep about an output until its signature arrives. */
export interface Pending {
  id: string;
  counter: number;
  secret: string;
  r: bigint;
  B_: string;
}

export interface SignatureOut {
  list: 'outputs' | 'change';
  index: number;
  amount: number;
  id: string;
  C_: string;
  dleq: { e: string; s: string };
}

const b2n = (b: Uint8Array) => BigInt('0x' + (toHex(b) || '0'));

/** The deterministic secret, blinding factor and B_ for one counter. */
export function deriveOutput(seed: Uint8Array, keysetId: string, counter: number): Pending {
  const { secret, blindingFactor } = cashu.deriveSecretAndBlindingFactor(seed, keysetId, counter);
  const secretHex = toHex(secret);
  const r = b2n(blindingFactor);
  const { B_ } = cashu.blindMessage(utf8(secretHex), r);
  return { id: keysetId, counter, secret: secretHex, r, B_: B_.toHex(true) };
}

/** `n` outputs with counters start..start+n; amount 0 = blank (the signer picks denominations). */
export function makeOutputs(
  seed: Uint8Array,
  keysetId: string,
  start: number,
  amounts: number[],
): { msgs: BlindedMessage[]; pending: Pending[] } {
  const pending = amounts.map((_, i) => deriveOutput(seed, keysetId, start + i));
  trace(() => `blind  ${pending.length} outputs · keyset ${short(keysetId)} · counters ${start}–${start + pending.length - 1} · B_ = Y + r·G, first ${short(pending[0]?.B_ ?? '')}`);
  return {
    msgs: pending.map((p, i) => ({ amount: amounts[i] ?? 0, id: keysetId, B_: p.B_ })),
    pending,
  };
}

export const blankOutputs = (seed: Uint8Array, keysetId: string, start: number) =>
  makeOutputs(seed, keysetId, start, new Array<number>(BLANK_OUTPUTS).fill(0));

export class SignatureError extends Error {}

/**
 * Turn signatures into slips. `lists` maps a list name to the pending outputs it was built from;
 * `keysets` maps keyset id → our derived keyset. Throws if any signature fails its DLEQ check
 * against our key, has a non-denomination amount, a foreign keyset, or a repeated index.
 */
export function receive(
  sigs: SignatureOut[],
  lists: Partial<Record<'outputs' | 'change', Pending[]>>,
  keysets: Map<string, Keyset>,
): Proof[] {
  const seen = new Set<string>();
  const proofs: Proof[] = [];
  for (const s of sigs) {
    const tag = `${s.list}:${s.index}`;
    if (seen.has(tag)) throw new SignatureError(`repeated output ${tag}`);
    seen.add(tag);
    const p = lists[s.list]?.[s.index];
    if (!p) throw new SignatureError(`no output ${tag}`);
    if (s.id !== p.id) throw new SignatureError(`${tag}: keyset ${s.id} isn't the one we asked for`);
    const ks = keysets.get(s.id);
    const K = ks && keyFor(ks, s.amount);
    if (!K) throw new SignatureError(`${tag}: ${s.amount} isn't a denomination of our keyset`);
    const B_ = Point.fromHex(p.B_);
    const C_ = Point.fromHex(s.C_);
    const ok = cashu.verifyDLEQProof({ e: fromHex(s.dleq.e), s: fromHex(s.dleq.s) }, B_, C_, K);
    if (!ok) throw new SignatureError(`${tag}: DLEQ proof fails for the key derived from M`);
    const C: Pt = cashu.unblindSignature(C_, p.r, K);
    trace(() => `dleq   ${tag} amount ${s.amount} ✓ against K derived from M · unblind C = C_ − r·K → ${short(C.toHex(true))}`);
    proofs.push({ amount: s.amount, id: s.id, secret: p.secret, C: C.toHex(true) });
  }
  return proofs;
}

/** Y = hash_to_curve(secret): a slip's entry in the public spent set. */
export function yOf(secret: string): string {
  return cashu.hashToCurve(utf8(secret)).toHex(true);
}

/** Split an amount into denominations, smallest first (its binary digits). */
export function split(amount: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < 31; k++) if (Math.floor(amount / 2 ** k) % 2 === 1) out.push(2 ** k);
  return out;
}
