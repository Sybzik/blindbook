import { describe, expect, it } from 'vitest';
import { isUnifiedAddress } from './address';

// A mainnet unified address with an Orchard receiver, made for this test from a random key.
const MAIN = 'u1j4tzwf0pwetque6susw9hmddawflh8ksq9txcexxjq7va06tphh9xtutma5yy6nv0eu0050trn7ywxqrva5aw5vyd8tsdp8zcvgv5kml';

describe('unified addresses', () => {
  it('takes a whole address of its network', () => {
    expect(isUnifiedAddress(MAIN, 'mainnet')).toBe(true);
    expect(isUnifiedAddress(MAIN, 'testnet')).toBe(false);
  });
  it('catches one changed letter, a cut and a missing prefix letter', () => {
    expect(isUnifiedAddress(MAIN.slice(0, 40) + (MAIN[40] === 'q' ? 'p' : 'q') + MAIN.slice(41), 'mainnet')).toBe(false);
    expect(isUnifiedAddress(MAIN.slice(0, -1), 'mainnet')).toBe(false);
    expect(isUnifiedAddress(MAIN.slice(1), 'mainnet')).toBe(false);
  });
});
