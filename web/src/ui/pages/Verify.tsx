// P400 verify: the browser downloads the public log (the same files every visitor gets) and
// checks it itself: the hash chain to the published head, every blind signature's DLEQ proof
// against keys derived from the pinned M, and the supply per keyset. It also checks a CALLED IT
// proof carried after "#p=" in a link: the proof never reaches any server.

import { useEffect, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as cashu from '@cashu/cashu-ts';
import { KeyButton, LeaderRow, Stamp, TeletextHeader, TextInput } from '../../ds';
import { Win } from '../win';
import { app, getApi } from '../../app/services';
import { useStore } from '../../app/store';
import { config } from '../../app/config';
import { canonical } from '../../core/canonical';
import { concat, fromHex, toHex, utf8 } from '../../core/bytes';
import { creditKeyset, keyFor, outcomeKeyset, type Keyset } from '../../core/keysets';
import { decodeProof } from '../../core/codes';
import { deltaTexts } from '../../core/log';
import { coin, height, zat } from '../../app/format';
import { COIN } from '../../app/config';
import { play } from '../sound';

interface LogEvent {
  type: string;
  txid?: string;
  root?: string;
  market?: string;
  keysets?: [string, string];
  commitment?: string;
  commitments?: string[];
  amount?: number;
  den?: number;
  num?: [number, number];
  height?: number;
  reserve_zat?: number;
  unswept_zat?: number;
  duel?: string;
  stake?: number;
}

interface Delta {
  seq: number;
  height: number;
  prev_root: string;
  issued: { id: string; amount: number; B_: string; C_: string; dleq: { e: string; s: string } }[];
  spent: { Y: string; id: string; amount: number }[];
  batches: { market: string; batch_id: number; orders: { tag: string; side: string; outcome: number; amount: number; limit_bp: number }[]; fills: { tag: string; status: string; out: number; kept: number; fee: number; avg_price_bp: number }[] }[];
  events: LogEvent[];
}

export interface Result {
  deltas: number;
  root: string;
  chainOk: boolean;
  sigs: number;
  sigsOk: number;
  /** Every listed market's keyset ids are the ones derived from M. */
  keysetsOk: boolean;
  supplyOk: boolean;
  supply: [string, number, number][];
  anchors: { txid: string; root: string }[];
  liabilitiesZat: number;
  /** The last reserve report and the liabilities at that point of the log. */
  reserve: { height: number; reserveZat: number; unsweptZat: number; owedZat: number } | null;
  /** Top-ups credited since the last report (their money is in the deposit account). */
  creditedSinceZat: number;
  solventOk: boolean;
  /** The engine's replay of every batch (wasm), null before it ran. */
  replay: { batches: number; failures: string[] } | null;
  ms: number;
}

const GENESIS = '0'.repeat(64);
/** One unit of CREDIT or of a share is 0.00001 ZEC. */
const ZAT_PER_UNIT = 1_000;

export async function fetchDeltas(onProgress?: (n: number, of: number) => void): Promise<{ deltas: Delta[]; texts: string[]; head: { seq: number; root: string; height: number } }> {
  const api = getApi();
  const head = await api.head();
  const texts = await deltaTexts(api, 1, head.seq, head.seq, onProgress);
  const deltas = texts.map((t) => JSON.parse(t) as Delta);
  return { deltas, texts, head };
}

/** Every batch through the pricing engine again, in this browser: the engine's own code built
 *  for wasm32 (crates/blindbook-engine-wasm), the same the server runs. */
async function replayBatches(texts: string[]): Promise<{ batches: number; failures: string[] }> {
  const { default: url } = await import('../../wasm/engine.wasm?url');
  const { instance } = await WebAssembly.instantiateStreaming(fetch(url), {});
  const x = instance.exports as { memory: WebAssembly.Memory; alloc(n: number): number; replay(): number; buf_ptr(): number };
  const input = new TextEncoder().encode('[' + texts.join(',') + ']');
  const ptr = x.alloc(input.length);
  new Uint8Array(x.memory.buffer, ptr, input.length).set(input);
  const n = x.replay();
  return JSON.parse(new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.buf_ptr(), n))) as { batches: number; failures: string[] };
}

/** Download the public log and check it; shared by P400 and the console's "verify". */
export async function runAudit(onProgress?: (s: string) => void): Promise<{ result: Result; deltas: Delta[] }> {
  const t0 = performance.now();
  const { deltas, texts, head } = await fetchDeltas((n, of) => onProgress?.(`delta ${n} of ${of}`));
  onProgress?.('checking');
  const r = audit(deltas, head.root);
  onProgress?.('replaying every batch through the engine');
  let replay: Result['replay'] = null;
  try {
    replay = await replayBatches(texts);
  } catch (e) {
    replay = { batches: 0, failures: [`the engine could not run here: ${(e as Error).message}`] };
  }
  return { result: { ...r, replay, ms: Math.round(performance.now() - t0) }, deltas };
}

function audit(deltas: Delta[], headRoot: string): Omit<Result, 'ms' | 'replay'> {
  let prev = GENESIS;
  let chainOk = true;
  for (const d of deltas) {
    if (d.prev_root !== prev) chainOk = false;
    const digest = sha256(utf8(canonical(d)));
    prev = toHex(sha256(concat(fromHex(prev), digest)));
  }
  if (deltas.length && prev !== headRoot) chainOk = false;

  // Keysets come from the log itself (every market listed in it), derived here from M.
  const names = new Map(app.get().markets.map((m) => [m.id, m]));
  const keysets = new Map<string, { ks: Keyset; name: string; market?: string; outcome?: 0 | 1 }>();
  const credit = creditKeyset(config.m);
  keysets.set(credit.id, { ks: credit, name: 'CREDIT' });
  let keysetsOk = true;
  let sigs = 0;
  let sigsOk = 0;
  const supply = new Map<string, [number, number]>();
  const markets = new Set<string>();
  const resolved = new Map<string, { den: number; num: [number, number] }>();
  const queued = new Map<string, number>();
  const duels = new Map<string, number>();
  let reserve: Result['reserve'] = null;
  let solventOk = true;
  let owed = 0;
  let creditedSince = 0;
  const out = (name: string) => {
    const v = supply.get(name);
    return v ? Math.max(0, v[0] - v[1]) : 0;
  };
  const liabilities = () => {
    let units = out('CREDIT');
    for (const m of markets) {
      const a = out(m + ':A');
      const b = out(m + ':B');
      const r = resolved.get(m);
      units += r && r.den > 0 ? Math.ceil((a * r.num[0] + b * r.num[1]) / r.den) : Math.max(a, b);
    }
    for (const v of queued.values()) units += v;
    for (const v of duels.values()) units += v;
    return units * ZAT_PER_UNIT;
  };
  const add = (name: string, i: 0 | 1, n: number) => {
    const v = supply.get(name) ?? [0, 0];
    v[i] += n;
    supply.set(name, v);
  };
  for (const d of deltas) {
    const reports: LogEvent[] = [];
    for (const e of d.events) {
      if (e.type === 'market_listed' && e.market && e.keysets) {
        markets.add(e.market);
        for (const o of [0, 1] as const) {
          const ks = outcomeKeyset(config.m, e.market, o);
          if (ks.id !== e.keysets[o]) keysetsOk = false;
          keysets.set(ks.id, { ks, name: e.market + (o === 0 ? ':A' : ':B'), market: e.market, outcome: o });
        }
      } else if (e.type === 'withdrawal_queued' && e.commitment) queued.set(e.commitment, e.amount ?? 0);
      else if (e.type === 'payout_sent') for (const c of e.commitments ?? []) queued.delete(c);
      else if (e.type === 'resolved' && e.market && e.den !== undefined && e.num) resolved.set(e.market, { den: e.den, num: e.num });
      else if (e.type === 'reserve_reported') reports.push(e);
      else if (e.type === 'topup_credited') creditedSince += (e.amount ?? 0) * 1_000;
      else if (e.type === 'duel_opened' && e.duel) duels.set(e.duel, e.stake ?? 0);
      else if ((e.type === 'duel_taken' || e.type === 'duel_cancelled') && e.duel) duels.delete(e.duel);
    }
    for (const s of d.issued) {
      sigs++;
      const k = keysets.get(s.id);
      const K = k && keyFor(k.ks, s.amount);
      if (!k || !K) continue;
      try {
        if (cashu.verifyDLEQProof({ e: fromHex(s.dleq.e), s: fromHex(s.dleq.s) }, secp256k1.Point.fromHex(s.B_), secp256k1.Point.fromHex(s.C_), K)) sigsOk++;
      } catch {
        /* counted as failed */
      }
      add(k.name, 0, s.amount);
    }
    for (const s of d.spent) {
      const k = keysets.get(s.id);
      if (k) add(k.name, 1, s.amount);
    }
    owed = liabilities();
    for (const r of reports) {
      const res = r.reserve_zat ?? 0;
      const uns = r.unswept_zat ?? 0;
      if (res + uns < owed) solventOk = false;
      reserve = { height: r.height ?? d.height, reserveZat: res, unsweptZat: uns, owedZat: owed };
      creditedSince = 0;
    }
  }
  // Rows named for people: "P202 NAVI" instead of a market id.
  const label = (n: string) => {
    if (n === 'CREDIT') return n;
    const [id, ab] = n.split(':');
    const m = names.get(id!);
    return m ? `${m.page} ${m.outcomes[ab === 'A' ? 0 : 1].toUpperCase()}` : `${id!.slice(0, 8)}… ${ab}`;
  };
  const rows = [...supply.entries()].map(([n, [i, s]]) => [label(n), i, s] as [string, number, number]);
  const anchors = deltas.flatMap((d) => d.events.filter((e) => e.type === 'anchored').map((e) => ({ txid: e.txid ?? '', root: e.root ?? '' })));
  return {
    deltas: deltas.length,
    root: prev,
    chainOk,
    sigs,
    sigsOk,
    keysetsOk,
    supplyOk: [...supply.values()].every(([i, sp]) => sp <= i),
    supply: rows,
    anchors,
    liabilitiesZat: owed,
    reserve,
    creditedSinceZat: creditedSince,
    // At every report, and now: what is owed now against the last report plus the top-ups since.
    solventOk: reserve !== null && solventOk && owed <= reserve.reserveZat + reserve.unsweptZat + creditedSince,
  };
}

function ProofCheck({ deltas, proof }: { deltas: Delta[] | null; proof?: string }) {
  const markets = useStore(app, (s) => s.markets);
  const [text, setText] = useState(proof ?? '');
  const [res, setRes] = useState<{ ok: boolean; line: string } | null>(null);
  const check = (t = text) => {
    try {
      const p = decodeProof(t);
      for (const d of deltas ?? []) {
        for (const b of d.batches) {
          const i = b.orders.findIndex((o) => o.tag === p.tag);
          if (i < 0) continue;
          const o = b.orders[i]!;
          const f = b.fills[i]!;
          const m = markets.find((x) => x.id === b.market);
          play('stamp');
          setRes({
            ok: true,
            line: `${o.side === 'buy' ? 'bought' : 'sold'} ${m ? m.outcomes[o.outcome]!.toUpperCase() : 'outcome ' + o.outcome} · ${coin(o.side === 'buy' ? f.out : f.kept)} shares @ ${Math.round(f.avg_price_bp / 100)}¢ · blk ${height(d.height)} · ${m?.question ?? b.market}`,
          });
          return;
        }
      }
      setRes({ ok: false, line: 'This proof is not in the public log: it is not genuine, or the log you downloaded is older than the call.' });
    } catch {
      setRes({ ok: false, line: 'That is not a CALLED IT proof: the link is incomplete or was changed.' });
    }
  };
  // Opened from a proof link: check it as soon as the log is in.
  useEffect(() => {
    if (proof && deltas) check(proof);
  }, [deltas]);
  return (
    <div style={{ maxWidth: 640, marginTop: 24 }}>
      {res && (
        <div className="tk-proofres" role="status">
          <Stamp tone={res.ok ? 'phosphor' : 'alarm'} size="lg" rotate={-4} worn={false} slam>{res.ok ? 'VERIFIED ✓' : 'NOT FOUND'}</Stamp>
          <p className="bb-ui">{res.line}</p>
          {res.ok && <p className="bb-conditions">Checked in this browser against the public log. It proves this one call and nothing else: not who made it, their balance or their other bets.</p>}
        </div>
      )}
      <TextInput label="CHECK A CALLED IT PROOF" placeholder="bbproof1:… or a link" value={text} onChange={setText} message="Checked here, against the public log. The proof is never sent anywhere." />
      <div style={{ marginTop: 8 }}>
        <KeyButton size="sm" disabled={!text || !deltas} onClick={() => check()} data-hint={deltas ? undefined : 'Run the verifier first: the proof is checked against the log it downloads.'}>CHECK PROOF</KeyButton>
      </div>
    </div>
  );
}

/** RUN IT YOURSELF: the full audit, every batch replayed through the engine, the reserve and
 *  the anchors checked on-chain, every result read again from Polygon. The command is public;
 *  copying it sends nothing. */
function RunIt() {
  const [copied, setCopied] = useState(false);
  const api = config.api || location.origin;
  const cmd = `cargo run --release -p blindbook-verify -- ${config.m} ${api} --chain ${config.network === 'mainnet' ? 'zecrocks-main' : 'zecrocks'} --polygon public`;
  return (
    <div style={{ maxWidth: 680, marginTop: 20 }}>
      <p className="bb-label bb-hi tk-sec">RUN IT YOURSELF</p>
      <pre className="tk-cmd">$ {cmd}</pre>
      <p className="bb-ui bb-dim" style={{ margin: '6px 0' }}>
        Everything above, plus the chain: it syncs the reserve with its public viewing key, opens every anchor, and reads every market's result again from Polygon. Add ALL_PROXY=socks5h://127.0.0.1:9050 to fetch over Tor.
      </p>
      <KeyButton size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(cmd).then(() => setCopied(true), () => setCopied(false))}>
        {copied ? 'COPIED ✓' : 'COPY COMMAND'}
      </KeyButton>
    </div>
  );
}

function Bars({ label, value, max }: { label: string; value: number; max: number }) {
  const n = 24;
  const on = Math.round((value / Math.max(1, max)) * n);
  return (
    <div className="tk-bars">
      <span className="bb-label">{label}</span>
      <span className="tk-bars__cells" aria-hidden="true">
        {Array.from({ length: n }, (_, i) => (
          <i key={i} className={i < on ? 'is-on' : ''} />
        ))}
      </span>
      <span className="bb-ui">{zat(value)}</span>
    </div>
  );
}

export function VerifyPage({ onClose, proof }: { onClose: () => void; proof?: string }) {
  const head = useStore(app, (s) => s.head);
  const [run, setRun] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [deltas, setDeltas] = useState<Delta[] | null>(null);
  const go = async () => {
    setRun('running');
    try {
      const { result, deltas } = await runAudit(setProgress);
      setDeltas(deltas);
      setRes(result);
      setRun('done');
      play('stamp');
    } catch (e) {
      setProgress(String((e as Error).message));
      setRun('error');
    }
  };
  useEffect(() => {
    if (proof) void go();
  }, []);
  return (
    <Win title="P400 · VERIFY" onClose={onClose}>
      <TeletextHeader page="P400" title="VERIFY IT YOURSELF" />
      <div style={{ maxWidth: 680, marginTop: 12 }}>
        <LeaderRow label="PUBLIC LOG" value={head ? `seq ${head.seq.toLocaleString('en-US')} · root ${head.root.slice(0, 8)}…${head.root.slice(-4)}` : '…'} />
        <LeaderRow label="CHAIN HEIGHT" value={head ? 'blk ' + height(head.height) : '…'} />
        <LeaderRow label="KEYSETS" value="derived here from the master key pinned in this app" />
        {res && (
          <>
            <LeaderRow label="HASH CHAIN" value={res.chainOk ? `${res.deltas} deltas link up to the head ✓` : 'BROKEN ✗'} tone={res.chainOk ? 'hi' : 'alarm'} />
            <LeaderRow label="SIGNATURES" value={`${res.sigsOk} of ${res.sigs} DLEQ proofs valid for keys derived from M`} tone={res.sigsOk === res.sigs ? 'hi' : 'alarm'} />
            {res.replay && (
              <LeaderRow
                label="BATCHES REPLAYED"
                value={res.replay.failures.length ? `${res.replay.failures.length} differ ✗ · ${res.replay.failures[0]}` : `${res.replay.batches} through the pricing engine, same fills and pools ✓`}
                tone={res.replay.failures.length ? 'alarm' : 'hi'}
              />
            )}
            <LeaderRow label="KEYSETS IN THE LOG" value={res.keysetsOk ? 'every market uses the keys derived from M ✓' : 'a market uses keys not derived from M ✗'} tone={res.keysetsOk ? 'hi' : 'alarm'} />
            <LeaderRow label="SUPPLY" value={res.supplyOk ? 'nothing spent beyond what was issued ✓' : 'more spent than issued ✗'} tone={res.supplyOk ? 'hi' : 'alarm'} />
            <LeaderRow label="ON-CHAIN ANCHORS" value={res.anchors.length ? `${res.anchors.length} · last ${res.anchors.at(-1)!.txid.slice(0, 10)}…` : 'none yet'} />
            <LeaderRow label="TOOK" value={`${(res.ms / 1000).toFixed(1)} s, in this browser`} tone="dim" />
          </>
        )}
      </div>
      {run === 'running' && <p className="tk-hex" aria-live="polite">{progress}</p>}
      {run === 'error' && <p className="bb-conditions" style={{ color: 'var(--alarm)' }}>{progress}</p>}
      {run === 'done' && res && (
        <div className="row" style={{ gap: 16, margin: '20px 0', flexWrap: 'wrap' }}>
          {res.chainOk && res.replay?.failures.length === 0 && <Stamp tone="phosphor" rotate={-3} worn={false}>LEDGER MATCH ✓</Stamp>}
          {res.sigsOk === res.sigs && res.keysetsOk && <Stamp tone="phosphor" rotate={2} worn={false}>NO TAGGED KEYS ✓</Stamp>}
          {res.supplyOk && <Stamp tone="phosphor" rotate={-2} worn={false}>SUPPLY ✓</Stamp>}
          {res.solventOk && <Stamp tone="phosphor" rotate={3} worn={false}>SOLVENT ✓</Stamp>}
          {res.anchors.length > 0 && <Stamp tone="phosphor" rotate={-1} worn={false}>ANCHORED ✓</Stamp>}
        </div>
      )}
      {res && (
        <div style={{ maxWidth: 680, marginTop: 8 }}>
          <p className="bb-label bb-hi tk-sec">SOLVENCY</p>
          {res.reserve ? (
            <>
              <div className="tk-solv">
                <span className="bb-display-md bb-glow bb-hi">
                  {res.reserve.owedZat === 0 ? 'NOTHING OWED' : `${Math.floor(((res.reserve.reserveZat + res.reserve.unsweptZat) / res.reserve.owedZat) * 100).toLocaleString('en-US')}%`}
                </span>
                <span className="bb-ui bb-dim">reserve over what it owes, at blk {height(res.reserve.height)}</span>
              </div>
              <Bars label="RESERVE" value={res.reserve.reserveZat + res.reserve.unsweptZat} max={Math.max(res.reserve.reserveZat + res.reserve.unsweptZat, res.reserve.owedZat)} />
              <Bars label="LIABILITIES" value={res.reserve.owedZat} max={Math.max(res.reserve.reserveZat + res.reserve.unsweptZat, res.reserve.owedZat)} />
              {res.liabilitiesZat > res.reserve.reserveZat + res.reserve.unsweptZat + res.creditedSinceZat ? (
                <p className="bb-conditions" style={{ color: 'var(--alarm)' }}>
                  NOW: {zat(res.liabilitiesZat)} {COIN} owed, more than the {zat(res.reserve.reserveZat + res.reserve.unsweptZat)} reported at blk {height(res.reserve.height)}
                  {res.creditedSinceZat ? ` plus ${zat(res.creditedSinceZat)} topped up since` : ''}. Not covered until a reserve report shows more; the signer reports at least every 48 blocks.
                </p>
              ) : (
                <p className="bb-conditions">
                  NOW: {zat(res.liabilitiesZat)} {COIN} owed, covered by that report{res.creditedSinceZat ? ` and the ${zat(res.creditedSinceZat)} topped up since` : ''}.
                </p>
              )}
              <p className="bb-conditions">
                Liabilities: every CREDIT slip outstanding, the most either outcome of each market can pay, withdrawals not paid yet and stakes held by open duels, all from the log above.
                The reserve figure ({zat(res.reserve.reserveZat)} {COIN}{res.reserve.unsweptZat ? ` + ${zat(res.reserve.unsweptZat)} not swept yet` : ''}) is the signer's report. The reserve's viewing key is public: the command-line verifier below, with --chain, syncs it from the chain and checks the real balance.
              </p>
            </>
          ) : (
            <p className="bb-ui bb-dim">No reserve report in the log yet. Liabilities now: {zat(res.liabilitiesZat)} {COIN}.</p>
          )}
        </div>
      )}
      {res && res.supply.length > 0 && (
        <div style={{ maxWidth: 680 }}>
          <p className="bb-label tk-sec">OUTSTANDING PER KEYSET (issued − spent)</p>
          {res.supply.map(([n, i, s]) => (
            <LeaderRow key={n} label={n} value={`${coin(i - s)} (${coin(i)} − ${coin(s)})`} />
          ))}
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <KeyButton icon="verify" loading={run === 'running'} onClick={go} data-hint="Downloads the public log and checks it in your browser. Nothing is sent anywhere.">
          {run === 'running' ? 'CHECKING' : run === 'done' ? 'RUN AGAIN' : 'RUN VERIFIER'}
        </KeyButton>
      </div>
      <RunIt />
      <ProofCheck deltas={deltas} proof={proof} />
    </Win>
  );
}
