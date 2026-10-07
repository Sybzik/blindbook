// The API client (PROTOCOL sections 4 and 8). Every request goes through a Transport: the
// mixnet in production (net/mixnet.ts), plain fetch only for local development. Every POST
// carries proof-of-work over its canonical body.

import type { BlindedMessage, Proof, SignatureOut } from './blind';

export interface Transport {
  request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: unknown; bytes?: Uint8Array }>;
  /** Raw bytes (bundle files). */
  bytes(path: string, timeoutMs?: number): Promise<Uint8Array>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: string,
  ) {
    super(`${status} ${code}${detail ? ': ' + detail : ''}`);
  }
}

/** Plain fetch against our own origin (development, and the static tunnel frames' own requests). */
export class DirectTransport implements Transport {
  constructor(private base = '') {}
  async request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15_000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(this.base + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      const text = await r.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: r.status, body: parsed };
    } finally {
      clearTimeout(t);
    }
  }
  async bytes(path: string, timeoutMs = 30_000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(this.base + path, { signal: ctl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!r.ok) throw new ApiError(r.status, 'http');
      return new Uint8Array(await r.arrayBuffer());
    } finally {
      clearTimeout(t);
    }
  }
}

export type PowFn = <T extends object>(body: T, bits: number) => Promise<T & { pow: { nonce: number } }>;

export interface Head {
  height: number;
  seq: number;
  root: string;
  pow_bits: { light: number; heavy: number };
  halted: boolean;
}

export interface FillRecord {
  tag: string;
  status: 'filled' | 'shrunk' | 'dropped_limit' | 'halted' | 'rejected';
  kept: number;
  out: number;
  fee: number;
  refund: number;
  avg_price_bp: number;
}

export interface LiveMarket {
  id: string;
  state: 'open' | 'halted' | 'resolved';
  halt: string | null;
  price_a_ppm: number | null;
  reference: { mid_ppm: number; ask_ppm: [number, number]; bid_ppm: [number, number]; unhealthy_ms: number };
  resolved: [number, number, number] | null;
}

export interface RecentFill {
  at_ms: number;
  batch_id: number;
  market: string;
  side: 'buy' | 'sell';
  outcome: 0 | 1;
  fill: FillRecord;
}

export interface Live {
  at_ms: number;
  head: { height: number; seq: number; root: string };
  markets: LiveMarket[];
  recent: RecentFill[];
}

export interface SignedAnswer {
  signatures: SignatureOut[];
  stored_record: Record<string, unknown>;
}

export interface TradeAnswer extends SignedAnswer {
  batch_id: number;
  fill: FillRecord;
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function check<T>(r: { status: number; body: unknown }): T {
  if (r.status >= 200 && r.status < 300) return r.body as T;
  const b = (r.body ?? {}) as { error?: string; detail?: string };
  throw new ApiError(r.status, typeof b.error === 'string' ? b.error : 'error', b.detail);
}

export class Api {
  private headCache?: Head;

  constructor(
    public transport: Transport,
    private pow: PowFn,
  ) {}

  async head(): Promise<Head> {
    this.headCache = check<Head>(await this.transport.request('GET', '/v1/head'));
    return this.headCache;
  }

  async live(): Promise<Live> {
    return check<Live>(await this.transport.request('GET', '/v1/live'));
  }

  private async bits(kind: 'light' | 'heavy'): Promise<number> {
    const h = this.headCache ?? (await this.head());
    return h.pow_bits[kind];
  }

  private async post<T>(path: string, body: object, kind: 'light' | 'heavy', timeoutMs = 20_000): Promise<T> {
    const withPow = await this.pow(body, await this.bits(kind));
    return check<T>(await this.transport.request('POST', path, withPow, timeoutMs));
  }

  async json<T>(path: string): Promise<T> {
    const raw = await this.transport.bytes(path);
    const text = new TextDecoder().decode(path.endsWith('.gz') ? await gunzip(raw) : raw);
    return JSON.parse(text) as T;
  }

  voucher(code: string, outputs: BlindedMessage[]) {
    return this.post<SignedAnswer>('/v1/voucher', { code, outputs }, 'heavy');
  }

  topup(amount_zat: number, credit_outputs: BlindedMessage[], claim_hash: string) {
    return this.post<{ topup_id: string; address: string; expires_height: number }>('/v1/topup', { amount_zat, credit_outputs, claim_hash }, 'heavy');
  }

  async topupStatus(id: string) {
    return check<{ status: string; privacy: string | null; paid_zat: number; signatures: SignatureOut[] }>(
      await this.transport.request('GET', `/v1/topup/${id}`),
    );
  }

  topupClaim(topup_id: string, topup_secret: string, credit_outputs: BlindedMessage[]) {
    return this.post<SignedAnswer>('/v1/topup/claim', { topup_id, topup_secret, credit_outputs }, 'heavy');
  }

  trade(req: {
    market: string;
    side: 'buy' | 'sell';
    outcome: 0 | 1;
    limit_bp: number;
    amount: number;
    inputs: Proof[];
    outputs: BlindedMessage[];
    change_outputs: BlindedMessage[];
    tag: string;
  }) {
    return this.post<TradeAnswer>('/v1/trade', req, 'light', 30_000);
  }

  swap(inputs: Proof[], outputs: BlindedMessage[]) {
    return this.post<SignedAnswer>('/v1/swap', { inputs, outputs }, 'light');
  }

  redeem(inputs: Proof[], outputs: BlindedMessage[]) {
    return this.post<SignedAnswer & { paid: number }>('/v1/redeem', { inputs, outputs }, 'light');
  }

  withdraw(inputs: Proof[], amount: number, change_outputs: BlindedMessage[], address_sealed: string, address_commitment: string) {
    return this.post<SignedAnswer>('/v1/withdraw', { inputs, amount, change_outputs, address_sealed, address_commitment }, 'heavy');
  }
}
