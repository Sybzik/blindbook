// What the build pins (THREAT_MODEL P2): the mint master public key M, the signer's seal key,
// and where the API is. A key the server hands out is never accepted instead.

const env = import.meta.env;

/** The devserver's public TEST keys (crates/blindbook-api/examples/devserver.rs). */
const DEV_M = '0204559d9106c538b0f21bd82b50c47117bfda93530ed212fb818b886321cdea3c';
const DEV_SEAL = '45a6018a2cf7c127c6ddfb1246298c9e2e09db027ab6cb4c3dc22bd7f838e745';

export const config = {
  m: (env.VITE_BB_M as string | undefined) ?? DEV_M,
  sealPk: (env.VITE_BB_SEAL_PK as string | undefined) ?? DEV_SEAL,
  /** Absolute API origin for the mixnet; empty = our own origin over plain fetch (dev only). */
  api: (env.VITE_BB_API as string | undefined) ?? '',
  /** Use the mixnet (production) or plain fetch (development). */
  mixnet: (env.VITE_BB_MIXNET as string | undefined) === '1',
  /** The .onion mirror: plain requests to its own origin, carried by Tor. */
  onion: (env.VITE_BB_ONION as string | undefined) === '1',
  ipr: env.VITE_BB_IPR as string | undefined,
  /** The .onion mirror's address, offered when the mixnet can't link (optional). */
  onionUrl: (env.VITE_BB_ONION_URL as string | undefined) || undefined,
  network: ((env.VITE_BB_NETWORK as string | undefined) ?? 'testnet') as 'testnet' | 'mainnet',
  dev: !!env.DEV,
};

// The test keys are public: never run for real users with them (vite.config.ts refuses the build).
if ((config.mixnet || config.onion) && (config.m === DEV_M || config.sealPk === DEV_SEAL)) {
  throw new Error('This build pins the development test keys; it must not run for real users.');
}

export const COIN = config.network === 'mainnet' ? 'ZEC' : 'TAZ';

/** Standard amounts (PROTOCOL section 1), in CREDIT units (1 unit = 0.00001). */
export const TOPUP_ZAT = config.network === 'mainnet' ? [100_000, 500_000, 1_000_000] : [1_000_000, 5_000_000, 10_000_000, 50_000_000];
export const WITHDRAW_UNITS = config.network === 'mainnet' ? [100, 500, 1_000] : [1_000, 5_000, 10_000, 50_000];
export const BET_UNITS = config.network === 'mainnet' ? [100, 200, 500] : [1_000, 2_000, 5_000];
export const WITHDRAWAL_FEE_UNITS = 20;
export const ZERO_CONF_ZAT = config.network === 'mainnet' ? 500_000 : 10_000_000;
