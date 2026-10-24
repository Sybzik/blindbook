// Reading the public log (PROTOCOL section 8): whole segments where they exist, single deltas for
// the rest, a few requests at a time. Every visitor reads the same files. The texts stay byte for
// byte as published, so no number passes through a JS double before the engine sees it.

import { ApiError, type Api } from './api';

/** One public file, read again after a dropped connection (a long read over a flaky line or the
 *  mixnet loses a request now and then): up to 4 tries, waiting 0.5, 1 and 2 s between them. A
 *  file the server says isn't there (404) isn't asked for again. */
export async function readFile(api: Api, path: string, tries = 4): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await api.text(path);
    } catch (e) {
      if (i + 1 >= tries || (e instanceof ApiError && e.status === 404)) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

/** Deltas per segment and per short segment, as the server writes them (crates/blindbook-api/src/files.rs). */
export const SEGMENT = 384;
export const MINI = 64;

interface Job {
  start: number;
  end: number;
  /** The complete file holding `start..=end`: a segment, or a short one past the last segment. */
  file: { dir: 'segment' | 'mini'; k: number; size: number } | null;
}

/** The raw texts of deltas `from..=to`. `headSeq` (the published head) says which segments are
 *  complete; a segment that can't be read falls back to its deltas one by one. */
export async function deltaTexts(
  api: Api,
  from: number,
  to: number,
  headSeq: number,
  onProgress?: (done: number, of: number) => void,
  parallel = 4,
): Promise<string[]> {
  if (to < from) return [];
  const jobs: Job[] = [];
  for (let seq = from; seq <= to; ) {
    const k = Math.floor((seq - 1) / SEGMENT);
    const j = Math.floor((seq - 1) / MINI);
    const file = (k + 1) * SEGMENT <= headSeq ? { dir: 'segment' as const, k, size: SEGMENT } : (j + 1) * MINI <= headSeq ? { dir: 'mini' as const, k: j, size: MINI } : null;
    if (file) {
      const end = Math.min((file.k + 1) * file.size, to);
      jobs.push({ start: seq, end, file });
      seq = end + 1;
    } else {
      jobs.push({ start: seq, end: seq, file: null });
      seq++;
    }
  }
  const one = (seq: number) => readFile(api, `/v1/delta/${seq}.json.gz`);
  async function run(j: Job): Promise<string[]> {
    if (j.file) {
      const { dir, k, size } = j.file;
      try {
        const lines = (await readFile(api, `/v1/${dir}/${k}.jsonl.gz`, 2)).split('\n').filter((l) => l.length > 0);
        const first = k * size + 1;
        if (lines.length === size) return lines.slice(j.start - first, j.end - first + 1);
      } catch {
        /* not there (an older server): one by one */
      }
    }
    const out: string[] = [];
    for (let s = j.start; s <= j.end; s++) out.push(await one(s));
    return out;
  }
  const results: string[][] = new Array<string[]>(jobs.length);
  const total = to - from + 1;
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      const j = jobs[i]!;
      results[i] = await run(j);
      done += j.end - j.start + 1;
      onProgress?.(done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  return results.flat();
}
