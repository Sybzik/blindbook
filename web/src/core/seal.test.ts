import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { seal, sealWith } from './seal';
import { toHex, utf8 } from './bytes';

const ADDR =
  'utest166fy5luckyz2fnztzsznh6rwt5pe0va4mpnqm6axfklss87w53fw50aqg3rwmt2stt5nnmnzgteckxjquxx2yjuk4rmrntds7gtghekc';

// Pinned: crates/blindbook-seal opens exactly this blob (`opens_the_browser_vector`).
export const SIGNER_SK = sha256(utf8('blindbook/seal-test/signer'));
const ESK = sha256(utf8('blindbook/seal-test/ephemeral'));
const NONCE = sha256(utf8('blindbook/seal-test/nonce')).slice(0, 12);
const SALT = sha256(utf8('blindbook/seal-test/salt'));

describe('sealed withdrawal addresses', () => {
  it('pinned vector for the Rust side', async () => {
    const pk = toHex(x25519.getPublicKey(SIGNER_SK));
    const v = await sealWith(pk, ADDR, ESK, NONCE, SALT);
    expect(v.sealed.startsWith('bbseal1:')).toBe(true);
    expect(v.commitment).toBe(toHex(sha256(new Uint8Array([...utf8(ADDR), ...SALT]))));
    expect(v).toMatchSnapshot();
  });
  it('randomized: the same address never looks the same', async () => {
    const pk = toHex(x25519.getPublicKey(SIGNER_SK));
    const a = await seal(pk, ADDR);
    const b = await seal(pk, ADDR);
    expect(a.sealed).not.toBe(b.sealed);
    expect(a.commitment).not.toBe(b.commitment);
    expect(a.sealed).not.toContain('utest1');
  });
});
