//! `blindbook-signer`: keep the master key away from the internet-facing API.
//!
//! ```text
//! blindbook-signer keygen <key-file>                 new master key; prints M
//! blindbook-signer vouchers <n> <codes-file> <hashes-file>
//!                                                    judge voucher codes (give out) and hashes (signer)
//! blindbook-signer run                               dial the API and serve
//!     BB_SIGNER_KEY      file with the master secret key (hex)
//!     BB_API_URL         wss://<api>/v1/signer (ws:// only for local tests)
//!     BB_SIGNER_TOKEN    bearer token the API expects
//!     BB_SIGNER_DATA     directory for the journal
//!     BB_VOUCHERS        optional file of voucher hashes (one hex per line)
//!     BB_VOUCHER_UNITS   CREDIT units per voucher (default 50,000 = 0.5 TAZ)
//!     BB_SIGNER_UFVK     file with the deposit account's full viewing key: the signer's own
//!                        indexer, which every top-up credit is checked against
//!     BB_ZCASH_NET       test (default) | main | regtest[:heights]
//!     BB_LWD             lightwalletd / Zaino: zecrocks (default) or host:port
//!     BB_NETWORK         testnet (default) | mainnet: the 0-conf caps
//! ```
//! Keys, codes and journals never go into the repository (`..\blindbook-work\` locally).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use blindbook_indexer::{ChainEvent, DepositKeys, Net};
use blindbook_ledger::H32;
use blindbook_mint::cashu::SecretKey;
use blindbook_mint::{MasterKey, sha256};
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
fn vouchers(n: usize, codes: &Path, hashes: &Path) -> Result<(), String> {
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
        hash_lines.push_str(&format!("{}\n", H32(sha256(code.as_bytes()))));
        code_lines.push_str(&code);
        code_lines.push('\n');
    }
    write_private(codes, &code_lines)?;
    write_private(hashes, &hash_lines)?;
    println!(
        "{n} vouchers: codes in {}, hashes in {}",
        codes.display(),
        hashes.display()
    );
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
        let hashes: Vec<H32> = text.lines().filter_map(|l| H32::parse(l.trim())).collect();
        tracing::info!(count = hashes.len(), units, "vouchers loaded");
        signer.add_vouchers(hashes, units);
    }
    signer.set_zero_conf(match std::env::var("BB_NETWORK").as_deref() {
        Ok("mainnet") => ZeroConf::MAINNET,
        _ => ZeroConf::TESTNET,
    });
    let data = PathBuf::from(env("BB_SIGNER_DATA")?);
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let station = Station::open(signer, &data.join("signer-journal.jsonl"))?;
    let station = Arc::new(Mutex::new(station));
    if let Ok(path) = std::env::var("BB_SIGNER_UFVK") {
        let net = Net::parse(&std::env::var("BB_ZCASH_NET").unwrap_or_else(|_| "test".into()))?;
        let ufvk = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
        let keys = Arc::new(DepositKeys::from_ufvk(net, &ufvk).map_err(|e| e.to_string())?);
        let server = std::env::var("BB_LWD").unwrap_or_else(|_| "zecrocks".into());
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
    {
        let s = station.lock().unwrap_or_else(|e| e.into_inner());
        tracing::info!(m = %s.signer.public_key().to_hex(), applied = s.applied, "signer ready");
    }
    run(env("BB_API_URL")?, env("BB_SIGNER_TOKEN")?, station).await;
    Ok(())
}

#[tokio::main]
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
            Ok(n) => vouchers(n, Path::new(codes), Path::new(hashes)),
            Err(_) => Err("n must be a number".into()),
        },
        ["run"] => serve().await,
        _ => Err(
            "usage: blindbook-signer keygen <file> | vouchers <n> <codes> <hashes> | run".into(),
        ),
    };
    if let Err(e) = r {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
