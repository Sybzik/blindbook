//! The API over real HTTP with the signer in-process and a wallet that only knows `M`:
//! voucher → bet → swap → block close → the public log checks out → restart from the journal.
#![cfg(feature = "embedded-signer")]

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::sync::{Arc, Mutex};

use blindbook_api::link::SignerLink;
use blindbook_api::routes::PowBits;
use blindbook_api::sequencer::{Cmd, RefFn};
use blindbook_api::{StartConfig, outcome_ids, pow, start};
use blindbook_ledger::H32;
use blindbook_ledger::delta::{ChainStats, Delta, GENESIS_ROOT, Head, verify_chain};
use blindbook_ledger::ledger::{MarketEntry, MarketInputs, MarketParams, MarketStatus, Pool};
use blindbook_ledger::ops::Op;
use blindbook_ledger::reference::RefSnapshot;
use blindbook_mint::cashu::dhke::{blind_message, unblind_message};
use blindbook_mint::cashu::{Amount, PublicKey, SecretKey};
use blindbook_mint::{KeysetKind, MasterKey, PublicKeyset, sha256};
use blindbook_signer::Signer;
use serde_json::{Value, json};
use tokio::sync::oneshot;

const MARKET: H32 = H32([0x5a; 32]);
const BITS: PowBits = PowBits { light: 6, heavy: 8 };

fn master() -> MasterKey {
    MasterKey::from_secret(SecretKey::from_slice(&sha256(b"blindbook/test-api")).unwrap())
}

fn refs() -> RefFn {
    Arc::new(|_m: &H32| MarketInputs {
        reference: RefSnapshot {
            at_ms: 0,
            mid_samples: vec![400_000; 30],
            mid_ppm: 400_000,
            ask_ppm: [405_000, 605_000],
            bid_ppm: [395_000, 595_000],
            guard_micro: 500_000_000,
            best_bid_ppm: [395_000, 595_000],
            best_ask_ppm: [405_000, 605_000],
            server_ts_ms: [0; 2],
            unhealthy_ms: 0,
        },
        closed: false,
        accepting_orders: true,
    })
}

struct Wallet {
    keys: HashMap<String, PublicKeyset>,
    /// B_ hex → (secret, r)
    pending: HashMap<String, (String, SecretKey)>,
    slips: Vec<Value>,
    n: u64,
}

impl Wallet {
    fn new(m: &PublicKey) -> Self {
        let mut keys = HashMap::new();
        for kind in [
            KeysetKind::Credit,
            KeysetKind::Outcome {
                market_id: MARKET.0,
                outcome: 0,
            },
            KeysetKind::Outcome {
                market_id: MARKET.0,
                outcome: 1,
            },
        ] {
            let ks = PublicKeyset::derive(m, kind).unwrap();
            keys.insert(ks.id.to_string(), ks);
        }
        Wallet {
            keys,
            pending: HashMap::new(),
            slips: Vec::new(),
            n: 0,
        }
    }

    fn id(&self, kind: KeysetKind) -> String {
        self.keys
            .iter()
            .find(|(_, k)| k.kind == kind)
            .unwrap()
            .0
            .clone()
    }

    fn blank(&mut self, kind: KeysetKind) -> Vec<Value> {
        let id = self.id(kind);
        (0..31)
            .map(|_| {
                self.n += 1;
                let secret = format!("{:064x}", u128::from(self.n) * 0x2545_f491_4f6c_dd1d);
                let (b, r) = blind_message(secret.as_bytes(), None).unwrap();
                self.pending.insert(b.to_hex(), (secret, r));
                json!({ "amount": 0, "id": id, "B_": b.to_hex() })
            })
            .collect()
    }

    /// Unblind `signatures` answering the given output lists.
    fn receive(&mut self, resp: &Value, outputs: &[Value], change: &[Value]) {
        for s in resp["signatures"].as_array().unwrap() {
            let list = if s["list"] == "outputs" {
                outputs
            } else {
                change
            };
            let b_hex = list[s["index"].as_u64().unwrap() as usize]["B_"]
                .as_str()
                .unwrap();
            let (secret, r) = self.pending.remove(b_hex).unwrap();
            let id = s["id"].as_str().unwrap();
            let amount = s["amount"].as_u64().unwrap();
            let k = self.keys[id].keys.amount_key(Amount::from(amount)).unwrap();
            let c_ = PublicKey::from_hex(s["C_"].as_str().unwrap()).unwrap();
            let c = unblind_message(&c_, &r, &k).unwrap();
            self.slips
                .push(json!({ "amount": amount, "id": id, "secret": secret, "C": c.to_hex() }));
        }
    }

    fn take(&mut self, kind: KeysetKind) -> Vec<Value> {
        let id = self.id(kind);
        let (take, keep): (Vec<_>, Vec<_>) =
            self.slips.drain(..).partition(|s| s["id"] == id.as_str());
        self.slips = keep;
        take
    }

    fn balance(&self, kind: KeysetKind) -> u64 {
        let id = self.id(kind);
        self.slips
            .iter()
            .filter(|s| s["id"] == id.as_str())
            .map(|s| s["amount"].as_u64().unwrap())
            .sum()
    }
}

fn with_pow(mut body: Value, bits: u32) -> Value {
    let nonce = pow::solve(&body, bits);
    body["pow"] = json!({ "nonce": nonce });
    body
}

async fn post(c: &reqwest::Client, base: &str, path: &str, body: Value) -> (u16, Value, String) {
    let r = c
        .post(format!("{base}{path}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = r.status().as_u16();
    let conn = r
        .headers()
        .get("connection")
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default();
    (status, r.json().await.unwrap_or(Value::Null), conn)
}

async fn serve(
    data: &std::path::Path,
    signer: Arc<Mutex<Signer>>,
    m: PublicKey,
) -> (String, tokio::sync::mpsc::Sender<Cmd>) {
    let running = start(
        StartConfig {
            data_dir: data.to_owned(),
            m,
            pow: BITS,
            voucher_units: 50_000,
            signer_token: None,
            topup: None,
        },
        Some(SignerLink::Embedded(signer)),
        refs(),
        BTreeMap::new(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, running.router).await.unwrap() });
    (format!("http://{addr}"), running.tx)
}

async fn gunzip_get(c: &reqwest::Client, url: &str) -> Vec<u8> {
    let bytes = c.get(url).send().await.unwrap().bytes().await.unwrap();
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(&bytes[..])
        .read_to_end(&mut out)
        .unwrap();
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn http_end_to_end_and_restart() {
    let data = std::env::temp_dir().join(format!("bb-api-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let mut signer = Signer::new(master()).unwrap();
    let m = signer.public_key();
    signer.add_vouchers([H32(sha256(b"JUDGE-0001"))], 50_000);
    let signer = Arc::new(Mutex::new(signer));
    let (base, tx) = serve(&data, signer.clone(), m).await;
    blindbook_polymarket::net::install_crypto_provider();
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut w = Wallet::new(&m);
    let credit = KeysetKind::Credit;
    let a = KeysetKind::Outcome {
        market_id: MARKET.0,
        outcome: 0,
    };

    // The operator lists a market.
    let (rtx, rrx) = oneshot::channel();
    tx.send(Cmd::Op(
        Op::ListMarket {
            entry: MarketEntry {
                id: MARKET,
                params: MarketParams::testnet(),
                event_start_ms: None,
                end_ms: u64::MAX,
                pool: Pool::default(),
                status: MarketStatus::Open,
            },
            keysets: outcome_ids(&m, MARKET),
        },
        rtx,
    ))
    .await
    .unwrap();
    rrx.await.unwrap().unwrap();

    // Voucher: no work → refused; with work → 50,000 units of CREDIT.
    let outs = w.blank(credit);
    let (status, _, conn) = post(
        &c,
        &base,
        "/v1/voucher",
        json!({ "code": "judge-0001", "outputs": outs }),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(conn, "close");
    let (status, resp, _) = post(
        &c,
        &base,
        "/v1/voucher",
        with_pow(json!({ "code": "judge-0001", "outputs": outs }), BITS.heavy),
    )
    .await;
    assert_eq!(status, 200, "{resp}");
    w.receive(&resp, &outs, &[]);
    assert_eq!(w.balance(credit), 50_000);
    let (status, resp, _) = post(
        &c,
        &base,
        "/v1/voucher",
        with_pow(
            json!({ "code": "JUDGE-0001", "outputs": w.blank(credit) }),
            BITS.heavy,
        ),
    )
    .await;
    assert_eq!(
        (status, resp["error"].as_str()),
        (422, Some("invalid_claim"))
    );

    // Bet 0.02 TAZ on A, paying with every slip: the rest comes back as change.
    let inputs = w.take(credit);
    let (outputs, change) = (w.blank(a), w.blank(credit));
    let tag = H32(sha256(b"called it #1"));
    let body = json!({
        "market": MARKET, "side": "buy", "outcome": 0, "limit_bp": 9000, "amount": 2000,
        "inputs": inputs, "outputs": outputs, "change_outputs": change, "tag": tag,
    });
    let started = std::time::Instant::now();
    let (status, resp, conn) =
        post(&c, &base, "/v1/trade", with_pow(body.clone(), BITS.light)).await;
    assert_eq!(status, 200, "{resp}");
    assert_eq!(conn, "close");
    assert!(
        started.elapsed().as_secs_f64() < 3.0,
        "cleared within one batch"
    );
    assert_eq!(resp["fill"]["status"], "filled");
    assert_eq!(resp["stored_record"]["tag"], json!(tag));
    w.receive(&resp, &outputs, &change);
    let shares = resp["fill"]["out"].as_u64().unwrap();
    assert_eq!(w.balance(a), shares);
    assert_eq!(
        w.balance(credit),
        48_000 + resp["fill"]["refund"].as_u64().unwrap()
    );

    // The same slips again: spent.
    let (status, resp, _) = post(&c, &base, "/v1/trade", with_pow(body, BITS.light)).await;
    assert_eq!((status, resp["error"].as_str()), (422, Some("spent")));

    // Swap the shares into one slip per bit, the other way round.
    let share_slips = w.take(a);
    let swapped_away = share_slips.clone();
    let mut outs = Vec::new();
    for bit in (0..31).map(|k| 1u64 << k).filter(|bit| shares & bit != 0) {
        let mut blank = w.blank(a).remove(0);
        blank["amount"] = json!(bit);
        outs.push(blank);
    }
    let (status, resp, _) = post(
        &c,
        &base,
        "/v1/swap",
        with_pow(
            json!({ "inputs": share_slips, "outputs": outs }),
            BITS.light,
        ),
    )
    .await;
    assert_eq!(status, 200, "{resp}");
    w.receive(&resp, &outs, &[]);
    assert_eq!(w.balance(a), shares);

    // Live prices moved off Polymarket's 0.40 by our users' A position.
    tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;
    let live: Value = c
        .get(format!("{base}/v1/live"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let mk = &live["markets"][0];
    assert_eq!(mk["state"], "open");
    assert!(mk["price_a_ppm"].as_u64().unwrap() > 400_000, "{mk}");
    assert_eq!(live["recent"][0]["fill"]["tag"], json!(tag));

    // Close a block: the delta is on disk and chains from genesis.
    tx.send(Cmd::Close {
        height: 101,
        chain: ChainStats {
            shielded_actions: 3,
        },
    })
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let head: Value = c
        .get(format!("{base}/v1/head"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(head["seq"], 1);
    let delta: Delta =
        serde_json::from_slice(&gunzip_get(&c, &format!("{base}/v1/delta/1.json.gz")).await)
            .unwrap();
    let start_head = Head {
        height: 0,
        seq: 0,
        root: GENESIS_ROOT,
    };
    let got = verify_chain(start_head, std::slice::from_ref(&delta)).unwrap();
    assert_eq!(serde_json::to_value(got.root).unwrap(), head["root"]);
    assert_eq!(delta.batches.len(), 1);
    assert_eq!(delta.batches[0].orders[0].tag, tag);
    assert!(delta.issued.len() > 10 && delta.spent.len() > 3);
    // The independent audit: chain, replayed batches, pools, DLEQ of every signature, supply.
    let audit = blindbook_verify::audit(&m, std::slice::from_ref(&delta), Some(got));
    assert!(audit.ok(), "{:?}", audit.failures);
    assert_eq!(audit.batches, 1);
    assert_eq!(audit.signatures as usize, delta.issued.len());
    assert_eq!(audit.markets, 1);
    let snap: Value = serde_json::from_slice(
        &gunzip_get(&c, &format!("{base}/v1/snapshot/latest.json.gz")).await,
    )
    .unwrap();
    assert_eq!(snap["issued"].as_array().unwrap().len(), delta.issued.len());
    // No slip secret ever reaches the disk.
    let journal = std::fs::read_to_string(data.join("journal.jsonl")).unwrap();
    for s in &w.slips {
        assert!(!journal.contains(s["secret"].as_str().unwrap()));
    }
    assert!(!journal.contains(&format!("{:064x}", 0x2545_f491_4f6c_dd1du128)));

    // Restart from the journal: same head, same spent set.
    drop(tx);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let (base2, _tx2) = serve(&data, signer.clone(), m).await;
    let head2: Value = c
        .get(format!("{base2}/v1/head"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(head2["root"], head["root"]);
    let spent_again = json!({
        "market": MARKET, "side": "sell", "outcome": 0, "limit_bp": 1, "amount": 1,
        "inputs": swapped_away, "outputs": w.blank(credit), "change_outputs": w.blank(a),
        "tag": H32([1; 32]),
    });
    let (status, resp, _) = post(&c, &base2, "/v1/trade", with_pow(spent_again, BITS.light)).await;
    assert_eq!(
        (status, resp["error"].as_str()),
        (422, Some("spent")),
        "the replayed spent set holds"
    );
    // Fresh slips still trade after the restart.
    let shares_now = w.take(a);
    let total: u64 = shares_now
        .iter()
        .map(|s| s["amount"].as_u64().unwrap())
        .sum();
    let (outputs, change) = (w.blank(credit), w.blank(a));
    let sell = json!({
        "market": MARKET, "side": "sell", "outcome": 0, "limit_bp": 1, "amount": total,
        "inputs": shares_now, "outputs": outputs, "change_outputs": change, "tag": H32([2; 32]),
    });
    let (status, resp, _) = post(&c, &base2, "/v1/trade", with_pow(sell, BITS.light)).await;
    assert_eq!(status, 200, "{resp}");
    w.receive(&resp, &outputs, &change);
    let _ = std::fs::remove_dir_all(&data);
}
