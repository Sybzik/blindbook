//! `GET /v1/live`: one small JSON every client polls (~3 s). Rebuilt once a second from the
//! ledger's pools and the Polymarket reference, so it costs the same for one client or ten
//! thousand, and no client ever asks about a single market.

use std::sync::{Arc, RwLock};
use std::time::Duration;

use blindbook_engine as engine;
use blindbook_ledger::H32;
use blindbook_ledger::delta::Head;
use blindbook_ledger::ledger::MarketStatus;
use serde::Serialize;

use crate::sequencer::{ChainBlock, RecentFill, RefFn, Shared, now_ms};

#[derive(Serialize)]
pub struct LiveReference {
    pub mid_ppm: u32,
    pub ask_ppm: [u32; 2],
    pub bid_ppm: [u32; 2],
    pub unhealthy_ms: u64,
}

#[derive(Serialize)]
pub struct LiveMarket {
    pub id: H32,
    /// "open", "halted" or "resolved".
    pub state: &'static str,
    pub halt: Option<String>,
    /// Our price of outcome A (ppm); B is 1 − A.
    pub price_a_ppm: Option<u64>,
    pub reference: LiveReference,
    pub resolved: Option<[u64; 3]>,
}

#[derive(Serialize)]
pub struct Live {
    pub at_ms: u64,
    pub head: Head,
    /// The last chain block in the log and its shielded activity.
    pub block: Option<ChainBlock>,
    pub markets: Vec<LiveMarket>,
    pub recent: Vec<RecentFill>,
}

pub fn build(shared: &Shared, refs: &RefFn, at_ms: u64) -> Live {
    let markets = shared.markets.read().unwrap_or_else(|e| e.into_inner());
    let out = markets
        .values()
        .map(|m| {
            let inputs = refs(&m.id);
            let r = &inputs.reference;
            let reference = LiveReference {
                mid_ppm: r.mid_ppm,
                ask_ppm: r.ask_ppm,
                bid_ppm: r.bid_ppm,
                unhealthy_ms: r.unhealthy_ms,
            };
            if let MarketStatus::Resolved { den, num } = m.status {
                return LiveMarket {
                    id: m.id,
                    state: "resolved",
                    halt: None,
                    price_a_ppm: None,
                    reference,
                    resolved: Some([den, num[0], num[1]]),
                };
            }
            let params = m.params.engine();
            let halt = engine::halt_reason(
                &params,
                &r.to_engine(inputs.closed, inputs.accepting_orders),
                &engine::Schedule {
                    now_ms: at_ms,
                    event_start_ms: m.event_start_ms,
                    end_ms: m.end_ms,
                },
            );
            let pool = engine::Market {
                u: m.pool.u,
                c: m.pool.c,
                house: m.pool.house,
            };
            let price = (r.mid_ppm > 0 && r.mid_ppm < engine::PPM)
                .then(|| engine::price_a_ppm(&pool, &params, r.mid_ppm));
            LiveMarket {
                id: m.id,
                state: if halt.is_some() { "halted" } else { "open" },
                halt: halt.map(|h| format!("{h:?}")),
                price_a_ppm: price,
                reference,
                resolved: None,
            }
        })
        .collect();
    drop(markets);
    Live {
        at_ms,
        head: *shared.head.read().unwrap_or_else(|e| e.into_inner()),
        block: *shared.block.read().unwrap_or_else(|e| e.into_inner()),
        markets: out,
        recent: shared
            .recent
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|f| f.at_ms + crate::sequencer::RECENT_MS >= at_ms)
            .cloned()
            .collect(),
    }
}

/// Rebuild the live JSON every second.
pub async fn run(shared: Arc<Shared>, refs: RefFn, out: Arc<RwLock<Vec<u8>>>) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tick.tick().await;
        let live = build(&shared, &refs, now_ms());
        if let Ok(bytes) = serde_json::to_vec(&live) {
            *out.write().unwrap_or_else(|e| e.into_inner()) = bytes;
        }
    }
}
