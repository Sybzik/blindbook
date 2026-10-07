//! Follow the chain over the lightwalletd gRPC protocol (lightwalletd or Zaino): every compact
//! block with all pool types, and the full mempool stream for SEEN (PROTOCOL section 11).
//! It never asks for a single transaction by id, so the server learns nothing about which
//! transactions matter to us.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
use zcash_client_backend::proto::service::{BlockId, BlockRange, ChainSpec, Empty, PoolType};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId};

use crate::Error;
use crate::detect::{Payment, detect_compact, detect_full, shielded_actions, txid_string};
use crate::keys::DepositKeys;

pub type Client = CompactTxStreamerClient<Channel>;

const ALL_POOLS: [PoolType; 4] = [
    PoolType::Transparent,
    PoolType::Sapling,
    PoolType::Orchard,
    PoolType::Ironwood,
];

/// `zecrocks` = testnet.zec.rocks:443, `zecrocks-main` = zec.rocks:443, otherwise `host:port`.
/// TLS for every host except a local one (Zaino on 127.0.0.1).
pub async fn connect(server: &str) -> Result<Client, Error> {
    let (host, port): (String, u16) = match server {
        "zecrocks" => ("testnet.zec.rocks".into(), 443),
        "zecrocks-main" => ("zec.rocks".into(), 443),
        s => {
            let (h, p) = s
                .rsplit_once(':')
                .ok_or_else(|| Error::Chain("server must be zecrocks or host:port".into()))?;
            (
                h.to_owned(),
                p.parse().map_err(|_| Error::Chain("bad port".into()))?,
            )
        }
    };
    let tls = !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");
    let endpoint = format!("{}://{host}:{port}", if tls { "https" } else { "http" });
    let mut ch = Channel::from_shared(endpoint).map_err(|e| Error::Chain(e.to_string()))?;
    if tls {
        ch = ch
            .tls_config(
                ClientTlsConfig::new()
                    .domain_name(host.clone())
                    .assume_http2(true)
                    .with_webpki_roots(),
            )
            .map_err(|e| Error::Chain(e.to_string()))?;
    }
    let ch = ch
        .connect_timeout(Duration::from_secs(10))
        .connect()
        .await
        .map_err(|e| Error::Chain(e.to_string()))?;
    Ok(CompactTxStreamerClient::new(ch).max_decoding_message_size(64 << 20))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChainEvent {
    /// A new block, with the payments to our addresses in it.
    Block {
        height: u64,
        hash: String,
        shielded_actions: u64,
        payments: Vec<Payment>,
    },
    /// A payment seen in the mempool (SEEN).
    Seen(Payment),
}

pub async fn tip(c: &mut Client) -> Result<u64, Error> {
    Ok(c.get_latest_block(ChainSpec {})
        .await
        .map_err(|e| Error::Chain(e.to_string()))?
        .into_inner()
        .height)
}

fn range(start: u64, end: u64) -> BlockRange {
    BlockRange {
        start: Some(BlockId {
            height: start,
            hash: vec![],
        }),
        end: Some(BlockId {
            height: end,
            hash: vec![],
        }),
        pool_types: ALL_POOLS.iter().map(|p| *p as i32).collect(),
    }
}

/// Blocks from `from` on, forever. On a reorg (a block that doesn't extend the last one) it
/// steps back 10 blocks and replays; consumers key payments by txid, so replays are harmless.
async fn follow_blocks(
    keys: Arc<DepositKeys>,
    server: String,
    mut next: u64,
    poll: Duration,
    tx: mpsc::Sender<ChainEvent>,
) {
    let mut last_hash: Option<Vec<u8>> = None;
    loop {
        let r: Result<(), Error> = async {
            let mut c = connect(&server).await?;
            loop {
                let t = tip(&mut c).await?;
                if t >= next {
                    let mut s = c
                        .get_block_range(range(next, t))
                        .await
                        .map_err(|e| Error::Chain(e.to_string()))?
                        .into_inner();
                    while let Some(b) =
                        s.message().await.map_err(|e| Error::Chain(e.to_string()))?
                    {
                        if let Some(h) = &last_hash
                            && b.prev_hash != *h
                        {
                            tracing::warn!(height = b.height, "reorg: stepping back 10 blocks");
                            next = b.height.saturating_sub(10);
                            last_hash = None;
                            return Ok(());
                        }
                        last_hash = Some(b.hash.clone());
                        next = b.height + 1;
                        let ev = ChainEvent::Block {
                            height: b.height,
                            hash: txid_string(&b.hash),
                            shielded_actions: shielded_actions(&b),
                            payments: detect_compact(&keys, &b),
                        };
                        if tx.send(ev).await.is_err() {
                            return Err(Error::Chain("consumer gone".into()));
                        }
                    }
                }
                tokio::time::sleep(poll).await;
            }
        }
        .await;
        if let Err(e) = r {
            if tx.is_closed() {
                return;
            }
            tracing::warn!(error = %e, "block follower restarting");
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}

/// The full mempool stream, reopened after each block (the server closes it then).
async fn follow_mempool(keys: Arc<DepositKeys>, server: String, tx: mpsc::Sender<ChainEvent>) {
    let mut seen: HashSet<String> = HashSet::new();
    loop {
        let r: Result<(), Error> = async {
            let mut c = connect(&server).await?;
            loop {
                let t = tip(&mut c).await?;
                let branch = BranchId::for_height(&keys.net, BlockHeight::from((t + 1) as u32));
                let mut s = c
                    .get_mempool_stream(Empty {})
                    .await
                    .map_err(|e| Error::Chain(e.to_string()))?
                    .into_inner();
                let mut n = 0;
                while let Some(raw) = s.message().await.map_err(|e| Error::Chain(e.to_string()))? {
                    n += 1;
                    let Ok(parsed) = Transaction::read(&raw.data[..], branch) else {
                        continue;
                    };
                    if !seen.insert(parsed.txid().to_string()) {
                        continue;
                    }
                    for p in detect_full(&keys, &parsed) {
                        if tx.send(ChainEvent::Seen(p)).await.is_err() {
                            return Err(Error::Chain("consumer gone".into()));
                        }
                    }
                }
                if seen.len() > 100_000 {
                    seen.clear();
                }
                if n == 0 {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
        .await;
        if let Err(e) = r {
            if tx.is_closed() {
                return;
            }
            tracing::warn!(error = %e, "mempool follower restarting");
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}

/// Start following: blocks from `from_height`, and the mempool.
pub fn follow(
    keys: Arc<DepositKeys>,
    server: String,
    from_height: u64,
    poll: Duration,
) -> mpsc::Receiver<ChainEvent> {
    let (tx, rx) = mpsc::channel(1_024);
    tokio::spawn(follow_blocks(
        keys.clone(),
        server.clone(),
        from_height,
        poll,
        tx.clone(),
    ));
    tokio::spawn(follow_mempool(keys, server, tx));
    rx
}
