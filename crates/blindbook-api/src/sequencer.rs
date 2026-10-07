//! The sequencer: one task that owns the ledger replica and puts every operation in one order.
//!
//! Trades wait for the next 2-second batch; everything else runs at once, between batches. Each
//! operation goes to the signer, comes back with its exclusions and signatures, is applied to the
//! replica with the same `ops::apply`, checked against the signatures, journaled (without slip
//! secrets) and recorded in the open block of the public log. If the replica and the signer ever
//! disagree, the sequencer halts: nothing more is accepted until the operator looks.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use blindbook_ledger::H32;
use blindbook_ledger::delta::{ChainStats, GENESIS_ROOT, Head, IssuedRecord, LogBuilder, LogEvent};
use blindbook_ledger::keysets::{Keyset, KeysetIds};
use blindbook_ledger::ledger::{
    FillRecord, Ledger, MarketInputs, MarketParams, MarketStatus, Pool, Reject, Side, TradeOutcome,
    TradeRequest,
};
use blindbook_ledger::ops::{self, Applied, Op};
use blindbook_ledger::wire::BlindSignature;
use blindbook_polymarket::MarketInfo;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

use crate::files::Files;
use crate::journal::{Entry, Journal, redact};
use crate::link::{LinkError, SignerLink};

pub const BATCH_EVERY: Duration = Duration::from_secs(2);
/// How long recent fills stay in `/v1/live`.
pub const RECENT_MS: u64 = 120_000;
/// Payouts stay in the live JSON for 30 minutes, so a browser that was away still sees its own.
pub const PAYOUTS_MS: u64 = 1_800_000;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("refused: {0}")]
    Rejected(Reject),
    #[error("signer: {0}")]
    Signer(#[from] LinkError),
    #[error("the service is halted for an operator check")]
    Halted,
    #[error("internal: {0}")]
    Internal(String),
}

/// What everyone may read about a listed market.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MarketView {
    pub id: H32,
    pub keysets: [String; 2],
    pub params: MarketParams,
    pub event_start_ms: Option<u64>,
    pub end_ms: u64,
    pub pool: Pool,
    pub status: MarketStatus,
    /// Labels, rules text and the like from Polymarket's catalog.
    pub info: Option<MarketInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RecentFill {
    pub at_ms: u64,
    pub batch_id: u64,
    pub market: H32,
    pub side: Side,
    pub outcome: u8,
    pub fill: FillRecord,
}

/// A payout transaction and the withdrawal commitments it paid (public in the log anyway).
#[derive(Clone, Debug, Serialize)]
pub struct RecentPayout {
    pub at_ms: u64,
    pub txid: String,
    pub commitments: Vec<H32>,
}

/// State shared with the HTTP handlers and the live-price task.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct ChainBlock {
    pub height: u64,
    pub shielded_actions: u64,
}

pub struct Shared {
    pub head: RwLock<Head>,
    /// The last chain block closed into the log, with its shielded activity (BLOCK RADIO).
    pub block: RwLock<Option<ChainBlock>>,
    /// Payouts of the last 30 minutes: every browser polls them alike and finds its own.
    pub payouts: RwLock<VecDeque<RecentPayout>>,
    pub markets: RwLock<BTreeMap<H32, MarketView>>,
    pub recent: RwLock<VecDeque<RecentFill>>,
    pub catalog: RwLock<BTreeMap<H32, MarketInfo>>,
    pub credit_id: String,
    pub halted: AtomicBool,
    /// Operations applied (the signer must report the same number when it connects).
    pub applied_ops: AtomicU64,
    /// An operation was sent and the link dropped before its answer: the signer may have
    /// applied it (and may report one more operation than we have) until it is re-sent.
    pub in_doubt: AtomicBool,
}

impl Shared {
    pub fn new(credit_id: String) -> Self {
        Shared {
            head: RwLock::new(Head {
                height: 0,
                seq: 0,
                root: GENESIS_ROOT,
            }),
            block: RwLock::new(None),
            payouts: RwLock::default(),
            markets: RwLock::default(),
            recent: RwLock::default(),
            catalog: RwLock::default(),
            credit_id,
            halted: AtomicBool::new(false),
            applied_ops: AtomicU64::new(0),
            in_doubt: AtomicBool::new(false),
        }
    }
}

pub struct TradeDone {
    pub batch_id: u64,
    pub outcome: TradeOutcome,
    pub signatures: Vec<BlindSignature>,
}

pub struct OpDone {
    pub applied: Applied,
    pub signatures: Vec<BlindSignature>,
}

pub enum Cmd {
    Trade(TradeRequest, oneshot::Sender<Result<TradeDone, ApiError>>),
    Op(Op, oneshot::Sender<Result<OpDone, ApiError>>),
    Close {
        height: u64,
        chain: ChainStats,
    },
    /// A chain transaction the signer's treasury reported.
    Event(LogEvent),
}

/// The market inputs for a batch: reference snapshot and Polymarket's flags.
pub type RefFn = Arc<dyn Fn(&H32) -> MarketInputs + Send + Sync>;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[derive(Serialize)]
struct Snapshot<'a> {
    v: u32,
    seq: u64,
    height: u64,
    root: H32,
    credit_keyset: &'a str,
    markets: Vec<MarketView>,
    issued: &'a [IssuedRecord],
    spent: Vec<&'a String>,
    /// Units issued and spent per keyset id: outstanding = issued − spent (solvency check).
    issued_total: &'a BTreeMap<String, u64>,
    spent_total: &'a BTreeMap<String, u64>,
    house: i64,
}

pub struct Sequencer {
    ledger: Ledger,
    log: LogBuilder,
    journal: Journal,
    files: Files,
    link: SignerLink,
    refs: RefFn,
    shared: Arc<Shared>,
    pending: Vec<(TradeRequest, oneshot::Sender<Result<TradeDone, ApiError>>)>,
    pending_ys: HashSet<String>,
    batch_id: u64,
    /// Every signature ever issued: the issuance log in the snapshot (zero-query restore).
    all_issued: Vec<IssuedRecord>,
    /// Operations applied so far (the signer reports the same count at hello).
    pub applied_ops: u64,
    /// Sent, unanswered: re-sent before anything else (the signer answers a repeat from its
    /// cache, so it is applied exactly once on both sides).
    in_doubt: Option<Op>,
}

impl Sequencer {
    /// Open the data directory and replay the journal.
    pub fn open(
        data_dir: &Path,
        credit_id: String,
        link: SignerLink,
        refs: RefFn,
        shared: Arc<Shared>,
    ) -> Result<Self, ApiError> {
        let io = |e: std::io::Error| ApiError::Internal(e.to_string());
        std::fs::create_dir_all(data_dir).map_err(io)?;
        let files = Files::new(data_dir).map_err(io)?;
        let (journal, entries) = Journal::open(&data_dir.join("journal.jsonl")).map_err(io)?;
        let mut ids = KeysetIds::default();
        ids.insert(Keyset::Credit, credit_id);
        let mut s = Sequencer {
            ledger: Ledger::new(ids),
            log: LogBuilder::new(Head {
                height: 0,
                seq: 0,
                root: GENESIS_ROOT,
            }),
            journal,
            files,
            link,
            refs,
            shared,
            pending: Vec::new(),
            pending_ys: HashSet::new(),
            batch_id: 0,
            all_issued: Vec::new(),
            applied_ops: 0,
            in_doubt: None,
        };
        for e in entries {
            match e {
                Entry::Op {
                    op,
                    invalid,
                    signatures,
                } => {
                    let applied = ops::apply(&mut s.ledger, &op, &invalid);
                    // at_ms 0: replayed fills are not "recent".
                    s.record(&op, &applied, &signatures, 0);
                    s.applied_ops += 1;
                    if let Op::Close { height, chain } = op {
                        s.close_block(height, chain, false)?;
                    }
                }
                Entry::Close { height, chain } => {
                    s.close_block(height, chain, false)?;
                }
            }
        }
        s.shared.applied_ops.store(s.applied_ops, Ordering::SeqCst);
        if s.log.head.seq > 0 {
            *s.shared.head.write().unwrap_or_else(|e| e.into_inner()) = s.log.head;
        }
        s.publish_views();
        tracing::info!(
            ops = s.applied_ops,
            head = s.log.head.seq,
            "journal replayed"
        );
        Ok(s)
    }

    pub fn ledger(&self) -> &Ledger {
        &self.ledger
    }

    fn halt(&self, why: &str) -> ApiError {
        tracing::error!(%why, "sequencer halted");
        self.shared.halted.store(true, Ordering::SeqCst);
        ApiError::Halted
    }

    /// Record an applied operation in the open block and the views.
    fn record(&mut self, op: &Op, applied: &Applied, sigs: &[BlindSignature], at_ms: u64) {
        self.all_issued.extend(ops::issued_records(applied, sigs));
        ops::record_applied(&mut self.log, &self.ledger, op, applied, sigs);
        if let (Op::Trades { batch_id, reqs, .. }, Applied::Trades(res)) = (op, applied) {
            self.batch_id = self.batch_id.max(*batch_id);
            let mut recent = self
                .shared
                .recent
                .write()
                .unwrap_or_else(|e| e.into_inner());
            for (r, o) in reqs.iter().zip(&res.outcomes) {
                if let Ok(fill) = &o.result {
                    recent.push_back(RecentFill {
                        at_ms,
                        batch_id: *batch_id,
                        market: r.market,
                        side: r.side,
                        outcome: r.outcome,
                        fill: fill.clone(),
                    });
                }
            }
            while recent.front().is_some_and(|f| f.at_ms + RECENT_MS < at_ms) {
                recent.pop_front();
            }
        }
        if let Op::Record {
            event: LogEvent::PayoutSent { txid, commitments },
        } = op
            && at_ms > 0
        {
            let mut p = self
                .shared
                .payouts
                .write()
                .unwrap_or_else(|e| e.into_inner());
            if !p.iter().any(|x| x.txid == *txid) {
                p.push_back(RecentPayout {
                    at_ms,
                    txid: txid.clone(),
                    commitments: commitments.clone(),
                });
            }
            while p.front().is_some_and(|f| f.at_ms + PAYOUTS_MS < at_ms) {
                p.pop_front();
            }
        }
    }

    fn publish_views(&self) {
        let catalog = self
            .shared
            .catalog
            .read()
            .unwrap_or_else(|e| e.into_inner());
        let views: BTreeMap<H32, MarketView> = self
            .ledger
            .markets
            .values()
            .map(|m| {
                let ks = |o| {
                    self.ledger
                        .keysets
                        .id(Keyset::Outcome {
                            market: m.id,
                            outcome: o,
                        })
                        .unwrap_or_default()
                        .to_owned()
                };
                (
                    m.id,
                    MarketView {
                        id: m.id,
                        keysets: [ks(0), ks(1)],
                        params: m.params,
                        event_start_ms: m.event_start_ms,
                        end_ms: m.end_ms,
                        pool: m.pool,
                        status: m.status,
                        info: catalog.get(&m.id).cloned(),
                    },
                )
            })
            .collect();
        drop(catalog);
        *self
            .shared
            .markets
            .write()
            .unwrap_or_else(|e| e.into_inner()) = views;
    }

    /// Re-send the operation in doubt, if any. Nothing else runs until it has an answer.
    async fn settle_doubt(&mut self) -> Result<(), ApiError> {
        let Some(op) = self.in_doubt.take() else {
            return Ok(());
        };
        tracing::warn!("re-sending the operation whose answer was lost");
        match self.apply_reply(op.clone()).await {
            Ok(_) => {
                self.shared.in_doubt.store(false, Ordering::SeqCst);
                Ok(())
            }
            Err(e) => {
                self.in_doubt = Some(op);
                Err(e)
            }
        }
    }

    /// Send an operation to the signer, apply it, check, journal and record it.
    async fn execute(&mut self, op: Op) -> Result<OpDone, ApiError> {
        if self.shared.halted.load(Ordering::SeqCst) {
            return Err(ApiError::Halted);
        }
        self.settle_doubt().await?;
        self.apply_reply(op).await
    }

    async fn apply_reply(&mut self, op: Op) -> Result<OpDone, ApiError> {
        let reply = match self.link.call(&op).await {
            Ok(r) => r,
            Err(e @ (LinkError::Down | LinkError::Timeout)) => {
                // The signer may have applied it; ask again before anything else.
                self.in_doubt = Some(op);
                self.shared.in_doubt.store(true, Ordering::SeqCst);
                return Err(e.into());
            }
            Err(e) => return Err(e.into()),
        };
        let applied = ops::apply(&mut self.ledger, &op, &reply.invalid);
        let jobs = applied.jobs();
        let aligned = jobs.len() == reply.signatures.len()
            && jobs
                .iter()
                .zip(&reply.signatures)
                .all(|(j, s)| j.id == s.id && j.amount == s.amount);
        if !aligned {
            return Err(self.halt("the signer's signatures don't match the replica's jobs"));
        }
        if !matches!(applied, Applied::Refused(_)) {
            let entry = Entry::Op {
                op: redact(&op),
                invalid: reply.invalid.clone(),
                signatures: reply.signatures.clone(),
            };
            if let Err(e) = self.journal.append(&entry) {
                return Err(self.halt(&format!("journal write failed: {e}")));
            }
            self.applied_ops += 1;
            self.shared
                .applied_ops
                .store(self.applied_ops, Ordering::SeqCst);
            self.record(&op, &applied, &reply.signatures, now_ms());
            self.publish_views();
            if let Op::Close { height, chain } = &op {
                self.close_block(*height, *chain, false)?;
                if let Some(theirs) = reply.root
                    && theirs != self.log.head.root
                {
                    return Err(self.halt(&format!(
                        "log root differs from the signer's: ours {}, theirs {theirs}",
                        self.log.head.root
                    )));
                }
            }
        }
        Ok(OpDone {
            applied,
            signatures: reply.signatures,
        })
    }

    fn accept_trade(
        &mut self,
        req: TradeRequest,
        reply: oneshot::Sender<Result<TradeDone, ApiError>>,
    ) {
        if self.shared.halted.load(Ordering::SeqCst) {
            let _ = reply.send(Err(ApiError::Halted));
            return;
        }
        match self.ledger.check_trade(&req, &self.pending_ys) {
            Ok(_) => {
                self.pending_ys
                    .extend(req.inputs.iter().map(|i| i.y.clone()));
                self.pending.push((req, reply));
            }
            Err(r) => {
                let _ = reply.send(Err(ApiError::Rejected(r)));
            }
        }
    }

    async fn run_batch(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let pending = std::mem::take(&mut self.pending);
        self.pending_ys.clear();
        let (reqs, waiters): (Vec<_>, Vec<_>) = pending.into_iter().unzip();
        let markets: HashSet<H32> = reqs.iter().map(|r| r.market).collect();
        let refs: BTreeMap<H32, MarketInputs> =
            markets.iter().map(|m| (*m, (self.refs)(m))).collect();
        let batch_id = self.batch_id + 1;
        let op = Op::Trades {
            batch_id,
            now_ms: now_ms(),
            reqs,
            refs,
        };
        match self.execute(op).await {
            Ok(OpDone {
                applied: Applied::Trades(res),
                signatures,
            }) => {
                let mut sigs = signatures.into_iter();
                for (outcome, w) in res.outcomes.into_iter().zip(waiters) {
                    let n = outcome.effects.jobs.len();
                    let signatures: Vec<_> = sigs.by_ref().take(n).collect();
                    let _ = w.send(Ok(TradeDone {
                        batch_id,
                        outcome,
                        signatures,
                    }));
                }
            }
            Ok(_) => {
                for w in waiters {
                    let _ = w.send(Err(ApiError::Internal("not a trade result".into())));
                }
            }
            Err(e) => {
                let msg = e.to_string();
                for w in waiters {
                    let _ = w.send(Err(ApiError::Internal(msg.clone())));
                }
            }
        }
    }

    fn close_block(
        &mut self,
        height: u64,
        chain: ChainStats,
        journal: bool,
    ) -> Result<(), ApiError> {
        if journal && let Err(e) = self.journal.append(&Entry::Close { height, chain }) {
            return Err(self.halt(&format!("journal write failed: {e}")));
        }
        let (delta, head) = self
            .log
            .close(height, chain)
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        let io = |e: std::io::Error| ApiError::Internal(e.to_string());
        self.files.write_delta(&delta).map_err(io)?;
        self.files.write_head(&head).map_err(io)?;
        let mut spent: Vec<&String> = self.ledger.spent.iter().collect();
        spent.sort();
        let markets = self
            .shared
            .markets
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        self.files
            .write_snapshot(
                head.seq,
                &Snapshot {
                    v: 1,
                    seq: head.seq,
                    height: head.height,
                    root: head.root,
                    credit_keyset: &self.shared.credit_id,
                    markets,
                    issued: &self.all_issued,
                    spent,
                    issued_total: &self.ledger.issued,
                    spent_total: &self.ledger.burned,
                    house: self.ledger.house,
                },
            )
            .map_err(io)?;
        *self.shared.head.write().unwrap_or_else(|e| e.into_inner()) = head;
        *self.shared.block.write().unwrap_or_else(|e| e.into_inner()) = Some(ChainBlock {
            height,
            shielded_actions: chain.shielded_actions,
        });
        Ok(())
    }

    /// Serve commands until every sender is gone.
    pub async fn run(mut self, mut rx: mpsc::Receiver<Cmd>) {
        let mut tick = tokio::time::interval(BATCH_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    None => break,
                    Some(Cmd::Trade(req, reply)) => self.accept_trade(req, reply),
                    Some(Cmd::Op(op, reply)) => {
                        let r = self.execute(op).await;
                        let _ = reply.send(r);
                    }
                    Some(Cmd::Close { height, chain }) => {
                        if let Err(e) = self.execute(Op::Close { height, chain }).await {
                            tracing::error!(error = %e, "closing the block failed");
                        }
                    }
                    Some(Cmd::Event(event)) => {
                        match self.execute(Op::Record { event: event.clone() }).await {
                            Ok(done) if !matches!(done.applied, Applied::Refused(_)) => {
                                tracing::info!(?event, "treasury event recorded");
                            }
                            Ok(_) => {}
                            Err(e) => tracing::warn!(error = %e, "recording a treasury event failed"),
                        }
                    }
                },
                _ = tick.tick() => self.run_batch().await,
            }
        }
    }
}
