//! `blindbook-signer`: keep the master key away from the internet-facing API.
//!
//! ```text
//! blindbook-signer keygen <key-file>                 new master key; prints M
//! blindbook-signer vouchers <n> <codes-file> <hashes-file> [uses]
//!                                                    judge voucher codes (give out) and hashes
//!                                                    (signer); each code redeemable `uses` times (1)
//! blindbook-signer init <dir> <birthday|tip>         seal key + treasury seed in <dir> (kept if
//!                                                    present); prints what the API and the app pin
//! blindbook-signer drain <dir> <address>             with the signer stopped, once the playground
//!                                                    is closed: everything the treasury holds to
//!                                                    one address (testnet TAZ back to a faucet)
//! blindbook-signer run                               dial the API and serve
//!     BB_SIGNER_KEY      file with the master secret key (hex)
//!     BB_API_URL         wss://<api>/v1/signer (ws:// only for local tests)
//!     BB_SIGNER_TOKEN    bearer token the API expects
//!     BB_SIGNER_DATA     directory for the journal
//!     BB_VOUCHERS        optional file of voucher hashes (one hex per line, then optionally
//!                        how many times it can be redeemed)
//!     BB_VOUCHER_UNITS   CREDIT units per redemption (default 50,000 = 0.5 TAZ)
//!     BB_TREASURY_DIR    the directory made by `init`: seal key, treasury seed and wallet.
//!                        Turns on the signer's own indexer (every top-up credit is checked
//!                        against it), sealed withdrawals, payouts, sweeps and anchors
//!     BB_SIGNER_UFVK     without a treasury: a deposit full viewing key for the own indexer only
//!     BB_ANCHOR_EVERY    blocks between anchors (default 144: an hour at NU7's 25 s blocks);
//!                        BB_SWEEP_EVERY likewise (an hour of deposits per sweep)
//!     BB_ZCASH_NET       test (default) | main | regtest[:heights]
//!     BB_LWD             lightwalletd / Zaino: zecrocks (default) or host:port
//!     BB_NETWORK         testnet (default) | mainnet: the 0-conf caps and the only market
//!                        parameters a listing may carry
//!     BB_POLYGON_RPCS    comma-separated Polygon RPCs the signer reads results from itself
//!                        (default: the two public ones the API uses; both must agree)
//! ```
//! Keys, codes and journals never go into the repository (a work directory beside it, locally).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use blindbook_indexer::{ChainEvent, DepositKeys, Net};
use blindbook_ledger::H32;
use blindbook_ledger::ledger::MarketParams;
use blindbook_mint::MasterKey;
use blindbook_mint::cashu::SecretKey;
use blindbook_polymarket::net::http_client;
use blindbook_polymarket::polygon::{DEFAULT_RPCS, PolygonReader, Settlement};
use blindbook_signer::link::{Station, run};
use blindbook_signer::{Deposit, Signer, ZeroConf};

fn env(k: &str) -> Result<String, String> {
    std::env::var(k).map_err(|_| format!("{k} is not set"))
}

fn write_private(path: &Path, text: &str) -> Result<(), String> {
    if path.exists() {
        return Err(format!("{} exists; refusing to overwrite", path.display()));
    }
    std::fs::write(path, text).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn keygen(path: &Path) -> Result<(), String> {
    let k = SecretKey::generate();
    write_private(path, &format!("{}\n", k.to_secret_hex()))?;
    println!("M = {}", MasterKey::from_secret(k).public_key().to_hex());
    Ok(())
}

/// Codes like `BB-7K2M-Q9XD-3HTR-W6PN` (Crockford base32: no I, L, O, U).
/// Lines of the voucher file: a hash, then optionally how many times it can be redeemed (1 when
/// absent). Blank lines are skipped; anything else stops the start.
fn voucher_entries(text: &str) -> Result<Vec<(H32, u32)>, String> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let mut parts = line.split_whitespace();
        let Some(hex) = parts.next() else { continue };
        let bad = || format!("voucher file, line {}: expected `<hash> [uses]`", i + 1);
        let hash = H32::parse(hex).ok_or_else(bad)?;
        let uses = match parts.next() {
            None => 1,
            Some(u) => u.parse::<u32>().ok().filter(|u| *u > 0).ok_or_else(bad)?,
        };
        if parts.next().is_some() {
            return Err(bad());
        }
        out.push((hash, uses));
    }
    Ok(out)
}

fn vouchers(n: usize, uses: u32, codes: &Path, hashes: &Path) -> Result<(), String> {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut code_lines = String::new();
    let mut hash_lines = String::new();
    for _ in 0..n {
        let bytes = SecretKey::generate().to_secret_bytes();
        let chars: String = bytes[..16]
            .iter()
            .map(|b| ALPHABET[(*b as usize) % 32] as char)
            .collect();
        let code = format!(
            "BB-{}-{}-{}-{}",
            &chars[0..4],
            &chars[4..8],
            &chars[8..12],
            &chars[12..16]
        );
        let hash = blindbook_ledger::ops::voucher_hash(&code);
        if uses > 1 {
            hash_lines.push_str(&format!("{hash} {uses}\n"));
        } else {
            hash_lines.push_str(&format!("{hash}\n"));
        }
        code_lines.push_str(&code);
        code_lines.push('\n');
    }
    write_private(codes, &code_lines)?;
    write_private(hashes, &hash_lines)?;
    println!(
        "{n} vouchers ({uses} redemption{} each): codes in {}, hashes in {}",
        if uses == 1 { "" } else { "s" },
        codes.display(),
        hashes.display()
    );
    Ok(())
}

fn read_hex(path: &Path) -> Result<Vec<u8>, String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let t = t.trim();
    (0..t.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(t.get(i..i + 2).unwrap_or("zz"), 16)
                .map_err(|_| "bad hex".to_string())
        })
        .collect()
}

fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

async fn open_treasury(
    dir: &Path,
    net: Net,
    server: &str,
    birthday: Option<u64>,
) -> Result<blindbook_treasury::Treasury, String> {
    let seed = read_hex(&dir.join("treasury.seed"))?;
    let mut c = blindbook_indexer::follow::connect(server)
        .await
        .map_err(|e| e.to_string())?;
    let tip = blindbook_indexer::follow::tip(&mut c)
        .await
        .map_err(|e| e.to_string())?;
    blindbook_treasury::Treasury::open(
        &dir.join("wallet"),
        net,
        secrecy::SecretVec::new(seed),
        birthday.unwrap_or(tip),
        &mut c,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Make (or reuse) the seal key and the treasury seed, and print the public values.
async fn init(dir: &Path, birthday: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let seal = dir.join("seal.key");
    if !seal.exists() {
        let (sk, _) = blindbook_seal::keygen();
        write_private(&seal, &format!("{}\n", hexs(&sk)))?;
    }
    let seed = dir.join("treasury.seed");
    if !seed.exists() {
        write_private(
            &seed,
            &format!("{}\n", hexs(&SecretKey::generate().to_secret_bytes())),
        )?;
    }
    let net = Net::parse(&std::env::var("BB_ZCASH_NET").unwrap_or_else(|_| "test".into()))?;
    let server = std::env::var("BB_LWD").unwrap_or_else(|_| "zecrocks".into());
    let birthday = birthday.parse::<u64>().ok();
    let mut t = open_treasury(dir, net, &server, birthday).await?;
    let sk: [u8; 32] = read_hex(&seal)?
        .try_into()
        .map_err(|_| "seal key must be 32 bytes")?;
    let pk = blindbook_seal::public_key(&sk);
    println!("seal public key (pin in the app):   {}", hexs(&pk));
    println!("deposit UIVK (API BB_UIVK file):     {}", t.deposit_uivk());
    println!("reserve UFVK (publish, solvency):    {}", t.reserve_ufvk());
    // Public values, ready for the API (BB_RESERVE_UFVK, BB_RESERVE_BIRTHDAY).
    let birthday = t.reserve_birthday().map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join("reserve-ufvk.txt"),
        format!(
            "{}
",
            t.reserve_ufvk()
        ),
    )
    .map_err(|e| e.to_string())?;
    println!("reserve birthday:                    {birthday} (reserve-ufvk.txt written)");
    println!(
        "reserve address (buffer funding):    {}",
        t.reserve_address().map_err(|e| e.to_string())?
    );
    Ok(())
}

/// Send everything the treasury holds to one address. Deposits not swept yet go into the reserve
/// first; run it again once that sweep has confirmed.
async fn drain(dir: &Path, address: &str) -> Result<(), String> {
    let to = zcash_address::ZcashAddress::try_from_encoded(address).map_err(|e| e.to_string())?;
    let net = Net::parse(&std::env::var("BB_ZCASH_NET").unwrap_or_else(|_| "test".into()))?;
    let server = std::env::var("BB_LWD").unwrap_or_else(|_| "zecrocks".into());
    let mut t = open_treasury(dir, net, &server, None).await?;
    let mut c = blindbook_indexer::follow::connect(&server)
        .await
        .map_err(|e| e.to_string())?;
    t.sync(&mut c).await.map_err(|e| e.to_string())?;
    let b = t.balances().map_err(|e| e.to_string())?;
    println!(
        "spendable: deposits {} zat, reserve {} zat",
        b.deposit_spendable, b.reserve_spendable
    );
    if let Some(txid) = t.sweep(&mut c).await.map_err(|e| e.to_string())? {
        println!("deposits swept into the reserve ({txid}); run drain again once it has confirmed");
        return Ok(());
    }
    match t.drain(&mut c, to).await.map_err(|e| e.to_string())? {
        Some(txid) => println!("sent: {txid}"),
        None => println!("nothing to send"),
    }
    Ok(())
}

async fn serve() -> Result<(), String> {
    let key_hex = std::fs::read_to_string(env("BB_SIGNER_KEY")?).map_err(|e| e.to_string())?;
    let key = SecretKey::from_hex(key_hex.trim()).map_err(|e| e.to_string())?;
    let mut signer = Signer::new(MasterKey::from_secret(key)).map_err(|e| e.to_string())?;
    if let Ok(path) = std::env::var("BB_VOUCHERS") {
        let units: u64 = std::env::var("BB_VOUCHER_UNITS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(50_000);
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let entries = voucher_entries(&text)?;
        let uses: u32 = entries.iter().map(|(_, u)| u).sum();
        tracing::info!(count = entries.len(), uses, units, "vouchers loaded");
        signer.add_voucher_uses(entries, units);
    }
    let mainnet = std::env::var("BB_NETWORK").as_deref() == Ok("mainnet");
    signer.set_zero_conf(if mainnet {
        ZeroConf::MAINNET
    } else {
        ZeroConf::TESTNET
    });
    // A listing carries the network's parameters or nothing, and a result counts only once the
    // signer has read it from Polygon itself (PROTOCOL section 9).
    signer.set_listing_params(if mainnet {
        MarketParams::mainnet()
    } else {
        MarketParams::testnet()
    });
    signer.require_confirmed_resolutions();
    let data = PathBuf::from(env("BB_SIGNER_DATA")?);
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let net = Net::parse(&std::env::var("BB_ZCASH_NET").unwrap_or_else(|_| "test".into()))?;
    let testnet = !matches!(net, Net::Main);
    let server = std::env::var("BB_LWD").unwrap_or_else(|_| "zecrocks".into());
    let treasury = match std::env::var("BB_TREASURY_DIR") {
        Ok(dir) => {
            let dir = PathBuf::from(dir);
            let sk: [u8; 32] = read_hex(&dir.join("seal.key"))?
                .try_into()
                .map_err(|_| "seal key must be 32 bytes")?;
            signer.set_seal_key(sk, testnet);
            Some(open_treasury(&dir, net, &server, None).await?)
        }
        Err(_) => None,
    };
    let station = Station::open(signer, &data.join("signer-journal.jsonl"))?;
    let station = Arc::new(Mutex::new(station));
    let ufvk = match (&treasury, std::env::var("BB_SIGNER_UFVK")) {
        (Some(t), _) => Some(t.deposit_ufvk()),
        (None, Ok(path)) => {
            Some(std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?)
        }
        (None, Err(_)) => None,
    };
    if let Some(ufvk) = ufvk {
        let keys = Arc::new(DepositKeys::from_ufvk(net, &ufvk).map_err(|e| e.to_string())?);
        let server = server.clone();
        let height_file = data.join("signer-scanned-height.txt");
        let scanned: u64 = std::fs::read_to_string(&height_file)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        let from = if scanned > 0 {
            // Re-read a margin: already-credited txids are ignored, so this is harmless.
            scanned.saturating_sub(100)
        } else {
            let mut c = blindbook_indexer::follow::connect(&server)
                .await
                .map_err(|e| e.to_string())?;
            blindbook_indexer::follow::tip(&mut c)
                .await
                .map_err(|e| e.to_string())?
        };
        tracing::info!(%server, from, "signer's own indexer following the chain");
        let mut rx =
            blindbook_indexer::follow(keys, server, from, std::time::Duration::from_secs(2));
        let st = station.clone();
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                let (payments, confirmed, height) = match ev {
                    ChainEvent::Seen(p) => (vec![p], false, None),
                    ChainEvent::Block {
                        height, payments, ..
                    } => (payments, true, Some(height)),
                };
                {
                    let mut s = st.lock().unwrap_or_else(|e| e.into_inner());
                    for p in payments {
                        let Ok(index) = u64::try_from(p.index) else {
                            continue;
                        };
                        s.signer.deposit_seen(Deposit {
                            diversifier_index: index,
                            amount: p.value_zat / 1_000,
                            txid: p.txid,
                            confirmed,
                        });
                    }
                }
                if let Some(h) = height {
                    let _ = std::fs::write(&height_file, h.to_string());
                }
            }
        });
    }
    if let Some(t) = treasury {
        let every = |k: &str, default: u64| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(default)
        };
        tokio::spawn(blindbook_signer::payouts::run(
            t,
            station.clone(),
            blindbook_signer::payouts::Schedule {
                server: server.clone(),
                data: data.clone(),
                anchor_every: every("BB_ANCHOR_EVERY", 144),
                sweep_every: every("BB_SWEEP_EVERY", 144),
            },
        ));
        tracing::info!("treasury running: payouts, sweeps, anchors");
    }
    tokio::spawn(read_results(station.clone()));
    {
        let s = station.lock().unwrap_or_else(|e| e.into_inner());
        tracing::info!(m = %s.signer.public_key().to_hex(), applied = s.applied, "signer ready");
    }
    run(env("BB_API_URL")?, env("BB_SIGNER_TOKEN")?, station).await;
    Ok(())
}

/// Once a minute, read the result of every open market from Polygon (two RPCs that must agree)
/// and remember it: the API's resolution must match it.
async fn read_results(station: Arc<Mutex<Station>>) {
    let rpcs: Vec<String> = match std::env::var("BB_POLYGON_RPCS") {
        Ok(v) => v.split(',').map(|s| s.trim().to_owned()).collect(),
        Err(_) => DEFAULT_RPCS.iter().map(|s| s.to_string()).collect(),
    };
    let http = match http_client() {
        Ok(h) => h,
        Err(e) => {
            tracing::error!(error = %e, "no HTTP client: resolutions can't be confirmed");
            return;
        }
    };
    let poly = PolygonReader::new(http, rpcs);
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        tick.tick().await;
        let due = station
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .signer
            .unconfirmed();
        for id in due {
            match poly.settle(&format!("0x{id}")).await {
                Ok(Settlement::Final { den, num, .. }) => {
                    tracing::info!(market = %id, den, ?num, "result read from Polygon");
                    station
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .signer
                        .confirm_resolution(id, den, num);
                }
                Ok(Settlement::Disagree { readings }) => {
                    tracing::error!(market = %id, ?readings, "Polygon RPCs disagree; no result");
                }
                Ok(Settlement::Pending { .. }) => {}
                Err(e) => tracing::warn!(market = %id, error = %e, "Polygon read failed"),
            }
        }
    }
}

// At least four worker threads whatever the core count: on a one-vCPU server a single worker
// would stall the API link (answers due within 10 s) while the treasury scans blocks or proves a
// payout; with several, the OS shares the core and the link keeps answering.
#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let r = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["keygen", path] => keygen(Path::new(path)),
        ["vouchers", n, codes, hashes] => match n.parse() {
            Ok(n) => vouchers(n, 1, Path::new(codes), Path::new(hashes)),
            Err(_) => Err("n must be a number".into()),
        },
        ["vouchers", n, codes, hashes, uses] => match (n.parse(), uses.parse()) {
            (Ok(n), Ok(uses)) if uses > 0 => vouchers(n, uses, Path::new(codes), Path::new(hashes)),
            _ => Err("n and uses must be positive numbers".into()),
        },
        ["init", dir, birthday] => init(Path::new(dir), birthday).await,
        ["drain", dir, address] => drain(Path::new(dir), address).await,
        ["run"] => serve().await,
        _ => Err(
            "usage: blindbook-signer keygen <file> | vouchers <n> <codes> <hashes> [uses] | init <dir> <birthday|tip> | drain <dir> <address> | run".into(),
        ),
    };
    if let Err(e) = r {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::voucher_entries;

    #[test]
    fn voucher_file_lines() {
        let h = "ab".repeat(32);
        let e = voucher_entries(&format!("{h}\n\n{h} 20\n")).unwrap();
        assert_eq!(e.iter().map(|(_, u)| *u).collect::<Vec<_>>(), [1, 20]);
        for bad in [
            format!("{h} 0"),
            format!("{h} x"),
            format!("{h} 2 3"),
            "zz".into(),
        ] {
            assert!(voucher_entries(&bad).is_err(), "{bad}");
        }
    }
}
