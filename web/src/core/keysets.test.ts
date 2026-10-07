import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as cashu from '@cashu/cashu-ts';
import golden from '../../../crates/blindbook-mint/tests/data/keysets-js.json';
import { deriveKeyset, keyFor } from './keysets';
import { blankOutputs, receive, split, yOf } from './blind';
import { toHex, utf8 } from './bytes';

const Point = secp256k1.Point;
const N = Point.Fn.ORDER;

describe('keysets derived from M match the signer (crates/blindbook-mint golden vectors)', () => {
  for (const e of golden.entries) {
    it(e.label, () => {
      const kind = e.outcome === 0xff ? ({ kind: 'credit' } as const) : ({ kind: 'outcome', market: e.market_id, outcome: e.outcome as 0 | 1 } as const);
      const ks = deriveKeyset(golden.m_pub, kind);
      expect(ks.id).toBe(e.id_v01);
      expect(ks.unit).toBe(e.unit);
      expect(ks.pubs.map((p) => p.toHex(true))).toEqual(e.pubkeys);
    });
  }
});

describe('blank outputs, signatures, DLEQ', () => {
  // A TEST mint: m = SHA256(label) mod n, never a real key.
  const m = BigInt('0x' + toHex(sha256(utf8(golden.test_mint_label)))) % N;
  const ks = deriveKeyset(golden.m_pub, { kind: 'credit' });
  const keysets = new Map([[ks.id, ks]]);
  const seed = sha256(utf8('blindbook/web-test-seed'));
  // The secret key for amount 2^k is m + t_k; t_k = (pub_k − M) / G, recomputed from the preimage.
  const secretFor = (amount: number) => {
    const k = Math.log2(amount);
    const M = Point.fromHex(golden.m_pub);
    const pre = new Uint8Array([...utf8('blindbook/keyset/v1'), ...M.toBytes(true), ...new Uint8Array(32), 0xff, k]);
    const t = BigInt('0x' + toHex(sha256(pre))) % N;
    return (m + t) % N;
  };
  const sign = (B_hex: string, amount: number) => {
    const k = secretFor(amount);
    const B_ = Point.fromHex(B_hex);
    const C_ = B_.multiply(k);
    const dleq = cashu.createDLEQProof(B_, toBytes32(k));
    return { C_: C_.toHex(true), dleq: { e: toHex(dleq.e), s: toHex(dleq.s) } };
  };
  const toBytes32 = (n: bigint) => Uint8Array.from((n.toString(16).padStart(64, '0').match(/../g) ?? []).map((h) => parseInt(h, 16)));

  it('round trip: blind, sign with the derived key, unblind, check', () => {
    const { msgs, pending } = blankOutputs(seed, ks.id, 0);
    expect(msgs).toHaveLength(31);
    expect(msgs.every((o) => o.amount === 0 && o.id === ks.id)).toBe(true);
    const amounts = split(1000);
    const sigs = amounts.map((a, i) => ({ list: 'outputs' as const, index: i, amount: a, id: ks.id, ...sign(msgs[i]!.B_, a) }));
    const proofs = receive(sigs, { outputs: pending }, keysets);
    expect(proofs.reduce((s, p) => s + p.amount, 0)).toBe(1000);
    // The slip passes the mint's spend check C == k·hash_to_curve(x).
    for (const p of proofs) {
      const Y = cashu.hashToCurve(utf8(p.secret));
      expect(Y.multiply(secretFor(p.amount)).toHex(true)).toBe(p.C);
      expect(yOf(p.secret)).toBe(Y.toHex(true));
    }
    // Deterministic: the same seed and counter give the same output.
    expect(blankOutputs(seed, ks.id, 0).msgs[3]!.B_).toBe(msgs[3]!.B_);
  });

  it('a signature with the wrong key, amount or index is refused', () => {
    const { msgs, pending } = blankOutputs(seed, ks.id, 100);
    const good = { list: 'outputs' as const, index: 0, amount: 8, id: ks.id, ...sign(msgs[0]!.B_, 8) };
    // Reported as 16, signed with K_8: the DLEQ against K_16 fails.
    expect(() => receive([{ ...good, amount: 16 }], { outputs: pending }, keysets)).toThrow(/DLEQ/);
    expect(() => receive([{ ...good, amount: 3 }], { outputs: pending }, keysets)).toThrow(/denomination/);
    expect(() => receive([good, good], { outputs: pending }, keysets)).toThrow(/repeated/);
    expect(() => receive([{ ...good, index: 40 }], { outputs: pending }, keysets)).toThrow(/no output/);
    expect(keyFor(ks, 2 ** 31)).toBeUndefined();
  });
});
