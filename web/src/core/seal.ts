// Sealed withdrawal addresses, the same format as crates/blindbook-seal:
//   shared = X25519(esk, signer_pk)
//   key    = HKDF-SHA256(ikm = shared, salt = epk ‖ signer_pk, info = "blindbook/seal/v1"), 32 bytes
//   sealed = "bbseal1:" ‖ base64url( epk ‖ nonce(12) ‖ AES-256-GCM(key, nonce, {"address","salt"}) )
//   commitment = SHA256(address ‖ salt(32))
// The API only ever sees the sealed blob and the commitment; only the signer can open it.

import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64url, concat, fromHex, own, randomBytes, toHex, utf8 } from './bytes';

export const PREFIX = 'bbseal1:';
const INFO = utf8('blindbook/seal/v1');

export function commitment(address: string, salt: Uint8Array): Uint8Array {
  return sha256(concat(utf8(address), salt));
}

/** Seal with explicit randomness (tests pin it; the app uses `seal`). */
export async function sealWith(
  signerPkHex: string,
  address: string,
  esk: Uint8Array,
  nonce: Uint8Array,
  salt: Uint8Array,
): Promise<{ sealed: string; commitment: string }> {
  const spk = fromHex(signerPkHex);
  const epk = x25519.getPublicKey(esk);
  const shared = x25519.getSharedSecret(esk, spk);
  const keyBytes = hkdf(sha256, shared, concat(epk, spk), INFO, 32);
  const key = await crypto.subtle.importKey('raw', own(keyBytes), 'AES-GCM', false, ['encrypt']);
  // Key order matches serde's struct order in Rust ({address, salt}); either order opens.
  const plain = utf8(JSON.stringify({ address, salt: toHex(salt) }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: own(nonce) }, key, own(plain)));
  return {
    sealed: PREFIX + base64url(concat(epk, nonce, ct)),
    commitment: toHex(commitment(address, salt)),
  };
}

export function seal(signerPkHex: string, address: string) {
  return sealWith(signerPkHex, address, randomBytes(32), randomBytes(12), randomBytes(32));
}
