//! The production link: a real signer process-in-a-task dials `/v1/signer` over WebSocket with
//! its token; a signer with the wrong token, or a different operation count, is turned away.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use blindbook_api::routes::PowBits;
use blindbook_api::sequencer::RefFn;
use blindbook_api::{StartConfig, pow, start};
use blindbook_ledger::H32;
use blindbook_ledger::ledger::MarketInputs;
use blindbook_ledger::reference::RefSnapshot;
use blindbook_mint::cashu::SecretKey;
use blindbook_mint::cashu::dhke::blind_message;
use blindbook_mint::{MasterKey, sha256};
use blindbook_signer::Signer;
use blindbook_signer::link::{Station, run};
use serde_json::{Value, json};

const TOKEN: &str = "0123456789abcdef0123456789abcdef-test-token";

fn master() -> MasterKey {
    MasterKey::from_secret(SecretKey::from_slice(&sha256(b"blindbook/test-remote")).unwrap())
}

fn station(dir: &std::path::Path) -> Station {
    std::fs::create_dir_all(dir).unwrap();
    let mut s = Signer::new(master()).unwrap();
    s.add_vouchers([H32(sha256(b"JUDGE-REMOTE"))], 4_096);
    Station::open(s, &dir.join("signer-journal.jsonl")).unwrap()
}

async fn voucher(c: &reqwest::Client, base: &str, credit_id: &str, code: &str) -> (u16, Value) {
    let outputs: Vec<Value> = (0..31u8)
        .map(|i| {
            let b = blind_message(&[i, code.len() as u8], None)
                .unwrap()
                .0
                .to_hex();
            json!({ "amount": 0, "id": credit_id, "B_": b })
        })
        .collect();
    let mut body = json!({ "code": code, "outputs": outputs });
    body["pow"] = json!({ "nonce": pow::solve(&body, 4) });
    let r = c
        .post(format!("{base}/v1/voucher"))
        .json(&body)
        .send()
        .await
        .unwrap();
    (r.status().as_u16(), r.json().await.unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn signer_over_websocket() {
    blindbook_polymarket::net::install_crypto_provider();
    let dir = std::env::temp_dir().join(format!("bb-remote-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let m = master().public_key();
    let refs: RefFn = Arc::new(|_: &H32| MarketInputs {
        reference: RefSnapshot::empty(0),
        closed: false,
        accepting_orders: false,
    });
    let running = start(
        StartConfig {
            data_dir: dir.join("api"),
            m,
            pow: PowBits { light: 4, heavy: 4 },
            voucher_units: 4_096,
            signer_token: Some(TOKEN.into()),
            topup: None,
        },
        None,
        refs,
        BTreeMap::new(),
    )
    .unwrap();
    let credit_id = running.shared.credit_id.clone();
    let remote = running.remote.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, running.router).await.unwrap() });
    let base = format!("http://{addr}");
    let url = format!("ws://{addr}/v1/signer");
    let c = reqwest::Client::builder().no_proxy().build().unwrap();

    // No signer yet: writes are unavailable.
    let (status, _) = voucher(&c, &base, &credit_id, "JUDGE-REMOTE").await;
    assert_eq!(status, 503);

    // A signer with the wrong token never gets in.
    let bad = tokio::spawn(run(
        url.clone(),
        "wrong".into(),
        Arc::new(Mutex::new(station(&dir.join("bad")))),
    ));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!remote.connected().await);
    bad.abort();

    // The real one connects and signs.
    std::fs::create_dir_all(dir.join("good")).unwrap();
    let good = tokio::spawn(run(
        url.clone(),
        TOKEN.into(),
        Arc::new(Mutex::new(station(&dir.join("good")))),
    ));
    for _ in 0..50 {
        if remote.connected().await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(remote.connected().await);
    let (status, resp) = voucher(&c, &base, &credit_id, "JUDGE-REMOTE").await;
    assert_eq!(status, 200, "{resp}");
    assert_eq!(
        resp["signatures"].as_array().unwrap().len(),
        1,
        "4,096 is one slip"
    );
    let (status, resp) = voucher(&c, &base, &credit_id, "JUDGE-REMOTE").await;
    assert_eq!(
        (status, resp["error"].as_str()),
        (422, Some("invalid_claim"))
    );
    good.abort();

    // A signer whose journal disagrees with ours (it never applied the voucher) is refused.
    tokio::time::sleep(Duration::from_millis(300)).await;
    std::fs::create_dir_all(dir.join("fresh")).unwrap();
    let fresh = tokio::spawn(run(
        url,
        TOKEN.into(),
        Arc::new(Mutex::new(station(&dir.join("fresh")))),
    ));
    tokio::time::sleep(Duration::from_millis(800)).await;
    let (status, _) = voucher(&c, &base, &credit_id, "JUDGE-OTHER").await;
    assert_eq!(status, 503, "a signer out of step is never used");
    fresh.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

/// The signer applies an operation and the link drops before its answer arrives: the API keeps
/// the operation in doubt, lets the signer back in one operation ahead, re-sends it first, and
/// gets the cached answer, so both sides apply it exactly once.
#[tokio::test(flavor = "multi_thread")]
async fn lost_answer_is_recovered_exactly_once() {
    use blindbook_ledger::ops::{FromSigner, ToSigner};
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    blindbook_polymarket::net::install_crypto_provider();
    let dir = std::env::temp_dir().join(format!("bb-doubt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let m = master().public_key();
    let refs: RefFn = Arc::new(|_: &H32| MarketInputs {
        reference: RefSnapshot::empty(0),
        closed: false,
        accepting_orders: false,
    });
    let running = start(
        StartConfig {
            data_dir: dir.join("api"),
            m,
            pow: PowBits { light: 4, heavy: 4 },
            voucher_units: 4_096,
            signer_token: Some(TOKEN.into()),
            topup: None,
        },
        None,
        refs,
        BTreeMap::new(),
    )
    .unwrap();
    let credit_id = running.shared.credit_id.clone();
    let shared = running.shared.clone();
    let remote = running.remote.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, running.router).await.unwrap() });
    let base = format!("http://{addr}");
    let url = format!("ws://{addr}/v1/signer");
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let st = Arc::new(Mutex::new(station(&dir.join("signer"))));
    {
        let mut s = st.lock().unwrap();
        s.signer.add_vouchers([H32(sha256(b"JUDGE-TWO"))], 4_096);
    }

    // A flaky signer: applies the first operation, then drops the link without answering.
    let flaky = {
        let st = st.clone();
        let url = url.clone();
        tokio::spawn(async move {
            let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
            let mut req = url.into_client_request().unwrap();
            req.headers_mut()
                .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
            let (mut ws, _) = tokio_tungstenite::client_async(req, tcp).await.unwrap();
            let hello = st.lock().unwrap().hello();
            ws.send(Message::Text(
                serde_json::to_string(&FromSigner::Hello { hello })
                    .unwrap()
                    .into(),
            ))
            .await
            .unwrap();
            while let Some(Ok(msg)) = ws.next().await {
                if let Message::Text(t) = msg {
                    let ToSigner { op, .. } = serde_json::from_str(&t).unwrap();
                    st.lock().unwrap().serve(&op).unwrap();
                    return; // the answer is lost
                }
            }
        })
    };
    for _ in 0..50 {
        if remote.connected().await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (status, _) = voucher(&c, &base, &credit_id, "JUDGE-REMOTE").await;
    assert_eq!(status, 503, "the answer never came");
    flaky.await.unwrap();
    assert!(shared.in_doubt.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(st.lock().unwrap().applied, 1);

    // The same signer comes back one operation ahead: admitted, because one is in doubt.
    let good = tokio::spawn(run(url, TOKEN.into(), st.clone()));
    for _ in 0..50 {
        if remote.connected().await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // The next request first settles the doubt, then runs.
    let (status, resp) = voucher(&c, &base, &credit_id, "JUDGE-TWO").await;
    assert_eq!(status, 200, "{resp}");
    assert!(!shared.in_doubt.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(st.lock().unwrap().applied, 2);
    assert_eq!(
        shared.applied_ops.load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    // Both vouchers counted once each, on both sides.
    let s = st.lock().unwrap();
    assert_eq!(
        s.signer
            .ledger
            .outstanding(blindbook_ledger::keysets::Keyset::Credit),
        8_192
    );
    drop(s);
    good.abort();
    let _ = std::fs::remove_dir_all(&dir);
}
