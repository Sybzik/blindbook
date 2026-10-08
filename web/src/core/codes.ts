// Things a user can carry outside the app (PROTOCOL sections 3 and 6):
//   bbslip2:  base64url(CBOR [[keyset_id, [[amount, secret, C], …]], …])  slips handed to someone
//             (or printed), grouped by keyset; ids, hex secrets and C as bytes, so a QR stays
//             readable. bbslip1 (base64url(CBOR [[keyset_id, amount, secret, C], …]), text
//             strings) is still read.
//   bbproof1: base64url(CBOR [s, height])                                  a "called it" proof
// and the deterministic "called it" secrets: s_i = HMAC-SHA256(seed, "blindbook/called-it/v1" ‖ i),
// tag_i = SHA256("bb-called-it" ‖ s_i). Every tag uses its own secret, so revealing one proof
// says nothing about other trades; the seed alone finds them all again in the public log.

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64url, concat, fromBase64url, fromHex, toHex, utf8 } from './bytes';
import { decode, encode } from './cbor';
import type { Proof } from './blind';

export const SLIP_PREFIX = 'bbslip2:';
const SLIP_PREFIX_V1 = 'bbslip1:';

/** Whether text looks like a slip code of either version. */
export const isSlipCode = (text: string) => /^bbslip[12]:/.test(text.trim());
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

const HEX64 = /^[0-9a-f]{64}$/;
const BAD = 'That slip code is incomplete or was changed.';

export function encodeSlips(slips: Proof[]): string {
  const groups = new Map<string, Proof[]>();
  for (const p of slips) groups.set(p.id, [...(groups.get(p.id) ?? []), p]);
  // A wallet's secrets are lowercase hex (NUT-13) and travel as their 32 bytes; anything else as text.
  const secret = (s: string) => (HEX64.test(s) ? fromHex(s) : s);
  const body = [...groups].map(([id, ps]) => [fromHex(id), ps.map((p) => [p.amount, secret(p.secret), fromHex(p.C)])]);
  return SLIP_PREFIX + base64url(encode(body));
}

export function decodeSlips(text: string): Proof[] {
  const body = text.trim();
  if (body.startsWith(SLIP_PREFIX_V1)) return decodeV1(body.slice(SLIP_PREFIX_V1.length));
  if (!body.startsWith(SLIP_PREFIX)) throw new Error('That is not a slip code (they start with bbslip2:).');
  const v = decode(fromBase64url(body.slice(SLIP_PREFIX.length)));
  if (!Array.isArray(v) || v.length === 0) throw new Error(BAD);
  const out: Proof[] = [];
  for (const g of v) {
    if (!Array.isArray(g) || !(g[0] instanceof Uint8Array) || g[0].length !== 33 || !Array.isArray(g[1])) throw new Error(BAD);
    const id = toHex(g[0]);
    for (const s of g[1] as unknown[]) {
      if (!Array.isArray(s) || typeof s[0] !== 'number' || !(s[1] instanceof Uint8Array || typeof s[1] === 'string') || !(s[2] instanceof Uint8Array) || s[2].length !== 33) throw new Error(BAD);
      if (s[1] instanceof Uint8Array && s[1].length !== 32) throw new Error(BAD);
      out.push({ id, amount: s[0], secret: s[1] instanceof Uint8Array ? toHex(s[1]) : s[1], C: toHex(s[2]) });
    }
  }
  if (out.length === 0 || out.length > 64) throw new Error(BAD);
  return out;
}

function decodeV1(b64: string): Proof[] {
  const v = decode(fromBase64url(b64));
  if (!Array.isArray(v) || v.length === 0 || v.length > 64) throw new Error(BAD);
  return v.map((s) => {
    if (!Array.isArray(s) || typeof s[0] !== 'string' || typeof s[1] !== 'number' || typeof s[2] !== 'string' || !(s[3] instanceof Uint8Array) || s[3].length !== 33) {
      throw new Error(BAD);
    }
    return { id: s[0], amount: s[1], secret: s[2], C: toHex(s[3]) };
  });
}
