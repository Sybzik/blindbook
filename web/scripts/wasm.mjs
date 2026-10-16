// Build the engine's wasm32 replay (crates/blindbook-engine-wasm) and copy it where the app
// imports it: the browser verifier runs the exact engine code the server runs.
//
// The wasm carries the source paths of its panic messages. Each source directory is remapped to
// one machine-independent spelling (forward slashes; dependencies under /cargo instead of this
// machine's cargo home), so the file names no local user or folder and two builds of one commit
// give the same bytes on any machine with the same Rust.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cargoHome = resolve(process.env.CARGO_HOME || join(homedir(), '.cargo'));

// Every package the wasm is built from, and where its sources are.
const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--filter-platform', 'wasm32-unknown-unknown'], { cwd: root, maxBuffer: 1 << 28 }).toString());
const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
const deps = new Map(meta.resolve.nodes.map((n) => [n.id, n.deps.filter((d) => d.dep_kinds.some((k) => k.kind === null)).map((d) => d.pkg)]));
const seen = new Set();
for (const todo = [meta.packages.find((p) => p.name === 'blindbook-engine-wasm').id]; todo.length; ) {
  const id = todo.pop();
  if (!seen.has(id)) (seen.add(id), todo.push(...deps.get(id)));
}
const dirsUnder = (d) => [d, ...readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => dirsUnder(join(d, e.name)))];
const flags = [];
for (const id of seen) {
  const pkg = pkgs.get(id);
  // Proc macros run at build time and leave no paths in the wasm.
  if (pkg.targets.every((t) => t.kind.includes('proc-macro'))) continue;
  // The directories the library is compiled from (src/, or wherever its lib.rs is).
  const lib = pkg.targets.find((t) => t.kind.some((k) => k.endsWith('lib')));
  if (!lib) continue;
  for (const d of dirsUnder(dirname(lib.src_path))) {
    // Workspace members are compiled with paths relative to the root, dependencies with absolute ones.
    const rel = relative(root, d);
    const inRoot = !rel.startsWith('..') && !isAbsolute(rel); // another drive gives an absolute path
    const from = inRoot ? rel : d;
    const to = inRoot ? rel.split(sep).join('/') : '/cargo/' + relative(cargoHome, d).split(sep).join('/');
    if (from) flags.push(`--remap-path-prefix=${from}${sep}=${to}/`);
  }
}
// Any other absolute path under the cargo home or the checkout still names no one. No symbol names
// either: they carry hashes of the build's settings, and the verifier needs none of them.
flags.unshift('-Cstrip=symbols', `--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${root}=/src`);
const encoded = flags.join('\x1f');
if (encoded.length > 30_000) throw new Error(`too many source directories to remap (${encoded.length} chars)`);

execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'blindbook-engine-wasm'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: encoded },
});
const target = process.env.CARGO_TARGET_DIR || join(root, 'target');
const out = join(root, 'web', 'src', 'wasm');
mkdirSync(out, { recursive: true });
copyFileSync(join(target, 'wasm32-unknown-unknown', 'release', 'blindbook_engine_wasm.wasm'), join(out, 'engine.wasm'));
console.log('engine.wasm ready');
