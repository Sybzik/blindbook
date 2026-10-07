import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { decode, encode } from './cbor';
import { calledItSecret, calledItTag, decodeProof, decodeSlips, encodeProof, encodeSlips } from './codes';
import { toHex, utf8 } from './bytes';

describe('CBOR subset', () => {
  it('round trips', () => {
    const v = [0, 23, 24, 255, 256, 65536, 2 ** 32 + 5, Number.MAX_SAFE_INTEGER, 'é', new Uint8Array([1, 2]), [[]]];
    expect(decode(encode(v))).toEqual(v);
  });
  it('RFC 8949 examples', () => {
    expect(toHex(encode(1000))).toBe('1903e8');
    expect(toHex(encode([1, [2, 3]]))).toBe('820182020' + '3');
    expect(toHex(encode('IETF'))).toBe('6449455446');
  });
  it('refuses junk', () => {
    expect(() => decode(new Uint8Array([0x1b, 1]))).toThrow();
    expect(() => decode(new Uint8Array([0x01, 0x02]))).toThrow(/trailing/);
    expect(() => decode(new Uint8Array([0xa0]))).toThrow(/major/);
  });
});

describe('called it', () => {
  const seed = sha256(utf8('seed'));
  it('independent secrets, one tag each', () => {
    const a = calledItSecret(seed, 0);
    const b = calledItSecret(seed, 1);
    expect(toHex(a)).not.toBe(toHex(b));
    expect(calledItTag(a)).toBe(toHex(sha256(new Uint8Array([...utf8('bb-called-it'), ...a]))));
  });
  it('proof codes, also inside a link after #', () => {
    const s = calledItSecret(seed, 7);
    const code = encodeProof(s, 4_473_853);
    const p = decodeProof(`https://blindbook.example/#p=${code}`);
    expect(p.height).toBe(4_473_853);
    expect(p.tag).toBe(calledItTag(s));
    expect(() => decodeProof('bbproof1:AAAA')).toThrow();
  });
});

describe('slip codes', () => {
  it('round trip', () => {
    const slips = [
      { id: '01' + 'ab'.repeat(32), amount: 8, secret: 'cd'.repeat(32), C: '02' + 'ef'.repeat(32) },
      { id: '01' + 'ab'.repeat(32), amount: 1024, secret: '12'.repeat(32), C: '03' + '34'.repeat(32) },
    ];
    const code = encodeSlips(slips);
    expect(code.startsWith('bbslip1:')).toBe(true);
    expect(decodeSlips(code)).toEqual(slips);
    expect(() => decodeSlips('bbslip1:gA')).toThrow();
  });
});
