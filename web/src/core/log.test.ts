import { describe, expect, it } from 'vitest';
import type { Api } from './api';
import { SEGMENT, deltaTexts } from './log';

/** A log of `n` deltas whose text is just its number; `missing` segments answer 404. */
function fakeApi(n: number, missing: number[] = []) {
  const asked: string[] = [];
  const api = {
    async text(path: string) {
      asked.push(path);
      const seg = /^\/v1\/segment\/(\d+)\.jsonl\.gz$/.exec(path);
      if (seg) {
        const k = Number(seg[1]);
        if (missing.includes(k) || (k + 1) * SEGMENT > n) throw new Error('404');
        return Array.from({ length: SEGMENT }, (_, i) => `{"seq":${k * SEGMENT + i + 1}}`).join('\n') + '\n';
      }
      const d = /^\/v1\/delta\/(\d+)\.json\.gz$/.exec(path);
      if (d && Number(d[1]) >= 1 && Number(d[1]) <= n) return `{"seq":${d[1]}}`;
      throw new Error('404');
    },
  } as unknown as Api;
  return { api, asked };
}

const seqs = (texts: string[]) => texts.map((t) => (JSON.parse(t) as { seq: number }).seq);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('deltaTexts', () => {
  it('reads whole segments, then the tail one by one, in order', async () => {
    const n = 2 * SEGMENT + 5;
    const { api, asked } = fakeApi(n);
    expect(seqs(await deltaTexts(api, 1, n, n))).toEqual(range(1, n));
    expect(asked.filter((p) => p.includes('segment'))).toHaveLength(2);
    expect(asked.filter((p) => p.includes('delta'))).toHaveLength(5);
  });

  it('starts in the middle of a segment and stops before the head', async () => {
    const n = 3 * SEGMENT;
    const { api } = fakeApi(n);
    expect(seqs(await deltaTexts(api, 100, 2 * SEGMENT + 3, n))).toEqual(range(100, 2 * SEGMENT + 3));
  });

  it('falls back to single deltas when a segment is missing', async () => {
    const n = 2 * SEGMENT;
    const { api, asked } = fakeApi(n, [0]);
    expect(seqs(await deltaTexts(api, 1, n, n))).toEqual(range(1, n));
    expect(asked.filter((p) => p.includes('delta'))).toHaveLength(SEGMENT);
  });

  it('reports progress up to the total and reads nothing for an empty range', async () => {
    const n = SEGMENT + 2;
    const { api, asked } = fakeApi(n);
    let last = 0;
    await deltaTexts(api, 1, n, n, (done, of) => {
      expect(of).toBe(n);
      last = done;
    });
    expect(last).toBe(n);
    asked.length = 0;
    expect(await deltaTexts(api, 5, 4, n)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
