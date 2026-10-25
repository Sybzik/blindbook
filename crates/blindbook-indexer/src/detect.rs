//! Payment detection with the incoming viewing key only: raw trial decryption of every Ironwood
//! and Orchard action (`zcash_note_encryption` under `IronwoodDomain` / `OrchardDomain`), then the
//! diversifier index from the note's recipient. Verified against the wallet library on testnet
//! (both paths agreed on txid, action, value and index).

use orchard::note::Note;
use orchard::note_encryption::{CompactAction, IronwoodDomain, OrchardDomain};
use serde::{Deserialize, Serialize};
use zcash_client_backend::proto::compact_formats::{CompactBlock, CompactTx};
use zcash_note_encryption::{try_compact_note_decryption, try_note_decryption};
use zcash_primitives::transaction::Transaction;

use crate::keys::DepositKeys;

/// How private the paying transaction was (shown to the user; PROTOCOL section 11).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Privacy {
    /// Within the pool the payment arrived in.
    Shielded,
    /// Value crossed into that pool from another shielded pool: the amount is visible on-chain.
    AmountVisible,
    /// Transparent inputs: the sender's address and amount are public.
    Exposed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxShape {
    pub transparent_inputs: u32,
    pub transparent_outputs: u32,
    pub sapling_spends: u32,
    pub sapling_outputs: u32,
    pub orchard_actions: u32,
    pub ironwood_actions: u32,
}

impl TxShape {
    /// How private a payment received in `pool` ("ironwood" or "orchard") was. The amount shows
    /// when value crosses into that pool from another one: Sapling spends, or the other of the
    /// two action pools. Where Ironwood isn't active (mainnet before NU7) a payment arrives in
    /// Orchard, and Orchard to Orchard stays shielded.
    pub fn privacy(&self, pool: &str) -> Privacy {
        let other = if pool == "ironwood" {
            self.orchard_actions
        } else {
            self.ironwood_actions
        };
        if self.transparent_inputs > 0 {
            Privacy::Exposed
        } else if self.sapling_spends > 0 || other > 0 {
            Privacy::AmountVisible
        } else {
            Privacy::Shielded
        }
    }

    pub fn of_full(tx: &Transaction) -> Self {
        let t = tx.transparent_bundle();
        let s = tx.sapling_bundle();
        TxShape {
            transparent_inputs: t.map_or(0, |b| b.vin.len() as u32),
            transparent_outputs: t.map_or(0, |b| b.vout.len() as u32),
            sapling_spends: s.map_or(0, |b| b.shielded_spends().len() as u32),
            sapling_outputs: s.map_or(0, |b| b.shielded_outputs().len() as u32),
            orchard_actions: tx.orchard_bundle().map_or(0, |b| b.actions().len() as u32),
            ironwood_actions: tx.ironwood_bundle().map_or(0, |b| b.actions().len() as u32),
        }
    }

    pub fn of_compact(tx: &CompactTx) -> Self {
        TxShape {
            transparent_inputs: tx.vin.len() as u32,
            transparent_outputs: tx.vout.len() as u32,
            sapling_spends: tx.spends.len() as u32,
            sapling_outputs: tx.outputs.len() as u32,
            orchard_actions: tx.actions.len() as u32,
            ironwood_actions: tx.ironwood_actions.len() as u32,
        }
    }

    /// Shielded actions, for the block's public statistics.
    pub fn shielded(&self) -> u64 {
        u64::from(
            self.sapling_spends
                + self.sapling_outputs
                + self.orchard_actions
                + self.ironwood_actions,
        )
    }
}

/// A payment to one of our one-time addresses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Payment {
    /// Display txid (byte-reversed hex).
    pub txid: String,
    pub action: u32,
    /// "ironwood" or "orchard": the pool the note was received in.
    pub pool: String,
    pub value_zat: u64,
    pub index: u128,
    pub shape: TxShape,
    pub privacy: Privacy,
}

fn payment(
    txid: &str,
    action: usize,
    pool: &str,
    note: &Note,
    index: u128,
    shape: TxShape,
) -> Payment {
    Payment {
        txid: txid.to_owned(),
        action: action as u32,
        pool: pool.to_owned(),
        value_zat: note.value().inner(),
        index,
        shape,
        privacy: shape.privacy(pool),
    }
}

/// Payments in a full transaction (from the mempool stream).
pub fn detect_full(keys: &DepositKeys, tx: &Transaction) -> Vec<Payment> {
    let txid = tx.txid().to_string();
    let shape = TxShape::of_full(tx);
    let mut out = Vec::new();
    if let Some(b) = tx.ironwood_bundle() {
        for (i, action) in b.actions().iter().enumerate() {
            let domain = IronwoodDomain::for_action(action);
            if let Some((note, addr, _memo)) = try_note_decryption(&domain, &keys.pivk, action)
                && let Some(index) = keys.index_of(&addr)
            {
                out.push(payment(&txid, i, "ironwood", &note, index, shape));
            }
        }
    }
    if let Some(b) = tx.orchard_bundle() {
        for (i, action) in b.actions().iter().enumerate() {
            let domain = OrchardDomain::for_action(action);
            if let Some((note, addr, _memo)) = try_note_decryption(&domain, &keys.pivk, action)
                && let Some(index) = keys.index_of(&addr)
            {
                out.push(payment(&txid, i, "orchard", &note, index, shape));
            }
        }
    }
    out
}

/// Payments in a compact block (requested with all pool types, so the shape is complete).
pub fn detect_compact(keys: &DepositKeys, block: &CompactBlock) -> Vec<Payment> {
    let mut out = Vec::new();
    for tx in &block.vtx {
        let txid = txid_string(&tx.txid);
        let shape = TxShape::of_compact(tx);
        for (i, a) in tx.ironwood_actions.iter().enumerate() {
            let Ok(ca) = CompactAction::try_from(a) else {
                continue;
            };
            let domain = IronwoodDomain::for_compact_action(&ca);
            if let Some((note, addr)) = try_compact_note_decryption(&domain, &keys.pivk, &ca)
                && let Some(index) = keys.index_of(&addr)
            {
                out.push(payment(&txid, i, "ironwood", &note, index, shape));
            }
        }
        for (i, a) in tx.actions.iter().enumerate() {
            let Ok(ca) = CompactAction::try_from(a) else {
                continue;
            };
            let domain = OrchardDomain::for_compact_action(&ca);
            if let Some((note, addr)) = try_compact_note_decryption(&domain, &keys.pivk, &ca)
                && let Some(index) = keys.index_of(&addr)
            {
                out.push(payment(&txid, i, "orchard", &note, index, shape));
            }
        }
    }
    out
}

/// Shielded actions in a block (public statistics for Block Radio).
pub fn shielded_actions(block: &CompactBlock) -> u64 {
    block
        .vtx
        .iter()
        .map(|t| TxShape::of_compact(t).shielded())
        .sum()
}

/// Display form of a txid (byte-reversed hex) from protocol-order bytes.
pub fn txid_string(bytes: &[u8]) -> String {
    let mut b = bytes.to_vec();
    b.reverse();
    hex::encode(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privacy_follows_the_receiving_pool() {
        let orchard_only = TxShape {
            orchard_actions: 2,
            ..Default::default()
        };
        let ironwood_only = TxShape {
            ironwood_actions: 2,
            ..Default::default()
        };
        let crossing = TxShape {
            orchard_actions: 1,
            ironwood_actions: 2,
            ..Default::default()
        };
        let from_sapling = TxShape {
            sapling_spends: 1,
            orchard_actions: 2,
            ..Default::default()
        };
        let transparent = TxShape {
            transparent_inputs: 1,
            orchard_actions: 2,
            ..Default::default()
        };
        // Mainnet before NU7: Orchard to Orchard is shielded.
        assert_eq!(orchard_only.privacy("orchard"), Privacy::Shielded);
        assert_eq!(ironwood_only.privacy("ironwood"), Privacy::Shielded);
        assert_eq!(crossing.privacy("ironwood"), Privacy::AmountVisible);
        assert_eq!(crossing.privacy("orchard"), Privacy::AmountVisible);
        assert_eq!(from_sapling.privacy("orchard"), Privacy::AmountVisible);
        assert_eq!(transparent.privacy("orchard"), Privacy::Exposed);
    }
}
