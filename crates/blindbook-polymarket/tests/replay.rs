//! Replays 407 real frames of one live market (HANJIN BRION vs Natus Vincere, Oct 6 2026,
//! captured in spikes/e-polymarket) through the feed: the local books must track Polymarket's
//! own best prices, stay mirrored between the two outcomes, and yield a healthy reference.

use blindbook_engine::{Params, Schedule, halt_reason};
use blindbook_polymarket::anchor::MidWindow;
use blindbook_polymarket::feed::{Feed, HealthConfig};
use blindbook_polymarket::fixed::{MICRO, PPM};
use blindbook_polymarket::gamma::parse_market;
use blindbook_polymarket::msg::{Frame, parse_frame};
use blindbook_polymarket::reference::{DEFAULT_GUARD_SHARES, MarketFeed, take};

const FRAMES: &str = include_str!("data/ws-market.jsonl");
const GAMMA: &str = include_str!("data/gamma-named.json");

#[test]
fn real_market_replay() {
    let info = parse_market(&serde_json::from_str(GAMMA).unwrap()).unwrap();
    let market = MarketFeed {
        condition_id: info.condition_id.clone(),
        tokens: info.token_ids.clone(),
        guard_micro: DEFAULT_GUARD_SHARES,
    };
    let mut feed = Feed::new(vec![info.token_ids.to_vec()], 0, HealthConfig::default());
    feed.on_connected(0, 0);
    let mut window = MidWindow::default();
    let mut mirrored_checks = 0;
    let mut unhealthy_frames = 0;
    // Replay at 25 ms per frame (about 10 s in all), sampling the mid every second.
    for (i, line) in FRAMES.lines().enumerate() {
        let now = i as u64 * 25;
        let Frame::Events(evs) = parse_frame(line).unwrap() else {
            panic!("frame {i}")
        };
        feed.on_frame(0, now);
        for ev in evs {
            feed.apply(0, ev, now);
        }
        if feed.unhealthy_since(&market.tokens[0], now).is_some() {
            unhealthy_frames += 1;
        }
        if now.is_multiple_of(1_000)
            && let Some(mid) = feed.book(&market.tokens[0]).and_then(|b| b.mid_ppm())
        {
            window.push(now, mid);
        }
        // Polymarket's CTF books are mirrored: our depth-aware quotes must be too.
        let (a, b) = (
            feed.book(&market.tokens[0]).unwrap(),
            feed.book(&market.tokens[1]).unwrap(),
        );
        if a.best_bid().is_some() && b.best_bid().is_some() && !a.is_crossed() && !b.is_crossed() {
            for q in [100 * MICRO, DEFAULT_GUARD_SHARES] {
                assert_eq!(a.buy_avg_ppm(q), PPM - b.sell_avg_ppm(q), "frame {i}");
                assert_eq!(a.sell_avg_ppm(q), PPM - b.buy_avg_ppm(q), "frame {i}");
            }
            mirrored_checks += 1;
        }
    }
    let s = feed.stats;
    assert_eq!(s.snapshots, 2);
    assert_eq!(
        s.changes, 800,
        "400 price_change events, both outcomes each"
    );
    assert_eq!(s.malformed + s.unknown_asset, 0);
    assert!(
        s.inconsistent <= 4,
        "local book disagreed with Polymarket {} times",
        s.inconsistent
    );
    assert!(unhealthy_frames <= 4, "{unhealthy_frames} unhealthy frames");
    assert!(mirrored_checks > 400);

    let now = FRAMES.lines().count() as u64 * 25;
    let snap = take(&feed, &window, &market, now, 1_791_272_100_000);
    assert!(snap.anchor_matches());
    assert_eq!(snap.unhealthy_ms, 0);
    // The match was trading around 0.62 for HANJIN BRION in this capture.
    assert!(
        (550_000..700_000).contains(&snap.mid_ppm),
        "{}",
        snap.mid_ppm
    );
    assert!(snap.ask_ppm[0] >= snap.best_ask_ppm[0] && snap.bid_ppm[0] <= snap.best_bid_ppm[0]);
    // Golden values. This capture is in-play (the match had started at 07:00 UTC, so trading here
    // would be halted) and the asks of outcome A were thin: buying 500 shares averaged 0.6603
    // against a 0.63 top, while the bids absorbed 500 shares at the top price.
    assert_eq!(snap.best_bid_ppm, [620_000, 370_000]);
    assert_eq!(snap.best_ask_ppm, [630_000, 380_000]);
    assert_eq!(snap.ask_ppm, [660_312, 380_000]);
    assert_eq!(snap.bid_ppm, [620_000, 339_688]);
    let r = snap.to_engine(info.closed, info.accepting_orders);
    assert_eq!(halt_reason(&Params::testnet(), &r, &Schedule::open()), None);
    println!("{}", serde_json::to_string_pretty(&snap).unwrap());
}
