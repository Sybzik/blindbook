//! The ledger state and every operation that moves value: trade batches (around the engine),
//! swaps, redemptions, top-up credits and withdrawals.
//!
//! Each operation checks its request, records which slips it spends, and returns **sign jobs**:
//! the blinded outputs the signer must sign and with which denomination. Nothing here verifies a
//! slip's signature (that needs the mint key, so only the signer does it, before signing); the
//! API runs the same code to check requests and build the public log, and the verifier replays
//! the log with it.

use std::collections::{BTreeMap, HashSet};

use blindbook_engine as engine;
use serde::{Deserialize, Serialize};

use crate::hex::H32;
use crate::keysets::{Keyset, KeysetIds, is_denomination, split};
use crate::reference::RefSnapshot;
use crate::wire::{BlindedMessage, Input};

/// Every blank output list holds this many outputs (PROTOCOL section 4).
pub const BLANK_OUTPUTS: usize = 31;
/// At most this many slips spent by one request.
pub const MAX_INPUTS: usize = 64;
/// At most this many outputs per keyset per request with explicit amounts (swaps).
pub const MAX_OUTPUTS: usize = 32;
/// Withdrawal fee in units (20,000 zatoshi, PROTOCOL section 1).
pub const WITHDRAWAL_FEE: u64 = 20;

/// Why a request was refused before anything was spent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum Reject {
    #[error("unknown market")]
    UnknownMarket,
    #[error("market is resolved")]
    MarketResolved,
    #[error("market is not resolved yet")]
    NotResolved,
    #[error("outcome must be 0 or 1")]
    BadOutcome,
    #[error("limit must be 1..=9999 bp")]
    BadLimit,
    #[error("no inputs")]
    NoInputs,
    #[error("too many inputs or outputs")]
    TooMany,
    #[error("a slip belongs to the wrong keyset")]
    WrongKeyset,
    #[error("an amount is not a denomination 2^k, k <= 30")]
    BadDenomination,
    #[error("a malformed point or secret")]
    Malformed,
    #[error("a slip was already spent")]
    Spent,
    #[error("the same slip appears twice")]
    Duplicate,
    #[error("blank outputs must be 31 amount-less outputs of the right keyset")]
    BadBlankOutputs,
    #[error("inputs and outputs don't balance")]
    Unbalanced,
    #[error("no open duel with that id")]
    DuelUnknown,
    #[error("a duel with that id exists")]
    DuelExists,
    #[error("the duel's terms are not the ones offered")]
    DuelTerms,
    #[error("duel shares must be 1..=10,000,000 units at a price of 1..=99 cents")]
    BadDuel,
    #[error("trading has closed for this market")]
    TradingClosed,
    #[error("wrong cancel secret")]
    BadCancel,
    #[error("the amount must be above 0 and at most the inputs' total")]
    BadAmount,
    #[error("nothing to redeem: this outcome pays 0")]
    NothingToRedeem,
    #[error("not a withdrawal denomination")]
    BadWithdrawalAmount,
    #[error("more spent from a keyset than was ever issued")]
    SupplyGuard,
    #[error("a slip's signature is invalid")]
    InvalidSlip,
    #[error("the top-up or voucher claim could not be confirmed")]
    InvalidClaim,
    #[error("the signer did not confirm it: other listing parameters, or not Polygon's result")]
    NotConfirmed,
    #[error("below the market's smallest trade or duel stake (max_trade / 200)")]
    TooSmall,
    #[error("the most open duels are on the board; one must be taken or cancelled first")]
    DuelsFull,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

/// Per-market parameters (PROTOCOL section 1), fixed at listing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketParams {
    pub b: u64,
    pub l: u64,
    pub fee_bp: u32,
    pub max_trade: u64,
    pub halt_ask_ppm: u32,
    pub stale_ms: u64,
}

impl MarketParams {
    pub fn testnet() -> Self {
        Self::from_engine(&engine::Params::testnet())
    }

    pub fn mainnet() -> Self {
        Self::from_engine(&engine::Params::mainnet())
    }

    /// The smallest trade (CREDIT units for a buy, share-units for a sell) and duel stake: every
    /// write lands in the public log that every visitor downloads, so a write must cost
    /// something (the fee on this much is 1%) and dust can't flood the log.
    pub fn min_trade(&self) -> u64 {
        (self.max_trade / MIN_TRADE_DIVISOR).max(1)
    }

    fn from_engine(p: &engine::Params) -> Self {
        MarketParams {
            b: p.b,
            l: p.l,
            fee_bp: p.fee_bp,
            max_trade: p.max_trade,
            halt_ask_ppm: p.halt_ask_ppm,
            stale_ms: p.stale_ms,
        }
    }

    pub fn engine(&self) -> engine::Params {
        engine::Params {
            b: self.b,
            l: self.l,
            fee_bp: self.fee_bp,
            max_trade: self.max_trade,
            halt_ask_ppm: self.halt_ask_ppm,
            stale_ms: self.stale_ms,
            drop_rule: engine::DropRule::LowestTier,
        }
    }
}

/// A market's pool state (the engine's `Market`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pool {
    /// Users' outstanding share-units per outcome.
    pub u: [u64; 2],
    /// Cash the market holds (net of fees); never below −L.
    pub c: i64,
    /// Fees and rounding dust credited to the house.
    pub house: i64,
}

impl Pool {
    fn engine(&self) -> engine::Market {
        engine::Market {
            u: self.u,
            c: self.c,
            house: self.house,
        }
    }

    fn set(&mut self, m: &engine::Market) {
        self.u = m.u;
        self.c = m.c;
        self.house = m.house;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum MarketStatus {
    Open,
    /// Settled from Polygon: a share of outcome i pays `num[i] / den`.
    Resolved {
        den: u64,
        num: [u64; 2],
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketEntry {
    pub id: H32,
    pub params: MarketParams,
    /// Trading halts at the event start and at the end date (Unix ms).
    pub event_start_ms: Option<u64>,
    pub end_ms: u64,
    pub pool: Pool,
    pub status: MarketStatus,
}

/// One blinded output the signer must sign.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignJob {
    /// Keyset id to sign with.
    pub id: String,
    pub amount: u64,
    #[serde(rename = "B_")]
    pub b: String,
    /// Which list of the request it came from, and its index there.
    pub list: OutputList,
    pub index: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputList {
    Outputs,
    Change,
    /// A duel challenger's outputs, sent when the duel opened and signed when it is taken: the
    /// signatures reach the challenger through the public record, not the taker's answer.
    Duel,
}

/// What an accepted request did: slips spent and outputs to sign.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Effects {
    pub spent: Vec<crate::delta::SpentRecord>,
    pub jobs: Vec<SignJob>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TradeRequest {
    pub market: H32,
    pub side: Side,
    pub outcome: u8,
    pub limit_bp: u32,
    /// Buy: CREDIT units to spend. Sell: share-units to sell. At most the inputs' total; the
    /// rest comes back on the change outputs, so a bet never waits for a swap to exact change.
    pub amount: u64,
    pub inputs: Vec<Input>,
    pub outputs: Vec<BlindedMessage>,
    pub change_outputs: Vec<BlindedMessage>,
    /// The "called it" tag `SHA256("bb-called-it" ‖ s)` (PROTOCOL section 6).
    pub tag: H32,
}

/// What the batch knows about a market's reference and Polymarket's state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketInputs {
    pub reference: RefSnapshot,
    pub closed: bool,
    pub accepting_orders: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FillStatus {
    Filled,
    Shrunk,
    DroppedLimit,
    Halted,
    Rejected,
}

impl From<engine::Status> for FillStatus {
    fn from(s: engine::Status) -> Self {
        match s {
            engine::Status::Filled => FillStatus::Filled,
            engine::Status::Shrunk => FillStatus::Shrunk,
            engine::Status::DroppedLimit => FillStatus::DroppedLimit,
            engine::Status::Halted => FillStatus::Halted,
            engine::Status::Rejected => FillStatus::Rejected,
        }
    }
}

/// One order as the public log records it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderRecord {
    pub tag: H32,
    pub side: Side,
    pub outcome: u8,
    /// Buy: CREDIT units paid in. Sell: share-units offered.
    pub amount: u64,
    pub limit_bp: u32,
}

/// One fill as the public log records it. Buy: `kept` = CREDIT kept (net of fee), `out` =
/// share-units issued, `refund` = CREDIT returned. Sell: `kept` = share-units sold, `out` =
/// CREDIT paid, `refund` = share-units returned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FillRecord {
    pub tag: H32,
    pub status: FillStatus,
    pub kept: u64,
    pub out: u64,
    pub fee: u64,
    pub refund: u64,
    /// Average price per share before the fee, in bp (0 if nothing filled).
    pub avg_price_bp: u32,
}

/// One market's part of one batch: everything the verifier needs to replay it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchRecord {
    pub batch_id: u64,
    pub at_ms: u64,
    pub market: H32,
    pub params: MarketParams,
    pub event_start_ms: Option<u64>,
    pub end_ms: u64,
    pub reference: RefSnapshot,
    pub closed: bool,
    pub accepting_orders: bool,
    pub before: Pool,
    pub orders: Vec<OrderRecord>,
    pub halt: Option<String>,
    pub fills: Vec<FillRecord>,
    pub after: Pool,
}

/// The answer to one trade request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TradeOutcome {
    /// `Err`: refused before the batch; nothing was spent.
    pub result: Result<FillRecord, Reject>,
    pub effects: Effects,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchResult {
    pub records: Vec<BatchRecord>,
    /// Same order as the requests.
    pub outcomes: Vec<TradeOutcome>,
}

/// The most share-units on each side of one duel (100 coins).
pub const MAX_DUEL_SHARES: u64 = 10_000_000;

/// The most duels open at once: every visitor's live feed lists them all.
pub const MAX_OPEN_DUELS: usize = 50;

/// `max_trade / MIN_TRADE_DIVISOR` is a market's smallest trade and duel stake (testnet 0.01).
pub const MIN_TRADE_DIVISOR: u64 = 200;

/// A blind duel waiting for a taker (PROTOCOL section 7.1). The challenger's stake is in escrow
/// and the blank outputs for their shares are already here, so a taker completes the set while
/// the challenger is offline: `shares` of the challenger's outcome and `shares` of the other one
/// for exactly `shares` CREDIT paid in by both, so the house carries no risk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Duel {
    pub market: H32,
    pub outcome: u8,
    pub shares: u64,
    pub price_bp: u32,
    /// The challenger's CREDIT in escrow: `ceil(shares · price_bp / 10 000)`.
    pub stake: u64,
    pub opened_ms: u64,
    pub outputs: Vec<BlindedMessage>,
    /// `SHA256(secret)`: whoever knows the secret (the challenger) can cancel an untaken duel.
    pub cancel: H32,
}

/// What the challenger pays for `shares` at `price_bp`; the taker pays the rest of `shares`.
pub fn duel_stake(shares: u64, price_bp: u32) -> u64 {
    (u128::from(shares) * u128::from(price_bp)).div_ceil(10_000) as u64
}

/// A queued withdrawal: the payout address stays sealed to the signer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Withdrawal {
    pub amount: u64,
    /// `SHA256(address ‖ salt)`, public.
    pub commitment: H32,
    /// X25519 sealed box of `{address, salt}`, only the signer can open it.
    pub sealed: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    pub markets: BTreeMap<H32, MarketEntry>,
    /// `Y` of every spent slip.
    pub spent: HashSet<String>,
    /// Units signed per keyset id.
    pub issued: BTreeMap<String, u64>,
    /// Units spent per keyset id.
    pub burned: BTreeMap<String, u64>,
    /// House balance outside the markets: withdrawal fees.
    pub house: i64,
    /// Set for good once anything tried to spend more from a keyset than was issued: all
    /// withdrawals stop until the operator investigates (PROTOCOL section 9, supply guard).
    #[serde(default)]
    pub supply_alarm: bool,
    /// Open blind duels by id.
    #[serde(default)]
    pub duels: BTreeMap<H32, Duel>,
    #[serde(skip)]
    pub keysets: KeysetIds,
}

fn is_point(s: &str) -> bool {
    s.len() == 66
        && (s.starts_with("02") || s.starts_with("03"))
        && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Average price per share in bp: `paid / shares` (both in units), rounded down.
fn price_bp(paid: u64, shares: u64) -> u32 {
    if shares == 0 {
        0
    } else {
        (u128::from(paid) * 10_000 / u128::from(shares)).min(10_000) as u32
    }
}

/// The public record of an engine fill (normative: the verifier rebuilds it the same way).
pub fn fill_record(tag: H32, side: Side, f: &engine::Fill) -> FillRecord {
    FillRecord {
        tag,
        status: f.status.into(),
        kept: f.kept,
        out: f.out,
        fee: f.fee,
        refund: f.refund,
        avg_price_bp: match side {
            Side::Buy => price_bp(f.kept, f.out),
            Side::Sell => price_bp(f.out + f.fee, f.kept),
        },
    }
}

impl Pool {
    /// The engine's market state.
    pub fn to_engine(&self) -> engine::Market {
        self.engine()
    }
}

impl Ledger {
    pub fn new(keysets: KeysetIds) -> Self {
        Ledger {
            keysets,
            ..Ledger::default()
        }
    }

    pub fn list_market(&mut self, m: MarketEntry) {
        self.markets.insert(m.id, m);
    }

    fn keyset_id(&self, kind: Keyset) -> Result<String, Reject> {
        self.keysets
            .id(kind)
            .map(str::to_owned)
            .ok_or(Reject::WrongKeyset)
    }

    /// Check inputs: all from `want`, denominations, well-formed, unspent, not already used in
    /// this batch, within what was issued. Returns their sum.
    fn check_inputs(
        &self,
        inputs: &[Input],
        want: &str,
        batch_spent: &HashSet<String>,
    ) -> Result<u64, Reject> {
        if inputs.is_empty() {
            return Err(Reject::NoInputs);
        }
        if inputs.len() > MAX_INPUTS {
            return Err(Reject::TooMany);
        }
        let mut seen = HashSet::new();
        let mut sum = 0u64;
        for i in inputs {
            if i.proof.id != want {
                return Err(Reject::WrongKeyset);
            }
            if !is_denomination(i.proof.amount) {
                return Err(Reject::BadDenomination);
            }
            if !is_point(&i.y)
                || !is_point(&i.proof.c)
                || i.proof.secret.is_empty()
                || i.proof.secret.len() > 128
            {
                return Err(Reject::Malformed);
            }
            if self.spent.contains(&i.y) || batch_spent.contains(&i.y) {
                return Err(Reject::Spent);
            }
            if !seen.insert(i.y.as_str()) {
                return Err(Reject::Duplicate);
            }
            sum += i.proof.amount;
        }
        let issued = self.issued.get(want).copied().unwrap_or(0);
        let burned = self.burned.get(want).copied().unwrap_or(0);
        if burned + sum > issued {
            return Err(Reject::SupplyGuard);
        }
        Ok(sum)
    }

    fn check_blank(list: &[BlindedMessage], want: &str) -> Result<(), Reject> {
        let mut seen = HashSet::new();
        let ok = list.len() == BLANK_OUTPUTS
            && list
                .iter()
                .all(|o| o.amount == 0 && o.id == want && is_point(&o.b) && seen.insert(&o.b));
        if ok {
            Ok(())
        } else {
            Err(Reject::BadBlankOutputs)
        }
    }

    fn spend(&mut self, inputs: &[Input], effects: &mut Effects) {
        for i in inputs {
            self.spent.insert(i.y.clone());
            *self.burned.entry(i.proof.id.clone()).or_default() += i.proof.amount;
            effects.spent.push(crate::delta::SpentRecord {
                y: i.y.clone(),
                id: i.proof.id.clone(),
                amount: i.proof.amount,
            });
        }
    }

    /// Fill blank outputs with the binary digits of `amount`, smallest first.
    fn fill_blank(
        &mut self,
        list: &[BlindedMessage],
        which: OutputList,
        amount: u64,
        effects: &mut Effects,
    ) {
        for (index, (o, amt)) in list.iter().zip(split(amount)).enumerate() {
            *self.issued.entry(o.id.clone()).or_default() += amt;
            effects.jobs.push(SignJob {
                id: o.id.clone(),
                amount: amt,
                b: o.b.clone(),
                list: which,
                index,
            });
        }
    }

    /// Check a trade request against the current state, `batch_spent` holding the `Y`s already
    /// claimed by requests waiting for the same batch. Returns the inputs' total. The API runs
    /// this when a request arrives, so only requests that will clear enter a batch.
    pub fn check_trade(
        &self,
        r: &TradeRequest,
        batch_spent: &HashSet<String>,
    ) -> Result<u64, Reject> {
        let m = self.markets.get(&r.market).ok_or(Reject::UnknownMarket)?;
        if m.status != MarketStatus::Open {
            return Err(Reject::MarketResolved);
        }
        if r.outcome > 1 {
            return Err(Reject::BadOutcome);
        }
        if !(1..10_000).contains(&r.limit_bp) {
            return Err(Reject::BadLimit);
        }
        let credit = self.keyset_id(Keyset::Credit)?;
        let position = self.keyset_id(Keyset::Outcome {
            market: r.market,
            outcome: r.outcome,
        })?;
        let (pay_with, get, change) = match r.side {
            Side::Buy => (&credit, &position, &credit),
            Side::Sell => (&position, &credit, &position),
        };
        Self::check_blank(&r.outputs, get)?;
        Self::check_blank(&r.change_outputs, change)?;
        let total = self.check_inputs(&r.inputs, pay_with, batch_spent)?;
        if r.amount == 0 || r.amount > total {
            return Err(Reject::BadAmount);
        }
        if r.amount < m.params.min_trade() {
            return Err(Reject::TooSmall);
        }
        Ok(total)
    }

    /// Clear one 2-second batch over every market it touches.
    ///
    /// Invalid requests are answered with a [`Reject`] and spend nothing; the rest go to the
    /// engine market by market. A market without [`MarketInputs`] is priced from an empty
    /// reference, which halts it (everything is refunded).
    pub fn clear_trades(
        &mut self,
        batch_id: u64,
        now_ms: u64,
        reqs: &[TradeRequest],
        refs: &BTreeMap<H32, MarketInputs>,
    ) -> BatchResult {
        let mut outcomes: Vec<Option<TradeOutcome>> = vec![None; reqs.len()];
        // The inputs' total per request; `amount` of it trades, the rest is change.
        let mut totals = vec![0u64; reqs.len()];
        let mut batch_spent = HashSet::new();
        let mut by_market: BTreeMap<H32, Vec<usize>> = BTreeMap::new();
        for (i, r) in reqs.iter().enumerate() {
            match self.check_trade(r, &batch_spent) {
                Ok(total) => {
                    totals[i] = total;
                    batch_spent.extend(r.inputs.iter().map(|x| x.y.clone()));
                    by_market.entry(r.market).or_default().push(i);
                }
                Err(e) => {
                    outcomes[i] = Some(TradeOutcome {
                        result: Err(e),
                        effects: Effects::default(),
                    })
                }
            }
        }

        let mut records = Vec::new();
        for (market, idx) in by_market {
            let entry = self.markets[&market].clone();
            let inputs = refs.get(&market).cloned().unwrap_or(MarketInputs {
                reference: RefSnapshot::empty(now_ms),
                closed: false,
                accepting_orders: false,
            });
            let orders: Vec<engine::Order> = idx
                .iter()
                .enumerate()
                .map(|(k, &i)| engine::Order {
                    id: k as u64,
                    side: match reqs[i].side {
                        Side::Buy => engine::Side::Buy,
                        Side::Sell => engine::Side::Sell,
                    },
                    outcome: reqs[i].outcome,
                    amount: reqs[i].amount,
                    limit_bp: reqs[i].limit_bp,
                })
                .collect();
            let reference = inputs
                .reference
                .to_engine(inputs.closed, inputs.accepting_orders);
            let schedule = engine::Schedule {
                now_ms,
                event_start_ms: entry.event_start_ms,
                end_ms: entry.end_ms,
            };
            let mut pool = entry.pool.engine();
            let report = engine::clear_batch(
                &mut pool,
                &entry.params.engine(),
                &reference,
                &schedule,
                &orders,
                &mut engine::Trace::off(),
            );
            let mut fills = Vec::with_capacity(idx.len());
            for (f, &i) in report.fills.iter().zip(&idx) {
                let r = &reqs[i];
                let fill = fill_record(r.tag, r.side, f);
                let mut effects = Effects::default();
                self.spend(&r.inputs, &mut effects);
                self.fill_blank(&r.outputs, OutputList::Outputs, f.out, &mut effects);
                let change = f.refund + (totals[i] - r.amount);
                self.fill_blank(&r.change_outputs, OutputList::Change, change, &mut effects);
                fills.push(fill.clone());
                outcomes[i] = Some(TradeOutcome {
                    result: Ok(fill),
                    effects,
                });
            }
            let m = self.markets.get_mut(&market).expect("listed");
            m.pool.set(&pool);
            records.push(BatchRecord {
                batch_id,
                at_ms: now_ms,
                market,
                params: entry.params,
                event_start_ms: entry.event_start_ms,
                end_ms: entry.end_ms,
                reference: inputs.reference,
                closed: inputs.closed,
                accepting_orders: inputs.accepting_orders,
                before: entry.pool,
                orders: idx
                    .iter()
                    .map(|&i| OrderRecord {
                        tag: reqs[i].tag,
                        side: reqs[i].side,
                        outcome: reqs[i].outcome,
                        amount: reqs[i].amount,
                        limit_bp: reqs[i].limit_bp,
                    })
                    .collect(),
                halt: report.halt.map(|h| format!("{h:?}")),
                fills,
                after: m.pool,
            });
        }
        BatchResult {
            records,
            outcomes: outcomes
                .into_iter()
                .map(|o| o.expect("every request answered"))
                .collect(),
        }
    }

    /// Exchange slips for new ones of the same keyset and total (split, merge, or take over a
    /// slip someone handed you).
    pub fn swap(
        &mut self,
        inputs: &[Input],
        outputs: &[BlindedMessage],
    ) -> Result<Effects, Reject> {
        let id = inputs.first().ok_or(Reject::NoInputs)?.proof.id.clone();
        if self.keysets.kind(&id).is_none() {
            return Err(Reject::WrongKeyset);
        }
        let sum = self.check_inputs(inputs, &id, &HashSet::new())?;
        if outputs.is_empty() || outputs.len() > MAX_OUTPUTS {
            return Err(Reject::TooMany);
        }
        let mut seen = HashSet::new();
        let mut out = 0u64;
        for o in outputs {
            if o.id != id {
                return Err(Reject::WrongKeyset);
            }
            if !is_denomination(o.amount) {
                return Err(Reject::BadDenomination);
            }
            if !is_point(&o.b) || !seen.insert(&o.b) {
                return Err(Reject::Malformed);
            }
            out += o.amount;
        }
        if out != sum {
            return Err(Reject::Unbalanced);
        }
        let mut effects = Effects::default();
        self.spend(inputs, &mut effects);
        for (index, o) in outputs.iter().enumerate() {
            *self.issued.entry(id.clone()).or_default() += o.amount;
            effects.jobs.push(SignJob {
                id: id.clone(),
                amount: o.amount,
                b: o.b.clone(),
                list: OutputList::Outputs,
                index,
            });
        }
        Ok(effects)
    }

    /// Redeem shares of a resolved market for CREDIT: `floor(a · num / den)` for the request's
    /// `a` share-units; the rounding dust goes to the house.
    pub fn redeem(
        &mut self,
        inputs: &[Input],
        credit_outputs: &[BlindedMessage],
    ) -> Result<(u64, Effects), Reject> {
        let id = inputs.first().ok_or(Reject::NoInputs)?.proof.id.clone();
        let Some(Keyset::Outcome { market, outcome }) = self.keysets.kind(&id) else {
            return Err(Reject::WrongKeyset);
        };
        let m = self.markets.get(&market).ok_or(Reject::UnknownMarket)?;
        let MarketStatus::Resolved { den, num } = m.status else {
            return Err(Reject::NotResolved);
        };
        let credit = self.keyset_id(Keyset::Credit)?;
        Self::check_blank(credit_outputs, &credit)?;
        let shares = self.check_inputs(inputs, &id, &HashSet::new())?;
        let exact = u128::from(shares) * u128::from(num[outcome as usize]);
        let pay = (exact / u128::from(den)) as u64;
        if pay == 0 {
            return Err(Reject::NothingToRedeem);
        }
        let mut effects = Effects::default();
        self.spend(inputs, &mut effects);
        self.fill_blank(credit_outputs, OutputList::Outputs, pay, &mut effects);
        Ok((pay, effects))
    }

    /// Credit a top-up (or a judge voucher) of `amount` units as CREDIT slips.
    pub fn credit(
        &mut self,
        amount: u64,
        credit_outputs: &[BlindedMessage],
    ) -> Result<Effects, Reject> {
        let credit = self.keyset_id(Keyset::Credit)?;
        Self::check_blank(credit_outputs, &credit)?;
        let mut effects = Effects::default();
        self.fill_blank(credit_outputs, OutputList::Outputs, amount, &mut effects);
        Ok(effects)
    }

    /// Spend CREDIT slips for a withdrawal of `amount` units (a standard denomination) plus the
    /// fee; the rest comes back on blank change outputs.
    pub fn withdraw(
        &mut self,
        inputs: &[Input],
        amount: u64,
        change_outputs: &[BlindedMessage],
        allowed_amounts: &[u64],
    ) -> Result<Effects, Reject> {
        if !allowed_amounts.contains(&amount) {
            return Err(Reject::BadWithdrawalAmount);
        }
        let credit = self.keyset_id(Keyset::Credit)?;
        Self::check_blank(change_outputs, &credit)?;
        let sum = self.check_inputs(inputs, &credit, &HashSet::new())?;
        let change = sum
            .checked_sub(amount + WITHDRAWAL_FEE)
            .ok_or(Reject::Unbalanced)?;
        let mut effects = Effects::default();
        self.spend(inputs, &mut effects);
        self.fill_blank(change_outputs, OutputList::Change, change, &mut effects);
        self.house += WITHDRAWAL_FEE as i64;
        Ok(effects)
    }

    /// Can the market still be traded at `now_ms` (open, before the event start and the end)?
    fn trading_open(&self, market: H32, now_ms: u64) -> Result<&MarketEntry, Reject> {
        let m = self.markets.get(&market).ok_or(Reject::UnknownMarket)?;
        if m.status != MarketStatus::Open {
            return Err(Reject::MarketResolved);
        }
        if m.event_start_ms.is_some_and(|s| now_ms >= s) || now_ms >= m.end_ms {
            return Err(Reject::TradingClosed);
        }
        Ok(m)
    }

    /// Open a duel: escrow the challenger's stake, keep their blank outputs for the shares.
    #[allow(clippy::too_many_arguments)]
    pub fn duel_open(
        &mut self,
        duel: H32,
        market: H32,
        outcome: u8,
        shares: u64,
        price_bp: u32,
        now_ms: u64,
        inputs: &[Input],
        change: &[BlindedMessage],
        outputs: &[BlindedMessage],
        cancel: H32,
    ) -> Result<Effects, Reject> {
        if self.duels.contains_key(&duel) {
            return Err(Reject::DuelExists);
        }
        if self.duels.len() >= MAX_OPEN_DUELS {
            return Err(Reject::DuelsFull);
        }
        let min_stake = self.trading_open(market, now_ms)?.params.min_trade();
        if outcome > 1 {
            return Err(Reject::BadOutcome);
        }
        if !(100..=9_900).contains(&price_bp) || shares == 0 || shares > MAX_DUEL_SHARES {
            return Err(Reject::BadDuel);
        }
        let credit = self.keyset_id(Keyset::Credit)?;
        let position = self.keyset_id(Keyset::Outcome { market, outcome })?;
        Self::check_blank(change, &credit)?;
        Self::check_blank(outputs, &position)?;
        let sum = self.check_inputs(inputs, &credit, &HashSet::new())?;
        let stake = duel_stake(shares, price_bp);
        if stake < min_stake {
            return Err(Reject::TooSmall);
        }
        if stake == 0 || stake >= shares || sum < stake {
            return Err(Reject::Unbalanced);
        }
        let mut effects = Effects::default();
        self.spend(inputs, &mut effects);
        self.fill_blank(change, OutputList::Change, sum - stake, &mut effects);
        self.duels.insert(
            duel,
            Duel {
                market,
                outcome,
                shares,
                price_bp,
                stake,
                opened_ms: now_ms,
                outputs: outputs.to_vec(),
                cancel,
            },
        );
        Ok(effects)
    }

    /// Take a duel: pay the rest of the set, get the other outcome's shares now; the
    /// challenger's shares are signed at the same time on the outputs they left.
    #[allow(clippy::too_many_arguments)]
    pub fn duel_take(
        &mut self,
        duel: H32,
        terms: (u8, u64, u32),
        now_ms: u64,
        inputs: &[Input],
        outputs: &[BlindedMessage],
        change: &[BlindedMessage],
    ) -> Result<Effects, Reject> {
        let d = self.duels.get(&duel).ok_or(Reject::DuelUnknown)?.clone();
        if (d.outcome, d.shares, d.price_bp) != terms {
            return Err(Reject::DuelTerms);
        }
        self.trading_open(d.market, now_ms)?;
        let credit = self.keyset_id(Keyset::Credit)?;
        let other = self.keyset_id(Keyset::Outcome {
            market: d.market,
            outcome: 1 - d.outcome,
        })?;
        Self::check_blank(outputs, &other)?;
        Self::check_blank(change, &credit)?;
        let sum = self.check_inputs(inputs, &credit, &HashSet::new())?;
        let cost = d.shares - d.stake;
        if sum < cost {
            return Err(Reject::Unbalanced);
        }
        let mut effects = Effects::default();
        self.spend(inputs, &mut effects);
        self.fill_blank(outputs, OutputList::Outputs, d.shares, &mut effects);
        self.fill_blank(change, OutputList::Change, sum - cost, &mut effects);
        self.fill_blank(&d.outputs, OutputList::Duel, d.shares, &mut effects);
        self.duels.remove(&duel);
        Ok(effects)
    }

    /// Cancel an untaken duel: the stake comes back to the challenger as CREDIT.
    pub fn duel_cancel(
        &mut self,
        duel: H32,
        secret: &str,
        outputs: &[BlindedMessage],
    ) -> Result<Effects, Reject> {
        use sha2::{Digest, Sha256};
        let d = self.duels.get(&duel).ok_or(Reject::DuelUnknown)?.clone();
        let raw = crate::hex::decode(secret).ok_or(Reject::BadCancel)?;
        if raw.len() != 32 || Sha256::digest(&raw).as_slice() != d.cancel.0 {
            return Err(Reject::BadCancel);
        }
        let credit = self.keyset_id(Keyset::Credit)?;
        Self::check_blank(outputs, &credit)?;
        let mut effects = Effects::default();
        self.fill_blank(outputs, OutputList::Outputs, d.stake, &mut effects);
        self.duels.remove(&duel);
        Ok(effects)
    }

    /// CREDIT held in escrow by open duels (owed back, or turned into shares when taken).
    pub fn duel_escrow(&self) -> u64 {
        self.duels.values().map(|d| d.stake).sum()
    }

    /// Record a market's on-chain result.
    pub fn resolve(&mut self, market: H32, den: u64, num: [u64; 2]) -> Result<(), Reject> {
        let m = self.markets.get_mut(&market).ok_or(Reject::UnknownMarket)?;
        if den == 0 || num[0] + num[1] != den {
            return Err(Reject::Unbalanced);
        }
        m.status = MarketStatus::Resolved { den, num };
        Ok(())
    }

    /// Slips of a keyset still out there: issued minus spent.
    pub fn outstanding(&self, kind: Keyset) -> u64 {
        let Some(id) = self.keysets.id(kind) else {
            return 0;
        };
        self.issued.get(id).copied().unwrap_or(0) - self.burned.get(id).copied().unwrap_or(0)
    }

    /// What the reserve must hold at least (the public solvency check, PROTOCOL section 5.3):
    /// CREDIT outstanding, plus for each open market the payout if its larger side wins, plus for
    /// each resolved market what its unredeemed winning shares pay.
    pub fn required_reserve(&self) -> u64 {
        let mut total = self.outstanding(Keyset::Credit) + self.duel_escrow();
        for m in self.markets.values() {
            let out = |outcome| {
                self.outstanding(Keyset::Outcome {
                    market: m.id,
                    outcome,
                })
            };
            total += match m.status {
                MarketStatus::Open => out(0).max(out(1)),
                MarketStatus::Resolved { den, num } => {
                    let owed = u128::from(out(0)) * u128::from(num[0])
                        + u128::from(out(1)) * u128::from(num[1]);
                    owed.div_ceil(u128::from(den)) as u64
                }
            };
        }
        total
    }
}
