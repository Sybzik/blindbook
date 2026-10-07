//! Proof-of-work on every POST (PROTOCOL section 4).
//!
//! `SHA256("bb-pow-v1" ‖ SHA256(canonical body) ‖ nonce)` must start with at least D zero bits.
//! The canonical body is the request's JSON without its `pow` field, in RFC 8785 form; the nonce
//! is 8 bytes big-endian, so the outer hash is one SHA-256 block.

use blindbook_ledger::canonical::{sha256, sha256_parts, to_canonical};
use serde_json::Value;

pub const DOMAIN: &[u8] = b"bb-pow-v1";

/// Leading zero bits of a hash.
pub fn leading_zero_bits(h: &[u8; 32]) -> u32 {
    let mut n = 0;
    for b in h {
        if *b == 0 {
            n += 8;
        } else {
            n += b.leading_zeros();
            break;
        }
    }
    n
}

/// The work hash for a body digest and nonce.
pub fn work_hash(body_digest: &[u8; 32], nonce: u64) -> [u8; 32] {
    sha256_parts(&[DOMAIN, body_digest, &nonce.to_be_bytes()])
}

/// Split the `pow` field off a request and return the canonical digest of the rest and the nonce.
pub fn split(mut body: Value) -> Option<([u8; 32], u64, Value)> {
    let nonce = body
        .as_object_mut()?
        .remove("pow")?
        .get("nonce")?
        .as_u64()?;
    let digest = sha256(&to_canonical(&body).ok()?);
    Some((digest, nonce, body))
}

/// Check a request's proof-of-work; returns the body without `pow`.
pub fn check(body: Value, bits: u32) -> Option<Value> {
    let (digest, nonce, rest) = split(body)?;
    (leading_zero_bits(&work_hash(&digest, nonce)) >= bits).then_some(rest)
}

/// Find a nonce (clients do this in Web Workers; here for tests and tools).
pub fn solve(body_without_pow: &Value, bits: u32) -> u64 {
    let digest = sha256(&to_canonical(body_without_pow).expect("canonical"));
    (0u64..)
        .find(|&n| leading_zero_bits(&work_hash(&digest, n)) >= bits)
        .expect("a nonce exists")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bits() {
        let mut h = [0u8; 32];
        assert_eq!(leading_zero_bits(&h), 256);
        h[1] = 0x10;
        assert_eq!(leading_zero_bits(&h), 11);
        h[0] = 0x80;
        assert_eq!(leading_zero_bits(&h), 0);
    }

    #[test]
    fn solve_and_check() {
        let body = json!({ "market": "ab", "amount": 5, "z": [1, 2] });
        let nonce = solve(&body, 12);
        let mut sent = body.clone();
        sent["pow"] = json!({ "nonce": nonce });
        assert_eq!(check(sent.clone(), 12), Some(body.clone()));
        // Key order and whitespace don't matter: the body is canonicalized.
        let reordered: Value = serde_json::from_str(&format!(
            r#"{{ "z":[1,2], "pow":{{"nonce":{nonce}}}, "amount":5, "market":"ab" }}"#
        ))
        .unwrap();
        assert!(check(reordered, 12).is_some());
        // Any change to the body voids the work.
        sent["amount"] = json!(6);
        assert_eq!(check(sent, 12), None);
        assert_eq!(check(body, 1), None, "no pow field");
    }
}

#[cfg(test)]
mod vectors {
    use super::*;
    use serde_json::json;

    /// Pinned for the browser implementation (web/src/core/pow.test.ts uses the same values).
    #[test]
    fn pinned_vector() {
        let body = json!({ "market": "ab", "amount": 5, "z": [1, 2], "s": "é\n" });
        let canonical = String::from_utf8(to_canonical(&body).unwrap()).unwrap();
        let digest = sha256(canonical.as_bytes());
        let nonce = solve(&body, 12);
        assert_eq!(
            canonical,
            r#"{"amount":5,"market":"ab","s":"é\n","z":[1,2]}"#
        );
        assert_eq!(
            blindbook_ledger::hex::encode(&digest),
            "e2494b42ee6de3f4f1ed4b6cb4ab45ee2af3f56d443029a75896d11aa29978a1"
        );
        assert_eq!(nonce, 2432);
        assert_eq!(
            blindbook_ledger::hex::encode(&work_hash(&digest, nonce)),
            "000aff2031488c5b61910b9d475c0ecf82a03d35a9d54afaa7f2ec27bc04773b"
        );
    }
}
