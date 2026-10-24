// Payout addresses checked here before anything is sent: a unified address (Bech32m, any length)
// of our network, its checksum intact. The signer checks again that it holds an Orchard-protocol
// receiver (crates/blindbook-signer payout_address_ok); this catches a pasted address that was cut
// or changed.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M = 0x2bc830a3;

function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i]!;
  }
  return chk >>> 0;
}

/** The address's human-readable part if it is well-formed Bech32m, else null. */
function bech32mHrp(addr: string): string | null {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  const s = addr.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return null;
  const hrp = s.slice(0, pos);
  const data: number[] = [];
  for (const c of s.slice(pos + 1)) {
    const d = CHARSET.indexOf(c);
    if (d < 0) return null;
    data.push(d);
  }
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  return polymod([...expanded, ...data]) === BECH32M ? hrp : null;
}

/** A unified address of this network ("u…" / "zu…" on mainnet, "utest…" / "zutest…" on testnet). */
export function isUnifiedAddress(addr: string, network: 'mainnet' | 'testnet'): boolean {
  const hrp = bech32mHrp(addr.trim());
  return network === 'mainnet' ? hrp === 'u' || hrp === 'zu' : hrp === 'utest' || hrp === 'zutest';
}
