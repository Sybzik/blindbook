//! `blindbook-verify`: audit the public log.
//!
//! ```text
//! blindbook-verify <M hex> <API base URL | directory with head.json and delta/>
//! ```
//! Exits with status 1 if anything fails.

use std::io::Read;

use blindbook_ledger::delta::{Delta, Head};
use blindbook_mint::cashu::PublicKey;
use blindbook_verify::audit;

fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

async fn fetch(source: &str, path: &str) -> Result<Vec<u8>, String> {
    if source.starts_with("http://") || source.starts_with("https://") {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let c = reqwest::Client::builder()
            .user_agent("blindbook-verify")
            .build()
            .map_err(|e| e.to_string())?;
        let r = c
            .get(format!("{}/v1/{path}", source.trim_end_matches('/')))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("{path}: HTTP {}", r.status()));
        }
        Ok(r.bytes().await.map_err(|e| e.to_string())?.to_vec())
    } else {
        std::fs::read(std::path::Path::new(source).join(path)).map_err(|e| format!("{path}: {e}"))
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        eprintln!("usage: blindbook-verify <M hex> <API base URL | public/v1 directory>");
        std::process::exit(2);
    }
    let m = PublicKey::from_hex(args[0].trim()).unwrap_or_else(|_| {
        eprintln!("M must be a compressed point in hex");
        std::process::exit(2)
    });
    let source = &args[1];
    let head: Head = match fetch(source, "head")
        .await
        .or(fetch(source, "head.json").await)
    {
        Ok(b) => {
            let v: serde_json::Value = serde_json::from_slice(&b).unwrap_or_default();
            serde_json::from_value(v).unwrap_or_else(|e| {
                eprintln!("head: {e}");
                std::process::exit(1)
            })
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1)
        }
    };
    let mut deltas = Vec::new();
    for seq in 1..=head.seq {
        let d: Delta = match fetch(source, &format!("delta/{seq}.json.gz"))
            .await
            .and_then(|b| gunzip(&b))
            .and_then(|j| serde_json::from_slice(&j).map_err(|e| e.to_string()))
        {
            Ok(d) => d,
            Err(e) => {
                eprintln!("delta {seq}: {e}");
                std::process::exit(1)
            }
        };
        deltas.push(d);
    }
    let r = audit(&m, &deltas, Some(head));
    println!(
        "deltas {} (head seq {}, height {}, root {})",
        r.deltas, head.seq, head.height, head.root
    );
    println!(
        "markets {}, batches {}, orders {}",
        r.markets, r.batches, r.orders
    );
    println!(
        "signatures checked {} (DLEQ against keys derived from M), slips spent {}",
        r.signatures, r.spent
    );
    println!("payouts {}, anchors {}", r.payouts, r.anchors.len());
    for (txid, root) in &r.anchors {
        println!("  anchor {txid} → root {root}");
    }
    println!("supply per keyset (issued / spent / outstanding units):");
    for (k, (i, s)) in &r.supply {
        println!("  {k:<70} {i:>10} {s:>10} {:>10}", i.saturating_sub(*s));
    }
    if r.ok() {
        println!("OK: everything checks out");
    } else {
        for f in &r.failures {
            println!("FAIL: {f}");
        }
        std::process::exit(1);
    }
}
