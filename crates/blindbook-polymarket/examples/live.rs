//! Mirror live Polymarket markets and print their reference every 2 seconds.
//!
//! ```text
//! cargo run --release -p blindbook-polymarket --example live -- [seconds] [slug ...]
//! ```
//! Without slugs it takes the most traded open markets (`BB_MARKETS`, default 12). It also reads
//! one resolved and one open market from Polygon. Uses `HTTPS_PROXY` (http://) if set.
//! `BB_SHARD_SIZE` and `BB_DEAD_AFTER_MS` override the feed settings (a tiny dead-after forces
//! frequent reconnects, to exercise the resync path against the real server).

use std::time::{Duration, Instant};

use blindbook_polymarket::gamma::{self, BAND_PPM};
use blindbook_polymarket::mirror::{Mirror, MirrorConfig};
use blindbook_polymarket::net::{http_client, proxy_from_env};
use blindbook_polymarket::polygon::{DEFAULT_RPCS, PolygonReader};
use blindbook_polymarket::reference::{DEFAULT_GUARD_SHARES, MarketFeed};

/// "Will the price of Bitcoin be above $74,000 on October 5?" resolved Yes.
const RESOLVED: &str = "0x2ebd864919bd149475d00db8aa75a70768a6ad3f33a0ab56a2ee0d54cbad9e3e";

fn env(k: &str) -> Option<u64> {
    std::env::var(k).ok()?.parse().ok()
}

fn cents(ppm: u32) -> String {
    format!("{:.2}", ppm as f64 / 10_000.0)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let mut args = std::env::args().skip(1);
    let secs: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(60);
    let slugs: Vec<String> = args.collect();
    let http = http_client()?;

    let infos = if slugs.is_empty() {
        gamma::fetch_top_open(&http, 60)
            .await?
            .into_iter()
            .filter(|m| m.accepting_orders && !m.closed && m.order_book)
            .take(env("BB_MARKETS").unwrap_or(12) as usize)
            .collect::<Vec<_>>()
    } else {
        let mut v = Vec::new();
        for s in &slugs {
            v.push(gamma::fetch_market(&http, s).await?);
        }
        v
    };
    let markets: Vec<MarketFeed> = infos
        .iter()
        .map(|m| MarketFeed {
            condition_id: m.condition_id.clone(),
            tokens: m.token_ids.clone(),
            guard_micro: DEFAULT_GUARD_SHARES,
        })
        .collect();
    println!("mirroring {} markets for {secs} s", markets.len());

    let mut cfg = MirrorConfig {
        proxy: proxy_from_env(),
        ..MirrorConfig::default()
    };
    if let Some(n) = env("BB_SHARD_SIZE") {
        cfg.shard_size = n as usize;
    }
    if let Some(ms) = env("BB_DEAD_AFTER_MS") {
        cfg.health.dead_after_ms = ms;
        cfg.health.resync_interval_ms = ms;
    }
    let started = Instant::now();
    let mirror = Mirror::start(cfg, markets.clone());
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let mut first_healthy: Vec<Option<Duration>> = vec![None; markets.len()];
    // Markets with a two-sided book (a mid) at least once: the others (decided markets with no
    // asks or no bids) are never healthy by design and could not be listed.
    let mut two_sided = vec![false; markets.len()];
    let mut unhealthy_slots = 0u64;
    let mut slots = 0u64;
    while started.elapsed() < Duration::from_secs(secs) {
        tick.tick().await;
        let (up, n) = mirror.connections();
        let st = mirror.stats();
        println!(
            "t={:>3}s conns {up}/{n} frames {} events {} snapshots {} changes {} inconsistent {} resyncs {} malformed {}",
            started.elapsed().as_secs(),
            st.frames,
            st.events,
            st.snapshots,
            st.changes,
            st.inconsistent,
            st.resyncs,
            st.malformed
        );
        for (i, (m, info)) in markets.iter().zip(&infos).enumerate() {
            let s = mirror.snapshot(&m.condition_id).expect("listed");
            two_sided[i] |= s.best_bid_ppm[0] > 0 && s.best_ask_ppm[0] > 0;
            if two_sided[i] {
                slots += 1;
                if s.unhealthy_ms > 0 || s.mid_ppm == 0 {
                    unhealthy_slots += 1;
                } else if first_healthy[i].is_none() {
                    first_healthy[i] = Some(started.elapsed());
                }
            }
            let band = (BAND_PPM.0..=BAND_PPM.1).contains(&s.mid_ppm);
            println!(
                "  {:<46} mid {:>6} ({:>2} smp) A {:>6}/{:<6} top {:>6}/{:<6} B {:>6}/{:<6} unhealthy {:>5} ms{}",
                info.slug.chars().take(46).collect::<String>(),
                cents(s.mid_ppm),
                s.mid_samples.len(),
                cents(s.bid_ppm[0]),
                cents(s.ask_ppm[0]),
                cents(s.best_bid_ppm[0]),
                cents(s.best_ask_ppm[0]),
                cents(s.bid_ppm[1]),
                cents(s.ask_ppm[1]),
                s.unhealthy_ms,
                if band { "" } else { "  (outside band)" }
            );
        }
        for r in mirror.take_resolved() {
            println!("  market_resolved: {} → {:?}", r.market, r.winning_outcome);
        }
    }
    let ready: Vec<f64> = first_healthy
        .iter()
        .filter_map(|d| d.map(|d| d.as_secs_f64()))
        .collect();
    let st = mirror.stats();
    println!(
        "two-sided markets healthy: {}/{} (of {} mirrored); first healthy reference after max {:.1} s; unhealthy (market, 2 s) slots: {unhealthy_slots}/{slots}; connects {}, resyncs {}, inconsistent changes {} of {}",
        ready.len(),
        two_sided.iter().filter(|&&x| x).count(),
        markets.len(),
        ready.iter().cloned().fold(0.0, f64::max),
        st.connects,
        st.resyncs,
        st.inconsistent,
        st.changes
    );

    let poly = PolygonReader::new(
        http.clone(),
        DEFAULT_RPCS.iter().map(|s| s.to_string()).collect(),
    );
    println!(
        "polygon, resolved market: {:?}",
        poly.settle(RESOLVED).await?
    );
    if let Some(m) = markets.first() {
        println!(
            "polygon, open market: {:?}",
            poly.settle(&m.condition_id).await?
        );
    }
    Ok(())
}
