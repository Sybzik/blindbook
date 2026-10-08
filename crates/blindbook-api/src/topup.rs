//! The top-up desk (PROTOCOL sections 1, 4 and 11): one-time addresses, payments seen by the
//! indexer, CREDIT issued on SEEN within the 0-conf caps or after one confirmation.
//!
//! A request knows its diversifier index, its blank CREDIT outputs and `SHA256(topup_secret)`.
//! The outputs are blinded, so once they are signed the API can't link the top-up to anything
//! the slips do later. The signer credits only payments its own indexer saw too.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use blindbook_indexer::{ChainEvent, DepositKeys, Payment, Privacy};
use blindbook_ledger::H32;
use blindbook_ledger::delta::ChainStats;
use blindbook_ledger::ledger::{BLANK_OUTPUTS, OutputList};
use blindbook_ledger::ops::{Applied, CreditClaim, Op};
use blindbook_ledger::wire::{BlindSignature, BlindedMessage};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::sequencer::Cmd;

/// Blocks a top-up address is advertised for (later payments are still credited).
pub const ADDRESS_LIFETIME: u64 = 120;

/// Unpaid, unexpired top-up requests the desk holds at most; past that, new ones are refused as
/// busy until some expire. Proof-of-work alone doesn't bound what a fast machine can ask for.
pub const MAX_OPEN: usize = 500;

/// Blocks after expiry (about a day) after which an unpaid request drops its blank outputs; a
/// payment that still arrives is credited through `/v1/topup/claim` with the request's secret.
pub const PRUNE_AFTER: u64 = 1_152;

#[derive(Debug, PartialEq, Eq)]
pub enum CreateError {
    /// Too many open requests: try again later.
    Busy,
    /// The claim hash belongs to a different request.
    Reused,
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Awaiting,
    Seen,
    Credited,
    Confirmed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentRec {
    pub txid: String,
    pub value_zat: u64,
    pub privacy: Privacy,
    pub mined_height: Option<u64>,
    pub credited: bool,
    /// A credit request for it is on its way to the signer.
    #[serde(default)]
    pub crediting: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SigOut {
    pub list: OutputList,
    pub index: usize,
    #[serde(flatten)]
    pub sig: BlindSignature,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Topup {
    pub id: String,
    pub index: u64,
    pub amount_zat: u64,
    pub address: String,
    pub outputs: Vec<BlindedMessage>,
    pub claim_hash: H32,
    pub expires_height: u64,
    pub payments: Vec<PaymentRec>,
    pub status: Status,
    pub signatures: Vec<SigOut>,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    next_index: u64,
    scanned_height: u64,
    topups: Vec<Topup>,
}

/// What to credit: one payment, onto a request's outputs.
#[derive(Clone, Debug)]
pub struct CreditJob {
    pub topup_id: String,
    pub index: u64,
    pub txid: String,
    pub units: u64,
    pub outputs: Vec<BlindedMessage>,
}

pub struct ZeroConfCaps {
    pub per_topup: u64,
    pub total: u64,
}

pub struct TopupBook {
    path: PathBuf,
    next_index: u64,
    pub scanned_height: u64,
    topups: HashMap<String, Topup>,
    by_index: HashMap<u64, String>,
    caps: ZeroConfCaps,
    /// Credited before confirmation, by txid (units).
    unconfirmed: HashMap<String, u64>,
    max_open: usize,
}

fn random_id() -> String {
    blindbook_mint::cashu::SecretKey::generate().to_secret_hex()[..32].to_owned()
}

impl TopupBook {
    pub fn open(path: &Path, caps: ZeroConfCaps) -> std::io::Result<Self> {
        let stored: Stored = match std::fs::read(path) {
            Ok(b) => serde_json::from_slice(&b).map_err(std::io::Error::other)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Stored {
                next_index: 1,
                ..Stored::default()
            },
            Err(e) => return Err(e),
        };
        let mut book = TopupBook {
            path: path.to_owned(),
            next_index: stored.next_index.max(1),
            scanned_height: stored.scanned_height,
            topups: HashMap::new(),
            by_index: HashMap::new(),
            caps,
            unconfirmed: HashMap::new(),
            max_open: MAX_OPEN,
        };
        for mut t in stored.topups {
            // A credit in flight when the process stopped is retried on the next event.
            for p in &mut t.payments {
                p.crediting = false;
            }
            for p in &t.payments {
                if p.credited && p.mined_height.is_none() {
                    book.unconfirmed.insert(p.txid.clone(), p.value_zat / 1_000);
                }
            }
            book.by_index.insert(t.index, t.id.clone());
            book.topups.insert(t.id.clone(), t);
        }
        Ok(book)
    }

    fn save(&self) -> std::io::Result<()> {
        let mut topups: Vec<&Topup> = self.topups.values().collect();
        topups.sort_by_key(|t| t.index);
        let bytes = serde_json::to_vec(&serde_json::json!({
            "next_index": self.next_index,
            "scanned_height": self.scanned_height,
            "topups": topups,
        }))
        .map_err(std::io::Error::other)?;
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &self.path)
    }

    /// A new request: the next diversifier index and its address.
    pub fn create(
        &mut self,
        keys: &DepositKeys,
        amount_zat: u64,
        outputs: Vec<BlindedMessage>,
        claim_hash: H32,
        height: u64,
    ) -> Result<Topup, CreateError> {
        // The same request again (a lost answer, or a replay of its proof-of-work): the same
        // address, nothing new stored.
        if let Some(t) = self.topups.values().find(|t| t.claim_hash == claim_hash) {
            return if t.amount_zat == amount_zat && t.outputs == outputs {
                Ok(t.clone())
            } else {
                Err(CreateError::Reused)
            };
        }
        let open = self
            .topups
            .values()
            .filter(|t| t.status == Status::Awaiting && t.expires_height > height)
            .count();
        if open >= self.max_open {
            return Err(CreateError::Busy);
        }
        let index = self.next_index;
        let address = keys
            .address_r0(u128::from(index))
            .map_err(|e| CreateError::Failed(e.to_string()))?;
        self.next_index += 1;
        let t = Topup {
            id: random_id(),
            index,
            amount_zat,
            address,
            outputs,
            claim_hash,
            expires_height: height + ADDRESS_LIFETIME,
            payments: Vec::new(),
            status: Status::Awaiting,
            signatures: Vec::new(),
        };
        self.by_index.insert(index, t.id.clone());
        self.topups.insert(t.id.clone(), t.clone());
        self.save()
            .map_err(|e| CreateError::Failed(e.to_string()))?;
        Ok(t)
    }

    /// Lower the cap on open requests (tests).
    pub fn set_max_open(&mut self, n: usize) {
        self.max_open = n;
    }

    pub fn get(&self, id: &str) -> Option<&Topup> {
        self.topups.get(id)
    }

    /// A payment seen in the mempool (`mined` = None) or in a block. Returns what to credit now.
    pub fn on_payment(&mut self, p: &Payment, mined: Option<u64>) -> Option<CreditJob> {
        let index = u64::try_from(p.index).ok()?;
        let id = self.by_index.get(&index)?.clone();
        let t = self.topups.get_mut(&id)?;
        let rec = match t.payments.iter_mut().find(|r| r.txid == p.txid) {
            Some(r) => r,
            None => {
                t.payments.push(PaymentRec {
                    txid: p.txid.clone(),
                    value_zat: p.value_zat,
                    privacy: p.privacy,
                    mined_height: None,
                    credited: false,
                    crediting: false,
                });
                t.payments.last_mut().expect("just pushed")
            }
        };
        if let Some(h) = mined {
            rec.mined_height.get_or_insert(h);
            self.unconfirmed.remove(&p.txid);
        }
        let units = rec.value_zat / 1_000;
        // A pruned request has no outputs left: its payment waits for a claim.
        let first_uncredited = !rec.credited
            && !rec.crediting
            && !t.outputs.is_empty()
            && matches!(t.status, Status::Awaiting | Status::Seen);
        let confirmed = rec.mined_height.is_some();
        if t.status == Status::Awaiting {
            t.status = Status::Seen;
        }
        if t.status == Status::Credited
            && t.payments
                .iter()
                .all(|r| !r.credited || r.mined_height.is_some())
        {
            t.status = Status::Confirmed;
        }
        let pending: u64 = self.unconfirmed.values().sum();
        let within_caps = units <= self.caps.per_topup && pending + units <= self.caps.total;
        let go = first_uncredited && units > 0 && (confirmed || within_caps);
        if go && let Some(r) = t.payments.iter_mut().find(|r| r.txid == p.txid) {
            r.crediting = true;
        }
        let job = go.then(|| CreditJob {
            topup_id: id.clone(),
            index,
            txid: p.txid.clone(),
            units,
            outputs: t.outputs.clone(),
        });
        let _ = self.save();
        job
    }

    /// The signer credited a payment.
    pub fn credited(&mut self, job: &CreditJob, sigs: Vec<SigOut>) {
        let Some(t) = self.topups.get_mut(&job.topup_id) else {
            return;
        };
        let mut confirmed = false;
        if let Some(r) = t.payments.iter_mut().find(|r| r.txid == job.txid) {
            r.credited = true;
            r.crediting = false;
            confirmed = r.mined_height.is_some();
        }
        if !confirmed {
            self.unconfirmed.insert(job.txid.clone(), job.units);
        }
        t.status = if confirmed {
            Status::Confirmed
        } else {
            Status::Credited
        };
        t.signatures = sigs;
        let _ = self.save();
    }

    /// A later payment to an already-credited address, claimed with the request's secret onto
    /// fresh outputs (`POST /v1/topup/claim`).
    pub fn claim(
        &mut self,
        id: &str,
        secret: &str,
        outputs: Vec<BlindedMessage>,
    ) -> Result<CreditJob, &'static str> {
        let t = self.topups.get(id).ok_or("unknown top-up")?;
        if blindbook_ledger::canonical::sha256(secret.as_bytes()) != t.claim_hash.0 {
            return Err("wrong secret");
        }
        let pending: u64 = self.unconfirmed.values().sum();
        let r = t
            .payments
            .iter()
            .find(|r| {
                let units = r.value_zat / 1_000;
                !r.credited
                    && units > 0
                    && (r.mined_height.is_some()
                        || (units <= self.caps.per_topup && pending + units <= self.caps.total))
            })
            .ok_or("nothing to claim yet")?;
        Ok(CreditJob {
            topup_id: id.to_owned(),
            index: t.index,
            txid: r.txid.clone(),
            units: r.value_zat / 1_000,
            outputs,
        })
    }

    /// The signer never accepted the credit: let the next event try again.
    pub fn credit_failed(&mut self, job: &CreditJob) {
        if let Some(r) = self
            .topups
            .get_mut(&job.topup_id)
            .and_then(|t| t.payments.iter_mut().find(|r| r.txid == job.txid))
        {
            r.crediting = false;
        }
        let _ = self.save();
    }

    pub fn set_scanned(&mut self, h: u64) {
        if h > self.scanned_height {
            self.scanned_height = h;
            for t in self.topups.values_mut() {
                if t.status == Status::Awaiting
                    && t.payments.is_empty()
                    && t.expires_height + PRUNE_AFTER <= h
                {
                    t.outputs.clear();
                }
            }
            let _ = self.save();
        }
    }
}

/// Check that blank outputs are 31 amount-less CREDIT outputs (the ledger checks them again).
pub fn blank_credit_ok(outputs: &[BlindedMessage], credit_id: &str) -> bool {
    outputs.len() == BLANK_OUTPUTS
        && outputs.iter().all(|o| {
            o.amount == 0
                && o.id == credit_id
                && o.b.len() == 66
                && o.b.bytes().all(|b| b.is_ascii_hexdigit())
        })
}

/// Ask the signer to credit a payment; its own indexer may see the payment a moment after ours,
/// so a refused claim is retried for a minute.
pub async fn credit(tx: mpsc::Sender<Cmd>, book: Arc<Mutex<TopupBook>>, job: CreditJob) {
    for _ in 0..30 {
        let (rtx, rrx) = oneshot::channel();
        let op = Op::Credit {
            amount: job.units,
            outputs: job.outputs.clone(),
            claim: CreditClaim::Topup {
                diversifier_index: job.index,
                txid: job.txid.clone(),
            },
        };
        if tx.send(Cmd::Op(op, rtx)).await.is_err() {
            break;
        }
        match rrx.await {
            Ok(Ok(done)) => match &done.applied {
                Applied::Effects(e) => {
                    let sigs = e
                        .jobs
                        .iter()
                        .zip(done.signatures)
                        .map(|(j, sig)| SigOut {
                            list: j.list,
                            index: j.index,
                            sig,
                        })
                        .collect();
                    book.lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .credited(&job, sigs);
                    tracing::info!(units = job.units, "top-up credited");
                    return;
                }
                Applied::Refused(r) => tracing::debug!(reason = %r, "credit not yet accepted"),
                _ => break,
            },
            Ok(Err(e)) => tracing::warn!(error = %e, "credit attempt failed"),
            Err(_) => break,
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    tracing::warn!("a top-up stayed uncredited after a minute of retries");
    book.lock()
        .unwrap_or_else(|e| e.into_inner())
        .credit_failed(&job);
}

/// Consume the indexer's events: close a log block per chain block, and credit payments.
pub async fn run_chain(
    mut rx: mpsc::Receiver<ChainEvent>,
    tx: mpsc::Sender<Cmd>,
    book: Arc<Mutex<TopupBook>>,
) {
    while let Some(ev) = rx.recv().await {
        let (jobs, close) = {
            let mut b = book.lock().unwrap_or_else(|e| e.into_inner());
            match &ev {
                ChainEvent::Seen(p) => {
                    (b.on_payment(p, None).into_iter().collect::<Vec<_>>(), None)
                }
                ChainEvent::Block {
                    height,
                    shielded_actions,
                    payments,
                    ..
                } => {
                    let jobs = payments
                        .iter()
                        .filter_map(|p| b.on_payment(p, Some(*height)))
                        .collect();
                    b.set_scanned(*height);
                    (jobs, Some((*height, *shielded_actions)))
                }
            }
        };
        if let Some((height, shielded_actions)) = close {
            let _ = tx
                .send(Cmd::Close {
                    height,
                    chain: ChainStats { shielded_actions },
                })
                .await;
        }
        for job in jobs {
            tokio::spawn(credit(tx.clone(), book.clone(), job));
        }
    }
}

/// Everything the top-up endpoints need.
#[derive(Clone)]
pub struct Desk {
    pub keys: Arc<DepositKeys>,
    pub book: Arc<Mutex<TopupBook>>,
    /// Allowed top-up amounts in zatoshi (testnet: 0.01 / 0.05 / 0.1 / 0.5 TAZ).
    pub denominations: Vec<u64>,
}

pub const DENOMINATIONS_TESTNET: [u64; 4] = [1_000_000, 5_000_000, 10_000_000, 50_000_000];
pub const DENOMINATIONS_MAINNET: [u64; 3] = [100_000, 500_000, 1_000_000];
