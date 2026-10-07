//! The signer's core (PROTOCOL section 9): the only holder of the mint master key.
//!
//! For every operation the API sequences, the signer
//! 1. checks each slip it spends: `Y` matches its secret and `C == k·hash_to_curve(x)` for the
//!    slip's keyset and amount (only the key holder can do this);
//! 2. checks every blinded output is a curve point, so signing can't fail half-way;
//! 3. checks top-up claims against its own indexer and vouchers against its own list;
//! 4. applies the operation to its own ledger replica with [`blindbook_ledger::ops::apply`], the
//!    same code the API runs, leaving out what failed the checks;
//! 5. signs exactly the jobs that produced, each with a NUT-12 DLEQ proof.
//!
//! It never signs because the API asked: a compromised API can only send operations the
//! signer's own replica accepts.

use std::collections::HashMap;

use blindbook_ledger::H32;
use blindbook_ledger::keysets::{Keyset, KeysetIds};
use blindbook_ledger::ledger::{Ledger, MAX_OUTPUTS, SignJob};
use blindbook_ledger::ops::{self, Applied, CreditClaim, Op, Reply};
use blindbook_ledger::wire::{self, BlindedMessage, Input};
use blindbook_mint::cashu::PublicKey;
use blindbook_mint::{KeysetKind, MasterKey, SecretKeyset, y_hex};

pub mod link;
pub mod payouts;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("keyset ids differ from the ones derived from M: {0}")]
    KeysetMismatch(String),
    #[error("mint: {0}")]
    Mint(#[from] blindbook_mint::Error),
    #[error("signing failed after the operation was applied: {0}")]
    Signing(String),
}

/// A payment to a one-time top-up address, from the signer's own indexer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deposit {
    pub diversifier_index: u64,
    /// CREDIT units (1,000 zatoshi each, rounded down).
    pub amount: u64,
    pub txid: String,
    /// Mined (at least one confirmation).
    pub confirmed: bool,
}

/// A withdrawal waiting for the next payout transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingPayout {
    pub commitment: H32,
    /// The unified address, opened from the sealed blob (only ever in the signer's memory).
    pub address: String,
    /// CREDIT units (the payout sends units × 1,000 zatoshi).
    pub amount: u64,
}

/// Payouts go only to unified addresses with an Orchard-protocol receiver on our network
/// (PROTOCOL section 10).
pub fn payout_address_ok(address: &str, testnet: bool) -> bool {
    use zcash_address::unified::{self, Container, Encoding};
    match unified::Address::decode(address) {
        Ok((net, _, ua)) => {
            let net_ok = match net {
                zcash_protocol::consensus::NetworkType::Main => !testnet,
                zcash_protocol::consensus::NetworkType::Test
                | zcash_protocol::consensus::NetworkType::Regtest => testnet,
            };
            net_ok
                && ua
                    .items()
                    .iter()
                    .any(|r| matches!(r, unified::Receiver::Orchard(_)))
        }
        Err(_) => false,
    }
}

/// How much may be credited before a confirmation (PROTOCOL section 1, THREAT_MODEL I9).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZeroConf {
    pub per_topup: u64,
    pub total: u64,
}

impl ZeroConf {
    /// Testnet: 0.1 TAZ per top-up, 0.3 TAZ unconfirmed in total.
    pub const TESTNET: ZeroConf = ZeroConf {
        per_topup: 10_000,
        total: 30_000,
    };
    /// Mainnet: 0.005 / 0.01 ZEC.
    pub const MAINNET: ZeroConf = ZeroConf {
        per_topup: 500,
        total: 1_000,
    };
}

pub struct Signer {
    master: MasterKey,
    keysets: HashMap<String, SecretKeyset>,
    pub ledger: Ledger,
    /// `SHA256(code)` → amount, for vouchers not used yet.
    vouchers: HashMap<H32, u64>,
    /// Payments the signer's indexer saw and nobody claimed yet, by txid.
    deposits: HashMap<String, Deposit>,
    /// Txids already credited: never again, whatever the indexer replays.
    credited: std::collections::HashSet<String>,
    /// Credited before their first confirmation, by txid (units).
    unconfirmed: HashMap<String, u64>,
    zero_conf: ZeroConf,
    /// X25519 secret for sealed withdrawal addresses, and whether we run on testnet.
    seal: Option<([u8; 32], bool)>,
    /// Withdrawals applied and not paid out yet, in order.
    payouts: Vec<PendingPayout>,
    /// Chain transactions the treasury made and wants in the log.
    events: Vec<blindbook_ledger::delta::LogEvent>,
}

fn kind_of(k: Keyset) -> KeysetKind {
    match k {
        Keyset::Credit => KeysetKind::Credit,
        Keyset::Outcome { market, outcome } => KeysetKind::Outcome {
            market_id: market.0,
            outcome,
        },
    }
}

/// A time the API puts in an operation must be within two minutes of the signer's own clock.
fn clock_ok(now_ms: u64) -> bool {
    let mine = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    mine.abs_diff(now_ms) <= 120_000
}

impl Signer {
    pub fn new(master: MasterKey) -> Result<Self, Error> {
        let credit = master.keyset(KeysetKind::Credit)?;
        let mut ids = KeysetIds::default();
        ids.insert(Keyset::Credit, credit.public.id.to_string());
        let mut keysets = HashMap::new();
        keysets.insert(credit.public.id.to_string(), credit);
        Ok(Signer {
            master,
            keysets,
            ledger: Ledger::new(ids),
            vouchers: HashMap::new(),
            deposits: HashMap::new(),
            credited: Default::default(),
            unconfirmed: HashMap::new(),
            zero_conf: ZeroConf::TESTNET,
            seal: None,
            payouts: Vec::new(),
            events: Vec::new(),
        })
    }

    /// The master public key `M`, as pinned in the app build.
    pub fn public_key(&self) -> PublicKey {
        self.master.public_key()
    }

    pub fn credit_id(&self) -> String {
        self.ledger
            .keysets
            .id(Keyset::Credit)
            .expect("credit keyset")
            .to_owned()
    }

    /// Add judge vouchers (by `SHA256(code)`), each worth `amount` units.
    pub fn add_vouchers(&mut self, hashes: impl IntoIterator<Item = H32>, amount: u64) {
        self.vouchers
            .extend(hashes.into_iter().map(|h| (h, amount)));
    }

    pub fn set_zero_conf(&mut self, z: ZeroConf) {
        self.zero_conf = z;
    }

    /// The X25519 secret that opens sealed withdrawal addresses.
    pub fn set_seal_key(&mut self, secret: [u8; 32], testnet: bool) {
        self.seal = Some((secret, testnet));
    }

    /// Withdrawals waiting for a payout, oldest first.
    pub fn payout_queue(&self) -> &[PendingPayout] {
        &self.payouts
    }

    /// The treasury made a chain transaction: it goes into the log once the API records it.
    pub fn report_event(&mut self, e: blindbook_ledger::delta::LogEvent) {
        if !self.events.contains(&e) {
            self.events.push(e);
        }
    }

    /// Events reported and not recorded yet.
    pub fn pending_events(&self) -> &[blindbook_ledger::delta::LogEvent] {
        &self.events
    }

    fn open_sealed(&self, sealed: &str, commitment: &H32) -> Option<String> {
        let (sk, testnet) = self.seal?;
        let address = blindbook_seal::open(&sk, sealed, &commitment.0).ok()?;
        payout_address_ok(&address, testnet).then_some(address)
    }

    /// Record a payment the signer's own indexer saw (again when it is mined).
    pub fn deposit_seen(&mut self, d: Deposit) {
        if self.credited.contains(&d.txid) {
            if d.confirmed {
                self.unconfirmed.remove(&d.txid);
            }
            return;
        }
        let e = self.deposits.entry(d.txid.clone()).or_insert(d.clone());
        e.confirmed |= d.confirmed;
    }

    fn topup_claim_ok(&self, index: u64, txid: &str, amount: u64) -> bool {
        let Some(d) = self.deposits.get(txid) else {
            return false;
        };
        if d.diversifier_index != index || amount > d.amount || amount == 0 {
            return false;
        }
        let pending: u64 = self.unconfirmed.values().sum();
        d.confirmed
            || (amount <= self.zero_conf.per_topup && pending + amount <= self.zero_conf.total)
    }

    fn input_ok(&self, i: &Input) -> bool {
        let Some(ks) = self.keysets.get(&i.proof.id) else {
            return false;
        };
        let Ok(c) = PublicKey::from_hex(&i.proof.c) else {
            return false;
        };
        y_hex(&i.proof.secret).is_ok_and(|y| y == i.y)
            && ks
                .verify_spend(i.proof.amount, i.proof.secret.as_bytes(), &c)
                .unwrap_or(false)
    }

    fn outputs_ok(list: &[BlindedMessage]) -> bool {
        list.len() <= MAX_OUTPUTS && list.iter().all(|o| PublicKey::from_hex(&o.b).is_ok())
    }

    /// Indices of requests (trades) or `[0]` (other operations) that fail the signer's checks.
    fn invalid(&mut self, op: &Op) -> Vec<usize> {
        match op {
            Op::Trades { reqs, .. } => reqs
                .iter()
                .enumerate()
                .filter(|(_, r)| {
                    !(r.inputs.iter().all(|i| self.input_ok(i))
                        && Self::outputs_ok(&r.outputs)
                        && Self::outputs_ok(&r.change_outputs))
                })
                .map(|(i, _)| i)
                .collect(),
            Op::Swap { inputs, outputs } | Op::Redeem { inputs, outputs } => {
                let ok = inputs.iter().all(|i| self.input_ok(i)) && Self::outputs_ok(outputs);
                if ok { vec![] } else { vec![0] }
            }
            Op::Withdraw {
                inputs,
                change,
                commitment,
                sealed,
                ..
            } => {
                // The address must open and be payable before any CREDIT is spent.
                let ok = inputs.iter().all(|i| self.input_ok(i))
                    && Self::outputs_ok(change)
                    && self.open_sealed(sealed, commitment).is_some();
                if ok { vec![] } else { vec![0] }
            }
            Op::Record { event } => {
                if self.events.contains(event) {
                    vec![]
                } else {
                    vec![0]
                }
            }
            Op::Credit {
                amount,
                outputs,
                claim,
            } => {
                let claim_ok = match claim {
                    CreditClaim::Voucher { code_hash } => {
                        self.vouchers.get(code_hash) == Some(amount)
                    }
                    CreditClaim::Topup {
                        diversifier_index,
                        txid,
                    } => self.topup_claim_ok(*diversifier_index, txid, *amount),
                };
                if claim_ok && Self::outputs_ok(outputs) {
                    vec![]
                } else {
                    vec![0]
                }
            }
            Op::DuelOpen {
                inputs,
                change,
                outputs,
                now_ms,
                ..
            } => {
                let ok = inputs.iter().all(|i| self.input_ok(i))
                    && Self::outputs_ok(change)
                    && Self::outputs_ok(outputs)
                    && clock_ok(*now_ms);
                if ok { vec![] } else { vec![0] }
            }
            Op::DuelTake {
                inputs,
                outputs,
                change,
                now_ms,
                ..
            } => {
                // The time decides whether trading is still open: the API can't backdate a take.
                let ok = inputs.iter().all(|i| self.input_ok(i))
                    && Self::outputs_ok(outputs)
                    && Self::outputs_ok(change)
                    && clock_ok(*now_ms);
                if ok { vec![] } else { vec![0] }
            }
            Op::DuelCancel { outputs, .. } => {
                if Self::outputs_ok(outputs) {
                    vec![]
                } else {
                    vec![0]
                }
            }
            Op::ListMarket { .. } | Op::Resolve { .. } | Op::Close { .. } => vec![],
        }
    }

    fn sign(&self, job: &SignJob) -> Result<wire::BlindSignature, Error> {
        let ks = self
            .keysets
            .get(&job.id)
            .ok_or_else(|| Error::Signing(format!("no keyset {}", job.id)))?;
        let b = PublicKey::from_hex(&job.b).map_err(|e| Error::Signing(e.to_string()))?;
        let sig = ks.sign(job.amount, &b)?;
        let dleq = sig
            .dleq
            .ok_or_else(|| Error::Signing("signature without DLEQ".into()))?;
        Ok(wire::BlindSignature {
            amount: job.amount,
            id: job.id.clone(),
            c: sig.c.to_hex(),
            dleq: wire::Dleq {
                e: dleq.e.to_secret_hex(),
                s: dleq.s.to_secret_hex(),
            },
        })
    }

    /// Derive and check the keysets of a market being listed.
    fn prepare(&mut self, op: &Op) -> Result<(), Error> {
        if let Op::ListMarket { entry, keysets } = op {
            for (o, want) in keysets.iter().enumerate() {
                let kind = kind_of(Keyset::Outcome {
                    market: entry.id,
                    outcome: o as u8,
                });
                let ks = self.master.keyset(kind)?;
                if ks.public.id.to_string() != *want {
                    return Err(Error::KeysetMismatch(format!(
                        "outcome {o}: derived {}, asked {want}",
                        ks.public.id
                    )));
                }
                self.keysets.insert(want.clone(), ks);
            }
        }
        Ok(())
    }

    /// What an applied operation changes outside the ledger: claims used up, withdrawals
    /// queued, payouts done, events recorded.
    fn consume_claim(&mut self, op: &Op, applied: &Applied) {
        if let (
            Op::Withdraw {
                amount,
                commitment,
                sealed,
                ..
            },
            Applied::Effects(_),
        ) = (op, applied)
            && let Some(address) = self.open_sealed(sealed, commitment)
        {
            self.payouts.push(PendingPayout {
                commitment: *commitment,
                address,
                amount: *amount,
            });
        }
        if let (Op::Record { event }, Applied::Done) = (op, applied) {
            self.events.retain(|e| e != event);
            if let blindbook_ledger::delta::LogEvent::PayoutSent { commitments, .. } = event {
                self.payouts
                    .retain(|p| !commitments.contains(&p.commitment));
            }
        }
        if let (Op::Credit { claim, .. }, Applied::Effects(_)) = (op, applied) {
            match claim {
                CreditClaim::Voucher { code_hash } => {
                    self.vouchers.remove(code_hash);
                }
                CreditClaim::Topup { txid, .. } => {
                    let d = self.deposits.remove(txid);
                    if let (Op::Credit { amount, .. }, Some(d)) = (op, &d)
                        && !d.confirmed
                    {
                        self.unconfirmed.insert(txid.clone(), *amount);
                    }
                    self.credited.insert(txid.clone());
                }
            }
        }
    }

    /// Check, apply and sign one operation.
    pub fn handle(&mut self, op: &Op) -> Result<(Reply, Applied), Error> {
        self.prepare(op)?;
        let invalid = self.invalid(op);
        let applied = ops::apply(&mut self.ledger, op, &invalid);
        self.consume_claim(op, &applied);
        let signatures = applied
            .jobs()
            .into_iter()
            .map(|j| self.sign(j))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((
            Reply {
                invalid,
                signatures,
                root: None,
            },
            applied,
        ))
    }

    /// Re-apply an operation from the signer's own journal after a restart: no checks, no
    /// signing (both happened when it first ran).
    pub fn replay(&mut self, op: &Op, invalid: &[usize]) -> Result<Applied, Error> {
        self.prepare(op)?;
        let applied = ops::apply(&mut self.ledger, op, invalid);
        self.consume_claim(op, &applied);
        Ok(applied)
    }
}
