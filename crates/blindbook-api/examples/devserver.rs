//! A self-contained development server for the web app: the real API with the signer in-process,
//! three synthetic markets whose reference drifts slowly, judge vouchers `DEV-0001`…`DEV-0099`,
//! a block every 15 s, and dev-only routes that simulate the chain:
//!
//! - `POST /dev/pay/{topup_id}`: pay a top-up address (as if a wallet did, mined at once);
//! - `POST /dev/payout`: pay every queued withdrawal with a fake txid.
//!
//! ```text
//! cargo run -p blindbook-api --features embedded-signer --example devserver [-- --block-ms <ms>]
//! ```
//! `--block-ms` closes blocks faster, e.g. 250 to grow a long log (segments) in a minute.
//! Listens on 127.0.0.1:8090 (the Vite dev server proxies `/v1` there). Never for production:
//! the master key is a public test key.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, State};
use axum::routing::post;
use blindbook_api::link::SignerLink;
use blindbook_api::routes::PowBits;
use blindbook_api::sequencer::{Cmd, RefFn, now_ms};
use blindbook_api::topup::{DENOMINATIONS_TESTNET, Desk, TopupBook, ZeroConfCaps};
use blindbook_api::{StartConfig, outcome_ids, start};
use blindbook_indexer::{DepositKeys, Net, Payment, Privacy, TxShape};
use blindbook_ledger::H32;
use blindbook_ledger::delta::{ChainStats, LogEvent};
use blindbook_ledger::ledger::{MarketEntry, MarketInputs, MarketParams, MarketStatus, Pool};
use blindbook_ledger::ops::Op;
use blindbook_ledger::reference::RefSnapshot;
use blindbook_mint::cashu::SecretKey;
use blindbook_mint::{MasterKey, sha256};
use blindbook_polymarket::MarketInfo;
use blindbook_signer::{Deposit, Signer};
use tokio::sync::oneshot;

/// The development reserve reported to the log (50 TAZ, simulated).
const DEV_RESERVE_ZAT: u64 = 5_000_000_000;

/// The public TEST master key: m = SHA256("blindbook/devserver"). Never a real key.
fn master() -> MasterKey {
    MasterKey::from_secret(SecretKey::from_slice(&sha256(b"blindbook/devserver")).unwrap())
}

/// The public TEST seal key: SHA256("blindbook/devserver/seal").
pub const SEAL_LABEL: &[u8] = b"blindbook/devserver/seal";

struct Fake {
    id: H32,
    question: &'static str,
    outcomes: [&'static str; 2],
    mid: f64,
    rules: &'static str,
    start_in_ms: Option<u64>,
}

fn fakes() -> Vec<Fake> {
    vec![
        Fake {
            id: H32(sha256(b"dev/market/navi-faze")),
            question: "CS2: NAVI vs FaZe (BO3), Grand Final",
            outcomes: ["NAVI", "FaZe"],
            mid: 0.61,
            rules: "This market will resolve to \"NAVI\" if NAVI wins the match against FaZe. If the match is canceled or ends in a tie, this market will resolve 50-50. The resolution source is official information from hltv.org.",
            start_in_ms: Some(3 * 3_600_000),
        },
        Fake {
            id: H32(sha256(b"dev/market/fed-hold")),
            question: "Will there be no change in Fed interest rates after the October 2026 meeting?",
            outcomes: ["Yes", "No"],
            mid: 0.83,
            rules: "This market will resolve to \"Yes\" if the Federal Reserve leaves the target federal funds rate unchanged at its October 2026 meeting. Otherwise it resolves to \"No\". The resolution source is the FOMC statement.",
            start_in_ms: None,
        },
        Fake {
            id: H32(sha256(b"dev/market/lisbon-rain")),
            question: "Will it rain in Lisbon on October 20?",
            outcomes: ["Yes", "No"],
            mid: 0.42,
            rules: "This market will resolve to \"Yes\" if at least 1 mm of rain is recorded at Lisbon Humberto Delgado Airport on October 20, 2026 (local time). The resolution source is the IPMA daily summary.",
            start_in_ms: None,
        },
    ]
}

fn reference(base: f64, phase: f64) -> MarketInputs {
    let t = now_ms() as f64 / 60_000.0;
    let mid = (base + 0.015 * (t + phase).sin()).clamp(0.05, 0.95);
    let mid_ppm = (mid * 1e6) as u32;
    let h = 5_000;
    MarketInputs {
        reference: RefSnapshot {
            at_ms: now_ms(),
            mid_samples: vec![mid_ppm; 30],
            mid_ppm,
            ask_ppm: [mid_ppm + h, 1_000_000 - mid_ppm + h],
            bid_ppm: [mid_ppm - h, 1_000_000 - mid_ppm - h],
            guard_micro: 500_000_000,
            best_bid_ppm: [mid_ppm - h, 1_000_000 - mid_ppm - h],
            best_ask_ppm: [mid_ppm + h, 1_000_000 - mid_ppm + h],
            server_ts_ms: [now_ms(); 2],
            unhealthy_ms: 0,
        },
        closed: false,
        accepting_orders: true,
    }
}

#[derive(Clone)]
struct Dev {
    signer: Arc<Mutex<Signer>>,
    desk: Desk,
    tx: tokio::sync::mpsc::Sender<Cmd>,
}

async fn pay(State(dev): State<Dev>, Path(id): Path<String>) -> String {
    let t = dev.desk.book.lock().unwrap().get(&id).cloned();
    let Some(t) = t else {
        return "unknown top-up".into();
    };
    let txid =
        blindbook_ledger::hex::encode(&sha256(format!("devpay/{id}/{}", now_ms()).as_bytes()));
    dev.signer.lock().unwrap().deposit_seen(Deposit {
        diversifier_index: t.index,
        amount: t.amount_zat / 1_000,
        txid: txid.clone(),
        confirmed: true,
    });
    let p = Payment {
        txid,
        action: 0,
        pool: "ironwood".into(),
        value_zat: t.amount_zat,
        index: u128::from(t.index),
        shape: TxShape {
            ironwood_actions: 2,
            ..TxShape::default()
        },
        privacy: Privacy::Shielded,
    };
    let job = dev.desk.book.lock().unwrap().on_payment(&p, Some(1));
    if let Some(job) = job {
        tokio::spawn(blindbook_api::topup::credit(
            dev.tx.clone(),
            dev.desk.book.clone(),
            job,
        ));
    }
    "paid".into()
}

async fn payout(State(dev): State<Dev>) -> String {
    let queued: Vec<H32> = dev
        .signer
        .lock()
        .unwrap()
        .payout_queue()
        .iter()
        .map(|p| p.commitment)
        .collect();
    if queued.is_empty() {
        return "nothing queued".into();
    }
    let event = LogEvent::PayoutSent {
        txid: blindbook_ledger::hex::encode(&sha256(format!("devpayout/{}", now_ms()).as_bytes())),
        commitments: queued.clone(),
    };
    dev.signer.lock().unwrap().report_event(event.clone());
    let _ = dev.tx.send(Cmd::Event(event)).await;
    format!("paid {} withdrawals", queued.len())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let data = std::env::temp_dir().join("blindbook-devserver");
    let _ = std::fs::remove_dir_all(&data);
    let master = master();
    let m = master.public_key();
    let mut signer = Signer::new(master).unwrap();
    signer.add_vouchers(
        (1..100).map(|i| H32(sha256(format!("DEV-{i:04}").as_bytes()))),
        50_000,
    );
    let seal_sk: [u8; 32] = sha256(SEAL_LABEL);
    signer.set_seal_key(seal_sk, true);
    let signer = Arc::new(Mutex::new(signer));

    // A deposit account from a public test seed, for top-up addresses.
    let usk = zcash_keys::keys::UnifiedSpendingKey::from_seed(
        &Net::Test,
        &sha256(b"blindbook/devserver/deposit"),
        zip32::AccountId::ZERO,
    )
    .unwrap();
    let uivk = usk
        .to_unified_full_viewing_key()
        .to_unified_incoming_viewing_key()
        .encode(&Net::Test);
    let keys = Arc::new(DepositKeys::from_uivk(Net::Test, &uivk).unwrap());
    let book = TopupBook::open(
        &data.join("topups.json"),
        ZeroConfCaps {
            per_topup: 10_000,
            total: 30_000,
        },
    )
    .unwrap();
    let desk = Desk {
        keys,
        book: Arc::new(Mutex::new(book)),
        denominations: DENOMINATIONS_TESTNET.to_vec(),
    };

    let markets = fakes();
    let bases: BTreeMap<H32, (f64, f64)> = markets
        .iter()
        .enumerate()
        .map(|(i, f)| (f.id, (f.mid, i as f64 * 2.1)))
        .collect();
    let refs: RefFn = Arc::new(move |id: &H32| {
        let (base, phase) = bases.get(id).copied().unwrap_or((0.5, 0.0));
        reference(base, phase)
    });
    let catalog: BTreeMap<H32, MarketInfo> = markets
        .iter()
        .map(|f| {
            (
                f.id,
                MarketInfo {
                    gamma_id: "dev".into(),
                    slug: f
                        .question
                        .to_lowercase()
                        .replace(|c: char| !c.is_alphanumeric(), "-"),
                    question: f.question.into(),
                    condition_id: format!("0x{}", f.id),
                    outcomes: f.outcomes.map(String::from),
                    token_ids: ["1".into(), "2".into()],
                    description: f.rules.into(),
                    resolution_source: "none: a synthetic market of the development server".into(),
                    end_ms: Some(now_ms() + 30 * 86_400_000),
                    event_start_ms: f.start_in_ms.map(|d| now_ms() + d),
                    neg_risk: false,
                    accepting_orders: true,
                    closed: false,
                    active: true,
                    order_book: true,
                    tick_ppm: Some(10_000),
                    image: None,
                    event_title: None,
                    group_item_title: None,
                    volume_24h_usd: Some(250_000),
                },
            )
        })
        .collect();

    let running = start(
        StartConfig {
            data_dir: data.clone(),
            m,
            pow: PowBits {
                light: 8,
                heavy: 10,
            },
            voucher_units: 50_000,
            signer_token: None,
            topup: Some(desk.clone()),
        },
        Some(SignerLink::Embedded(signer.clone())),
        refs,
        catalog.clone(),
    )
    .unwrap();

    for f in &markets {
        let (rtx, rrx) = oneshot::channel();
        let entry = MarketEntry {
            id: f.id,
            params: MarketParams::testnet(),
            event_start_ms: f.start_in_ms.map(|d| now_ms() + d),
            end_ms: now_ms() + 30 * 86_400_000,
            pool: Pool::default(),
            status: MarketStatus::Open,
        };
        running
            .tx
            .send(Cmd::Op(
                Op::ListMarket {
                    entry,
                    keysets: outcome_ids(&m, f.id),
                },
                rtx,
            ))
            .await
            .unwrap();
        rrx.await.unwrap().unwrap();
    }
    let tx = running.tx.clone();
    let shared = running.shared.clone();
    let reserve_signer = signer.clone();
    tokio::spawn(async move {
        let block_ms = std::env::args()
            .skip_while(|a| a != "--block-ms")
            .nth(1)
            .and_then(|v| v.parse().ok())
            .unwrap_or(15_000u64);
        let mut tick = tokio::time::interval(Duration::from_millis(block_ms.max(50)));
        tick.tick().await;
        loop {
            tick.tick().await;
            let h = shared.head.read().unwrap().height.max(4_480_000);
            let _ = tx
                .send(Cmd::Close {
                    height: h + 1,
                    chain: ChainStats {
                        shielded_actions: (h % 13) * 2,
                    },
                })
                .await;
            // A fixed development reserve, so the solvency check has something to compare.
            if h.is_multiple_of(4) {
                let event = LogEvent::ReserveReported {
                    height: h + 1,
                    reserve_zat: DEV_RESERVE_ZAT,
                    unswept_zat: 0,
                };
                reserve_signer.lock().unwrap().report_event(event.clone());
                let _ = tx.send(Cmd::Event(event)).await;
            }
        }
    });

    let dev = Dev {
        signer,
        desk,
        tx: running.tx.clone(),
    };
    let router = running.router.merge(
        Router::new()
            .route("/dev/pay/{id}", post(pay))
            .route("/dev/payout", post(payout))
            .with_state(dev),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8090")
        .await
        .unwrap();
    println!("devserver on http://127.0.0.1:8090");
    println!("M = {}", m.to_hex());
    println!(
        "seal public key = {}",
        blindbook_ledger::hex::encode(&blindbook_seal::public_key(&seal_sk))
    );
    println!("vouchers DEV-0001 … DEV-0099 (0.5 TAZ each)");
    axum::serve(listener, router).await.unwrap();
}
