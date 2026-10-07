//! Network selection: testnet, mainnet (read-only measurements) or a local regtest chain.

use zcash_protocol::{
    consensus::{BlockHeight, MainNetwork, NetworkType, NetworkUpgrade, Parameters, TestNetwork},
    local_consensus::LocalNetwork,
};

#[derive(Clone, Copy, Debug)]
pub enum Net {
    Main,
    Test,
    Regtest(LocalNetwork),
}

impl Parameters for Net {
    fn network_type(&self) -> NetworkType {
        match self {
            Net::Main => NetworkType::Main,
            Net::Test => NetworkType::Test,
            Net::Regtest(_) => NetworkType::Regtest,
        }
    }

    fn activation_height(&self, nu: NetworkUpgrade) -> Option<BlockHeight> {
        match self {
            Net::Main => MainNetwork.activation_height(nu),
            Net::Test => TestNetwork.activation_height(nu),
            Net::Regtest(l) => l.activation_height(nu),
        }
    }
}

impl Net {
    /// `main`, `test`, or `regtest:<h1>,...` where the regtest list gives activation heights for
    /// overwinter,sapling,blossom,heartwood,canopy,nu5,nu6,nu6_1,nu6_2,nu6_3 (use `-` for
    /// "never"). `regtest` alone means every upgrade through NU6.3 at height 1.
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "main" | "mainnet" => Ok(Net::Main),
            "test" | "testnet" => Ok(Net::Test),
            "regtest" => Ok(Net::Regtest(local(&[Some(1); 10]))),
            _ => {
                let list = s
                    .strip_prefix("regtest:")
                    .ok_or_else(|| format!("unknown network '{s}'"))?;
                let hs: Vec<Option<u32>> = list
                    .split(',')
                    .map(|h| match h.trim() {
                        "-" | "never" => Ok(None),
                        h => h.parse::<u32>().map(Some),
                    })
                    .collect::<Result<_, _>>()
                    .map_err(|e| e.to_string())?;
                if hs.len() != 10 && hs.len() != 11 {
                    return Err(format!(
                        "regtest needs 10 or 11 activation heights (overwinter..nu6_3[,nu7]), got {}",
                        hs.len()
                    ));
                }
                Ok(Net::Regtest(local(&hs)))
            }
        }
    }
}

fn local(h: &[Option<u32>]) -> LocalNetwork {
    let b = |i: usize| h[i].map(BlockHeight::from_u32);
    LocalNetwork {
        overwinter: b(0),
        sapling: b(1),
        blossom: b(2),
        heartwood: b(3),
        canopy: b(4),
        nu5: b(5),
        nu6: b(6),
        nu6_1: b(7),
        nu6_2: b(8),
        nu6_3: b(9),
        nu7: h.get(10).copied().flatten().map(BlockHeight::from_u32),
    }
}
