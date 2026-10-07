//! Operations the API sequences and the signer executes (PROTOCOL section 9).
//!
//! Both sides keep a ledger replica and apply the same operations in the same order with
//! [`apply`]. The signer alone can check a slip's signature; the requests whose slips it finds
//! invalid travel back in the reply (`invalid`), and the API applies the operation with the same
//! exclusions, so the two replicas never diverge. The signer then signs exactly the jobs `apply`
//! produced; the API checks the signatures line up with its own jobs before answering anyone.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::delta::{ChainStats, IssuedRecord, LogBuilder, LogEvent};
use crate::hex::H32;
use crate::keysets::Keyset;
use crate::ledger::{
    BatchResult, Effects, Ledger, MarketEntry, MarketInputs, Reject, TradeOutcome, TradeRequest,
};
use crate::wire::{BlindSignature, BlindedMessage, Input};

/// Standard withdrawal amounts in units (THREAT_MODEL X6), testnet: 0.01, 0.05, 0.1, 0.5 TAZ.
pub const WITHDRAW_AMOUNTS_TESTNET: [u64; 4] = [1_000, 5_000, 10_000, 50_000];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// List a market. `keysets` are the outcome keyset ids the API derived; the signer derives
    /// them itself from `M` and refuses a mismatch.
    ListMarket {
        entry: MarketEntry,
        keysets: [String; 2],
    },
    Trades {
        batch_id: u64,
        now_ms: u64,
        reqs: Vec<TradeRequest>,
        refs: BTreeMap<H32, MarketInputs>,
    },
    Swap {
        inputs: Vec<Input>,
        outputs: Vec<BlindedMessage>,
    },
    Redeem {
        inputs: Vec<Input>,
        outputs: Vec<BlindedMessage>,
    },
    /// CREDIT for a confirmed top-up or a voucher. The signer checks the claim against its own
    /// indexer (top-ups) or its voucher list before signing.
    Credit {
        amount: u64,
        outputs: Vec<BlindedMessage>,
        claim: CreditClaim,
    },
    Withdraw {
        inputs: Vec<Input>,
        amount: u64,
        change: Vec<BlindedMessage>,
        commitment: H32,
        sealed: String,
    },
    /// Close the open block of the public log at this chain height. Both sides build the same
    /// delta; the signer answers with its own root, which must equal the API's.
    Close { height: u64, chain: ChainStats },
    /// A chain transaction the signer made (payout, sweep, anchor), entered in the log. The
    /// signer accepts only events it reported itself.
    Record { event: LogEvent },
    /// The payout vector both Polygon RPCs agreed on, with where it was read (for the log).
    Resolve {
        market: H32,
        den: u64,
        num: [u64; 2],
        polygon_block: u64,
        polygon_tx: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CreditClaim {
    /// A payment to the one-time address with this diversifier index, seen in this tx.
    Topup {
        diversifier_index: u64,
        txid: String,
    },
    /// `SHA256(code)` of a single-use judge voucher.
    Voucher { code_hash: H32 },
}

/// What applying an operation did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Applied {
    Done,
    Trades(BatchResult),
    Effects(Effects),
    Redeemed { paid: u64, effects: Effects },
    Refused(Reject),
}

impl Applied {
    /// Every sign job, in order: trade outcomes in request order, then within each its list.
    pub fn jobs(&self) -> Vec<&crate::ledger::SignJob> {
        match self {
            Applied::Trades(b) => b.outcomes.iter().flat_map(|o| &o.effects.jobs).collect(),
            Applied::Effects(e) | Applied::Redeemed { effects: e, .. } => e.jobs.iter().collect(),
            Applied::Done | Applied::Refused(_) => Vec::new(),
        }
    }

    /// Every spent slip.
    pub fn spent(&self) -> Vec<&crate::delta::SpentRecord> {
        match self {
            Applied::Trades(b) => b.outcomes.iter().flat_map(|o| &o.effects.spent).collect(),
            Applied::Effects(e) | Applied::Redeemed { effects: e, .. } => e.spent.iter().collect(),
            Applied::Done | Applied::Refused(_) => Vec::new(),
        }
    }
}

/// The signer's answer to one operation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reply {
    /// Trades: indices of requests with an invalid slip. Other operations: `[0]` if refused for
    /// an invalid slip or claim.
    pub invalid: Vec<usize>,
    /// One signature per job of [`Applied::jobs`], same order.
    pub signatures: Vec<BlindSignature>,
    /// For `Close`: the root of the signer's own log after the block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<H32>,
}

/// Apply an operation to a ledger replica, leaving out what the signer found invalid.
pub fn apply(l: &mut Ledger, op: &Op, invalid: &[usize]) -> Applied {
    let applied = apply_inner(l, op, invalid);
    let guard = match &applied {
        Applied::Refused(Reject::SupplyGuard) => true,
        Applied::Trades(b) => b
            .outcomes
            .iter()
            .any(|o| o.result == Err(Reject::SupplyGuard)),
        _ => false,
    };
    l.supply_alarm |= guard;
    applied
}

fn apply_inner(l: &mut Ledger, op: &Op, invalid: &[usize]) -> Applied {
    let refused = !invalid.is_empty();
    match op {
        Op::ListMarket { entry, keysets } => {
            for (o, id) in keysets.iter().enumerate() {
                l.keysets.insert(
                    crate::keysets::Keyset::Outcome {
                        market: entry.id,
                        outcome: o as u8,
                    },
                    id.clone(),
                );
            }
            l.list_market(entry.clone());
            Applied::Done
        }
        Op::Trades {
            batch_id,
            now_ms,
            reqs,
            refs,
        } => {
            let keep: Vec<usize> = (0..reqs.len()).filter(|i| !invalid.contains(i)).collect();
            let kept: Vec<TradeRequest> = keep.iter().map(|&i| reqs[i].clone()).collect();
            let res = l.clear_trades(*batch_id, *now_ms, &kept, refs);
            // Put the refused requests back in place, in request order.
            let mut outcomes: Vec<TradeOutcome> = (0..reqs.len())
                .map(|_| TradeOutcome {
                    result: Err(Reject::InvalidSlip),
                    effects: Effects::default(),
                })
                .collect();
            for (o, &i) in res.outcomes.into_iter().zip(&keep) {
                outcomes[i] = o;
            }
            Applied::Trades(BatchResult {
                records: res.records,
                outcomes,
            })
        }
        Op::Credit { .. } | Op::Record { .. } if refused => Applied::Refused(Reject::InvalidClaim),
        Op::Close { .. } | Op::Record { .. } => Applied::Done,
        _ if refused => Applied::Refused(Reject::InvalidSlip),
        Op::Swap { inputs, outputs } => match l.swap(inputs, outputs) {
            Ok(e) => Applied::Effects(e),
            Err(r) => Applied::Refused(r),
        },
        Op::Redeem { inputs, outputs } => match l.redeem(inputs, outputs) {
            Ok((paid, effects)) => Applied::Redeemed { paid, effects },
            Err(r) => Applied::Refused(r),
        },
        Op::Credit {
            amount, outputs, ..
        } => match l.credit(*amount, outputs) {
            Ok(e) => Applied::Effects(e),
            Err(r) => Applied::Refused(r),
        },
        Op::Withdraw { .. } if l.supply_alarm => Applied::Refused(Reject::SupplyGuard),
        Op::Withdraw {
            inputs,
            amount,
            change,
            ..
        } => match l.withdraw(inputs, *amount, change, &WITHDRAW_AMOUNTS_TESTNET) {
            Ok(e) => Applied::Effects(e),
            Err(r) => Applied::Refused(r),
        },
        Op::Resolve {
            market, den, num, ..
        } => match l.resolve(*market, *den, *num) {
            Ok(()) => Applied::Done,
            Err(r) => Applied::Refused(r),
        },
    }
}

/// The slips an operation spends, per request (trades) or as one group (everything else): what
/// the signer checks signatures for.
pub fn inputs_of(op: &Op) -> Vec<&[Input]> {
    match op {
        Op::Trades { reqs, .. } => reqs.iter().map(|r| r.inputs.as_slice()).collect(),
        Op::Swap { inputs, .. } | Op::Redeem { inputs, .. } | Op::Withdraw { inputs, .. } => {
            vec![inputs.as_slice()]
        }
        Op::ListMarket { .. }
        | Op::Credit { .. }
        | Op::Resolve { .. }
        | Op::Close { .. }
        | Op::Record { .. } => Vec::new(),
    }
}

/// The issuance records of an applied operation: its jobs with their signatures.
pub fn issued_records(applied: &Applied, sigs: &[BlindSignature]) -> Vec<IssuedRecord> {
    applied
        .jobs()
        .into_iter()
        .zip(sigs)
        .map(|(j, s)| IssuedRecord {
            id: s.id.clone(),
            amount: s.amount,
            b: j.b.clone(),
            c: s.c.clone(),
            dleq: s.dleq.clone(),
        })
        .collect()
}

/// Enter an applied operation in the open block of the log (normative: the API and the signer
/// both do this, so their roots agree). `Close` itself is handled by the caller.
pub fn record_applied(
    log: &mut LogBuilder,
    l: &Ledger,
    op: &Op,
    applied: &Applied,
    sigs: &[BlindSignature],
) {
    for r in issued_records(applied, sigs) {
        log.issued(r);
    }
    log.spent(applied.spent().into_iter().cloned());
    let event = match (op, applied) {
        (Op::ListMarket { entry, keysets }, Applied::Done) => Some(LogEvent::MarketListed {
            market: entry.id,
            params: entry.params,
            event_start_ms: entry.event_start_ms,
            end_ms: entry.end_ms,
            keysets: keysets.clone(),
        }),
        (Op::Credit { amount, claim, .. }, Applied::Effects(_)) => Some(match claim {
            CreditClaim::Topup { .. } => LogEvent::TopupCredited { amount: *amount },
            CreditClaim::Voucher { .. } => LogEvent::VoucherRedeemed { amount: *amount },
        }),
        (Op::Redeem { inputs, .. }, Applied::Redeemed { paid, .. }) => {
            match inputs.first().and_then(|i| l.keysets.kind(&i.proof.id)) {
                Some(Keyset::Outcome { market, outcome }) => Some(LogEvent::Redeemed {
                    market,
                    outcome,
                    shares: inputs.iter().map(|i| i.proof.amount).sum(),
                    paid: *paid,
                }),
                _ => None,
            }
        }
        (
            Op::Withdraw {
                amount, commitment, ..
            },
            Applied::Effects(_),
        ) => Some(LogEvent::WithdrawalQueued {
            commitment: *commitment,
            amount: *amount,
        }),
        (
            Op::Resolve {
                market,
                den,
                num,
                polygon_block,
                polygon_tx,
            },
            Applied::Done,
        ) => Some(LogEvent::Resolved {
            market: *market,
            den: *den,
            num: *num,
            polygon_block: *polygon_block,
            polygon_tx: polygon_tx.clone(),
        }),
        (Op::Record { event }, Applied::Done) => Some(event.clone()),
        _ => None,
    };
    if let Some(e) = event {
        log.event(e);
    }
    if let Applied::Trades(res) = applied {
        for rec in &res.records {
            log.batch(rec.clone());
        }
    }
}

/// A placeholder curve point for redacted slips (the format checks only look at its shape).
pub const REDACTED_POINT: &str =
    "020000000000000000000000000000000000000000000000000000000000000000";
pub const REDACTED_SECRET: &str = "redacted";

fn redact_inputs(inputs: &mut [Input]) {
    for i in inputs {
        i.proof.secret = REDACTED_SECRET.into();
        i.proof.c = REDACTED_POINT.into();
    }
}

/// The operation with every spent slip's secret and signature replaced by placeholders: what
/// the API and the signer write to their journals. Only `Y`, keyset and amount stay, and replay
/// never re-checks the rest (the request passed the checks when it arrived), so a stolen journal
/// holds nothing spendable.
pub fn redact(op: &Op) -> Op {
    let mut op = op.clone();
    match &mut op {
        Op::Trades { reqs, .. } => {
            for r in reqs {
                redact_inputs(&mut r.inputs);
            }
        }
        Op::Swap { inputs, .. } | Op::Redeem { inputs, .. } | Op::Withdraw { inputs, .. } => {
            redact_inputs(inputs)
        }
        Op::ListMarket { .. }
        | Op::Credit { .. }
        | Op::Resolve { .. }
        | Op::Close { .. }
        | Op::Record { .. } => {}
    }
    op
}

/// Signer → API, first message on a connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    /// Master public key `M`, hex.
    pub m: String,
    /// Operations the signer has applied (its journal length); must equal the API's.
    pub applied: u64,
}

/// API → signer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToSigner {
    pub id: u64,
    pub op: Op,
}

/// Signer → API.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FromSigner {
    Hello {
        hello: Hello,
    },
    Reply {
        id: u64,
        reply: Reply,
    },
    Error {
        id: u64,
        error: String,
    },
    /// Unsolicited: a chain transaction the treasury made. The API answers with `Op::Record`.
    Event {
        event: LogEvent,
    },
}
