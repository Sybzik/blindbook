//! Whole flows through the ledger with a toy wallet: top-up → buy → sell → resolve → redeem →
//! withdraw, the refusals, and a property test of the public solvency check.

use std::collections::BTreeMap;

use blindbook_ledger::canonical::sha256;
use blindbook_ledger::hex::{H32, encode};
use blindbook_ledger::keysets::{Keyset, KeysetIds};
use blindbook_ledger::ledger::{
    Effects, FillStatus, Ledger, MarketEntry, MarketInputs, MarketParams, MarketStatus, Pool,
    Reject, Side, TradeRequest, WITHDRAWAL_FEE,
};
use blindbook_ledger::reference::RefSnapshot;
use blindbook_ledger::wire::{BlindedMessage, Input, Proof};
use proptest::prelude::*;

const M: H32 = H32([7; 32]);
const CREDIT: &str = "01credit";
const POS: [&str; 2] = ["01m7a", "01m7b"];
const WITHDRAW_AMOUNTS: [u64; 3] = [1_000, 5_000, 10_000];

fn point(tag: &str, n: u64) -> String {
    let mut pre = tag.as_bytes().to_vec();
    pre.extend_from_slice(&n.to_be_bytes());
    format!("02{}", encode(&sha256(&pre)))
}

fn reference(mid: u32, half: u32) -> MarketInputs {
    let ask_a = mid + half;
    let bid_a = mid - half;
    MarketInputs {
        reference: RefSnapshot {
            at_ms: 1_000,
            mid_samples: vec![mid; 30],
            mid_ppm: mid,
            ask_ppm: [ask_a, 1_000_000 - bid_a],
            bid_ppm: [bid_a, 1_000_000 - ask_a],
            guard_micro: 500_000_000,
            best_bid_ppm: [bid_a, 1_000_000 - ask_a],
            best_ask_ppm: [ask_a, 1_000_000 - bid_a],
            server_ts_ms: [1_000; 2],
            unhealthy_ms: 0,
        },
        closed: false,
        accepting_orders: true,
    }
}

/// A ledger with one market and a wallet that "unblinds" every sign job into a slip.
struct World {
    l: Ledger,
    n: u64,
    /// Slips held, per keyset id.
    slips: BTreeMap<String, Vec<Input>>,
    /// What the reserve holds: top-ups and buffers in, withdrawals out (fees stay in).
    reserve: i128,
    batch: u64,
}

impl World {
    fn new() -> Self {
        let mut ids = KeysetIds::default();
        ids.insert(Keyset::Credit, CREDIT.into());
        for (o, id) in POS.iter().enumerate() {
            ids.insert(
                Keyset::Outcome {
                    market: M,
                    outcome: o as u8,
                },
                id.to_string(),
            );
        }
        let mut l = Ledger::new(ids);
        let params = MarketParams::testnet();
        l.list_market(MarketEntry {
            id: M,
            params,
            event_start_ms: Some(1_000_000),
            end_ms: 2_000_000,
            pool: Pool::default(),
            status: MarketStatus::Open,
        });
        World {
            l,
            n: 0,
            slips: BTreeMap::new(),
            reserve: i128::from(params.l),
            batch: 0,
        }
    }

    fn blank(&mut self, id: &str) -> Vec<BlindedMessage> {
        (0..31)
            .map(|_| {
                self.n += 1;
                BlindedMessage {
                    amount: 0,
                    id: id.into(),
                    b: point("B", self.n),
                }
            })
            .collect()
    }

    fn receive(&mut self, e: &Effects) {
        for j in &e.jobs {
            self.n += 1;
            self.slips.entry(j.id.clone()).or_default().push(Input {
                proof: Proof {
                    amount: j.amount,
                    id: j.id.clone(),
                    secret: format!("{:064x}", self.n),
                    c: point("C", self.n),
                },
                y: point("Y", self.n),
            });
        }
    }

    fn balance(&self, id: &str) -> u64 {
        self.slips
            .get(id)
            .map_or(0, |v| v.iter().map(|i| i.proof.amount).sum())
    }

    /// Take slips worth at least `amount` (largest first), or None.
    fn take(&mut self, id: &str, amount: u64) -> Option<Vec<Input>> {
        let v = self.slips.get_mut(id)?;
        v.sort_by_key(|i| std::cmp::Reverse(i.proof.amount));
        let mut got = 0;
        let mut n = 0;
        while got < amount && n < v.len() {
            got += v[n].proof.amount;
            n += 1;
        }
        (got >= amount && amount > 0).then(|| v.drain(..n).collect())
    }

    fn put_back(&mut self, inputs: Vec<Input>) {
        for i in inputs {
            self.slips.entry(i.proof.id.clone()).or_default().push(i);
        }
    }

    fn topup(&mut self, amount: u64) {
        let outs = self.blank(CREDIT);
        let e = self.l.credit(amount, &outs).unwrap();
        self.receive(&e);
        self.reserve += i128::from(amount);
    }

    fn trade(
        &mut self,
        side: Side,
        outcome: u8,
        amount: u64,
        limit_bp: u32,
        refs: &MarketInputs,
        now_ms: u64,
    ) -> Option<Result<blindbook_ledger::ledger::FillRecord, Reject>> {
        let pay = match side {
            Side::Buy => CREDIT,
            Side::Sell => POS[outcome as usize],
        };
        let inputs = self.take(pay, amount)?;
        let (get, change) = match side {
            Side::Buy => (POS[outcome as usize], CREDIT),
            Side::Sell => (CREDIT, POS[outcome as usize]),
        };
        let req = TradeRequest {
            market: M,
            side,
            outcome,
            limit_bp,
            amount,
            inputs: inputs.clone(),
            outputs: self.blank(get),
            change_outputs: self.blank(change),
            tag: H32(sha256(&self.n.to_be_bytes())),
        };
        self.batch += 1;
        let refs = BTreeMap::from([(M, refs.clone())]);
        let res = self.l.clear_trades(self.batch, now_ms, &[req], &refs);
        let o = res.outcomes.into_iter().next().unwrap();
        match &o.result {
            Ok(_) => self.receive(&o.effects),
            Err(_) => self.put_back(inputs),
        }
        Some(o.result)
    }

    fn check_solvency(&self) {
        let need = i128::from(self.l.required_reserve());
        assert!(
            self.reserve >= need,
            "reserve {} < required {need}",
            self.reserve
        );
    }
}

#[test]
fn full_cycle() {
    let mut w = World::new();
    w.topup(50_000);
    assert_eq!(w.balance(CREDIT), 50_000);
    assert_eq!(w.l.outstanding(Keyset::Credit), 50_000);

    // Buy A with 0.1 TAZ at mid 0.60.
    let r = reference(600_000, 5_000);
    // The wallet pays with its 32,768-unit slip; 22,768 come back as change in the same answer.
    let f = w
        .trade(Side::Buy, 0, 10_000, 9_000, &r, 10_000)
        .unwrap()
        .unwrap();
    assert_eq!(f.status, FillStatus::Filled);
    assert_eq!(f.fee, 100);
    assert_eq!(f.kept + f.fee + f.refund, 10_000);
    assert!(f.avg_price_bp > 6_000 && f.avg_price_bp < 7_000, "{f:?}");
    assert_eq!(w.balance(POS[0]), f.out);
    assert_eq!(w.balance(CREDIT), 40_000 + f.refund);
    w.check_solvency();

    // Sell a third of the shares back.
    let sell = w.balance(POS[0]) / 3;
    let f2 = w
        .trade(Side::Sell, 0, sell, 1, &r, 12_000)
        .unwrap()
        .unwrap();
    assert!(matches!(f2.status, FillStatus::Filled | FillStatus::Shrunk));
    w.check_solvency();

    // The event starts: everything is refunded.
    let before = w.balance(CREDIT);
    let f3 = w
        .trade(Side::Buy, 1, 5_000, 9_000, &r, 1_000_000)
        .unwrap()
        .unwrap();
    assert_eq!(f3.status, FillStatus::Halted);
    assert_eq!(f3.refund, 5_000);
    assert_eq!(w.balance(CREDIT), before);

    // A wins on Polygon: redeem every A share at 1 unit per share-unit.
    w.l.resolve(M, 1, [1, 0]).unwrap();
    let shares = w.balance(POS[0]);
    let inputs = w.take(POS[0], shares).unwrap();
    let outs = w.blank(CREDIT);
    let (paid, e) = w.l.redeem(&inputs, &outs).unwrap();
    assert_eq!(paid, shares);
    w.receive(&e);
    assert_eq!(
        w.l.outstanding(Keyset::Outcome {
            market: M,
            outcome: 0
        }),
        0
    );
    w.check_solvency();

    // Withdraw 0.1 TAZ.
    let inputs = w.take(CREDIT, 10_000 + WITHDRAWAL_FEE).unwrap();
    let sum: u64 = inputs.iter().map(|i| i.proof.amount).sum();
    let change = w.blank(CREDIT);
    let e =
        w.l.withdraw(&inputs, 10_000, &change, &WITHDRAW_AMOUNTS)
            .unwrap();
    w.receive(&e);
    w.reserve -= 10_000;
    assert_eq!(e.jobs.iter().map(|j| j.amount).sum::<u64>(), sum - 10_020);
    w.check_solvency();
    // The pool kept its fees in the house.
    assert!(w.l.markets[&M].pool.house > 0);
}

#[test]
fn double_spends_and_bad_requests_spend_nothing() {
    let mut w = World::new();
    w.topup(20_000);
    let r = reference(500_000, 5_000);
    let refs = BTreeMap::from([(M, r.clone())]);
    let inputs = w.take(CREDIT, 4_096).unwrap();
    let mk = |w: &mut World, inputs: Vec<Input>| TradeRequest {
        market: M,
        side: Side::Buy,
        outcome: 0,
        limit_bp: 9_000,
        amount: inputs.iter().map(|i| i.proof.amount).sum(),
        inputs,
        outputs: w.blank(POS[0]),
        change_outputs: w.blank(CREDIT),
        tag: H32([1; 32]),
    };
    let a = mk(&mut w, inputs.clone());
    let b = mk(&mut w, inputs.clone());
    let res = w.l.clear_trades(1, 10_000, &[a, b], &refs);
    assert!(res.outcomes[0].result.is_ok());
    assert_eq!(res.outcomes[1].result, Err(Reject::Spent));
    assert!(res.outcomes[1].effects.jobs.is_empty());
    // Spent for good.
    let c = mk(&mut w, inputs.clone());
    let res = w.l.clear_trades(2, 10_000, &[c], &refs);
    assert_eq!(res.outcomes[0].result, Err(Reject::Spent));

    let fresh = w.take(CREDIT, 1_000).unwrap();
    let spent_before = w.l.spent.len();
    let mut bad = mk(&mut w, fresh.clone());
    bad.limit_bp = 0;
    let mut wrong_keyset = mk(&mut w, fresh.clone());
    wrong_keyset.outputs = w.blank(POS[1]);
    let mut short = mk(&mut w, fresh.clone());
    short.change_outputs.pop();
    let mut unknown = mk(&mut w, fresh.clone());
    unknown.market = H32([9; 32]);
    let mut dup = mk(&mut w, fresh.clone());
    dup.inputs.push(dup.inputs[0].clone());
    let mut too_much = mk(&mut w, fresh.clone());
    too_much.amount += 1;
    let res = w.l.clear_trades(
        3,
        10_000,
        &[bad, wrong_keyset, short, unknown, dup, too_much],
        &refs,
    );
    let errs: Vec<_> = res.outcomes.iter().map(|o| o.result.clone()).collect();
    assert_eq!(
        errs,
        vec![
            Err(Reject::BadLimit),
            Err(Reject::BadBlankOutputs),
            Err(Reject::BadBlankOutputs),
            Err(Reject::UnknownMarket),
            Err(Reject::Duplicate),
            Err(Reject::BadAmount),
        ]
    );
    assert_eq!(w.l.spent.len(), spent_before);
    assert!(res.records.is_empty());
}

#[test]
fn swaps_balance_and_the_supply_guard_holds() {
    let mut w = World::new();
    w.topup(8);
    let inputs = w.take(CREDIT, 8).unwrap();
    let out = |amount, n| BlindedMessage {
        amount,
        id: CREDIT.into(),
        b: point("S", n),
    };
    assert_eq!(
        w.l.swap(&inputs, &[out(4, 1), out(2, 2)]),
        Err(Reject::Unbalanced)
    );
    let e =
        w.l.swap(&inputs, &[out(4, 1), out(2, 2), out(2, 3)])
            .unwrap();
    assert_eq!(e.spent.len(), 1);
    assert_eq!(w.l.swap(&inputs, &[out(8, 4)]), Err(Reject::Spent));
    w.receive(&e);
    // A forged slip of a keyset that never issued anything.
    let forged = Input {
        proof: Proof {
            amount: 1 << 20,
            id: POS[1].into(),
            secret: "ff".into(),
            c: point("C", 999),
        },
        y: point("Y", 999),
    };
    let b = BlindedMessage {
        amount: 1 << 20,
        id: POS[1].into(),
        b: point("S", 9),
    };
    assert_eq!(w.l.swap(&[forged], &[b]), Err(Reject::SupplyGuard));
}

#[test]
fn half_and_losing_redemptions() {
    let mut w = World::new();
    w.topup(30_000);
    let r = reference(500_000, 5_000);
    w.trade(Side::Buy, 0, 10_000, 9_000, &r, 10_000)
        .unwrap()
        .unwrap();
    w.trade(Side::Buy, 1, 10_000, 9_000, &r, 10_000)
        .unwrap()
        .unwrap();
    // Canceled match: 50-50.
    w.l.resolve(M, 2, [1, 1]).unwrap();
    for pos in POS {
        let shares = w.balance(pos);
        let inputs = w.take(pos, shares).unwrap();
        let outs = w.blank(CREDIT);
        let (paid, e) = w.l.redeem(&inputs, &outs).unwrap();
        assert_eq!(paid, shares / 2);
        w.receive(&e);
        w.check_solvency();
    }
    let mut w = World::new();
    w.topup(10_000);
    w.trade(Side::Buy, 1, 10_000, 9_000, &r, 10_000)
        .unwrap()
        .unwrap();
    w.l.resolve(M, 1, [1, 0]).unwrap();
    let inputs = w.take(POS[1], w.balance(POS[1])).unwrap();
    let outs = w.blank(CREDIT);
    assert_eq!(w.l.redeem(&inputs, &outs), Err(Reject::NothingToRedeem));
    w.topup(1_000);
    assert_eq!(
        w.trade(Side::Buy, 0, 1_000, 9_000, &r, 10_000),
        Some(Err(Reject::MarketResolved))
    );
}

#[derive(Clone, Debug)]
enum Op {
    Topup(u64),
    Trade {
        sell: bool,
        outcome: u8,
        amount: u64,
        limit_bp: u32,
        mid: u32,
    },
    Withdraw(usize),
}

#[test]
fn blind_duels_complete_a_set_and_cancel() {
    use blindbook_ledger::ledger::{OutputList, duel_stake};
    let mut w = World::new();
    w.topup(50_000);
    let issued_credit_before = w.l.issued[CREDIT];
    // The challenger bets A at 40¢ for 10,000 share-units: stake 4,000 in escrow.
    let duel = H32([1; 32]);
    let secret = [9u8; 32];
    let cancel = H32(sha256(&secret));
    let inputs = w.take(CREDIT, 4_000).unwrap();
    let paid: u64 = inputs.iter().map(|i| i.proof.amount).sum();
    let change = w.blank(CREDIT);
    let challenger_outs = w.blank(POS[0]);
    let e =
        w.l.duel_open(
            duel,
            M,
            0,
            10_000,
            4_000,
            500,
            &inputs,
            &change,
            &challenger_outs,
            cancel,
        )
        .unwrap();
    assert_eq!(duel_stake(10_000, 4_000), 4_000);
    assert_eq!(e.jobs.iter().map(|j| j.amount).sum::<u64>(), paid - 4_000);
    w.receive(&e);
    assert_eq!(w.l.duel_escrow(), 4_000);
    w.check_solvency();
    // Same id again, wrong terms, and after the event start: refused, nothing spent.
    let again = w.take(CREDIT, 1).unwrap();
    let c2 = w.blank(CREDIT);
    let o2 = w.blank(POS[0]);
    assert_eq!(
        w.l.duel_open(duel, M, 0, 10_000, 4_000, 500, &again, &c2, &o2, cancel),
        Err(Reject::DuelExists)
    );
    w.put_back(again);
    let tin = w.take(CREDIT, 6_000).unwrap();
    let tout = w.blank(POS[1]);
    let tchg = w.blank(CREDIT);
    assert_eq!(
        w.l.duel_take(duel, (0, 10_000, 4_100), 600, &tin, &tout, &tchg),
        Err(Reject::DuelTerms)
    );
    assert_eq!(
        w.l.duel_take(duel, (0, 10_000, 4_000), 1_000_000, &tin, &tout, &tchg),
        Err(Reject::TradingClosed)
    );
    // Taken: the taker pays 6,000 and gets 10,000 B now; the challenger's 10,000 A are signed
    // on the outputs left at opening.
    let taker_paid: u64 = tin.iter().map(|i| i.proof.amount).sum();
    let e =
        w.l.duel_take(duel, (0, 10_000, 4_000), 600, &tin, &tout, &tchg)
            .unwrap();
    let sum = |list: OutputList| -> u64 {
        e.jobs
            .iter()
            .filter(|j| j.list == list)
            .map(|j| j.amount)
            .sum()
    };
    assert_eq!(sum(OutputList::Outputs), 10_000);
    assert_eq!(sum(OutputList::Duel), 10_000);
    assert_eq!(sum(OutputList::Change), taker_paid - 6_000);
    assert!(
        e.jobs
            .iter()
            .filter(|j| j.list == OutputList::Duel)
            .all(|j| j.id == POS[0])
    );
    w.receive(&e);
    assert_eq!(w.l.duel_escrow(), 0);
    assert!(w.l.duels.is_empty());
    // A complete set: 10,000 CREDIT out, 10,000 of each outcome in; the house holds no risk.
    assert_eq!(
        w.l.outstanding(Keyset::Outcome {
            market: M,
            outcome: 0
        }),
        10_000
    );
    assert_eq!(
        w.l.outstanding(Keyset::Outcome {
            market: M,
            outcome: 1
        }),
        10_000
    );
    assert_eq!(
        w.l.issued[CREDIT] - issued_credit_before,
        (paid - 4_000) + (taker_paid - 6_000)
    );
    w.check_solvency();
    assert_eq!(
        w.l.duel_take(duel, (0, 10_000, 4_000), 600, &[], &tout, &tchg),
        Err(Reject::DuelUnknown)
    );

    // A second duel, cancelled: wrong secret refused, the right one refunds the stake.
    let duel2 = H32([2; 32]);
    let inputs = w.take(CREDIT, 3_000).unwrap();
    let c = w.blank(CREDIT);
    let o = w.blank(POS[1]);
    let e =
        w.l.duel_open(duel2, M, 1, 5_000, 6_000, 700, &inputs, &c, &o, cancel)
            .unwrap();
    w.receive(&e);
    assert_eq!(w.l.duel_escrow(), 3_000);
    let refund = w.blank(CREDIT);
    assert_eq!(
        w.l.duel_cancel(duel2, &encode(&[8u8; 32]), &refund),
        Err(Reject::BadCancel)
    );
    let e = w.l.duel_cancel(duel2, &encode(&secret), &refund).unwrap();
    assert_eq!(e.jobs.iter().map(|j| j.amount).sum::<u64>(), 3_000);
    w.receive(&e);
    assert_eq!(w.l.duel_escrow(), 0);
    w.check_solvency();
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (1u64..40_000).prop_map(Op::Topup),
        (
            any::<bool>(),
            0u8..2,
            1u64..25_000,
            1u32..10_000,
            150_000u32..850_000
        )
            .prop_map(|(sell, outcome, amount, limit_bp, mid)| Op::Trade {
                sell,
                outcome,
                amount,
                limit_bp,
                mid
            }),
        (0usize..3).prop_map(Op::Withdraw),
    ]
}

// 256 cases by default; PROPTEST_CASES=N for more.
proptest! {

    /// Whatever users do and wherever Polymarket moves, the reserve covers every claim, and every
    /// unit is accounted for, before and after resolution.
    #[test]
    fn reserve_always_covers_claims(ops in prop::collection::vec(op(), 1..60), winner in 0u8..3) {
        let mut w = World::new();
        for op in ops {
            match op {
                Op::Topup(a) => w.topup(a),
                Op::Trade { sell, outcome, amount, limit_bp, mid } => {
                    let side = if sell { Side::Sell } else { Side::Buy };
                    let r = reference(mid, 5_000);
                    let _ = w.trade(side, outcome, amount, limit_bp, &r, 10_000);
                }
                Op::Withdraw(i) => {
                    let amount = WITHDRAW_AMOUNTS[i];
                    if let Some(inputs) = w.take(CREDIT, amount + WITHDRAWAL_FEE) {
                        let change = w.blank(CREDIT);
                        let e = w.l.withdraw(&inputs, amount, &change, &WITHDRAW_AMOUNTS).unwrap();
                        w.receive(&e);
                        w.reserve -= i128::from(amount);
                    }
                }
            }
            w.check_solvency();
            // The wallet holds exactly what the ledger says is outstanding.
            prop_assert_eq!(w.balance(CREDIT), w.l.outstanding(Keyset::Credit));
            for o in 0..2u8 {
                prop_assert_eq!(
                    w.balance(POS[o as usize]),
                    w.l.outstanding(Keyset::Outcome { market: M, outcome: o })
                );
                prop_assert_eq!(w.balance(POS[o as usize]), w.l.markets[&M].pool.u[o as usize]);
            }
        }
        let (den, num) = match winner { 0 => (1, [1, 0]), 1 => (1, [0, 1]), _ => (2, [1, 1]) };
        w.l.resolve(M, den, num).unwrap();
        w.check_solvency();
        for pos in POS {
            let shares = w.balance(pos);
            if let Some(inputs) = w.take(pos, shares) {
                let outs = w.blank(CREDIT);
                if let Ok((_, e)) = w.l.redeem(&inputs, &outs) {
                    w.receive(&e);
                }
                w.check_solvency();
            }
        }
    }
}
