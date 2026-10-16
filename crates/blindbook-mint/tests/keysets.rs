//! The keyset derivation must match the browser byte for byte: these golden vectors were produced
//! by `@cashu/cashu-ts` 4.11 + `@noble/curves`.

use blindbook_mint::cashu::dhke::{blind_message, unblind_message};
use blindbook_mint::cashu::{PublicKey, SecretKey};
use blindbook_mint::{KeysetKind, MasterKey, PublicKeyset, denomination_index, sha256};
use serde::Deserialize;

#[derive(Deserialize)]
struct Golden {
    test_mint_label: String,
    m_pub: String,
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    label: String,
    market_id: String,
    outcome: u8,
    unit: String,
    pubkeys: Vec<String>,
    id_v01: String,
}

fn golden() -> Golden {
    serde_json::from_str(include_str!("data/keysets-js.json")).unwrap()
}

/// The public TEST master key of the vectors: m = SHA256(label) mod n (never a real key).
fn test_master(label: &str) -> MasterKey {
    MasterKey::from_secret(SecretKey::from_slice(&sha256(label.as_bytes())).unwrap())
}

fn kind_of(e: &Entry) -> KeysetKind {
    if e.outcome == 0xFF {
        KeysetKind::Credit
    } else {
        let mut market_id = [0u8; 32];
        market_id.copy_from_slice(&hex::decode(&e.market_id).unwrap());
        KeysetKind::Outcome {
            market_id,
            outcome: e.outcome,
        }
    }
}

#[test]
fn public_keys_and_ids_match_the_browser() {
    let g = golden();
    let m_pub = PublicKey::from_hex(&g.m_pub).unwrap();
    assert_eq!(
        test_master(&g.test_mint_label).public_key(),
        m_pub,
        "test master key"
    );
    for e in &g.entries {
        let kind = kind_of(e);
        assert_eq!(kind.unit(), e.unit, "{}: unit", e.label);
        let ks = PublicKeyset::derive(&m_pub, kind).unwrap();
        for (k, want) in e.pubkeys.iter().enumerate() {
            let got = ks
                .keys
                .amount_key(blindbook_mint::cashu::Amount::from(1u64 << k))
                .unwrap();
            assert_eq!(&got.to_hex(), want, "{}: key for 2^{k}", e.label);
        }
        assert_eq!(ks.id.to_string(), e.id_v01, "{}: v01 keyset id", e.label);
    }
}

#[test]
fn secret_keys_match_public_keys() {
    let g = golden();
    let master = test_master(&g.test_mint_label);
    for e in &g.entries {
        let kind = kind_of(e);
        for k in [0u8, 1, 17, 30] {
            let s = master.derive_secret_key(&kind, k).unwrap();
            assert_eq!(
                s.public_key().to_hex(),
                e.pubkeys[k as usize],
                "{}: m + t_k for 2^{k}",
                e.label
            );
        }
    }
}

#[test]
fn blind_sign_unblind_and_spend() {
    let g = golden();
    let master = test_master(&g.test_mint_label);
    let ks = master.keyset(KeysetKind::Credit).unwrap();
    let secret = b"slip secret from NUT-13";
    let r = SecretKey::from_slice(&sha256(b"blinding factor")).unwrap();
    let (b_, r) = blind_message(secret, Some(r)).unwrap();
    let amount = 1u64 << 12;
    let sig = ks.sign(amount, &b_).unwrap();
    // The wallet checks the DLEQ proof against the key it derived itself from M.
    let key = ks
        .public
        .keys
        .amount_key(blindbook_mint::cashu::Amount::from(amount))
        .unwrap();
    assert!(sig.dleq.is_some(), "every signature carries a DLEQ proof");
    assert!(
        sig.verify_dleq(key, b_).is_ok(),
        "DLEQ proof verifies against the derived key"
    );
    let other = ks
        .public
        .keys
        .amount_key(blindbook_mint::cashu::Amount::from(amount * 2))
        .unwrap();
    assert!(
        sig.verify_dleq(other, b_).is_err(),
        "DLEQ proof fails for another key (no key tagging)"
    );
    let c = unblind_message(&sig.c, &r, &key).unwrap();
    assert!(ks.verify_spend(amount, secret, &c).unwrap(), "valid slip");
    assert!(
        !ks.verify_spend(amount, b"another secret", &c).unwrap(),
        "wrong secret"
    );
    assert!(
        !ks.verify_spend(amount * 2, secret, &c).unwrap(),
        "wrong denomination"
    );
}

#[test]
fn only_power_of_two_denominations() {
    assert_eq!(denomination_index(1).unwrap(), 0);
    assert_eq!(denomination_index(1 << 30).unwrap(), 30);
    assert!(denomination_index(0).is_err());
    assert!(denomination_index(3).is_err());
    assert!(denomination_index(1 << 31).is_err());
}
