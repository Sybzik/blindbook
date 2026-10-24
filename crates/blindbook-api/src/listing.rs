//! Which markets the API lists (docs/MARKETS.md "Listing").
//!
//! - The operator's markets file (`BB_MARKETS`) is read at start and then once a minute: a market
//!   added to it is listed without a restart.
//! - With `BB_AUTO_LIST=N`, the API keeps at least N markets open for trading by listing
//!   Polymarket's own candidates (`blindbook-api candidates`, the ones that pass every rule with
//!   Gamma's own event start: matches and games), at most 2N unresolved at a time. They are kept
//!   in `<BB_DATA>/auto-markets.json`, so a restart lists them again.
//!
//! Every new market gets its own live mirror of Polymarket's books, so the markets already listed
//! keep their feed untouched; every listing passes the rules on the live book, and the signer
//! still checks its parameters.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use blindbook_api::outcome_ids;
use blindbook_api::sequencer::{Cmd, Shared, now_ms};
use blindbook_ledger::H32;
use blindbook_ledger::ledger::{MarketEntry, MarketParams, MarketStatus, Pool, Reject};
use blindbook_ledger::ops::Op;
use blindbook_ledger::reference::RefSnapshot;
use blindbook_mint::cashu::PublicKey;
use blindbook_polymarket::book::Book;
use blindbook_polymarket::mirror::{Mirror, MirrorConfig};
use blindbook_polymarket::reference::{DEFAULT_GUARD_SHARES, MarketFeed};
use blindbook_polymarket::{MarketInfo, gamma};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::{JUDGING_END_MS, candidates, env_num, op};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Listing {
    pub slug: String,
    /// When trading halts, if Gamma has no `gameStartTime` / `eventStartTime`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_start_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<u64>,
}

/// How often the markets file is read again, and auto-listing looks for a gap.
const FOLLOW_EVERY: Duration = Duration::from_secs(60);
/// A market auto-listing picks must open for trading at least this long.
const AUTO_MIN_OPEN_MS: u64 = 60 * 60 * 1000;
/// A market counts as open for trading while its event start is at least this far ahead.
const OPEN_MARGIN_MS: u64 = 15 * 60 * 1000;
/// A slug Gamma doesn't give (a typo, a market not live yet, Gamma down) is tried every minute
/// this many times, then once an hour.
const MAX_TRIES: u32 = 10;

/// The markets file plus the auto-listed markets.
pub fn read_listings(file: Option<&Path>, auto: &Path) -> Result<Vec<Listing>, String> {
    let mut out: Vec<Listing> = match file {
        Some(p) => {
            serde_json::from_slice(&std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?)
                .map_err(|e| format!("{}: {e}", p.display()))?
        }
        None => Vec::new(),
    };
    if let Ok(bytes) = std::fs::read(auto)
        && let Ok(more) = serde_json::from_slice::<Vec<Listing>>(&bytes)
    {
        out.extend(more);
    }
    Ok(out)
}

/// Fetch the catalog entries of these slugs; fall back to the cached copy per market. The cache
/// keeps every market ever fetched.
pub async fn load_catalog(
    http: &reqwest::Client,
    listings: &[Listing],
    cache: &Path,
) -> BTreeMap<H32, (MarketInfo, Listing)> {
    let mut cached: BTreeMap<String, MarketInfo> = std::fs::read(cache)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut out = BTreeMap::new();
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
        cached.insert(l.slug.clone(), info.clone());
        out.insert(id, (info, l.clone()));
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&cached) {
        let _ = std::fs::write(cache, bytes);
    }
    out
}

pub fn feeds(catalog: &BTreeMap<H32, (MarketInfo, Listing)>) -> Vec<MarketFeed> {
    catalog
        .values()
        .map(|(info, _)| MarketFeed {
            condition_id: info.condition_id.clone(),
            tokens: info.token_ids.clone(),
            guard_micro: DEFAULT_GUARD_SHARES,
        })
        .collect()
}

/// The live mirrors: one for the markets known at start, one more for each batch added later.
pub struct Mirrors {
    cfg: MirrorConfig,
    set: RwLock<Vec<Arc<Mirror>>>,
}

impl Mirrors {
    pub fn new(cfg: MirrorConfig) -> Self {
        Mirrors {
            cfg,
            set: RwLock::default(),
        }
    }

    /// Start mirroring these markets (must run inside the Tokio runtime).
    pub fn add(&self, feeds: Vec<MarketFeed>) {
        if feeds.is_empty() {
            return;
        }
        let mirror = Arc::new(Mirror::start(self.cfg.clone(), feeds));
        self.set
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .push(mirror);
    }

    pub fn snapshot(&self, condition_id: &str) -> Option<RefSnapshot> {
        let set = self.set.read().unwrap_or_else(|e| e.into_inner());
        set.iter().rev().find_map(|m| m.snapshot(condition_id))
    }

    pub fn book(&self, condition_id: &str, outcome: usize) -> Option<Book> {
        let set = self.set.read().unwrap_or_else(|e| e.into_inner());
        set.iter().rev().find_map(|m| m.book(condition_id, outcome))
    }
}

/// The listing rules (MARKETS "Listing") on the live book: wait up to a minute for outcome A's
/// snapshot, then return what keeps the market out (empty: list it). An event start entered in
/// the markets file stands in for Polymarket's.
async fn listing_check(mirrors: &Mirrors, info: &MarketInfo, l: &Listing) -> Vec<String> {
    let mut book = None;
    for _ in 0..60 {
        book = mirrors.book(&info.condition_id, 0);
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
    gamma::listing_issues(
        &info,
        &book,
        gamma::LISTING_DEPTH_MICRO,
        now_ms(),
        judging_end,
    )
    .into_iter()
    .map(|i| format!("{i:?}"))
    .collect()
}

/// List every catalog market the ledger doesn't know yet and that passes the listing rules
/// (retries until the signer is there).
pub async fn list_markets(
    tx: mpsc::Sender<Cmd>,
    shared: Arc<Shared>,
    m: PublicKey,
    params: MarketParams,
    catalog: BTreeMap<H32, (MarketInfo, Listing)>,
    mirrors: Arc<Mirrors>,
) {
    let known = |id: &H32| {
        shared
            .markets
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(id)
    };
    for (id, (info, l)) in catalog {
        if !known(&id) {
            let issues = listing_check(&mirrors, &info, &l).await;
            if !issues.is_empty() {
                tracing::warn!(slug = %info.slug, ?issues, "not listed: the listing rules keep it out");
                continue;
            }
        }
        while !known(&id) {
            let entry = MarketEntry {
                id,
                params,
                event_start_ms: l.event_start_ms.or(info.event_start_ms),
                end_ms: l.end_ms.or(info.end_ms).unwrap_or(u64::MAX),
                pool: Pool::default(),
                status: MarketStatus::Open,
            };
            let listed = Op::ListMarket {
                entry,
                keysets: outcome_ids(&m, id),
            };
            match op(&tx, listed).await {
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

/// The catalog's slugs, all of them or only those of markets not resolved yet.
fn catalog_slugs(shared: &Shared, unresolved_only: bool) -> Vec<String> {
    let catalog = shared.catalog.read().unwrap_or_else(|e| e.into_inner());
    let markets = shared.markets.read().unwrap_or_else(|e| e.into_inner());
    catalog
        .iter()
        .filter(|(id, _)| {
            !unresolved_only
                || markets
                    .get(id)
                    .is_none_or(|m| m.status == MarketStatus::Open)
        })
        .map(|(_, info)| info.slug.clone())
        .collect()
}

/// Keep `closed` / `acceptingOrders` fresh from Gamma, for every market not resolved yet.
pub async fn refresh_catalog(http: reqwest::Client, shared: Arc<Shared>) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        for slug in &catalog_slugs(&shared, true) {
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

/// Everything [`follow`] needs.
pub struct Follow {
    pub http: reqwest::Client,
    pub tx: mpsc::Sender<Cmd>,
    pub shared: Arc<Shared>,
    pub m: PublicKey,
    pub params: MarketParams,
    pub mirrors: Arc<Mirrors>,
    pub file: Option<PathBuf>,
    pub auto_file: PathBuf,
    pub cache: PathBuf,
    /// `BB_AUTO_LIST`: markets to keep open for trading (0: off).
    pub auto_target: usize,
    /// The listings read at start (checked by then).
    pub initial: Vec<Listing>,
}

/// Read the markets file again every minute: list what's new, check again an entry the operator
/// changed for a market that isn't listed yet (an event start added, say), and keep the
/// auto-listed markets topped up. A listed market's schedule is fixed in the log at listing.
pub async fn follow(f: Follow) {
    let mut tick = tokio::time::interval(FOLLOW_EVERY);
    tick.tick().await;
    let entry = |l: &Listing| serde_json::to_string(l).unwrap_or_default();
    // The entry each slug was last checked with, and the failed tries of slugs Gamma doesn't know.
    let mut checked: HashMap<String, String> = f
        .initial
        .iter()
        .map(|l| (l.slug.clone(), entry(l)))
        .collect();
    let mut tries: HashMap<String, u32> = HashMap::new();
    loop {
        tick.tick().await;
        let mut wanted = match read_listings(f.file.as_deref(), &f.auto_file) {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(error = %e, "markets file unreadable; keeping the markets listed so far");
                continue;
            }
        };
        if f.auto_target > 0 {
            wanted.extend(auto_pick(&f).await);
        }
        let mut seen = BTreeSet::new();
        wanted.retain(|l| seen.insert(l.slug.clone()));
        let in_catalog: HashMap<String, (H32, MarketInfo)> = f
            .shared
            .catalog
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(id, i)| (i.slug.clone(), (*id, i.clone())))
            .collect();
        let listed: BTreeSet<H32> = f
            .shared
            .markets
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .collect();
        let mut again = BTreeMap::new();
        let mut new = Vec::new();
        for l in wanted {
            match in_catalog.get(&l.slug) {
                Some((id, info)) => {
                    if !listed.contains(id) && checked.get(&l.slug) != Some(&entry(&l)) {
                        checked.insert(l.slug.clone(), entry(&l));
                        again.insert(*id, (info.clone(), l));
                    }
                }
                None => {
                    let n = tries.entry(l.slug.clone()).or_default();
                    if *n < MAX_TRIES || n.is_multiple_of(60) {
                        new.push(l);
                    }
                    *n += 1;
                }
            }
        }
        if !again.is_empty() {
            tracing::info!(
                markets = again.len(),
                "changed entries in the markets file; checking the listing rules again"
            );
            tokio::spawn(list_markets(
                f.tx.clone(),
                f.shared.clone(),
                f.m,
                f.params,
                again,
                f.mirrors.clone(),
            ));
        }
        if new.is_empty() {
            continue;
        }
        let added = load_catalog(&f.http, &new, &f.cache).await;
        for l in &new {
            if added.values().any(|(_, a)| a.slug == l.slug) {
                checked.insert(l.slug.clone(), entry(l));
                tries.remove(&l.slug);
            } else if tries.get(&l.slug) == Some(&MAX_TRIES) {
                tracing::error!(slug = %l.slug, "Gamma doesn't give this market; trying once an hour from now");
            }
        }
        if added.is_empty() {
            continue;
        }
        {
            let mut catalog = f.shared.catalog.write().unwrap_or_else(|e| e.into_inner());
            for (id, (info, _)) in &added {
                catalog.insert(*id, info.clone());
            }
        }
        tracing::info!(
            markets = added.len(),
            "new markets in the catalog; checking the listing rules"
        );
        f.mirrors.add(feeds(&added));
        tokio::spawn(list_markets(
            f.tx.clone(),
            f.shared.clone(),
            f.m,
            f.params,
            added,
            f.mirrors.clone(),
        ));
    }
}

/// `BB_AUTO_LIST`: when fewer than the target are open for trading, pick candidates that pass
/// every rule with Gamma's own event start and open for at least an hour, and remember them.
async fn auto_pick(f: &Follow) -> Vec<Listing> {
    let now = now_ms();
    let (tradeable, unresolved) = {
        let markets = f.shared.markets.read().unwrap_or_else(|e| e.into_inner());
        let open: Vec<_> = markets
            .values()
            .filter(|m| m.status == MarketStatus::Open)
            .collect();
        let tradeable = open
            .iter()
            .filter(|m| m.end_ms > now && m.event_start_ms.is_none_or(|t| t > now + OPEN_MARGIN_MS))
            .count();
        (tradeable, open.len())
    };
    // Picks still waiting to be listed (the signer away, say) count as open, so a pass while they
    // wait picks no more; one the rules keep out stops counting once its event has started.
    let pending = {
        let markets = f.shared.markets.read().unwrap_or_else(|e| e.into_inner());
        let catalog = f.shared.catalog.read().unwrap_or_else(|e| e.into_inner());
        let by_slug: HashMap<&str, (&H32, &MarketInfo)> = catalog
            .iter()
            .map(|(id, i)| (i.slug.as_str(), (id, i)))
            .collect();
        std::fs::read(&f.auto_file)
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<Listing>>(&b).ok())
            .unwrap_or_default()
            .iter()
            .filter(|l| match by_slug.get(l.slug.as_str()) {
                Some((id, info)) => {
                    !markets.contains_key(*id) && info.event_start_ms.is_none_or(|t| t > now)
                }
                None => true,
            })
            .count()
    };
    let need = f
        .auto_target
        .saturating_sub(tradeable + pending)
        .min((2 * f.auto_target).saturating_sub(unresolved + pending));
    if need == 0 {
        return Vec::new();
    }
    let known: BTreeSet<String> = catalog_slugs(&f.shared, false).into_iter().collect();
    let judging_end = env_num("BB_JUDGING_END_MS", JUDGING_END_MS);
    let found =
        match candidates::find(&f.http, now, judging_end, need + known.len().min(50) + 5).await {
            Ok(found) => found,
            Err(e) => {
                tracing::warn!(error = %e, "auto-listing: Polymarket's catalog unavailable");
                return Vec::new();
            }
        };
    let picked: Vec<Listing> = found
        .ready
        .into_iter()
        .filter(|(m, _)| {
            !known.contains(&m.slug)
                && m.event_start_ms
                    .is_some_and(|t| t >= now + AUTO_MIN_OPEN_MS)
        })
        .take(need)
        .map(|(m, _)| Listing {
            slug: m.slug,
            event_start_ms: None,
            end_ms: None,
        })
        .collect();
    if picked.is_empty() {
        return picked;
    }
    let mut kept: Vec<Listing> = std::fs::read(&f.auto_file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    kept.extend(picked.iter().cloned());
    if let Ok(bytes) = serde_json::to_vec_pretty(&kept) {
        let _ = std::fs::write(&f.auto_file, bytes);
    }
    tracing::info!(slugs = ?picked.iter().map(|l| &l.slug).collect::<Vec<_>>(), tradeable, "auto-listing markets");
    picked
}
