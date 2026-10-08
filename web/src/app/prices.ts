// The market chart's ranges: the stored price history at each range's resolution
// (crates/blindbook-api/src/history.rs), then the live samples since its last point.

import type { PriceHistory, PricePoint } from '../core/api';
import type { Point } from './services';

export type Range = '1H' | '1D' | '1W' | 'ALL';
export const RANGES: Range[] = ['1H', '1D', '1W', 'ALL'];

/** The chart's points for a range: the stored history at that range's resolution, then the live
 *  samples since its last point, so the right end is always current. */
export function pointsFor(range: Range, hist: PriceHistory | undefined, series: Point[], now: number): Point[] {
  const toPoint = (p: PricePoint): Point => ({ t: p[0] * 60_000, ours: p[1] / 100, ref: p[2] / 100 });
  const base = !hist
    ? []
    : range === '1H'
      ? hist.m1.map(toPoint).filter((p) => p.t > now - 3_600_000)
      : range === '1D'
        ? hist.m15.map(toPoint).filter((p) => p.t > now - 86_400_000)
        : range === '1W'
          ? hist.m15.map(toPoint)
          : hist.h2.map(toPoint);
  const last = base.at(-1)?.t ?? 0;
  const fresh = series.filter((p) => p.t > last);
  return base.concat(range === '1H' || base.length < 2 ? fresh : fresh.slice(-1));
}

