import { describe, expect, it } from 'vitest';
import type { Api } from './api';
import { ChainBroken, checkCall, rootAfter, type CallBlock } from './calls';
import { SEGMENT } from './log';

// A published log of `n` blocks: heights grow with gaps (empty blocks are skipped), a call in some.
function log(n: number) {
  const blocks: CallBlock[] = [];
  let root = '0'.repeat(64);
  let height = 4_480_000;
  for (let seq = 1; seq <= n; seq++) {
    height += 1 + (seq % 4 === 0 ? 3 : 0);
    const b: CallBlock = { seq, height, prev_root: root, batches: seq % 7 === 0 ? [{ market: 'm' + (seq % 3), orders: [{ tag: 'tag-' + seq, side: 'buy', outcome: seq % 2 }], fills: [{ out: 1_000 + seq, kept: 990, avg_price_bp: 5_000 + seq }] }] : [] };
    blocks.push(b);
    root = rootAfter(root, b);
  }
  return { blocks, head: { height, seq: n, root, pow_bits: { light: 8, heavy: 10 } } };
}

function fakeApi(blocks: CallBlock[], head: { height: number; seq: number; root: string }) {
  const reads: string[] = [];
  const api = {
    head: async () => head,
    text: async (path: string) => {
      reads.push(path);
      let m = path.match(/^\/v1\/delta\/(\d+)\.json\.gz$/);
      if (m) return JSON.stringify(blocks[Number(m[1]) - 1]);
      m = path.match(/^\/v1\/segment\/(\d+)\.jsonl\.gz$/);
      if (m) return blocks.slice(Number(m[1]) * SEGMENT, (Number(m[1]) + 1) * SEGMENT).map((b) => JSON.stringify(b)).join('\n') + '\n';
      throw new Error('404 ' + path);
    },
  };
  return { api: api as unknown as Api, reads };
}

describe('checking a CALLED IT proof', () => {
  it('finds a recent call reading only its block and the ones since', async () => {
    const { blocks, head } = log(1_000);
    const { api, reads } = fakeApi(blocks, head);
    const call = blocks[993]!; // seq 994, a call (994 % 7 === 0)
    const r = await checkCall(api, 'tag-994', call.height);
    expect('found' in r && r.found).toMatchObject({ seq: 994, height: call.height, market: call.batches[0]!.market, shares: 1_994, avgPriceBp: 5_994 });
    expect('found' in r && r.blocks).toBe(7);
    // the search: a handful of single blocks; then 7 blocks
    expect(reads.length).toBeLessThan(25);
  });

  it('finds an old call through segments, and rejects a log whose later block was changed', async () => {
    const { blocks, head } = log(1_000);
    const r = await checkCall(fakeApi(blocks, head).api, 'tag-14', blocks[13]!.height);
    expect('found' in r && r.found.seq).toBe(14);
    const forged = blocks.map((b) => (b.seq === 500 ? { ...b, batches: [{ market: 'x', orders: [{ tag: 'mine', side: 'buy', outcome: 0 }], fills: [{ out: 9, kept: 9, avg_price_bp: 1 }] }] } : b));
    await expect(checkCall(fakeApi(forged, head).api, 'tag-14', blocks[13]!.height)).rejects.toBeInstanceOf(ChainBroken);
  });

  it('waits for a call newer than the head, and says when a tag is not where the proof puts it', async () => {
    const { blocks, head } = log(200);
    const { api } = fakeApi(blocks, head);
    expect(await checkCall(api, 'tag-x', head.height + 1)).toMatchObject({ pending: true });
    expect(await checkCall(api, 'tag-x', blocks[69]!.height)).toMatchObject({ missing: true });
    // height unknown (shared before its block came out): the newest blocks, then wait
    expect(await checkCall(api, 'tag-196', 0)).toMatchObject({ found: { seq: 196 } });
    expect(await checkCall(api, 'tag-x', 0)).toMatchObject({ pending: true });
  });
});
