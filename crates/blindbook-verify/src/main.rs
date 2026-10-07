//! `blindbook-verify`: audit the public log.
//!
//! ```text
//! blindbook-verify <M hex> <API base URL | directory with head.json and delta/>
//!                  [--chain <lightwalletd URL>] [--reserve <UFVK> --birthday <height>]
//!                  [--net test|main] [--data <dir>]
//! ```
//! With `--chain`, the reserve is also checked on-chain: a view-only wallet of the published
//! reserve viewing key (from `--reserve`, or the API's `/v1/reserve.json`) is synced, and its balance
//! plus the reported unswept top-ups must cover the liabilities. Exits with status 1 if anything
//! fails. Requests honor `HTTPS_PROXY` / `ALL_PROXY`, so `ALL_PROXY=socks5h://127.0.0.1:9050`
//! fetches the log over Tor.

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
    let all: Vec<String> = std::env::args().skip(1).collect();
    let mut args = Vec::new();
    let mut opts = std::collections::BTreeMap::new();
    let mut it = all.into_iter();
    while let Some(a) = it.next() {
        match a.strip_prefix("--") {
            Some(k) => {
                opts.insert(k.to_string(), it.next().unwrap_or_default());
            }
            None => args.push(a),
        }
    }
    if args.len() != 2 {
        eprintln!(
            "usage: blindbook-verify <M hex> <API base URL | public/v1 directory> [--chain <lightwalletd URL>] [--reserve <UFVK> --birthday <height>] [--net test|main] [--data <dir>]"
        );
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
    let mut r = audit(&m, &deltas, Some(head));
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
    let zec = |z: u64| format!("{}.{:08}", z / 100_000_000, z % 100_000_000);
    println!("liabilities now: {} ZEC", zec(r.liabilities_zat));
    match r.reserve {
        Some((h, reserve, unswept, owed)) => println!(
            "reserve reported at height {h}: {} ZEC + {} unswept, liabilities then {} ZEC (add --chain to check the reserve on-chain)",
            zec(reserve),
            zec(unswept),
            zec(owed)
        ),
        None => println!("no reserve report yet"),
    }
    if let Some(lwd) = opts.get("chain") {
        match chain::check(source, lwd, &opts, &r).await {
            Ok(lines) => lines.iter().for_each(|l| println!("{l}")),
            Err(e) => r.failures.push(format!("on-chain reserve check: {e}")),
        }
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

#[cfg(feature = "chain")]
mod chain {
    use std::collections::BTreeMap;

    use blindbook_indexer::Net;
    use blindbook_treasury::ReserveWatch;
    use blindbook_verify::Report;

    #[derive(serde::Deserialize)]
    struct Published {
        ufvk: String,
        birthday: u64,
        network: String,
    }

    /// Sync a view-only wallet of the reserve and compare it with the liabilities.
    pub async fn check(
        source: &str,
        lwd: &str,
        opts: &BTreeMap<String, String>,
        r: &Report,
    ) -> Result<Vec<String>, String> {
        let p = match (opts.get("reserve"), opts.get("birthday")) {
            (Some(u), Some(b)) => Published {
                ufvk: u.clone(),
                birthday: b.parse().map_err(|_| "--birthday must be a height")?,
                network: opts.get("net").cloned().unwrap_or_else(|| "test".into()),
            },
            _ => {
                let b = super::fetch(source, "reserve.json").await?;
                serde_json::from_slice(&b).map_err(|e| format!("/v1/reserve.json: {e}"))?
            }
        };
        let net = Net::parse(opts.get("net").unwrap_or(&p.network))?;
        let dir = opts
            .get("data")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                let tag = blindbook_mint::sha256(p.ufvk.as_bytes());
                std::env::temp_dir().join(format!(
                    "blindbook-verify-{}",
                    blindbook_ledger::hex::encode(&tag[..8])
                ))
            });
        let mut client = blindbook_indexer::follow::connect(lwd)
            .await
            .map_err(|e| e.to_string())?;
        let mut w = ReserveWatch::open(&dir, net, &p.ufvk, p.birthday, &mut client)
            .await
            .map_err(|e| e.to_string())?;
        w.sync(&mut client).await.map_err(|e| e.to_string())?;
        let (onchain, tip) = w.balance().map_err(|e| e.to_string())?;
        let zec = |z: u64| format!("{}.{:08}", z / 100_000_000, z % 100_000_000);
        let unswept = r.reserve.map_or(0, |(_, _, u, _)| u);
        let mut out = vec![format!(
            "reserve on-chain at height {tip}: {} ZEC (view-only wallet of the published key, synced here)",
            zec(onchain)
        )];
        if let Some((h, reported, _, _)) = r.reserve {
            out.push(format!(
                "  last report (height {h}): {} ZEC; difference {} ZEC",
                zec(reported),
                if onchain >= reported {
                    format!("+{}", zec(onchain - reported))
                } else {
                    format!("-{}", zec(reported - onchain))
                }
            ));
        }
        if onchain + unswept < r.liabilities_zat {
            return Err(format!(
                "on-chain reserve {} + {} unswept is below the liabilities of {} ZEC",
                zec(onchain),
                zec(unswept),
                zec(r.liabilities_zat)
            ));
        }
        out.push(format!(
            "SOLVENT on-chain: {} + {} unswept covers {} ZEC of liabilities",
            zec(onchain),
            zec(unswept),
            zec(r.liabilities_zat)
        ));
        Ok(out)
    }
}

#[cfg(not(feature = "chain"))]
mod chain {
    pub async fn check(
        _: &str,
        _: &str,
        _: &std::collections::BTreeMap<String, String>,
        _: &blindbook_verify::Report,
    ) -> Result<Vec<String>, String> {
        Err("built without the `chain` feature".into())
    }
}
