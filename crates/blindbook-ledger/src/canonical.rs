//! Canonical JSON (RFC 8785, JCS) for every hashed record: request bodies under proof-of-work and
//! the public log deltas. Our records hold only integers, strings, booleans, arrays and objects,
//! so canonical form means: no whitespace, object keys sorted by UTF-16 code units, minimal
//! string escaping, integers in plain decimal. Floats are refused.
//!
//! Keys are sorted here explicitly, whatever `serde_json` feature (`preserve_order`) another crate
//! in the build may switch on.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::Error;

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// SHA-256 of the concatenation of `parts`.
pub fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn write(v: &Value, out: &mut Vec<u8>) -> Result<(), Error> {
    match v {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
        Value::Number(n) => {
            if n.is_f64() {
                return Err(Error::Canonical(format!("float {n} in a canonical record")));
            }
            out.extend_from_slice(n.to_string().as_bytes());
        }
        // serde_json escapes exactly what JCS requires: `"`, `\`, \b \t \n \f \r and the other
        // control characters as lowercase \u00xx; everything else is written as UTF-8.
        Value::String(s) => out.extend_from_slice(serde_json::to_string(s)?.as_bytes()),
        Value::Array(a) => {
            out.push(b'[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write(x, out)?;
            }
            out.push(b']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push(b'{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                out.extend_from_slice(serde_json::to_string(k)?.as_bytes());
                out.push(b':');
                write(&m[k], out)?;
            }
            out.push(b'}');
        }
    }
    Ok(())
}

/// The canonical bytes of a record.
pub fn to_canonical<T: Serialize>(v: &T) -> Result<Vec<u8>, Error> {
    let value = serde_json::to_value(v)?;
    let mut out = Vec::new();
    write(&value, &mut out)?;
    Ok(out)
}

/// SHA-256 of a record's canonical bytes.
pub fn hash_record<T: Serialize>(v: &T) -> Result<[u8; 32], Error> {
    Ok(sha256(&to_canonical(v)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorted_compact_integers() {
        let v = json!({ "b": [3, {"z": true, "a": null}], "a": "x", "€": 1, "B": -2 });
        let c = String::from_utf8(to_canonical(&v).unwrap()).unwrap();
        assert_eq!(c, r#"{"B":-2,"a":"x","b":[3,{"a":null,"z":true}],"€":1}"#);
    }

    #[test]
    fn jcs_string_escapes() {
        let v = json!({ "s": "q\"b\\n\n\t\u{1}\u{7f}é/" });
        let c = String::from_utf8(to_canonical(&v).unwrap()).unwrap();
        assert_eq!(c, "{\"s\":\"q\\\"b\\\\n\\n\\t\\u0001\u{7f}é/\"}");
    }

    #[test]
    fn utf16_key_order() {
        // U+FB01 (one UTF-16 unit, 0xFB01) sorts after U+1F600 (surrogates 0xD83D…) in UTF-16,
        // but before it in UTF-8 byte order: JCS uses UTF-16.
        let v = json!({ "\u{fb01}": 1, "\u{1f600}": 2 });
        let c = String::from_utf8(to_canonical(&v).unwrap()).unwrap();
        assert_eq!(c, "{\"\u{1f600}\":2,\"\u{fb01}\":1}");
    }

    #[test]
    fn floats_are_refused() {
        assert!(to_canonical(&json!({ "p": 0.5 })).is_err());
        assert!(to_canonical(&json!({ "n": u64::MAX })).is_ok());
    }

    #[test]
    fn hashes() {
        // SHA-256("abc")
        assert_eq!(
            crate::hex::encode(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_parts(&[b"a", b"bc"]), sha256(b"abc"));
    }
}
