//! Polymarket CLOB market-channel messages (`wss://ws-subscriptions-clob.polymarket.com/ws/market`).
//! Formats as captured from the live feed.

use serde::Deserialize;

use crate::book::BookSide;

#[derive(Clone, Debug, Deserialize)]
pub struct Level {
    pub price: String,
    pub size: String,
}

/// Full snapshot of one token's book: sent on subscribe and again after trades.
#[derive(Clone, Debug, Deserialize)]
pub struct BookMsg {
    pub market: String,
    pub asset_id: String,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub bids: Vec<Level>,
    #[serde(default)]
    pub asks: Vec<Level>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Change {
    pub asset_id: String,
    pub price: String,
    /// The level's new total size; "0" removes it.
    pub size: String,
    /// `BUY` (a bid level) or `SELL` (an ask level).
    pub side: String,
    /// Polymarket's best prices after the change ("0" = no bid; "0" or "1" = no ask).
    #[serde(default)]
    pub best_bid: Option<String>,
    #[serde(default)]
    pub best_ask: Option<String>,
}

impl Change {
    pub fn book_side(&self) -> Option<BookSide> {
        match self.side.as_str() {
            "BUY" => Some(BookSide::Bid),
            "SELL" => Some(BookSide::Ask),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct PriceChangeMsg {
    pub market: String,
    #[serde(default)]
    pub timestamp: String,
    pub price_changes: Vec<Change>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ResolvedMsg {
    pub market: String,
    #[serde(default)]
    pub assets_ids: Vec<String>,
    #[serde(default)]
    pub winning_asset_id: Option<String>,
    #[serde(default)]
    pub winning_outcome: Option<String>,
    #[serde(default)]
    pub timestamp: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum Event {
    Book(BookMsg),
    PriceChange(PriceChangeMsg),
    /// Wakes the resolver early; settlement still waits for the payout on Polygon.
    MarketResolved(ResolvedMsg),
    /// `best_bid_ask`, `last_trade_price`, `tick_size_change`, `new_market`, …: not needed. The
    /// local book is the source of truth (`best_bid_ask` disagrees with it more often than not).
    #[serde(other)]
    Other,
}

#[derive(Debug)]
pub enum Frame {
    Pong,
    Events(Vec<Event>),
}

/// Parse one text frame: `PONG`, a JSON array of events or a single event object.
pub fn parse_frame(text: &str) -> Result<Frame, serde_json::Error> {
    let t = text.trim();
    if t == "PONG" {
        return Ok(Frame::Pong);
    }
    if t.starts_with('[') {
        Ok(Frame::Events(serde_json::from_str(t)?))
    } else {
        Ok(Frame::Events(vec![serde_json::from_str(t)?]))
    }
}

/// The first message on a connection.
pub fn subscribe_initial(assets: &[String]) -> String {
    serde_json::json!({ "assets_ids": assets, "type": "market", "custom_feature_enabled": true })
        .to_string()
}

/// Further assets on an open connection.
pub fn subscribe_more(assets: &[String]) -> String {
    serde_json::json!({ "assets_ids": assets, "operation": "subscribe", "custom_feature_enabled": true })
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLES: &str = include_str!("../tests/data/ws-samples.json");

    #[test]
    fn parses_every_captured_event_type() {
        let v: serde_json::Value = serde_json::from_str(SAMPLES).unwrap();
        let mut seen = Vec::new();
        for (name, ev) in v.as_object().unwrap() {
            let Frame::Events(evs) = parse_frame(&ev.to_string()).unwrap() else {
                panic!("not events")
            };
            let tag = match &evs[0] {
                Event::Book(b) => {
                    assert_eq!(b.bids.len(), 3);
                    assert_eq!(b.asks[2].price, "0.82");
                    "book"
                }
                Event::PriceChange(p) => {
                    assert_eq!(p.price_changes.len(), 2);
                    assert_eq!(p.price_changes[0].book_side(), Some(BookSide::Bid));
                    assert_eq!(p.price_changes[1].best_ask.as_deref(), Some("0.38"));
                    "price_change"
                }
                Event::MarketResolved(r) => {
                    assert_eq!(r.winning_outcome.as_deref(), Some("Up"));
                    assert_eq!(r.assets_ids.len(), 2);
                    "market_resolved"
                }
                Event::Other => "other",
            };
            seen.push((name.clone(), tag));
        }
        for (name, tag) in &seen {
            let want = match name.as_str() {
                "book" | "price_change" | "market_resolved" => name.as_str(),
                _ => "other",
            };
            assert_eq!(*tag, want, "{name}");
        }
        assert_eq!(seen.len(), 6);
    }

    #[test]
    fn frames() {
        assert!(matches!(parse_frame("PONG").unwrap(), Frame::Pong));
        assert!(matches!(parse_frame("[]").unwrap(), Frame::Events(v) if v.is_empty()));
        assert!(parse_frame("not json").is_err());
    }

    #[test]
    fn subscribe_messages() {
        let a = vec!["1".to_string(), "2".to_string()];
        let v: serde_json::Value = serde_json::from_str(&subscribe_initial(&a)).unwrap();
        assert_eq!(v["type"], "market");
        assert_eq!(v["assets_ids"][1], "2");
        let v: serde_json::Value = serde_json::from_str(&subscribe_more(&a)).unwrap();
        assert_eq!(v["operation"], "subscribe");
    }
}
