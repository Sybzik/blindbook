//! The API's side of the signer link (PROTOCOL section 9). The signer has no inbound ports: it
//! dials the API's `/v1/signer` WebSocket and the API sends it one operation at a time.
//!
//! Wire format, one JSON text message each way per operation:
//! - signer → API on connect: `{"hello": {"m": <M hex>, "applied": <operations applied>}}`
//! - API → signer: `{"id": n, "op": Op}`
//! - signer → API: `{"id": n, "reply": Reply}` or `{"id": n, "error": "..."}`

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
pub use blindbook_ledger::ops::{FromSigner, Hello, ToSigner};
use blindbook_ledger::ops::{Op, Reply};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Mutex, mpsc, oneshot};

#[derive(Debug, thiserror::Error)]
pub enum LinkError {
    /// Nothing was sent: no signer connected.
    #[error("the signer is not connected")]
    NotConnected,
    /// Sent, and the connection dropped before the answer: the signer may have applied it.
    #[error("the signer link dropped before it answered")]
    Down,
    #[error("the signer did not answer in time")]
    Timeout,
    #[error("the signer refused: {0}")]
    Signer(String),
}

type Call = (Op, u64, oneshot::Sender<Result<Reply, LinkError>>);

/// A signer connected over WebSocket.
#[derive(Default)]
pub struct Remote {
    /// The live connection's sender, tagged with its connection number, so a closing old
    /// connection never removes a newer one.
    tx: Mutex<Option<(u64, mpsc::Sender<Call>)>>,
    generation: std::sync::atomic::AtomicU64,
    /// Where the treasury's events go (the sequencer turns each into `Op::Record`).
    events: std::sync::Mutex<Option<mpsc::Sender<blindbook_ledger::delta::LogEvent>>>,
}

pub const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// A ping while idle, so a half-open connection is noticed.
pub const KEEPALIVE: Duration = Duration::from_secs(15);

impl Remote {
    async fn call(&self, op: &Op, at: u64) -> Result<Reply, LinkError> {
        let tx = self
            .tx
            .lock()
            .await
            .as_ref()
            .map(|(_, t)| t.clone())
            .ok_or(LinkError::NotConnected)?;
        let (rtx, rrx) = oneshot::channel();
        tx.send((op.clone(), at, rtx))
            .await
            .map_err(|_| LinkError::NotConnected)?;
        tokio::time::timeout(CALL_TIMEOUT, rrx)
            .await
            .map_err(|_| LinkError::Timeout)?
            .map_err(|_| LinkError::Down)?
    }

    /// Serve one signer connection until it drops. `check` validates the hello (same `M`, same
    /// number of applied operations); a signer that fails it is disconnected.
    pub async fn attach(&self, socket: WebSocket, check: impl Fn(&Hello) -> Result<(), String>) {
        let (mut sink, mut stream) = socket.split();
        let hello = match tokio::time::timeout(Duration::from_secs(10), stream.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => match serde_json::from_str::<FromSigner>(&t) {
                Ok(FromSigner::Hello { hello }) => hello,
                _ => return,
            },
            _ => return,
        };
        if let Err(why) = check(&hello) {
            tracing::error!(%why, "signer refused at hello");
            let _ = sink.send(Message::Close(None)).await;
            return;
        }
        tracing::info!(applied = hello.applied, "signer connected");
        let generation = self
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        let (tx, mut rx) = mpsc::channel::<Call>(1);
        *self.tx.lock().await = Some((generation, tx));
        let mut next_id = 0u64;
        let mut keepalive = tokio::time::interval(KEEPALIVE);
        keepalive.tick().await;
        loop {
            let (op, at, reply) = tokio::select! {
                call = rx.recv() => match call {
                    Some(c) => c,
                    None => break,
                },
                msg = stream.next() => match msg {
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    Some(Ok(Message::Text(t))) => {
                        self.forward(&t);
                        continue;
                    }
                    _ => break,
                },
                _ = keepalive.tick() => {
                    if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                    continue;
                }
            };
            next_id += 1;
            let msg = serde_json::to_string(&ToSigner {
                id: next_id,
                at,
                op,
            })
            .expect("serializable");
            if sink.send(Message::Text(msg.into())).await.is_err() {
                let _ = reply.send(Err(LinkError::Down));
                break;
            }
            let answer = loop {
                match stream.next().await {
                    Some(Ok(Message::Text(t))) => match serde_json::from_str::<FromSigner>(&t) {
                        Ok(FromSigner::Reply { id, reply }) if id == next_id => break Ok(reply),
                        Ok(FromSigner::Error { id, error }) if id == next_id => {
                            break Err(LinkError::Signer(error));
                        }
                        _ => {
                            self.forward(&t);
                            continue;
                        }
                    },
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    _ => break Err(LinkError::Down),
                }
            };
            let down = matches!(answer, Err(LinkError::Down));
            let _ = reply.send(answer);
            if down {
                break;
            }
        }
        let mut slot = self.tx.lock().await;
        if slot.as_ref().is_some_and(|(g, _)| *g == generation) {
            *slot = None;
        }
        drop(slot);
        tracing::warn!("signer disconnected");
    }

    pub fn set_events(&self, tx: mpsc::Sender<blindbook_ledger::delta::LogEvent>) {
        *self.events.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    }

    fn forward(&self, text: &str) {
        if let Ok(FromSigner::Event { event }) = serde_json::from_str::<FromSigner>(text) {
            let tx = self
                .events
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if let Some(tx) = tx {
                let _ = tx.try_send(event);
            }
        }
    }

    pub async fn connected(&self) -> bool {
        self.tx.lock().await.is_some()
    }
}

#[derive(Clone)]
pub enum SignerLink {
    Remote(Arc<Remote>),
    #[cfg(feature = "embedded-signer")]
    Embedded(Arc<std::sync::Mutex<blindbook_signer::Signer>>),
}

impl SignerLink {
    /// Send `op` at its place in the sequence (`at`: operations applied before it).
    pub async fn call(&self, op: &Op, at: u64) -> Result<Reply, LinkError> {
        match self {
            SignerLink::Remote(r) => r.call(op, at).await,
            #[cfg(feature = "embedded-signer")]
            // In process: no answer can be lost, so there is nothing to repeat.
            SignerLink::Embedded(s) => s
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .handle(op)
                .map(|(reply, _)| reply)
                .map_err(|e| LinkError::Signer(e.to_string())),
        }
    }
}
