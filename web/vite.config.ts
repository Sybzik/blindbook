import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Production Content-Security-Policy (THREAT_MODEL N5, D3).
 * - connect-src: our own origin (the API is reached only through the mixnet, whose traffic leaves
 *   the browser as WebSocket frames to the entry gateway), plus the Nym directory the mixnet client
 *   bootstraps from. Nothing else: no CDN, font, analytics or Polymarket request is possible.
 * - worker-src blob: and 'wasm-unsafe-eval': mix-fetch runs its WASM in a worker built from a blob.
 * - frame-src 'self': the disposable tunnel frames are same-origin pages.
 * Injected only into the production build; the dev server needs looser rules for hot reload.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' wss: https://validator.nymtech.net",
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "font-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  // frame-ancestors only works as an HTTP header: the server sends it (deploy/Caddyfile).
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'blindbook-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    },
  };
}

/**
 * The service worker (THREAT_MODEL N7): after the first visit the app loads from its own cache,
 * so starting it sends no request for the app. Generated at build with the exact file list, so a
 * new build is a new worker; it never touches /v1/ (API traffic goes through the mixnet).
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'blindbook-sw',
    apply: 'build',
    generateBundle(_, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const shell = ['/', '/index.html', '/tunnel.html', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
      const list = [...new Set([...shell, ...files.map((f) => '/' + f)])];
      const version = createHash('sha256').update(list.join(' ')).update(JSON.stringify(Object.values(bundle).map((b) => ('code' in b ? b.code.length : 0)))).digest('hex').slice(0, 16);
      const sw = `// Generated at build. Serves the app from its cache; never touches /v1/.
const CACHE = 'blindbook-${version}';
const FILES = ${JSON.stringify(list)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/v1/') || u.pathname.startsWith('/dev/')) return;
  // Navigations get the app shell (the URL never changes inside the app, and proof links ride after #).
  const key = e.request.mode === 'navigate' ? (u.pathname === '/tunnel.html' ? '/tunnel.html' : '/index.html') : u.pathname;
  e.respondWith(caches.open(CACHE).then((c) => c.match(key).then((hit) => hit || fetch(e.request))));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
    },
  };
}

/**
 * Integrity (THREAT_MODEL D3): every script and stylesheet the pages load directly carries a
 * Subresource Integrity hash, and dist/SHA256SUMS lists every file, so anyone who builds the
 * same commit can compare what a host serves with what the source produces.
 */
function integrityPlugin(): Plugin {
  return {
    name: 'blindbook-integrity',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      // On the files as written (the last plugin has run), so the hashes are the served bytes.
      const dir = 'dist';
      for (const html of ['index.html', 'tunnel.html']) {
        const path = join(dir, html);
        const text = readFileSync(path, 'utf8').replace(/<(script|link)([^>]*?)(src|href)="\/(assets\/[^"]+\.(?:js|css))"([^>]*)>/g, (m, tag, a, attr, file, b) => {
          if (m.includes('integrity=')) return m;
          const h = 'sha384-' + createHash('sha384').update(readFileSync(join(dir, file))).digest('base64');
          return `<${tag}${a}${attr}="/${file}" integrity="${h}"${b}>`;
        });
        writeFileSync(path, text);
      }
      // Every file in dist, the copied public/ files included.
      const walk = (d: string): string[] =>
        readdirSync(join(dir, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name).replace(/\\/g, '/')]));
      const lines = walk('')
        .filter((f) => f !== 'SHA256SUMS')
        .sort()
        .map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`);
      writeFileSync(join(dir, 'SHA256SUMS'), lines.join('\n') + '\n');
    },
  };
}

export default defineConfig({
  plugins: [react(), cspPlugin(), serviceWorkerPlugin(), integrityPlugin()],
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      // The app, and the tunnel frame (its own copy of mix-fetch per frame).
      input: { index: 'index.html', tunnel: 'tunnel.html' },
    },
    // The app shell must stay under 300 KB gzip (ARCHITECTURE "Speed under load"); the mixnet
    // module is a separate lazy chunk.
    chunkSizeWarningLimit: 17000,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Development only: the devserver (crates/blindbook-api/examples/devserver.rs) on our origin.
    proxy: { '/v1': 'http://127.0.0.1:8090', '/dev': 'http://127.0.0.1:8090' },
  },
  worker: { format: 'es' },
});
