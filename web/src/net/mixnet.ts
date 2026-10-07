// The mixnet transport (PROTOCOL section 4, THREAT_MODEL N1–N13).
//
// - Every tunnel runs in its own hidden same-origin frame (tunnel.html), with a fresh random
//   mixnet identity; its IndexedDB database is deleted when the frame goes, and leftovers are
//   deleted at boot.
// - Boot races two tunnels and keeps the first that answers GET /v1/head within 8 s: about a
//   third of random routes come up "ready" and never answer (spikes/a-mixnet).
// - Every request has an app-level deadline (mix-fetch has none). A tunnel that misses one is
//   replaced while the lamp shows RELINKING, and a warm spare is kept so the swap is instant.
// - Top-ups and withdrawals use a separate "cage" tunnel, opened for one operation and destroyed.

import type { Transport } from '../core/api';
import { randomBytes, toHex } from '../core/bytes';

export type LinkState = 'linking' | 'linked' | 'relinking' | 'down';

const DB_PREFIX = 'wasm-client-storage-';
export const BOOT_DEADLINE_MS = 8_000;
export const SETUP_DEADLINE_MS = 25_000;

/** Delete every mixnet identity left behind by an earlier session. */
export async function cleanupIdentities(): Promise<void> {
  try {
    for (const db of await indexedDB.databases()) {
      if (db.name?.startsWith(DB_PREFIX)) indexedDB.deleteDatabase(db.name);
    }
  } catch {
    // indexedDB.databases() is missing on some browsers; per-frame deletion still runs.
  }
}

interface Waiting {
  resolve: (v: { status: number; text?: string; bytes?: Uint8Array }) => void;
  reject: (e: Error) => void;
}

/** One tunnel frame. */
class Tunnel {
  readonly cid = 'bb-' + toHex(randomBytes(8));
  private frame: HTMLIFrameElement;
  private next = 1;
  private waiting = new Map<number, Waiting>();
  readonly ready: Promise<void>;
  private onMsg: (e: MessageEvent) => void;

  constructor(ipr?: string) {
    this.frame = document.createElement('iframe');
    this.frame.hidden = true;
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.tabIndex = -1;
    const pw = toHex(randomBytes(16));
    this.frame.src = `/tunnel.html#cid=${this.cid}&pw=${pw}${ipr ? '&ipr=' + encodeURIComponent(ipr) : ''}`;
    let readyRes!: () => void;
    let readyRej!: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      readyRes = res;
      readyRej = rej;
    });
    const t = setTimeout(() => readyRej(new Error('tunnel setup timed out')), SETUP_DEADLINE_MS);
    this.onMsg = (e: MessageEvent) => {
      if (e.source !== this.frame.contentWindow || e.origin !== location.origin) return;
      const d = e.data as { type: string; id?: number; status?: number; text?: string; bytes?: Uint8Array; error?: string };
      if (d.type === 'ready') {
        clearTimeout(t);
        readyRes();
      } else if (d.type === 'failed') {
        clearTimeout(t);
        readyRej(new Error(d.error ?? 'tunnel failed'));
      } else if (d.type === 'res' && d.id !== undefined) {
        const w = this.waiting.get(d.id);
        this.waiting.delete(d.id);
        if (!w) return;
        if (d.error) w.reject(new Error(d.error));
        else w.resolve({ status: d.status ?? 0, text: d.text, bytes: d.bytes });
      }
    };
    addEventListener('message', this.onMsg);
    document.body.appendChild(this.frame);
  }

  fetch(method: 'GET' | 'POST', url: string, body: string | undefined, bytes: boolean, deadline: number) {
    const id = this.next++;
    return new Promise<{ status: number; text?: string; bytes?: Uint8Array }>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        reject(new DeadlineError());
      }, deadline);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.frame.contentWindow?.postMessage({ type: 'req', id, method, url, body, bytes }, location.origin);
    });
  }

  destroy() {
    removeEventListener('message', this.onMsg);
    try {
      this.frame.contentWindow?.postMessage({ type: 'close' }, location.origin);
    } catch {
      /* the frame may already be gone */
    }
    for (const w of this.waiting.values()) w.reject(new Error('tunnel closed'));
    this.waiting.clear();
    this.frame.remove();
    setTimeout(() => indexedDB.deleteDatabase(DB_PREFIX + this.cid), 1_000);
  }
}

export class DeadlineError extends Error {
  constructor() {
    super('no answer in time');
  }
}

/** The main transport: one live tunnel, one warm spare, replaced on any missed deadline. */
export class MixnetTransport implements Transport {
  private live?: Tunnel;
  private spare?: Tunnel;
  private listeners = new Set<(s: LinkState) => void>();
  state: LinkState = 'linking';

  constructor(
    private api: string,
    private ipr?: string,
  ) {}

  onState(f: (s: LinkState) => void): () => void {
    this.listeners.add(f);
    f(this.state);
    return () => this.listeners.delete(f);
  }

  private set(s: LinkState) {
    this.state = s;
    this.listeners.forEach((f) => f(s));
  }

  /** Race two tunnels; keep the first that answers /v1/head in time. */
  async boot(): Promise<void> {
    this.set(this.live ? 'relinking' : 'linking');
    for (;;) {
      const a = new Tunnel(this.ipr);
      const b = new Tunnel(this.ipr);
      const probe = async (t: Tunnel) => {
        await t.ready;
        const r = await t.fetch('GET', this.api + '/v1/head', undefined, false, BOOT_DEADLINE_MS);
        if (r.status !== 200) throw new Error(`head ${r.status}`);
        return t;
      };
      try {
        const winner = await Promise.any([probe(a), probe(b)]);
        const loser = winner === a ? b : a;
        this.live?.destroy();
        this.live = winner;
        // Keep the loser as the spare only if it came up too; otherwise start a fresh one.
        loser.destroy();
        this.spare = new Tunnel(this.ipr);
        this.set('linked');
        return;
      } catch {
        a.destroy();
        b.destroy();
        this.set('down');
        await new Promise((r) => setTimeout(r, 2_000));
        this.set('relinking');
      }
    }
  }

  private async relink(): Promise<void> {
    this.set('relinking');
    const spare = this.spare;
    this.spare = undefined;
    this.live?.destroy();
    this.live = undefined;
    if (spare) {
      try {
        await Promise.race([spare.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('spare not ready')), 3_000))]);
        const r = await spare.fetch('GET', this.api + '/v1/head', undefined, false, BOOT_DEADLINE_MS);
        if (r.status === 200) {
          this.live = spare;
          this.spare = new Tunnel(this.ipr);
          this.set('linked');
          return;
        }
      } catch {
        spare.destroy();
      }
    }
    await this.boot();
  }

  private async call(method: 'GET' | 'POST', path: string, body: string | undefined, bytes: boolean, deadline: number) {
    for (let attempt = 0; ; attempt++) {
      if (!this.live) await this.boot();
      try {
        return await this.live!.fetch(method, this.api + path, body, bytes, deadline);
      } catch (e) {
        // A write that missed its deadline may still have been processed: never resend it here;
        // the caller decides (the wallet recovers by restore). Reads are retried on a new tunnel.
        await this.relink();
        if (method === 'POST' || attempt >= 1) throw e;
      }
    }
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15_000) {
    const r = await this.call(method, path, body === undefined ? undefined : JSON.stringify(body), false, timeoutMs);
    let parsed: unknown = null;
    try {
      parsed = r.text ? JSON.parse(r.text) : null;
    } catch {
      parsed = r.text;
    }
    return { status: r.status, body: parsed };
  }

  async bytes(path: string, timeoutMs = 30_000) {
    const r = await this.call('GET', path, undefined, true, timeoutMs);
    if (r.status !== 200 || !r.bytes) throw new Error(`GET ${path}: ${r.status}`);
    return r.bytes;
  }
}

/** A one-off tunnel with its own identity for a top-up or a withdrawal (the "cage"). */
export async function openCage(api: string, ipr?: string): Promise<Transport & { close(): void }> {
  const t = new Tunnel(ipr);
  await t.ready;
  const tr: Transport & { close(): void } = {
    async request(method, path, body, timeoutMs = 20_000) {
      const r = await t.fetch(method, api + path, body === undefined ? undefined : JSON.stringify(body), false, timeoutMs);
      let parsed: unknown = null;
      try {
        parsed = r.text ? JSON.parse(r.text) : null;
      } catch {
        parsed = r.text;
      }
      return { status: r.status, body: parsed };
    },
    async bytes(path, timeoutMs = 30_000) {
      const r = await t.fetch('GET', api + path, undefined, true, timeoutMs);
      if (!r.bytes) throw new Error('no body');
      return r.bytes;
    },
    close: () => t.destroy(),
  };
  return tr;
}
