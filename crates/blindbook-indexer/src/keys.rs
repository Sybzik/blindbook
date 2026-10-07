//! The deposit account's incoming viewing key: all the public API needs to hand out one-time
//! addresses and recognise payments to them (the full viewing key stays with the signer).

use orchard::Address;
use orchard::keys::{DiversifierIndex, IncomingViewingKey, PreparedIncomingViewingKey};
use zcash_address::unified::Revision;
use zcash_address::unified::{self, Encoding, Receiver};
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedIncomingViewingKey};
use zcash_protocol::consensus::Parameters;

use crate::Error;
use crate::net::Net;

/// Diversifier indices are 88 bits.
pub const MAX_INDEX: u128 = (1 << 88) - 1;

pub struct DepositKeys {
    pub net: Net,
    ivk: IncomingViewingKey,
    pub(crate) pivk: PreparedIncomingViewingKey,
}

impl DepositKeys {
    /// From the encoded UIVK (`uivktest1…`), as the API holds it.
    pub fn from_uivk(net: Net, encoded: &str) -> Result<Self, Error> {
        let uivk = UnifiedIncomingViewingKey::decode(&net, encoded.trim())
            .map_err(|e| Error::Key(format!("UIVK: {e}")))?;
        Self::from_parsed(net, &uivk)
    }

    /// From the encoded UFVK (`uviewtest1…`), as the signer holds it.
    pub fn from_ufvk(net: Net, encoded: &str) -> Result<Self, Error> {
        let ufvk = UnifiedFullViewingKey::decode(&net, encoded.trim())
            .map_err(|e| Error::Key(format!("UFVK: {e}")))?;
        Self::from_parsed(net, &ufvk.to_unified_incoming_viewing_key())
    }

    fn from_parsed(net: Net, uivk: &UnifiedIncomingViewingKey) -> Result<Self, Error> {
        let ivk = uivk
            .orchard()
            .clone()
            .ok_or_else(|| Error::Key("the viewing key has no Orchard item".into()))?;
        Ok(DepositKeys {
            net,
            pivk: PreparedIncomingViewingKey::new(&ivk),
            ivk,
        })
    }

    pub fn address(&self, index: u128) -> Result<Address, Error> {
        let di = DiversifierIndex::try_from(index)
            .map_err(|_| Error::Key(format!("index {index} exceeds 88 bits")))?;
        Ok(self.ivk.address_at(di))
    }

    /// The one-time top-up address for a diversifier index: a ZIP 316 **Revision 0** unified
    /// address (`u1…` / `utest1…`) with only an Orchard-protocol receiver, which wallets that
    /// predate Revision 2 accept too (PROTOCOL section 1).
    pub fn address_r0(&self, index: u128) -> Result<String, Error> {
        let raw = self.address(index)?.to_raw_address_bytes();
        let ua = unified::Address::try_from_items(
            Revision::R0,
            vec![unified::Uitem::Data(Receiver::Orchard(raw))],
        )
        .map_err(|e| Error::Key(e.to_string()))?;
        Ok(ua.encode(&self.net.network_type()))
    }

    /// Which index an address of this account was derived at (FF1 under the diversifier key).
    pub fn index_of(&self, addr: &Address) -> Option<u128> {
        self.ivk.diversifier_index(addr).map(u128::from)
    }
}
