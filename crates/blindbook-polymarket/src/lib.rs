//! Blindbook's Polymarket mirror (MARKETS.md; PROTOCOL sections 1 and 5).
//!
//! - [`gamma`]: the catalog and the listing rules.
//! - [`mirror`]: live order books over sharded WebSocket connections, feed health, and the
//!   once-a-second mid samples behind the 30 s anchor.
//! - [`reference`]: the per-batch snapshot the public log records and the engine prices from:
//!   anchor (lower median of the samples), depth-aware guard quotes, health.
//! - [`polygon`]: settlement from the ConditionalTokens contract on two independent RPCs.
//!
//! All of this runs on the server. A visitor's browser never contacts Polymarket or Polygon.
//! Prices are integers (ppm) parsed exactly from Polymarket's decimal strings, so a snapshot is
//! reproducible bit for bit.

pub mod anchor;
pub mod book;
pub mod feed;
pub mod fixed;
pub mod gamma;
pub mod mirror;
pub mod msg;
pub mod net;
pub mod polygon;
pub mod reference;

pub use book::Book;
pub use feed::{Feed, FeedStats, HealthConfig};
pub use gamma::MarketInfo;
pub use mirror::{Mirror, MirrorConfig};
pub use reference::{MarketFeed, RefSnapshot};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("network: {0}")]
    Net(String),
    #[error("parse: {0}")]
    Parse(String),
    #[error("rpc: {0}")]
    Rpc(String),
    #[error("market not found: {0}")]
    NotFound(String),
}
