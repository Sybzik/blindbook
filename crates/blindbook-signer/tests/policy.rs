//! What the signer accepts from the API without a slip to check: a listing only with the
//! network's parameters, a resolution only if it matches the result the signer read from
//! Polygon itself.

use blindbook_ledger::H32;
use blindbook_ledger::ledger::{MarketEntry, MarketParams, MarketStatus, Pool, Reject};
use blindbook_ledger::ops::{Applied, Op};
use blindbook_mint::cashu::SecretKey;
use blindbook_mint::{KeysetKind, MasterKey, PublicKeyset, sha256};
use blindbook_signer::Signer;

const MARKET: H32 = H32([0x42; 32]);

fn signer() -> Signer {
    let mut s = Signer::new(MasterKey::from_secret(
        SecretKey::from_slice(&sha256(b"blindbook/test-policy")).unwrap(),
    ))
    .unwrap();
    s.set_listing_params(MarketParams::testnet());
    s.require_confirmed_resolutions();
    s
}

fn listing(s: &Signer, params: MarketParams) -> Op {
    let id = |outcome| {
        PublicKeyset::derive(
            &s.public_key(),
            KeysetKind::Outcome {
                market_id: MARKET.0,
                outcome,
            },
        )
        .unwrap()
        .id
        .to_string()
    };
    Op::ListMarket {
        entry: MarketEntry {
            id: MARKET,
            params,
            event_start_ms: None,
            end_ms: 1_000,
            pool: Pool::default(),
            status: MarketStatus::Open,
        },
        keysets: [id(0), id(1)],
    }
}

fn resolve(den: u64, num: [u64; 2]) -> Op {
    Op::Resolve {
        market: MARKET,
        den,
        num,
        polygon_block: 1,
        polygon_tx: None,
    }
}

#[test]
fn a_listing_with_other_parameters_is_refused() {
    let mut s = signer();
    let wide = MarketParams {
        l: MarketParams::testnet().l * 100,
        ..MarketParams::testnet()
    };
    let (reply, applied) = s.handle(&listing(&s, wide)).unwrap();
    assert_eq!(reply.invalid, vec![0]);
    assert_eq!(applied, Applied::Refused(Reject::NotConfirmed));
    assert!(s.ledger.markets.is_empty());

    let (reply, _) = s.handle(&listing(&s, MarketParams::testnet())).unwrap();
    assert!(reply.invalid.is_empty());
    assert!(s.ledger.markets.contains_key(&MARKET));
}

#[test]
fn a_resolution_counts_only_if_the_signer_read_the_same_from_polygon() {
    let mut s = signer();
    s.handle(&listing(&s, MarketParams::testnet())).unwrap();
    assert_eq!(s.unconfirmed_due(500), vec![], "not past its end yet");
    assert_eq!(s.unconfirmed_due(2_000), vec![MARKET]);

    // Nothing read yet: refused.
    let (reply, applied) = s.handle(&resolve(1, [1, 0])).unwrap();
    assert_eq!(reply.invalid, vec![0]);
    assert_eq!(applied, Applied::Refused(Reject::NotConfirmed));
    assert_eq!(s.ledger.markets[&MARKET].status, MarketStatus::Open);

    // Polygon says B won: A winning is refused, B winning goes through.
    s.confirm_resolution(MARKET, 1, [0, 1]);
    assert_eq!(s.unconfirmed_due(2_000), vec![]);
    let (reply, _) = s.handle(&resolve(1, [1, 0])).unwrap();
    assert_eq!(reply.invalid, vec![0]);
    assert_eq!(s.ledger.markets[&MARKET].status, MarketStatus::Open);
    let (reply, _) = s.handle(&resolve(1, [0, 1])).unwrap();
    assert!(reply.invalid.is_empty());
    assert_eq!(
        s.ledger.markets[&MARKET].status,
        MarketStatus::Resolved {
            den: 1,
            num: [0, 1]
        }
    );
}
