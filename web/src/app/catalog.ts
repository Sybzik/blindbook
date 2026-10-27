// The market catalog (PROTOCOL section 8): `/v1/catalog.json.gz` holds the markets in play and the
// settled ones not archived yet; `/v1/settled/{k}.json.gz` holds the other settled markets, a fixed
// number per chunk, never changed once made. Every visitor reads the catalog file, then every
// chunk in order, so nobody's requests say which market they care about.

import type { MarketMeta } from './services';

export interface CatalogEntry {
  id: string;
  keysets: [string, string];
  end_ms: number;
  event_start_ms: number | null;
  status: { state: 'open' } | { state: 'resolved'; den: number; num: [number, number] };
  params: { b: number; fee_bp: number; max_trade: number };
  info: { slug: string; question: string; outcomes: [string, string]; description: string; resolution_source: string; volume_24h_usd: number | null; group_item_title: string | null } | null;
}

export interface CatalogFile {
  /** Archive chunks there are: `settled/0.json.gz` up to this, exclusive. */
  settled_chunks: number;
  markets: CatalogEntry[];
}

export interface ChunkFile {
  chunk: number;
  markets: CatalogEntry[];
}

/** How many archive chunks the catalog file says there are (0 for an answer of another shape). */
export function chunksOf(file: CatalogFile): number {
  const n = file.settled_chunks;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** The app's market list: the catalog file's markets first, so their pages stay put when the
 *  archive arrives, then the archive's in order, each market once. */
export function toMarkets(current: CatalogEntry[], archive: CatalogEntry[][]): MarketMeta[] {
  const seen = new Set<string>();
  const list: CatalogEntry[] = [];
  for (const m of [...current, ...archive.flat()]) {
    if (!m.info || seen.has(m.id)) continue;
    seen.add(m.id);
    list.push(m);
  }
  return list.map((m, i) => ({
    id: m.id,
    page: 'P' + (201 + i),
    question: m.info!.question,
    outcomes: m.info!.outcomes,
    rules: m.info!.description,
    source: m.info!.resolution_source,
    slug: m.info!.slug,
    eventStartMs: m.event_start_ms,
    endMs: m.end_ms,
    keysets: m.keysets,
    resolved: m.status.state === 'resolved' ? { den: m.status.den, num: m.status.num } : null,
    volume: m.info!.volume_24h_usd,
    group: m.info!.group_item_title,
    b: m.params.b,
    feeBp: m.params.fee_bp,
    minTrade: Math.max(1, Math.floor(m.params.max_trade / 200)),
  }));
}
