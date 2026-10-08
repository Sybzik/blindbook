//! Polymarket's catalog (Gamma API) and the listing rules (MARKETS "Listing").

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Error;
use crate::book::Book;
use crate::fixed::{MICRO, parse_utc_ms, price_ppm};

pub const GAMMA: &str = "https://gamma-api.polymarket.com";

/// What we take from Gamma about one binary market.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MarketInfo {
    pub gamma_id: String,
    pub slug: String,
    pub question: String,
    /// `conditionId`, 0x-prefixed lowercase hex: our market id and the CTF condition.
    pub condition_id: String,
    /// Polymarket's outcome labels; index i is CTF payout index i.
    pub outcomes: [String; 2],
    pub token_ids: [String; 2],
    /// The full rules text, shown verbatim and credited.
    pub description: String,
    pub resolution_source: String,
    pub end_ms: Option<u64>,
    /// `gameStartTime` (sports) or `eventStartTime`: when trading halts.
    pub event_start_ms: Option<u64>,
    pub neg_risk: bool,
    pub accepting_orders: bool,
    pub closed: bool,
    pub active: bool,
    pub order_book: bool,
    pub tick_ppm: Option<u32>,
    pub image: Option<String>,
    pub event_title: Option<String>,
    pub group_item_title: Option<String>,
    /// Context only (shown, never used for pricing).
    pub volume_24h_usd: Option<u64>,
}

fn str_field(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn bool_field(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

/// Gamma encodes `outcomes` and `clobTokenIds` as JSON arrays inside strings.
fn pair_field(v: &Value, k: &str) -> Result<[String; 2], Error> {
    let raw = v
        .get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Parse(format!("{k} missing")))?;
    let list: Vec<String> =
        serde_json::from_str(raw).map_err(|e| Error::Parse(format!("{k}: {e}")))?;
    <[String; 2]>::try_from(list)
        .map_err(|l| Error::Parse(format!("{k}: {} entries, not a binary market", l.len())))
}

fn is_condition_id(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Parse one Gamma `/markets` entry.
pub fn parse_market(v: &Value) -> Result<MarketInfo, Error> {
    let condition_id = str_field(v, "conditionId")
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| is_condition_id(s))
        .ok_or_else(|| Error::Parse("conditionId missing or malformed".into()))?;
    let token_ids = pair_field(v, "clobTokenIds")?;
    if !token_ids
        .iter()
        .all(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(Error::Parse("clobTokenIds are not decimal ids".into()));
    }
    let time = |k: &str| str_field(v, k).as_deref().and_then(parse_utc_ms);
    Ok(MarketInfo {
        gamma_id: v
            .get("id")
            .map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_owned))
            .unwrap_or_default(),
        slug: str_field(v, "slug").unwrap_or_default(),
        question: str_field(v, "question").unwrap_or_default(),
        condition_id,
        outcomes: pair_field(v, "outcomes")?,
        token_ids,
        description: str_field(v, "description").unwrap_or_default(),
        resolution_source: str_field(v, "resolutionSource").unwrap_or_default(),
        end_ms: time("endDate"),
        event_start_ms: time("gameStartTime").or_else(|| time("eventStartTime")),
        neg_risk: bool_field(v, "negRisk"),
        accepting_orders: bool_field(v, "acceptingOrders"),
        closed: bool_field(v, "closed"),
        active: bool_field(v, "active"),
        order_book: bool_field(v, "enableOrderBook"),
        tick_ppm: v
            .get("orderPriceMinTickSize")
            .and_then(|x| price_ppm(&x.to_string().replace('"', ""))),
        image: str_field(v, "image"),
        event_title: v
            .get("events")
            .and_then(|e| e.get(0))
            .and_then(|e| str_field(e, "title")),
        group_item_title: str_field(v, "groupItemTitle"),
        volume_24h_usd: v.get("volume24hr").and_then(|x| {
            x.as_f64()
                .or_else(|| x.as_str()?.parse().ok())
                .map(|f| f as u64)
        }),
    })
}

/// Fetch one market by its slug.
pub async fn fetch_market(http: &reqwest::Client, slug: &str) -> Result<MarketInfo, Error> {
    let list: Vec<Value> = http
        .get(format!("{GAMMA}/markets"))
        .query(&[("slug", slug)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let v = list
        .iter()
        .find(|m| m.get("slug").and_then(Value::as_str) == Some(slug))
        .ok_or_else(|| Error::NotFound(slug.to_owned()))?;
    parse_market(v)
}

/// The most traded open markets (for discovery and tests; listing is always by slug).
pub async fn fetch_top_open(http: &reqwest::Client, limit: u32) -> Result<Vec<MarketInfo>, Error> {
    let list: Vec<Value> = http
        .get(format!("{GAMMA}/markets"))
        .query(&[
            ("active", "true"),
            ("closed", "false"),
            ("order", "volume24hr"),
            ("ascending", "false"),
            ("limit", &limit.to_string()),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(list.iter().filter_map(|v| parse_market(v).ok()).collect())
}

/// Why a market can't be listed (MARKETS "Listing (curation)").
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListingIssue {
    Closed,
    NotAcceptingOrders,
    NoOrderBook,
    EndPassed,
    EndsAfterJudging,
    /// No `gameStartTime`/`eventStartTime`: the operator must enter the event start at listing.
    NoEventStart,
    /// The event has already started: trading would be halted from the first batch.
    Started,
    /// The reference mid isn't inside [0.10, 0.90].
    OutsideBand(u32),
    /// Polymarket's book can't fill our max trade within 2¢ of the top (ppm away, per side).
    TooThin {
        buy_slip_ppm: u32,
        sell_slip_ppm: u32,
    },
    NoRules,
}

pub const BAND_PPM: (u32, u32) = (100_000, 900_000);
/// A listed market's book must fill this many shares of outcome A within 2¢ of the top.
pub const LISTING_DEPTH_MICRO: u64 = 1_000 * MICRO;
pub const MAX_SLIP_PPM: u32 = 20_000;

/// Check the listing rules. `book_a` is outcome A's live book, `depth_micro` the depth it must
/// fill within 2¢ ([`LISTING_DEPTH_MICRO`]); `judging_end_ms` is when judging ends (Nov 22).
pub fn listing_issues(
    m: &MarketInfo,
    book_a: &Book,
    depth_micro: u64,
    now_ms: u64,
    judging_end_ms: u64,
) -> Vec<ListingIssue> {
    let mut out = Vec::new();
    if m.closed {
        out.push(ListingIssue::Closed);
    }
    if !m.accepting_orders {
        out.push(ListingIssue::NotAcceptingOrders);
    }
    if !m.order_book {
        out.push(ListingIssue::NoOrderBook);
    }
    match m.end_ms {
        Some(e) if e <= now_ms => out.push(ListingIssue::EndPassed),
        Some(e) if e > judging_end_ms => out.push(ListingIssue::EndsAfterJudging),
        None => out.push(ListingIssue::EndPassed),
        _ => {}
    }
    match m.event_start_ms {
        None => out.push(ListingIssue::NoEventStart),
        Some(t) if t <= now_ms => out.push(ListingIssue::Started),
        _ => {}
    }
    match book_a.mid_ppm() {
        Some(mid) if (BAND_PPM.0..=BAND_PPM.1).contains(&mid) => {}
        mid => out.push(ListingIssue::OutsideBand(mid.unwrap_or(0))),
    }
    let buy_slip = book_a
        .buy_avg_ppm(depth_micro)
        .saturating_sub(book_a.best_ask().unwrap_or(0));
    let sell_slip = book_a
        .best_bid()
        .unwrap_or(0)
        .saturating_sub(book_a.sell_avg_ppm(depth_micro));
    if book_a.best_ask().is_none()
        || book_a.best_bid().is_none()
        || buy_slip > MAX_SLIP_PPM
        || sell_slip > MAX_SLIP_PPM
    {
        out.push(ListingIssue::TooThin {
            buy_slip_ppm: buy_slip,
            sell_slip_ppm: sell_slip,
        });
    }
    if m.description.trim().is_empty() {
        out.push(ListingIssue::NoRules);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(name: &str) -> Value {
        let s = match name {
            "named" => include_str!("../tests/data/gamma-named.json"),
            _ => include_str!("../tests/data/gamma-negrisk.json"),
        };
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn named_outcomes_market() {
        let m = parse_market(&load("named")).unwrap();
        assert_eq!(m.slug, "lol-bro2-navi-2026-10-06");
        assert_eq!(
            m.outcomes,
            ["HANJIN BRION".to_string(), "Natus Vincere".to_string()]
        );
        assert_eq!(
            m.condition_id,
            "0xd852e0f76587ed40d7092ca1036044ee8a516e17b17ee32e26623ea3c1b21ac7"
        );
        assert!(m.token_ids[0].starts_with("95984957"));
        assert!(m.token_ids[1].starts_with("16824250"));
        // gameStartTime "2026-10-06 07:00:00+00"
        assert_eq!(m.event_start_ms, Some(1_791_270_000_000));
        assert_eq!(m.end_ms, Some(1_791_291_600_000));
        assert_eq!(m.tick_ppm, Some(10_000));
        assert!(!m.neg_risk && m.accepting_orders && !m.closed && m.order_book);
        assert_eq!(m.group_item_title.as_deref(), Some("Match Winner"));
        assert!(m.event_title.unwrap().starts_with("LoL: HANJIN BRION"));
        assert!(m.description.contains("50-50"));
        assert_eq!(m.resolution_source, "https://gol.gg/esports/home");
        assert_eq!(m.volume_24h_usd, Some(488_462));
    }

    #[test]
    fn neg_risk_single() {
        let m = parse_market(&load("negrisk")).unwrap();
        assert!(m.neg_risk);
        assert_eq!(m.outcomes, ["Yes".to_string(), "No".to_string()]);
        assert_eq!(m.event_start_ms, None);
    }

    #[test]
    fn rejects_non_binary_and_broken_entries() {
        let mut v = load("named");
        v["outcomes"] = Value::String(r#"["A","B","C"]"#.into());
        assert!(parse_market(&v).is_err());
        let mut v = load("named");
        v["conditionId"] = Value::String("0x1234".into());
        assert!(parse_market(&v).is_err());
        let mut v = load("named");
        v["clobTokenIds"] = Value::String(r#"["1","x"]"#.into());
        assert!(parse_market(&v).is_err());
    }

    #[test]
    fn listing_rules() {
        let m = parse_market(&load("named")).unwrap();
        let deep = Book::from_levels([(760_000, 50_000 * MICRO)], [(770_000, 50_000 * MICRO)]);
        let before_start = 1_791_260_000_000;
        let judging_end = 1_795_391_999_000; // 2026-11-22T23:59:59Z
        assert_eq!(
            listing_issues(&m, &deep, LISTING_DEPTH_MICRO, before_start, judging_end),
            vec![]
        );
        let thin = Book::from_levels([(760_000, 100 * MICRO)], [(770_000, 100 * MICRO)]);
        let issues = listing_issues(&m, &thin, LISTING_DEPTH_MICRO, before_start, judging_end);
        assert!(matches!(issues[..], [ListingIssue::TooThin { .. }]));
        let at_start = m.event_start_ms.expect("the fixture has a start");
        assert!(
            listing_issues(&m, &deep, LISTING_DEPTH_MICRO, at_start, judging_end)
                .contains(&ListingIssue::Started)
        );
        let after_end = 1_791_291_600_000;
        assert!(
            listing_issues(&m, &deep, LISTING_DEPTH_MICRO, after_end, judging_end)
                .contains(&ListingIssue::EndPassed)
        );
        let extreme = Book::from_levels([(940_000, 50_000 * MICRO)], [(950_000, 50_000 * MICRO)]);
        assert!(
            listing_issues(&m, &extreme, LISTING_DEPTH_MICRO, before_start, judging_end)
                .contains(&ListingIssue::OutsideBand(945_000))
        );
    }
}
