//! An independent audit of Blindbook's public log (PROTOCOL section 8). Anyone can run it; it
//! needs only the published files and the pinned master public key `M`.
//!
//! Checks:
//! 1. the deltas form one hash chain from genesis to the head;
//! 2. every listed market's keyset ids are the ones derived from `M` (no hidden keys);
//! 3. every batch replays with the engine to the same fills and pool, each anchor equals the lower
//!    median of its recorded samples, and each market's pool carries over from batch to batch;
//! 4. every issued blind signature carries a DLEQ proof valid for the key derived from `M` for
//!    its keyset and amount (no slip can be tagged with a special key);
//! 5. per keyset, nothing was spent beyond what was issued; the outstanding supply is reported;
//! 6. at every reserve report, the reserve (plus top-ups not swept yet) covers the liabilities:
//!    CREDIT outstanding + per market the most either outcome can pay + withdrawals not paid
//!    yet + stakes held by open blind duels. The reserve figure itself is checkable on-chain with the public reserve viewing key.

use std::collections::BTreeMap;
use std::str::FromStr;

use blindbook_ledger::H32;
use blindbook_ledger::delta::{Delta, GENESIS_ROOT, Head, LogEvent, verify_chain};
use blindbook_ledger::ledger::Pool;
use blindbook_mint::cashu::nuts::nut12::BlindSignatureDleq;
use blindbook_mint::cashu::{Amount, BlindSignature, Id, PublicKey, SecretKey};
use blindbook_mint::{KeysetKind, PublicKeyset};

#[derive(Debug, Default)]
pub struct Report {
    pub deltas: u64,
    pub head: Option<Head>,
    pub batches: u64,
    pub orders: u64,
    pub signatures: u64,
    pub spent: u64,
    pub markets: u64,
    pub anchors: Vec<(String, H32)>,
    pub payouts: u64,
    /// Units issued, spent and outstanding per keyset id.
    pub supply: BTreeMap<String, (u64, u64)>,
    /// Liabilities at the end of the log, in zatoshi.
    pub liabilities_zat: u64,
    /// The last reserve report: (height, reserve, unswept top-ups) in zatoshi, and the
    /// liabilities at that point of the log.
    pub reserve: Option<(u64, u64, u64, u64)>,
    pub failures: Vec<String>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.failures.is_empty()
    }
}

fn kind_name(k: &KeysetKind) -> String {
    match k {
        KeysetKind::Credit => "CREDIT".into(),
        KeysetKind::Outcome { market_id, outcome } => {
            format!(
                "{}:{}",
                H32(*market_id),
                if *outcome == 0 { "A" } else { "B" }
            )
        }
    }
}

pub use blindbook_ledger::replay::replay_batch;

/// One unit of CREDIT or of a share is 0.00001 ZEC.
pub const ZAT_PER_UNIT: u64 = 1_000;

/// What the reserve owes, in zatoshi: CREDIT outstanding, per open market the most either
/// outcome can pay (only one wins; a 50-50 pays half of each, which is less), per resolved
/// market what its payout numerators say, and withdrawals queued but not paid yet.
pub fn liabilities(
    supply: &BTreeMap<String, (u64, u64)>,
    markets: &BTreeMap<H32, Pool>,
    resolved: &BTreeMap<H32, (u64, [u64; 2])>,
    queued: &BTreeMap<H32, u64>,
) -> u64 {
    let out = |k: &str| supply.get(k).map_or(0, |(i, s)| i.saturating_sub(*s));
    let mut units = out("CREDIT");
    for m in markets.keys() {
        let a = out(&format!("{m}:A"));
        let b = out(&format!("{m}:B"));
        units += match resolved.get(m) {
            Some((den, num)) if *den > 0 => (a as u128 * num[0] as u128
                + b as u128 * num[1] as u128)
                .div_ceil(*den as u128) as u64,
            _ => a.max(b),
        };
    }
    units += queued.values().sum::<u64>();
    units * ZAT_PER_UNIT
}

/// Audit a run of deltas against the head the server publishes.
pub fn audit(m: &PublicKey, deltas: &[Delta], head: Option<Head>) -> Report {
    let mut r = Report {
        deltas: deltas.len() as u64,
        head,
        ..Report::default()
    };
    match verify_chain(
        Head {
            height: 0,
            seq: 0,
            root: GENESIS_ROOT,
        },
        deltas,
    ) {
        Ok(end) => {
            if let Some(h) = head
                && (h.seq != end.seq || h.root != end.root)
            {
                r.failures.push(format!(
                    "head {} {} doesn't match the chain's end {} {}",
                    h.seq, h.root, end.seq, end.root
                ));
            }
        }
        Err(e) => r.failures.push(e.to_string()),
    }

    let credit = PublicKeyset::derive(m, KeysetKind::Credit).expect("derivable");
    let mut keysets: BTreeMap<String, PublicKeyset> = BTreeMap::new();
    keysets.insert(credit.id.to_string(), credit);
    let mut pools: BTreeMap<H32, Pool> = BTreeMap::new();
    let mut resolved: BTreeMap<H32, (u64, [u64; 2])> = BTreeMap::new();
    let mut queued: BTreeMap<H32, u64> = BTreeMap::new();
    let mut duels: BTreeMap<H32, u64> = BTreeMap::new();
    let mut reports: Vec<(u64, u64, u64)> = Vec::new();
    for d in deltas {
        for e in &d.events {
            match e {
                LogEvent::MarketListed {
                    market,
                    keysets: ids,
                    ..
                } => {
                    r.markets += 1;
                    pools.insert(*market, Pool::default());
                    for (o, id) in ids.iter().enumerate() {
                        let ks = PublicKeyset::derive(
                            m,
                            KeysetKind::Outcome {
                                market_id: market.0,
                                outcome: o as u8,
                            },
                        )
                        .expect("derivable");
                        if ks.id.to_string() != *id {
                            r.failures
                                .push(format!("market {market}: keyset {id} isn't derived from M"));
                        }
                        keysets.insert(ks.id.to_string(), ks);
                    }
                }
                LogEvent::Anchored { txid, root } => r.anchors.push((txid.clone(), *root)),
                LogEvent::PayoutSent { commitments, .. } => {
                    r.payouts += 1;
                    for c in commitments {
                        queued.remove(c);
                    }
                }
                LogEvent::WithdrawalQueued { commitment, amount } => {
                    queued.insert(*commitment, *amount);
                }
                LogEvent::Resolved {
                    market, den, num, ..
                } => {
                    resolved.insert(*market, (*den, *num));
                }
                LogEvent::ReserveReported {
                    height,
                    reserve_zat,
                    unswept_zat,
                } => reports.push((*height, *reserve_zat, *unswept_zat)),
                LogEvent::DuelOpened { duel, stake, .. } => {
                    duels.insert(*duel, *stake);
                }
                LogEvent::DuelTaken { duel } | LogEvent::DuelCancelled { duel } => {
                    duels.remove(duel);
                }
                _ => {}
            }
        }
        for b in &d.batches {
            r.batches += 1;
            r.orders += b.orders.len() as u64;
            match pools.get(&b.market) {
                Some(p) if *p == b.before => {}
                Some(_) => r.failures.push(format!(
                    "batch {} {}: pool before isn't the last pool after",
                    b.batch_id, b.market
                )),
                None => r.failures.push(format!(
                    "batch {}: unlisted market {}",
                    b.batch_id, b.market
                )),
            }
            pools.insert(b.market, b.after);
            if let Some(f) = replay_batch(b) {
                r.failures.push(f);
            }
        }
        for s in &d.issued {
            r.signatures += 1;
            let Some(ks) = keysets.get(&s.id) else {
                r.failures
                    .push(format!("signature from unknown keyset {}", s.id));
                continue;
            };
            let entry = r.supply.entry(kind_name(&ks.kind)).or_default();
            entry.0 += s.amount;
            let ok = (|| {
                let k = ks.keys.amount_key(Amount::from(s.amount))?;
                let sig = BlindSignature {
                    amount: Amount::from(s.amount),
                    keyset_id: Id::from_str(&s.id).ok()?,
                    c: PublicKey::from_hex(&s.c).ok()?,
                    dleq: Some(BlindSignatureDleq {
                        e: SecretKey::from_hex(&s.dleq.e).ok()?,
                        s: SecretKey::from_hex(&s.dleq.s).ok()?,
                    }),
                };
                sig.verify_dleq(k, PublicKey::from_hex(&s.b).ok()?).ok()
            })();
            if ok.is_none() {
                r.failures.push(format!(
                    "signature on {} has no valid DLEQ proof for the key derived from M",
                    s.b
                ));
            }
        }
        for s in &d.spent {
            r.spent += 1;
            match keysets.get(&s.id) {
                Some(ks) => r.supply.entry(kind_name(&ks.kind)).or_default().1 += s.amount,
                None => r
                    .failures
                    .push(format!("spent slip of unknown keyset {}", s.id)),
            }
        }
        // Reserve reports are checked against the liabilities after this delta.
        let owed = liabilities(&r.supply, &pools, &resolved, &queued)
            + duels.values().sum::<u64>() * ZAT_PER_UNIT;
        for (height, reserve, unswept) in reports.drain(..) {
            if reserve + unswept < owed {
                r.failures.push(format!(
                    "reserve at height {height}: {reserve} + {unswept} unswept zat is below the liabilities of {owed} zat"
                ));
            }
            r.reserve = Some((height, reserve, unswept, owed));
        }
        r.liabilities_zat = owed;
    }
    for (k, (issued, spent)) in &r.supply {
        if spent > issued {
            r.failures
                .push(format!("{k}: {spent} units spent, only {issued} issued"));
        }
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liabilities_take_the_worse_outcome_until_resolved() {
        let m = H32([7; 32]);
        let mut supply = BTreeMap::new();
        supply.insert("CREDIT".to_string(), (1_000, 200));
        supply.insert(format!("{m}:A"), (500, 0));
        supply.insert(format!("{m}:B"), (300, 0));
        let mut pools = BTreeMap::new();
        pools.insert(m, Pool::default());
        let mut queued = BTreeMap::new();
        queued.insert(H32([1; 32]), 50);
        let open = liabilities(&supply, &pools, &BTreeMap::new(), &queued);
        assert_eq!(open, (800 + 500 + 50) * ZAT_PER_UNIT);
        let mut resolved = BTreeMap::new();
        resolved.insert(m, (2, [1, 1]));
        let half = liabilities(&supply, &pools, &resolved, &queued);
        assert_eq!(half, (800 + 400 + 50) * ZAT_PER_UNIT);
        resolved.insert(m, (1, [0, 1]));
        assert_eq!(
            liabilities(&supply, &pools, &resolved, &queued),
            (800 + 300 + 50) * ZAT_PER_UNIT
        );
    }
}
