// Build the engine's wasm32 replay (crates/blindbook-engine-wasm) and copy it where the app
// imports it: the browser verifier runs the exact engine code the server runs.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'blindbook-engine-wasm'], { cwd: root, stdio: 'inherit' });
const target = process.env.CARGO_TARGET_DIR || join(root, 'target');
const out = join(root, 'web', 'src', 'wasm');
mkdirSync(out, { recursive: true });
copyFileSync(join(target, 'wasm32-unknown-unknown', 'release', 'blindbook_engine_wasm.wasm'), join(out, 'engine.wasm'));
console.log('engine.wasm ready');
