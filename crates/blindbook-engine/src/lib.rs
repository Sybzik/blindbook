//! Blindbook market engine (PROTOCOL section 5), deterministic across native and wasm32.
//!
//! `no_std` on purpose: core has no `f64::exp`/`ln`, so every transcendental must come from
//! `libm`, and clippy's `disallowed-methods` (see clippy.toml) bans the rest. The verifier
//! (CLI and browser) runs this same code, so a replay reproduces every price bit for bit.
#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod clear;
pub mod math;
pub mod trace;
pub mod vectors;

pub use clear::*;
pub use trace::Trace;
