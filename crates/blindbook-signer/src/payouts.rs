//! The signer's treasury loop (PROTOCOL section 10): payouts every block while withdrawals wait,
//! sweeps and anchors on a schedule, each reported to the API as a log event.
//!
//! **Never pay twice.** A payout is built and stored by the wallet, its txid and the
//! withdrawals it pays are written to `payouts-inflight.json`, and only then is it broadcast. After
//! a crash the in-flight file is replayed (re-broadcast, which is harmless, and re-reported);
//! a withdrawal leaves the queue only when the API has recorded its payout.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use blindbook_indexer::follow::{Client, connect, tip};
use blindbook_ledger::H32;
use blindbook_ledger::delta::LogEvent;
use blindbook_treasury::{PAYOUT_OUTPUTS, Treasury};
use serde::{Deserialize, Serialize};
use zcash_address::ZcashAddress;

use crate::link::Station;

/// ZIP 317 fee of a payout transaction (8 actions × 5,000 zatoshi).
pub const PAYOUT_FEE_ZAT: u64 = 40_000;

pub struct Schedule {
    pub server: String,
    pub data: PathBuf,
    /// Anchor the log root every this many blocks (testnet 48).
    pub anchor_every: u64,
    /// Sweep deposits every this many blocks (48).
    pub sweep_every: u64,
}

/// Report the reserve at least this often (blocks), even when it did not change.
const RESERVE_EVERY: u64 = 48;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct State {
    inflight: Vec<InFlight>,
    /// Height and values of the last reserve report (a new one when they change, or every
    /// RESERVE_EVERY blocks).
    #[serde(default)]
    last_reserve: u64,
    #[serde(default)]
    reported: Option<(u64, u64)>,
    last_anchor: u64,
    last_sweep: u64,
    last_payout: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct InFlight {
    txid: String,
    commitments: Vec<H32>,
}

fn load(path: &std::path::Path) -> State {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(path: &std::path::Path, s: &State) {
    if let Ok(b) = serde_json::to_vec_pretty(s) {
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, b).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

fn txid_of(s: &str) -> Option<zcash_primitives::transaction::TxId> {
    let mut bytes = [0u8; 32];
    if s.len() != 64 {
        return None;
    }
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    // Display order is byte-reversed.
    bytes.reverse();
    Some(zcash_primitives::transaction::TxId::from_bytes(bytes))
}

async fn client(server: &str) -> Client {
    loop {
        match connect(server).await {
            Ok(c) => return c,
            Err(e) => {
                tracing::warn!(error = %e, "treasury: lightwalletd unreachable");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

/// One pass: sync, settle in-flight payouts, pay the queue, sweep, anchor.
async fn pass(
    t: &mut Treasury,
    c: &mut Client,
    station: &Mutex<Station>,
    sched: &Schedule,
    state: &mut State,
    state_path: &std::path::Path,
) -> Result<(), String> {
    t.sync(c).await.map_err(|e| e.to_string())?;
    let h = tip(c).await.map_err(|e| e.to_string())?;
    let report = |e: LogEvent| {
        station
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .signer
            .report_event(e)
    };

    // In-flight payouts: drop the recorded ones, re-send and re-report the rest.
    let queued: Vec<H32> = station
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .signer
        .payout_queue()
        .iter()
        .map(|p| p.commitment)
        .collect();
    state
        .inflight
        .retain(|f| f.commitments.iter().any(|c| queued.contains(c)));
    for f in state.inflight.clone() {
        if let Some(txid) = txid_of(&f.txid) {
            let _ = t.broadcast(c, txid).await;
        }
        report(LogEvent::PayoutSent {
            txid: f.txid.clone(),
            commitments: f.commitments.clone(),
        });
    }
    save(state_path, state);

    // New payouts, at most one transaction per block.
    let mut paid = false;
    if h > state.last_payout {
        let busy: Vec<H32> = state
            .inflight
            .iter()
            .flat_map(|f| f.commitments.clone())
            .collect();
        let batch: Vec<_> = station
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .signer
            .payout_queue()
            .iter()
            .filter(|p| !busy.contains(&p.commitment))
            .take(PAYOUT_OUTPUTS)
            .cloned()
            .collect();
        if !batch.is_empty() {
            let mut recipients = Vec::new();
            for p in &batch {
                let addr = ZcashAddress::try_from_encoded(&p.address).map_err(|e| e.to_string())?;
                recipients.push((addr, p.amount * 1_000));
            }
            let total: u64 = recipients.iter().map(|(_, z)| z).sum::<u64>() + PAYOUT_FEE_ZAT;
            let spendable = t.balances().map_err(|e| e.to_string())?.reserve_spendable;
            if spendable >= total {
                let txid = t.build_payout(&recipients).map_err(|e| e.to_string())?;
                let f = InFlight {
                    txid: txid.to_string(),
                    commitments: batch.iter().map(|p| p.commitment).collect(),
                };
                state.inflight.push(f.clone());
                state.last_payout = h;
                save(state_path, state);
                t.broadcast(c, txid).await.map_err(|e| e.to_string())?;
                tracing::info!(txid = %f.txid, withdrawals = batch.len(), "payout sent");
                paid = true;
                report(LogEvent::PayoutSent {
                    txid: f.txid,
                    commitments: f.commitments,
                });
            } else {
                tracing::warn!(spendable, needed = total, "payouts wait for reserve funds");
            }
        }
    }

    // Keep a few spendable reserve notes, so payouts and anchors don't queue behind each other's
    // change. A split has the payout shape (8 actions, OVK discarded).
    if !paid
        && t.reserve_notes().map_err(|e| e.to_string())? < 3
        && t.balances().map_err(|e| e.to_string())?.reserve_spendable >= 2_000_000
    {
        match t.build_split() {
            Ok(txid) => match t.broadcast(c, txid).await {
                Ok(_) => tracing::info!(%txid, "reserve split into more notes"),
                Err(e) => tracing::warn!(error = %e, "split broadcast failed"),
            },
            Err(e) => tracing::debug!(error = %e, "no split"),
        }
    }

    if h >= state.last_sweep + sched.sweep_every {
        match t.sweep(c).await {
            Ok(Some(txid)) => {
                tracing::info!(%txid, "deposits swept");
                report(LogEvent::Swept {
                    txid: txid.to_string(),
                });
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(error = %e, "sweep failed"),
        }
        state.last_sweep = h;
        save(state_path, state);
    }

    // The reserve for the public solvency check.
    if let Ok(b) = t.balances() {
        let now = (b.reserve_total, b.deposit_total);
        if state.reported != Some(now) || h >= state.last_reserve + RESERVE_EVERY {
            report(LogEvent::ReserveReported {
                height: h,
                reserve_zat: now.0,
                unswept_zat: now.1,
            });
            state.reported = Some(now);
            state.last_reserve = h;
            save(state_path, state);
        }
    }

    if h >= state.last_anchor + sched.anchor_every {
        let head = station.lock().unwrap_or_else(|e| e.into_inner()).log.head;
        if head.seq > 0 {
            let memo = format!("bb1:anchor:{}:{}", head.height, head.root);
            match t.anchor(c, &memo).await {
                Ok(txid) => {
                    tracing::info!(%txid, %memo, "log root anchored");
                    report(LogEvent::Anchored {
                        txid: txid.to_string(),
                        root: head.root,
                    });
                    state.last_anchor = h;
                    save(state_path, state);
                }
                Err(e) => tracing::warn!(error = %e, "anchor failed"),
            }
        }
    }
    Ok(())
}

/// Run the treasury loop forever (every 10 seconds).
pub async fn run(mut t: Treasury, station: Arc<Mutex<Station>>, sched: Schedule) {
    let state_path = sched.data.join("treasury-state.json");
    let mut state = load(&state_path);
    let mut c = client(&sched.server).await;
    loop {
        if let Err(e) = pass(&mut t, &mut c, &station, &sched, &mut state, &state_path).await {
            tracing::warn!(error = %e, "treasury pass failed");
            c = client(&sched.server).await;
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}
