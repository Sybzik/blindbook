// The tunnel frame (PROTOCOL section 4): a hidden same-origin page with its own copy of
// mix-fetch, so its own worker, mixnet identity and tunnel. mix-fetch allows one tunnel per
// JavaScript realm, so every tunnel lives in a frame like this one, the main tunnel included, and
// a stuck tunnel is replaced by a new frame without reloading the app.
//
// The mixnet worker runs with an opaque origin (vite.config.ts, opaqueMixnetWorkerPlugin): Nym's
// directory API and the entry gateway see `Origin: null`, never the app's site. Its identity is
// random per frame and lives only in the worker's memory, gone with the frame.
//
// The app talks to the frame over a MessageChannel whose port it hands over once the frame has
// loaded: a port can't be forged or overheard, and it doesn't depend on how a browser labels a
// message's source (Safari names the parent page as the source of a message this frame sends
// from a promise callback).

import { disconnectMixTunnel, mixFetch, setupMixTunnel } from '@nymproject/mix-fetch';

// The mixnet client narrates its setup (gateways, keys, routes): none of it goes to the console of
// this frame either. Errors still do.
for (const k of ['log', 'info', 'debug', 'warn'] as const) console[k] = () => undefined;

interface Req {
  id: number;
  method: 'GET' | 'POST';
  url: string;
  body?: string;
  bytes?: boolean;
}

const params = new URLSearchParams(location.hash.slice(1));
const clientId = params.get('cid') ?? '';
const storagePassphrase = params.get('pw') ?? '';
const preferredIpr = params.get('ipr') || undefined;

const port = new Promise<MessagePort>((resolve) => {
  addEventListener('message', function onPort(e: MessageEvent) {
    if (e.origin !== location.origin || (e.data as { type?: string } | null)?.type !== 'port' || !e.ports[0]) return;
    removeEventListener('message', onPort);
    resolve(e.ports[0]);
  });
});
const send = (m: unknown, transfer: Transferable[] = []) => void port.then((p) => p.postMessage(m, transfer));

async function serve(r: Req) {
  try {
    const res = await mixFetch(r.url, {
      method: r.method,
      body: r.body,
      headers: r.body ? { 'content-type': 'application/json' } : undefined,
      // mix-fetch has no decompressor: bundle files are .gz and the app decompresses them.
      // (It sends Accept-Encoding: identity itself.)
    } as RequestInit);
    if (r.bytes) {
      const buf = new Uint8Array(await res.arrayBuffer());
      send({ type: 'res', id: r.id, status: res.status, bytes: buf }, [buf.buffer]);
    } else {
      send({ type: 'res', id: r.id, status: res.status, text: await res.text() });
    }
  } catch (e) {
    send({ type: 'res', id: r.id, error: String((e as Error)?.message ?? e) });
  }
}

void port.then((p) => {
  p.onmessage = (e: MessageEvent) => {
    const d = e.data as { type: string } & Req;
    if (d.type === 'req') void serve(d);
    if (d.type === 'close') void disconnectMixTunnel().catch(() => undefined);
  };
});

setupMixTunnel({ clientId, storagePassphrase, preferredIpr })
  .then(() => send({ type: 'ready' }))
  .catch((e: unknown) => send({ type: 'failed', error: String((e as Error)?.message ?? e) }));
