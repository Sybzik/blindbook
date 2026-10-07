// The tunnel frame (PROTOCOL section 4): a hidden same-origin page with its own copy of
// mix-fetch, so its own worker, mixnet identity and tunnel. mix-fetch allows one tunnel per
// JavaScript realm, so every tunnel lives in a frame like this one, the main tunnel included, and
// a stuck tunnel is replaced by a new frame without reloading the app.
//
// The identity is random per frame (clientId + storage passphrase, passed in the URL fragment,
// which never leaves the browser) and its IndexedDB database is deleted when the frame goes.

import { disconnectMixTunnel, mixFetch, setupMixTunnel } from '@nymproject/mix-fetch';

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
      parent.postMessage({ type: 'res', id: r.id, status: res.status, bytes: buf }, location.origin, [buf.buffer]);
    } else {
      parent.postMessage({ type: 'res', id: r.id, status: res.status, text: await res.text() }, location.origin);
    }
  } catch (e) {
    parent.postMessage({ type: 'res', id: r.id, error: String((e as Error)?.message ?? e) }, location.origin);
  }
}

addEventListener('message', (e: MessageEvent) => {
  if (e.origin !== location.origin || e.source !== parent) return;
  const d = e.data as { type: string } & Req;
  if (d.type === 'req') void serve(d);
  if (d.type === 'close') void disconnectMixTunnel().catch(() => undefined);
});

setupMixTunnel({ clientId, storagePassphrase, preferredIpr })
  .then(() => parent.postMessage({ type: 'ready' }, location.origin))
  .catch((e: unknown) => parent.postMessage({ type: 'failed', error: String((e as Error)?.message ?? e) }, location.origin));
