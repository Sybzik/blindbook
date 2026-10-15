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
    let first = st.serve(&op, 0).unwrap();
    assert_eq!(first.signatures.len(), 6, "1,000 = 512+256+128+64+32+8");
    let again = st.serve(&op, 0).unwrap();
    assert_eq!(again, first);
    assert_eq!(st.applied, 1);
    assert_eq!(st.signer.ledger.outstanding(Keyset::Credit), 1_000);
    drop(st);

    // After a restart the journal still answers the repeat.
    let mut st = Station::open(signer(), &journal).unwrap();
    assert_eq!(st.applied, 1);
    assert_eq!(st.signer.ledger.outstanding(Keyset::Credit), 1_000);
    assert_eq!(st.serve(&op, 0).unwrap(), first);
    assert_eq!(st.applied, 1);
    assert_eq!(st.hello().applied, 1);
    // The voucher is spent for good.
    let journal_text = std::fs::read_to_string(&journal).unwrap();
    assert_eq!(journal_text.lines().count(), 1);
    std::fs::remove_dir_all(&dir).unwrap();
}

/// One judge code shared by the judges: redeemable as many times as it was given, then refused,
/// and a restart (the journal replayed) doesn't give the used redemptions back.
#[test]
fn a_shared_voucher_is_redeemed_as_many_times_as_it_was_given() {
    let dir = std::env::temp_dir().join(format!("bb-station-uses-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let journal = dir.join("signer-journal.jsonl");
    let shared = || {
        let mut s = signer();
        s.add_voucher_uses([(H32(sha256(b"SHARED")), 2)], 1_000);
        s
    };
    let credit = shared().credit_id();
    let op = |seed: u8| Op::Credit {
        amount: 1_000,
        outputs: (0..31u8)
            .map(|i| BlindedMessage {
                amount: 0,
                id: credit.clone(),
                b: blind_message(&[seed, i, 0, 0, 0, 0, 0, 0], None)
                    .unwrap()
                    .0
                    .to_hex(),
            })
            .collect(),
        claim: CreditClaim::Voucher {
            code_hash: H32(sha256(b"SHARED")),
        },
    };
    let mut st = Station::open(shared(), &journal).unwrap();
    assert_eq!(st.serve(&op(1), 0).unwrap().signatures.len(), 6);
    drop(st);
    let mut st = Station::open(shared(), &journal).unwrap();
    assert_eq!(st.serve(&op(2), 1).unwrap().signatures.len(), 6);
    let used_up = st.serve(&op(3), 2).unwrap();
    assert!(used_up.signatures.is_empty() && !used_up.invalid.is_empty());
    assert_eq!(st.signer.ledger.outstanding(Keyset::Credit), 2_000);
    std::fs::remove_dir_all(&dir).unwrap();
}

/// An operation identical to the last one, sent at the next place, is a new operation, not a repeat
/// (a treasury event re-announced and sent twice): here the second record is refused, because the
/// event is no longer pending, and nothing is applied twice. A place that is neither the next one
/// nor the last one is out of step.
#[test]
fn an_identical_operation_at_the_next_place_is_new() {
    use blindbook_ledger::delta::{ChainStats, LogEvent};
    use blindbook_ledger::ops::OUT_OF_STEP;
    let dir = std::env::temp_dir().join(format!("bb-station-next-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut st = Station::open(signer(), &dir.join("signer-journal.jsonl")).unwrap();
    let event = LogEvent::ReserveReported {
        height: 7,
        reserve_zat: 0,
        unswept_zat: 0,
    };
    st.signer.report_event(event.clone());
    let op = Op::Record { event };
    let first = st.serve(&op, 0).unwrap();
    assert!(first.invalid.is_empty(), "recorded");
    assert_eq!(st.applied, 1);
    // The same operation asked again at its own place: the same answer.
    assert_eq!(st.serve(&op, 0).unwrap(), first);
    // The same operation at the next place: new, and refused (the event was recorded).
    let second = st.serve(&op, 1).unwrap();
    assert_eq!(second.invalid, vec![0], "refused, not applied again");
    assert_eq!(st.applied, 1);
    // Places the signer never reached are out of step, and so is another operation at a place
    // already taken.
    assert!(st.serve(&op, 5).unwrap_err().starts_with(OUT_OF_STEP));
    let close = Op::Close {
        height: 8,
        chain: ChainStats {
            shielded_actions: 0,
        },
    };
    assert!(
        st.serve(&close, 0).unwrap_err().starts_with(OUT_OF_STEP),
        "not the operation applied at 0"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
