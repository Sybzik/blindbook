// Proof-of-work in a worker: tries nonces start, start + step, … until one has `bits` zero bits.
import { solveDigest } from '../core/pow';

self.onmessage = (e: MessageEvent<{ digest: Uint8Array; bits: number; start: number; step: number }>) => {
  const { digest, bits, start, step } = e.data;
  postMessage({ nonce: solveDigest(digest, bits, start, step) });
};
