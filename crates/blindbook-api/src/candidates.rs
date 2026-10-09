//! `blindbook-api candidates [count]`: open Polymarket markets that pass the listing rules right
//! now (docs/MARKETS.md "Listing"), printed as entries for the markets file (`BB_MARKETS`).
//! Reads Gamma and each market's order book from Polymarket's public API; it touches no state
//! and needs no key, so it runs anywhere the API's image runs:
//!
//! ```text
//! docker compose run --rm api blindbook-api candidates 20
//! ```
//! Markets that pass every rule except a missing event start are listed apart: the operator
//! looks up when the outcome can become known and enters it as `event_start_ms`.

use blindbook_polymarket::MarketInfo;
use blindbook_polymarket::book::Book;
use blindbook_polymarket::fixed::{price_ppm, size_micro};
use blindbook_polymarket::gamma::{self, GAMMA, LISTING_DEPTH_MICRO, ListingIssue};
use serde_json::Value;

const CLOB: &str = "https://clob.polymarket.com";
/// Gamma pages of 100 markets read at most (the most traded first).
const PAGES: usize = 10;

/// Unix milliseconds as `2026-10-09T12:00:00Z`.
fn iso(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil date from days since 1970-01-01 (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

/// Outcome A's order book from the CLOB's REST endpoint.
async fn book(http: &reqwest::Client, token: &str) -> Result<Book, String> {
    let v: Value = http
        .get(format!("{CLOB}/book"))
        .query(&[("token_id", token)])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let levels = |k: &str| -> Vec<(u32, u64)> {
        v.get(k)
            .and_then(Value::as_array)
            .map(|l| {
                l.iter()
                    .filter_map(|x| {
                        Some((
                            price_ppm(x.get("price")?.as_str()?)?,
                            size_micro(x.get("size")?.as_str()?)?,
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    Ok(Book::from_levels(levels("bids"), levels("asks")))
}

fn line(m: &MarketInfo, mid: Option<u32>) -> String {
    let day = |ms: Option<u64>| ms.map_or("-".to_owned(), |t| iso(t)[..16].replace('T', " "));
    format!(
        "  ends {} · starts {} · mid {} · ${}k/24h · {}",
        day(m.end_ms),
        day(m.event_start_ms),
        mid.map_or("-".into(), |p| format!("{:.2}", f64::from(p) / 1e6)),
        m.volume_24h_usd.unwrap_or(0) / 1000,
        m.question
    )
}

pub async fn run(
    http: &reqwest::Client,
    now_ms: u64,
    judging_end_ms: u64,
    want: usize,
) -> Result<(), String> {
    let mut ready: Vec<(MarketInfo, Option<u32>)> = Vec::new();
    let mut need_start: Vec<(MarketInfo, Option<u32>)> = Vec::new();
    let mut read = 0;
    'pages: for page in 0..PAGES {
        let list: Vec<Value> = http
            .get(format!("{GAMMA}/markets"))
            .query(&[
                ("active", "true".to_owned()),
                ("closed", "false".to_owned()),
                ("end_date_min", iso(now_ms)),
                ("end_date_max", iso(judging_end_ms)),
                ("order", "volume24hr".to_owned()),
                ("ascending", "false".to_owned()),
                ("limit", "100".to_owned()),
                ("offset", (page * 100).to_string()),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        if list.is_empty() {
            break;
        }
        for v in &list {
            let Ok(m) = gamma::parse_market(v) else {
                continue;
            };
            read += 1;
            // The rules that need no book first; the book only for markets that pass them.
            let book_rules = |i: &ListingIssue| {
                matches!(
                    i,
                    ListingIssue::OutsideBand(_) | ListingIssue::TooThin { .. }
                )
            };
            let early: Vec<_> = gamma::listing_issues(
                &m,
                &Book::default(),
                LISTING_DEPTH_MICRO,
                now_ms,
                judging_end_ms,
            )
            .into_iter()
            .filter(|i| !book_rules(i))
            .collect();
            if !(early.is_empty() || early == [ListingIssue::NoEventStart]) {
                continue;
            }
            let Ok(b) = book(http, &m.token_ids[0]).await else {
                continue;
            };
            let issues = gamma::listing_issues(&m, &b, LISTING_DEPTH_MICRO, now_ms, judging_end_ms);
            let mid = b.mid_ppm();
            if issues.is_empty() {
                ready.push((m, mid));
            } else if issues == [ListingIssue::NoEventStart] {
                need_start.push((m, mid));
            }
            if ready.len() >= want {
                break 'pages;
            }
        }
    }
    println!(
        "{read} open markets read that end between now and {} (the end of judging).",
        &iso(judging_end_ms)[..10]
    );
    println!("\nREADY: they pass every rule now ({}).", ready.len());
    for (m, mid) in &ready {
        println!("{}\n    {{\"slug\": \"{}\"}}", line(m, *mid), m.slug);
    }
    println!(
        "\nNEED AN EVENT START ({}): Gamma has none. Enter when the outcome can become known \
         (kick-off, announcement; for a \"by <date>\" question, its end) as event_start_ms (Unix ms).",
        need_start.len()
    );
    for (m, mid) in need_start.iter().take(want) {
        println!(
            "{}\n    {{\"slug\": \"{}\", \"event_start_ms\": <ms>}}",
            line(m, *mid),
            m.slug
        );
    }
    println!(
        "\nThe API checks the same rules on the live book again when it starts; check each market's rules and resolution source yourself (public events only)."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::iso;

    #[test]
    fn iso_dates() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_795_392_000_000), "2026-11-23T00:00:00Z");
        assert_eq!(
            iso(1_759_622_400_000 + 16 * 3_600_000),
            "2025-10-05T16:00:00Z"
        );
    }
}
