//! The live mirror: sharded WebSocket connections to Polymarket's market channel feeding one
//! [`Feed`], a once-a-second mid sampler for the anchor, and reference snapshots on demand.
//!
//! Polymarket drops a slow consumer (close 1013 "send buffer full") and 200 markets produce about
//! 1 MB/s, so assets are spread over several connections; a dropped or
//! inconsistent connection is redone and re-subscribed, which brings fresh `book` snapshots.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

use crate::anchor::{MidWindow, SAMPLE_EVERY_MS};
use crate::feed::{Feed, FeedStats, HealthConfig, plan_shards};
use crate::msg::{Frame, ResolvedMsg, parse_frame, subscribe_initial, subscribe_more};
use crate::net::{Wss, connect_wss};
use crate::reference::{MarketFeed, RefSnapshot, take};

pub const WS_MARKET: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const SEND_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug)]
pub struct MirrorConfig {
    pub url: String,
    /// Assets per connection (both tokens of a market stay together).
    pub shard_size: usize,
    pub ping_every: Duration,
    pub connect_timeout: Duration,
    /// `http://host:port` CONNECT proxy, for development machines only.
    pub proxy: Option<String>,
    pub health: HealthConfig,
}

impl Default for MirrorConfig {
    fn default() -> Self {
        MirrorConfig {
            url: WS_MARKET.into(),
            shard_size: 40,
            ping_every: Duration::from_secs(3),
            connect_timeout: Duration::from_secs(10),
            proxy: None,
            health: HealthConfig::default(),
        }
    }
}

struct State {
    feed: Feed,
    windows: HashMap<String, MidWindow>,
}

#[derive(Clone)]
struct Clock {
    epoch: Instant,
    epoch_wall_ms: u64,
}

impl Clock {
    fn new() -> Self {
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        Clock {
            epoch: Instant::now(),
            epoch_wall_ms: wall,
        }
    }

    /// Monotonic ms since the mirror started.
    fn now(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    /// Unix ms derived from the monotonic clock (never jumps backwards).
    fn wall(&self, now: u64) -> u64 {
        self.epoch_wall_ms + now
    }
}

pub struct Mirror {
    state: Arc<Mutex<State>>,
    markets: Vec<MarketFeed>,
    clock: Clock,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Mirror {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

fn lock(s: &Mutex<State>) -> MutexGuard<'_, State> {
    s.lock().unwrap_or_else(|e| e.into_inner())
}

impl Mirror {
    /// Start mirroring these markets. Must be called inside a Tokio runtime.
    pub fn start(cfg: MirrorConfig, markets: Vec<MarketFeed>) -> Mirror {
        let clock = Clock::new();
        let pairs: Vec<[String; 2]> = markets.iter().map(|m| m.tokens.clone()).collect();
        let shards = plan_shards(&pairs, cfg.shard_size);
        let n = shards.len();
        let state = Arc::new(Mutex::new(State {
            feed: Feed::new(shards, clock.now(), cfg.health),
            windows: markets
                .iter()
                .map(|m| (m.condition_id.clone(), MidWindow::default()))
                .collect(),
        }));
        let cfg = Arc::new(cfg);
        let mut tasks: Vec<JoinHandle<()>> = (0..n)
            .map(|i| tokio::spawn(run_shard(i, cfg.clone(), state.clone(), clock.clone())))
            .collect();
        tasks.push(tokio::spawn(run_sampler(
            state.clone(),
            markets.clone(),
            clock.clone(),
        )));
        Mirror {
            state,
            markets,
            clock,
            tasks,
        }
    }

    pub fn markets(&self) -> &[MarketFeed] {
        &self.markets
    }

    /// The current reference of a listed market.
    pub fn snapshot(&self, condition_id: &str) -> Option<RefSnapshot> {
        let m = self
            .markets
            .iter()
            .find(|m| m.condition_id == condition_id)?;
        let now = self.clock.now();
        let st = lock(&self.state);
        let w = st.windows.get(condition_id)?;
        Some(take(&st.feed, w, m, now, self.clock.wall(now)))
    }

    /// A copy of one outcome's live book (for the listing rules), once its snapshot arrived.
    pub fn book(&self, condition_id: &str, outcome: usize) -> Option<crate::book::Book> {
        let m = self
            .markets
            .iter()
            .find(|m| m.condition_id == condition_id)?;
        let token = m.tokens.get(outcome)?;
        let st = lock(&self.state);
        if !st.feed.has_snapshot(token) {
            return None;
        }
        st.feed.book(token).cloned()
    }

    pub fn stats(&self) -> FeedStats {
        lock(&self.state).feed.stats
    }

    /// `market_resolved` events since the last call (they wake the resolver; they settle nothing).
    pub fn take_resolved(&self) -> Vec<ResolvedMsg> {
        lock(&self.state).feed.take_resolved()
    }

    /// Connected shards / all shards.
    pub fn connections(&self) -> (usize, usize) {
        let st = lock(&self.state);
        let n = st.feed.shard_count();
        ((0..n).filter(|&i| st.feed.is_connected(i)).count(), n)
    }
}

/// Sample every market's outcome-A mid once a second while its reference is healthy.
async fn run_sampler(state: Arc<Mutex<State>>, markets: Vec<MarketFeed>, clock: Clock) {
    let mut tick = tokio::time::interval(Duration::from_millis(SAMPLE_EVERY_MS));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let now = clock.now();
        let mut guard = lock(&state);
        let st = &mut *guard;
        for m in &markets {
            let healthy = m
                .tokens
                .iter()
                .all(|t| st.feed.unhealthy_since(t, now).is_none());
            let mid = st.feed.book(&m.tokens[0]).and_then(|b| b.mid_ppm());
            if let Some(w) = st.windows.get_mut(&m.condition_id) {
                match mid {
                    Some(mid) if healthy => w.push(now, mid),
                    _ => w.prune(now),
                }
            }
        }
    }
}

async fn run_shard(idx: usize, cfg: Arc<MirrorConfig>, state: Arc<Mutex<State>>, clock: Clock) {
    // Back off only after failed connection attempts; a session that ended (server close,
    // resync) is redone right away, because every second offline counts toward the 10 s halt.
    let mut backoff = Duration::ZERO;
    loop {
        let assets = lock(&state).feed.shard_assets(idx).to_vec();
        match tokio::time::timeout(
            cfg.connect_timeout,
            connect_wss(&cfg.url, cfg.proxy.as_deref()),
        )
        .await
        {
            Ok(Ok(ws)) => {
                backoff = Duration::ZERO;
                lock(&state).feed.on_connected(idx, clock.now());
                tracing::info!(
                    shard = idx,
                    assets = assets.len(),
                    "polymarket feed connected"
                );
                let why = session(idx, ws, &assets, &cfg, &state, &clock).await;
                tracing::warn!(shard = idx, reason = %why, "polymarket feed reconnecting");
            }
            Ok(Err(e)) => {
                backoff = (backoff * 2).clamp(Duration::from_millis(500), Duration::from_secs(10));
                tracing::warn!(shard = idx, error = %e, "polymarket feed connect failed");
            }
            Err(_) => {
                backoff = (backoff * 2).clamp(Duration::from_millis(500), Duration::from_secs(10));
                tracing::warn!(shard = idx, "polymarket feed connect timed out");
            }
        }
        lock(&state).feed.on_disconnected(idx, clock.now());
        // Jitter from the clock's sub-second part, so shards don't reconnect in lockstep.
        let jitter = Duration::from_millis(clock.now() % 200);
        tokio::time::sleep(backoff + jitter).await;
    }
}

/// One connection's life. Returns why it ended.
async fn session(
    idx: usize,
    ws: Wss,
    assets: &[String],
    cfg: &MirrorConfig,
    state: &Mutex<State>,
    clock: &Clock,
) -> String {
    let (mut tx, mut rx) = ws.split();
    // Polymarket accepts large subscriptions, but its first snapshot frame grows with them:
    // send 50 assets per message.
    for (i, chunk) in assets.chunks(50).enumerate() {
        let msg = if i == 0 {
            subscribe_initial(chunk)
        } else {
            subscribe_more(chunk)
        };
        if let Err(e) = tx.send(Message::Text(msg.into())).await {
            return format!("subscribe failed: {e}");
        }
    }
    let mut ping = tokio::time::interval(cfg.ping_every);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut check = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! {
            msg = rx.next() => match msg {
                Some(Ok(Message::Text(t))) => {
                    let parsed = parse_frame(&t);
                    let now = clock.now();
                    let mut st = lock(state);
                    st.feed.on_frame(idx, now);
                    match parsed {
                        Ok(Frame::Pong) => {}
                        Ok(Frame::Events(evs)) => {
                            for ev in evs {
                                st.feed.apply(idx, ev, now);
                            }
                        }
                        Err(_) => st.feed.stats.malformed += 1,
                    }
                }
                Some(Ok(Message::Close(f))) => return format!("closed by server: {f:?}"),
                Some(Ok(_)) => lock(state).feed.on_frame(idx, clock.now()),
                Some(Err(e)) => return format!("read error: {e}"),
                None => return "connection ended".into(),
            },
            _ = ping.tick() => {
                let sent = tokio::time::timeout(SEND_TIMEOUT, tx.send(Message::Text("PING".into()))).await;
                match sent {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => return format!("ping failed: {e}"),
                    Err(_) => return "ping timed out".into(),
                }
            }
            _ = check.tick() => {
                let why = lock(state).feed.shard_needs_resync(idx, clock.now());
                if let Some(why) = why {
                    let _ = tokio::time::timeout(SEND_TIMEOUT, tx.send(Message::Close(None))).await;
                    return format!("resync: {why:?}");
                }
            }
        }
    }
}
