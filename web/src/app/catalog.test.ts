import { describe, expect, it } from 'vitest';
import { type CatalogEntry, chunksOf, toMarkets } from './catalog';

const entry = (n: number, settled = false, info = true): CatalogEntry => ({
  id: n.toString(16).padStart(64, '0'),
  keysets: [`01a${n}`, `01b${n}`],
  end_ms: 1_000 + n,
  event_start_ms: null,
  status: settled ? { state: 'resolved', den: 1, num: [0, 1] } : { state: 'open' },
  params: { b: 400_000, fee_bp: 100, max_trade: 200_000 },
  info: info ? { slug: `m-${n}`, question: `Market ${n}?`, outcomes: ['Yes', 'No'], description: 'Rules.', resolution_source: 'src', volume_24h_usd: n, group_item_title: null } : null,
});

describe('catalog', () => {
  it('lists the catalog file first, then the archive in order, each market once', () => {
    const current = [entry(3), entry(5), entry(9, true)];
    const archive = [[entry(7, true), entry(1, true)], [entry(9, true), entry(2, true)]];
    const markets = toMarkets(current, archive);
    expect(markets.map((m) => [m.page, m.question])).toEqual([
      ['P201', 'Market 3?'],
      ['P202', 'Market 5?'],
      ['P203', 'Market 9?'],
      ['P204', 'Market 7?'],
      ['P205', 'Market 1?'],
      ['P206', 'Market 2?'],
    ]);
    expect(markets[3]!.resolved).toEqual({ den: 1, num: [0, 1] });
    expect(markets[0]!.resolved).toBeNull();
    expect(markets[0]!.minTrade).toBe(1_000);
  });

  it("keeps the pages of the catalog file's markets when the archive arrives", () => {
    const current = [entry(3), entry(5)];
    const before = toMarkets(current, []);
    const after = toMarkets(current, [[entry(1, true), entry(2, true)]]);
    expect(after.slice(0, 2)).toEqual(before);
  });

  it('leaves out markets without labels', () => {
    expect(toMarkets([entry(1, false, false), entry(2)], []).map((m) => m.page + m.question)).toEqual(['P201Market 2?']);
  });

  it('reads the chunk count defensively', () => {
    expect(chunksOf({ settled_chunks: 3, markets: [] })).toBe(3);
    expect(chunksOf({ settled_chunks: -1, markets: [] })).toBe(0);
    expect(chunksOf({ markets: [] } as never)).toBe(0);
    expect(chunksOf({ settled_chunks: 1.5, markets: [] })).toBe(0);
  });
});
