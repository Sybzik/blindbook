//! Replaying the public record: every batch through the engine, with nothing but the record
//! itself. Shared by the command-line verifier and the browser (through the wasm32 build), so
//! both run exactly the code the API and the signer ran.

use std::collections::BTreeMap;

use blindbook_engine as engine;

use crate::hex::H32;
use crate::ledger::{BatchRecord, Pool, Side, fill_record};

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

/// Replay a run of batches in log order: each one on its own, and each market's pool carrying
/// over from one batch to the next (a market starts from the empty pool it is listed with).
/// Returns the failures, empty if everything matches.
pub fn replay_all(batches: &[BatchRecord]) -> Vec<String> {
    let mut pools: BTreeMap<H32, Pool> = BTreeMap::new();
    let mut failures = Vec::new();
    for b in batches {
        let last = pools.get(&b.market).copied().unwrap_or_default();
        if last != b.before {
            failures.push(format!(
                "batch {} {}: pool before isn't the last pool after",
                b.batch_id, b.market
            ));
        }
        pools.insert(b.market, b.after);
        if let Some(f) = replay_batch(b) {
            failures.push(f);
        }
    }
    failures
}
