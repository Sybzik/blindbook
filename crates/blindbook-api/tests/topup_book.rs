//! The top-up desk's book: a repeated request (a lost answer, or a replay of its proof-of-work)
//! stores nothing new, open requests are capped, and an expired unpaid request drops its blank
//! outputs while a late payment can still be claimed.

use blindbook_api::topup::{CreateError, PRUNE_AFTER, TopupBook, ZeroConfCaps};
use blindbook_indexer::{DepositKeys, Net, Payment, Privacy, TxShape};
use blindbook_ledger::H32;
use blindbook_ledger::wire::BlindedMessage;
use blindbook_mint::sha256;

fn keys() -> DepositKeys {
    let usk = zcash_keys::keys::UnifiedSpendingKey::from_seed(
        &Net::Test,
        &sha256(b"blindbook/test/topups"),
        zip32::AccountId::ZERO,
    )
    .unwrap();
    let uivk = usk
        .to_unified_full_viewing_key()
        .to_unified_incoming_viewing_key()
        .encode(&Net::Test);
    DepositKeys::from_uivk(Net::Test, &uivk).unwrap()
}

fn outputs(seed: u8) -> Vec<BlindedMessage> {
    (0..31u8)
        .map(|i| BlindedMessage {
            amount: 0,
            id: "00".repeat(33),
            b: format!("02{}", blindbook_ledger::hex::encode(&sha256(&[seed, i]))),
        })
        .collect()
}

#[test]
fn repeats_caps_and_pruning() {
    let dir = std::env::temp_dir().join(format!("bb-topups-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let k = keys();
    let mut book = TopupBook::open(
        &dir.join("topups.json"),
        ZeroConfCaps {
            per_topup: 10_000,
            total: 30_000,
        },
    )
    .unwrap();
    let claim = H32(sha256(b"secret-1"));

    let a = book.create(&k, 1_000_000, outputs(1), claim, 100).unwrap();
    let again = book.create(&k, 1_000_000, outputs(1), claim, 101).unwrap();
    assert_eq!(again.id, a.id, "the same request answers the same address");
    assert_eq!(
        book.create(&k, 1_000_000, outputs(2), claim, 101),
        Err(CreateError::Reused)
    );

    book.set_max_open(2);
    book.create(&k, 1_000_000, outputs(3), H32(sha256(b"secret-2")), 100)
        .unwrap();
    assert_eq!(
        book.create(&k, 1_000_000, outputs(4), H32(sha256(b"secret-3")), 100),
        Err(CreateError::Busy)
    );
    // Once they expire, there is room again.
    assert!(
        book.create(
            &k,
            1_000_000,
            outputs(4),
            H32(sha256(b"secret-3")),
            a.expires_height
        )
        .is_ok()
    );

    // A day after expiry the unpaid request drops its outputs; a late payment waits for a claim.
    book.set_scanned(a.expires_height + PRUNE_AFTER);
    assert!(book.get(&a.id).unwrap().outputs.is_empty());
    let late = Payment {
        txid: "ab".repeat(32),
        action: 0,
        pool: "ironwood".into(),
        value_zat: 1_000_000,
        index: u128::from(a.index),
        shape: TxShape::default(),
        privacy: Privacy::Shielded,
    };
    assert!(
        book.on_payment(&late, Some(a.expires_height + PRUNE_AFTER + 1))
            .is_none()
    );
    let job = book.claim(&a.id, "secret-1", outputs(9)).unwrap();
    assert_eq!(job.units, 1_000);
    assert_eq!(job.outputs, outputs(9));
    std::fs::remove_dir_all(&dir).unwrap();
}
