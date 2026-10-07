// Proof-of-work across 2–4 workers (PROTOCOL section 1: 16 bits ≈ 35 ms, 20 bits ≈ 0.5 s on one
// desktop thread). Each worker searches its own residue class of nonces; the first answer wins.

import { bodyDigest } from '../core/pow';
import type { PowFn } from '../core/api';

const WORKERS = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

export const powInWorkers: PowFn = async (body, bits) => {
  const digest = bodyDigest(body);
  const workers: Worker[] = [];
  try {
    const nonce = await new Promise<number>((resolve, reject) => {
      for (let i = 0; i < WORKERS; i++) {
        const w = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
        workers.push(w);
        w.onmessage = (e: MessageEvent<{ nonce: number }>) => resolve(e.data.nonce);
        w.onerror = (e) => reject(new Error(e.message));
        w.postMessage({ digest, bits, start: i, step: WORKERS });
      }
    });
    return { ...body, pow: { nonce } };
  } finally {
    workers.forEach((w) => w.terminate());
  }
};
