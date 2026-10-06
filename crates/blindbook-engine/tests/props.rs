//! Property tests for the batch-clearing engine (PROTOCOL section 5).
//!
//! Every test drives `clear_batch` with random batches of buys and sells while the Polymarket
//! anchor jumps between 0.05 and 0.95, and checks the invariants the public solvency check and
//! the verifier rely on.

use blindbook_engine::clear::{
    BatchReport, Market, Order, Params, Reference, Schedule, Side, Status, clear_batch, price_a_ppm,
};
use blindbook_engine::trace::Trace;
use proptest::prelude::*;

/// One generated order; sells are scaled to the users' holdings when the batch is built.
#[derive(Clone, Debug)]
struct Gen {
    sell: bool,
    outcome: u8,
    amount_frac: u32, // per mille of max_trade (buys) or of holdings (sells)
    limit_bp: u32,
}

fn gen_order() -> impl Strategy<Value = Gen> {
    (
        any::<bool>(),
        0u8..2,
        1u32..=1000,
        prop_oneof![Just(10_000u32), 1u32..=10_000],
    )
        .prop_map(|(sell, outcome, amount_frac, limit_bp)| Gen {
            sell,
            outcome,
            amount_frac,
            limit_bp,
        })
}

fn gen_batch() -> impl Strategy<Value = (u32, u32, Vec<Gen>)> {
    // mid 0.05..0.95, half spread 0..2 cents, up to 12 orders
    (
        50_000u32..=950_000,
        0u32..=20_000,
        prop::collection::vec(gen_order(), 0..12),
    )
}

/// Builds concrete orders from generated ones; sells never offer more shares than users hold.
fn build(m: &Market, p: &Params, gens: &[Gen], next_id: &mut u64) -> Vec<Order> {
    let mut remaining = m.u;
    let mut out = Vec::new();
    for g in gens {
        *next_id += 1;
        let (side, amount) = if g.sell {
            let held = remaining[g.outcome as usize];
            let a = held * g.amount_frac as u64 / 1000;
            if a == 0 {
                continue;
            }
            remaining[g.outcome as usize] -= a;
            (Side::Sell, a)
        } else {
            (
                Side::Buy,
                (p.max_trade * g.amount_frac as u64 / 1000).max(1),
            )
        };
        // Sell limits are minimum prices: map the random limit into a realistic range.
        let limit_bp = if g.sell { g.limit_bp / 4 } else { g.limit_bp };
        out.push(Order {
            id: *next_id,
            side,
            outcome: g.outcome,
            amount,
            limit_bp,
        });
    }
    out
}

/// Checks the per-order accounting identities and returns (credit_in, credit_out) for the batch.
fn check_fills(orders: &[Order], rep: &BatchReport) -> Result<(i128, i128), TestCaseError> {
    prop_assert_eq!(orders.len(), rep.fills.len());
    let mut credit_in = 0i128;
    let mut credit_out = 0i128;
    for (o, f) in orders.iter().zip(&rep.fills) {
        prop_assert_eq!(o.id, f.id);
        match o.side {
            Side::Buy => {
                // Buy: amount = net kept + fee + refund; shares issued only if something was kept.
                prop_assert_eq!(o.amount, f.kept + f.fee + f.refund, "buy {:?} {:?}", o, f);
                if f.kept == 0 {
                    prop_assert_eq!(f.out, 0);
                }
                credit_in += (f.kept + f.fee) as i128;
            }
            Side::Sell => {
                // Sell: shares offered = sold + returned; paid out never exceeds the sold shares (price <= 1).
                prop_assert_eq!(o.amount, f.kept + f.refund, "sell {:?} {:?}", o, f);
                prop_assert!(
                    f.out + f.fee <= f.kept,
                    "sell paid more than 1 per share {:?} {:?}",
                    o,
                    f
                );
                credit_out += f.out as i128;
            }
        }
        if matches!(
            f.status,
            Status::Halted | Status::DroppedLimit | Status::Rejected
        ) {
            prop_assert_eq!(f.kept, 0);
            prop_assert_eq!(f.out, 0);
        }
    }
    Ok((credit_in, credit_out))
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, .. ProptestConfig::default() })]

    /// W <= L after every batch, value is conserved, and nobody receives more than the market holds.
    #[test]
    fn invariant_and_conservation(batches in prop::collection::vec(gen_batch(), 1..25), mainnet in any::<bool>()) {
        let p = if mainnet { Params::mainnet() } else { Params::testnet() };
        let s = Schedule::open();
        let mut m = Market::default();
        let mut id = 0u64;
        for (mid, half, gens) in batches {
            let r = Reference::with_spread(mid, half);
            let orders = build(&m, &p, &gens, &mut id);
            let before = m;
            let rep = clear_batch(&mut m, &p, &r, &s, &orders, &mut Trace::off());
            let (cin, cout) = check_fills(&orders, &rep)?;
            // Cash identity: market cash + house ledger grow by exactly what users paid in net of what they got back.
            let d_cash = (m.c as i128 + m.house as i128) - (before.c as i128 + before.house as i128);
            prop_assert_eq!(d_cash, cin - cout, "cash identity broken: before {:?} after {:?}", before, m);
            // Share identity: issued minus sold.
            let issued: [u64; 2] = [0, 1].map(|o| orders.iter().zip(&rep.fills).filter(|(x, _)| x.side == Side::Buy && x.outcome == o).map(|(_, f)| f.out).sum());
            let sold: [u64; 2] = [0, 1].map(|o| orders.iter().zip(&rep.fills).filter(|(x, _)| x.side == Side::Sell && x.outcome == o).map(|(_, f)| f.kept).sum());
            for o in 0..2 {
                prop_assert_eq!(m.u[o] as i128, before.u[o] as i128 + issued[o] as i128 - sold[o] as i128);
            }
            // The exposure invariant (PROTOCOL 5.3).
            prop_assert!(m.exposure() <= p.l as i128, "W = {} > L = {} after batch, market {:?}, mid {}, report {:?}", m.exposure(), p.l, m, mid, rep.halt);
            prop_assert!(m.house >= before.house, "house ledger decreased");
        }
    }

    /// Clearing doesn't depend on the order of requests inside a batch (PROTOCOL 5: "ordering inside the window doesn't matter").
    #[test]
    fn order_independence(pre in prop::collection::vec(gen_batch(), 0..6), (mid, half, gens) in gen_batch(), seed in any::<u64>()) {
        let p = Params::testnet();
        let s = Schedule::open();
        let mut m = Market::default();
        let mut id = 0u64;
        for (mid0, half0, g0) in pre {
            let o0 = build(&m, &p, &g0, &mut id);
            clear_batch(&mut m, &p, &Reference::with_spread(mid0, half0), &s, &o0, &mut Trace::off());
        }
        let r = Reference::with_spread(mid, half);
        let orders = build(&m, &p, &gens, &mut id);
        let mut shuffled = orders.clone();
        // Deterministic Fisher-Yates from the seed.
        let mut x = seed | 1;
        for i in (1..shuffled.len()).rev() {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            shuffled.swap(i, (x % (i as u64 + 1)) as usize);
        }
        let (mut m1, mut m2) = (m, m);
        let r1 = clear_batch(&mut m1, &p, &r, &s, &orders, &mut Trace::off());
        let r2 = clear_batch(&mut m2, &p, &r, &s, &shuffled, &mut Trace::off());
        prop_assert_eq!(m1, m2, "market state depends on request order");
        for f in &r1.fills {
            let g = r2.fills.iter().find(|g| g.id == f.id).unwrap();
            prop_assert_eq!(f, g, "fill depends on request order");
        }
    }

    /// Buying an outcome never lowers its price; selling never raises it (same anchor).
    #[test]
    fn monotone_prices(mid in 100_000u32..=900_000, amount in 1u64..=20_000, outcome in 0u8..2) {
        let p = Params::testnet();
        let s = Schedule::open();
        let r = Reference::with_spread(mid, 0);
        let mut m = Market::default();
        let p0 = price_a_ppm(&m, &p, mid);
        let buy = [Order { id: 1, side: Side::Buy, outcome, amount, limit_bp: 10_000 }];
        clear_batch(&mut m, &p, &r, &s, &buy, &mut Trace::off());
        let p1 = price_a_ppm(&m, &p, mid);
        if outcome == 0 { prop_assert!(p1 >= p0, "buying A lowered A: {} -> {}", p0, p1); }
        else { prop_assert!(p1 <= p0, "buying B raised A: {} -> {}", p0, p1); }
        let held = m.u[outcome as usize];
        if held > 0 {
            let sell = [Order { id: 2, side: Side::Sell, outcome, amount: held, limit_bp: 0 }];
            clear_batch(&mut m, &p, &r, &s, &sell, &mut Trace::off());
            let p2 = price_a_ppm(&m, &p, mid);
            if outcome == 0 { prop_assert!(p2 <= p1, "selling A raised A: {} -> {}", p1, p2); }
            else { prop_assert!(p2 >= p1, "selling B lowered A: {} -> {}", p1, p2); }
        }
    }
}

/// Guards against vacuous passes: the generated batches must actually fill, shrink and sell.
#[test]
fn generator_exercises_the_engine() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;
    let p = Params::testnet();
    let s = Schedule::open();
    let mut runner = TestRunner::deterministic();
    let (mut filled, mut shrunk, mut sold, mut dropped, mut halted, mut orders_n) =
        (0, 0, 0, 0, 0, 0);
    let mut max_w = i128::MIN;
    for _ in 0..200 {
        let batches = prop::collection::vec(gen_batch(), 1..25)
            .new_tree(&mut runner)
            .unwrap()
            .current();
        let mut m = Market::default();
        let mut id = 0;
        for (mid, half, gens) in batches {
            let orders = build(&m, &p, &gens, &mut id);
            let rep = clear_batch(
                &mut m,
                &p,
                &Reference::with_spread(mid, half),
                &s,
                &orders,
                &mut Trace::off(),
            );
            orders_n += orders.len();
            for (o, f) in orders.iter().zip(&rep.fills) {
                match f.status {
                    Status::Filled => filled += 1,
                    Status::Shrunk => shrunk += 1,
                    Status::DroppedLimit => dropped += 1,
                    Status::Halted => halted += 1,
                    Status::Rejected => {}
                }
                if o.side == Side::Sell && f.kept > 0 {
                    sold += 1;
                }
            }
            max_w = max_w.max(m.exposure());
        }
    }
    println!(
        "orders {orders_n}: filled {filled}, shrunk {shrunk}, sells with fills {sold}, dropped by limit {dropped}, halted {halted}, max W {max_w} (L = {})",
        p.l
    );
    assert!(
        filled > 100 && shrunk > 10 && sold > 50,
        "generator too weak"
    );
}
