import { describe, expect, it } from 'vitest';
import type { PriceHistory, PricePoint } from '../core/api';
import { pointsFor } from './prices';

const NOW = 30 * 24 * 3_600_000;
const min = (ms: number) => Math.floor(ms / 60_000);
/** Samples every `step` minutes over the last `span` minutes before NOW. */
const pts = (step: number, span: number): PricePoint[] =>
  Array.from({ length: Math.floor(span / step) }, (_, i) => [min(NOW) - span + (i + 1) * step, 5_000 + i, 4_900]);

describe('pointsFor', () => {
  const hist: PriceHistory = { m1: pts(1, 120), m15: pts(15, 7 * 24 * 60), h2: pts(120, 30 * 24 * 60) };
  const live = [{ t: NOW + 3_000, ours: 61, ref: 60 }, { t: NOW + 6_000, ours: 62, ref: 60 }];

  it('takes each range from its own resolution and keeps the live end', () => {
    const h = pointsFor('1H', hist, live, NOW);
    expect(h).toHaveLength(60 + 2);
    expect(h.at(-1)).toEqual(live[1]);
    expect(pointsFor('1D', hist, live, NOW)).toHaveLength(24 * 4 + 1);
    expect(pointsFor('1W', hist, live, NOW)).toHaveLength(7 * 24 * 4 + 1);
    expect(pointsFor('ALL', hist, live, NOW)).toHaveLength(30 * 12 + 1);
    expect(pointsFor('1D', hist, live, NOW)[0]).toEqual({ t: (min(NOW) - 24 * 60 + 15) * 60_000, ours: 50 + (7 * 24 * 4 - 96) / 100, ref: 49 });
  });

  it('falls back to the live samples while the history is short', () => {
    expect(pointsFor('1W', undefined, live, NOW)).toEqual(live);
    expect(pointsFor('ALL', { m1: [], m15: [], h2: [[min(NOW), 5_000, 5_000]] }, live, NOW)).toHaveLength(3);
  });
});
