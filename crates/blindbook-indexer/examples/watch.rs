//! Watch testnet for payments to one-time addresses of a deposit account.
//!
//! ```text
//! cargo run -p blindbook-indexer --example watch -- <uivk-file> <index> [server] [seconds]
//! ```
//! Prints the Revision 0 address at `index`, then every SEEN (mempool) and every block payment.

use std::sync::Arc;
use std::time::{Duration, Instant};

use blindbook_indexer::follow::{connect, tip};
use blindbook_indexer::{ChainEvent, DepositKeys, Net, follow};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let uivk = std::fs::read_to_string(args.next().expect("uivk file")).unwrap();
    let index: u128 = args.next().expect("index").parse().unwrap();
    let server = args.next().unwrap_or_else(|| "zecrocks".into());
    let secs: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(300);
    let keys = Arc::new(DepositKeys::from_uivk(Net::Test, &uivk).unwrap());
    let addr = keys.address_r0(index).unwrap();
    println!("index {index}: {addr}");
    assert_eq!(keys.index_of(&keys.address(index).unwrap()), Some(index));
    let mut c = connect(&server).await.unwrap();
    let start = tip(&mut c).await.unwrap();
    println!("tip {start}; following");
    let t0 = Instant::now();
    let mut rx = follow(keys, server, start + 1, Duration::from_secs(2));
    while t0.elapsed() < Duration::from_secs(secs) {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(ChainEvent::Seen(p))) => println!(
                "{:>7.1}s SEEN  {} index {} value {} {:?} shape {:?}",
                t0.elapsed().as_secs_f64(),
                p.txid,
                p.index,
                p.value_zat,
                p.privacy,
                p.shape
            ),
            Ok(Some(ChainEvent::Block {
                height,
                shielded_actions,
                payments,
                ..
            })) => {
                println!(
                    "{:>7.1}s BLOCK {height} shielded actions {shielded_actions}",
                    t0.elapsed().as_secs_f64()
                );
                for p in payments {
                    println!(
                        "          MINED {} index {} value {} {:?}",
                        p.txid, p.index, p.value_zat, p.privacy
                    );
                }
            }
            Ok(None) => break,
            Err(_) => {}
        }
    }
}
