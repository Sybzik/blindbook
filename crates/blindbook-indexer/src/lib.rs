//! Blindbook's indexer (PROTOCOL section 11), shared by the API (with the incoming viewing key)
//! and the signer (with the full viewing key, for its own independent view):
//!
//! - [`keys`]: one-time top-up addresses at chosen diversifier indices, Revision 0 encoding;
//! - [`detect`]: payments recognised by trial decryption with the incoming viewing key only,
//!   and how private the paying transaction was (SHIELDED / AMOUNT VISIBLE / EXPOSED);
//! - [`follow`]: compact blocks with all pools and the full mempool stream over gRPC, never a
//!   request for a single transaction.

pub mod detect;
pub mod follow;
pub mod keys;
pub mod net;

pub use detect::{Payment, Privacy, TxShape};
pub use follow::{ChainEvent, follow};
pub use keys::DepositKeys;
pub use net::Net;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("key: {0}")]
    Key(String),
    #[error("chain: {0}")]
    Chain(String),
}
