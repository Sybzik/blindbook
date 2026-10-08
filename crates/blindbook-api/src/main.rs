//! `blindbook-api`: the public, secretless server.
//!
//! ```text
//! BB_DATA            data directory (journal, public files, catalog cache)
//! BB_LISTEN          listen address (default 127.0.0.1:8080; Caddy terminates TLS in front)
//! BB_M               mint master public key M (hex), pinned in the app build
//! BB_SIGNER_TOKEN    bearer token the signer presents on /v1/signer
//! BB_MARKETS         JSON file: [{"slug": "...", "event_start_ms": 0?, "end_ms": 0?}]
//! BB_NETWORK         testnet (default) | mainnet: market parameters (PROTOCOL section 1)
//! BB_POW_LIGHT       proof-of-work bits for trades, swaps, redemptions (default 16)
//! BB_POW_HEAVY       for top-ups, vouchers, withdrawals (default 20)
//! BB_VOUCHER_UNITS   CREDIT units per voucher (default 50,000 = 0.5 TAZ)
//! BB_UIVK            file with the deposit account's incoming viewing key: turns on top-ups and
//!                    makes the chain close the log blocks
//! BB_ZCASH_NET       test (default) | main | regtest[:heights] for the indexer
//! BB_LWD             lightwalletd / Zaino: zecrocks (default), zecrocks-main or host:port
//! BB_RESERVE_UFVK    file with the reserve's full viewing key, published as /v1/reserve.json
//!                    (with BB_RESERVE_BIRTHDAY, the wallet birthday height) for the solvency check
//! BB_DEV_BLOCK_SECS  development only, without BB_UIVK: close a log block every N seconds
//! HTTPS_PROXY        http:// proxy for Polymarket and Polygon (development machines only)
//! ```
//! It logs nothing about requests: no addresses, no paths, no user agents.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use blindbook_api::routes::PowBits;
use blindbook_api::sequencer::{Cmd, RefFn, Shared, now_ms};
use blindbook_api::{StartConfig, outcome_ids, start};
use blindbook_ledger::H32;
use blindbook_ledger::delta::ChainStats;
use blindbook_ledger::ledger::{
    MarketEntry, MarketInputs, MarketParams, MarketStatus, Pool, Reject,
};
use blindbook_ledger::ops::Op;
use blindbook_ledger::reference::RefSnapshot;
use blindbook_mint::cashu::PublicKey;
use blindbook_polymarket::mirror::{Mirror, MirrorConfig};
use blindbook_polymarket::net::{http_client, proxy_from_env};
use blindbook_polymarket::polygon::{DEFAULT_RPCS, PolygonReader, Settlement};
use blindbook_polymarket::reference::{DEFAULT_GUARD_SHARES, MarketFeed};
use blindbook_polymarket::{MarketInfo, gamma};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Debug, Deserialize)]
struct Listing {
    slug: String,
    /// When trading halts, if Gamma has no `gameStartTime` / `eventStartTime`.
    event_start_ms: Option<u64>,
    end_ms: Option<u64>,
}

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_owned())
}

fn env_num(k: &str, d: u64) -> u64 {
    std::env::var(k)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(d)
}

/// Fetch the catalog entries of the listed slugs; fall back to the cached copy per market.
async fn load_catalog(
    http: &reqwest::Client,
    listings: &[Listing],
    cache: &Path,
) -> BTreeMap<H32, (MarketInfo, Listing)> {
    let cached: BTreeMap<String, MarketInfo> = std::fs::read(cache)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut out = BTreeMap::new();
    let mut fresh = BTreeMap::new();
    for l in listings {
        let info = match gamma::fetch_market(http, &l.slug).await {
            Ok(i) => i,
            Err(e) => match cached.get(&l.slug) {
                Some(i) => {
                    tracing::warn!(slug = %l.slug, error = %e, "Gamma unavailable; using the cached catalog entry");
                    i.clone()
                }
                None => {
                    tracing::error!(slug = %l.slug, error = %e, "market not listed: no catalog entry");
                    continue;
                }
            },
        };
        let Some(id) = H32::parse(&info.condition_id) else {
            continue;
        };
        fresh.insert(l.slug.clone(), info.clone());
        out.insert(id, (info, l.clone()));
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&fresh) {
        let _ = std::fs::write(cache, bytes);
    }
    out
}

async fn op(tx: &mpsc::Sender<Cmd>, op: Op) -> Result<(), String> {
    let (rtx, rrx) = oneshot::channel();
    tx.send(Cmd::Op(op, rtx)).await.map_err(|e| e.to_string())?;
    match rrx.await.map_err(|e| e.to_string())? {
        Ok(done) => match done.applied {
            blindbook_ledger::ops::Applied::Refused(r) => Err(r.to_string()),
            _ => Ok(()),
        },
        Err(e) => Err(e.to_string()),
    }
}

/// Judging ends Nov 22, 2026: a market must end before (MARKETS "Listing"). `BB_JUDGING_END_MS`
/// overrides it.
const JUDGING_END_MS: u64 = 1_795_392_000_000;

/// The listing rules (MARKETS "Listing") on the live book: wait up to a minute for outcome A's
/// snapshot, then return what keeps the market out (empty: list it). An event start entered in
/// the markets file stands in for Polymarket's.
async fn listing_check(mirror: &Mirror, info: &MarketInfo, l: &Listing) -> Vec<String> {
    let mut book = None;
    for _ in 0..60 {
        book = mirror.book(&info.condition_id, 0);
        if book.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let Some(book) = book else {
        return vec!["no order book snapshot from Polymarket".into()];
    };
    let mut info = info.clone();
    if l.event_start_ms.is_some() {
        info.event_start_ms = l.event_start_ms;
    }
    if l.end_ms.is_some() {
        info.end_ms = l.end_ms;
    }
    let judging_end = env_num("BB_JUDGING_END_MS", JUDGING_END_MS);
    blindbook_polymarket::gamma::listing_issues(
        &info,
        &book,
        blindbook_polymarket::gamma::LISTING_DEPTH_MICRO,
        now_ms(),
        judging_end,
    )
    .into_iter()
    .map(|i| format!("{i:?}"))
    .collect()
}

/// List every catalog market the ledger doesn't know yet and that passes the listing rules
/// (retries until the signer is there).
async fn list_markets(
    tx: mpsc::Sender<Cmd>,
    shared: Arc<Shared>,
    m: PublicKey,
    params: MarketParams,
    catalog: BTreeMap<H32, (MarketInfo, Listing)>,
    mirror: Arc<Mirror>,
) {
    for (id, (info, l)) in catalog {
        let known = shared
            .markets
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&id);
        if !known {
            let issues = listing_check(&mirror, &info, &l).await;
            if !issues.is_empty() {
                tracing::warn!(slug = %info.slug, ?issues, "not listed: the listing rules keep it out");
                continue;
            }
        }
        loop {
            let known = shared
                .markets
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&id);
            if known {
                break;
            }
            let entry = MarketEntry {
                id,
                params,
                event_start_ms: l.event_start_ms.or(info.event_start_ms),
                end_ms: l.end_ms.or(info.end_ms).unwrap_or(u64::MAX),
                pool: Pool::default(),
                status: MarketStatus::Open,
            };
            match op(
                &tx,
                Op::ListMarket {
                    entry,
                    keysets: outcome_ids(&m, id),
                },
            )
            .await
            {
                Ok(()) => {
                    tracing::info!(slug = %info.slug, "market listed");
                    break;
                }
                Err(e) if e == Reject::NotConfirmed.to_string() => {
                    tracing::error!(
                        slug = %info.slug,
                        "the signer refuses the listing: its parameters aren't the signer's network's (BB_NETWORK must match on both)"
                    );
                    break;
                }
                Err(e) => {
                    tracing::warn!(slug = %info.slug, error = %e, "listing waits for the signer");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    }
}

/// Keep `closed` / `acceptingOrders` fresh from Gamma.
async fn refresh_catalog(http: reqwest::Client, shared: Arc<Shared>, slugs: Vec<String>) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        for slug in &slugs {
            if let Ok(info) = gamma::fetch_market(&http, slug).await
                && let Some(id) = H32::parse(&info.condition_id)
            {
                shared
                    .catalog
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(id, info);
            }
        }
    }
}

/// After a market's end, read its payout from Polygon every 5 minutes; settle when both RPCs
/// agree (MARKETS "Settlement").
async fn resolver(http: reqwest::Client, tx: mpsc::Sender<Cmd>, shared: Arc<Shared>) {
    let poly = PolygonReader::new(http, DEFAULT_RPCS.iter().map(|s| s.to_string()).collect());
    let mut tick = tokio::time::interval(Duration::from_secs(300));
    loop {
        tick.tick().await;
        let due: Vec<H32> = shared
            .markets
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|m| m.status == MarketStatus::Open && m.end_ms <= now_ms())
            .map(|m| m.id)
            .collect();
        for id in due {
            match poly.settle(&format!("0x{id}")).await {
                Ok(Settlement::Final { den, num, readings }) => {
                    let block = readings.iter().map(|r| r.block).max().unwrap_or(0);
                    let tx_hash = poly
                        .resolution_tx(DEFAULT_RPCS[0], &format!("0x{id}"), block, 3)
                        .await
                        .ok()
                        .flatten()
                        .map(|(_, h)| h);
                    let r = op(
                        &tx,
                        Op::Resolve {
                            market: id,
                            den,
                            num,
                            polygon_block: block,
                            polygon_tx: tx_hash,
                        },
                    )
                    .await;
                    tracing::info!(market = %id, ?num, den, result = ?r, "resolved from Polygon");
                }
                Ok(Settlement::Disagree { readings }) => {
                    tracing::error!(market = %id, ?readings, "Polygon RPCs disagree; not settling");
                }
                Ok(Settlement::Pending { .. }) => {}
                Err(e) => tracing::warn!(market = %id, error = %e, "resolver read failed"),
            }
        }
    }
}

/// Directives appended to every log filter so the HTTP stack can't log requests.
const NO_REQUEST_LOGS: &str = "tower_http=off,hyper=off,hyper_util=off,axum=off,h2=off";

#[tokio::main]
async fn main() -> Result<(), String> {
    // Whatever RUST_LOG says, the HTTP stack never logs a request: no line, path, header or
    // address (THREAT_MODEL N2). The handlers themselves never see an address.
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into());
    let filter = format!("{filter},{NO_REQUEST_LOGS}");
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(&filter))
        .init();
    tracing::info!("request logging is off: no addresses, paths or bodies are ever logged");
    let data = PathBuf::from(env_or("BB_DATA", "data"));
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let m = PublicKey::from_hex(env_or("BB_M", "").trim()).map_err(|_| "BB_M must be M in hex")?;
    let params = match env_or("BB_NETWORK", "testnet").as_str() {
        "mainnet" => MarketParams::mainnet(),
        _ => MarketParams::testnet(),
    };
    let listings: Vec<Listing> = match std::env::var("BB_MARKETS") {
        Ok(p) => serde_json::from_slice(&std::fs::read(&p).map_err(|e| format!("{p}: {e}"))?)
            .map_err(|e| format!("{p}: {e}"))?,
        Err(_) => Vec::new(),
    };
    let http = http_client().map_err(|e| e.to_string())?;
    let catalog = load_catalog(&http, &listings, &data.join("catalog.json")).await;
    tracing::info!(markets = catalog.len(), "catalog loaded");

    let feeds: Vec<MarketFeed> = catalog
        .values()
        .map(|(info, _)| MarketFeed {
            condition_id: info.condition_id.clone(),
            tokens: info.token_ids.clone(),
            guard_micro: DEFAULT_GUARD_SHARES,
        })
        .collect();
    let mirror = Arc::new(Mirror::start(
        MirrorConfig {
            proxy: proxy_from_env(),
            ..MirrorConfig::default()
        },
        feeds,
    ));
    let catalog_flags: Arc<RwLock<BTreeMap<H32, MarketInfo>>> = Arc::new(RwLock::new(
        catalog
            .iter()
            .map(|(id, (i, _))| (*id, i.clone()))
            .collect(),
    ));
    let shared_slot: Arc<RwLock<Option<Arc<Shared>>>> = Arc::default();
    let refs: RefFn = {
        let mirror = mirror.clone();
        let slot = shared_slot.clone();
        let flags = catalog_flags.clone();
        Arc::new(move |id: &H32| {
            let reference = mirror
                .snapshot(&format!("0x{id}"))
                .unwrap_or_else(|| RefSnapshot::empty(now_ms()));
            // Prefer the refreshed catalog in Shared; fall back to the one loaded at start.
            let info = slot
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .and_then(|s| {
                    s.catalog
                        .read()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(id)
                        .cloned()
                })
                .or_else(|| {
                    flags
                        .read()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(id)
                        .cloned()
                });
            MarketInputs {
                reference,
                closed: info.as_ref().is_some_and(|i| i.closed),
                accepting_orders: info.as_ref().is_some_and(|i| i.accepting_orders),
            }
        })
    };

    // The reserve's viewing key, for anyone to check the reserve on-chain (PROTOCOL section 8).
    if let Ok(path) = std::env::var("BB_RESERVE_UFVK") {
        let ufvk = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
        let birthday: u64 = env_num("BB_RESERVE_BIRTHDAY", 0);
        let public = data.join("public").join("v1");
        std::fs::create_dir_all(&public).map_err(|e| e.to_string())?;
        let body = serde_json::json!({
            "ufvk": ufvk.trim(),
            "birthday": birthday,
            "network": env_or("BB_ZCASH_NET", "test"),
        });
        std::fs::write(public.join("reserve.json"), body.to_string()).map_err(|e| e.to_string())?;
    }

    let desk = match std::env::var("BB_UIVK") {
        Ok(path) => {
            let net = blindbook_indexer::Net::parse(&env_or("BB_ZCASH_NET", "test"))?;
            let uivk = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
            let keys = Arc::new(
                blindbook_indexer::DepositKeys::from_uivk(net, &uivk).map_err(|e| e.to_string())?,
            );
            let (caps, denominations) = match env_or("BB_NETWORK", "testnet").as_str() {
                "mainnet" => (
                    blindbook_api::topup::ZeroConfCaps {
                        per_topup: 500,
                        total: 1_000,
                    },
                    blindbook_api::topup::DENOMINATIONS_MAINNET.to_vec(),
                ),
                _ => (
                    blindbook_api::topup::ZeroConfCaps {
                        per_topup: 10_000,
                        total: 30_000,
                    },
                    blindbook_api::topup::DENOMINATIONS_TESTNET.to_vec(),
                ),
            };
            let book = blindbook_api::topup::TopupBook::open(&data.join("topups.json"), caps)
                .map_err(|e| e.to_string())?;
            Some(blindbook_api::topup::Desk {
                keys,
                book: Arc::new(std::sync::Mutex::new(book)),
                denominations,
            })
        }
        Err(_) => None,
    };

    let running = start(
        StartConfig {
            data_dir: data.clone(),
            m,
            pow: PowBits {
                light: env_num("BB_POW_LIGHT", 16) as u32,
                heavy: env_num("BB_POW_HEAVY", 20) as u32,
            },
            voucher_units: env_num("BB_VOUCHER_UNITS", 50_000),
            signer_token: std::env::var("BB_SIGNER_TOKEN")
                .ok()
                .filter(|t| t.len() >= 32),
            topup: desk.clone(),
        },
        None,
        refs,
        catalog_flags
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
    )
    .map_err(|e| e.to_string())?;
    *shared_slot.write().unwrap_or_else(|e| e.into_inner()) = Some(running.shared.clone());

    tokio::spawn(list_markets(
        running.tx.clone(),
        running.shared.clone(),
        m,
        params,
        catalog,
        mirror.clone(),
    ));
    tokio::spawn(refresh_catalog(
        http.clone(),
        running.shared.clone(),
        listings.iter().map(|l| l.slug.clone()).collect(),
    ));
    tokio::spawn(resolver(
        http.clone(),
        running.tx.clone(),
        running.shared.clone(),
    ));
    if let Some(desk) = desk {
        let server = env_or("BB_LWD", "zecrocks");
        let scanned = desk
            .book
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .scanned_height;
        let from = if scanned > 0 {
            scanned + 1
        } else {
            // First start: a little history, so nothing paid just before is missed.
            let mut c = blindbook_indexer::follow::connect(&server)
                .await
                .map_err(|e| e.to_string())?;
            blindbook_indexer::follow::tip(&mut c)
                .await
                .map_err(|e| e.to_string())?
                .saturating_sub(20)
        };
        tracing::info!(%server, from, "indexer following the chain");
        let rx = blindbook_indexer::follow(desk.keys.clone(), server, from, Duration::from_secs(2));
        tokio::spawn(blindbook_api::topup::run_chain(
            rx,
            running.tx.clone(),
            desk.book.clone(),
        ));
    } else if let Some(secs) = std::env::var("BB_DEV_BLOCK_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        let tx = running.tx.clone();
        let shared = running.shared.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(secs.max(1)));
            tick.tick().await;
            loop {
                tick.tick().await;
                let h = shared.head.read().unwrap_or_else(|e| e.into_inner()).height;
                let _ = tx
                    .send(Cmd::Close {
                        height: h + 1,
                        chain: ChainStats::default(),
                    })
                    .await;
            }
        });
    }

    let listen = env_or("BB_LISTEN", "127.0.0.1:8080");
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .map_err(|e| format!("{listen}: {e}"))?;
    tracing::info!(%listen, m = %m.to_hex(), "API listening");
    axum::serve(listener, running.router)
        .await
        .map_err(|e| e.to_string())
}
