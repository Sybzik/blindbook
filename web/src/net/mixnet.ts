// The mixnet transport (PROTOCOL section 4, THREAT_MODEL N1–N13).
//
// - Every tunnel runs in its own hidden same-origin frame (/tunnel/), with a fresh random
//   mixnet identity held only in its worker's memory (the worker has an opaque origin, so Nym's
//   directory and gateway never see the app's site). Identities an older build stored in
//   IndexedDB are deleted at boot.
// - Boot races two tunnels and keeps the first that answers GET /v1/head within 20 s: about a
//   third of random routes come up "ready" and never answer, and a healthy one can take 3 to 20 s
//   for its first request (TCP and TLS inside the tunnel; spikes/a-mixnet).
// - The app talks to each frame over its own MessageChannel (see tunnel.ts).
// - Every request has an app-level deadline (mix-fetch has none). A tunnel that misses one is
//   replaced while the lamp shows RELINKING, and a warm spare is kept so the swap is instant.
// - Top-ups and withdrawals use a separate "cage" tunnel, opened for one operation and destroyed;
//   it races two tunnels the same way, so a dead route doesn't fail the operation.

import type { Transport } from '../core/api';
import { randomBytes, toHex } from '../core/bytes';

export type LinkState = 'linking' | 'linked' | 'relinking' | 'down';

const DB_PREFIX = 'wasm-client-storage-';
export const BOOT_DEADLINE_MS = 20_000;
export const SETUP_DEADLINE_MS = 25_000;
/** Failed rounds of racing tunnels after which the network is probably what blocks the link. */
export const UNREACHABLE_AFTER = 3;

/** Delete every mixnet identity an older build left in IndexedDB (this one keeps them in memory). */
export async function cleanupIdentities(): Promise<void> {
  try {
    for (const db of await indexedDB.databases()) {
      if (db.name?.startsWith(DB_PREFIX)) indexedDB.deleteDatabase(db.name);
    }
  } catch {
    // indexedDB.databases() is missing on some browsers: nothing to clean there.
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
  private port: MessagePort;

  /** The exit this tunnel was pinned to (VITE_BB_IPR), or undefined: one picked at random. */
  constructor(readonly ipr?: string) {
    this.frame = document.createElement('iframe');
    this.frame.hidden = true;
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.tabIndex = -1;
    const pw = toHex(randomBytes(16));
    // `/tunnel/`, not `/tunnel.html`: static hosts that drop `.html` (Cloudflare, Netlify) answer
    // the latter with a redirect, and every host serves a directory's index.html at its `/` path.
    this.frame.src = `/tunnel/#cid=${this.cid}&pw=${pw}${ipr ? '&ipr=' + encodeURIComponent(ipr) : ''}`;
    let readyRes!: () => void;
    let readyRej!: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      readyRes = res;
      readyRej = rej;
    });
    const t = setTimeout(() => readyRej(new Error('tunnel setup timed out')), SETUP_DEADLINE_MS);
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (e: MessageEvent) => {
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
    // The frame's end of the channel goes over once the tunnel page has loaded (its module script,
    // which waits for it, has run by then).
    const handOver = () => {
      if (this.frame.contentWindow?.location.pathname !== '/tunnel/') return;
      this.frame.removeEventListener('load', handOver);
      this.frame.contentWindow.postMessage({ type: 'port' }, location.origin, [channel.port2]);
    };
    this.frame.addEventListener('load', handOver);
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
      this.port.postMessage({ type: 'req', id, method, url, body, bytes });
    });
  }

  destroy() {
    this.port.postMessage({ type: 'close' });
    this.port.close();
    for (const w of this.waiting.values()) w.reject(new Error('tunnel closed'));
    this.waiting.clear();
    this.frame.remove();
  }
}

export class DeadlineError extends Error {
  constructor() {
    super('no answer in time');
  }
}

/** The mixnet client is WebAssembly in a worker: a browser without either (iPhone Lockdown Mode
 *  turns WebAssembly off) can never link, so it doesn't try. */
export const mixnetSupported = () => typeof WebAssembly === 'object' && typeof Worker === 'function';

/** The main transport: one live tunnel, one warm spare, replaced on any missed deadline.
 *  With a pinned exit (VITE_BB_IPR), every race pairs it with an exit picked at random, and the
 *  spare always takes the other kind than the live tunnel: the client never falls back from a
 *  pinned exit by itself, so an exit that goes away can't take the link down with it. */
export class MixnetTransport implements Transport {
  private live?: Tunnel;
  private spare?: Tunnel;
  /** The link attempt in progress: requests made meanwhile all wait for this one. */
  private linking?: Promise<void>;
  private failedRounds = 0;
  private listeners = new Set<(s: LinkState) => void>();
  state: LinkState = 'linking';

  constructor(
    private api: string,
    private ipr?: string,
    /** Told when UNREACHABLE_AFTER rounds in a row have failed (true), and when a link comes up after that (false). */
    private onUnreachable?: (yes: boolean) => void,
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

  /** One link attempt at a time, whoever asks. */
  private link(run: () => Promise<void>): Promise<void> {
    this.linking ??= run().finally(() => (this.linking = undefined));
    return this.linking;
  }

  /** Link (or wait for the attempt already under way). */
  boot(): Promise<void> {
    if (!mixnetSupported()) {
      this.set('down');
      return Promise.reject(new Error('this browser cannot run the mixnet client (no WebAssembly)'));
    }
    return this.link(() => this.race());
  }

  /** Race two tunnels; keep the first that answers /v1/head in time. */
  private async race(): Promise<void> {
    this.set(this.live ? 'relinking' : 'linking');
    for (;;) {
      const a = new Tunnel(this.ipr);
      const b = new Tunnel();
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
        loser.destroy();
        this.spare?.destroy();
        this.spare = this.other(winner);
        if (this.failedRounds >= UNREACHABLE_AFTER) this.onUnreachable?.(false);
        this.failedRounds = 0;
        this.set('linked');
        return;
      } catch {
        a.destroy();
        b.destroy();
        if (++this.failedRounds === UNREACHABLE_AFTER) this.onUnreachable?.(true);
        this.set('down');
        // 2 s, then twice as long after every failed round, up to a minute: a network that blocks
        // the mixnet shouldn't make a phone start two WebAssembly clients every two seconds.
        await new Promise((r) => setTimeout(r, Math.min(60_000, 2_000 * 2 ** Math.min(this.failedRounds - 1, 5))));
        this.set('relinking');
      }
    }
  }

  /** A spare of the other kind than the live tunnel: random behind a pinned one, pinned behind a random one. */
  private other(live: Tunnel): Tunnel {
    return new Tunnel(live.ipr ? undefined : this.ipr);
  }

  /** Replace a tunnel that missed a deadline with the spare, or link anew. A failure on a tunnel
   *  that has already been replaced changes nothing. */
  private relink(failed: Tunnel): Promise<void> {
    if (this.live !== failed) return this.linking ?? Promise.resolve();
    return this.link(async () => {
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
            this.spare = this.other(spare);
            this.set('linked');
            return;
          }
        } catch {
          /* replaced below */
        }
        spare.destroy();
      }
      await this.race();
    });
  }

  private async call(method: 'GET' | 'POST', path: string, body: string | undefined, bytes: boolean, deadline: number) {
    for (let attempt = 0; ; attempt++) {
      if (!this.live) await this.boot();
      const tunnel = this.live!;
      try {
        return await tunnel.fetch(method, this.api + path, body, bytes, deadline);
      } catch (e) {
        // A write that missed its deadline may still have been processed: never resend it here;
        // the caller decides (the wallet recovers by restore). Reads are retried on a new tunnel.
        await this.relink(tunnel);
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

/** A one-off tunnel with its own identity for a top-up or a withdrawal (the "cage"): two race
 *  (a pinned exit against a random one, as above), the first to answer GET /v1/head stays (up to
 *  three rounds), the other is destroyed. */
export async function openCage(api: string, ipr?: string): Promise<Transport & { close(): void }> {
  if (!mixnetSupported()) throw new Error('this browser cannot run the mixnet client (no WebAssembly)');
  let t: Tunnel | undefined;
  for (let round = 0; round < 3 && !t; round++) {
    const a = new Tunnel(ipr);
    const b = new Tunnel();
    const probe = async (x: Tunnel) => {
      await x.ready;
      const r = await x.fetch('GET', api + '/v1/head', undefined, false, BOOT_DEADLINE_MS);
      if (r.status !== 200) throw new Error(`head ${r.status}`);
      return x;
    };
    try {
      t = await Promise.any([probe(a), probe(b)]);
      (t === a ? b : a).destroy();
    } catch {
      a.destroy();
      b.destroy();
    }
  }
  if (!t) throw new DeadlineError();
  const tunnel = t;
  const tr: Transport & { close(): void } = {
    async request(method, path, body, timeoutMs = 20_000) {
      const r = await tunnel.fetch(method, api + path, body === undefined ? undefined : JSON.stringify(body), false, timeoutMs);
      let parsed: unknown = null;
      try {
        parsed = r.text ? JSON.parse(r.text) : null;
      } catch {
        parsed = r.text;
      }
      return { status: r.status, body: parsed };
    },
    async bytes(path, timeoutMs = 30_000) {
      const r = await tunnel.fetch('GET', api + path, undefined, true, timeoutMs);
      if (!r.bytes) throw new Error('no body');
      return r.bytes;
    },
    close: () => tunnel.destroy(),
  };
  return tr;
}
