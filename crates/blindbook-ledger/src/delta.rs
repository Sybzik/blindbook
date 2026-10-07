//! The public log (PROTOCOL section 8): one delta per block, hash-chained and anchored on-chain.
//!
//! `root = SHA256(prev_root ‖ SHA256(canonical JSON of the delta))`. Issued signatures and spent
//! `Y`s are sorted inside each delta, so their order says nothing about which request they came
//! from or when in the block it arrived.

use serde::{Deserialize, Serialize};

use crate::Error;
use crate::canonical::{hash_record, sha256_parts};
use crate::hex::H32;
use crate::ledger::{BatchRecord, MarketParams};
use crate::wire::Dleq;

pub const DELTA_VERSION: u32 = 1;
/// `prev_root` of the first delta.
pub const GENESIS_ROOT: H32 = H32([0; 32]);

/// One blind signature in the public issuance log: what zero-query restore searches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssuedRecord {
    pub id: String,
    pub amount: u64,
    #[serde(rename = "B_")]
    pub b: String,
    #[serde(rename = "C_")]
    pub c: String,
    pub dleq: Dleq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LogEvent {
    MarketListed {
        market: H32,
        params: MarketParams,
        event_start_ms: Option<u64>,
        end_ms: u64,
        /// Keyset ids of outcome A and B.
        keysets: [String; 2],
    },
    /// A top-up credited as CREDIT (a standard denomination).
    TopupCredited {
        amount: u64,
    },
    /// A judge voucher exchanged for CREDIT.
    VoucherRedeemed {
        amount: u64,
    },
    Redeemed {
        market: H32,
        outcome: u8,
        shares: u64,
        paid: u64,
    },
    /// A withdrawal waiting for the next payout transaction; the address stays sealed.
    WithdrawalQueued {
        commitment: H32,
        amount: u64,
    },
    PayoutSent {
        txid: String,
        commitments: Vec<H32>,
    },
    Resolved {
        market: H32,
        den: u64,
        num: [u64; 2],
        polygon_block: u64,
        polygon_tx: Option<String>,
    },
    /// The previous root, written into a Zcash memo `bb1:anchor:<height>:<root-hex>`.
    Anchored {
        txid: String,
        root: H32,
    },
}

/// Public chain statistics for the block (Block Radio).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainStats {
    pub shielded_actions: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Delta {
    pub v: u32,
    pub seq: u64,
    /// Zcash height the delta closes at.
    pub height: u64,
    pub prev_root: H32,
    pub batches: Vec<BatchRecord>,
    pub issued: Vec<IssuedRecord>,
    pub spent: Vec<String>,
    pub events: Vec<LogEvent>,
    pub chain: ChainStats,
}

impl Delta {
    /// SHA-256 of the canonical bytes.
    pub fn digest(&self) -> Result<[u8; 32], Error> {
        hash_record(self)
    }

    /// The root after this delta.
    pub fn root(&self) -> Result<H32, Error> {
        Ok(H32(sha256_parts(&[&self.prev_root.0, &self.digest()?])))
    }
}

/// `GET /v1/head`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Head {
    pub height: u64,
    pub seq: u64,
    pub root: H32,
}

/// Collects one block's records, then closes them into the next delta of the chain.
#[derive(Clone, Debug)]
pub struct LogBuilder {
    pub head: Head,
    batches: Vec<BatchRecord>,
    issued: Vec<IssuedRecord>,
    spent: Vec<String>,
    events: Vec<LogEvent>,
}

impl LogBuilder {
    /// Continue the chain after `head` (`Head { seq: 0, root: GENESIS_ROOT, .. }` to start).
    pub fn new(head: Head) -> Self {
        LogBuilder {
            head,
            batches: Vec::new(),
            issued: Vec::new(),
            spent: Vec::new(),
            events: Vec::new(),
        }
    }

    pub fn batch(&mut self, r: BatchRecord) {
        self.batches.push(r);
    }

    pub fn issued(&mut self, r: IssuedRecord) {
        self.issued.push(r);
    }

    pub fn spent(&mut self, ys: impl IntoIterator<Item = String>) {
        self.spent.extend(ys);
    }

    pub fn event(&mut self, e: LogEvent) {
        self.events.push(e);
    }

    /// Close the block: the delta and the new head.
    pub fn close(&mut self, height: u64, chain: ChainStats) -> Result<(Delta, Head), Error> {
        let mut issued = std::mem::take(&mut self.issued);
        issued.sort_by(|a, b| a.b.cmp(&b.b));
        let mut spent = std::mem::take(&mut self.spent);
        spent.sort();
        let delta = Delta {
            v: DELTA_VERSION,
            seq: self.head.seq + 1,
            height,
            prev_root: self.head.root,
            batches: std::mem::take(&mut self.batches),
            issued,
            spent,
            events: std::mem::take(&mut self.events),
            chain,
        };
        let head = Head {
            height,
            seq: delta.seq,
            root: delta.root()?,
        };
        self.head = head;
        Ok((delta, head))
    }
}

/// Check that a run of deltas forms one chain from `start` and return the final head.
pub fn verify_chain(start: Head, deltas: &[Delta]) -> Result<Head, Error> {
    let mut head = start;
    for d in deltas {
        if d.seq != head.seq + 1 || d.prev_root != head.root || d.height < head.height {
            return Err(Error::Chain(format!(
                "delta {} doesn't follow head {} ({})",
                d.seq, head.seq, head.root
            )));
        }
        let mut issued = d.issued.clone();
        issued.sort_by(|a, b| a.b.cmp(&b.b));
        let mut spent = d.spent.clone();
        spent.sort();
        if issued != d.issued || spent != d.spent {
            return Err(Error::Chain(format!("delta {} isn't sorted", d.seq)));
        }
        head = Head {
            height: d.height,
            seq: d.seq,
            root: d.root()?,
        };
    }
    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(b: &str) -> IssuedRecord {
        IssuedRecord {
            id: "01aa".into(),
            amount: 4,
            b: b.into(),
            c: "02cc".into(),
            dleq: Dleq {
                e: "e".into(),
                s: "s".into(),
            },
        }
    }

    #[test]
    fn chain_of_deltas() {
        let start = Head {
            height: 100,
            seq: 0,
            root: GENESIS_ROOT,
        };
        let mut log = LogBuilder::new(start);
        log.issued(rec("03bb"));
        log.issued(rec("02aa"));
        log.spent(["03ff".to_string(), "02ee".to_string()]);
        log.event(LogEvent::TopupCredited { amount: 10_000 });
        let (d1, h1) = log.close(101, ChainStats::default()).unwrap();
        assert_eq!(d1.issued[0].b, "02aa", "sorted by B_");
        assert_eq!(d1.spent, vec!["02ee", "03ff"]);
        assert_eq!(h1.seq, 1);
        let (d2, h2) = log
            .close(
                102,
                ChainStats {
                    shielded_actions: 7,
                },
            )
            .unwrap();
        assert_eq!(d2.prev_root, h1.root);
        assert_eq!(verify_chain(start, &[d1.clone(), d2.clone()]).unwrap(), h2);
        // Any change breaks the chain from there on.
        let mut bad = d1.clone();
        bad.events.push(LogEvent::TopupCredited { amount: 1 });
        assert!(verify_chain(start, &[bad, d2.clone()]).is_err());
        assert!(verify_chain(start, &[d2]).is_err());
        // Root is SHA256(prev_root ‖ SHA256(canonical delta)).
        let digest = crate::canonical::sha256(&crate::canonical::to_canonical(&d1).unwrap());
        assert_eq!(h1.root.0, sha256_parts(&[&GENESIS_ROOT.0, &digest]));
    }
}
