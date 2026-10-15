//! Feed state without I/O: local books for every subscribed token, and the health of each.
//!
//! **Health, not activity** (PROTOCOL section 5.2, `spikes/e-polymarket`): a quiet market isn't a
//! stale reference. A token's reference is unhealthy from the moment any of these starts:
//!
//! - its connection is down, or delivered nothing (not even a `PONG`) for `dead_after_ms`;
//! - no valid `book` snapshot since the connection (re)opened;
//! - the local book disagrees with the best prices Polymarket attaches to each `price_change`,
//!   or is crossed: a missed or reordered delta. In the 5-minute capture this happened in 0.27%
//!   of changes and healed within 14 ms in 99% of cases; it lasted over 0.1 s twice.
//!
//! The engine halts a market once its reference has been unhealthy for more than 10 s. A shard
//! is resynced (reconnected, which brings fresh snapshots) when one of its books stays
//! inconsistent for `resync_after_ms`, so a real gap is repaired well before the halt.
//!
//! Times are milliseconds on one monotonic clock chosen by the caller.

use std::collections::HashMap;

use crate::book::Book;
use crate::fixed::{PPM, price_ppm, size_micro};
use crate::msg::{BookMsg, Event, PriceChangeMsg, ResolvedMsg};

#[derive(Clone, Copy, Debug)]
pub struct HealthConfig {
    /// A connection that delivered nothing for this long is dead. We PING every 3 s, so this is
    /// two missed `PONG`s; with a ~1 s reconnect a dead connection recovers before the 10 s halt.
    pub dead_after_ms: u64,
    /// Resync a shard when one of its books has been inconsistent this long.
    pub resync_after_ms: u64,
    /// Resync a shard when a token still has no snapshot this long after connecting.
    pub snapshot_timeout_ms: u64,
    /// Minimum time between two resyncs of the same shard (a dead connection is always redone).
    pub resync_interval_ms: u64,
}

impl Default for HealthConfig {
    fn default() -> Self {
        HealthConfig {
            dead_after_ms: 6_000,
            resync_after_ms: 1_000,
            snapshot_timeout_ms: 5_000,
            resync_interval_ms: 10_000,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resync {
    Dead { silent_ms: u64 },
    Inconsistent { asset_id: String, for_ms: u64 },
    NoSnapshot { asset_id: String },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeedStats {
    pub frames: u64,
    pub events: u64,
    pub snapshots: u64,
    pub changes: u64,
    /// Price changes after which the book disagreed with Polymarket's best prices or was crossed.
    pub inconsistent: u64,
    pub malformed: u64,
    pub unknown_asset: u64,
    pub connects: u64,
    pub resyncs: u64,
}

#[derive(Debug)]
struct TokenState {
    shard: usize,
    book: Book,
    /// No valid snapshot since this time (startup or the moment the connection dropped).
    no_snapshot_since: Option<u64>,
    /// The book has disagreed with Polymarket's best prices, or been crossed, since this time.
    inconsistent_since: Option<u64>,
    /// Polymarket's timestamp (ms) of the last event applied to this book.
    server_ts_ms: u64,
    /// Connections in a row redone for a missing snapshot while this book still sent none.
    missed: u32,
}

/// A book that sent no snapshot over this many connections in a row is taken as gone from
/// Polymarket (a market closed or resolved there): it stays subscribed and unhealthy, but no longer
/// makes its connection start over every few seconds, which would cut the feed of every other
/// market on it. A snapshot that does come puts it back.
const GONE_AFTER: u32 = 3;

#[derive(Debug)]
struct ShardState {
    assets: Vec<String>,
    connected: bool,
    /// Connected at, or disconnected at.
    since_ms: u64,
    last_rx_ms: u64,
    last_resync_ms: Option<u64>,
}

#[derive(Debug)]
pub struct Feed {
    cfg: HealthConfig,
    tokens: HashMap<String, TokenState>,
    shards: Vec<ShardState>,
    resolved: Vec<ResolvedMsg>,
    pub stats: FeedStats,
}

/// Best bid and best ask, `None` for an empty side.
type Top = (Option<u32>, Option<u32>);

/// Polymarket's best prices: bid "0" means no bid; ask "0" or "1" means no ask.
fn reported_best(bid: Option<&str>, ask: Option<&str>) -> Option<Top> {
    let bid = price_ppm(bid?)?;
    let ask = price_ppm(ask?)?;
    Some((
        (bid > 0).then_some(bid),
        (ask > 0 && ask < PPM).then_some(ask),
    ))
}

impl Feed {
    /// `shards[i]` lists the asset ids carried by connection `i`.
    pub fn new(shards: Vec<Vec<String>>, now_ms: u64, cfg: HealthConfig) -> Self {
        let mut tokens = HashMap::new();
        for (i, assets) in shards.iter().enumerate() {
            for a in assets {
                tokens.insert(
                    a.clone(),
                    TokenState {
                        shard: i,
                        book: Book::default(),
                        no_snapshot_since: Some(now_ms),
                        inconsistent_since: None,
                        server_ts_ms: 0,
                        missed: 0,
                    },
                );
            }
        }
        let shards = shards
            .into_iter()
            .map(|assets| ShardState {
                assets,
                connected: false,
                since_ms: now_ms,
                last_rx_ms: now_ms,
                last_resync_ms: None,
            })
            .collect();
        Feed {
            cfg,
            tokens,
            shards,
            resolved: Vec::new(),
            stats: FeedStats::default(),
        }
    }

    pub fn shard_count(&self) -> usize {
        self.shards.len()
    }

    pub fn shard_assets(&self, shard: usize) -> &[String] {
        &self.shards[shard].assets
    }

    pub fn on_connected(&mut self, shard: usize, now_ms: u64) {
        let sh = &mut self.shards[shard];
        sh.connected = true;
        sh.since_ms = now_ms;
        sh.last_rx_ms = now_ms;
        self.stats.connects += 1;
        for a in &self.shards[shard].assets {
            if let Some(t) = self.tokens.get_mut(a) {
                t.no_snapshot_since.get_or_insert(now_ms);
                // The old book is replaced by the coming snapshot.
                t.inconsistent_since = None;
            }
        }
    }

    pub fn on_disconnected(&mut self, shard: usize, now_ms: u64) {
        let dead_after = self.cfg.dead_after_ms;
        let sh = &mut self.shards[shard];
        // A connection that went silent was already unhealthy when it fell silent.
        let from = if now_ms.saturating_sub(sh.last_rx_ms) > dead_after {
            sh.last_rx_ms
        } else {
            now_ms
        };
        sh.connected = false;
        sh.since_ms = from;
        for a in &self.shards[shard].assets {
            if let Some(t) = self.tokens.get_mut(a) {
                t.no_snapshot_since.get_or_insert(from);
            }
        }
    }

    /// Any frame from the connection, `PONG` included.
    pub fn on_frame(&mut self, shard: usize, now_ms: u64) {
        self.shards[shard].last_rx_ms = now_ms;
        self.stats.frames += 1;
    }

    pub fn apply(&mut self, shard: usize, ev: Event, now_ms: u64) {
        self.stats.events += 1;
        match ev {
            Event::Book(b) => self.apply_book(shard, b, now_ms),
            Event::PriceChange(p) => self.apply_changes(shard, p, now_ms),
            Event::MarketResolved(r) => {
                if !self.resolved.iter().any(|x| x.market == r.market) {
                    self.resolved.push(r);
                }
            }
            Event::Other => {}
        }
    }

    fn token_mut(&mut self, shard: usize, asset: &str) -> Option<&mut TokenState> {
        match self.tokens.get_mut(asset) {
            Some(t) if t.shard == shard => Some(t),
            _ => {
                self.stats.unknown_asset += 1;
                None
            }
        }
    }

    fn apply_book(&mut self, shard: usize, b: BookMsg, now_ms: u64) {
        let parse = |levels: &[crate::msg::Level]| -> Option<Vec<(u32, u64)>> {
            levels
                .iter()
                .map(|l| Some((price_ppm(&l.price)?, size_micro(&l.size)?)))
                .collect()
        };
        let parsed = parse(&b.bids).zip(parse(&b.asks));
        let server_ts = b.timestamp.parse().unwrap_or(0);
        let Some(t) = self.token_mut(shard, &b.asset_id) else {
            return;
        };
        let Some((bids, asks)) = parsed else {
            t.inconsistent_since.get_or_insert(now_ms);
            self.stats.malformed += 1;
            return;
        };
        t.book = Book::from_levels(bids, asks);
        t.server_ts_ms = server_ts;
        t.no_snapshot_since = None;
        t.missed = 0;
        if t.book.is_crossed() {
            t.inconsistent_since.get_or_insert(now_ms);
        } else {
            t.inconsistent_since = None;
        }
        self.stats.snapshots += 1;
    }

    fn apply_changes(&mut self, shard: usize, p: PriceChangeMsg, now_ms: u64) {
        let server_ts = p.timestamp.parse().unwrap_or(0);
        // Polymarket's best prices after the message, per asset (the last change carries them).
        let mut touched: Vec<(String, Option<Top>)> = Vec::new();
        for c in &p.price_changes {
            self.stats.changes += 1;
            let parsed = c
                .book_side()
                .zip(price_ppm(&c.price))
                .zip(size_micro(&c.size));
            let Some(t) = self.token_mut(shard, &c.asset_id) else {
                continue;
            };
            match parsed {
                Some(((side, price), size)) => {
                    t.book.set(side, price, size);
                    t.server_ts_ms = t.server_ts_ms.max(server_ts);
                }
                None => {
                    t.inconsistent_since.get_or_insert(now_ms);
                    self.stats.malformed += 1;
                    continue;
                }
            }
            let reported = reported_best(c.best_bid.as_deref(), c.best_ask.as_deref());
            match touched.iter_mut().find(|(a, _)| *a == c.asset_id) {
                Some(entry) => entry.1 = reported.or(entry.1),
                None => touched.push((c.asset_id.clone(), reported)),
            }
        }
        for (asset, reported) in touched {
            let Some(t) = self.tokens.get_mut(&asset) else {
                continue;
            };
            let local = (t.book.best_bid(), t.book.best_ask());
            let consistent = !t.book.is_crossed() && reported.is_none_or(|r| r == local);
            if consistent {
                t.inconsistent_since = None;
            } else {
                t.inconsistent_since.get_or_insert(now_ms);
                self.stats.inconsistent += 1;
            }
        }
    }

    /// `market_resolved` events seen since the last call.
    pub fn take_resolved(&mut self) -> Vec<ResolvedMsg> {
        std::mem::take(&mut self.resolved)
    }

    /// Since when this token's reference has been unhealthy, or `None` if it is healthy now.
    /// An asset the feed doesn't carry has never been healthy (`Some(0)`).
    pub fn unhealthy_since(&self, asset: &str, now_ms: u64) -> Option<u64> {
        let Some(t) = self.tokens.get(asset) else {
            return Some(0);
        };
        let sh = &self.shards[t.shard];
        let shard_bad = if !sh.connected {
            Some(sh.since_ms)
        } else if now_ms.saturating_sub(sh.last_rx_ms) > self.cfg.dead_after_ms {
            Some(sh.last_rx_ms)
        } else {
            None
        };
        [shard_bad, t.no_snapshot_since, t.inconsistent_since]
            .into_iter()
            .flatten()
            .min()
    }

    /// How long the token's reference has been unhealthy (0 if healthy).
    pub fn unhealthy_ms(&self, asset: &str, now_ms: u64) -> u64 {
        self.unhealthy_since(asset, now_ms)
            .map_or(0, |s| now_ms.saturating_sub(s))
    }

    /// Whether the shard's connection should be redone now, and why. Records the resync.
    pub fn shard_needs_resync(&mut self, shard: usize, now_ms: u64) -> Option<Resync> {
        let cfg = self.cfg;
        let sh = &self.shards[shard];
        if !sh.connected {
            return None;
        }
        let silent = now_ms.saturating_sub(sh.last_rx_ms);
        let why = if silent > cfg.dead_after_ms {
            Some(Resync::Dead { silent_ms: silent })
        } else if sh
            .last_resync_ms
            .is_some_and(|t| now_ms.saturating_sub(t) < cfg.resync_interval_ms)
        {
            None
        } else {
            let connected_for = now_ms.saturating_sub(sh.since_ms);
            sh.assets.iter().find_map(|a| {
                let t = self.tokens.get(a)?;
                if let Some(s) = t.inconsistent_since {
                    let for_ms = now_ms.saturating_sub(s);
                    if for_ms >= cfg.resync_after_ms {
                        return Some(Resync::Inconsistent {
                            asset_id: a.clone(),
                            for_ms,
                        });
                    }
                }
                (t.no_snapshot_since.is_some()
                    && t.missed < GONE_AFTER
                    && connected_for >= cfg.snapshot_timeout_ms)
                    .then(|| Resync::NoSnapshot {
                        asset_id: a.clone(),
                    })
            })
        };
        if why.is_some() {
            self.shards[shard].last_resync_ms = Some(now_ms);
            self.stats.resyncs += 1;
        }
        if matches!(why, Some(Resync::NoSnapshot { .. })) {
            for a in &self.shards[shard].assets {
                if let Some(t) = self.tokens.get_mut(a)
                    && t.no_snapshot_since.is_some()
                {
                    t.missed += 1;
                }
            }
        }
        why
    }

    pub fn book(&self, asset: &str) -> Option<&Book> {
        self.tokens.get(asset).map(|t| &t.book)
    }

    /// Whether this token's book holds a snapshot (it is empty until the first one arrives).
    pub fn has_snapshot(&self, asset: &str) -> bool {
        self.tokens
            .get(asset)
            .is_some_and(|t| t.no_snapshot_since.is_none())
    }

    /// Polymarket's timestamp of the last event applied to this token's book.
    pub fn server_ts_ms(&self, asset: &str) -> u64 {
        self.tokens.get(asset).map_or(0, |t| t.server_ts_ms)
    }

    pub fn is_connected(&self, shard: usize) -> bool {
        self.shards[shard].connected
    }
}

/// Split assets over connections of at most `per_shard` assets, keeping a market's two tokens
/// on the same connection (Polymarket sends both sides of a market in one `price_change`).
pub fn plan_shards(markets: &[[String; 2]], per_shard: usize) -> Vec<Vec<String>> {
    let per_market = (per_shard / 2).max(1);
    markets
        .chunks(per_market)
        .map(|c| c.iter().flat_map(|m| m.iter().cloned()).collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msg::{Change, Level};

    fn lv(p: &str, s: &str) -> Level {
        Level {
            price: p.into(),
            size: s.into(),
        }
    }

    fn book_ev(asset: &str) -> Event {
        Event::Book(BookMsg {
            market: "m".into(),
            asset_id: asset.into(),
            timestamp: "1000".into(),
            bids: vec![lv("0.60", "100"), lv("0.61", "50")],
            asks: vec![lv("0.63", "70"), lv("0.62", "40")],
        })
    }

    fn change(asset: &str, price: &str, size: &str, side: &str, bb: &str, ba: &str) -> Event {
        Event::PriceChange(PriceChangeMsg {
            market: "m".into(),
            timestamp: "2000".into(),
            price_changes: vec![Change {
                asset_id: asset.into(),
                price: price.into(),
                size: size.into(),
                side: side.into(),
                best_bid: Some(bb.into()),
                best_ask: Some(ba.into()),
            }],
        })
    }

    fn feed() -> Feed {
        Feed::new(
            vec![vec!["a".into(), "b".into()]],
            0,
            HealthConfig::default(),
        )
    }

    #[test]
    fn unhealthy_until_connected_and_snapshotted() {
        let mut f = feed();
        assert_eq!(f.unhealthy_since("a", 100), Some(0));
        f.on_connected(0, 500);
        assert_eq!(f.unhealthy_since("a", 600), Some(0), "still no snapshot");
        f.on_frame(0, 700);
        f.apply(0, book_ev("a"), 700);
        assert_eq!(f.unhealthy_since("a", 800), None);
        assert_eq!(f.unhealthy_since("b", 800), Some(0));
        assert_eq!(f.unhealthy_since("zzz", 800), Some(0), "unknown asset");
        assert_eq!(f.book("a").unwrap().mid_ppm(), Some(615_000));
        assert_eq!(f.server_ts_ms("a"), 1000);
    }

    #[test]
    fn consistent_changes_keep_it_healthy_and_gaps_are_caught() {
        let mut f = feed();
        f.on_connected(0, 0);
        f.apply(0, book_ev("a"), 10);
        f.apply(0, change("a", "0.615", "5", "BUY", "0.615", "0.62"), 20);
        assert_eq!(f.unhealthy_since("a", 30), None);
        assert_eq!(f.book("a").unwrap().best_bid(), Some(615_000));
        assert_eq!(f.server_ts_ms("a"), 2000);
        // Polymarket says the best ask is 0.63: we missed the removal of 0.62.
        f.apply(0, change("a", "0.60", "90", "BUY", "0.615", "0.63"), 40);
        assert_eq!(f.unhealthy_since("a", 50), Some(40));
        assert_eq!(f.stats.inconsistent, 1);
        // The next consistent change heals it (out-of-order delivery, the common case).
        f.apply(0, change("a", "0.62", "0", "SELL", "0.615", "0.63"), 45);
        assert_eq!(f.unhealthy_since("a", 50), None);
    }

    #[test]
    fn crossed_book_is_unhealthy() {
        let mut f = feed();
        f.on_connected(0, 0);
        f.apply(0, book_ev("a"), 0);
        // No reported best prices: only the crossed check applies.
        f.apply(
            0,
            Event::PriceChange(PriceChangeMsg {
                market: "m".into(),
                timestamp: "3".into(),
                price_changes: vec![Change {
                    asset_id: "a".into(),
                    price: "0.65".into(),
                    size: "1".into(),
                    side: "BUY".into(),
                    best_bid: None,
                    best_ask: None,
                }],
            }),
            5,
        );
        assert_eq!(f.unhealthy_since("a", 6), Some(5));
    }

    #[test]
    fn persistent_gap_triggers_one_resync_then_waits() {
        let mut f = feed();
        f.on_connected(0, 0);
        f.apply(0, book_ev("a"), 0);
        f.apply(0, book_ev("b"), 0);
        f.on_frame(0, 100);
        f.apply(0, change("a", "0.60", "90", "BUY", "0.61", "0.99"), 100);
        assert_eq!(f.shard_needs_resync(0, 900), None, "may still heal");
        assert_eq!(
            f.shard_needs_resync(0, 1_100),
            Some(Resync::Inconsistent {
                asset_id: "a".into(),
                for_ms: 1_000
            })
        );
        f.on_frame(0, 1_200);
        assert_eq!(f.shard_needs_resync(0, 1_300), None, "rate limited");
        assert_eq!(f.stats.resyncs, 1);
    }

    #[test]
    fn a_book_gone_from_polymarket_stops_forcing_reconnects() {
        // "b" never sends a snapshot (its market closed on Polymarket): its connection is redone
        // GONE_AFTER times, then left alone; "a" keeps its feed. A late snapshot puts "b" back.
        let mut f = feed();
        let mut t = 0;
        for round in 0..GONE_AFTER {
            f.on_connected(0, t);
            f.apply(0, book_ev("a"), t + 100);
            f.on_frame(0, t + 5_000);
            assert_eq!(
                f.shard_needs_resync(0, t + 5_000),
                Some(Resync::NoSnapshot {
                    asset_id: "b".into()
                }),
                "round {round}"
            );
            f.on_disconnected(0, t + 5_001);
            t += 11_000;
        }
        f.on_connected(0, t);
        f.apply(0, book_ev("a"), t + 100);
        f.on_frame(0, t + 5_000);
        assert_eq!(
            f.shard_needs_resync(0, t + 5_000),
            None,
            "b is taken as gone"
        );
        f.on_frame(0, t + 30_000);
        assert_eq!(f.shard_needs_resync(0, t + 30_000), None);
        assert!(
            f.unhealthy_since("b", t + 30_000).is_some(),
            "still unhealthy"
        );
        assert_eq!(f.unhealthy_since("a", t + 30_000), None);
        // A snapshot after all: b is healthy and counted again.
        f.apply(0, book_ev("b"), t + 31_000);
        assert_eq!(f.unhealthy_since("b", t + 31_000), None);
        assert_eq!(f.tokens["b"].missed, 0);
    }

    #[test]
    fn missing_snapshot_triggers_resync() {
        let mut f = feed();
        f.on_connected(0, 0);
        f.apply(0, book_ev("a"), 100);
        f.on_frame(0, 4_000);
        assert_eq!(f.shard_needs_resync(0, 4_000), None);
        f.on_frame(0, 5_000);
        assert_eq!(
            f.shard_needs_resync(0, 5_000),
            Some(Resync::NoSnapshot {
                asset_id: "b".into()
            })
        );
    }

    #[test]
    fn silence_and_disconnects() {
        let mut f = feed();
        f.on_connected(0, 0);
        f.apply(0, book_ev("a"), 0);
        f.on_frame(0, 1_000);
        assert_eq!(f.unhealthy_since("a", 7_000), None);
        // Nothing for 6 s: dead since the last frame.
        assert_eq!(f.unhealthy_since("a", 7_001), Some(1_000));
        assert_eq!(
            f.shard_needs_resync(0, 7_001),
            Some(Resync::Dead { silent_ms: 6_001 })
        );
        f.on_disconnected(0, 7_100);
        assert_eq!(f.unhealthy_ms("a", 10_000), 9_000);
        f.on_connected(0, 10_000);
        assert_eq!(
            f.unhealthy_since("a", 10_500),
            Some(1_000),
            "until a snapshot"
        );
        f.apply(0, book_ev("a"), 10_600);
        assert_eq!(f.unhealthy_since("a", 10_700), None);
        // A clean disconnect counts from the moment it happened.
        f.on_frame(0, 11_000);
        f.on_disconnected(0, 11_000);
        assert_eq!(f.unhealthy_since("a", 12_000), Some(11_000));
    }

    #[test]
    fn malformed_and_foreign_events() {
        let mut f = feed();
        f.on_connected(0, 0);
        f.apply(0, book_ev("a"), 0);
        f.apply(0, change("a", "0.6x", "1", "BUY", "0.61", "0.62"), 10);
        assert_eq!(f.stats.malformed, 1);
        assert_eq!(f.unhealthy_since("a", 20), Some(10));
        f.apply(0, change("other", "0.5", "1", "BUY", "0.5", "0.6"), 10);
        assert_eq!(f.stats.unknown_asset, 1);
    }

    #[test]
    fn shards_keep_market_pairs_together() {
        let m = |i: u32| [format!("{i}a"), format!("{i}b")];
        let plan = plan_shards(&[m(1), m(2), m(3)], 4);
        assert_eq!(plan, vec![vec!["1a", "1b", "2a", "2b"], vec!["3a", "3b"]]);
    }
}
