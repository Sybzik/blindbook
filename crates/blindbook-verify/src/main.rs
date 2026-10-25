//! `blindbook-verify`: audit the public log.
//!
//! ```text
//! blindbook-verify <M hex> <API base URL | directory with head.json and delta/>
//!                  [--chain <lightwalletd URL>] [--reserve <UFVK> --birthday <height>]
//!                  [--net test|main] [--data <dir>] [--polygon public | <rpc,rpc>]
//! ```
//! With `--chain`, the reserve is also checked on-chain: a view-only wallet of the published
//! reserve viewing key (from `--reserve`, or the API's `/v1/reserve.json`) is synced, and its balance
//! plus the reported unswept top-ups must cover the liabilities; every anchor transaction is opened
//! with that key and must name the log's root. With `--polygon`, every resolution in the log is
//! read again from Polymarket's ConditionalTokens contract on Polygon (two RPCs that must agree;
//! `public` = the two public ones the server uses). Exits with status 1 if anything
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

/// One client for every request (one TLS session, not one per file).
fn client() -> Result<&'static reqwest::Client, String> {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(c) = C.get() {
        return Ok(c);
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let c = reqwest::Client::builder()
        .user_agent("blindbook-verify")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(C.get_or_init(|| c))
}

/// A public file. A request that fails on the way (not a 404) is tried again, four times in all:
/// a long log is many requests, and one dropped connection shouldn't end the audit.
async fn fetch(source: &str, path: &str) -> Result<Vec<u8>, String> {
    if !(source.starts_with("http://") || source.starts_with("https://")) {
        return std::fs::read(std::path::Path::new(source).join(path))
            .map_err(|e| format!("{path}: {e}"));
    }
    let url = format!("{}/v1/{path}", source.trim_end_matches('/'));
    let mut last = String::new();
    for attempt in 0..4u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500 << attempt)).await;
        }
        match client()?.get(&url).send().await {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) => return Ok(b.to_vec()),
                Err(e) => last = e.to_string(),
            },
            Ok(r) if r.status().is_client_error() => {
                return Err(format!("{path}: HTTP {}", r.status()));
            }
            Ok(r) => last = format!("HTTP {}", r.status()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("{path}: {last}"))
}

/// Deltas per segment (`segment/{k}.jsonl.gz`: deltas `k·384 + 1 ..= (k + 1)·384`, one per line)
/// and per short segment (`mini/{j}.jsonl.gz`, 64 deltas), as the API's `files` writes them.
const SEGMENT: u64 = 384;
const MINI: u64 = 64;

/// Deltas 1..=`head_seq`: whole segments where they exist, then short ones, single deltas for
/// the rest.
async fn read_log(source: &str, head_seq: u64) -> Result<Vec<Delta>, String> {
    let mut deltas = Vec::new();
    let mut seq = 1;
    'next: while seq <= head_seq {
        for (dir, size) in [("segment", SEGMENT), ("mini", MINI)] {
            let k = (seq - 1) / size;
            if (seq - 1) % size != 0 || (k + 1) * size > head_seq {
                continue;
            }
            let Ok(text) = fetch(source, &format!("{dir}/{k}.jsonl.gz"))
                .await
                .and_then(|b| gunzip(&b))
            else {
                continue;
            };
            let lines: Vec<&[u8]> = text
                .split(|&b| b == b'\n')
                .filter(|l| !l.is_empty())
                .collect();
            if lines.len() as u64 == size {
                for (i, line) in lines.iter().enumerate() {
                    let d = serde_json::from_slice(line)
                        .map_err(|e| format!("{dir} {k}, line {}: {e}", i + 1))?;
                    deltas.push(d);
                }
                seq = (k + 1) * size + 1;
                continue 'next;
            }
        }
        let d = fetch(source, &format!("delta/{seq}.json.gz"))
            .await
            .and_then(|b| gunzip(&b))
            .and_then(|j| serde_json::from_slice(&j).map_err(|e| e.to_string()))
            .map_err(|e| format!("delta {seq}: {e}"))?;
        deltas.push(d);
        seq += 1;
    }
    Ok(deltas)
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
            "usage: blindbook-verify <M hex> <API base URL | public/v1 directory> [--chain <lightwalletd URL>] [--reserve <UFVK> --birthday <height>] [--net test|main] [--data <dir>] [--polygon public | <rpc,rpc>]"
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
    let deltas = match read_log(source, head.seq).await {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1)
        }
    };
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
    let unit = coin(source, &opts).await;
    println!("liabilities now: {} {unit}", zec(r.liabilities_zat));
    match r.reserve {
        Some((h, reserve, unswept, owed)) => println!(
            "reserve reported at height {h}: {} {unit} + {} unswept, liabilities then {} {unit}{}",
            zec(reserve),
            zec(unswept),
            zec(owed),
            if opts.contains_key("chain") {
                ""
            } else {
                " (add --chain to check it on-chain)"
            }
        ),
        None => println!("no reserve report yet"),
    }
    if let Some(lwd) = opts.get("chain") {
        match chain::check(source, lwd, &opts, &r, unit).await {
            Ok(lines) => lines.iter().for_each(|l| println!("{l}")),
            Err(e) => r.failures.push(format!("on-chain reserve check: {e}")),
        }
    }
    if let Some(rpcs) = opts.get("polygon") {
        match polygon(rpcs, &r).await {
            Ok(lines) => lines.iter().for_each(|l| println!("{l}")),
            Err(e) => r.failures.push(format!("resolutions against Polygon: {e}")),
        }
    } else if !r.resolutions.is_empty() {
        println!(
            "resolutions {} (add --polygon public to check each against Polygon)",
            r.resolutions.len()
        );
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

/// The network's own coin for the amounts: TAZ on testnet, ZEC on mainnet (from `--net`, or the
/// network the deployment publishes next to its reserve key).
async fn coin(source: &str, opts: &std::collections::BTreeMap<String, String>) -> &'static str {
    let net = match opts.get("net") {
        Some(n) => n.clone(),
        None => fetch(source, "reserve.json")
            .await
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v["network"].as_str().map(str::to_owned))
            .unwrap_or_default(),
    };
    if net.starts_with("main") {
        "ZEC"
    } else {
        "TAZ"
    }
}

/// `--polygon public` or `--polygon <rpc,rpc>`.
#[cfg(feature = "chain")]
async fn polygon(rpcs: &str, r: &blindbook_verify::Report) -> Result<Vec<String>, String> {
    let rpcs: Vec<String> = if rpcs == "public" || rpcs.is_empty() {
        blindbook_polymarket::polygon::DEFAULT_RPCS
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        rpcs.split(',').map(|s| s.trim().to_owned()).collect()
    };
    blindbook_verify::resolutions_on_polygon(rpcs, &r.resolutions).await
}

#[cfg(not(feature = "chain"))]
async fn polygon(_: &str, _: &blindbook_verify::Report) -> Result<Vec<String>, String> {
    Err("built without the `chain` feature".into())
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
        unit: &str,
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
            "reserve on-chain at height {tip}: {} {unit} (view-only wallet of the published key, synced here)",
            zec(onchain)
        )];
        if let Some((h, reported, _, _)) = r.reserve {
            out.push(format!(
                "  last report (height {h}): {} {unit}; difference {} {unit}",
                zec(reported),
                if onchain >= reported {
                    format!("+{}", zec(onchain - reported))
                } else {
                    format!("-{}", zec(reported - onchain))
                }
            ));
        }
        // Every anchor in the log: its transaction, opened with the reserve key, carries the
        // memo bb1:anchor:<height>:<root>, and that root is the log's root at that height.
        let mut anchored = 0;
        for (txid, root) in &r.anchors {
            let memo = w
                .anchor_memo(&mut client, txid)
                .await
                .map_err(|e| format!("anchor {txid}: {e}"))?;
            let Some((mined, memo)) = memo else {
                return Err(format!(
                    "anchor {txid}: no bb1:anchor memo the reserve key can read"
                ));
            };
            let mut parts = memo.trim().split(':').skip(2);
            let (h, m_root) = (
                parts.next().and_then(|h| h.parse::<u64>().ok()),
                parts.next(),
            );
            let in_log = r
                .roots
                .iter()
                .any(|(rh, rr)| Some(*rh) == h && Some(rr.to_string().as_str()) == m_root);
            if m_root != Some(root.to_string().as_str()) || !in_log {
                return Err(format!(
                    "anchor {txid} (mined at {mined}): memo {memo} doesn't name the log's root"
                ));
            }
            anchored += 1;
        }
        out.push(format!(
            "anchors: {anchored} of {} found on-chain, each naming the log's root at its height",
            r.anchors.len()
        ));
        if onchain + unswept < r.liabilities_zat {
            return Err(format!(
                "on-chain reserve {} + {} unswept is below the liabilities of {} {unit}",
                zec(onchain),
                zec(unswept),
                zec(r.liabilities_zat)
            ));
        }
        out.push(format!(
            "SOLVENT on-chain: {} + {} unswept covers {} {unit} of liabilities",
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
        _: &str,
    ) -> Result<Vec<String>, String> {
        Err("built without the `chain` feature".into())
    }
}
