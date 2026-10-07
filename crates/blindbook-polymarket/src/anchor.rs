//! The anchor: the **lower median** of outcome A's Polymarket mid, sampled once a second over the
//! last 30 s (PROTOCOL section 1). Samples are only taken while the reference is healthy.

use std::collections::VecDeque;

pub const WINDOW_MS: u64 = 30_000;
pub const SAMPLE_EVERY_MS: u64 = 1_000;

#[derive(Clone, Debug, Default)]
pub struct MidWindow {
    samples: VecDeque<(u64, u32)>,
}

impl MidWindow {
    pub fn push(&mut self, now_ms: u64, mid_ppm: u32) {
        self.samples.push_back((now_ms, mid_ppm));
        self.prune(now_ms);
    }

    /// Drop samples older than the window: keep `t > now − 30 s`.
    pub fn prune(&mut self, now_ms: u64) {
        while let Some(&(t, _)) = self.samples.front() {
            if t + WINDOW_MS <= now_ms {
                self.samples.pop_front();
            } else {
                break;
            }
        }
    }

    /// The samples inside the window, oldest first: what the public log records.
    pub fn samples(&self, now_ms: u64) -> Vec<u32> {
        self.samples
            .iter()
            .filter(|(t, _)| t + WINDOW_MS > now_ms && *t <= now_ms)
            .map(|&(_, m)| m)
            .collect()
    }

    /// The anchor, or `None` without a single healthy sample in the window.
    pub fn anchor(&self, now_ms: u64) -> Option<u32> {
        anchor_of(&self.samples(now_ms))
    }
}

pub use blindbook_ledger::reference::anchor_of;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lower_median_over_30_seconds() {
        let mut w = MidWindow::default();
        assert_eq!(w.anchor(0), None);
        for (i, m) in [600_000, 610_000, 590_000, 700_000].into_iter().enumerate() {
            w.push(i as u64 * 1_000, m);
        }
        // sorted 590, 600, 610, 700 → lower median 600
        assert_eq!(w.anchor(3_000), Some(600_000));
        assert_eq!(w.samples(3_000), vec![600_000, 610_000, 590_000, 700_000]);
        // At 30.5 s the first sample (t = 0) has left the window: 590, 610, 700 → 610.
        assert_eq!(w.anchor(30_500), Some(610_000));
        // Everything expires.
        assert_eq!(w.anchor(34_000), None);
    }

    #[test]
    fn a_spoofed_spike_moves_nothing() {
        let mut w = MidWindow::default();
        for i in 0..30u64 {
            w.push(i * 1_000, 600_000 + (i as u32 % 3) * 1_000);
        }
        let before = w.anchor(29_000);
        // Five seconds of a fake 0.99 mid.
        for i in 30..35u64 {
            w.push(i * 1_000, 990_000);
        }
        assert_eq!(w.samples(34_000).len(), 30);
        assert_eq!(w.anchor(34_000), before);
        assert_eq!(before, Some(601_000));
    }

    #[test]
    fn anchor_of_is_the_engine_median() {
        assert_eq!(anchor_of(&[3, 1, 2]), Some(2));
        assert_eq!(anchor_of(&[4, 1, 3, 2]), Some(2));
        assert_eq!(anchor_of(&[]), None);
    }
}
