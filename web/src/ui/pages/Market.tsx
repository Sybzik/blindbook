// P100 market index, P2xx market page (chart of both outcomes, RULES, recent fills, bet panel)
// and the CALLED IT card.

import { useContext, useEffect, useMemo, useState } from 'react';
import {
  AlarmBanner,
  AmountChips,
  BettingSlip,
  CalledItCard,
  FillRow,
  KeyButton,
  LeaderRow,
  OutcomePill,
  PayoutPreview,
  RulesPanel,
  ScopeChart,
  Stamp,
  TeletextHeader,
  TradeConditions,
} from '../../ds';
import { Win, WinCtx } from '../win';
import { app, actions, type MarketMeta, type Point } from '../../app/services';
import { useStore } from '../../app/store';
import { BET_UNITS, COIN, config } from '../../app/config';
import { coin, countdown, haltText, height, utc } from '../../app/format';
import type { FillRecord, LiveMarket, TradeAnswer } from '../../core/api';
import { calledItSecret, encodeProof } from '../../core/codes';
import { currentWallet, earnStamp } from '../../app/services';
import { Qr } from '../Qr';
import { drawCalledIt, savePng } from '../cards';
import { openWindow, ui } from '../uistate';
import { play } from '../sound';

export interface FilledSlip {
  serial: string;
  market: string;
  outcome: string;
  side: 'a' | 'b';
  shares: string;
  price: string;
  stake: string;
  block: number;
  status: 'open' | 'refunded';
  tag: string;
  calledIndex?: number;
  at_ms: number;
}

function statusOf(meta: MarketMeta, live?: LiveMarket): 'OPEN' | 'HALTED' | 'RESOLVING' | 'RESOLVED' {
  if (meta.resolved || live?.state === 'resolved') return 'RESOLVED';
  if (live?.state === 'halted') return live.halt === 'PastEnd' || live.halt === 'EventStarted' ? 'RESOLVING' : 'HALTED';
  return 'OPEN';
}

function closesText(meta: MarketMeta): string {
  if (meta.eventStartMs) return `at the event start · ${utc(meta.eventStartMs)}`;
  return utc(meta.endMs);
}

function priceA(live?: LiveMarket): number {
  return live?.price_a_ppm ? live.price_a_ppm / 10_000 : 50;
}

function outcomesOf(meta: MarketMeta, live: LiveMarket | undefined, series: Point[]) {
  const a = priceA(live);
  const pts = series.length >= 2 ? series : [{ t: 0, ours: a, ref: (live?.reference.mid_ppm ?? 500_000) / 10_000 }, { t: 1, ours: a, ref: (live?.reference.mid_ppm ?? 500_000) / 10_000 }];
  return [
    { label: meta.outcomes[0].toUpperCase(), side: 'a' as const, value: Math.round(a), data: pts.map((p) => p.ours), refValue: Math.round(pts.at(-1)!.ref), refData: pts.map((p) => p.ref) },
    { label: meta.outcomes[1].toUpperCase(), side: 'b' as const, value: Math.round(100 - a), data: pts.map((p) => 100 - p.ours), refValue: Math.round(100 - pts.at(-1)!.ref), refData: pts.map((p) => 100 - p.ref) },
  ];
}

export function MarketsIndex({ onOpen, onClose }: { onOpen: (id: string) => void; onClose: () => void }) {
  const markets = useStore(app, (s) => s.markets);
  const live = useStore(app, (s) => s.live);
  const now = Date.now();
  return (
    <Win title="P100 · MARKETS" onClose={onClose}>
      <TeletextHeader page="P100" title="MARKETS · MIRRORED FROM POLYMARKET" />
      <div className="tk-idx" role="list">
        <div className="tk-row tk-head bb-label" aria-hidden="true">
          <span>PAGE</span>
          <span>QUESTION</span>
          <span>PRICES</span>
          <span className="hide-sm">POLYMARKET</span>
          <span>CLOSES IN</span>
          <span className="hide-sm">STATUS</span>
        </div>
        {markets.length === 0 && <p className="bb-text bb-dim">{config.mixnet ? 'Loading the catalog over the mixnet…' : 'Loading the catalog…'}</p>}
        {markets.map((m) => {
          const lm = live?.markets.find((x) => x.id === m.id);
          const a = Math.round(priceA(lm));
          const ref = lm ? Math.round(lm.reference.mid_ppm / 10_000) : 0;
          const st = statusOf(m, lm);
          const named = !(m.outcomes[0] === 'Yes' && m.outcomes[1] === 'No');
          return (
            <button key={m.id} type="button" role="listitem" className="tk-row" onClick={() => onOpen(m.id)} data-hint={`Opens ${m.page}: ${m.question}`}>
              <span className="pg">{m.page.slice(1)}</span>
              <span className="q">
                <span className="bb-label">{m.group ?? 'MARKET'}</span>
                <b>{named ? <><span className="bb-a">{m.outcomes[0].toUpperCase()}</span> <span className="bb-dim">vs</span> <span className="bb-b">{m.outcomes[1].toUpperCase()}</span></> : m.question}</b>
              </span>
              <span className="pills">
                <OutcomePill label={m.outcomes[0].toUpperCase()} price={a} side="a" size="sm" />
                <OutcomePill label={m.outcomes[1].toUpperCase()} price={100 - a} side="b" size="sm" />
              </span>
              <span className="num hide-sm" style={{ color: 'var(--ref)' }}>
                {ref}¢ · {100 - ref}¢{m.volume ? <span className="bb-dim" style={{ fontSize: 14 }}>vol ${Math.round(m.volume / 1000)}k</span> : null}
              </span>
              <span className="num">
                <span>{countdown((m.eventStartMs ?? m.endMs) - now)}</span>
              </span>
              <span className={'tk-st tk-st--' + st + ' hide-sm'}>{st}</span>
            </button>
          );
        })}
      </div>
    </Win>
  );
}

function BetPanel({ meta, live, locked, lockReason, onCalledIt }: { meta: MarketMeta; live?: LiveMarket; locked: boolean; lockReason: string | null; onCalledIt: (s: FilledSlip) => void }) {
  const balance = useStore(app, (s) => s.balance);
  const busy = useStore(app, (s) => s.busy);
  const error = useStore(app, (s) => s.error);
  const head = useStore(app, (s) => s.head);
  const vault = useStore(app, (s) => s.vault);
  const [side, setSide] = useState<'a' | 'b'>('a');
  const options = BET_UNITS.map((u) => coin(u, 2));
  const [amt, setAmt] = useState(options[0]!);
  const [slip, setSlip] = useState<FilledSlip | null>(null);
  const [maxCents, setMaxCents] = useState<number | null>(null);
  const prefill = useStore(ui, (s) => s.prefill);
  // ODDS CALC "USE IN BET" (or the console) hands over a max price, side or size once.
  useEffect(() => {
    if (!prefill || (prefill.market && prefill.market !== meta.id)) return;
    if (prefill.side) setSide(prefill.side);
    if (prefill.units && BET_UNITS.includes(prefill.units)) setAmt(coin(prefill.units, 2));
    if (prefill.maxCents) setMaxCents(Math.min(99, Math.max(1, prefill.maxCents)));
    ui.set({ prefill: null });
  }, [prefill]);
  const units = Math.round(parseFloat(amt) * 100_000);
  const a = priceA(live);
  const price = side === 'a' ? a : 100 - a;
  const label = meta.outcomes[side === 'a' ? 0 : 1].toUpperCase();
  const limit = maxCents ?? Math.min(99, Math.ceil(price) + 3);
  const payout = ((units * 0.99) / (price / 100)) / 100_000;
  const profit = payout - units / 100_000;
  const tooMuch = units > balance;
  const disabled = locked || tooMuch || vault !== 'unlocked';
  const buy = async () => {
    try {
      const r: TradeAnswer = await actions.buy(meta.id, side === 'a' ? 0 : 1, units, limit * 100);
      const f: FillRecord = r.fill;
      play(f.out > 0 ? 'tear' : 'error');
      const w = currentWallet();
      const entry = w?.data.history.at(-1);
      setSlip({
        serial: String(r.batch_id).padStart(4, '0') + '-' + f.tag.slice(0, 3).toUpperCase(),
        market: meta.question,
        outcome: label,
        side,
        shares: coin(f.out),
        price: f.avg_price_bp ? Math.round(f.avg_price_bp / 100) + '¢' : '—',
        stake: coin(f.kept + f.fee) + ' ' + COIN,
        block: head?.height ?? 0,
        status: f.out > 0 ? 'open' : 'refunded',
        tag: f.tag,
        calledIndex: entry?.called?.index,
        at_ms: Date.now(),
      });
    } catch {
      /* shown below */
    }
  };
  if (slip)
    return (
      <div className="tk-bet">
        <p className="bb-label" style={{ margin: 0 }}>
          {slip.status === 'refunded' ? 'REFUNDED · nothing filled, the full amount is back' : `FILLED · blk ${height(slip.block)}`}
        </p>
        <BettingSlip {...slip} block={height(slip.block)} width="100%" />
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {slip.status === 'open' && (
            <button type="button" className="tk-calledbtn" onClick={() => onCalledIt(slip)} data-hint="Prints a CALLED IT card. It stays private unless you share it.">
              <Stamp tone="phosphor" size="sm" rotate={-4} worn={false}>CALLED IT?</Stamp>
            </button>
          )}
          <KeyButton variant="secondary" size="sm" onClick={() => setSlip(null)}>NEW BET</KeyButton>
        </div>
      </div>
    );
  return (
    <div className="tk-bet">
      <p className="bb-label" style={{ margin: 0 }}>YOUR BET</p>
      {(['a', 'b'] as const).map((s) => {
        const p = Math.round(s === 'a' ? a : 100 - a);
        const l = meta.outcomes[s === 'a' ? 0 : 1].toUpperCase();
        return (
          <OutcomePill key={s} label={l} price={p} pct={p} side={s} selected={side === s} onClick={() => setSide(s)}
            data-hint={`Bet that ${l} wins. ${p}¢ means a ${p}% chance.`} />
        );
      })}
      <div data-hint="Standard sizes keep you in the crowd. Odd sizes can be linked.">
        <AmountChips value={amt} options={options} unit={COIN} onChange={setAmt} />
      </div>
      <PayoutPreview outcome={label} side={side} payout={payout.toFixed(4)} profit={'+' + profit.toFixed(4)} unit={COIN} size="lg" />
      <div data-hint={lockReason ?? (tooMuch ? 'Not enough balance. Top up in F3 CAGE.' : `Buys ${label} at up to ${limit}¢. You can't lose more than ${amt} ${COIN}.`)}>
        <KeyButton size="lg" fullWidth loading={busy === 'PRINTING'} disabled={disabled || !!busy} onClick={buy}>
          {busy === 'PRINTING' ? 'PRINTING' : 'BUY ' + label}
        </KeyButton>
        <TradeConditions fill="~2 s" max={limit + '¢'} fee="1%" closes={meta.eventStartMs ? 'at the event start' : utc(meta.endMs)} />
        {maxCents !== null && (
          <p className="bb-conditions">
            Max price set to {maxCents}¢ by ODDS CALC{maxCents < price ? ': below the current price, so this bet may not fill' : ''}.{' '}
            <button type="button" className="bb-link" onClick={() => setMaxCents(null)}>use the default</button>
          </p>
        )}
        {vault !== 'unlocked' && (
          <p className="bb-conditions">
            Open your vault first (it lives only on this device).{' '}
            <button type="button" className="bb-link" onClick={() => openWindow('vault')}>open it</button>
          </p>
        )}
        {(locked || tooMuch) && vault === 'unlocked' && (
          <p className="bb-conditions" style={{ color: locked ? 'var(--alarm)' : 'var(--text-dim)' }}>{lockReason ?? 'Not enough balance. Top up in F3 CAGE.'}</p>
        )}
        {error && <p className="bb-conditions" style={{ color: 'var(--alarm)' }} role="status">{error}</p>}
      </div>
      <button type="button" className="bb-link" style={{ alignSelf: 'flex-start' }} onClick={() => openWindow('duels', { market: meta.id, side })}
        data-hint="Challenge anyone with a link: they take the other side anonymously. No house, no fee.">
        or challenge someone: BLIND DUEL on {label} ▸
      </button>
    </div>
  );
}

export function MarketPage({ id, onClose, onCalledIt }: { id: string; onClose: () => void; onCalledIt: (s: FilledSlip) => void }) {
  const meta = useStore(app, (s) => s.markets.find((m) => m.id === id));
  const live = useStore(app, (s) => s.live?.markets.find((m) => m.id === id));
  const recent = useStore(app, (s) => s.live?.recent);
  const series = useStore(app, (s) => s.series[id]);
  const link = useStore(app, (s) => s.link);
  const head = useStore(app, (s) => s.head);
  const [rules, setRules] = useState(false);
  const { pager } = useContext(WinCtx);
  const outcomes = useMemo(() => (meta ? outcomesOf(meta, live, series ?? []) : []), [meta, live, series]);
  if (!meta) return <Win title="MARKET" onClose={onClose}><p className="bb-text">Loading…</p></Win>;
  const st = statusOf(meta, live);
  const lockReason =
    link !== 'linked' ? 'Mixnet is not linked. Trading is locked; your balance is safe.' : st === 'HALTED' ? haltText(live?.halt ?? null) : st === 'RESOLVING' ? 'Trading has closed. Waiting for the result on Polygon.' : st === 'RESOLVED' ? 'Resolved: winning slips cash in under F2 SLIPS.' : null;
  const fills = (recent ?? []).filter((f) => f.market === id && f.fill.out > 0).slice(-3).reverse();
  const named = !(meta.outcomes[0] === 'Yes' && meta.outcomes[1] === 'No');
  const ref = live ? Math.round(live.reference.mid_ppm / 10_000) : 0;
  const rows = [
    { label: 'TRADING CLOSES', value: meta.eventStartMs ? `at the event start (${utc(meta.eventStartMs)}), or earlier if Polymarket stops trading or a price reaches 98¢` : `${utc(meta.endMs)}, or earlier if Polymarket stops trading or a price reaches 98¢` },
    { label: 'SETTLES', value: "when Polymarket's result is final on-chain (Polygon); usually minutes to hours after the event, longer if disputed" },
    { label: 'PAYS', value: `1 ${COIN} per winning share; 0.5 per share if Polymarket resolves 50-50` },
    { label: 'YOUR BET', value: 'fills in the next 2-second batch at one shared price, never above your max price; any unfilled part returns. Fee 1%' },
    { label: 'REDEEM', value: 'any time after settlement; it never expires' },
  ];
  return (
    <Win title={meta.page + ' · MARKET'} onClose={onClose}>
      <TeletextHeader page={meta.page} category={meta.group ?? 'MARKET'} outcomeA={meta.outcomes[0].toUpperCase()} outcomeB={meta.outcomes[1].toUpperCase()} title={named ? undefined : meta.question} meta={countdown((meta.eventStartMs ?? meta.endMs) - Date.now())} />
      <p className="tk-sub bb-label">
        {named ? meta.question : 'POLYMARKET'} · <span className={'tk-st tk-st--' + st}>{st}</span>
      </p>
      {st === 'HALTED' && <div style={{ marginTop: 16 }}><AlarmBanner title="MARKET HALTED" action="">{haltText(live?.halt ?? null)}</AlarmBanner></div>}
      <div className="tk-market">
        {/* On the pager the bet comes first: one thumb, no scrolling to BUY. */}
        {pager && <BetPanel key={meta.id} meta={meta} live={live} locked={!!lockReason} lockReason={lockReason} onCalledIt={onCalledIt} />}
        <div className="col" style={{ gap: 4 }}>
          <LeaderRow label="CLOSES" value={closesText(meta)} />
          <LeaderRow label="POLYMARKET" value={`${meta.outcomes[0].toUpperCase()} ${ref}¢ · ${meta.outcomes[1].toUpperCase()} ${100 - ref}¢`} tone="ref" />
          <div style={{ marginTop: 10 }} data-hint="Both outcomes, live. REF adds Polymarket's price as dashed violet lines.">
            {rules ? <RulesPanel rules={meta.rules} rows={rows} /> : <ScopeChart key={meta.id} outcomes={outcomes} height={pager ? 120 : 168} />}
          </div>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <KeyButton variant="secondary" size="sm" icon="rules" onClick={() => setRules(!rules)} data-hint="Polymarket's rules word for word, and how Blindbook settles this market.">
              {rules ? 'BACK TO CHART' : 'RULES ▸'}
            </KeyButton>
          </div>
          <p className="bb-label tk-sec">RECENT FILLS · participants redacted</p>
          <div>
            {fills.length === 0 && <p className="bb-ui bb-dim" style={{ margin: 0 }}>No fills in the last two minutes.</p>}
            {fills.map((f, i) => (
              <FillRow key={f.batch_id + '-' + i} outcome={meta.outcomes[f.outcome].toUpperCase()} side={f.outcome === 0 ? 'a' : 'b'} amount={coin(f.side === 'buy' ? f.fill.kept + f.fill.fee : f.fill.out, 3)} unit={COIN} price={Math.round(f.fill.avg_price_bp / 100)} block={height(head?.height ?? 0)} length={8} verb={f.side === 'buy' ? 'bought' : 'sold'} />
            ))}
          </div>
        </div>
        {!pager && <BetPanel key={meta.id} meta={meta} live={live} locked={!!lockReason} lockReason={lockReason} onCalledIt={onCalledIt} />}
      </div>
    </Win>
  );
}

export function CalledItPage({ slip, onBack }: { slip: FilledSlip; onBack: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  // The proof rides after "#": neither our servers nor link previews ever receive it.
  const link = useMemo(() => {
    const w = currentWallet();
    if (!w || slip.calledIndex === undefined) return null;
    return `${location.origin}/#p=${encodeProof(calledItSecret(w.seed, slip.calledIndex), slip.block)}`;
  }, [slip]);
  const date = new Date(slip.at_ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setMsg('Proof link copied. It shows VERIFIED ✓ and nothing else.');
    } catch {
      setMsg(link);
    }
    void earnStamp('CALLED IT');
  };
  const save = async () => {
    if (!link) return;
    savePng(await drawCalledIt({ market: slip.market, outcome: slip.outcome, price: slip.price, block: height(slip.block), date, link }), 'called-it.png');
    setMsg('Saved on this device. Whoever scans the QR sees VERIFIED ✓ and nothing else.');
    void earnStamp('CALLED IT');
  };
  return (
    <Win title="CALLED IT · RECEIPT CARD" onClose={onBack} maxWidth={520} style={{ alignSelf: 'center', width: '100%' }}>
      <CalledItCard market={slip.market} outcome={slip.outcome} side={slip.side} price={slip.price} block={height(slip.block)} date={date} proofSeed={slip.tag}
        qr={link ? <Qr value={link} size={96} paper title="Proof QR" /> : undefined}
        onKeepPrivate={() => setMsg('Kept private. Nothing was shared; the secret behind it stays in your vault.')} onCopyLink={copy} onSaveImage={save} />
      <p className="bb-conditions" role="status" style={{ minHeight: 20, wordBreak: 'break-all' }}>{msg}</p>
      <KeyButton variant="secondary" size="sm" onClick={onBack}>BACK TO MARKET</KeyButton>
    </Win>
  );
}

export { config };
