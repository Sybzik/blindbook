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
  "frame-ancestors 'none'",
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

export default defineConfig({
  plugins: [react(), cspPlugin()],
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
