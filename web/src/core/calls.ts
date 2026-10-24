// Checking a CALLED IT proof against the public log without downloading all of it: the block the
// call was published in, and every block since, must hash up to the head everyone reads. That is
// what makes the call part of the one public log; the full verifier (F4) checks the rest.
//
// Each block's root is H(previous root ‖ H(canonical block)), and every block carries the previous
// root, so the call's block and the ones after it link to the head on their own. A call made a
// minute ago costs a few small requests; an old one, the blocks published since.

import { sha256 } from '@noble/hashes/sha2.js';
import type { Api, Head } from './api';
import { canonical } from './canonical';
import { concat, fromHex, toHex, utf8 } from './bytes';
import { readFile, deltaTexts } from './log';

export interface CallBlock {
  seq: number;
  height: number;
  prev_root: string;
  batches: { market: string; orders: { tag: string; side: string; outcome: number }[]; fills: { out: number; kept: number; avg_price_bp: number }[] }[];
}

export interface CallHit {
  seq: number;
  height: number;
  market: string;
  side: string;
  outcome: number;
  /** Shares bought, or CREDIT kept for a sale. */
  shares: number;
  avgPriceBp: number;
}

export type CallCheck =
  | { found: CallHit; head: Head; blocks: number }
  /** Not in the log yet: the call is newer than the head (it reaches the log with the next block). */
  | { pending: true; head: Head }
  | { missing: true; head: Head; blocks: number };

export class ChainBroken extends Error {}

export const rootAfter = (prev: string, block: unknown) => toHex(sha256(concat(fromHex(prev), sha256(utf8(canonical(block))))));

/** The root the blocks lead to, from the root before the first; throws if one doesn't name the
 *  root before it. */
export function linkUp(blocks: CallBlock[]): string {
  let root = blocks[0]!.prev_root;
  for (const b of blocks) {
    if (b.prev_root !== root) throw new ChainBroken(`block ${b.seq} does not follow block ${b.seq - 1}`);
    root = rootAfter(root, b);
  }
  return root;
}

const one = async (api: Api, seq: number) => JSON.parse(await readFile(api, `/v1/delta/${seq}.json.gz`)) as CallBlock;

/** The first published block at or above `height` (blocks only grow in height): an interpolation
 *  search, a handful of single-block reads. */
async function firstAtOrAbove(api: Api, height: number, head: Head): Promise<number> {
  let lo = 1;
  let hi = head.seq;
  let loH = (await one(api, lo)).height;
  if (loH >= height) return lo;
  let hiH = head.height;
  while (hi - lo > 1) {
    const guess = lo + Math.round(((height - loH) / Math.max(1, hiH - loH)) * (hi - lo));
    const mid = Math.min(hi - 1, Math.max(lo + 1, guess));
    const h = (await one(api, mid)).height;
    if (h >= height) {
      hi = mid;
      hiH = h;
    } else {
      lo = mid;
      loH = h;
    }
  }
  return hi;
}

/** Look for the call `tag`, published at `height` (0: not known yet, so the newest blocks). */
export async function checkCall(api: Api, tag: string, height: number, onProgress?: (done: number, of: number) => void): Promise<CallCheck> {
  const head = await api.head();
  if (height > head.height) return { pending: true, head };
  const from = height > 0 ? await firstAtOrAbove(api, height, head) : Math.max(1, head.seq - 8);
  const blocks = (await deltaTexts(api, from, head.seq, head.seq, onProgress)).map((t) => JSON.parse(t) as CallBlock);
  if (blocks.length === 0) return height > 0 ? { missing: true, head, blocks: 0 } : { pending: true, head };
  if (linkUp(blocks) !== head.root) throw new ChainBroken('the blocks do not hash up to the published head');
  for (const b of blocks) {
    if (height > 0 && b.height !== height) continue;
    for (const batch of b.batches) {
      const i = batch.orders.findIndex((o) => o.tag === tag);
      if (i < 0) continue;
      const o = batch.orders[i]!;
      const f = batch.fills[i]!;
      return { found: { seq: b.seq, height: b.height, market: batch.market, side: o.side, outcome: o.outcome, shares: o.side === 'buy' ? f.out : f.kept, avgPriceBp: f.avg_price_bp }, head, blocks: blocks.length };
    }
  }
  return height > 0 ? { missing: true, head, blocks: blocks.length } : { pending: true, head };
}

/** One of our own calls, looked up in the log from a height at or below the one it was published
 *  in (the bet's time, less a margin): its block, for a CALLED IT proof made after the fact. Null
 *  while it is newer than the published log. */
export async function findCall(api: Api, tag: string, notBefore: number): Promise<CallHit | null> {
  const head = await api.head();
  const from = await firstAtOrAbove(api, Math.max(1, notBefore), head);
  const blocks = (await deltaTexts(api, from, head.seq, head.seq)).map((t) => JSON.parse(t) as CallBlock);
  for (const b of blocks)
    for (const batch of b.batches) {
      const i = batch.orders.findIndex((o) => o.tag === tag);
      if (i < 0) continue;
      const o = batch.orders[i]!;
      const f = batch.fills[i]!;
      return { seq: b.seq, height: b.height, market: batch.market, side: o.side, outcome: o.outcome, shares: o.side === 'buy' ? f.out : f.kept, avgPriceBp: f.avg_price_bp };
    }
  return null;
}
