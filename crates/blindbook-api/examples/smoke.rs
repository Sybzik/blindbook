//! Smoke test against a running API (and its separate signer):
//! voucher → bet on a live Polymarket-anchored market → sell half → check the public log.
//!
//! ```text
//! BB_API=http://127.0.0.1:8080 BB_M=<M hex> cargo run -p blindbook-api --example smoke -- <voucher code>
//! ```

use std::collections::HashMap;
use std::io::Read;
use std::time::{Duration, Instant};

use blindbook_api::pow;
use blindbook_ledger::H32;
use blindbook_ledger::delta::{Delta, GENESIS_ROOT, Head, verify_chain};
use blindbook_mint::cashu::dhke::{blind_message, unblind_message};
use blindbook_mint::cashu::{Amount, PublicKey, SecretKey};
use blindbook_mint::{KeysetKind, PublicKeyset, sha256};
use serde_json::{Value, json};

struct Wallet {
    m: PublicKey,
    keys: HashMap<String, PublicKeyset>,
    pending: HashMap<String, (String, SecretKey)>,
    slips: Vec<Value>,
}

impl Wallet {
    fn id(&mut self, kind: KeysetKind) -> String {
        if let Some((id, _)) = self.keys.iter().find(|(_, k)| k.kind == kind) {
            return id.clone();
        }
        let ks = PublicKeyset::derive(&self.m, kind).unwrap();
        let id = ks.id.to_string();
        self.keys.insert(id.clone(), ks);
        id
    }

    fn blank(&mut self, kind: KeysetKind) -> Vec<Value> {
        let id = self.id(kind);
        (0..31)
            .map(|_| {
                let secret = SecretKey::generate().to_secret_hex();
                let (b, r) = blind_message(secret.as_bytes(), None).unwrap();
                self.pending.insert(b.to_hex(), (secret, r));
                json!({ "amount": 0, "id": id, "B_": b.to_hex() })
            })
            .collect()
    }

    fn receive(&mut self, resp: &Value, outputs: &[Value], change: &[Value]) {
        for s in resp["signatures"].as_array().into_iter().flatten() {
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
            let c = unblind_message(
                &PublicKey::from_hex(s["C_"].as_str().unwrap()).unwrap(),
                &r,
                &k,
            )
            .unwrap();
            self.slips
                .push(json!({ "amount": amount, "id": id, "secret": secret, "C": c.to_hex() }));
        }
    }

    fn take(&mut self, kind: KeysetKind) -> Vec<Value> {
        let id = self.id(kind);
        let (t, k): (Vec<_>, Vec<_>) = self.slips.drain(..).partition(|s| s["id"] == id.as_str());
        self.slips = k;
        t
    }
}

fn sum(slips: &[Value]) -> u64 {
    slips.iter().map(|s| s["amount"].as_u64().unwrap()).sum()
}

#[tokio::main]
async fn main() {
    blindbook_polymarket::net::install_crypto_provider();
    let base = std::env::var("BB_API").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let m = PublicKey::from_hex(std::env::var("BB_M").expect("BB_M").trim()).unwrap();
    let code = std::env::args().nth(1).expect("voucher code");
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let get = |p: &str| {
        let c = c.clone();
        let u = format!("{base}{p}");
        async move {
            c.get(u)
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        }
    };
    let head = get("/v1/head").await;
    let (light, heavy) = (
        head["pow_bits"]["light"].as_u64().unwrap() as u32,
        head["pow_bits"]["heavy"].as_u64().unwrap() as u32,
    );
    println!("head: {head}");
    let post = |p: &str, mut body: Value, bits: u32| {
        let c = c.clone();
        let u = format!("{base}{p}");
        async move {
            let t = Instant::now();
            body["pow"] = json!({ "nonce": pow::solve(&body, bits) });
            let pow_ms = t.elapsed().as_millis();
            let r = c.post(u).json(&body).send().await.unwrap();
            let status = r.status().as_u16();
            let v: Value = r.json().await.unwrap_or(Value::Null);
            (status, v, pow_ms, t.elapsed().as_millis())
        }
    };
    let mut w = Wallet {
        m,
        keys: HashMap::new(),
        pending: HashMap::new(),
        slips: Vec::new(),
    };

    let outs = w.blank(KeysetKind::Credit);
    let (st, resp, pow_ms, ms) = post(
        "/v1/voucher",
        json!({ "code": code, "outputs": outs }),
        heavy,
    )
    .await;
    println!(
        "voucher: {st} in {ms} ms (pow {pow_ms} ms) {}",
        resp.get("error").unwrap_or(&Value::Null)
    );
    w.receive(&resp, &outs, &[]);
    println!("CREDIT: {} units", sum(&w.slips));

    // Wait for live prices with a healthy reference.
    let mut market = None;
    for _ in 0..40 {
        let live = get("/v1/live").await;
        market = live["markets"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m["state"] == "open" && m["price_a_ppm"].is_u64())
            .cloned();
        if market.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let market = market.expect("an open market with a live reference");
    let id = H32::parse(market["id"].as_str().unwrap()).unwrap();
    println!(
        "market {id}: our A {} ppm, reference mid {} ask {:?} bid {:?}",
        market["price_a_ppm"],
        market["reference"]["mid_ppm"],
        market["reference"]["ask_ppm"],
        market["reference"]["bid_ppm"]
    );
    let a = KeysetKind::Outcome {
        market_id: id.0,
        outcome: 0,
    };

    let inputs = w.take(KeysetKind::Credit);
    let (outputs, change) = (w.blank(a), w.blank(KeysetKind::Credit));
    let body = json!({ "market": id, "side": "buy", "outcome": 0, "limit_bp": 9900, "amount": 1000,
        "inputs": inputs, "outputs": outputs, "change_outputs": change, "tag": H32(sha256(b"smoke called it")) });
    let (st, resp, pow_ms, ms) = post("/v1/trade", body, light).await;
    println!(
        "buy: {st} in {ms} ms (pow {pow_ms} ms): {}",
        resp.get("fill").unwrap_or(&resp)
    );
    w.receive(&resp, &outputs, &change);

    let shares = w.take(a);
    let half = sum(&shares) / 2;
    let (outputs, change) = (w.blank(KeysetKind::Credit), w.blank(a));
    let body = json!({ "market": id, "side": "sell", "outcome": 0, "limit_bp": 1, "amount": half,
        "inputs": shares, "outputs": outputs, "change_outputs": change, "tag": H32(sha256(b"smoke sell")) });
    let (st, resp, pow_ms, ms) = post("/v1/trade", body, light).await;
    println!(
        "sell half: {st} in {ms} ms (pow {pow_ms} ms): {}",
        resp.get("fill").unwrap_or(&resp)
    );
    w.receive(&resp, &outputs, &change);
    let id_a = w.id(a);
    let id_c = w.id(KeysetKind::Credit);
    println!(
        "wallet: CREDIT {} units, A {} share-units",
        sum(&w
            .slips
            .iter()
            .filter(|s| s["id"] == id_c.as_str())
            .cloned()
            .collect::<Vec<_>>()),
        sum(&w
            .slips
            .iter()
            .filter(|s| s["id"] == id_a.as_str())
            .cloned()
            .collect::<Vec<_>>())
    );

    // The public log: every delta so far chains from genesis.
    let head = get("/v1/head").await;
    let n = head["seq"].as_u64().unwrap();
    let mut deltas = Vec::new();
    for seq in 1..=n {
        let bytes = c
            .get(format!("{base}/v1/delta/{seq}.json.gz"))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let mut json = Vec::new();
        flate2::read::GzDecoder::new(&bytes[..])
            .read_to_end(&mut json)
            .unwrap();
        deltas.push(serde_json::from_slice::<Delta>(&json).unwrap());
    }
    let end = verify_chain(
        Head {
            height: 0,
            seq: 0,
            root: GENESIS_ROOT,
        },
        &deltas,
    )
    .unwrap();
    println!(
        "log: {n} deltas verified, root {} (head says {})",
        end.root, head["root"]
    );
}
