//! End to end with real curve math: a wallet blinds outputs, the signer checks and signs, the
//! wallet unblinds and checks each DLEQ proof against keys it derived itself from `M`, and an API
//! replica applying the same operations with the signer's exclusions stays identical.

use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;

use blindbook_ledger::H32;
use blindbook_ledger::keysets::{Keyset, KeysetIds};
use blindbook_ledger::ledger::{
    FillStatus, Ledger, MarketEntry, MarketInputs, MarketParams, MarketStatus, Pool, Reject, Side,
    TradeRequest, WITHDRAWAL_FEE,
};
use blindbook_ledger::ops::{self, Applied, CreditClaim, Op};
use blindbook_ledger::reference::RefSnapshot;
use blindbook_ledger::wire::{self, BlindedMessage, Input, Proof};
use blindbook_mint::cashu::dhke::{blind_message, unblind_message};
use blindbook_mint::cashu::nuts::nut12::BlindSignatureDleq;
use blindbook_mint::cashu::{Amount, BlindSignature, Id, PublicKey, SecretKey};
use blindbook_mint::{KeysetKind, MasterKey, PublicKeyset, sha256};
use blindbook_signer::{Deposit, Signer};

const MARKET: H32 = H32([0x42; 32]);

fn master() -> MasterKey {
    MasterKey::from_secret(SecretKey::from_slice(&sha256(b"blindbook/test-signer")).unwrap())
}

fn kind(k: Keyset) -> KeysetKind {
    match k {
        Keyset::Credit => KeysetKind::Credit,
        Keyset::Outcome { market, outcome } => KeysetKind::Outcome {
            market_id: market.0,
            outcome,
        },
    }
}

/// A wallet that knows only `M`.
struct Wallet {
    keys: HashMap<String, PublicKeyset>,
    pending: HashMap<String, (String, SecretKey)>,
    slips: Vec<Input>,
    n: u64,
}

impl Wallet {
    fn new(m: &PublicKey, kinds: &[Keyset]) -> Self {
        let keys = kinds
            .iter()
            .map(|&k| {
                let ks = PublicKeyset::derive(m, kind(k)).unwrap();
                (ks.id.to_string(), ks)
            })
            .collect();
        Wallet {
            keys,
            pending: HashMap::new(),
            slips: Vec::new(),
            n: 0,
        }
    }

    fn id(&self, k: Keyset) -> String {
        self.keys
            .iter()
            .find(|(_, v)| v.kind == kind(k))
            .unwrap()
            .0
            .clone()
    }

    fn blank(&mut self, k: Keyset) -> Vec<BlindedMessage> {
        let id = self.id(k);
        (0..31)
            .map(|_| {
                self.n += 1;
                let secret = format!("{:064x}", u128::from(self.n) * 0x9e37_79b9_7f4a_7c15);
                let (b, r) = blind_message(secret.as_bytes(), None).unwrap();
                self.pending.insert(b.to_hex(), (secret, r));
                BlindedMessage {
                    amount: 0,
                    id: id.clone(),
                    b: b.to_hex(),
                }
            })
            .collect()
    }

    /// Unblind the signatures for these jobs, checking every DLEQ against our own keys.
    fn receive(&mut self, applied: &Applied, sigs: &[wire::BlindSignature]) {
        let jobs = applied.jobs();
        assert_eq!(jobs.len(), sigs.len());
        for (job, sig) in jobs.into_iter().zip(sigs) {
            let ks = &self.keys[&sig.id];
            let k = ks.keys.amount_key(Amount::from(sig.amount)).unwrap();
            let b = PublicKey::from_hex(&job.b).unwrap();
            let c_ = PublicKey::from_hex(&sig.c).unwrap();
            let cashu_sig = BlindSignature {
                amount: Amount::from(sig.amount),
                keyset_id: Id::from_str(&sig.id).unwrap(),
                c: c_,
                dleq: Some(BlindSignatureDleq {
                    e: SecretKey::from_hex(&sig.dleq.e).unwrap(),
                    s: SecretKey::from_hex(&sig.dleq.s).unwrap(),
                }),
            };
            cashu_sig
                .verify_dleq(k, b)
                .expect("DLEQ against the key derived from M");
            let (secret, r) = self.pending.remove(&job.b).unwrap();
            let c = unblind_message(&c_, &r, &k).unwrap();
            self.slips.push(Input {
                y: blindbook_mint::y_hex(&secret).unwrap(),
                proof: Proof {
                    amount: sig.amount,
                    id: sig.id.clone(),
                    secret,
                    c: c.to_hex(),
                },
            });
        }
    }

    fn balance(&self, k: Keyset) -> u64 {
        let id = self.id(k);
        self.slips
            .iter()
            .filter(|s| s.proof.id == id)
            .map(|s| s.proof.amount)
            .sum()
    }

    fn take_all(&mut self, k: Keyset) -> Vec<Input> {
        let id = self.id(k);
        let (take, keep) = self.slips.drain(..).partition(|s| s.proof.id == id);
        self.slips = keep;
        take
    }
}

/// The signer and an API replica, fed the same operations.
struct Pair {
    signer: Signer,
    api: Ledger,
}

impl Pair {
    fn run(&mut self, op: &Op) -> (Applied, Vec<wire::BlindSignature>, Vec<usize>) {
        let (reply, applied) = self.signer.handle(op).unwrap();
        let api = ops::apply(&mut self.api, op, &reply.invalid);
        assert_eq!(api, applied, "replicas agree");
        assert_eq!(self.api.spent, self.signer.ledger.spent);
        assert_eq!(self.api.issued, self.signer.ledger.issued);
        assert_eq!(self.api.markets, self.signer.ledger.markets);
        // The signatures line up with the API's own jobs.
        for (j, s) in api.jobs().iter().zip(&reply.signatures) {
            assert_eq!((j.id.as_str(), j.amount), (s.id.as_str(), s.amount));
        }
        (applied, reply.signatures, reply.invalid)
    }
}

fn reference() -> BTreeMap<H32, MarketInputs> {
    BTreeMap::from([(
        MARKET,
        MarketInputs {
            reference: RefSnapshot {
                at_ms: 0,
                mid_samples: vec![550_000; 30],
                mid_ppm: 550_000,
                ask_ppm: [555_000, 455_000],
                bid_ppm: [545_000, 445_000],
                guard_micro: 500_000_000,
                best_bid_ppm: [545_000, 445_000],
                best_ask_ppm: [555_000, 455_000],
                server_ts_ms: [0; 2],
                unhealthy_ms: 0,
            },
            closed: false,
            accepting_orders: true,
        },
    )])
}

#[test]
fn signer_and_api_replica_end_to_end() {
    let signer = Signer::new(master()).unwrap();
    let m = signer.public_key();
    let a = Keyset::Outcome {
        market: MARKET,
        outcome: 0,
    };
    let b = Keyset::Outcome {
        market: MARKET,
        outcome: 1,
    };
    let mut w = Wallet::new(&m, &[Keyset::Credit, a, b]);
    // The API derives the same ids from M (it holds no secret).
    let mut ids = KeysetIds::default();
    ids.insert(Keyset::Credit, w.id(Keyset::Credit));
    assert_eq!(signer.credit_id(), w.id(Keyset::Credit));
    let mut pair = Pair {
        signer,
        api: Ledger::new(ids),
    };
    let voucher = H32(sha256(b"JUDGE-0001"));
    pair.signer.add_vouchers([voucher], 50_000);

    // List the market; a wrong keyset id is refused.
    let entry = MarketEntry {
        id: MARKET,
        params: MarketParams::testnet(),
        event_start_ms: None,
        end_ms: u64::MAX,
        pool: Pool::default(),
        status: MarketStatus::Open,
    };
    let bad = Op::ListMarket {
        entry: entry.clone(),
        keysets: [w.id(b), w.id(a)],
    };
    assert!(pair.signer.handle(&bad).is_err());
    pair.run(&Op::ListMarket {
        entry,
        keysets: [w.id(a), w.id(b)],
    });

    // Voucher → 50,000 units of CREDIT; the same voucher twice is refused.
    let credit = |w: &mut Wallet, amount| Op::Credit {
        amount,
        outputs: w.blank(Keyset::Credit),
        claim: CreditClaim::Voucher { code_hash: voucher },
    };
    let op = credit(&mut w, 50_000);
    let (applied, sigs, _) = pair.run(&op);
    w.receive(&applied, &sigs);
    assert_eq!(w.balance(Keyset::Credit), 50_000);
    let again = credit(&mut w, 50_000);
    let (applied, _, invalid) = pair.run(&again);
    assert_eq!(applied, Applied::Refused(Reject::InvalidClaim));
    assert_eq!(invalid, vec![0]);

    // A top-up is credited only once the signer's own indexer saw it.
    let topup = |w: &mut Wallet| Op::Credit {
        amount: 10_000,
        outputs: w.blank(Keyset::Credit),
        claim: CreditClaim::Topup {
            diversifier_index: 7,
            txid: "ab".repeat(32),
        },
    };
    let op = topup(&mut w);
    assert_eq!(pair.run(&op).0, Applied::Refused(Reject::InvalidClaim));
    pair.signer.deposit_seen(Deposit {
        diversifier_index: 7,
        amount: 10_000,
        txid: "ab".repeat(32),
        confirmed: false,
    });
    let op = topup(&mut w);
    let (applied, sigs, _) = pair.run(&op);
    w.receive(&applied, &sigs);
    assert_eq!(w.balance(Keyset::Credit), 60_000);

    // A batch with one honest buy and one forged slip.
    let mut inputs = w.take_all(Keyset::Credit);
    inputs.sort_by_key(|i| i.proof.amount);
    let honest = TradeRequest {
        market: MARKET,
        side: Side::Buy,
        outcome: 0,
        limit_bp: 9_000,
        amount: 15_000,
        inputs: inputs.clone(),
        outputs: w.blank(a),
        change_outputs: w.blank(Keyset::Credit),
        tag: H32(sha256(b"called-it secret 1")),
    };
    let mut forged_input = inputs[0].clone();
    forged_input.proof.secret = "forged".into();
    forged_input.y = blindbook_mint::y_hex("forged").unwrap();
    let forged = TradeRequest {
        inputs: vec![forged_input],
        amount: inputs[0].proof.amount,
        outputs: w.blank(b),
        change_outputs: w.blank(Keyset::Credit),
        outcome: 1,
        tag: H32(sha256(b"called-it secret 2")),
        ..honest.clone()
    };
    let op = Op::Trades {
        batch_id: 1,
        now_ms: 1_000,
        reqs: vec![forged, honest],
        refs: reference(),
    };
    let (applied, sigs, invalid) = pair.run(&op);
    assert_eq!(invalid, vec![0]);
    let Applied::Trades(res) = &applied else {
        panic!()
    };
    assert_eq!(res.outcomes[0].result, Err(Reject::InvalidSlip));
    let fill = res.outcomes[1].result.clone().unwrap();
    // 0.15 TAZ at 0.55 is more than the 0.05 TAZ buffer allows: the invariant shrinks it.
    assert_eq!(fill.status, FillStatus::Shrunk);
    assert!(fill.refund > 0 && fill.out > 0);
    w.receive(&applied, &sigs);
    assert_eq!(w.balance(a), fill.out);
    assert_eq!(
        w.balance(Keyset::Credit),
        60_000 - 15_000 + fill.refund,
        "the unspent 45,000 came back as change"
    );
    assert_eq!(
        res.records[0].orders.len(),
        1,
        "the forged order never reached the log"
    );

    // Sell half the shares.
    let shares = w.take_all(a);
    let total: u64 = shares.iter().map(|s| s.proof.amount).sum();
    let op = Op::Trades {
        batch_id: 2,
        now_ms: 3_000,
        reqs: vec![TradeRequest {
            market: MARKET,
            side: Side::Sell,
            outcome: 0,
            limit_bp: 1,
            amount: total / 2,
            inputs: shares,
            outputs: w.blank(Keyset::Credit),
            change_outputs: w.blank(a),
            tag: H32(sha256(b"called-it secret 3")),
        }],
        refs: reference(),
    };
    let (applied, sigs, _) = pair.run(&op);
    w.receive(&applied, &sigs);
    assert_eq!(w.balance(a), total - total / 2);

    // Resolve: A wins. Redeem.
    pair.run(&Op::Resolve {
        market: MARKET,
        den: 1,
        num: [1, 0],
        polygon_block: 95_078_144,
        polygon_tx: None,
    });
    let shares = w.take_all(a);
    let left: u64 = shares.iter().map(|s| s.proof.amount).sum();
    let before = w.balance(Keyset::Credit);
    let op = Op::Redeem {
        inputs: shares,
        outputs: w.blank(Keyset::Credit),
    };
    let (applied, sigs, _) = pair.run(&op);
    assert!(matches!(applied, Applied::Redeemed { paid, .. } if paid == left));
    w.receive(&applied, &sigs);
    assert_eq!(w.balance(Keyset::Credit), before + left);

    // Withdraw 0.1 TAZ; a replayed withdrawal finds its slips spent.
    let inputs = w.take_all(Keyset::Credit);
    let sum: u64 = inputs.iter().map(|s| s.proof.amount).sum();
    let op = Op::Withdraw {
        inputs: inputs.clone(),
        amount: 10_000,
        change: w.blank(Keyset::Credit),
        commitment: H32(sha256(b"address || salt")),
        sealed: "sealed-box".into(),
    };
    let (applied, sigs, _) = pair.run(&op);
    w.receive(&applied, &sigs);
    assert_eq!(w.balance(Keyset::Credit), sum - 10_000 - WITHDRAWAL_FEE);
    let (replayed, _, _) = pair.run(&op);
    assert_eq!(replayed, Applied::Refused(Reject::Spent));
    assert_eq!(
        pair.signer.ledger.outstanding(Keyset::Credit),
        w.balance(Keyset::Credit)
    );
}
