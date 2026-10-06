//! Deterministic vectors shared by the native tools and the wasm build.
//! Everything here is pure (no clock, no OS randomness), so the trace bytes must match exactly.

use crate::clear::*;
use crate::math::*;
use crate::trace::Trace;
use alloc::vec::Vec;

/// SplitMix64: tiny, portable, integer-only PRNG.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next_u64() % n }
    }
    /// inclusive range
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }
    /// f64 in [0, 1) from 53 random bits (exact integer -> f64 conversion).
    pub fn unit_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// A market plus the users' individual positions, so random sells are always backed by slips.
#[derive(Clone)]
pub struct Sim {
    pub m: Market,
    pub p: Params,
    pub positions: Vec<(u8, u64)>,
    pub next_id: u64,
}

impl Sim {
    pub fn new(p: Params) -> Self {
        Sim {
            m: Market::default(),
            p,
            positions: Vec::new(),
            next_id: 1,
        }
    }

    /// Random orders: ~1/3 sells of existing positions, buys log-uniform up to max_trade,
    /// half of the orders with a random limit.
    pub fn random_orders(&mut self, rng: &mut Rng, n: usize) -> Vec<Order> {
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            let id = self.next_id;
            self.next_id += 1;
            if !self.positions.is_empty() && rng.below(3) == 0 {
                let i = rng.below(self.positions.len() as u64) as usize;
                let (outcome, shares) = self.positions[i];
                let amount = if rng.below(2) == 0 {
                    shares
                } else {
                    rng.range(1, shares)
                };
                if amount == shares {
                    self.positions.swap_remove(i);
                } else {
                    self.positions[i].1 -= amount;
                }
                let limit_bp = if rng.below(2) == 0 {
                    0
                } else {
                    rng.range(0, 9_500) as u32
                };
                out.push(Order {
                    id,
                    side: Side::Sell,
                    outcome,
                    amount,
                    limit_bp,
                });
            } else {
                // log-uniform amount in [1, max_trade]
                let bits = 64 - self.p.max_trade.leading_zeros() as u64;
                let e = rng.range(0, bits.saturating_sub(1));
                let amount = rng
                    .range(1u64 << e, ((1u64 << (e + 1)) - 1).min(self.p.max_trade))
                    .max(1);
                let limit_bp = if rng.below(2) == 0 {
                    10_000
                } else {
                    rng.range(500, 10_000) as u32
                };
                out.push(Order {
                    id,
                    side: Side::Buy,
                    outcome: rng.below(2) as u8,
                    amount,
                    limit_bp,
                });
            }
        }
        out
    }

    /// Book-keeping of positions after a batch (issued shares in, unsold shares back).
    pub fn apply(&mut self, orders: &[Order], rep: &BatchReport) {
        for (o, f) in orders.iter().zip(rep.fills.iter()) {
            match o.side {
                Side::Buy => {
                    if f.out > 0 {
                        self.positions.push((o.outcome, f.out));
                    }
                }
                Side::Sell => {
                    if f.refund > 0 {
                        self.positions.push((o.outcome, f.refund));
                    }
                }
            }
        }
    }
}

/// Random reference: mid jumps anywhere in [0.05, 0.95], half-spread up to 2%, occasional halts.
pub fn random_reference(rng: &mut Rng) -> (Reference, Schedule) {
    let mid = rng.range(50_000, 950_000) as u32;
    let hs = rng.range(0, 20_000) as u32;
    let mut r = Reference::with_spread(mid, hs);
    // depth-aware quotes are a bit worse than top of book
    r.ask_ppm[0] = (r.ask_ppm[0] + rng.range(0, 3_000) as u32).min(PPM);
    r.ask_ppm[1] = (r.ask_ppm[1] + rng.range(0, 3_000) as u32).min(PPM);
    r.bid_ppm[0] = r.bid_ppm[0]
        .saturating_sub(rng.range(0, 3_000) as u32)
        .max(1);
    r.bid_ppm[1] = r.bid_ppm[1]
        .saturating_sub(rng.range(0, 3_000) as u32)
        .max(1);
    let mut s = Schedule::open();
    match rng.below(40) {
        0 => r.age_ms = 10_001,
        1 => r.accepting_orders = false,
        2 => s.event_start_ms = Some(0),
        _ => {}
    }
    (r, s)
}

fn push_report(tr: &mut Trace, m: &Market, rep: &BatchReport) {
    tr.u(rep.halt.map(|h| h as u64 + 1).unwrap_or(0));
    for f in &rep.fills {
        tr.u(f.id);
        tr.u(f.status as u64);
        tr.u(f.kept);
        tr.u(f.out);
        tr.u(f.fee);
        tr.u(f.refund);
    }
    tr.f(rep.k_buy);
    tr.u(rep.k_sell);
    tr.u(m.u[0]);
    tr.u(m.u[1]);
    tr.i(m.c);
    tr.i(m.house);
}

/// libm sweep: the raw functions over wide argument ranges.
pub fn libm_sweep(tr: &mut Trace, n: usize) {
    tr.tag(10);
    let mut rng = Rng::new(0x5EED_0001);
    for _ in 0..n {
        let x = (rng.unit_f64() - 0.5) * 80.0; // [-40, 40)
        let y = rng.unit_f64() * 1.0e6 + 1.0e-9;
        let z = (rng.unit_f64() - 0.5) * 2.0; // [-1, 1)
        tr.f(libm::exp(x));
        tr.f(libm::log(y));
        tr.f(libm::log1p(z * 0.999));
        tr.f(libm::expm1(z));
        tr.f(sigma(x));
        let b = 1_000.0 + rng.unit_f64() * 50_000.0;
        let cash = rng.unit_f64() * 30_000.0;
        tr.f(buy_shares(x * 0.25, cash, b));
        tr.f(sell_proceeds(x * 0.25, cash, b));
        tr.f(logit_ppm(rng.range(1, 999_999) as u32));
    }
}

/// Spec examples from PROTOCOL 5.5 / 5.7 through the integer engine.
pub fn spec_vectors(tr: &mut Trace) {
    tr.tag(20);
    let p = Params::testnet();
    let s = Schedule::open();
    // single buy A 0.05 at mid 0.60, ask 0.61
    let mut m = Market::default();
    let r = Reference::with_spread(600_000, 10_000);
    let o = [Order {
        id: 1,
        side: Side::Buy,
        outcome: 0,
        amount: 5_000,
        limit_bp: 10_000,
    }];
    let rep = clear_batch(&mut m, &p, &r, &s, &o, tr);
    push_report(tr, &m, &rep);
    tr.u(price_a_ppm(&m, &p, 600_000));
    tr.u(price_a_ppm(&m, &p, 650_000));
    tr.u(price_a_ppm(&m, &p, 550_000));
    // A 0.05 + B 0.01, zero spread and 0.59/0.61
    for hs in [0u32, 10_000] {
        let mut m = Market::default();
        let r = Reference::with_spread(600_000, hs);
        let o = [
            Order {
                id: 1,
                side: Side::Buy,
                outcome: 0,
                amount: 5_000,
                limit_bp: 10_000,
            },
            Order {
                id: 2,
                side: Side::Buy,
                outcome: 1,
                amount: 1_000,
                limit_bp: 10_000,
            },
        ];
        let rep = clear_batch(&mut m, &p, &r, &s, &o, tr);
        push_report(tr, &m, &rep);
    }
    // price impact table, no fee, guard at 0.50 (not binding)
    for b in [5_000u64, 10_000, 20_000, 50_000] {
        for x in [500u64, 1_000, 5_000] {
            let pp = Params {
                b,
                fee_bp: 0,
                l: 1_000_000,
                max_trade: 1_000_000,
                ..p
            };
            let mut m = Market::default();
            let r = Reference::with_spread(500_000, 0);
            let o = [Order {
                id: 1,
                side: Side::Buy,
                outcome: 0,
                amount: x,
                limit_bp: 10_000,
            }];
            let rep = clear_batch(&mut m, &pp, &r, &s, &o, tr);
            push_report(tr, &m, &rep);
        }
    }
    // 5.5 sell example, L = 0.02
    for bid in [850_000u32, 840_000] {
        for l in [2_000u64, 1_000_000] {
            let pp = Params {
                l,
                max_trade: 1_000_000,
                ..p
            };
            let mut m = Market {
                u: [10_000, 10_000],
                c: 10_000,
                house: 0,
            };
            let mut r = Reference::with_spread(850_000, 0);
            r.bid_ppm[0] = bid;
            let o = [Order {
                id: 1,
                side: Side::Sell,
                outcome: 0,
                amount: 10_000,
                limit_bp: 0,
            }];
            let rep = clear_batch(&mut m, &pp, &r, &s, &o, tr);
            push_report(tr, &m, &rep);
        }
    }
}

/// Random batch sequences with anchor jumps, both drop rules, testnet and mainnet sizes.
pub fn random_sequences(
    tr: &mut Trace,
    markets: usize,
    batches: usize,
    max_orders: usize,
    seed: u64,
) {
    tr.tag(30);
    let mut rng = Rng::new(seed);
    for mi in 0..markets {
        let mut p = if mi % 2 == 0 {
            Params::testnet()
        } else {
            Params::mainnet()
        };
        if mi % 3 == 0 {
            p.drop_rule = DropRule::AllViolators;
        }
        if mi % 5 == 0 {
            p.fee_bp = [0u32, 30, 100, 250][(mi / 5) % 4];
        }
        let mut sim = Sim::new(p);
        for _ in 0..batches {
            let (r, s) = random_reference(&mut rng);
            let n = rng.range(0, max_orders as u64) as usize;
            let orders = sim.random_orders(&mut rng, n);
            let rep = clear_batch(&mut sim.m, &sim.p, &r, &s, &orders, tr);
            push_report(tr, &sim.m, &rep);
            sim.apply(&orders, &rep);
        }
    }
}

/// The full determinism vector set. Returns the trace as little-endian bytes.
pub fn all_vectors() -> Vec<u8> {
    let mut tr = Trace::on();
    libm_sweep(&mut tr, 20_000);
    spec_vectors(&mut tr);
    random_sequences(&mut tr, 96, 40, 40, 0xB10C_B00C);
    tr.to_le_bytes()
}

/// Benchmark workload: `n_markets` markets with some history, `n_orders` orders spread over them.
pub struct Workload {
    pub sims: Vec<Sim>,
    pub refs: Vec<Reference>,
    pub orders: Vec<Vec<Order>>,
}

pub fn bench_workload(n_orders: usize, n_markets: usize, seed: u64) -> Workload {
    let mut rng = Rng::new(seed);
    let mut sims = Vec::new();
    let mut refs = Vec::new();
    let mut orders = Vec::new();
    for mi in 0..n_markets {
        let mut p = Params::testnet();
        p.l = 50_000; // larger buffer so the history doesn't saturate W
        p.drop_rule = if mi % 2 == 0 {
            DropRule::LowestTier
        } else {
            DropRule::AllViolators
        };
        let mut sim = Sim::new(p);
        let mut off = Trace::off();
        for _ in 0..10 {
            let mid = rng.range(150_000, 850_000) as u32;
            let r = Reference::with_spread(mid, 5_000);
            let o = sim.random_orders(&mut rng, 20);
            let rep = clear_batch(&mut sim.m, &sim.p, &r, &Schedule::open(), &o, &mut off);
            sim.apply(&o, &rep);
        }
        sim.p.l = 5_000.max(sim.m.exposure().max(0) as u64 + 2_000);
        let mid = rng.range(150_000, 850_000) as u32;
        refs.push(Reference::with_spread(mid, 5_000));
        sims.push(sim);
        orders.push(Vec::new());
    }
    for _ in 0..n_orders {
        let mi = rng.below(n_markets as u64) as usize;
        let mut o = sims[mi].random_orders(&mut rng, 1);
        orders[mi].append(&mut o);
    }
    Workload { sims, refs, orders }
}

/// Clear one batch over all markets of the workload (state cloned so it can be repeated).
/// Returns a checksum so the optimizer can't drop the work.
pub fn bench_once(w: &Workload) -> u64 {
    let mut acc = 0u64;
    let s = Schedule::open();
    let mut off = Trace::off();
    for i in 0..w.sims.len() {
        let mut m = w.sims[i].m;
        let rep = clear_batch(&mut m, &w.sims[i].p, &w.refs[i], &s, &w.orders[i], &mut off);
        acc = acc
            .wrapping_mul(31)
            .wrapping_add(m.u[0] ^ m.u[1].rotate_left(17) ^ (m.c as u64) ^ rep.iterations as u64);
    }
    acc
}
