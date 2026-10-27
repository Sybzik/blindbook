//! The market catalog as files every visitor downloads (PROTOCOL section 8), gzipped like the
//! log's files (the mixnet client can't decompress, so the app does):
//!
//! - `GET /v1/catalog.json.gz`: every market still in play and the settled ones not yet in an
//!   archive chunk, with what the app reads of each (labels, Polymarket's rules, schedule, keyset
//!   ids, parameters, status). However many markets settle, it stays about the same size.
//! - `GET /v1/settled/{k}.json.gz`: settled markets `k·chunk … k·chunk + chunk − 1`, in the order
//!   their results were applied. Made once the last of them has settled, never changed after.
//!
//! Every visitor reads the catalog file, then every chunk in order: nobody asks about one market.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use blindbook_ledger::H32;
use blindbook_ledger::ledger::{MarketParams, MarketStatus};
use serde::Serialize;

use crate::files::gz;
use crate::sequencer::{MarketView, Settled, Shared};

/// Settled markets per archive chunk: about 8 KB gzipped.
pub const SETTLED_CHUNK: usize = 32;

/// How often the catalog file is rebuilt from the market views (gzipped again only if it changed).
const REFRESH: Duration = Duration::from_secs(2);

/// The files as served: gzipped bytes.
#[derive(Default)]
pub struct Published {
    pub catalog: Vec<u8>,
    /// Chunk `k` at index `k`.
    pub chunks: Vec<Vec<u8>>,
    /// The catalog file before gzip, so an unchanged one isn't compressed again.
    json: Vec<u8>,
}

#[derive(Serialize)]
struct Entry<'a> {
    id: H32,
    keysets: &'a [String; 2],
    params: &'a MarketParams,
    event_start_ms: Option<u64>,
    end_ms: u64,
    status: &'a MarketStatus,
    info: Option<Info<'a>>,
}

#[derive(Serialize)]
struct Info<'a> {
    slug: &'a str,
    question: &'a str,
    outcomes: &'a [String; 2],
    description: &'a str,
    resolution_source: &'a str,
    volume_24h_usd: Option<u64>,
    group_item_title: Option<&'a str>,
}

#[derive(Serialize)]
struct CatalogFile<'a> {
    credit_keyset: &'a str,
    /// Archive chunks there are: `settled/0.json.gz` up to this, exclusive.
    settled_chunks: usize,
    markets: Vec<Entry<'a>>,
}

#[derive(Serialize)]
struct ChunkFile<'a> {
    chunk: usize,
    markets: Vec<Entry<'a>>,
}

fn entry(m: &MarketView) -> Entry<'_> {
    Entry {
        id: m.id,
        keysets: &m.keysets,
        params: &m.params,
        event_start_ms: m.event_start_ms,
        end_ms: m.end_ms,
        status: &m.status,
        info: m.info.as_ref().map(|i| Info {
            slug: &i.slug,
            question: &i.question,
            outcomes: &i.outcomes,
            description: &i.description,
            resolution_source: &i.resolution_source,
            volume_24h_usd: i.volume_24h_usd,
            group_item_title: i.group_item_title.as_deref(),
        }),
    }
}

/// The settled markets that are in archive chunks, so in no other file everyone polls.
pub fn archived(settled: &[Settled], chunk: usize) -> HashSet<H32> {
    settled[..settled.len() / chunk * chunk]
        .iter()
        .map(|s| s.market)
        .collect()
}

/// Bring `out` up to date: chunks that have filled up are added (one made is never made again),
/// and the catalog file is rebuilt if its content changed.
pub fn refresh(
    markets: &BTreeMap<H32, MarketView>,
    settled: &[Settled],
    credit_keyset: &str,
    chunk: usize,
    out: &mut Published,
) -> std::io::Result<()> {
    let full = settled.len() / chunk;
    while out.chunks.len() < full {
        let k = out.chunks.len();
        let file = ChunkFile {
            chunk: k,
            markets: settled[k * chunk..(k + 1) * chunk]
                .iter()
                .filter_map(|s| markets.get(&s.market))
                .map(entry)
                .collect(),
        };
        out.chunks.push(gz(&serde_json::to_vec(&file)?)?);
    }
    let archived = archived(settled, chunk);
    let file = CatalogFile {
        credit_keyset,
        settled_chunks: full,
        markets: markets
            .values()
            .filter(|m| !archived.contains(&m.id))
            .map(entry)
            .collect(),
    };
    let json = serde_json::to_vec(&file)?;
    if json != out.json {
        out.catalog = gz(&json)?;
        out.json = json;
    }
    Ok(())
}

/// Refresh the files from the shared market views.
pub fn refresh_from(shared: &Shared, chunk: usize, out: &RwLock<Published>) {
    let markets = shared.markets.read().unwrap_or_else(|e| e.into_inner());
    let settled = shared.settled.read().unwrap_or_else(|e| e.into_inner());
    let mut out = out.write().unwrap_or_else(|e| e.into_inner());
    if let Err(e) = refresh(&markets, &settled, &shared.credit_id, chunk, &mut out) {
        tracing::warn!(error = %e, "catalog files not built");
    }
}

/// Keep the files current.
pub async fn run(shared: Arc<Shared>, chunk: usize, out: Arc<RwLock<Published>>) {
    let mut tick = tokio::time::interval(REFRESH);
    loop {
        tick.tick().await;
        refresh_from(&shared, chunk, &out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use blindbook_ledger::ledger::Pool;
    use blindbook_polymarket::MarketInfo;
    use std::io::Read;

    fn view(n: u8, status: MarketStatus) -> MarketView {
        MarketView {
            id: H32([n; 32]),
            keysets: [format!("00a{n}"), format!("00b{n}")],
            params: MarketParams::testnet(),
            event_start_ms: None,
            end_ms: 1_000 + n as u64,
            pool: Pool::default(),
            status,
            info: Some(MarketInfo {
                gamma_id: "1".into(),
                slug: format!("market-{n}"),
                question: format!("Market {n}?"),
                condition_id: format!("0x{}", H32([n; 32])),
                outcomes: ["Yes".into(), "No".into()],
                token_ids: ["123".into(), "456".into()],
                description: "The rules.".into(),
                resolution_source: "somewhere".into(),
                end_ms: None,
                event_start_ms: None,
                neg_risk: false,
                accepting_orders: true,
                closed: false,
                active: true,
                order_book: true,
                tick_ppm: None,
                image: Some("https://example.invalid/image.png".into()),
                event_title: None,
                group_item_title: None,
                volume_24h_usd: Some(5),
            }),
        }
    }

    const WON_A: MarketStatus = MarketStatus::Resolved {
        den: 1,
        num: [1, 0],
    };

    fn unzip(b: &[u8]) -> serde_json::Value {
        let mut s = String::new();
        flate2::read::GzDecoder::new(b)
            .read_to_string(&mut s)
            .unwrap();
        serde_json::from_str(&s).unwrap()
    }

    fn ids(v: &serde_json::Value) -> Vec<String> {
        v["markets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap().to_owned())
            .collect()
    }

    fn settle(markets: &mut BTreeMap<H32, MarketView>, settled: &mut Vec<Settled>, n: u8) {
        markets.get_mut(&H32([n; 32])).unwrap().status = WON_A;
        settled.push(Settled {
            market: H32([n; 32]),
            at_ms: 0,
        });
    }

    #[test]
    fn settled_markets_move_to_chunks_in_the_order_they_settled() {
        let mut markets: BTreeMap<H32, MarketView> = (1..=5)
            .map(|n| (H32([n; 32]), view(n, MarketStatus::Open)))
            .collect();
        let mut settled = Vec::new();
        let mut out = Published::default();
        refresh(&markets, &settled, "00cc", 2, &mut out).unwrap();
        let cat = unzip(&out.catalog);
        assert_eq!(cat["settled_chunks"], 0);
        assert_eq!(cat["credit_keyset"], "00cc");
        assert_eq!(ids(&cat).len(), 5);
        assert!(out.chunks.is_empty());

        // One settled: still in the catalog file (a chunk takes two).
        settle(&mut markets, &mut settled, 4);
        refresh(&markets, &settled, "00cc", 2, &mut out).unwrap();
        let cat = unzip(&out.catalog);
        assert_eq!(ids(&cat).len(), 5);
        assert_eq!(cat["markets"][3]["status"]["state"], "resolved");
        assert!(out.chunks.is_empty());

        // Two settled: they leave the catalog file for chunk 0, in the order they settled.
        settle(&mut markets, &mut settled, 2);
        refresh(&markets, &settled, "00cc", 2, &mut out).unwrap();
        let cat = unzip(&out.catalog);
        assert_eq!(cat["settled_chunks"], 1);
        assert_eq!(
            ids(&cat),
            [1, 3, 5].map(|n| H32([n; 32]).to_string()).to_vec()
        );
        assert_eq!(out.chunks.len(), 1);
        let chunk0 = out.chunks[0].clone();
        let c = unzip(&chunk0);
        assert_eq!(c["chunk"], 0);
        assert_eq!(ids(&c), [4, 2].map(|n| H32([n; 32]).to_string()).to_vec());
        assert_eq!(c["markets"][0]["status"]["num"], serde_json::json!([1, 0]));

        // A chunk once made never changes, whatever happens to the views later.
        markets.get_mut(&H32([4; 32])).unwrap().info = None;
        settle(&mut markets, &mut settled, 1);
        refresh(&markets, &settled, "00cc", 2, &mut out).unwrap();
        assert_eq!(out.chunks.len(), 1);
        assert_eq!(out.chunks[0], chunk0);
        assert_eq!(
            ids(&unzip(&out.catalog)),
            [1, 3, 5].map(|n| H32([n; 32]).to_string()).to_vec()
        );
        assert_eq!(archived(&settled, 2).len(), 2);
    }

    #[test]
    fn only_what_the_app_reads() {
        let markets: BTreeMap<H32, MarketView> = [(H32([7; 32]), view(7, MarketStatus::Open))]
            .into_iter()
            .collect();
        let mut out = Published::default();
        refresh(&markets, &[], "00cc", SETTLED_CHUNK, &mut out).unwrap();
        let m = &unzip(&out.catalog)["markets"][0];
        let keys = |v: &serde_json::Value| {
            let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(
            keys(m),
            [
                "end_ms",
                "event_start_ms",
                "id",
                "info",
                "keysets",
                "params",
                "status"
            ]
        );
        assert_eq!(
            keys(&m["info"]),
            [
                "description",
                "group_item_title",
                "outcomes",
                "question",
                "resolution_source",
                "slug",
                "volume_24h_usd"
            ]
        );
        assert_eq!(m["params"]["max_trade"], 200_000);
        assert_eq!(m["info"]["description"], "The rules.");

        // Unchanged content: the same bytes, not compressed again.
        let before = out.catalog.as_ptr();
        refresh(&markets, &[], "00cc", SETTLED_CHUNK, &mut out).unwrap();
        assert_eq!(out.catalog.as_ptr(), before);
    }
}
