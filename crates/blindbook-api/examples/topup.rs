//! Top-up against a running API: ask for a one-time address, wait for the payment, unblind the
//! CREDIT slips.
//!
//! ```text
//! BB_API=http://127.0.0.1:8080 BB_M=<M hex> cargo run -p blindbook-api --example topup -- <amount_zat> [wait seconds]
//! ```
//! Prints the address; pay it from any wallet, then watch the status change.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use blindbook_api::pow;
use blindbook_ledger::H32;
use blindbook_mint::cashu::dhke::{blind_message, unblind_message};
use blindbook_mint::cashu::{Amount, PublicKey, SecretKey};
use blindbook_mint::{KeysetKind, PublicKeyset, sha256};
use serde_json::{Value, json};

#[tokio::main]
async fn main() {
    blindbook_polymarket::net::install_crypto_provider();
    let base = std::env::var("BB_API").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let m = PublicKey::from_hex(std::env::var("BB_M").expect("BB_M").trim()).unwrap();
    let mut args = std::env::args().skip(1);
    let amount_zat: u64 = args.next().expect("amount_zat").parse().unwrap();
    let wait: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(600);
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let head: Value = c
        .get(format!("{base}/v1/head"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let heavy = head["pow_bits"]["heavy"].as_u64().unwrap() as u32;

    let credit = PublicKeyset::derive(&m, KeysetKind::Credit).unwrap();
    let id = credit.id.to_string();
    let mut pending: HashMap<String, (String, SecretKey)> = HashMap::new();
    let outputs: Vec<Value> = (0..31)
        .map(|_| {
            let secret = SecretKey::generate().to_secret_hex();
            let (b, r) = blind_message(secret.as_bytes(), None).unwrap();
            pending.insert(b.to_hex(), (secret, r));
            json!({ "amount": 0, "id": id, "B_": b.to_hex() })
        })
        .collect();
    let topup_secret = SecretKey::generate().to_secret_hex();
    let mut body = json!({
        "amount_zat": amount_zat,
        "credit_outputs": outputs,
        "claim_hash": H32(sha256(topup_secret.as_bytes())),
    });
    body["pow"] = json!({ "nonce": pow::solve(&body, heavy) });
    let r: Value = c
        .post(format!("{base}/v1/topup"))
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let topup_id = r["topup_id"].as_str().expect("topup_id").to_owned();
    println!(
        "pay {} zat to\n{}\n(expires at height {})",
        amount_zat,
        r["address"].as_str().unwrap(),
        r["expires_height"]
    );

    let t0 = Instant::now();
    let mut last = String::new();
    while t0.elapsed() < Duration::from_secs(wait) {
        let s: Value = c
            .get(format!("{base}/v1/topup/{topup_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let status = s["status"].as_str().unwrap_or("?").to_owned();
        if status != last {
            println!(
                "{:>6.1}s {status} privacy {} paid {}",
                t0.elapsed().as_secs_f64(),
                s["privacy"],
                s["paid_zat"]
            );
            last = status.clone();
        }
        if status == "credited" || status == "confirmed" {
            let mut total = 0;
            for sig in s["signatures"].as_array().unwrap() {
                let list = &outputs;
                let b = list[sig["index"].as_u64().unwrap() as usize]["B_"]
                    .as_str()
                    .unwrap();
                let (_secret, r) = pending.get(b).unwrap();
                let amount = sig["amount"].as_u64().unwrap();
                let k = credit.keys.amount_key(Amount::from(amount)).unwrap();
                unblind_message(
                    &PublicKey::from_hex(sig["C_"].as_str().unwrap()).unwrap(),
                    r,
                    &k,
                )
                .unwrap();
                total += amount;
            }
            println!("CREDIT slips unblinded: {total} units");
            if status == "confirmed" {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
