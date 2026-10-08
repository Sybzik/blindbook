//! `GET /v1/history.json.gz`: the price history of every listed market, ours and Polymarket's, in
//! one file every visitor downloads (no client ever asks about one market). Sampled from the live
//! state once a minute and kept at three resolutions, one per chart range: one-minute samples for
//! the last two hours (1H), fifteen-minute samples for the last week (1D, 1W), two-hour samples
//! since listing (ALL). Kept in `<data>/history.json` across restarts.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use blindbook_ledger::H32;
use serde::{Deserialize, Serialize};

use crate::files::{gz, write_atomic};
use crate::sequencer::now_ms;

/// One sample: Unix minute, our price of outcome A and Polymarket's mid of A, in basis points.
pub type Point = [u64; 3];

const M1_KEEP: usize = 120;
const M15_KEEP: usize = 7 * 24 * 4;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Series {
    pub m1: VecDeque<Point>,
    pub m15: VecDeque<Point>,
    pub h2: Vec<Point>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    pub markets: BTreeMap<H32, Series>,
}

impl History {
    /// Add one minute's prices: `(market, ours_bp, reference_bp)`. A coarser series takes a
    /// sample once its interval has passed since its last one, so restarts leave no gaps.
    pub fn sample(&mut self, minute: u64, prices: &[(H32, u64, u64)]) {
        for &(id, ours, reference) in prices {
            let s = self.markets.entry(id).or_default();
            let p = [minute, ours, reference];
            let due =
                |last: Option<&Point>, every: u64| last.is_none_or(|q| minute >= q[0] + every);
            if due(s.m1.back(), 1) {
                s.m1.push_back(p);
                if s.m1.len() > M1_KEEP {
                    s.m1.pop_front();
                }
            }
            if due(s.m15.back(), 15) {
                s.m15.push_back(p);
                if s.m15.len() > M15_KEEP {
                    s.m15.pop_front();
                }
            }
            if due(s.h2.last(), 120) {
                s.h2.push(p);
            }
        }
    }
}

/// Our price and the reference of every market with a price in the live JSON.
fn prices(live: &[u8]) -> Vec<(H32, u64, u64)> {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(live) else {
        return Vec::new();
    };
    v["markets"]
        .as_array()
        .map(|ms| {
            ms.iter()
                .filter_map(|m| {
                    let id = H32::parse(m["id"].as_str()?)?;
                    let ours = m["price_a_ppm"].as_u64()?;
                    let reference = m["reference"]["mid_ppm"].as_u64()?;
                    Some((id, ours / 100, reference / 100))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("history.json")
}

pub fn load(data_dir: &Path) -> History {
    std::fs::read(state_path(data_dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Sample the live state once a minute; write the state and the public file.
pub async fn run(data_dir: PathBuf, live: Arc<RwLock<Vec<u8>>>) {
    let mut h = load(&data_dir);
    let public = data_dir.join("public").join("v1").join("history.json.gz");
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        let p = prices(&live.read().unwrap_or_else(|e| e.into_inner()));
        if p.is_empty() {
            continue;
        }
        h.sample(now_ms() / 60_000, &p);
        let Ok(json) = serde_json::to_vec(&h) else {
            continue;
        };
        let written = write_atomic(&state_path(&data_dir), &json)
            .and_then(|()| gz(&json))
            .and_then(|z| write_atomic(&public, &z));
        if let Err(e) = written {
            tracing::warn!(error = %e, "price history not written");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_resolutions() {
        let a = H32([1; 32]);
        let mut h = History::default();
        for minute in 0..3 * 24 * 60u64 {
            h.sample(minute, &[(a, 5_000 + minute % 7, 5_000)]);
        }
        let s = &h.markets[&a];
        assert_eq!(s.m1.len(), M1_KEEP);
        assert_eq!(s.m1.back().unwrap()[0], 3 * 24 * 60 - 1);
        assert_eq!(s.m15.len(), 3 * 24 * 4);
        assert!(
            s.m15
                .iter()
                .zip(s.m15.iter().skip(1))
                .all(|(p, q)| q[0] - p[0] == 15)
        );
        assert_eq!(s.h2.len(), 3 * 12);
        // The same minute twice adds nothing; after a gap, every series takes the next sample.
        let before = h.clone();
        h.sample(3 * 24 * 60 - 1, &[(a, 1, 1)]);
        assert_eq!(h, before);
        h.sample(10 * 24 * 60, &[(a, 7_000, 6_900)]);
        let s = &h.markets[&a];
        assert_eq!(*s.m1.back().unwrap(), [10 * 24 * 60, 7_000, 6_900]);
        assert_eq!(*s.m15.back().unwrap(), [10 * 24 * 60, 7_000, 6_900]);
        assert_eq!(*s.h2.last().unwrap(), [10 * 24 * 60, 7_000, 6_900]);
    }

    #[test]
    fn reads_the_live_json() {
        let id = H32([2; 32]);
        let live = serde_json::json!({ "markets": [
            { "id": id.to_string(), "price_a_ppm": 612_345, "reference": { "mid_ppm": 600_000 } },
            { "id": H32([3; 32]).to_string(), "price_a_ppm": null, "reference": { "mid_ppm": 0 } },
        ]});
        assert_eq!(
            prices(&serde_json::to_vec(&live).unwrap()),
            vec![(id, 6_123, 6_000)]
        );
    }
}
