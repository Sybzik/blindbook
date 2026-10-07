//! Blindbook mint primitives (PROTOCOL sections 2 and 3).
//!
//! **Keysets.** One keyset per (market, outcome) plus one CREDIT keyset, each with 31 keys for the
//! denominations 2^k, k = 0..=30. Every key is a non-hardened tweak of the mint master key, so the
//! browser derives the public keys itself from the master public key `M` pinned in the build and
//! never has to trust a key the server hands out (THREAT_MODEL P2):
//!
//! ```text
//! t_k    = int(SHA256("blindbook/keyset/v1" ‖ M ‖ market_id ‖ outcome ‖ k)) mod n
//!          19 ASCII bytes ‖ 33-byte compressed M ‖ 32 bytes ‖ 1 byte ‖ 1 byte   (86 bytes)
//! secret = (m + t_k) mod n      (signer only)
//! public = M + t_k·G            (anyone)
//! ```
//!
//! CREDIT uses `market_id = 0x00 × 32` and `outcome = 0xFF`. Keyset ids are Cashu NUT-02 v01 ids
//! with the unit `bb-share` (outcome keysets) or `bb-credit` (CREDIT), input fee 0, no expiry.
//! The derivation is byte-identical with the browser implementation (`@cashu/cashu-ts` 4.11 +
//! `@noble/curves`); `tests/data/keysets-js.json` pins it.
//!
//! **Signatures.** Blind signatures are Cashu BDHKE (NUT-00) with a NUT-12 DLEQ proof on every
//! signature, from the `cashu` crate.

use std::collections::BTreeMap;

use bitcoin::hashes::{Hash, sha256};
use bitcoin::secp256k1::constants::CURVE_ORDER;
use bitcoin::secp256k1::{Scalar, SecretKey as SecpSecretKey};
use cashu::nuts::nut00::CurrencyUnit;
use cashu::{Amount, BlindSignature, Id, Keys, PublicKey, SecretKey};

pub use cashu;

/// Domain separation tag of the keyset tweak (19 ASCII bytes, no length prefix).
pub const KEYSET_DST: &[u8] = b"blindbook/keyset/v1";
/// Denominations per keyset: k = 0..=30, amount = 2^k units.
pub const DENOMINATIONS: u8 = 31;
/// Unit string of outcome keysets in their v01 keyset id.
pub const SHARE_UNIT: &str = "bb-share";
/// Unit string of the CREDIT keyset in its v01 keyset id.
pub const CREDIT_UNIT: &str = "bb-credit";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A scalar reduced to zero (probability about 2^-256).
    #[error("scalar is zero")]
    ZeroScalar,
    /// The amount isn't one of the 31 power-of-two denominations.
    #[error("{0} is not a denomination 2^k with k <= 30")]
    BadDenomination(u64),
    #[error("crypto error: {0}")]
    Crypto(String),
}

fn crypto<E: std::fmt::Display>(e: E) -> Error {
    Error::Crypto(e.to_string())
}

/// What a keyset is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum KeysetKind {
    /// Shares of one outcome of one market. `market_id` is Polymarket's 32-byte `conditionId`;
    /// `outcome` is 0 (A) or 1 (B), matching the CTF payout index.
    Outcome { market_id: [u8; 32], outcome: u8 },
    /// The private balance.
    Credit,
}

impl KeysetKind {
    pub fn market_id(&self) -> [u8; 32] {
        match self {
            KeysetKind::Outcome { market_id, .. } => *market_id,
            KeysetKind::Credit => [0u8; 32],
        }
    }

    pub fn outcome_byte(&self) -> u8 {
        match self {
            KeysetKind::Outcome { outcome, .. } => *outcome,
            KeysetKind::Credit => 0xFF,
        }
    }

    pub fn unit(&self) -> &'static str {
        match self {
            KeysetKind::Outcome { .. } => SHARE_UNIT,
            KeysetKind::Credit => CREDIT_UNIT,
        }
    }
}

/// `Y = hash_to_curve(secret)` of a slip, as the hex of the compressed point: the slip's entry
/// in the public spent set. Cashu hashes the secret string's UTF-8 bytes.
pub fn y_hex(secret: &str) -> Result<String, Error> {
    Ok(cashu::dhke::hash_to_curve(secret.as_bytes())
        .map_err(crypto)?
        .to_hex())
}

/// SHA-256.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    sha256::Hash::hash(data).to_byte_array()
}

/// Reduce a 256-bit big-endian integer modulo the secp256k1 group order n.
/// x < 2^256 < 2n, so one conditional subtraction is enough.
fn reduce_mod_n(x: [u8; 32]) -> [u8; 32] {
    if x < CURVE_ORDER {
        return x;
    }
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = x[i] as i16 - CURVE_ORDER[i] as i16 - borrow;
        if d < 0 {
            d += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out[i] = d as u8;
    }
    out
}

fn scalar_from_hash(h: [u8; 32]) -> Result<SecretKey, Error> {
    SecpSecretKey::from_slice(&reduce_mod_n(h))
        .map(SecretKey::from)
        .map_err(|_| Error::ZeroScalar)
}

/// The 86-byte preimage of the keyset tweak for denomination 2^k.
pub fn keyset_preimage(m_pub: &PublicKey, kind: &KeysetKind, k: u8) -> Vec<u8> {
    let mut v = Vec::with_capacity(KEYSET_DST.len() + 33 + 32 + 2);
    v.extend_from_slice(KEYSET_DST);
    v.extend_from_slice(&m_pub.to_bytes());
    v.extend_from_slice(&kind.market_id());
    v.push(kind.outcome_byte());
    v.push(k);
    v
}

fn tweak(m_pub: &PublicKey, kind: &KeysetKind, k: u8) -> Result<SecretKey, Error> {
    scalar_from_hash(sha256(&keyset_preimage(m_pub, kind, k)))
}

/// `public_k = M + t_k·G`: what the browser computes from the pinned `M`.
pub fn derive_public_key(m_pub: &PublicKey, kind: &KeysetKind, k: u8) -> Result<PublicKey, Error> {
    let tg = tweak(m_pub, kind, k)?.public_key();
    Ok(m_pub.combine(&tg).map_err(crypto)?.into())
}

/// The 31 public keys of a keyset, keyed by amount 2^k.
pub fn derive_public_keys(m_pub: &PublicKey, kind: &KeysetKind) -> Result<Keys, Error> {
    let mut map = BTreeMap::new();
    for k in 0..DENOMINATIONS {
        map.insert(Amount::from(1u64 << k), derive_public_key(m_pub, kind, k)?);
    }
    Ok(Keys::new(map))
}

/// The NUT-02 v01 keyset id of a keyset.
pub fn keyset_id(keys: &Keys, kind: &KeysetKind) -> Id {
    Id::v2_from_data(keys, &CurrencyUnit::custom(kind.unit()), 0, None)
}

/// The denomination index k of an amount, if it is 2^k with k <= 30.
pub fn denomination_index(amount: u64) -> Result<u8, Error> {
    if amount.is_power_of_two() && amount.trailing_zeros() < DENOMINATIONS as u32 {
        Ok(amount.trailing_zeros() as u8)
    } else {
        Err(Error::BadDenomination(amount))
    }
}

/// A public keyset as clients see it.
#[derive(Debug, Clone)]
pub struct PublicKeyset {
    pub kind: KeysetKind,
    pub id: Id,
    pub keys: Keys,
}

impl PublicKeyset {
    pub fn derive(m_pub: &PublicKey, kind: KeysetKind) -> Result<Self, Error> {
        let keys = derive_public_keys(m_pub, &kind)?;
        Ok(Self {
            kind,
            id: keyset_id(&keys, &kind),
            keys,
        })
    }
}

/// The signer's view of one keyset: the 31 secret keys `m + t_k`.
pub struct SecretKeyset {
    pub public: PublicKeyset,
    secrets: BTreeMap<u64, SecretKey>,
}

impl std::fmt::Debug for SecretKeyset {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretKeyset")
            .field("public", &self.public)
            .finish_non_exhaustive()
    }
}

/// The mint master key. Lives only on the signer (ARCHITECTURE "Who holds which key").
pub struct MasterKey {
    m: SecretKey,
}

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MasterKey")
            .field("public", &self.public_key().to_hex())
            .finish_non_exhaustive()
    }
}

impl MasterKey {
    pub fn from_secret(m: SecretKey) -> Self {
        Self { m }
    }

    /// The master public key `M`, pinned in the app build and the repository.
    pub fn public_key(&self) -> PublicKey {
        self.m.public_key()
    }

    /// `secret_k = (m + t_k) mod n`.
    pub fn derive_secret_key(&self, kind: &KeysetKind, k: u8) -> Result<SecretKey, Error> {
        let t = tweak(&self.public_key(), kind, k)?;
        let s = (*self.m)
            .add_tweak(&Scalar::from(*t))
            .map_err(|_| Error::ZeroScalar)?;
        Ok(SecretKey::from(s))
    }

    pub fn keyset(&self, kind: KeysetKind) -> Result<SecretKeyset, Error> {
        let public = PublicKeyset::derive(&self.public_key(), kind)?;
        let mut secrets = BTreeMap::new();
        for k in 0..DENOMINATIONS {
            secrets.insert(1u64 << k, self.derive_secret_key(&kind, k)?);
        }
        Ok(SecretKeyset { public, secrets })
    }
}

impl SecretKeyset {
    fn secret_for(&self, amount: u64) -> Result<&SecretKey, Error> {
        denomination_index(amount)?;
        self.secrets
            .get(&amount)
            .ok_or(Error::BadDenomination(amount))
    }

    /// Blind-sign `B_` for a denomination: `C_ = k·B_` with its NUT-12 DLEQ proof.
    pub fn sign(&self, amount: u64, blinded: &PublicKey) -> Result<BlindSignature, Error> {
        let k = self.secret_for(amount)?;
        let c = cashu::dhke::sign_message(k, blinded).map_err(crypto)?;
        BlindSignature::new(Amount::from(amount), c, self.public.id, blinded, k).map_err(crypto)
    }

    /// The spend check: `C == k·hash_to_curve(x)` for a slip of this keyset.
    pub fn verify_spend(&self, amount: u64, secret: &[u8], c: &PublicKey) -> Result<bool, Error> {
        let k = self.secret_for(amount)?;
        Ok(cashu::dhke::verify_message(k, *c, secret).is_ok())
    }
}
