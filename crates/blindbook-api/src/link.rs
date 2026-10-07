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
use blindbook_ledger::ops::{Op, Reply};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc, oneshot};

#[derive(Debug, thiserror::Error)]
pub enum LinkError {
    #[error("the signer is not connected")]
    Down,
    #[error("the signer did not answer in time")]
    Timeout,
    #[error("the signer refused: {0}")]
    Signer(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hello {
    /// Master public key, hex.
    pub m: String,
    /// Operations the signer has applied (its journal length).
    pub applied: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FromSigner {
    Hello { hello: Hello },
    Reply { id: u64, reply: Reply },
    Error { id: u64, error: String },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ToSigner {
    pub id: u64,
    pub op: Op,
}

type Call = (Op, oneshot::Sender<Result<Reply, LinkError>>);

/// A signer connected over WebSocket.
#[derive(Default)]
pub struct Remote {
    tx: Mutex<Option<mpsc::Sender<Call>>>,
}

pub const CALL_TIMEOUT: Duration = Duration::from_secs(10);

impl Remote {
    async fn call(&self, op: &Op) -> Result<Reply, LinkError> {
        let tx = self.tx.lock().await.clone().ok_or(LinkError::Down)?;
        let (rtx, rrx) = oneshot::channel();
        tx.send((op.clone(), rtx))
            .await
            .map_err(|_| LinkError::Down)?;
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
        let (tx, mut rx) = mpsc::channel::<Call>(1);
        *self.tx.lock().await = Some(tx);
        let mut next_id = 0u64;
        while let Some((op, reply)) = rx.recv().await {
            next_id += 1;
            let msg = serde_json::to_string(&ToSigner { id: next_id, op }).expect("serializable");
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
                        _ => continue,
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
        *self.tx.lock().await = None;
        tracing::warn!("signer disconnected");
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
    pub async fn call(&self, op: &Op) -> Result<Reply, LinkError> {
        match self {
            SignerLink::Remote(r) => r.call(op).await,
            #[cfg(feature = "embedded-signer")]
            SignerLink::Embedded(s) => s
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .handle(op)
                .map(|(reply, _)| reply)
                .map_err(|e| LinkError::Signer(e.to_string())),
        }
    }
}
