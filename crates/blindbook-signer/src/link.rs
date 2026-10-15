//! The signer's outbound link to the API (PROTOCOL section 9): it dials `/v1/signer`, says
//! hello with `M` and how many operations it has applied, then answers one operation at a time.
//! It never listens on a port. Its journal is written before each reply leaves, and holds no slip
//! secret (`ops::redact`).

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use blindbook_ledger::H32;
use blindbook_ledger::delta::{GENESIS_ROOT, Head, LogBuilder};
use blindbook_ledger::ops::{self, Applied, FromSigner, Hello, Op, Reply, ToSigner};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use crate::Signer;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub op: Op,
    pub invalid: Vec<usize>,
    /// The reply as sent, so a repeat after a lost answer gets the same one, even across a
    /// restart.
    #[serde(default)]
    pub signatures: Vec<blindbook_ledger::wire::BlindSignature>,
}

pub struct Journal {
    file: File,
}

impl Journal {
    /// Open (or create) the journal and return its entries.
    pub fn open(path: &Path) -> std::io::Result<(Journal, Vec<Entry>)> {
        let mut entries = Vec::new();
        if path.exists() {
            for (n, line) in BufReader::new(File::open(path)?).lines().enumerate() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                entries.push(
                    serde_json::from_str(&line).map_err(|e| {
                        std::io::Error::other(format!("journal line {}: {e}", n + 1))
                    })?,
                );
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok((Journal { file }, entries))
    }

    pub fn append(&mut self, e: &Entry) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(e).map_err(std::io::Error::other)?;
        line.push(b'\n');
        self.file.write_all(&line)?;
        self.file.sync_data()
    }
}

/// The signer with its journal: what the link serves.
pub struct Station {
    pub signer: Signer,
    journal: Journal,
    pub applied: u64,
    /// Digest of the last applied operation (redacted) and its reply.
    last: Option<([u8; 32], Reply)>,
    /// The signer's own copy of the public log: it computes every root itself, and anchors its
    /// own root on-chain, not one the API hands it.
    pub log: LogBuilder,
}

/// Enter an applied operation in the log; for `Close`, close the block and return the root.
fn enter(
    log: &mut LogBuilder,
    signer: &Signer,
    op: &Op,
    applied: &Applied,
    sigs: &[blindbook_ledger::wire::BlindSignature],
) -> Option<H32> {
    ops::record_applied(log, &signer.ledger, op, applied, sigs);
    match op {
        Op::Close { height, chain } => log.close(*height, *chain).ok().map(|(_, head)| head.root),
        _ => None,
    }
}

fn digest(op: &Op) -> [u8; 32] {
    blindbook_ledger::canonical::hash_record(&ops::redact(op)).unwrap_or([0; 32])
}

impl Station {
    /// Replay the journal into a fresh signer.
    pub fn open(mut signer: Signer, journal_path: &Path) -> Result<Self, String> {
        let (journal, entries) = Journal::open(journal_path).map_err(|e| e.to_string())?;
        let applied = entries.len() as u64;
        let mut last = None;
        let mut log = LogBuilder::new(Head {
            height: 0,
            seq: 0,
            root: GENESIS_ROOT,
        });
        for e in entries {
            let applied = signer
                .replay(&e.op, &e.invalid)
                .map_err(|e| e.to_string())?;
            let root = enter(&mut log, &signer, &e.op, &applied, &e.signatures);
            last = Some((
                digest(&e.op),
                Reply {
                    invalid: e.invalid,
                    signatures: e.signatures,
                    root,
                },
            ));
        }
        Ok(Station {
            signer,
            journal,
            applied,
            last,
            log,
        })
    }

    /// Handle one operation at its place in the sequence (`at`: operations applied before it);
    /// journal it before the reply goes out.
    pub fn serve(&mut self, op: &Op, at: u64) -> Result<Reply, String> {
        let d = digest(op);
        if at + 1 == self.applied {
            // The API lost our answer and asks again: same answer, applied once. Only the operation
            // that took that place can ask: an identical one sent afterwards comes at the next place.
            return match &self.last {
                Some((last, reply)) if *last == d => Ok(reply.clone()),
                _ => Err(format!(
                    "{}: operation {at} is not the one applied there",
                    ops::OUT_OF_STEP
                )),
            };
        }
        if at != self.applied {
            return Err(format!(
                "{}: the API is at {at}, the signer at {}",
                ops::OUT_OF_STEP,
                self.applied
            ));
        }
        let (mut reply, applied) = self.signer.handle(op).map_err(|e| e.to_string())?;
        if !matches!(applied, Applied::Refused(_)) {
            reply.root = enter(&mut self.log, &self.signer, op, &applied, &reply.signatures);
            self.journal
                .append(&Entry {
                    op: ops::redact(op),
                    invalid: reply.invalid.clone(),
                    signatures: reply.signatures.clone(),
                })
                .map_err(|e| format!("journal write failed: {e}"))?;
            self.applied += 1;
            self.last = Some((d, reply.clone()));
        }
        Ok(reply)
    }

    pub fn hello(&self) -> Hello {
        Hello {
            m: self.signer.public_key().to_hex(),
            applied: self.applied,
        }
    }
}

fn tls() -> TlsConnector {
    static CFG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    let cfg = CFG
        .get_or_init(|| {
            let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            Arc::new(
                ClientConfig::builder_with_provider(Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))
                .with_safe_default_protocol_versions()
                .expect("TLS versions")
                .with_root_certificates(roots)
                .with_no_client_auth(),
            )
        })
        .clone();
    TlsConnector::from(cfg)
}

type Ws = tokio_tungstenite::WebSocketStream<Box<dyn Stream>>;
trait Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Stream for T {}

/// Dial `ws://` (local tests) or `wss://` (production) with the bearer token.
async fn connect(url: &str, token: &str) -> Result<Ws, String> {
    let (tls_on, rest) = if let Some(r) = url.strip_prefix("wss://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("ws://") {
        (false, r)
    } else {
        return Err(format!("not a ws:// or wss:// url: {url}"));
    };
    let authority = rest.split('/').next().unwrap_or(rest);
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().map_err(|_| "bad port".to_string())?),
        None => (authority, if tls_on { 443 } else { 80 }),
    };
    let tcp = TcpStream::connect((host, port))
        .await
        .map_err(|e| e.to_string())?;
    tcp.set_nodelay(true).map_err(|e| e.to_string())?;
    let stream: Box<dyn Stream> = if tls_on {
        let name = ServerName::try_from(host.to_string()).map_err(|e| e.to_string())?;
        Box::new(tls().connect(name, tcp).await.map_err(|e| e.to_string())?)
    } else {
        Box::new(tcp)
    };
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|e| e.to_string())?,
    );
    let (ws, _) = tokio_tungstenite::client_async(req, stream)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ws)
}

/// One connection's life: hello, then answer operations until the API goes away.
async fn session(ws: Ws, station: &Mutex<Station>) -> String {
    let (mut tx, mut rx) = ws.split();
    let hello = station.lock().unwrap_or_else(|e| e.into_inner()).hello();
    let msg = serde_json::to_string(&FromSigner::Hello { hello }).expect("serializable");
    if let Err(e) = tx.send(Message::Text(msg.into())).await {
        return format!("hello failed: {e}");
    }
    let mut announce = tokio::time::interval(Duration::from_secs(3));
    loop {
        let msg = tokio::select! {
            m = rx.next() => match m {
                Some(m) => m,
                None => break,
            },
            _ = announce.tick() => {
                // Events the API hasn't recorded yet (re-sent until it does).
                let events = station
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .signer
                    .pending_events()
                    .to_vec();
                for event in events {
                    let msg = serde_json::to_string(&FromSigner::Event { event }).expect("serializable");
                    if let Err(e) = tx.send(Message::Text(msg.into())).await {
                        return format!("write error: {e}");
                    }
                }
                continue;
            }
        };
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) => return "closed by the API".into(),
            Ok(_) => continue,
            Err(e) => return format!("read error: {e}"),
        };
        let Ok(ToSigner { id, at, op }) = serde_json::from_str::<ToSigner>(&text) else {
            continue;
        };
        let answer = match station
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .serve(&op, at)
        {
            Ok(reply) => FromSigner::Reply { id, reply },
            Err(error) => {
                tracing::error!(%error, "operation failed");
                FromSigner::Error { id, error }
            }
        };
        let msg = serde_json::to_string(&answer).expect("serializable");
        if let Err(e) = tx.send(Message::Text(msg.into())).await {
            return format!("write error: {e}");
        }
    }
    "connection ended".into()
}

/// Keep the link up forever.
pub async fn run(url: String, token: String, station: Arc<Mutex<Station>>) {
    let mut backoff = Duration::from_millis(500);
    loop {
        match connect(&url, &token).await {
            Ok(ws) => {
                backoff = Duration::from_millis(500);
                tracing::info!("connected to the API");
                let why = session(ws, &station).await;
                tracing::warn!(reason = %why, "link down, reconnecting");
            }
            Err(e) => tracing::warn!(error = %e, "connect failed"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(10));
    }
}
