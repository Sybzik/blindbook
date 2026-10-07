//! Lowercase hex, and 32-byte values that serialize as hex strings.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub fn encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

pub fn decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    s.as_bytes()
        .chunks(2)
        .map(|p| Some(nib(p[0])? << 4 | nib(p[1])?))
        .collect()
}

/// 32 bytes, written as 64 lowercase hex digits (tags, roots, market ids without `0x`).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct H32(pub [u8; 32]);

impl H32 {
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.strip_prefix("0x").unwrap_or(s);
        let v = decode(s)?;
        Some(H32(v.try_into().ok()?))
    }
}

impl fmt::Display for H32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&encode(&self.0))
    }
}

impl fmt::Debug for H32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "H32({self})")
    }
}

impl Serialize for H32 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for H32 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        H32::parse(&s).ok_or_else(|| serde::de::Error::custom("expected 32 bytes of hex"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        assert_eq!(encode(&[0, 15, 255]), "000fff");
        assert_eq!(decode("000FfF"), Some(vec![0, 15, 255]));
        assert_eq!(decode("0"), None);
        assert_eq!(decode("zz"), None);
        let h = H32([7; 32]);
        let j = serde_json::to_string(&h).unwrap();
        assert_eq!(j.len(), 66);
        assert_eq!(serde_json::from_str::<H32>(&j).unwrap(), h);
        assert_eq!(H32::parse(&format!("0x{h}")), Some(h));
        assert!(serde_json::from_str::<H32>("\"00\"").is_err());
    }
}
