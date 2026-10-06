//! TLS and proxies for the server's outbound connections (Polymarket, Polygon RPCs).
//!
//! rustls with the ring provider and the Mozilla root set: no system OpenSSL, no aws-lc build.
//! An `http://` proxy from `HTTPS_PROXY` is honoured (HTTP CONNECT), for development machines
//! that can't reach Polymarket directly; the production server connects directly.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};

use crate::Error;

/// Install ring as the process-wide rustls provider (reqwest is built without one). Idempotent.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn tls_config() -> Arc<ClientConfig> {
    static CFG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let cfg =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("ring supports TLS 1.2 and 1.3")
                .with_root_certificates(roots)
                .with_no_client_auth();
        Arc::new(cfg)
    })
    .clone()
}

/// The `http://host:port` proxy from `HTTPS_PROXY` / `https_proxy`, if any.
pub fn proxy_from_env() -> Option<String> {
    ["HTTPS_PROXY", "https_proxy"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|v| v.starts_with("http://"))
}

/// The HTTP client for Gamma and the Polygon RPCs (honours `HTTPS_PROXY` by itself).
pub fn http_client() -> Result<reqwest::Client, Error> {
    install_crypto_provider();
    reqwest::Client::builder()
        .user_agent("blindbook/0.1")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(Error::from)
}

/// Open a TCP connection to `host:port`, through an HTTP CONNECT proxy if one is given.
async fn tcp(host: &str, port: u16, proxy: Option<&str>) -> Result<TcpStream, Error> {
    let Some(proxy) = proxy else {
        let s = TcpStream::connect((host, port)).await?;
        s.set_nodelay(true)?;
        return Ok(s);
    };
    let addr = proxy
        .strip_prefix("http://")
        .unwrap_or(proxy)
        .trim_end_matches('/');
    if addr.contains('@') {
        return Err(Error::Net("proxy credentials are not supported".into()));
    }
    let mut s = TcpStream::connect(addr).await?;
    s.set_nodelay(true)?;
    s.write_all(
        format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n").as_bytes(),
    )
    .await?;
    let mut head = Vec::with_capacity(128);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if s.read(&mut byte).await? == 0 || head.len() > 8_192 {
            return Err(Error::Net("proxy closed during CONNECT".into()));
        }
        head.push(byte[0]);
    }
    let status = String::from_utf8_lossy(&head);
    let status = status.lines().next().unwrap_or_default();
    if status.split_whitespace().nth(1) != Some("200") {
        return Err(Error::Net(format!("proxy refused CONNECT: {status}")));
    }
    Ok(s)
}

pub type Wss = tokio_tungstenite::WebSocketStream<TlsStream<TcpStream>>;

/// Connect a `wss://` URL (TCP or proxy → TLS → WebSocket handshake).
pub async fn connect_wss(url: &str, proxy: Option<&str>) -> Result<Wss, Error> {
    let rest = url
        .strip_prefix("wss://")
        .ok_or_else(|| Error::Net(format!("not a wss:// url: {url}")))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().map_err(|_| Error::Net("bad port".into()))?),
        None => (authority, 443),
    };
    let stream = tcp(host, port, proxy).await?;
    let name = ServerName::try_from(host.to_string()).map_err(|e| Error::Net(e.to_string()))?;
    let tls = TlsConnector::from(tls_config())
        .connect(name, stream)
        .await?;
    let (ws, _) = tokio_tungstenite::client_async(url, tls)
        .await
        .map_err(|e| Error::Net(e.to_string()))?;
    Ok(ws)
}
