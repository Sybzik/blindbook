//! Blindbook's ledger: everything about value and the public record that must come out the same
//! on the API, on the signer and in the verifier.
//!
//! - [`wire`]: slips, blinded outputs and signatures in Cashu's JSON shapes.
//! - [`keysets`]: keyset ids → (market, outcome) or CREDIT; denominations.
//! - [`ledger`]: market pools, the spent set, issuance per keyset, and the operations: trade
//!   batches around `blindbook-engine`, swaps, redemptions, top-up credits, withdrawals.
//! - [`reference`]: the reference snapshot each batch prices from.
//! - [`ops`]: the operations the API sequences and the signer executes, and [`ops::apply`].
//! - [`delta`]: the hash-chained public log.
//! - [`canonical`]: RFC 8785 canonical JSON, used for every hash.
//! - [`replay`]: every batch of the record through the engine again (the verifiers).
//!
//! No I/O, no clocks, no randomness, no curve code: callers pass in time, `Y` values and keyset
//! ids, so the same inputs always give the same log.

pub mod canonical;
pub mod delta;
pub mod hex;
pub mod keysets;
pub mod ledger;
pub mod ops;
pub mod reference;
pub mod replay;
pub mod wire;

pub use hex::H32;
pub use keysets::{Keyset, KeysetIds};
pub use ledger::{Ledger, Reject};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("canonical form: {0}")]
    Canonical(String),
    #[error("log chain: {0}")]
    Chain(String),
}
