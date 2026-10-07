//! Sealed withdrawal addresses (PROTOCOL section 4, THREAT_MODEL X2).
//!
//! The browser seals `{address, salt}` to the signer's X25519 public key, pinned in the app
//! build; the API stores and relays only the sealed blob and the public commitment
//! `SHA256(address ‖ salt)`. Only the signer can open it, and it refuses a blob whose contents
//! don't match the commitment, so the API can't swap the address.
//!
//! Normative format, all of it available in browsers (WebCrypto + `@noble/curves`):
//! ```text
//! esk, epk          ephemeral X25519 key pair
//! shared            X25519(esk, signer_pk)
//! key               HKDF-SHA256(ikm = shared, salt = epk ‖ signer_pk, info = "blindbook/seal/v1"), 32 bytes
//! sealed            "bbseal1:" ‖ base64url-nopad( epk (32) ‖ nonce (12) ‖ AES-256-GCM(key, nonce, plaintext) )
//! plaintext         {"address": "<unified address>", "salt": "<64 hex>"}  (JSON)
//! commitment        SHA256( address as UTF-8 ‖ salt as 32 bytes )
//! ```

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

pub const PREFIX: &str = "bbseal1:";
pub const INFO: &[u8] = b"blindbook/seal/v1";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("not a sealed address")]
    Format,
    #[error("can't open: wrong key or tampered")]
    Open,
    #[error("contents don't match the commitment")]
    Commitment,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plain {
    pub address: String,
    /// 32 bytes, hex.
    pub salt: String,
}

fn hex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

/// `SHA256(address ‖ salt)`.
pub fn commitment(address: &str, salt: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(address.as_bytes());
    h.update(salt);
    h.finalize().into()
}

fn key(shared: &[u8; 32], epk: &[u8; 32], spk: &[u8; 32]) -> [u8; 32] {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(epk);
    salt[32..].copy_from_slice(spk);
    let mut k = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared)
        .expand(INFO, &mut k)
        .expect("32 bytes is a valid HKDF length");
    k
}

/// The public key of a seal secret.
pub fn public_key(secret: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

/// A new signer seal key pair (secret, public), 32 bytes each.
pub fn keygen() -> ([u8; 32], [u8; 32]) {
    let s = StaticSecret::random_from_rng(OsRng);
    (s.to_bytes(), PublicKey::from(&s).to_bytes())
}

/// Seal an address (with a fresh random salt) to the signer's public key. Returns the sealed
/// string and the commitment. (The browser does the same in JavaScript.)
pub fn seal(signer_pk: &[u8; 32], address: &str) -> (String, [u8; 32]) {
    let mut salt = [0u8; 32];
    OsRng.fill_bytes(&mut salt);
    let salt_hex: String = salt.iter().map(|b| format!("{b:02x}")).collect();
    let plain = serde_json::to_vec(&Plain {
        address: address.to_owned(),
        salt: salt_hex,
    })
    .expect("serializable");
    let esk = StaticSecret::random_from_rng(OsRng);
    let epk = PublicKey::from(&esk).to_bytes();
    let shared = esk.diffie_hellman(&PublicKey::from(*signer_pk)).to_bytes();
    let k = key(&shared, &epk, signer_pk);
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ct = Aes256Gcm::new_from_slice(&k)
        .expect("32-byte key")
        .encrypt(Nonce::from_slice(&nonce), plain.as_ref())
        .expect("encryption");
    let mut blob = Vec::with_capacity(44 + ct.len());
    blob.extend_from_slice(&epk);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    (
        format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(blob)),
        commitment(address, &salt),
    )
}

/// Open a sealed address with the signer's secret key and check it against the commitment.
pub fn open(signer_sk: &[u8; 32], sealed: &str, expected: &[u8; 32]) -> Result<String, Error> {
    let blob = URL_SAFE_NO_PAD
        .decode(sealed.strip_prefix(PREFIX).ok_or(Error::Format)?)
        .map_err(|_| Error::Format)?;
    if blob.len() < 32 + 12 + 16 {
        return Err(Error::Format);
    }
    let epk: [u8; 32] = blob[..32].try_into().expect("32 bytes");
    let nonce = &blob[32..44];
    let secret = StaticSecret::from(*signer_sk);
    let spk = PublicKey::from(&secret).to_bytes();
    let shared = secret.diffie_hellman(&PublicKey::from(epk)).to_bytes();
    let k = key(&shared, &epk, &spk);
    let plain = Aes256Gcm::new_from_slice(&k)
        .expect("32-byte key")
        .decrypt(Nonce::from_slice(nonce), &blob[44..])
        .map_err(|_| Error::Open)?;
    let p: Plain = serde_json::from_slice(&plain).map_err(|_| Error::Open)?;
    let salt = hex32(&p.salt).ok_or(Error::Open)?;
    if commitment(&p.address, &salt) != *expected {
        return Err(Error::Commitment);
    }
    Ok(p.address)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDR: &str = "utest166fy5luckyz2fnztzsznh6rwt5pe0va4mpnqm6axfklss87w53fw50aqg3rwmt2stt5nnmnzgteckxjquxx2yjuk4rmrntds7gtghekc";

    #[test]
    fn seal_and_open() {
        let (sk, pk) = keygen();
        let (sealed, c) = seal(&pk, ADDR);
        assert!(sealed.starts_with(PREFIX));
        assert!(!sealed.contains("utest1"));
        assert_eq!(open(&sk, &sealed, &c), Ok(ADDR.to_owned()));
        // Another commitment (the API swapping the address): refused.
        assert_eq!(open(&sk, &sealed, &[0u8; 32]), Err(Error::Commitment));
        // Another key: can't open.
        let (other, _) = keygen();
        assert_eq!(open(&other, &sealed, &c), Err(Error::Open));
        // Tampered blob.
        let mut t = sealed.clone().into_bytes();
        let last = t.len() - 3;
        t[last] = if t[last] == b'A' { b'B' } else { b'A' };
        assert!(open(&sk, std::str::from_utf8(&t).unwrap(), &c).is_err());
        assert_eq!(open(&sk, "nope", &c), Err(Error::Format));
    }

    /// The blob web/src/core/seal.test.ts produces with pinned randomness: the signer opens what
    /// the browser seals.
    #[test]
    fn opens_the_browser_vector() {
        use sha2::{Digest, Sha256};
        let sk: [u8; 32] = Sha256::digest(b"blindbook/seal-test/signer").into();
        let sealed = "bbseal1:jcI5YXsA72S_qk5iwjgLIs7KkCXjRjKWM4RoPnDqoBQq0BYfkUPmOcHCrrjqIBPlOC2QkKnmL2yFTtDXTKC_KIE37DPpLZah7RRDLI0PevEmxbNk7MjLhO7CWCQyrPIHefKabg7mKBuPp-ZeXSNz6oqezf9tQyuv6m3eLLxAfJLbzob0zR3swax6-OHcLslEBuHiDoiy6Dnxeby6N6QnI2mO0AhKMKxh2XTpdPyXuQd9aQyiEJ9qJ74IaT-20IdYYNN6SAWPLzXgoluRW2G5-OsDwOKjmdfo7zbem2o8O7UKH4qFIpdSWqWCQQNevbYAkaaWxEqkxh0HHRk58HOOgw-8";
        let c = hex32("f6277091ad30a891443fa34d93eeea67fb5080ba9f9b5f2fa972237067b4808d").unwrap();
        assert_eq!(open(&sk, sealed, &c), Ok(ADDR.to_owned()));
    }

    #[test]
    fn sealing_is_randomized() {
        let (_, pk) = keygen();
        let (a, ca) = seal(&pk, ADDR);
        let (b, cb) = seal(&pk, ADDR);
        assert_ne!(a, b);
        assert_ne!(
            ca, cb,
            "a fresh salt each time: the same address isn't recognisable"
        );
    }
}
