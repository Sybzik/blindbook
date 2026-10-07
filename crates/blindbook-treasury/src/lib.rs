//! The treasury (PROTOCOL section 10), run by the signer only: it holds the spending keys.
//!
//! Two ZIP 32 accounts from one seed:
//! - **deposit** (account 0): one-time top-up addresses live here; the API holds only its
//!   incoming viewing key;
//! - **reserve** (account 1): everything users can claim. Its viewing key can be published for
//!   the solvency check without revealing a single top-up, because deposits reach it only through
//!   periodic sweeps.
//!
//! Transactions:
//! - **sweep:** all spendable deposit notes → the reserve;
//! - **payout:** always exactly 8 Ironwood actions (≤ 7 recipients, zero-value padding to fresh
//!   throwaway addresses, one change output), built with `OvkPolicy::Discard`, so even the
//!   reserve's viewing key can't see who was paid or how much (verified in `spikes/g-payout`);
//! - **anchor:** a zero-value self-payment with the memo `bb1:anchor:<height>:<root-hex>`.

use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::Arc;

use nonempty::NonEmpty;
use secrecy::{ExposeSecret, SecretVec};
use tokio::sync::Mutex as AsyncMutex;
use zcash_address::unified::{self, Encoding, Receiver, Revision};
use zcash_address::{ToAddress, ZcashAddress};
use zcash_client_backend::data_api::chain::{BlockCache, BlockSource, error as chain_error};
use zcash_client_backend::data_api::locking::LockFilter;
use zcash_client_backend::data_api::scanning::ScanRange;
use zcash_client_backend::data_api::wallet::TargetHeight;
use zcash_client_backend::data_api::wallet::input_selection::{GreedyInputSelector, SpendPolicy};
use zcash_client_backend::data_api::wallet::{
    ConfirmationsPolicy, SpendingKeys, create_proposed_transactions, propose_send_max_transfer,
    propose_transfer,
};
use zcash_client_backend::data_api::{
    Account, AccountBirthday, InputSource, MaxSpendMode, TargetValue, WalletRead, WalletWrite,
};
use zcash_client_backend::fees::standard::MultiOutputChangeStrategy;
use zcash_client_backend::fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule};
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_client_backend::proto::service::{self, BlockId};
use zcash_client_backend::wallet::OvkPolicy;
use zcash_client_sqlite::WalletDb;
use zcash_client_sqlite::util::SystemClock;
use zcash_client_sqlite::wallet::init::init_wallet_db;
use zcash_keys::address::UnifiedAddress;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_primitives::transaction::TxId;
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::ShieldedPool;
use zcash_protocol::consensus::{BlockHeight, Parameters};
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::value::Zatoshis;
use zip321::{Payment, TransactionRequest};

use blindbook_indexer::Net;
use blindbook_indexer::follow::Client;

pub type OsRng = rand_core::UnwrapErr<rand::rngs::SysRng>;
#[allow(non_upper_case_globals)]
pub const OsRng: OsRng = rand_core::UnwrapErr(rand::rngs::SysRng);

type Db = WalletDb<rusqlite::Connection, Net, SystemClock, OsRng>;

/// Every payout has exactly this many outputs (recipients + padding) besides the change.
pub const PAYOUT_OUTPUTS: usize = 7;

/// Notes the wallet made itself are spendable after 1 confirmation, received ones (deposits)
/// after 3, so a payout waits about one block and a sweep about three.
fn confirmations() -> ConfirmationsPolicy {
    ConfirmationsPolicy::new(
        std::num::NonZeroU32::MIN,
        std::num::NonZeroU32::new(3).expect("nonzero"),
    )
    .expect("trusted <= untrusted")
}

#[derive(Debug, thiserror::Error)]
#[error("treasury: {0}")]
pub struct Error(pub String);

fn err<E: std::fmt::Debug>(e: E) -> Error {
    Error(format!("{e:?}"))
}

/// An in-memory compact block cache for `zcash_client_backend::sync::run`.
#[derive(Default, Clone)]
pub struct MemCache {
    blocks: Arc<std::sync::Mutex<Vec<CompactBlock>>>,
}

#[derive(Debug, thiserror::Error)]
#[error("cache")]
pub struct CacheError;

impl BlockSource for MemCache {
    type Error = CacheError;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), chain_error::Error<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), chain_error::Error<WalletErrT, Self::Error>>,
    {
        let mut blocks: Vec<CompactBlock> = self
            .blocks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|b| from_height.is_none_or(|h| b.height >= u64::from(h)))
            .cloned()
            .collect();
        blocks.sort_by_key(|b| b.height);
        for b in blocks.into_iter().take(limit.unwrap_or(usize::MAX)) {
            with_block(b)?;
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl BlockCache for MemCache {
    fn get_tip_height(
        &self,
        range: Option<&ScanRange>,
    ) -> Result<Option<BlockHeight>, Self::Error> {
        Ok(self
            .blocks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|b| {
                range.is_none_or(|r| {
                    r.block_range()
                        .contains(&BlockHeight::from_u32(b.height as u32))
                })
            })
            .map(|b| BlockHeight::from_u32(b.height as u32))
            .max())
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let mut v: Vec<CompactBlock> = self
            .blocks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|b| {
                range
                    .block_range()
                    .contains(&BlockHeight::from_u32(b.height as u32))
            })
            .cloned()
            .collect();
        v.sort_by_key(|b| b.height);
        Ok(v)
    }

    async fn insert(&self, mut blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        self.blocks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .append(&mut blocks);
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        self.blocks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|b| {
                !range
                    .block_range()
                    .contains(&BlockHeight::from_u32(b.height as u32))
            });
        Ok(())
    }
}

/// Spendable balances in zatoshi.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Balances {
    pub deposit_spendable: u64,
    pub reserve_spendable: u64,
    /// Including notes not spendable yet (unconfirmed change, fresh sweeps).
    pub reserve_total: u64,
}

pub struct Treasury {
    db: Db,
    net: Net,
    cache: MemCache,
    deposit: zcash_client_sqlite::AccountUuid,
    reserve: zcash_client_sqlite::AccountUuid,
    usk_deposit: UnifiedSpendingKey,
    usk_reserve: UnifiedSpendingKey,
    prover: Arc<LocalTxProver>,
    /// One transaction at a time.
    lock: Arc<AsyncMutex<()>>,
}

/// A fresh address whose key is thrown away: zero-value padding in payouts.
fn throwaway_address(net: &Net) -> Result<ZcashAddress, Error> {
    let mut seed = [0u8; 32];
    rand::fill(&mut seed);
    let sk = orchard::keys::SpendingKey::from_zip32_seed(&seed, 1, zip32::AccountId::ZERO)
        .map_err(err)?;
    let fvk = orchard::keys::FullViewingKey::from(&sk);
    let raw = fvk
        .address_at(0u32, zip32::Scope::External)
        .to_raw_address_bytes();
    let ua = unified::Address::try_from_items(
        Revision::R0,
        vec![unified::Uitem::Data(Receiver::Orchard(raw))],
    )
    .map_err(err)?;
    Ok(ZcashAddress::from_unified(net.network_type(), ua))
}

async fn birthday(client: &mut Client, height: u64) -> Result<AccountBirthday, Error> {
    let tree = client
        .get_tree_state(BlockId {
            height: height.saturating_sub(1),
            hash: vec![],
        })
        .await
        .map_err(err)?
        .into_inner();
    AccountBirthday::from_treestate(tree, None).map_err(err)
}

impl Treasury {
    /// Open the wallet in `dir` (creating the two accounts on first use, with `birthday_height`).
    pub async fn open(
        dir: &Path,
        net: Net,
        seed: SecretVec<u8>,
        birthday_height: u64,
        client: &mut Client,
    ) -> Result<Self, Error> {
        std::fs::create_dir_all(dir).map_err(err)?;
        let mut db = WalletDb::for_path(dir.join("treasury.sqlite"), net, SystemClock, OsRng)
            .map_err(err)?;
        init_wallet_db(&mut db, Some(SecretVec::new(seed.expose_secret().clone()))).map_err(err)?;
        let mut ids = db.get_account_ids().map_err(err)?;
        if ids.is_empty() {
            let b = birthday(client, birthday_height).await?;
            db.create_account("deposit", &seed, &b, None).map_err(err)?;
            db.create_account("reserve", &seed, &b, None).map_err(err)?;
            ids = db.get_account_ids().map_err(err)?;
        }
        let mut deposit = None;
        let mut reserve = None;
        for id in ids {
            let a = db
                .get_account(id)
                .map_err(err)?
                .ok_or_else(|| Error("account".into()))?;
            match a.name() {
                Some("deposit") => {
                    deposit = Some((id, a.source().key_derivation().map(|d| d.account_index())))
                }
                Some("reserve") => {
                    reserve = Some((id, a.source().key_derivation().map(|d| d.account_index())))
                }
                _ => {}
            }
        }
        let (deposit, d_idx) = deposit.ok_or_else(|| Error("no deposit account".into()))?;
        let (reserve, r_idx) = reserve.ok_or_else(|| Error("no reserve account".into()))?;
        let usk = |idx: Option<zip32::AccountId>| {
            UnifiedSpendingKey::from_seed(
                &net,
                seed.expose_secret(),
                idx.ok_or_else(|| Error("not a seed account".into()))?,
            )
            .map_err(err)
        };
        Ok(Treasury {
            usk_deposit: usk(d_idx)?,
            usk_reserve: usk(r_idx)?,
            db,
            net,
            cache: MemCache::default(),
            deposit,
            reserve,
            prover: Arc::new(LocalTxProver::bundled()),
            lock: Arc::new(AsyncMutex::new(())),
        })
    }

    /// The deposit account's incoming viewing key, for the API (`uivktest1…`).
    pub fn deposit_uivk(&self) -> String {
        self.usk_deposit
            .to_unified_full_viewing_key()
            .to_unified_incoming_viewing_key()
            .encode(&self.net)
    }

    /// The deposit account's full viewing key, for the signer's own indexer.
    pub fn deposit_ufvk(&self) -> String {
        self.usk_deposit
            .to_unified_full_viewing_key()
            .encode(&self.net)
    }

    /// The reserve's full viewing key: publishable for the solvency check.
    pub fn reserve_ufvk(&self) -> String {
        self.usk_reserve
            .to_unified_full_viewing_key()
            .encode(&self.net)
    }

    /// The reserve's address (Revision 0, Orchard receiver), for buffer funding.
    pub fn reserve_address(&mut self) -> Result<String, Error> {
        let ua = self.address_of(self.reserve)?;
        Ok(r0(&ua, &self.net))
    }

    fn address_of(
        &mut self,
        account: zcash_client_sqlite::AccountUuid,
    ) -> Result<UnifiedAddress, Error> {
        let (ua, _) = self
            .db
            .get_next_available_address(account, UnifiedAddressRequest::ORCHARD)
            .map_err(err)?
            .ok_or_else(|| Error("no address".into()))?;
        Ok(ua)
    }

    /// Bring the wallet up to the chain tip.
    pub async fn sync(&mut self, client: &mut Client) -> Result<(), Error> {
        zcash_client_backend::sync::run(client, &self.net, &self.cache, &mut self.db, 1_000)
            .await
            .map_err(err)
    }

    pub fn balances(&self) -> Result<Balances, Error> {
        let Some(s) = self.db.get_wallet_summary(confirmations()).map_err(err)? else {
            return Ok(Balances::default());
        };
        let spendable = |id| {
            s.account_balances().get(&id).map_or(0, |b| {
                b.ironwood_balance().spendable_value().into_u64()
                    + b.orchard_balance().spendable_value().into_u64()
            })
        };
        let total = |id| {
            s.account_balances().get(&id).map_or(0, |b| {
                b.ironwood_balance().total().into_u64() + b.orchard_balance().total().into_u64()
            })
        };
        Ok(Balances {
            deposit_spendable: spendable(self.deposit),
            reserve_spendable: spendable(self.reserve),
            reserve_total: total(self.reserve),
        })
    }

    async fn broadcast_all(
        &mut self,
        client: &mut Client,
        txids: NonEmpty<TxId>,
    ) -> Result<TxId, Error> {
        if txids.len() > 1 {
            return Err(Error("a multi-transaction proposal".into()));
        }
        self.broadcast(client, *txids.first()).await
    }

    /// Send a transaction the wallet built (again, if needed: a repeat is harmless).
    pub async fn broadcast(&mut self, client: &mut Client, txid: TxId) -> Result<TxId, Error> {
        let tx = self
            .db
            .get_transaction(txid)
            .map_err(err)?
            .ok_or_else(|| Error("transaction vanished".into()))?;
        let mut raw = service::RawTransaction::default();
        tx.write(&mut raw.data).map_err(err)?;
        let r = client
            .send_transaction(raw)
            .await
            .map_err(err)?
            .into_inner();
        if r.error_code != 0 && !r.error_message.to_lowercase().contains("already") {
            return Err(Error(format!(
                "rejected: {} {}",
                r.error_code, r.error_message
            )));
        }
        Ok(txid)
    }

    fn change_strategy(notes: usize) -> MultiOutputChangeStrategy<Db> {
        MultiOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Orchard,
            DustOutputPolicy::default(),
            SplitPolicy::with_min_output_value(
                NonZeroUsize::new(notes).expect("nonzero"),
                Zatoshis::from_u64(100_000).expect("valid"),
            ),
        )
    }

    /// Sweep every spendable deposit note into the reserve. `None` if there is nothing to sweep.
    pub async fn sweep(&mut self, client: &mut Client) -> Result<Option<TxId>, Error> {
        let lock = self.lock.clone();
        let _g = lock.lock().await;
        if self.balances()?.deposit_spendable < 20_000 {
            return Ok(None);
        }
        let to = r0_zaddr(&self.address_of(self.reserve)?, &self.net);
        let proposal = propose_send_max_transfer::<_, _, _, std::convert::Infallible>(
            &mut self.db,
            &self.net,
            self.deposit,
            &[ShieldedPool::Ironwood, ShieldedPool::Orchard],
            &StandardFeeRule::Zip317,
            to,
            None,
            MaxSpendMode::MaxSpendable,
            confirmations(),
            &Default::default(),
            None,
        )
        .map_err(err)?;
        let mut rng = OsRng;
        let txids = create_proposed_transactions::<
            _,
            _,
            std::convert::Infallible,
            _,
            std::convert::Infallible,
            _,
        >(
            &mut self.db,
            &self.net,
            &SystemClock,
            &mut rng,
            self.prover.as_ref(),
            self.prover.as_ref(),
            &SpendingKeys::from_unified_spending_key(self.usk_deposit.clone()),
            OvkPolicy::Discard,
            &proposal,
            None,
        )
        .map_err(err)?;
        self.broadcast_all(client, txids).await.map(Some)
    }

    /// Build and store a payout without broadcasting it: up to 7 recipients, padded to exactly
    /// 7 outputs with zero-value notes to throwaway addresses, plus one change note = 8 Ironwood
    /// actions, outgoing viewing key discarded. The caller records the txid, then broadcasts it
    /// with [`Treasury::broadcast`], so a crash in between can never pay twice.
    pub fn build_payout(&mut self, recipients: &[(ZcashAddress, u64)]) -> Result<TxId, Error> {
        if recipients.is_empty() || recipients.len() > PAYOUT_OUTPUTS {
            return Err(Error(format!("{} recipients", recipients.len())));
        }
        let mut payments = Vec::with_capacity(PAYOUT_OUTPUTS);
        for (addr, zat) in recipients {
            payments.push(Payment::without_memo(
                addr.clone(),
                Zatoshis::from_u64(*zat).map_err(err)?,
            ));
        }
        while payments.len() < PAYOUT_OUTPUTS {
            payments.push(Payment::without_memo(
                throwaway_address(&self.net)?,
                Zatoshis::ZERO,
            ));
        }
        let request = TransactionRequest::new(payments).map_err(err)?;
        let txids = self.create(self.reserve, request, OvkPolicy::Discard)?;
        if txids.len() > 1 {
            return Err(Error("a multi-transaction proposal".into()));
        }
        Ok(*txids.first())
    }

    /// Reserve notes spendable right now. With a single note every transaction waits for the
    /// previous one's change to confirm, so the loop keeps a few ([`Treasury::build_split`]).
    pub fn reserve_notes(&self) -> Result<usize, Error> {
        let Some(tip) = self.db.chain_height().map_err(err)? else {
            return Ok(0);
        };
        let notes = self
            .db
            .select_spendable_notes(
                self.reserve,
                TargetValue::AllFunds(MaxSpendMode::MaxSpendable),
                &[ShieldedPool::Ironwood, ShieldedPool::Orchard],
                TargetHeight::from(tip + 1),
                confirmations(),
                &[],
                LockFilter::Unfiltered,
            )
            .map_err(err)?;
        Ok(notes.ironwood().len() + notes.orchard().len())
    }

    /// Split the reserve into 7 equal notes to fresh reserve addresses plus change: 8 Ironwood
    /// actions with the outgoing viewing key discarded, the same shape as a payout, so a split
    /// looks like any other payout on-chain.
    pub fn build_split(&mut self) -> Result<TxId, Error> {
        let spendable = self.balances()?.reserve_spendable;
        let part = spendable.saturating_sub(40_000) / 8;
        if part < 100_000 {
            return Err(Error("too little to split".into()));
        }
        let mut payments = Vec::with_capacity(PAYOUT_OUTPUTS);
        for _ in 0..PAYOUT_OUTPUTS {
            let to = r0_zaddr(&self.address_of(self.reserve)?, &self.net);
            payments.push(Payment::without_memo(
                to,
                Zatoshis::from_u64(part).map_err(err)?,
            ));
        }
        let request = TransactionRequest::new(payments).map_err(err)?;
        let txids = self.create(self.reserve, request, OvkPolicy::Discard)?;
        Ok(*txids.first())
    }

    /// Build and broadcast a payout in one go (tools and tests).
    pub async fn payout(
        &mut self,
        client: &mut Client,
        recipients: &[(ZcashAddress, u64)],
    ) -> Result<TxId, Error> {
        let lock = self.lock.clone();
        let _g = lock.lock().await;
        let txid = self.build_payout(recipients)?;
        self.broadcast(client, txid).await
    }

    /// Write `memo` (e.g. `bb1:anchor:<height>:<root>`) on-chain with a zero-value payment to the
    /// reserve itself: 2 actions.
    pub async fn anchor(&mut self, client: &mut Client, memo: &str) -> Result<TxId, Error> {
        let lock = self.lock.clone();
        let _g = lock.lock().await;
        let to = r0_zaddr(&self.address_of(self.reserve)?, &self.net);
        let memo = MemoBytes::from(Memo::from_bytes(memo.as_bytes()).map_err(err)?);
        let p =
            Payment::new(to, Some(Zatoshis::ZERO), Some(memo), None, None, vec![]).map_err(err)?;
        let request = TransactionRequest::new(vec![p]).map_err(err)?;
        // The reserve's own viewing key must read the anchor, so the outgoing key is kept here.
        self.send(client, self.reserve, request, OvkPolicy::Sender)
            .await
    }

    fn create(
        &mut self,
        from: zcash_client_sqlite::AccountUuid,
        request: TransactionRequest,
        ovk: OvkPolicy,
    ) -> Result<NonEmpty<TxId>, Error> {
        let usk = if from == self.reserve {
            self.usk_reserve.clone()
        } else {
            self.usk_deposit.clone()
        };
        let proposal = propose_transfer::<_, _, _, _, std::convert::Infallible>(
            &mut self.db,
            &self.net,
            from,
            &GreedyInputSelector::new(),
            &Self::change_strategy(1),
            request,
            confirmations(),
            &SpendPolicy::default(),
            None,
            None,
        )
        .map_err(err)?;
        let mut rng = OsRng;
        create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut self.db,
            &self.net,
            &SystemClock,
            &mut rng,
            self.prover.as_ref(),
            self.prover.as_ref(),
            &SpendingKeys::from_unified_spending_key(usk),
            ovk,
            &proposal,
            None,
        )
        .map_err(err)
    }

    async fn send(
        &mut self,
        client: &mut Client,
        from: zcash_client_sqlite::AccountUuid,
        request: TransactionRequest,
        ovk: OvkPolicy,
    ) -> Result<TxId, Error> {
        let txids = self.create(from, request, ovk)?;
        self.broadcast_all(client, txids).await
    }
}

/// Revision 0 encoding of an address's Orchard receiver.
fn r0(ua: &UnifiedAddress, net: &Net) -> String {
    r0_zaddr(ua, net).encode()
}

fn r0_zaddr(ua: &UnifiedAddress, net: &Net) -> ZcashAddress {
    let raw = ua
        .orchard()
        .expect("requested with an Orchard receiver")
        .to_raw_address_bytes();
    let u = unified::Address::try_from_items(
        Revision::R0,
        vec![unified::Uitem::Data(Receiver::Orchard(raw))],
    )
    .expect("valid");
    ZcashAddress::from_unified(net.network_type(), u)
}
