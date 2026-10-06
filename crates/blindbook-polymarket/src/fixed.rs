//! Exact parsing of Polymarket's decimal strings and timestamps. No floats: the reference recorded
//! in the public log must be reproducible bit for bit.

/// Prices are kept in parts per million of 1 USDC (0.63 → 630,000).
pub const PPM: u32 = 1_000_000;
/// Sizes are kept in micro-shares (CTF tokens have 6 decimals).
pub const MICRO: u64 = 1_000_000;

/// Parse a non-negative decimal string into an integer scaled by 10^6.
///
/// `exact`: digits beyond the sixth decimal must be zeros (prices); otherwise they are cut off,
/// rounding down (sizes).
fn parse_e6(s: &str, exact: bool) -> Option<u64> {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if int.is_empty() && frac.is_empty() {
        return None;
    }
    if !int.bytes().chain(frac.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (keep, rest) = frac.split_at(frac.len().min(6));
    if exact && !rest.bytes().all(|b| b == b'0') {
        return None;
    }
    let mut v: u64 = 0;
    for b in int.bytes().chain(keep.bytes()) {
        v = v.checked_mul(10)?.checked_add(u64::from(b - b'0'))?;
    }
    for _ in keep.len()..6 {
        v = v.checked_mul(10)?;
    }
    Some(v)
}

/// A price in [0, 1] as ppm, exactly.
pub fn price_ppm(s: &str) -> Option<u32> {
    parse_e6(s, true)
        .filter(|&v| v <= u64::from(PPM))
        .map(|v| v as u32)
}

/// A size in micro-shares, rounded down below one micro-share.
pub fn size_micro(s: &str) -> Option<u64> {
    parse_e6(s, false)
}

/// Days from 1970-01-01 to the given civil date (proleptic Gregorian; H. Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn digits(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Parse the UTC timestamps Gamma uses into Unix milliseconds:
/// `2026-10-05T16:00:00Z`, `2026-10-05T16:00:00.123Z`, `2026-10-06 07:00:00+00`,
/// `2026-10-06 07:00:00+00:00`, and a bare date `2026-10-06` (midnight UTC).
/// Only UTC offsets are accepted; anything else is `None`.
pub fn parse_utc_ms(s: &str) -> Option<u64> {
    let s = s.trim();
    let (date, time) = match s.find(['T', ' ']) {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, "00:00:00Z"),
    };
    let mut dp = date.split('-');
    let (y, mo, d) = (
        digits(dp.next()?)?,
        digits(dp.next()?)?,
        digits(dp.next()?)?,
    );
    if dp.next().is_some() || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let time = time
        .strip_suffix('Z')
        .or_else(|| time.strip_suffix("+00:00"))
        .or_else(|| time.strip_suffix("+00"))?;
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut tp = hms.split(':');
    let (h, mi) = (digits(tp.next()?)?, digits(tp.next()?)?);
    let sec = match tp.next() {
        Some(x) => digits(x)?,
        None => 0,
    };
    if tp.next().is_some() || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let ms = if frac.is_empty() {
        0
    } else {
        let f = &frac[..frac.len().min(3)];
        digits(f)? * 10u32.pow(3 - f.len() as u32)
    };
    let days = days_from_civil(i64::from(y), mo, d);
    let secs = days * 86_400 + i64::from(h) * 3_600 + i64::from(mi) * 60 + i64::from(sec);
    u64::try_from(secs * 1_000 + i64::from(ms)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices() {
        assert_eq!(price_ppm("0.63"), Some(630_000));
        assert_eq!(price_ppm("0.190"), Some(190_000));
        assert_eq!(price_ppm("0.001"), Some(1_000));
        assert_eq!(price_ppm("1"), Some(PPM));
        assert_eq!(price_ppm("0"), Some(0));
        assert_eq!(price_ppm(".5"), Some(500_000));
        assert_eq!(price_ppm("0.1234560"), Some(123_456));
        assert_eq!(price_ppm("0.1234567"), None, "sub-ppm price is rejected");
        assert_eq!(price_ppm("1.01"), None);
        assert_eq!(price_ppm("-0.5"), None);
        assert_eq!(price_ppm("0.5e1"), None);
        assert_eq!(price_ppm(""), None);
        assert_eq!(price_ppm("."), None);
    }

    #[test]
    fn sizes() {
        assert_eq!(size_micro("46133.15"), Some(46_133_150_000));
        assert_eq!(size_micro("235"), Some(235_000_000));
        assert_eq!(size_micro("0"), Some(0));
        assert_eq!(
            size_micro("1.0000009"),
            Some(1_000_000),
            "cut below one micro-share"
        );
        assert_eq!(size_micro("99999999999999999999"), None, "overflow");
    }

    #[test]
    fn timestamps() {
        assert_eq!(parse_utc_ms("1970-01-01T00:00:00Z"), Some(0));
        // 2026-10-05T16:00:00Z: `date -u -d @1791216000`
        assert_eq!(
            parse_utc_ms("2026-10-05T16:00:00Z"),
            Some(1_791_216_000_000)
        );
        assert_eq!(
            parse_utc_ms("2026-10-05T16:00:00.250Z"),
            Some(1_791_216_000_250)
        );
        assert_eq!(
            parse_utc_ms("2026-10-06 07:00:00+00"),
            Some(1_791_270_000_000)
        );
        assert_eq!(
            parse_utc_ms("2026-10-06 07:00:00+00:00"),
            Some(1_791_270_000_000)
        );
        assert_eq!(parse_utc_ms("2026-10-06"), Some(1_791_244_800_000));
        assert_eq!(
            parse_utc_ms("2024-02-29T12:00:00Z"),
            Some(1_709_208_000_000)
        );
        assert_eq!(parse_utc_ms("2026-10-06T07:00:00-04:00"), None);
        assert_eq!(parse_utc_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_utc_ms("soon"), None);
    }
}
