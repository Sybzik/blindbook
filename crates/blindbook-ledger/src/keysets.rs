//! Which keyset a keyset id belongs to. The caller fills the registry from the mint master key
//! (`blindbook-mint` derives every id from the pinned `M`), so this crate needs no curve code.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::hex::H32;

/// Units per denomination: a slip holds 2^k units, k = 0..=30 (PROTOCOL section 1).
pub const MAX_DENOMINATION: u64 = 1 << 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Keyset {
    /// The private balance.
    Credit,
    /// Shares of one outcome (0 = A, 1 = B) of one market.
    Outcome { market: H32, outcome: u8 },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeysetIds {
    by_id: HashMap<String, Keyset>,
    by_kind: HashMap<Keyset, String>,
}

impl KeysetIds {
    pub fn insert(&mut self, kind: Keyset, id: String) {
        self.by_kind.insert(kind, id.clone());
        self.by_id.insert(id, kind);
    }

    pub fn kind(&self, id: &str) -> Option<Keyset> {
        self.by_id.get(id).copied()
    }

    pub fn id(&self, kind: Keyset) -> Option<&str> {
        self.by_kind.get(&kind).map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }
}

/// Whether `amount` is a slip denomination 2^k, k ≤ 30.
pub fn is_denomination(amount: u64) -> bool {
    amount.is_power_of_two() && amount <= MAX_DENOMINATION
}

/// Split an amount into denominations, smallest first (its binary digits). Amounts below 2^31
/// need at most 31 slips, which is why every blank output list has 31 entries.
pub fn split(amount: u64) -> Vec<u64> {
    (0..64)
        .map(|k| 1u64 << k)
        .filter(|bit| amount & bit != 0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denominations() {
        assert!(is_denomination(1) && is_denomination(1 << 30));
        assert!(!is_denomination(0) && !is_denomination(3) && !is_denomination(1 << 31));
        assert_eq!(split(0), Vec::<u64>::new());
        assert_eq!(split(13), vec![1, 4, 8]);
        assert_eq!(split((1 << 31) - 1).len(), 31);
        assert_eq!(split(20_000).iter().sum::<u64>(), 20_000);
    }

    #[test]
    fn registry() {
        let mut r = KeysetIds::default();
        let a = Keyset::Outcome {
            market: H32([1; 32]),
            outcome: 0,
        };
        r.insert(Keyset::Credit, "01aa".into());
        r.insert(a, "01bb".into());
        assert_eq!(r.kind("01bb"), Some(a));
        assert_eq!(r.id(Keyset::Credit), Some("01aa"));
        assert_eq!(r.kind("01cc"), None);
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            format!(
                r#"{{"kind":"outcome","market":"{}","outcome":0}}"#,
                H32([1; 32])
            )
        );
    }
}
