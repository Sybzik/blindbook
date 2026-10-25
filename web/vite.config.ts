import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Production Content-Security-Policy (THREAT_MODEL N5, D3), one per page.
 * - The app (index.html) connects only to its own origin: the API is reached through the tunnel
 *   frames, and nothing else (no CDN, font, analytics or Polymarket request) is possible.
 *   'wasm-unsafe-eval' runs the engine's WebAssembly in the verifier; frame-src 'self' allows the
 *   tunnel frames.
 * - A tunnel frame (tunnel/index.html) runs the mixnet client: its worker starts from a data: URL and
 *   loads its code from our own host (opaqueMixnetWorkerPlugin below), and it connects only to
 *   Nym's directory API and, over WebSocket, to the entry gateway. That worker has an opaque
 *   origin, and Safari reads 'self' in its policy as that opaque origin, so the app's own origins
 *   (VITE_BB_APP_ORIGIN) are named explicitly.
 * Injected only into the production build; the dev server needs looser rules for hot reload.
 */
function cspPlugin(): Plugin {
  const common = ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"];
  let appOrigins = '';
  return {
    name: 'blindbook-csp',
    apply: 'build',
    configResolved(c) {
      appOrigins = appOriginsOf(c.env);
    },
    transformIndexHtml(html, ctx) {
      const policy = ctx.path.endsWith('tunnel/index.html')
        ? [...common, `script-src 'self'${appOrigins ? ' ' + appOrigins : ''} 'wasm-unsafe-eval'`, 'worker-src data:', 'connect-src wss: https://validator.nymtech.net', "img-src 'none'", "style-src 'none'", "font-src 'none'", "frame-src 'none'"]
        : [...common, "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'", "connect-src 'self'", "img-src 'self' data: blob:", "style-src 'self'", "font-src 'self'", "frame-src 'self'"];
      // frame-ancestors only works as an HTTP header: the static host and Caddy send it.
      return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${policy.join('; ')}">`);
    },
  };
}

/** The origins the app is served from (VITE_BB_APP_ORIGIN: one or more, separated by spaces or commas). */
function appOriginsOf(env: Record<string, string | undefined>): string {
  const list = (env.VITE_BB_APP_ORIGIN ?? '').split(/[\s,]+/).filter(Boolean);
  for (const o of list) if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) throw new Error(`VITE_BB_APP_ORIGIN: "${o}" is not an origin like https://example.org`);
  return list.join(' ');
}

/**
 * The mixnet worker runs with an opaque origin (THREAT_MODEL N5, N12). mix-tunnel starts its worker
 * from a blob of our own origin, so the browser would label the worker's request to Nym's directory
 * API and its WebSocket to the entry gateway with `Origin: <the app's site>`: both would learn which
 * site the user is on. Here the worker starts from a data: URL instead (an opaque origin, so the
 * browser sends `Origin: null`) whose only line imports the worker's code from our own host:
 * assets/nym-worker-<hash>.js, mix-tunnel's worker as its own file. (Safari won't let an
 * opaque-origin worker run code from a blob, so the code can't be handed over in memory.) An opaque
 * origin has no IndexedDB, so that file starts with an in-memory one (src/net/memidb.ts) and the
 * mixnet identity never reaches the disk. The build fails if mix-tunnel's worker loader changes
 * shape.
 */
function opaqueMixnetWorkerPlugin(): Plugin {
  let memIdb: Promise<string> | undefined;
  const bundleMemIdb = async () => {
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        emptyOutDir: false,
        minify: true,
        target: 'es2022',
        lib: { entry: fileURLToPath(new URL('./src/net/memidb.ts', import.meta.url)), formats: ['iife'], name: 'bbMemIdb' },
      },
    });
    const chunk = (Array.isArray(out) ? out[0] : out) as { output: { type: string; code?: string }[] };
    return chunk.output.find((o) => o.type === 'chunk')!.code!;
  };
  // Runs where mix-tunnel's factory ran: a classic worker from a data: URL that imports the code.
  const factory = `
function bbOpaqueWorkerFactory(path) {
  return function WorkerFactory(options) {
    // The mixnet client narrates its setup (gateways, keys, routes): none of it goes to the
    // console. Errors still do.
    var boot = 'self.console.log=self.console.info=self.console.debug=self.console.warn=function(){};importScripts(' + JSON.stringify(new URL(path, location.href).href) + ');';
    return new Worker('data:text/javascript,' + encodeURIComponent(boot), options);
  };
}
`;
  let building = false;
  let devSource: Buffer = Buffer.alloc(0);
  return {
    name: 'bb-opaque-mixnet-worker',
    enforce: 'pre',
    configResolved(c) {
      building = c.command === 'build';
    },
    async transform(code, id) {
      if (!/@nymproject[\\/+]mix-tunnel/.test(id) || !code.includes('createBase64WorkerFactory')) return;
      const m = code.match(/createBase64WorkerFactory\('([A-Za-z0-9+/=]+)', null, false\)/);
      if (!m) throw new Error('@nymproject/mix-tunnel changed its worker loader: the opaque-origin worker can no longer be set up');
      // The text its own loader would run (base64 to a binary string, first line dropped), as the
      // UTF-8 bytes its blob would have held.
      const raw = Buffer.from(m[1]!, 'base64').toString('latin1');
      const source = Buffer.from((await (memIdb ??= bundleMemIdb())) + ';\n' + raw.substring(raw.indexOf('\n', 10) + 1), 'utf8');
      // Build: an asset named by its hash. Dev: served by the middleware below.
      let path = '/@bb/nym-worker.js';
      if (building) {
        path = '/assets/nym-worker-' + createHash('sha256').update(source).digest('hex').slice(0, 10) + '.js';
        this.emitFile({ type: 'asset', fileName: path.slice(1), source });
      } else devSource = source;
      return { code: code.replace(m[0], `bbOpaqueWorkerFactory(${JSON.stringify(path)})`) + factory, map: null };
    },
    configureServer(server) {
      server.middlewares.use('/@bb/nym-worker.js', (_req, res) => {
        res.setHeader('content-type', 'text/javascript');
        res.end(devSource);
      });
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
      // The mixnet worker's code is loaded by a worker with an opaque origin, which the service
      // worker never sees: the browser's HTTP cache keeps it (`_headers`: immutable).
      // The pages by the paths every static host serves without a redirect ('/', '/tunnel/'): hosts
      // that drop `.html` (Cloudflare, Netlify) answer '/index.html' with a redirect to '/'.
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && !f.startsWith('assets/nym-worker-') && !f.endsWith('.html'));
      const shell = ['/', '/tunnel/', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
      const list = [...new Set([...shell, ...files.map((f) => '/' + f)])];
      const version = createHash('sha256').update(list.join(' ')).update(JSON.stringify(Object.values(bundle).map((b) => ('code' in b ? b.code.length : 0)))).digest('hex').slice(0, 16);
      const sw = `// Generated at build. Serves the app from its cache; never touches /v1/.
const CACHE = 'blindbook-${version}';
const FILES = ${JSON.stringify(list)};
// A response that came through a redirect is stored as a plain copy: a browser refuses a
// redirected response as the answer to a navigation, so the app would not open from the cache.
const store = (c, f) => fetch(f).then(async (r) => {
  if (!r.ok) throw new Error(f + ': ' + r.status);
  return c.put(f, r.redirected ? new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: r.headers }) : r);
});
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(FILES.map((f) => store(c, f)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/v1/') || u.pathname.startsWith('/dev/')) return;
  // Navigations get the app shell (the URL never changes inside the app, and proof links ride after #).
  const key = e.request.mode === 'navigate' ? (u.pathname === '/tunnel/' ? '/tunnel/' : '/') : u.pathname;
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
      for (const html of ['index.html', 'tunnel/index.html']) {
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

/** A build for real users (through the mixnet) must pin the deployment's own keys and API: the
 *  devserver's test keys are public, and a withdrawal sealed to the test seal key could be opened
 *  by anyone (THREAT_MODEL X2). */
function pinnedKeysPlugin(): Plugin {
  return {
    name: 'bb-pinned-keys',
    apply: 'build',
    configResolved(c) {
      const mixnet = c.env.VITE_BB_MIXNET === '1';
      const onion = c.env.VITE_BB_ONION === '1';
      if (mixnet && onion) throw new Error('a build is either for the mixnet or for the .onion mirror');
      if (!mixnet && !onion) return;
      // The .onion build talks to its own origin; the mixnet build to the API's address, from tunnel
      // frames whose policy names the app's origins (cspPlugin).
      const missing = ['VITE_BB_M', 'VITE_BB_SEAL_PK', ...(mixnet ? ['VITE_BB_API', 'VITE_BB_APP_ORIGIN'] : [])].filter((k) => !c.env[k]);
      if (missing.length) throw new Error(`a ${mixnet ? 'mixnet' : '.onion'} build needs ${missing.join(', ')} (never the devserver's test keys)`);
    },
  };
}

export default defineConfig({
  plugins: [react(), opaqueMixnetWorkerPlugin(), pinnedKeysPlugin(), cspPlugin(), serviceWorkerPlugin(), integrityPlugin()],
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      // The app, and the tunnel frame (its own copy of mix-fetch per frame).
      input: { index: 'index.html', tunnel: 'tunnel/index.html' },
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
  // Not pre-bundled, so the dev server applies opaqueMixnetWorkerPlugin too.
  optimizeDeps: { exclude: ['@nymproject/mix-fetch', '@nymproject/mix-tunnel'] },
});
