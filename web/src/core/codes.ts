// Things a user can carry outside the app (PROTOCOL sections 3 and 6):
//   bbslip1:  base64url(CBOR [[keyset_id, amount, secret, C], …])  slips handed to someone (or printed)
//   bbproof1: base64url(CBOR [s, height])                            a "called it" proof
// and the deterministic "called it" secrets: s_i = HMAC-SHA256(seed, "blindbook/called-it/v1" ‖ i),
// tag_i = SHA256("bb-called-it" ‖ s_i). Every tag uses its own secret, so revealing one proof
// says nothing about other trades; the seed alone finds them all again in the public log.

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64url, concat, fromBase64url, fromHex, toHex, utf8 } from './bytes';
import { decode, encode } from './cbor';
import type { Proof } from './blind';

export const SLIP_PREFIX = 'bbslip1:';
export const PROOF_PREFIX = 'bbproof1:';

export function calledItSecret(seed: Uint8Array, i: number): Uint8Array {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, i);
  return hmac(sha256, seed, concat(utf8('blindbook/called-it/v1'), idx));
}

export function calledItTag(secret: Uint8Array): string {
  return toHex(sha256(concat(utf8('bb-called-it'), secret)));
}

export function encodeProof(secret: Uint8Array, height: number): string {
  return PROOF_PREFIX + base64url(encode([secret, height]));
}

export function decodeProof(text: string): { secret: Uint8Array; height: number; tag: string } {
  const body = text.trim().replace(/^.*#p=/, '');
  if (!body.startsWith(PROOF_PREFIX)) throw new Error('not a called-it proof');
  const v = decode(fromBase64url(body.slice(PROOF_PREFIX.length)));
  if (!Array.isArray(v) || !(v[0] instanceof Uint8Array) || v[0].length !== 32 || typeof v[1] !== 'number') {
    throw new Error('malformed proof');
  }
  return { secret: v[0], height: v[1], tag: calledItTag(v[0]) };
}

export function encodeSlips(slips: Proof[]): string {
  return SLIP_PREFIX + base64url(encode(slips.map((p) => [p.id, p.amount, p.secret, fromHex(p.C)])));
}

export function decodeSlips(text: string): Proof[] {
  const body = text.trim();
  if (!body.startsWith(SLIP_PREFIX)) throw new Error('not a slip code');
  const v = decode(fromBase64url(body.slice(SLIP_PREFIX.length)));
  if (!Array.isArray(v) || v.length === 0 || v.length > 64) throw new Error('malformed slip code');
  return v.map((s) => {
    if (!Array.isArray(s) || typeof s[0] !== 'string' || typeof s[1] !== 'number' || typeof s[2] !== 'string' || !(s[3] instanceof Uint8Array) || s[3].length !== 33) {
      throw new Error('malformed slip');
    }
    return { id: s[0], amount: s[1], secret: s[2], C: toHex(s[3]) };
  });
}
