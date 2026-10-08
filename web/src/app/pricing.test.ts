import { describe, expect, it } from 'vitest';
import { defaultLimitCents, estimateBuy, estimateSell } from './pricing';

describe('estimates follow the engine (PROTOCOL 5.7, b = 0.2, fee 1%)', () => {
  it('a 0.05 buy of A at 0.60 with ask 0.61: 0.076785 shares at 64.47¢', () => {
    const e = estimateBuy({ priceA: 0.6, outcome: 0, amount: 5_000, b: 20_000, feeBp: 100, ask: 0.61 });
    expect(e.shares).toBe(7_678);
    expect(e.avgCents).toBeCloseTo(64.47, 1);
    expect(defaultLimitCents(e.avgCents)).toBe(67);
  });

  it('the guard binds when Polymarket is dearer than our curve', () => {
    const e = estimateBuy({ priceA: 0.6, outcome: 0, amount: 1_000, b: 20_000, feeBp: 100, ask: 0.9 });
    expect(e.shares).toBe(Math.floor(990 / 0.9));
  });

  it('outcome B uses 1 − price', () => {
    const a = estimateBuy({ priceA: 0.4, outcome: 0, amount: 2_000, b: 20_000, feeBp: 100, ask: 0.41 });
    const b = estimateBuy({ priceA: 0.6, outcome: 1, amount: 2_000, b: 20_000, feeBp: 100, ask: 0.41 });
    expect(b).toEqual(a);
  });

  it('a sale never pays above the bid, and the fee comes off', () => {
    const s = estimateSell({ priceA: 0.85, outcome: 0, shares: 10_000, b: 20_000, feeBp: 100, bid: 0.84 });
    expect(s.avgCents).toBeLessThanOrEqual(84);
    expect(s.proceeds).toBeLessThan(10_000 * 0.84);
    expect(s.proceeds).toBeGreaterThan(0);
  });
});
