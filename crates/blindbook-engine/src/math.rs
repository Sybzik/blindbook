//! Anchored-LMSR primitives (PROTOCOL 5.1), written in the log-odds form.
//!
//! All state enters as `d = (q_A - q_B) / b = (u_A - u_B) / b + logit(mu)`.
//! Every LMSR quantity the batch needs depends only on `d`, the cash or share amount and `b`,
//! because adding the same constant to both q's (complete sets, or the common part of u)
//! changes neither prices nor cost differences. This avoids `e^(q/b)` overflow
//! (q/b > 709.78 overflows f64; see `naive_buy_shares`) and keeps the operation order fixed.
//!
//! Only `libm` is used for transcendental functions; only + - * / on f64 otherwise.

use libm::{exp, expm1, log, log1p};

/// Logistic function, numerically stable for every finite input.
#[inline]
pub fn sigma(d: f64) -> f64 {
    if d >= 0.0 {
        1.0 / (1.0 + exp(-d))
    } else {
        let e = exp(d);
        e / (1.0 + e)
    }
}

/// logit(mu) with mu given in parts per million, 0 < mid_ppm < 1_000_000.
/// Computed as ln(mu / (1 - mu)) with both terms formed exactly in integers first.
#[inline]
pub fn logit_ppm(mid_ppm: u32) -> f64 {
    let num = mid_ppm as f64;
    let den = (1_000_000 - mid_ppm) as f64;
    log(num / den)
}

/// Log-odds of outcome A against B for the batch: d = (u_A - u_B)/b + logit(mu).
#[inline]
pub fn log_odds(u_a: u64, u_b: u64, b: u64, mid_ppm: u32) -> f64 {
    let diff = u_a as i128 - u_b as i128;
    (diff as f64) / (b as f64) + logit_ppm(mid_ppm)
}

/// Shares received for cash `x` on the outcome whose log-odds against the other is `d`
/// (use `d` for A and `-d` for B). Exact rewrite of
///   Delta = b*ln(e^((C(q)+x)/b) - e^(q_o/b)) - q_s
/// as
///   d >= 0:  Delta = x + b*log1p(e^(-d) * (1 - e^(-x/b)))
///   d <  0:  Delta = b*(ln(expm1(x/b) + e^(d + x/b)) - d)
#[inline]
pub fn buy_shares(d: f64, x: f64, b: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    let t = x / b;
    if d >= 0.0 {
        x + b * log1p(exp(-d) * (-expm1(-t)))
    } else {
        b * (log(expm1(t) + exp(d + t)) - d)
    }
}

/// Cash paid by the curve for selling `s` shares of the outcome with log-odds `d`:
///   C(q) - C(q - s*e) = -b*log1p(sigma(d) * expm1(-s/b))
#[inline]
pub fn sell_proceeds(d: f64, s: f64, b: f64) -> f64 {
    if s <= 0.0 {
        return 0.0;
    }
    -b * log1p(sigma(d) * expm1(-s / b))
}

/// Stable softplus ln(1 + e^x).
#[inline]
pub fn softplus(x: f64) -> f64 {
    if x > 0.0 {
        x + log1p(exp(-x))
    } else {
        log1p(exp(x))
    }
}

/// Cost function relative to q_B: C(q) - q_B = b*softplus(d). Reporting only.
#[inline]
pub fn cost_rel(d: f64, b: f64) -> f64 {
    b * softplus(d)
}

/// The formula exactly as written in PROTOCOL 5.1 (for comparison and the overflow demo).
pub fn naive_buy_shares(q_a: f64, q_b: f64, x: f64, b: f64) -> f64 {
    let c = b * log(exp(q_a / b) + exp(q_b / b));
    b * log(exp((c + x) / b) - exp(q_b / b)) - q_a
}

/// Naive cost function C(q) = b*ln(e^(q_A/b) + e^(q_B/b)) as written in PROTOCOL 5.1.
pub fn naive_cost(q_a: f64, q_b: f64, b: f64) -> f64 {
    b * log(exp(q_a / b) + exp(q_b / b))
}
