//! The worked examples of PROTOCOL 5.5 and 5.7, checked against the engine.
//! If one of these fails, either the engine or the spec is wrong; fix whichever it is.

use blindbook_engine::trace::Trace;
use blindbook_engine::{
    Market, Order, Params, Reference, Schedule, Side, clear_batch, price_a_ppm,
};

const U: f64 = 100_000.0; // units per ZEC

fn close(got: f64, want: f64, tol: f64, what: &str) {
    assert!(
        (got - want).abs() <= tol,
        "{what}: got {got:.6}, spec {want:.6} (tolerance {tol})"
    );
}

fn buy(id: u64, outcome: u8, zec: f64) -> Order {
    Order {
        id,
        side: Side::Buy,
        outcome,
        amount: (zec * U) as u64,
        limit_bp: 10_000,
    }
}

/// The parameters of PROTOCOL 5.7's worked examples: b = 0.2, L = 0.05, fee 1% (the live testnet
/// is deeper; the arithmetic is the same).
fn example() -> Params {
    Params {
        b: 20_000,
        l: 5_000,
        max_trade: 20_000,
        ..Params::testnet()
    }
}

#[test]
fn untouched_market_quotes_polymarket() {
    let p = example();
    close(
        price_a_ppm(&Market::default(), &p, 600_000) as f64 / 1e6,
        0.6000,
        1e-6,
        "price A at mid 0.60",
    );
}

#[test]
fn buy_a_005_at_mid_060() {
    // b = 0.2, fee 1%, ask 0.61 (guard not binding).
    let p = example();
    let r = Reference::with_spread(600_000, 10_000);
    let mut m = Market::default();
    let rep = clear_batch(
        &mut m,
        &p,
        &r,
        &Schedule::open(),
        &[buy(1, 0, 0.05)],
        &mut Trace::off(),
    );
    let f = rep.fills[0];
    close(f.out as f64 / U, 0.07678, 1e-5, "shares (whole units)");
    close(f.kept as f64 / f.out as f64, 0.6447, 1e-4, "average price");
    close(
        price_a_ppm(&m, &p, 600_000) as f64 / 1e6,
        0.6877,
        1e-4,
        "price after",
    );
    close(
        price_a_ppm(&m, &p, 650_000) as f64 / 1e6,
        0.7316,
        1e-4,
        "then Polymarket 0.65",
    );
    close(
        price_a_ppm(&m, &p, 550_000) as f64 / 1e6,
        0.6421,
        1e-4,
        "or Polymarket 0.55",
    );
    close(m.exposure() as f64 / U, 0.0273, 1e-4, "house exposure W");
    assert!(m.exposure() <= p.l as i128);
}

#[test]
fn a_and_b_in_one_batch_zero_spread() {
    let p = example();
    let r = Reference::with_spread(600_000, 0);
    let mut m = Market::default();
    let rep = clear_batch(
        &mut m,
        &p,
        &r,
        &Schedule::open(),
        &[buy(1, 0, 0.05), buy(2, 1, 0.01)],
        &mut Trace::off(),
    );
    close(rep.k_buy / U, 0.024750, 1e-6, "complete sets");
    let (fa, fb) = (rep.fills[0], rep.fills[1]);
    close(
        fa.kept as f64 / fa.out as f64,
        0.6222,
        2e-4,
        "A side average",
    );
    close(
        fb.kept as f64 / fb.out as f64,
        0.4000,
        2e-4,
        "B side average",
    );
    close(
        price_a_ppm(&m, &p, 600_000) as f64 / 1e6,
        0.6636,
        1e-4,
        "price after",
    );
    close(
        (fa.kept + fa.fee + fb.kept + fb.fee) as f64 / U,
        0.0600,
        1e-6,
        "paid in",
    );
}

#[test]
fn a_and_b_in_one_batch_with_a_real_book_binds_bs_guard() {
    // The same batch with Polymarket at 0.59 / 0.61: B's ask is 0.41, so B pays 0.41.
    let p = example();
    let r = Reference::with_spread(600_000, 10_000);
    let mut m = Market::default();
    let rep = clear_batch(
        &mut m,
        &p,
        &r,
        &Schedule::open(),
        &[buy(1, 0, 0.05), buy(2, 1, 0.01)],
        &mut Trace::off(),
    );
    let fb = rep.fills[1];
    close(
        fb.kept as f64 / fb.out as f64,
        0.4100,
        3e-4,
        "B side average",
    );
    assert!(rep.buy[1].guard_binding, "B's guard should bind");
    close(
        price_a_ppm(&m, &p, 600_000) as f64 / 1e6,
        0.6643,
        1e-4,
        "price after",
    );
}

#[test]
fn sells_respect_the_exposure_invariant() {
    // PROTOCOL 5.5: L = 0.02, u_A = u_B = c = 0.10, Polymarket jumps to 0.85, someone sells 0.10 A.
    let p = Params {
        l: 2_000,
        ..example()
    };
    let r = Reference::with_spread(850_000, 0);
    let mut m = Market {
        u: [10_000, 10_000],
        c: 10_000,
        house: 0,
    };
    let sell = Order {
        id: 1,
        side: Side::Sell,
        outcome: 0,
        amount: 10_000,
        limit_bp: 0,
    };
    let rep = clear_batch(
        &mut m,
        &p,
        &r,
        &Schedule::open(),
        &[sell],
        &mut Trace::off(),
    );
    let f = rep.fills[0];
    close(f.kept as f64 / U, 0.02375, 2e-5, "shares sold");
    assert_eq!(f.kept + f.refund, 10_000, "unsold shares come back");
    assert!(
        m.exposure() <= p.l as i128,
        "W {} > L {}",
        m.exposure(),
        p.l
    );
    close(m.exposure() as f64 / U, 0.0200, 1e-5, "W ends at L");
}
