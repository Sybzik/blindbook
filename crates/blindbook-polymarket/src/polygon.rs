//! Settlement from the chain, not from Polymarket's website (MARKETS "Settlement").
//!
//! The resolver reads the ConditionalTokens payout vector on two independent Polygon RPC
//! providers, each at its own `finalized` block. A market resolves only when both report the same
//! non-zero denominator and numerators; one provider lagging means "not yet", and two providers
//! reporting different payouts is an alarm. Verified on mainnet in `spikes/e-polymarket`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::Error;

/// Polymarket's ConditionalTokens contract on Polygon.
pub const CTF: &str = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
/// Free providers that serve `finalized` reads without a key (checked Oct 6, 2026).
pub const DEFAULT_RPCS: [&str; 2] = [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org",
];
/// `payoutDenominator(bytes32)`.
pub const SEL_PAYOUT_DENOMINATOR: [u8; 4] = [0xdd, 0x34, 0xde, 0x67];
/// `payoutNumerators(bytes32,uint256)`.
pub const SEL_PAYOUT_NUMERATORS: [u8; 4] = [0x05, 0x04, 0xc8, 0x14];
/// `ConditionResolution(bytes32,address,bytes32,uint256,uint256[])`, topic 1 = conditionId.
pub const TOPIC_CONDITION_RESOLUTION: &str =
    "0xb44d84d3289691f71497564b85d4233648d9dbae8cbdbb4329f301c3a0185894";
/// publicnode's `eth_getLogs` range limit.
pub const LOG_WINDOW: u64 = 10_000;

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// The 32 bytes of a `0x…` condition id.
pub fn condition_bytes(condition_id: &str) -> Result<[u8; 32], Error> {
    let h = condition_id
        .strip_prefix("0x")
        .filter(|h| h.len() == 64)
        .ok_or_else(|| Error::Parse(format!("bad condition id {condition_id}")))?;
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&h[2 * i..2 * i + 2], 16)
            .map_err(|_| Error::Parse(format!("bad condition id {condition_id}")))?;
    }
    Ok(out)
}

pub fn denominator_calldata(cond: &[u8; 32]) -> String {
    let mut d = SEL_PAYOUT_DENOMINATOR.to_vec();
    d.extend_from_slice(cond);
    hex(&d)
}

pub fn numerator_calldata(cond: &[u8; 32], index: u8) -> String {
    let mut d = SEL_PAYOUT_NUMERATORS.to_vec();
    d.extend_from_slice(cond);
    d.extend_from_slice(&[0u8; 31]);
    d.push(index);
    hex(&d)
}

/// A `uint256` return word that must fit in u64 (payout numbers are tiny).
pub fn decode_u64_word(word: &str) -> Result<u64, Error> {
    let h = word
        .strip_prefix("0x")
        .ok_or_else(|| Error::Rpc(format!("not hex: {word}")))?;
    if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Rpc(format!("not one uint256 word: {word}")));
    }
    let (high, low) = h.split_at(48);
    if high.bytes().any(|b| b != b'0') {
        return Err(Error::Rpc(format!("value too large: {word}")));
    }
    u64::from_str_radix(low, 16).map_err(|e| Error::Rpc(e.to_string()))
}

fn decode_quantity(v: &Value) -> Result<u64, Error> {
    let s = v
        .as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .ok_or_else(|| Error::Rpc(format!("not a quantity: {v}")))?;
    u64::from_str_radix(s, 16).map_err(|e| Error::Rpc(e.to_string()))
}

/// One provider's view of a condition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Payout {
    Unresolved,
    /// Each share of outcome i pays `num[i] / den` (1 ZEC per share × that fraction).
    Resolved {
        den: u64,
        num: [u64; 2],
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reading {
    pub rpc: String,
    pub block: u64,
    pub payout: Payout,
}

/// The resolver's verdict.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Settlement {
    /// Not resolved on-chain yet, or the providers don't both see it yet, or one failed.
    Pending {
        readings: Vec<Reading>,
        errors: Vec<String>,
    },
    /// Both providers agree on a resolved payout: final.
    Final {
        den: u64,
        num: [u64; 2],
        readings: Vec<Reading>,
    },
    /// Both report a resolution and they differ: never settle, alert the operator.
    Disagree { readings: Vec<Reading> },
}

/// Combine the providers' readings (pure, so the rule is testable).
pub fn decide(readings: Vec<Reading>, errors: Vec<String>) -> Settlement {
    if !errors.is_empty() || readings.len() < 2 {
        return Settlement::Pending { readings, errors };
    }
    let resolved: Vec<(u64, [u64; 2])> = readings
        .iter()
        .filter_map(|r| match r.payout {
            Payout::Resolved { den, num } => Some((den, num)),
            Payout::Unresolved => None,
        })
        .collect();
    if resolved.len() < readings.len() {
        return Settlement::Pending { readings, errors };
    }
    let (den, num) = resolved[0];
    if resolved.iter().all(|&r| r == (den, num)) {
        Settlement::Final { den, num, readings }
    } else {
        Settlement::Disagree { readings }
    }
}

pub struct PolygonReader {
    http: reqwest::Client,
    pub rpcs: Vec<String>,
}

impl PolygonReader {
    pub fn new(http: reqwest::Client, rpcs: Vec<String>) -> Self {
        PolygonReader { http, rpcs }
    }

    async fn rpc(&self, url: &str, method: &str, params: Value) -> Result<Value, Error> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let v: Value = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if let Some(e) = v.get("error") {
            return Err(Error::Rpc(format!("{url} {method}: {e}")));
        }
        v.get("result")
            .cloned()
            .ok_or_else(|| Error::Rpc(format!("{url} {method}: no result")))
    }

    async fn call_u64(&self, url: &str, data: String, block: u64) -> Result<u64, Error> {
        let r = self
            .rpc(
                url,
                "eth_call",
                json!([{ "to": CTF, "data": data }, format!("0x{block:x}")]),
            )
            .await?;
        decode_u64_word(r.as_str().unwrap_or_default())
    }

    /// The provider's `finalized` block number.
    pub async fn finalized_block(&self, url: &str) -> Result<u64, Error> {
        let b = self
            .rpc(url, "eth_getBlockByNumber", json!(["finalized", false]))
            .await?;
        decode_quantity(&b["number"])
    }

    /// Read the payout vector at the provider's finalized block.
    pub async fn read(&self, url: &str, cond: &[u8; 32]) -> Result<Reading, Error> {
        let block = self.finalized_block(url).await?;
        let den = self
            .call_u64(url, denominator_calldata(cond), block)
            .await?;
        let payout = if den == 0 {
            Payout::Unresolved
        } else {
            let n0 = self
                .call_u64(url, numerator_calldata(cond, 0), block)
                .await?;
            let n1 = self
                .call_u64(url, numerator_calldata(cond, 1), block)
                .await?;
            // CTF: the denominator is the sum of the numerators.
            if n0.checked_add(n1) != Some(den) {
                return Err(Error::Rpc(format!(
                    "{url}: numerators {n0} + {n1} != denominator {den}"
                )));
            }
            Payout::Resolved { den, num: [n0, n1] }
        };
        Ok(Reading {
            rpc: url.to_owned(),
            block,
            payout,
        })
    }

    /// Ask every provider and decide.
    pub async fn settle(&self, condition_id: &str) -> Result<Settlement, Error> {
        let cond = condition_bytes(condition_id)?;
        let results =
            futures_util::future::join_all(self.rpcs.iter().map(|u| self.read(u, &cond))).await;
        let mut readings = Vec::new();
        let mut errors = Vec::new();
        for r in results {
            match r {
                Ok(x) => readings.push(x),
                Err(e) => errors.push(e.to_string()),
            }
        }
        Ok(decide(readings, errors))
    }

    /// The `ConditionResolution` transaction, searched backwards from `to_block` in windows of
    /// 10,000 blocks (the resolver polls every 5 minutes, so it is normally in the first window).
    pub async fn resolution_tx(
        &self,
        url: &str,
        condition_id: &str,
        to_block: u64,
        windows: u32,
    ) -> Result<Option<(u64, String)>, Error> {
        let cond = condition_bytes(condition_id)?;
        let mut hi = to_block;
        for _ in 0..windows {
            let lo = hi.saturating_sub(LOG_WINDOW - 1);
            let logs = self
                .rpc(
                    url,
                    "eth_getLogs",
                    json!([{
                        "address": CTF,
                        "fromBlock": format!("0x{lo:x}"),
                        "toBlock": format!("0x{hi:x}"),
                        "topics": [TOPIC_CONDITION_RESOLUTION, hex(&cond)],
                    }]),
                )
                .await?;
            if let Some(l) = logs.as_array().and_then(|a| a.last()) {
                let block = decode_quantity(&l["blockNumber"])?;
                let tx = l["transactionHash"].as_str().unwrap_or_default().to_owned();
                return Ok(Some((block, tx)));
            }
            if lo == 0 {
                break;
            }
            hi = lo - 1;
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BTC: &str = "0x2ebd864919bd149475d00db8aa75a70768a6ad3f33a0ab56a2ee0d54cbad9e3e";

    #[test]
    fn calldata() {
        let c = condition_bytes(BTC).unwrap();
        assert_eq!(denominator_calldata(&c), format!("0xdd34de67{}", &BTC[2..]));
        assert_eq!(
            numerator_calldata(&c, 1),
            format!("0x0504c814{}{}01", &BTC[2..], "0".repeat(62))
        );
        assert!(condition_bytes("0x12").is_err());
    }

    #[test]
    fn words() {
        let one = format!("0x{}1", "0".repeat(63));
        assert_eq!(decode_u64_word(&one).unwrap(), 1);
        assert_eq!(
            decode_u64_word(&format!("0x{}", "0".repeat(64))).unwrap(),
            0
        );
        assert!(decode_u64_word(&format!("0x1{}", "0".repeat(63))).is_err());
        assert!(decode_u64_word("0x").is_err());
    }

    fn r(rpc: &str, payout: Payout) -> Reading {
        Reading {
            rpc: rpc.into(),
            block: 1,
            payout,
        }
    }

    #[test]
    fn agreement_rules() {
        let yes = Payout::Resolved {
            den: 1,
            num: [1, 0],
        };
        let half = Payout::Resolved {
            den: 2,
            num: [1, 1],
        };
        assert!(matches!(
            decide(vec![r("a", yes), r("b", yes)], vec![]),
            Settlement::Final {
                den: 1,
                num: [1, 0],
                ..
            }
        ));
        assert!(matches!(
            decide(vec![r("a", half), r("b", half)], vec![]),
            Settlement::Final {
                den: 2,
                num: [1, 1],
                ..
            }
        ));
        // One provider lags: not yet.
        assert!(matches!(
            decide(vec![r("a", yes), r("b", Payout::Unresolved)], vec![]),
            Settlement::Pending { .. }
        ));
        // One provider failed: never settle on a single source.
        assert!(matches!(
            decide(vec![r("a", yes)], vec!["b: timeout".into()]),
            Settlement::Pending { .. }
        ));
        assert!(matches!(
            decide(
                vec![
                    r("a", yes),
                    r(
                        "b",
                        Payout::Resolved {
                            den: 1,
                            num: [0, 1]
                        }
                    )
                ],
                vec![]
            ),
            Settlement::Disagree { .. }
        ));
    }
}
