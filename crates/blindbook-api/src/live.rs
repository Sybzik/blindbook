//! `GET /v1/live`: one small JSON every client polls (~3 s). Rebuilt once a second from the
//! ledger's pools and the Polymarket reference, so it costs the same for one client or ten
//! thousand, and no client ever asks about a single market. It carries the markets still in play
//! and those settled in the last half hour; the catalog file carries every result.

use std::collections::HashSet;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use blindbook_engine as engine;
use blindbook_ledger::H32;
use blindbook_ledger::delta::Head;
use blindbook_ledger::ledger::MarketStatus;
use serde::Serialize;

use crate::sequencer::{
    ChainBlock, DuelFill, OpenDuel, RecentFill, RecentPayout, RefFn, Shared, now_ms,
};

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
    pub payouts: Vec<RecentPayout>,
    /// Open blind duels anyone can take, and the challengers' signatures of recent takes.
    pub duels: Vec<OpenDuel>,
    pub duel_fills: Vec<DuelFill>,
}

/// How long a settled market stays in the live JSON after its result was applied.
pub const SETTLED_LIVE_MS: u64 = 1_800_000;

pub fn build(shared: &Shared, refs: &RefFn, at_ms: u64) -> Live {
    // Results replayed at start (at_ms 0) are older than any visitor's page.
    let just_settled: HashSet<H32> = shared
        .settled
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|s| s.at_ms > 0 && s.at_ms + SETTLED_LIVE_MS >= at_ms)
        .map(|s| s.market)
        .collect();
    let markets = shared.markets.read().unwrap_or_else(|e| e.into_inner());
    let out = markets
        .values()
        .filter(|m| m.status == MarketStatus::Open || just_settled.contains(&m.id))
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
            .filter(|f| {
                (f.at_ms > 0 && f.height.is_none())
                    || f.at_ms + crate::sequencer::RECENT_MS >= at_ms
            })
            .cloned()
            .collect(),
        payouts: shared
            .payouts
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|p| p.at_ms + crate::sequencer::PAYOUTS_MS >= at_ms)
            .cloned()
            .collect(),
        duels: shared
            .duels
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
        duel_fills: shared
            .duel_fills
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|f| f.at_ms + crate::sequencer::PAYOUTS_MS >= at_ms)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sequencer::{MarketView, Settled};
    use blindbook_ledger::ledger::{MarketInputs, MarketParams, Pool};
    use blindbook_ledger::reference::RefSnapshot;

    #[test]
    fn settled_markets_stay_half_an_hour() {
        let shared = Shared::new("00cc".into());
        let now = 10_000_000_000;
        let won = MarketStatus::Resolved {
            den: 1,
            num: [1, 0],
        };
        let statuses = [(1, MarketStatus::Open), (2, won), (3, won), (4, won)];
        *shared.markets.write().unwrap() = statuses
            .into_iter()
            .map(|(n, status)| {
                let view = MarketView {
                    id: H32([n; 32]),
                    keysets: [String::new(), String::new()],
                    params: MarketParams::testnet(),
                    event_start_ms: None,
                    end_ms: u64::MAX,
                    pool: Pool::default(),
                    status,
                    info: None,
                };
                (view.id, view)
            })
            .collect();
        *shared.settled.write().unwrap() = vec![
            // Replayed from the journal at start.
            Settled {
                market: H32([2; 32]),
                at_ms: 0,
            },
            Settled {
                market: H32([3; 32]),
                at_ms: now - SETTLED_LIVE_MS - 1,
            },
            Settled {
                market: H32([4; 32]),
                at_ms: now - 60_000,
            },
        ];
        let refs: RefFn = Arc::new(|_m: &H32| MarketInputs {
            reference: RefSnapshot {
                at_ms: 0,
                mid_samples: vec![400_000; 30],
                mid_ppm: 400_000,
                ask_ppm: [405_000, 605_000],
                bid_ppm: [395_000, 595_000],
                guard_micro: 500_000_000,
                best_bid_ppm: [395_000, 595_000],
                best_ask_ppm: [405_000, 605_000],
                server_ts_ms: [0; 2],
                unhealthy_ms: 0,
            },
            closed: false,
            accepting_orders: true,
        });
        let live = build(&shared, &refs, now);
        let ids: Vec<H32> = live.markets.iter().map(|m| m.id).collect();
        assert_eq!(ids, [H32([1; 32]), H32([4; 32])]);
        assert_eq!(live.markets[1].state, "resolved");
        assert_eq!(live.markets[1].resolved, Some([1, 1, 0]));
    }
}
