import { describe, expect, it } from 'vitest';
import { canonical } from './canonical';
import { bodyDigest, leadingZeroBits, solveDigest, workHash } from './pow';
import { toHex } from './bytes';

// The same vector is pinned in crates/blindbook-api/src/pow.rs (`pinned_vector`).
describe('proof-of-work matches the server byte for byte', () => {
  const body = { market: 'ab', amount: 5, z: [1, 2], s: 'é\n' };
  it('canonical body', () => {
    expect(canonical(body)).toBe('{"amount":5,"market":"ab","s":"é\\n","z":[1,2]}');
    expect(toHex(bodyDigest(body))).toBe('e2494b42ee6de3f4f1ed4b6cb4ab45ee2af3f56d443029a75896d11aa29978a1');
  });
  it('the first nonce with 12 zero bits', () => {
    const d = bodyDigest(body);
    const n = solveDigest(d, 12);
    expect(n).toBe(2432);
    expect(toHex(workHash(d, n))).toBe('000aff2031488c5b61910b9d475c0ecf82a03d35a9d54afaa7f2ec27bc04773b');
    expect(leadingZeroBits(workHash(d, n))).toBeGreaterThanOrEqual(12);
  });
  it('split nonce space finds valid nonces', () => {
    const d = bodyDigest(body);
    const n = solveDigest(d, 10, 1, 4);
    expect(n % 4).toBe(1);
    expect(leadingZeroBits(workHash(d, n))).toBeGreaterThanOrEqual(10);
  });
});

describe('canonical JSON (same cases as the Rust tests)', () => {
  it('sorted, compact, integers', () => {
    expect(canonical({ b: [3, { z: true, a: null }], a: 'x', '€': 1, B: -2 })).toBe(
      '{"B":-2,"a":"x","b":[3,{"a":null,"z":true}],"€":1}',
    );
  });
  it('JCS string escapes', () => {
    expect(canonical({ s: 'q"b\\n\n\t\u0001\u007fé/' })).toBe('{"s":"q\\"b\\\\n\\n\\t\\u0001\u007fé/"}');
  });
  it('UTF-16 key order', () => {
    expect(canonical({ 'ﬁ': 1, '\u{1f600}': 2 })).toBe('{"\u{1f600}":2,"ﬁ":1}');
  });
  it('floats are refused', () => {
    expect(() => canonical({ p: 0.5 })).toThrow();
  });
});
