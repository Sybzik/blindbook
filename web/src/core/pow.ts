// Proof-of-work on every POST (PROTOCOL section 4), the same as crates/blindbook-api/src/pow.rs:
// SHA256("bb-pow-v1" ‖ SHA256(canonical body without `pow`) ‖ nonce as 8 bytes big-endian) must
// start with at least `bits` zero bits.

import { sha256 } from '@noble/hashes/sha2.js';
import { canonical } from './canonical';
import { concat, u64be, utf8 } from './bytes';

export const DOMAIN = utf8('bb-pow-v1');

export function leadingZeroBits(h: Uint8Array): number {
  let n = 0;
  for (const b of h) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

export function bodyDigest(body: object): Uint8Array {
  return sha256(utf8(canonical(body)));
}

export function workHash(digest: Uint8Array, nonce: number): Uint8Array {
  return sha256(concat(DOMAIN, digest, u64be(nonce)));
}

/** Find a nonce, trying `start`, `start + step`, … (workers split the space this way). */
export function solveDigest(digest: Uint8Array, bits: number, start = 0, step = 1): number {
  const msg = concat(DOMAIN, digest, new Uint8Array(8));
  const view = new DataView(msg.buffer, msg.length - 8, 8);
  for (let n = start; ; n += step) {
    view.setBigUint64(0, BigInt(n));
    if (leadingZeroBits(sha256(msg)) >= bits) return n;
  }
}

/** Attach `pow` to a request body (synchronously; the UI uses the worker pool in powPool.ts). */
export function withPow<T extends object>(body: T, bits: number): T & { pow: { nonce: number } } {
  const nonce = solveDigest(bodyDigest(body), bits);
  return { ...body, pow: { nonce } };
}
