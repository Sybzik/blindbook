// Compare the wasm32 engine trace with the native one, byte for byte (PROTOCOL 5.6, THREAT_MODEL I5).
// Usage: node check-determinism.mjs <blindbook_engine_wasm.wasm> <trace-native.bin>
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [wasmPath, nativePath] = process.argv.slice(2);
if (!wasmPath || !nativePath) {
  console.error('usage: node check-determinism.mjs <engine.wasm> <trace-native.bin>');
  process.exit(2);
}
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const x = instance.exports;
const n = x.vectors_run();
const wasmTrace = Buffer.from(new Uint8Array(x.memory.buffer, x.buf_ptr(), n));
const nativeTrace = readFileSync(nativePath);
const sha = (b) => createHash('sha256').update(b).digest('hex');
console.log(`wasm   ${wasmTrace.length} bytes sha256 ${sha(wasmTrace)}`);
console.log(`native ${nativeTrace.length} bytes sha256 ${sha(nativeTrace)}`);
if (Buffer.compare(wasmTrace, nativeTrace) !== 0) {
  let i = 0;
  while (i < Math.min(wasmTrace.length, nativeTrace.length) && wasmTrace[i] === nativeTrace[i]) i++;
  console.error(`DETERMINISM FAILURE: traces differ at byte ${i} (word ${Math.floor(i / 8)})`);
  process.exit(1);
}
console.log(`DETERMINISM OK: byte-identical (${wasmTrace.length / 8} 64-bit words)`);
