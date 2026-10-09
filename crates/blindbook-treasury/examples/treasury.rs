//! Operate a treasury wallet by hand (testnet / regtest), for tests and for funding buffers.
//!
//! ```text
//! cargo run -p blindbook-treasury --example treasury -- <dir> <seed-hex-file> <server> <command>
//!   info                      keys, addresses, balances (after a sync)
//!   sweep                     deposits → reserve
//!   payout <addr> <zat> ...   up to 7 recipients, 8 Ironwood actions, OVK discarded
//!   anchor <memo>             zero-value self-payment with a memo
//!   drain <addr>              everything the reserve can spend → one address (sweep first)
//! ```

use blindbook_indexer::follow::{connect, tip};
use blindbook_indexer::{DepositKeys, Net};
use blindbook_treasury::Treasury;
use secrecy::SecretVec;
use zcash_address::ZcashAddress;

#[tokio::main]
async fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (dir, seed_file, server) = (&a[0], &a[1], &a[2]);
    let seed_hex = std::fs::read_to_string(seed_file).unwrap();
    let seed: Vec<u8> = (0..seed_hex.trim().len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&seed_hex.trim()[i..i + 2], 16).unwrap())
        .collect();
    let mut c = connect(server).await.unwrap();
    let t = tip(&mut c).await.unwrap();
    let mut tr = Treasury::open(
        std::path::Path::new(dir),
        Net::Test,
        SecretVec::new(seed),
        t.saturating_sub(5),
        &mut c,
    )
    .await
    .unwrap();
    let started = std::time::Instant::now();
    tr.sync(&mut c).await.unwrap();
    println!(
        "synced to {t} in {:.1} s; balances {:?}",
        started.elapsed().as_secs_f64(),
        tr.balances().unwrap()
    );
    match a[3].as_str() {
        "info" => {
            let keys = DepositKeys::from_uivk(Net::Test, &tr.deposit_uivk()).unwrap();
            println!("deposit UIVK {}", tr.deposit_uivk());
            println!("deposit address #1 {}", keys.address_r0(1).unwrap());
            println!("reserve address {}", tr.reserve_address().unwrap());
            println!("reserve UFVK {}", tr.reserve_ufvk());
        }
        "sweep" => println!("sweep: {:?}", tr.sweep(&mut c).await),
        "payout" => {
            let rec: Vec<(ZcashAddress, u64)> = a[4..]
                .chunks(2)
                .map(|p| {
                    (
                        ZcashAddress::try_from_encoded(&p[0]).unwrap(),
                        p[1].parse().unwrap(),
                    )
                })
                .collect();
            println!("payout: {:?}", tr.payout(&mut c, &rec).await);
        }
        "anchor" => println!("anchor: {:?}", tr.anchor(&mut c, &a[4]).await),
        "drain" => println!(
            "drain: {:?}",
            tr.drain(&mut c, ZcashAddress::try_from_encoded(&a[4]).unwrap())
                .await
        ),
        other => println!("unknown command {other}"),
    }
}
