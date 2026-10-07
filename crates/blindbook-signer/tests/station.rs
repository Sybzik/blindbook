//! The signer's journal and its answer to a repeated operation (an answer lost on the way back):
//! applied once, the same reply every time, also after a restart.

use blindbook_ledger::H32;
use blindbook_ledger::keysets::Keyset;
use blindbook_ledger::ops::{CreditClaim, Op};
use blindbook_ledger::wire::BlindedMessage;
use blindbook_mint::cashu::SecretKey;
use blindbook_mint::cashu::dhke::blind_message;
use blindbook_mint::{MasterKey, sha256};
use blindbook_signer::Signer;
use blindbook_signer::link::Station;

fn signer() -> Signer {
    let mut s = Signer::new(MasterKey::from_secret(
        SecretKey::from_slice(&sha256(b"blindbook/test-station")).unwrap(),
    ))
    .unwrap();
    s.add_vouchers([H32(sha256(b"CODE"))], 1_000);
    s
}

#[test]
fn a_repeat_is_answered_from_the_journal_not_applied_twice() {
    let dir = std::env::temp_dir().join(format!("bb-station-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let journal = dir.join("signer-journal.jsonl");

    let s = signer();
    let credit = s.credit_id();
    let outputs: Vec<BlindedMessage> = (0..31u8)
        .map(|i| BlindedMessage {
            amount: 0,
            id: credit.clone(),
            b: blind_message(&[i; 8], None).unwrap().0.to_hex(),
        })
        .collect();
    let op = Op::Credit {
        amount: 1_000,
        outputs,
        claim: CreditClaim::Voucher {
            code_hash: H32(sha256(b"CODE")),
        },
    };

    let mut st = Station::open(s, &journal).unwrap();
    let first = st.serve(&op).unwrap();
    assert_eq!(first.signatures.len(), 6, "1,000 = 512+256+128+64+32+8");
    let again = st.serve(&op).unwrap();
    assert_eq!(again, first);
    assert_eq!(st.applied, 1);
    assert_eq!(st.signer.ledger.outstanding(Keyset::Credit), 1_000);
    drop(st);

    // After a restart the journal still answers the repeat.
    let mut st = Station::open(signer(), &journal).unwrap();
    assert_eq!(st.applied, 1);
    assert_eq!(st.signer.ledger.outstanding(Keyset::Credit), 1_000);
    assert_eq!(st.serve(&op).unwrap(), first);
    assert_eq!(st.applied, 1);
    assert_eq!(st.hello().applied, 1);
    // The voucher is spent for good.
    let journal_text = std::fs::read_to_string(&journal).unwrap();
    assert_eq!(journal_text.lines().count(), 1);
    std::fs::remove_dir_all(&dir).unwrap();
}
