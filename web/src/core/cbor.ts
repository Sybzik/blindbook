// A minimal CBOR (RFC 8949) subset for our two transfer formats: unsigned integers (up to 2^53),
// byte strings, text strings and arrays. Definite lengths only.

export type Cbor = number | Uint8Array | string | Cbor[];

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  if (n < 0x100000000) return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  return [(major << 5) | 27, 0, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff, (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff];
}

export function encode(v: Cbor): Uint8Array {
  const out: number[] = [];
  const go = (x: Cbor) => {
    if (typeof x === 'number') {
      if (!Number.isSafeInteger(x) || x < 0) throw new Error('only unsigned integers');
      out.push(...head(0, x));
    } else if (x instanceof Uint8Array) {
      out.push(...head(2, x.length), ...x);
    } else if (typeof x === 'string') {
      const b = new TextEncoder().encode(x);
      out.push(...head(3, b.length), ...b);
    } else {
      out.push(...head(4, x.length));
      x.forEach(go);
    }
  };
  go(v);
  return Uint8Array.from(out);
}

export function decode(bytes: Uint8Array): Cbor {
  let i = 0;
  const byte = () => {
    if (i >= bytes.length) throw new Error('truncated CBOR');
    return bytes[i++]!;
  };
  const len = (info: number): number => {
    if (info < 24) return info;
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (n < 0) throw new Error('unsupported CBOR length');
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + byte();
    if (!Number.isSafeInteger(v)) throw new Error('CBOR integer too large');
    return v;
  };
  const go = (depth: number): Cbor => {
    if (depth > 8) throw new Error('CBOR nested too deeply');
    const b = byte();
    const major = b >> 5;
    const n = len(b & 31);
    switch (major) {
      case 0:
        return n;
      case 2:
      case 3: {
        if (i + n > bytes.length) throw new Error('truncated CBOR');
        const s = bytes.slice(i, i + n);
        i += n;
        return major === 2 ? s : new TextDecoder('utf-8', { fatal: true }).decode(s);
      }
      case 4: {
        if (n > 4096) throw new Error('CBOR array too long');
        const a: Cbor[] = [];
        for (let k = 0; k < n; k++) a.push(go(depth + 1));
        return a;
      }
      default:
        throw new Error(`unsupported CBOR major type ${major}`);
    }
  };
  const v = go(0);
  if (i !== bytes.length) throw new Error('trailing bytes after CBOR');
  return v;
}
