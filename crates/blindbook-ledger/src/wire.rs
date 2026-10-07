//! Slip and signature types in Cashu's JSON shapes (NUT-00, NUT-12), as `cashu-ts` sends them.
//! Points and scalars stay hex strings here; only the signer parses them as curve points.

use serde::{Deserialize, Serialize};

/// A blinded output `B_` for a keyset. Blank outputs (PROTOCOL section 4) carry amount 0 and get
/// their denomination from the signer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlindedMessage {
    pub amount: u64,
    /// Keyset id (NUT-02 v01, hex).
    pub id: String,
    #[serde(rename = "B_")]
    pub b: String,
}

/// NUT-12 DLEQ proof `(e, s)` on a blind signature.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dleq {
    pub e: String,
    pub s: String,
}

/// The signer's answer to one blinded output: `C_ = k·B_` with its DLEQ proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlindSignature {
    pub amount: u64,
    pub id: String,
    #[serde(rename = "C_")]
    pub c: String,
    pub dleq: Dleq,
}

/// A slip being spent: `{keyset id, amount, secret x, C}`. Never published; only `Y =
/// hash_to_curve(x)` enters the public spent set.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proof {
    pub amount: u64,
    pub id: String,
    pub secret: String,
    #[serde(rename = "C")]
    pub c: String,
}

/// An input together with its `Y` (hex of the compressed point), computed by whoever has the
/// curve code: the API for its spent check, the signer again before signing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Input {
    pub proof: Proof,
    pub y: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cashu_json_shapes() {
        let b: BlindedMessage =
            serde_json::from_str(r#"{"amount":0,"id":"01ab","B_":"02cd"}"#).unwrap();
        assert_eq!(b.b, "02cd");
        let p: Proof =
            serde_json::from_str(r#"{"amount":8,"id":"01ab","secret":"9f","C":"03ef"}"#).unwrap();
        assert_eq!(p.c, "03ef");
        let s = BlindSignature {
            amount: 8,
            id: "01ab".into(),
            c: "02aa".into(),
            dleq: Dleq {
                e: "11".into(),
                s: "22".into(),
            },
        };
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"amount":8,"id":"01ab","C_":"02aa","dleq":{"e":"11","s":"22"}}"#
        );
    }
}
