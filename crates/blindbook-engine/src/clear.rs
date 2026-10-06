//! Batch clearing for one market (PROTOCOL 5.2 - 5.5), integer units at every boundary.
//!
//! Units: 1 unit = 1,000 zatoshi; 1 ZEC = 100,000 units; a share-unit pays 1 unit if it wins.
//! Prices: ppm (parts per million) for Polymarket quotes, bp for user limits.
//!
//! Per phase (buys, then sells), the loop is:
//!   aggregate -> complete-set matching -> curve for the residual side -> guard
//!   -> exposure invariant (shrink the residual side, exact integer check)
//!   -> limit check (drop-and-repeat) -> allocate pro-rata in integers.
//! Every rounding is in the house's favour, and W = max(u_A, u_B) - c <= L is checked
//! on the *rounded* integer result, so dust can never push the house past L.

use crate::math::{buy_shares, log_odds, sell_proceeds, sigma};
use crate::trace::Trace;
use alloc::vec::Vec;
use libm::{ceil, floor};

pub const UNITS_PER_ZEC: u64 = 100_000;
pub const PPM: u32 = 1_000_000;
pub const BP: u64 = 10_000;

/// How the limit-price loop removes orders whose limit is beaten by the side average.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropRule {
    /// PROTOCOL 5.4 as written: drop every violator at once, then repeat.
    AllViolators,
    /// Recommended: drop only the violators at the worst limit on each side, then repeat.
    /// Never over-drops (an order is refunded only if it would still violate after all
    /// worse-limited orders on its side are gone).
    LowestTier,
}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// LMSR liquidity, units.
    pub b: u64,
    /// Exposure buffer L_m, units.
    pub l: u64,
    /// Trade fee in bp of the buy amount / of sell proceeds.
    pub fee_bp: u32,
    /// Max buy amount (units) and max sell notional at bid (units). PROTOCOL: 4 * L_m.
    pub max_trade: u64,
    /// Halt when either outcome's ask >= this (ppm). PROTOCOL: 0.98.
    pub halt_ask_ppm: u32,
    /// Halt when the reference is older than this. PROTOCOL: 10 s.
    pub stale_ms: u64,
    pub drop_rule: DropRule,
}

impl Params {
    /// Testnet parameters from PROTOCOL section 1: b = 0.2 TAZ, L = 0.05 TAZ, fee 1%.
    pub fn testnet() -> Self {
        Params {
            b: 20_000,
            l: 5_000,
            fee_bp: 100,
            max_trade: 20_000,
            halt_ask_ppm: 980_000,
            stale_ms: 10_000,
            drop_rule: DropRule::LowestTier,
        }
    }
    /// Mainnet parameters: b = 0.01 ZEC, L = 0.002 ZEC.
    pub fn mainnet() -> Self {
        Params {
            b: 1_000,
            l: 200,
            max_trade: 800,
            ..Params::testnet()
        }
    }
}

/// Per-market state. `u` = users' outstanding share-units per outcome, `c` = market cash
/// (net of fees, can go down to -L), `house` = fees + dust credited to the house ledger.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Market {
    pub u: [u64; 2],
    pub c: i64,
    pub house: i64,
}

impl Market {
    /// W = max(u_A, u_B) - c
    pub fn exposure(&self) -> i128 {
        self.u[0].max(self.u[1]) as i128 - self.c as i128
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Reference {
    /// Median Polymarket mid of outcome A over the last 30 s.
    pub mid_ppm: u32,
    /// Depth-aware ask per outcome (price to fill our max trade size), ppm.
    pub ask_ppm: [u32; 2],
    /// Depth-aware bid per outcome, ppm.
    pub bid_ppm: [u32; 2],
    pub age_ms: u64,
    pub closed: bool,
    pub accepting_orders: bool,
}

impl Reference {
    /// Quote with a symmetric spread around mid: ask_A = mid + h, bid_A = mid - h,
    /// ask_B = 1 - bid_A, bid_B = 1 - ask_A (mirrored CTF books).
    pub fn with_spread(mid_ppm: u32, half_spread_ppm: u32) -> Self {
        let ask_a = (mid_ppm + half_spread_ppm).min(PPM);
        let bid_a = mid_ppm.saturating_sub(half_spread_ppm).max(1);
        Reference {
            mid_ppm,
            ask_ppm: [ask_a, PPM - bid_a],
            bid_ppm: [bid_a, (PPM - ask_a).max(1)],
            age_ms: 0,
            closed: false,
            accepting_orders: true,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Schedule {
    pub now_ms: u64,
    pub event_start_ms: Option<u64>,
    pub end_ms: u64,
}

impl Schedule {
    pub fn open() -> Self {
        Schedule {
            now_ms: 0,
            event_start_ms: None,
            end_ms: u64::MAX,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: u64,
    pub side: Side,
    /// 0 = A, 1 = B.
    pub outcome: u8,
    /// Buy: CREDIT units paid in. Sell: share-units offered.
    pub amount: u64,
    /// Buy: maximum average price. Sell: minimum average price. bp of 1 unit per share-unit.
    pub limit_bp: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Filled,
    /// Partially filled because of the exposure invariant.
    Shrunk,
    DroppedLimit,
    Halted,
    Rejected,
}

/// Result for one order. Buy: `kept` = net CREDIT kept by the market, `out` = share-units issued,
/// `fee` = fee kept, `refund` = CREDIT returned. Sell: `kept` = share-units sold,
/// `out` = CREDIT paid, `fee` = fee kept, `refund` = share-units returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fill {
    pub id: u64,
    pub status: Status,
    pub kept: u64,
    pub out: u64,
    pub fee: u64,
    pub refund: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HaltReason {
    Closed,
    NotAccepting,
    EventStarted,
    PastEnd,
    AskAtLimit,
    StaleReference,
    BadQuote,
    BadInput,
    Numeric,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SideReport {
    /// Buy: net cash kept. Sell: shares sold.
    pub kept: u64,
    /// Buy: curve/guard share total S (floored). Sell: proceeds P (floored).
    pub total: u64,
    /// Buy: share-units actually issued (sum of per-order floors). Sell: gross paid (before fee).
    pub allocated: u64,
    pub guard_binding: bool,
    pub shrunk: bool,
}

#[derive(Clone, Debug)]
pub struct BatchReport {
    pub halt: Option<HaltReason>,
    pub fills: Vec<Fill>,
    pub buy: [SideReport; 2],
    pub sell: [SideReport; 2],
    /// Loop iterations (buys + sells).
    pub iterations: u32,
    /// How often the residual-side shrink had to fall back to the uniform shrink.
    pub uniform_fallbacks: u32,
    /// Matched complete sets (buys: f64 k; sells: integer k).
    pub k_buy: f64,
    pub k_sell: u64,
    pub d_open: f64,
    pub d_after_buys: f64,
    pub d_close: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NumErr {
    Numeric,
    BadInput,
}

#[inline]
fn floor_units(x: f64) -> Result<u64, NumErr> {
    if !x.is_finite() {
        return Err(NumErr::Numeric);
    }
    if x <= 0.0 {
        return Ok(0);
    }
    let f = floor(x);
    if f >= 4.0e15 {
        return Err(NumErr::Numeric);
    }
    Ok(f as u64)
}

#[inline]
fn ceil_units(x: f64) -> Result<u64, NumErr> {
    if !x.is_finite() {
        return Err(NumErr::Numeric);
    }
    if x <= 0.0 {
        return Ok(0);
    }
    let f = ceil(x);
    if f >= 4.0e15 {
        return Err(NumErr::Numeric);
    }
    Ok(f as u64)
}

#[inline]
fn mul_div_floor(a: u64, b: u64, d: u64) -> u64 {
    ((a as u128 * b as u128) / d as u128) as u64
}

#[inline]
fn mul_div_ceil(a: u64, b: u64, d: u64) -> u64 {
    let n = a as u128 * b as u128;
    n.div_ceil(d as u128) as u64
}

/// Integer fee, rounded up (house's favour): ceil(amount * fee_bp / 10000).
#[inline]
pub fn fee_of(amount: u64, fee_bp: u32) -> u64 {
    mul_div_ceil(amount, fee_bp as u64, BP)
}

pub fn halt_reason(p: &Params, r: &Reference, s: &Schedule) -> Option<HaltReason> {
    let valid = |x: u32| x > 0 && x < PPM;
    let valid_quote = |x: u32| x > 0 && x <= PPM;
    if !valid(r.mid_ppm)
        || !r.ask_ppm.iter().all(|&a| valid_quote(a))
        || !r.bid_ppm.iter().all(|&b| valid_quote(b))
    {
        return Some(HaltReason::BadQuote);
    }
    if r.closed {
        return Some(HaltReason::Closed);
    }
    if !r.accepting_orders {
        return Some(HaltReason::NotAccepting);
    }
    if let Some(t) = s.event_start_ms
        && s.now_ms >= t
    {
        return Some(HaltReason::EventStarted);
    }
    if s.now_ms >= s.end_ms {
        return Some(HaltReason::PastEnd);
    }
    if r.ask_ppm[0] >= p.halt_ask_ppm || r.ask_ppm[1] >= p.halt_ask_ppm {
        return Some(HaltReason::AskAtLimit);
    }
    if r.age_ms > p.stale_ms {
        return Some(HaltReason::StaleReference);
    }
    None
}

// ---------------------------------------------------------------------------------------------
// Buys
// ---------------------------------------------------------------------------------------------

struct BuyEval {
    s: [u64; 2],
    k: f64,
    res: Option<usize>,
    p: [f64; 2],
    guard: [bool; 2],
}

/// Shares for kept net cash totals `t` (per outcome) at log-odds `d`.
fn eval_buy(
    d: f64,
    b: f64,
    ask_ppm: [u32; 2],
    t: [u64; 2],
    tr: &mut Trace,
) -> Result<BuyEval, NumErr> {
    let p = [sigma(d), sigma(-d)];
    let x = [t[0] as f64, t[1] as f64];
    let mut k = 0.0;
    let mut res = None;
    if t[0] > 0 && t[1] > 0 {
        let ka = x[0] / p[0];
        let kb = x[1] / p[1];
        if ka <= kb {
            k = ka;
            if ka < kb {
                res = Some(1);
            }
        } else {
            k = kb;
            res = Some(0);
        }
    } else if t[0] > 0 {
        res = Some(0);
    } else if t[1] > 0 {
        res = Some(1);
    }
    let mut curve = [k, k];
    let mut r = 0.0;
    if let Some(s) = res {
        r = x[s] - k * p[s];
        if r < 0.0 {
            r = 0.0;
        }
        let ds = if s == 0 { d } else { -d };
        curve[s] = k + buy_shares(ds, r, b);
    }
    let mut s_out = [0u64; 2];
    let mut guard = [false; 2];
    for i in 0..2 {
        if t[i] == 0 {
            continue;
        }
        let g = (x[i] * 1_000_000.0) / (ask_ppm[i] as f64);
        let sh = if g < curve[i] {
            guard[i] = true;
            g
        } else {
            curve[i]
        };
        s_out[i] = floor_units(sh)?;
        tr.f(g);
    }
    tr.f(p[0]);
    tr.f(p[1]);
    tr.f(k);
    tr.f(r);
    tr.f(curve[0]);
    tr.f(curve[1]);
    tr.u(s_out[0]);
    tr.u(s_out[1]);
    Ok(BuyEval {
        s: s_out,
        k,
        res,
        p,
        guard,
    })
}

#[inline]
fn w_after_buy(m: &Market, s: [u64; 2], t: [u64; 2]) -> i128 {
    let ua = m.u[0] as i128 + s[0] as i128;
    let ub = m.u[1] as i128 + s[1] as i128;
    ua.max(ub) - (m.c as i128 + t[0] as i128 + t[1] as i128)
}

#[derive(Clone, Copy)]
enum Shrink {
    None,
    /// Kept on side `side` = floor(base * t / x) per order.
    Residual {
        side: usize,
        t: u64,
        x: u64,
    },
    /// Kept on both sides = floor(base * phi / 2^32) per order.
    Uniform {
        phi: u64,
    },
}

const PHI_ONE: u64 = 1 << 32;

#[inline]
fn kept_of(base: u64, outcome: usize, sh: Shrink) -> u64 {
    match sh {
        Shrink::None => base,
        Shrink::Residual { side, t, x } => {
            if outcome == side {
                mul_div_floor(base, t, x)
            } else {
                base
            }
        }
        Shrink::Uniform { phi } => mul_div_floor(base, phi, PHI_ONE),
    }
}

struct Ord {
    idx: usize,
    outcome: usize,
    /// Buy: net cash. Sell: shares.
    base: u64,
    limit: u32,
    active: bool,
}

fn totals(ords: &[Ord], sh: Shrink) -> [u64; 2] {
    let mut t = [0u64; 2];
    for o in ords.iter().filter(|o| o.active) {
        t[o.outcome] += kept_of(o.base, o.outcome, sh);
    }
    t
}

/// Generic shrink search shared by buys and sells.
/// `feasible(sh)` evaluates the batch with that shrink and checks W <= L on the rounded result.
/// `residual` = (side, matched-part target in kept units on that side).
fn find_shrink<F>(
    ords: &[Ord],
    x: [u64; 2],
    residual: Option<(usize, u64)>,
    fallbacks: &mut u32,
    mut feasible: F,
) -> Result<Shrink, NumErr>
where
    F: FnMut(Shrink) -> Result<bool, NumErr>,
{
    if let Some((side, target)) = residual {
        let xs = x[side];
        let kept_side = |t: u64| -> u64 {
            let sh = Shrink::Residual { side, t, x: xs };
            totals(ords, sh)[side]
        };
        // smallest t with kept_side(t) >= target (monotone in t)
        let (mut lo, mut hi) = (0u64, xs);
        if kept_side(0) >= target {
            hi = 0;
        } else {
            while hi - lo > 1 {
                let mid = lo + (hi - lo) / 2;
                if kept_side(mid) >= target {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
        }
        let t_m = hi;
        if feasible(Shrink::Residual {
            side,
            t: t_m,
            x: xs,
        })? {
            // bisection: lo feasible, hi infeasible (the full batch was infeasible)
            let (mut lo, mut hi) = (t_m, xs);
            while hi - lo > 1 {
                let mid = lo + (hi - lo) / 2;
                if feasible(Shrink::Residual {
                    side,
                    t: mid,
                    x: xs,
                })? {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            return Ok(Shrink::Residual { side, t: lo, x: xs });
        }
    }
    // Fallback: shrink both sides uniformly. phi = 0 is the empty batch, feasible because
    // W only changes through fills and held before the batch.
    *fallbacks += 1;
    let (mut lo, mut hi) = (0u64, PHI_ONE);
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if feasible(Shrink::Uniform { phi: mid })? {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Ok(Shrink::Uniform { phi: lo })
}

/// Drop orders whose limit is beaten. `violates(order, side)` decides; returns true if any dropped.
fn apply_drops<F>(ords: &mut [Ord], rule: DropRule, mut violates: F, fills: &mut [Fill]) -> bool
where
    F: FnMut(&Ord) -> bool,
{
    let mut dropped = false;
    for side in 0..2 {
        let mut worst: Option<u32> = None;
        let mut any = false;
        for o in ords.iter().filter(|o| o.active && o.outcome == side) {
            if violates(o) {
                any = true;
                worst = Some(match (worst, rule) {
                    (None, _) => o.limit,
                    // buys: worst = lowest max-price; sells: caller passes limits so that
                    // "worst" is also the minimum (sell limits are transformed below)
                    (Some(w), _) => w.min(o.limit),
                });
            }
        }
        if !any {
            continue;
        }
        for o in ords.iter_mut().filter(|o| o.active && o.outcome == side) {
            let hit = violates(o)
                && match rule {
                    DropRule::AllViolators => true,
                    DropRule::LowestTier => Some(o.limit) == worst,
                };
            if hit {
                o.active = false;
                fills[o.idx].status = Status::DroppedLimit;
                dropped = true;
            }
        }
    }
    dropped
}

#[allow(clippy::too_many_arguments)]
fn clear_buys(
    m: &mut Market,
    p: &Params,
    r: &Reference,
    orders: &[Order],
    fills: &mut [Fill],
    rep: &mut BatchReport,
    tr: &mut Trace,
) -> Result<(), NumErr> {
    let b = p.b as f64;
    let mut ords: Vec<Ord> = Vec::new();
    let mut fees: Vec<u64> = Vec::new();
    for (idx, o) in orders.iter().enumerate() {
        if o.side != Side::Buy {
            continue;
        }
        let fee = fee_of(o.amount, p.fee_bp);
        let net = o.amount - fee.min(o.amount);
        if o.amount == 0
            || net == 0
            || o.amount > p.max_trade
            || o.outcome > 1
            || o.limit_bp as u64 > BP
        {
            fills[idx] = Fill {
                id: o.id,
                status: Status::Rejected,
                kept: 0,
                out: 0,
                fee: 0,
                refund: o.amount,
            };
            continue;
        }
        fills[idx] = Fill {
            id: o.id,
            status: Status::Filled,
            kept: 0,
            out: 0,
            fee: 0,
            refund: 0,
        };
        ords.push(Ord {
            idx,
            outcome: o.outcome as usize,
            base: net,
            limit: o.limit_bp,
            active: true,
        });
        fees.push(fee);
    }
    let d = log_odds(m.u[0], m.u[1], p.b, r.mid_ppm);
    rep.d_open = d;
    tr.tag(1);
    tr.f(d);

    let mut shrink;
    let mut ev;
    let mut t;
    loop {
        rep.iterations += 1;
        let x = totals(&ords, Shrink::None);
        if x == [0, 0] {
            shrink = Shrink::None;
            ev = BuyEval {
                s: [0, 0],
                k: 0.0,
                res: None,
                p: [0.0, 0.0],
                guard: [false, false],
            };
            t = [0, 0];
            break;
        }
        ev = eval_buy(d, b, r.ask_ppm, x, tr)?;
        t = x;
        shrink = Shrink::None;
        if w_after_buy(m, ev.s, t) > p.l as i128 {
            let residual = match ev.res {
                Some(s) => Some((s, ceil_units(ev.k * ev.p[s])?.min(x[s]))),
                None => None,
            };
            let mm = *m;
            let ords_ref = &ords;
            let mut probe = Trace::off();
            shrink = find_shrink(ords_ref, x, residual, &mut rep.uniform_fallbacks, |sh| {
                let tt = totals(ords_ref, sh);
                let e = eval_buy(d, b, r.ask_ppm, tt, &mut probe)?;
                Ok(w_after_buy(&mm, e.s, tt) <= p.l as i128)
            })?;
            t = totals(&ords, shrink);
            ev = eval_buy(d, b, r.ask_ppm, t, tr)?;
        }
        // limit check on the side average t_s / S_s (exact integer comparison)
        let s_tot = ev.s;
        let t_tot = t;
        let dropped = apply_drops(
            &mut ords,
            p.drop_rule,
            |o| {
                let side = o.outcome;
                t_tot[side] > 0
                    && (t_tot[side] as u128) * (BP as u128)
                        > (o.limit as u128) * (s_tot[side] as u128)
            },
            fills,
        );
        if !dropped {
            break;
        }
    }
    tr.u(t[0]);
    tr.u(t[1]);

    // allocate
    let mut issued = [0u64; 2];
    for (j, o) in ords.iter().enumerate() {
        let order = &orders[o.idx];
        if !o.active {
            fills[o.idx].refund = order.amount;
            continue;
        }
        let kept = kept_of(o.base, o.outcome, shrink);
        let side = o.outcome;
        let out = if t[side] > 0 {
            mul_div_floor(kept, ev.s[side], t[side])
        } else {
            0
        };
        let fee_kept = mul_div_ceil(fees[j], kept, o.base);
        let refund = order.amount - kept - fee_kept;
        issued[side] += out;
        fills[o.idx] = Fill {
            id: order.id,
            status: if kept == o.base {
                Status::Filled
            } else {
                Status::Shrunk
            },
            kept,
            out,
            fee: fee_kept,
            refund,
        };
        m.house += fee_kept as i64;
        tr.u(out);
        tr.u(refund);
    }
    for i in 0..2 {
        rep.buy[i] = SideReport {
            kept: t[i],
            total: ev.s[i],
            allocated: issued[i],
            guard_binding: ev.guard[i],
            shrunk: !matches!(shrink, Shrink::None),
        };
    }
    rep.k_buy = ev.k;
    m.u[0] += issued[0];
    m.u[1] += issued[1];
    m.c += (t[0] + t[1]) as i64;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Sells
// ---------------------------------------------------------------------------------------------

struct SellEval {
    pr: [u64; 2],
    k: u64,
    res: Option<usize>,
    guard: [bool; 2],
}

fn eval_sell(
    d: f64,
    b: f64,
    bid_ppm: [u32; 2],
    kk: [u64; 2],
    tr: &mut Trace,
) -> Result<SellEval, NumErr> {
    let p = [sigma(d), sigma(-d)];
    let k = kk[0].min(kk[1]);
    let res = if kk[0] > kk[1] {
        Some(0)
    } else if kk[1] > kk[0] {
        Some(1)
    } else {
        None
    };
    let kf = k as f64;
    let mut curve = [kf * p[0], kf * p[1]];
    if let Some(s) = res {
        let rr = (kk[s] - k) as f64;
        let ds = if s == 0 { d } else { -d };
        curve[s] += sell_proceeds(ds, rr, b);
    }
    let mut pr = [0u64; 2];
    let mut guard = [false; 2];
    for i in 0..2 {
        if kk[i] == 0 {
            continue;
        }
        let g = (kk[i] as f64) * (bid_ppm[i] as f64) / 1_000_000.0;
        let v = if g < curve[i] {
            guard[i] = true;
            g
        } else {
            curve[i]
        };
        pr[i] = floor_units(v)?;
        tr.f(g);
    }
    tr.f(p[0]);
    tr.f(p[1]);
    tr.f(curve[0]);
    tr.f(curve[1]);
    tr.u(pr[0]);
    tr.u(pr[1]);
    Ok(SellEval { pr, k, res, guard })
}

#[inline]
fn w_after_sell(m: &Market, kk: [u64; 2], pr: [u64; 2]) -> i128 {
    let ua = m.u[0] as i128 - kk[0] as i128;
    let ub = m.u[1] as i128 - kk[1] as i128;
    ua.max(ub) - (m.c as i128 - pr[0] as i128 - pr[1] as i128)
}

fn clear_sells(
    m: &mut Market,
    p: &Params,
    r: &Reference,
    orders: &[Order],
    fills: &mut [Fill],
    rep: &mut BatchReport,
    tr: &mut Trace,
) -> Result<(), NumErr> {
    let b = p.b as f64;
    let mut ords: Vec<Ord> = Vec::new();
    for (idx, o) in orders.iter().enumerate() {
        if o.side != Side::Sell {
            continue;
        }
        let bid = if o.outcome <= 1 {
            r.bid_ppm[o.outcome as usize]
        } else {
            0
        };
        let notional = mul_div_floor(o.amount, bid as u64, PPM as u64);
        if o.amount == 0 || o.outcome > 1 || o.limit_bp as u64 > BP || notional > p.max_trade {
            fills[idx] = Fill {
                id: o.id,
                status: Status::Rejected,
                kept: 0,
                out: 0,
                fee: 0,
                refund: o.amount,
            };
            continue;
        }
        fills[idx] = Fill {
            id: o.id,
            status: Status::Filled,
            kept: 0,
            out: 0,
            fee: 0,
            refund: 0,
        };
        // Sell limits are minimum prices: store (BP - limit) so that "worst" = min works in apply_drops.
        ords.push(Ord {
            idx,
            outcome: o.outcome as usize,
            base: o.amount,
            limit: BP as u32 - o.limit_bp,
            active: true,
        });
    }
    let x_all = totals(&ords, Shrink::None);
    if x_all[0] > m.u[0] || x_all[1] > m.u[1] {
        return Err(NumErr::BadInput); // more shares offered than outstanding: impossible with valid slips
    }
    let d = log_odds(m.u[0], m.u[1], p.b, r.mid_ppm);
    rep.d_after_buys = d;
    tr.tag(2);
    tr.f(d);

    let mut shrink;
    let mut ev;
    let mut kk;
    loop {
        rep.iterations += 1;
        let x = totals(&ords, Shrink::None);
        if x == [0, 0] {
            shrink = Shrink::None;
            ev = SellEval {
                pr: [0, 0],
                k: 0,
                res: None,
                guard: [false, false],
            };
            kk = [0, 0];
            break;
        }
        ev = eval_sell(d, b, r.bid_ppm, x, tr)?;
        kk = x;
        shrink = Shrink::None;
        if w_after_sell(m, kk, ev.pr) > p.l as i128 {
            let residual = ev.res.map(|s| (s, ev.k));
            let mm = *m;
            let ords_ref = &ords;
            let mut probe = Trace::off();
            shrink = find_shrink(ords_ref, x, residual, &mut rep.uniform_fallbacks, |sh| {
                let tt = totals(ords_ref, sh);
                let e = eval_sell(d, b, r.bid_ppm, tt, &mut probe)?;
                Ok(w_after_sell(&mm, tt, e.pr) <= p.l as i128)
            })?;
            kk = totals(&ords, shrink);
            ev = eval_sell(d, b, r.bid_ppm, kk, tr)?;
        }
        let pr = ev.pr;
        let k_tot = kk;
        let dropped = apply_drops(
            &mut ords,
            p.drop_rule,
            |o| {
                let side = o.outcome;
                let min_bp = BP as u128 - o.limit as u128;
                // avg = pr / kk < min  <=>  pr * BP < min * kk
                k_tot[side] > 0
                    && (pr[side] as u128) * (BP as u128) < min_bp * (k_tot[side] as u128)
            },
            fills,
        );
        if !dropped {
            break;
        }
    }
    tr.u(kk[0]);
    tr.u(kk[1]);

    let mut gross_sum = [0u64; 2];
    for o in ords.iter() {
        let order = &orders[o.idx];
        if !o.active {
            fills[o.idx].refund = order.amount;
            continue;
        }
        let side = o.outcome;
        let kept = kept_of(o.base, side, shrink);
        let gross = if kk[side] > 0 {
            mul_div_floor(ev.pr[side], kept, kk[side])
        } else {
            0
        };
        let fee = fee_of(gross, p.fee_bp);
        let credit = gross - fee;
        gross_sum[side] += gross;
        fills[o.idx] = Fill {
            id: order.id,
            status: if kept == o.base {
                Status::Filled
            } else {
                Status::Shrunk
            },
            kept,
            out: credit,
            fee,
            refund: order.amount - kept,
        };
        m.house += fee as i64;
        tr.u(credit);
        tr.u(fee);
    }
    for i in 0..2 {
        rep.sell[i] = SideReport {
            kept: kk[i],
            total: ev.pr[i],
            allocated: gross_sum[i],
            guard_binding: ev.guard[i],
            shrunk: !matches!(shrink, Shrink::None),
        };
        // proceeds dust (P - sum of per-order gross) goes to the house ledger
        m.house += (ev.pr[i] - gross_sum[i]) as i64;
    }
    rep.k_sell = ev.k;
    m.u[0] -= kk[0];
    m.u[1] -= kk[1];
    m.c -= (ev.pr[0] + ev.pr[1]) as i64;
    Ok(())
}

/// Clear one 2-second batch for one market: halts, buys, then sells.
/// On any numeric failure the whole batch is refunded (treated as a halt) and the
/// market state is left untouched.
pub fn clear_batch(
    m: &mut Market,
    p: &Params,
    r: &Reference,
    s: &Schedule,
    orders: &[Order],
    tr: &mut Trace,
) -> BatchReport {
    let mut rep = BatchReport {
        halt: None,
        fills: orders
            .iter()
            .map(|o| Fill {
                id: o.id,
                status: Status::Halted,
                kept: 0,
                out: 0,
                fee: 0,
                refund: o.amount,
            })
            .collect(),
        buy: [SideReport::default(); 2],
        sell: [SideReport::default(); 2],
        iterations: 0,
        uniform_fallbacks: 0,
        k_buy: 0.0,
        k_sell: 0,
        d_open: 0.0,
        d_after_buys: 0.0,
        d_close: 0.0,
    };
    if let Some(h) = halt_reason(p, r, s) {
        rep.halt = Some(h);
        tr.tag(0xDEAD);
        return rep;
    }
    let before = *m;
    let mut fills = rep.fills.clone();
    let res = clear_buys(m, p, r, orders, &mut fills, &mut rep, tr)
        .and_then(|_| clear_sells(m, p, r, orders, &mut fills, &mut rep, tr));
    match res {
        Ok(()) => {
            rep.fills = fills;
            rep.d_close = log_odds(m.u[0], m.u[1], p.b, r.mid_ppm);
            tr.tag(3);
            tr.f(rep.d_close);
            tr.u(m.u[0]);
            tr.u(m.u[1]);
            tr.i(m.c);
            tr.i(m.house);
        }
        Err(e) => {
            *m = before;
            rep.halt = Some(match e {
                NumErr::BadInput => HaltReason::BadInput,
                NumErr::Numeric => HaltReason::Numeric,
            });
            for (f, o) in rep.fills.iter_mut().zip(orders) {
                *f = Fill {
                    id: o.id,
                    status: Status::Halted,
                    kept: 0,
                    out: 0,
                    fee: 0,
                    refund: o.amount,
                };
            }
        }
    }
    rep
}

/// Our displayed price of A in ppm (floor) for the given state and mid.
pub fn price_a_ppm(m: &Market, p: &Params, mid_ppm: u32) -> u64 {
    let d = log_odds(m.u[0], m.u[1], p.b, mid_ppm);
    floor(sigma(d) * 1_000_000.0) as u64
}

/// Lower median of mid samples (ppm). Recommended normative definition for the 30 s anchor.
pub fn median_ppm(samples: &mut [u32]) -> Option<u32> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_unstable();
    Some(samples[(samples.len() - 1) / 2])
}
