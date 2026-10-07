// RFC 8785 (JCS) canonical JSON, byte-identical with crates/blindbook-ledger/src/canonical.rs:
// sorted keys (UTF-16 code units, which is how JavaScript compares strings), no whitespace,
// minimal string escaping (JSON.stringify's), integers only.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function canonical(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`not a safe integer in a canonical record: ${v}`);
    return String(v);
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  throw new Error(`can't canonicalize ${typeof v}`);
}
