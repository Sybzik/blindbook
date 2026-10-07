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
//! 5. per keyset, nothing was spent beyond what was issued; the outstanding supply is reported.

use std::collections::BTreeMap;
use std::str::FromStr;

use blindbook_engine as engine;
use blindbook_ledger::H32;
use blindbook_ledger::delta::{Delta, GENESIS_ROOT, Head, LogEvent, verify_chain};
use blindbook_ledger::ledger::{BatchRecord, Pool, Side, fill_record};
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

/// Replay one batch record with the engine; `None` if it matches.
pub fn replay_batch(b: &BatchRecord) -> Option<String> {
    if !b.reference.anchor_matches() {
        return Some(format!(
            "batch {} {}: anchor isn't the lower median of its samples",
            b.batch_id, b.market
        ));
    }
    let mut pool = b.before.to_engine();
    let orders: Vec<engine::Order> = b
        .orders
        .iter()
        .enumerate()
        .map(|(i, o)| engine::Order {
            id: i as u64,
            side: match o.side {
                Side::Buy => engine::Side::Buy,
                Side::Sell => engine::Side::Sell,
            },
            outcome: o.outcome,
            amount: o.amount,
            limit_bp: o.limit_bp,
        })
        .collect();
    let report = engine::clear_batch(
        &mut pool,
        &b.params.engine(),
        &b.reference.to_engine(b.closed, b.accepting_orders),
        &engine::Schedule {
            now_ms: b.at_ms,
            event_start_ms: b.event_start_ms,
            end_ms: b.end_ms,
        },
        &orders,
        &mut engine::Trace::off(),
    );
    let fills: Vec<_> = report
        .fills
        .iter()
        .zip(&b.orders)
        .map(|(f, o)| fill_record(o.tag, o.side, f))
        .collect();
    if fills != b.fills {
        return Some(format!(
            "batch {} {}: fills differ on replay",
            b.batch_id, b.market
        ));
    }
    let after = Pool {
        u: pool.u,
        c: pool.c,
        house: pool.house,
    };
    if after != b.after {
        return Some(format!(
            "batch {} {}: pool after differs on replay",
            b.batch_id, b.market
        ));
    }
    if report.halt.map(|h| format!("{h:?}")) != b.halt {
        return Some(format!(
            "batch {} {}: halt differs on replay",
            b.batch_id, b.market
        ));
    }
    None
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
                LogEvent::PayoutSent { .. } => r.payouts += 1,
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
    }
    for (k, (issued, spent)) in &r.supply {
        if spent > issued {
            r.failures
                .push(format!("{k}: {spent} units spent, only {issued} issued"));
        }
    }
    r
}
