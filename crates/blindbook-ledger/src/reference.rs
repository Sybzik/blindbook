//! The reference snapshot each batch records and prices from (PROTOCOL section 1, "Reference
//! snapshot"). The server builds it from Polymarket's live books (`blindbook-polymarket`); the
//! verifier only reads it, so it lives here, free of any network code.

use blindbook_engine::Reference;
use serde::{Deserialize, Serialize};

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

/// The normative anchor of a list of mid samples: their lower median.
pub fn anchor_of(samples: &[u32]) -> Option<u32> {
    let mut s = samples.to_vec();
    blindbook_engine::median_ppm(&mut s)
}

impl RefSnapshot {
    /// A snapshot with no data at all: every market priced from it halts.
    pub fn empty(at_ms: u64) -> Self {
        RefSnapshot {
            at_ms,
            mid_samples: Vec::new(),
            mid_ppm: 0,
            ask_ppm: [blindbook_engine::PPM; 2],
            bid_ppm: [0; 2],
            guard_micro: 0,
            best_bid_ppm: [0; 2],
            best_ask_ppm: [0; 2],
            server_ts_ms: [0; 2],
            unhealthy_ms: u64::MAX,
        }
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
    use blindbook_engine::{HaltReason, Params, Schedule, halt_reason};

    #[test]
    fn empty_snapshot_halts() {
        let r = RefSnapshot::empty(0).to_engine(false, true);
        assert_eq!(
            halt_reason(&Params::testnet(), &r, &Schedule::open()),
            Some(HaltReason::BadQuote)
        );
        assert!(RefSnapshot::empty(0).anchor_matches());
    }

    #[test]
    fn anchor_is_the_lower_median() {
        assert_eq!(anchor_of(&[3, 1, 2]), Some(2));
        assert_eq!(anchor_of(&[4, 1, 3, 2]), Some(2));
        assert_eq!(anchor_of(&[]), None);
    }
}
