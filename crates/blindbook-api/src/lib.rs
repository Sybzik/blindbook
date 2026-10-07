//! Blindbook's API (ARCHITECTURE layer 3): secretless. It sequences requests, relays them to the
//! signer, keeps a ledger replica, writes the public log and serves live prices. It holds no key,
//! and it never sees, stores or logs a client address.

pub mod files;
pub mod journal;
pub mod link;
pub mod live;
pub mod pow;
pub mod routes;
pub mod sequencer;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use blindbook_ledger::H32;
use blindbook_mint::cashu::PublicKey;
use blindbook_mint::{KeysetKind, PublicKeyset};
use blindbook_polymarket::MarketInfo;
use tokio::sync::mpsc;
use tower_http::services::ServeDir;

use crate::link::{Remote, SignerLink};
use crate::routes::{AppState, PowBits};
use crate::sequencer::{ApiError, Cmd, RefFn, Sequencer, Shared};

pub struct StartConfig {
    pub data_dir: PathBuf,
    /// The mint master public key `M` pinned in the app build.
    pub m: PublicKey,
    pub pow: PowBits,
    /// CREDIT units per judge voucher.
    pub voucher_units: u64,
    /// Bearer token the signer presents on `/v1/signer`; `None` disables the endpoint.
    pub signer_token: Option<String>,
}

pub struct Running {
    pub router: Router,
    pub tx: mpsc::Sender<Cmd>,
    pub shared: Arc<Shared>,
    pub remote: Arc<Remote>,
}

/// The CREDIT keyset id, derived from `M`.
pub fn credit_id(m: &PublicKey) -> String {
    PublicKeyset::derive(m, KeysetKind::Credit)
        .expect("derivable")
        .id
        .to_string()
}

/// The two outcome keyset ids of a market, derived from `M`.
pub fn outcome_ids(m: &PublicKey, market: H32) -> [String; 2] {
    [0u8, 1].map(|outcome| {
        PublicKeyset::derive(
            m,
            KeysetKind::Outcome {
                market_id: market.0,
                outcome,
            },
        )
        .expect("derivable")
        .id
        .to_string()
    })
}

/// Open the data directory (replaying the journal), start the sequencer and the live task, and
/// build the router. `link`: `None` waits for a signer to dial `/v1/signer`.
pub fn start(
    cfg: StartConfig,
    link: Option<SignerLink>,
    refs: RefFn,
    catalog: BTreeMap<H32, MarketInfo>,
) -> Result<Running, ApiError> {
    let shared = Arc::new(Shared::new(credit_id(&cfg.m)));
    *shared.catalog.write().unwrap_or_else(|e| e.into_inner()) = catalog;
    let remote = Arc::new(Remote::default());
    let link = link.unwrap_or_else(|| SignerLink::Remote(remote.clone()));
    let seq = Sequencer::open(
        &cfg.data_dir,
        shared.credit_id.clone(),
        link,
        refs.clone(),
        shared.clone(),
    )?;
    let (tx, rx) = mpsc::channel(1_024);
    tokio::spawn(seq.run(rx));
    let live_bytes = Arc::new(RwLock::new(b"{}".to_vec()));
    tokio::spawn(live::run(shared.clone(), refs, live_bytes.clone()));
    let public = cfg.data_dir.join("public").join("v1");
    let state = AppState {
        tx: tx.clone(),
        shared: shared.clone(),
        pow: cfg.pow,
        voucher_units: cfg.voucher_units,
        remote: remote.clone(),
        signer_token: cfg.signer_token,
        m_hex: cfg.m.to_hex(),
        live: live_bytes,
    };
    let router = Router::new()
        .route("/v1/head", get(routes::head))
        .route("/v1/live", get(routes::live))
        .route("/v1/trade", post(routes::trade))
        .route("/v1/swap", post(routes::swap))
        .route("/v1/redeem", post(routes::redeem))
        .route("/v1/withdraw", post(routes::withdraw))
        .route("/v1/voucher", post(routes::voucher))
        .route("/v1/signer", get(routes::signer))
        .nest_service("/v1/delta", ServeDir::new(public.join("delta")))
        .nest_service("/v1/snapshot", ServeDir::new(public.join("snapshot")))
        .layer(DefaultBodyLimit::max(128 * 1024))
        .with_state(state);
    Ok(Running {
        router,
        tx,
        shared,
        remote,
    })
}
