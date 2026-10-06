//! The per-batch reference snapshot: what each 2-second batch records in the public log and
//! hands to the engine (MARKETS "Live reference, anchor and guard", PROTOCOL sections 1 and 5).

use blindbook_engine::Reference;
use serde::{Deserialize, Serialize};

use crate::anchor::{MidWindow, anchor_of};
use crate::feed::Feed;
use crate::fixed::{MICRO, PPM};

/// Default guard depth: 500 shares (≈ $250 at 50¢), recorded per market at listing. On Oct 7,
/// across 49 open pre-match markets in the listing band, the 500-share price was at the top of
/// the book in the median case and within 0.94¢ of it for 90% of markets; dust orders (tens of
/// shares) can't move it.
pub const DEFAULT_GUARD_SHARES: u64 = 500 * MICRO;

/// What the mirror needs to know about one listed market.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketFeed {
    /// Polymarket's `conditionId` (0x-prefixed hex): our market id.
    pub condition_id: String,
    /// CLOB token ids of outcome A (index 0) and B (index 1).
    pub tokens: [String; 2],
    /// Guard depth in micro-shares.
    pub guard_micro: u64,
}

/// One market's reference at one batch. Prices in ppm; 0 means "none" (and halts the market).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefSnapshot {
    /// Unix ms when the snapshot was taken.
    pub at_ms: u64,
    /// Outcome A's mid samples in the last 30 s, oldest first. `mid_ppm` is their lower median.
    pub mid_samples: Vec<u32>,
    pub mid_ppm: u32,
    /// Average price to buy `guard_micro` shares of each outcome on Polymarket's book.
    pub ask_ppm: [u32; 2],
    /// Average price to sell `guard_micro` shares of each outcome.
    pub bid_ppm: [u32; 2],
    pub guard_micro: u64,
    /// Top of book per outcome, for auditors comparing with Polymarket's price history.
    pub best_bid_ppm: [u32; 2],
    pub best_ask_ppm: [u32; 2],
    /// Polymarket's timestamp of the last event in each outcome's book.
    pub server_ts_ms: [u64; 2],
    /// How long the reference has been unhealthy (0 = healthy); the engine halts above 10 s.
    pub unhealthy_ms: u64,
}

impl RefSnapshot {
    /// Build the snapshot from the live feed. `now_ms` is the feed's monotonic clock, `wall_ms`
    /// the Unix time recorded in the log.
    pub fn take(
        feed: &Feed,
        window: &MidWindow,
        m: &MarketFeed,
        now_ms: u64,
        wall_ms: u64,
    ) -> Self {
        let mut s = RefSnapshot {
            at_ms: wall_ms,
            mid_samples: window.samples(now_ms),
            mid_ppm: 0,
            ask_ppm: [PPM; 2],
            bid_ppm: [0; 2],
            guard_micro: m.guard_micro,
            best_bid_ppm: [0; 2],
            best_ask_ppm: [0; 2],
            server_ts_ms: [0; 2],
            unhealthy_ms: 0,
        };
        s.mid_ppm = anchor_of(&s.mid_samples).unwrap_or(0);
        for (i, token) in m.tokens.iter().enumerate() {
            if let Some(b) = feed.book(token) {
                s.ask_ppm[i] = b.buy_avg_ppm(m.guard_micro);
                s.bid_ppm[i] = b.sell_avg_ppm(m.guard_micro);
                s.best_bid_ppm[i] = b.best_bid().unwrap_or(0);
                s.best_ask_ppm[i] = b.best_ask().unwrap_or(0);
            }
            s.server_ts_ms[i] = feed.server_ts_ms(token);
            s.unhealthy_ms = s.unhealthy_ms.max(feed.unhealthy_ms(token, now_ms));
        }
        s
    }

    /// The engine's input. `closed` / `accepting_orders` come from the catalog and from
    /// `market_resolved` events.
    pub fn to_engine(&self, closed: bool, accepting_orders: bool) -> Reference {
        Reference {
            mid_ppm: self.mid_ppm,
            ask_ppm: self.ask_ppm,
            bid_ppm: self.bid_ppm,
            age_ms: self.unhealthy_ms,
            closed,
            accepting_orders,
        }
    }

    /// Recompute the anchor from the recorded samples (what the verifier does).
    pub fn anchor_matches(&self) -> bool {
        anchor_of(&self.mid_samples).unwrap_or(0) == self.mid_ppm
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feed::HealthConfig;
    use crate::msg::{BookMsg, Event, Level};
    use blindbook_engine::{HaltReason, Params, Schedule, halt_reason};

    fn lv(p: &str, s: &str) -> Level {
        Level {
            price: p.into(),
            size: s.into(),
        }
    }

    fn market() -> MarketFeed {
        MarketFeed {
            condition_id: "0xabc".into(),
            tokens: ["A".into(), "B".into()],
            guard_micro: 1_000 * MICRO,
        }
    }

    fn live_feed() -> Feed {
        let mut f = Feed::new(
            vec![vec!["A".into(), "B".into()]],
            0,
            HealthConfig::default(),
        );
        f.on_connected(0, 0);
        let book = |asset: &str, bids: Vec<Level>, asks: Vec<Level>| {
            Event::Book(BookMsg {
                market: "0xabc".into(),
                asset_id: asset.into(),
                timestamp: "1791272078414".into(),
                bids,
                asks,
            })
        };
        // Mirrored books: A 0.61 / 0.62, B 0.38 / 0.39.
        f.apply(
            0,
            book(
                "A",
                vec![lv("0.60", "5000"), lv("0.61", "600")],
                vec![lv("0.62", "800"), lv("0.63", "5000")],
            ),
            0,
        );
        f.apply(
            0,
            book(
                "B",
                vec![lv("0.37", "5000"), lv("0.38", "800")],
                vec![lv("0.39", "600"), lv("0.40", "5000")],
            ),
            0,
        );
        f
    }

    #[test]
    fn snapshot_and_engine_reference() {
        let mut f = live_feed();
        f.on_frame(0, 9_000);
        let mut w = MidWindow::default();
        for t in 0..10 {
            w.push(t * 1_000, 615_000);
        }
        let s = RefSnapshot::take(&f, &w, &market(), 9_500, 1_791_272_100_000);
        assert_eq!(s.mid_ppm, 615_000);
        assert!(s.anchor_matches());
        // 1,000 shares of A: 800 @ 0.62 + 200 @ 0.63 = 0.622; selling: 600 @ 0.61 + 400 @ 0.60.
        assert_eq!(s.ask_ppm, [622_000, 394_000]);
        assert_eq!(s.bid_ppm, [606_000, 378_000]);
        assert_eq!(s.ask_ppm[0], PPM - s.bid_ppm[1], "mirrored");
        assert_eq!(s.best_bid_ppm, [610_000, 380_000]);
        assert_eq!(s.best_ask_ppm, [620_000, 390_000]);
        assert_eq!(s.unhealthy_ms, 0);
        assert_eq!(s.server_ts_ms, [1_791_272_078_414; 2]);
        let r = s.to_engine(false, true);
        assert_eq!(halt_reason(&Params::testnet(), &r, &Schedule::open()), None);
        // Round trip through the log format.
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(serde_json::from_str::<RefSnapshot>(&json).unwrap(), s);
    }

    #[test]
    fn no_samples_or_no_book_halts() {
        let f = live_feed();
        let s = RefSnapshot::take(&f, &MidWindow::default(), &market(), 0, 0);
        let r = s.to_engine(false, true);
        assert_eq!(
            halt_reason(&Params::testnet(), &r, &Schedule::open()),
            Some(HaltReason::BadQuote)
        );
        let empty = Feed::new(
            vec![vec!["A".into(), "B".into()]],
            0,
            HealthConfig::default(),
        );
        let mut w = MidWindow::default();
        w.push(0, 500_000);
        let s = RefSnapshot::take(&empty, &w, &market(), 20_000, 0);
        assert_eq!(s.ask_ppm, [PPM; 2]);
        assert_eq!(s.bid_ppm, [0; 2]);
        assert_eq!(s.unhealthy_ms, 20_000);
    }

    #[test]
    fn unhealthy_feed_goes_stale_after_10_s() {
        let mut f = live_feed();
        let mut w = MidWindow::default();
        w.push(20_000, 615_000);
        f.on_frame(0, 12_000);
        f.on_disconnected(0, 12_000);
        let p = Params::testnet();
        let at = |now| RefSnapshot::take(&f, &w, &market(), now, 0).to_engine(false, true);
        assert_eq!(halt_reason(&p, &at(22_000), &Schedule::open()), None);
        assert_eq!(
            halt_reason(&p, &at(22_001), &Schedule::open()),
            Some(HaltReason::StaleReference)
        );
    }
}
