//! A local copy of one outcome token's Polymarket order book, built from `book` snapshots and
//! `price_change` deltas, and the depth-aware quotes the guard uses (PROTOCOL section 1).

use std::collections::BTreeMap;

use crate::fixed::PPM;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BookSide {
    /// Resting buy orders (Polymarket's `BUY` side).
    Bid,
    /// Resting sell orders (Polymarket's `SELL` side).
    Ask,
}

/// Price levels in ppm → resting size in micro-shares.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Book {
    bids: BTreeMap<u32, u64>,
    asks: BTreeMap<u32, u64>,
}

impl Book {
    /// A book from snapshot levels; zero-size levels are dropped.
    pub fn from_levels(
        bids: impl IntoIterator<Item = (u32, u64)>,
        asks: impl IntoIterator<Item = (u32, u64)>,
    ) -> Self {
        let keep = |(p, s): &(u32, u64)| *s > 0 && *p > 0 && *p < PPM;
        Book {
            bids: bids.into_iter().filter(keep).collect(),
            asks: asks.into_iter().filter(keep).collect(),
        }
    }

    /// Set a level's size (Polymarket deltas carry the new total size; 0 removes the level).
    pub fn set(&mut self, side: BookSide, price_ppm: u32, size_micro: u64) {
        let levels = match side {
            BookSide::Bid => &mut self.bids,
            BookSide::Ask => &mut self.asks,
        };
        if size_micro == 0 {
            levels.remove(&price_ppm);
        } else {
            levels.insert(price_ppm, size_micro);
        }
    }

    pub fn best_bid(&self) -> Option<u32> {
        self.bids.keys().next_back().copied()
    }

    pub fn best_ask(&self) -> Option<u32> {
        self.asks.keys().next().copied()
    }

    /// Bid at or above ask: never a valid state for long (a missed delta).
    pub fn is_crossed(&self) -> bool {
        matches!((self.best_bid(), self.best_ask()), (Some(b), Some(a)) if b >= a)
    }

    /// Top-of-book midpoint (rounded down), if both sides exist and the book isn't crossed.
    pub fn mid_ppm(&self) -> Option<u32> {
        match (self.best_bid(), self.best_ask()) {
            (Some(b), Some(a)) if b < a => Some(((u64::from(b) + u64::from(a)) / 2) as u32),
            _ => None,
        }
    }

    /// Average price per share to **buy** `q` micro-shares by walking the asks, rounded up.
    /// Whatever the asks can't fill is priced at 1.00, so a thin book makes the guard stricter
    /// instead of undefined (and an empty ask side quotes 1.00, which halts the market).
    pub fn buy_avg_ppm(&self, q_micro: u64) -> u32 {
        if q_micro == 0 {
            return self.best_ask().unwrap_or(PPM);
        }
        let mut left = q_micro;
        let mut cost: u128 = 0;
        for (&p, &s) in &self.asks {
            let take = s.min(left);
            cost += u128::from(p) * u128::from(take);
            left -= take;
            if left == 0 {
                break;
            }
        }
        cost += u128::from(PPM) * u128::from(left);
        cost.div_ceil(u128::from(q_micro)) as u32
    }

    /// Average price per share to **sell** `q` micro-shares by walking the bids, rounded down.
    /// Whatever the bids can't absorb is priced at 0.00 (an empty bid side quotes 0, which halts
    /// the market).
    pub fn sell_avg_ppm(&self, q_micro: u64) -> u32 {
        if q_micro == 0 {
            return self.best_bid().unwrap_or(0);
        }
        let mut left = q_micro;
        let mut proceeds: u128 = 0;
        for (&p, &s) in self.bids.iter().rev() {
            let take = s.min(left);
            proceeds += u128::from(p) * u128::from(take);
            left -= take;
            if left == 0 {
                break;
            }
        }
        (proceeds / u128::from(q_micro)) as u32
    }

    /// Number of price levels (bids, asks).
    pub fn depth(&self) -> (usize, usize) {
        (self.bids.len(), self.asks.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixed::MICRO;

    fn book() -> Book {
        // A sample `book` event captured live (best 3 levels).
        Book::from_levels(
            [
                (790_000, 46_133_150_000),
                (800_000, 63_029_620_000),
                (810_000, 51_485_680_000),
            ],
            [
                (840_000, 418_141_420_000),
                (830_000, 254_298_060_000),
                (820_000, 45_914_330_000),
            ],
        )
    }

    #[test]
    fn top_of_book() {
        let b = book();
        assert_eq!(b.best_bid(), Some(810_000));
        assert_eq!(b.best_ask(), Some(820_000));
        assert_eq!(b.mid_ppm(), Some(815_000));
        assert!(!b.is_crossed());
    }

    #[test]
    fn deltas() {
        let mut b = book();
        b.set(BookSide::Ask, 820_000, 0);
        assert_eq!(b.best_ask(), Some(830_000));
        b.set(BookSide::Bid, 825_000, 10 * MICRO);
        assert_eq!(b.best_bid(), Some(825_000));
        assert_eq!(b.mid_ppm(), Some(827_500));
        b.set(BookSide::Bid, 830_000, MICRO);
        assert!(b.is_crossed());
        assert_eq!(b.mid_ppm(), None);
    }

    #[test]
    fn depth_aware_quotes() {
        let b = book();
        // Inside the first level: exactly the top price.
        assert_eq!(b.buy_avg_ppm(1_000 * MICRO), 820_000);
        assert_eq!(b.sell_avg_ppm(1_000 * MICRO), 810_000);
        // 50,000 shares: 45,914.33 @ 0.82 + 4,085.67 @ 0.83 = 41,040.8567 → 0.820817134 → up.
        assert_eq!(b.buy_avg_ppm(50_000 * MICRO), 820_818);
        // 60,000 shares: 51,485.68 @ 0.81 + 8,514.32 @ 0.80 = 48,514.8568 → 0.808580946 → down.
        assert_eq!(b.sell_avg_ppm(60_000 * MICRO), 808_580);
    }

    #[test]
    fn thin_books_get_stricter_not_undefined() {
        let b = Book::from_levels([(400_000, 100 * MICRO)], [(600_000, 100 * MICRO)]);
        // Half the asks are missing: 100 @ 0.60 + 100 @ 1.00.
        assert_eq!(b.buy_avg_ppm(200 * MICRO), 800_000);
        // Half the bids are missing: 100 @ 0.40 + 100 @ 0.
        assert_eq!(b.sell_avg_ppm(200 * MICRO), 200_000);
        let empty = Book::default();
        assert_eq!(empty.buy_avg_ppm(MICRO), PPM);
        assert_eq!(empty.sell_avg_ppm(MICRO), 0);
        assert_eq!(empty.mid_ppm(), None);
    }

    #[test]
    fn mirrored_books_give_mirrored_quotes() {
        // A bid on A at p is an ask on B at 1 − p (Polymarket's CTF books are mirrored).
        let a = book();
        let b = Book::from_levels(
            [
                (160_000, 418_141_420_000),
                (170_000, 254_298_060_000),
                (180_000, 45_914_330_000),
            ],
            [
                (190_000, 51_485_680_000),
                (200_000, 63_029_620_000),
                (210_000, 46_133_150_000),
            ],
        );
        for q in [1u64, 1_000, 50_000, 200_000, 2_000_000] {
            let q = q * MICRO;
            let (ask_a, bid_b) = (a.buy_avg_ppm(q), b.sell_avg_ppm(q));
            assert_eq!(ask_a, PPM - bid_b, "ask_A = 1 − bid_B at {q}");
            let (bid_a, ask_b) = (a.sell_avg_ppm(q), b.buy_avg_ppm(q));
            assert_eq!(bid_a, PPM - ask_b, "bid_A = 1 − ask_B at {q}");
        }
    }
}
