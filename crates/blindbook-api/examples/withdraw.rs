//! Voucher → withdraw to a sealed address, against a running API and signer.
//!
//! ```text
//! BB_API=http://127.0.0.1:8080 BB_M=<M hex> BB_SEAL_PK=<hex> \
//!   cargo run -p blindbook-api --example withdraw -- <voucher code> <address> <amount units>
//! ```

use std::collections::HashMap;

use blindbook_api::pow;
use blindbook_ledger::H32;
use blindbook_mint::cashu::dhke::{blind_message, unblind_message};
use blindbook_mint::cashu::{Amount, PublicKey, SecretKey};
use blindbook_mint::{KeysetKind, PublicKeyset};
use serde_json::{Value, json};

#[tokio::main]
async fn main() {
    blindbook_polymarket::net::install_crypto_provider();
    let base = std::env::var("BB_API").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let m = PublicKey::from_hex(std::env::var("BB_M").expect("BB_M").trim()).unwrap();
    let pk_hex = std::env::var("BB_SEAL_PK").expect("BB_SEAL_PK");
    let seal_pk: [u8; 32] = (0..32)
        .map(|i| u8::from_str_radix(&pk_hex[2 * i..2 * i + 2], 16).unwrap())
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (code, address, amount): (&str, &str, u64) = (&a[0], &a[1], a[2].parse().unwrap());
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
    let blank = |pending: &mut HashMap<String, (String, SecretKey)>| -> Vec<Value> {
        (0..31)
            .map(|_| {
                let secret = SecretKey::generate().to_secret_hex();
                let (b, r) = blind_message(secret.as_bytes(), None).unwrap();
                pending.insert(b.to_hex(), (secret, r));
                json!({ "amount": 0, "id": id, "B_": b.to_hex() })
            })
            .collect()
    };
    let post = |path: &str, mut body: Value| {
        let c = c.clone();
        let url = format!("{base}{path}");
        async move {
            body["pow"] = json!({ "nonce": pow::solve(&body, heavy) });
            let r = c.post(url).json(&body).send().await.unwrap();
            (
                r.status().as_u16(),
                r.json::<Value>().await.unwrap_or(Value::Null),
            )
        }
    };
    let outputs = blank(&mut pending);
    let (st, resp) = post("/v1/voucher", json!({ "code": code, "outputs": outputs })).await;
    println!(
        "voucher: {st} {}",
        resp.get("error").unwrap_or(&Value::Null)
    );
    let mut slips = Vec::new();
    for s in resp["signatures"].as_array().into_iter().flatten() {
        let b = outputs[s["index"].as_u64().unwrap() as usize]["B_"]
            .as_str()
            .unwrap();
        let (secret, r) = pending.remove(b).unwrap();
        let amt = s["amount"].as_u64().unwrap();
        let k = credit.keys.amount_key(Amount::from(amt)).unwrap();
        let cc = unblind_message(
            &PublicKey::from_hex(s["C_"].as_str().unwrap()).unwrap(),
            &r,
            &k,
        )
        .unwrap();
        slips.push(json!({ "amount": amt, "id": id, "secret": secret, "C": cc.to_hex() }));
    }
    let (sealed, commitment) = blindbook_seal::seal(&seal_pk, address);
    let change = blank(&mut pending);
    let (st, resp) = post(
        "/v1/withdraw",
        json!({
            "inputs": slips, "amount": amount, "change_outputs": change,
            "address_sealed": sealed, "address_commitment": H32(commitment),
        }),
    )
    .await;
    println!(
        "withdraw: {st} {} commitment {}",
        resp.get("error").unwrap_or(&json!("ok")),
        H32(commitment)
    );
}
