// P300 slips: the free balance and every position, as bearer slips. Sell, cash in after
// settlement, hand over as a code, print as bearer paper, take over a code (typed or scanned),
// and take back a code nobody has used yet.

import { useState } from 'react';
import { BettingSlip, KeyButton, LeaderRow, TeletextHeader, TextInput, Wordmark } from '../../ds';
import { Qr } from '../Qr';
import { Scan } from '../Scan';
import { creditKeyset } from '../../core/keysets';
import { config, COIN } from '../../app/config';
import { Win } from '../win';
import { app, actions, type Position } from '../../app/services';
import { useStore } from '../../app/store';
import { coin, coinLabel, utc } from '../../app/format';
import { play } from '../sound';

interface Handed {
  code: string;
  title: string;
  paper?: { market: string; outcome: string; shares: string; serial: string };
}

/** The printable bearer slip: black on white, receipt width, a real QR of the code. */
function PaperSlip({ h }: { h: Handed }) {
  const p = h.paper!;
  return (
    <div className="bb-print tk-printable">
      <div className="bb-print__head">
        <Wordmark height={14} color="#000" />
        <span>BEARER SLIP</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Qr value={h.code} size={220} paper title={'Bearer slip ' + p.serial} />
      </div>
      <p className="bb-print__market">{p.market}</p>
      <LeaderRow label="OUTCOME" value={p.outcome} medium="paper" />
      <LeaderRow label="SHARES" value={p.shares} medium="paper" />
      <LeaderRow label="SERIAL" value={p.serial} medium="paper" />
      <p className="bb-print__warn">bearer paper: whoever scans this owns it</p>
      <p className="bb-print__foot">Scan it in F2 SLIPS to import. It is re-issued on scan, so this paper can't be spent twice.</p>
    </div>
  );
}

export function SlipsPage({ onClose }: { onClose: () => void }) {
  const balance = useStore(app, (s) => s.balance);
  const positions = useStore(app, (s) => s.positions);
  const markets = useStore(app, (s) => s.markets);
  const live = useStore(app, (s) => s.live);
  const busy = useStore(app, (s) => s.busy);
  const error = useStore(app, (s) => s.error);
  const vault = useStore(app, (s) => s.vault);
  const outbox = useStore(app, (s) => s.outbox);
  const [handed, setHanded] = useState<Handed | null>(null);
  const [incoming, setIncoming] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  if (vault !== 'unlocked')
    return (
      <Win title="P300 · SLIPS" onClose={onClose}>
        <TeletextHeader page="P300" title="YOUR SLIPS" />
        <p className="bb-text">Your slips live in the vault on this device. Open it first.</p>
      </Win>
    );

  if (handed?.paper)
    return (
      <Win title="P300 · PRINT SLIP" onClose={() => setHanded(null)} maxWidth={520} style={{ alignSelf: 'center', width: '100%' }}>
        <div className="col" style={{ alignItems: 'center', gap: 16 }}>
          <PaperSlip h={handed} />
          <p className="bb-conditions">The slip has left your vault and lives on this paper now. Until someone scans it, you can take it back from P300.</p>
          <div className="row" style={{ gap: 8 }}>
            <KeyButton icon="qr" onClick={() => window.print()}>PRINT</KeyButton>
            <KeyButton variant="secondary" onClick={() => setHanded(null)}>DONE</KeyButton>
          </div>
        </div>
      </Win>
    );

  if (handed)
    return (
      <Win title="P300 · HAND OVER" onClose={() => setHanded(null)} maxWidth={560} style={{ alignSelf: 'center', width: '100%' }}>
        <p className="bb-label" style={{ margin: 0 }}>{handed.title}</p>
        <div style={{ display: 'flex', justifyContent: 'center', margin: '16px 0' }}>
          <Qr value={handed.code} size={240} title="Slip code" />
        </div>
        <p className="bb-ui" style={{ wordBreak: 'break-all' }}>{handed.code}</p>
        <p className="bb-conditions">Bearer e-cash: whoever takes this code over first owns it. Nothing on the chain shows it moved. Until it is taken over you can take it back from P300.</p>
        <div className="row" style={{ gap: 8 }}>
          <KeyButton size="sm" onClick={() => navigator.clipboard?.writeText(handed.code)}>COPY CODE</KeyButton>
          <KeyButton variant="secondary" size="sm" onClick={() => setHanded(null)}>DONE</KeyButton>
        </div>
      </Win>
    );

  const handOver = async (keyset: string, units: number, title: string, paper?: Handed['paper']) => {
    try {
      const code = await actions.send(keyset, units, !!paper);
      play(paper ? 'print' : 'tear');
      setHanded({ code, title, paper });
    } catch {
      /* shown */
    }
  };

  const takeOver = async (code: string) => {
    try {
      const n = await actions.receive(code.trim());
      play('stamp');
      setMsg(`Taken over: ${coinLabel(n)} is yours now; the old code is void.`);
      setIncoming('');
    } catch {
      /* shown */
    }
  };

  const takeBack = async (code: string) => {
    try {
      const r = await actions.reclaim(code);
      setMsg(r === 'back' ? 'Taken back into your vault. The code is void now.' : 'Someone already took it over: the hand-off worked.');
    } catch {
      /* shown */
    }
  };

  const nameOf = (id: string) => {
    if (id === creditKeyset(config.m).id) return 'CREDIT';
    for (const m of markets) for (const o of [0, 1] as const) if (m.keysets[o] === id) return `${m.page} ${m.outcomes[o].toUpperCase()}`;
    return id.slice(0, 10);
  };

  return (
    <Win title="P300 · SLIPS" onClose={onClose}>
      <TeletextHeader page="P300" title="YOUR SLIPS" />
      <div style={{ maxWidth: 560, marginTop: 12 }}>
        <LeaderRow label="FREE BALANCE" value={coinLabel(balance)} tone="hi" />
        <LeaderRow label="OPEN POSITIONS" value={positions.length} />
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <KeyButton variant="secondary" size="sm" disabled={balance < 1_000 || !!busy} onClick={() => handOver(creditKeyset(config.m).id, 1_000, `0.01 ${COIN} OF CREDIT`)} data-hint="Hands 0.01 of your balance to someone as a code or QR.">
          HAND OVER 0.01
        </KeyButton>
        <KeyButton variant="secondary" size="sm" icon="qr" disabled={!!busy} onClick={() => setScanning(true)} data-hint="Scan a slip QR from paper or another screen.">
          SCAN A SLIP
        </KeyButton>
      </div>
      {scanning && (
        <Scan
          onCode={(c) => {
            setScanning(false);
            void takeOver(c);
          }}
          onCancel={() => setScanning(false)}
        />
      )}
      <div className="tk-slips">
        {positions.map((p: Position) => {
          const m = markets.find((x) => x.id === p.market);
          const lm = live?.markets.find((x) => x.id === p.market);
          if (!m) return null;
          const resolved = m.resolved ?? (lm?.resolved ? { den: lm.resolved[0], num: [lm.resolved[1], lm.resolved[2]] as [number, number] } : null);
          const won = resolved ? resolved.num[p.outcome]! > 0 : false;
          const status = resolved ? (won ? 'won' : 'lost') : 'open';
          const a = lm?.price_a_ppm ? lm.price_a_ppm / 10_000 : 50;
          const price = Math.round(p.outcome === 0 ? a : 100 - a);
          const bid = lm ? Math.max(1, Math.floor(lm.reference.bid_ppm[p.outcome] / 100) - 300) : 1;
          const outcome = m.outcomes[p.outcome].toUpperCase();
          const serial = p.keyset.slice(2, 8).toUpperCase();
          return (
            <div className="tk-slipcell" key={p.keyset}>
              <BettingSlip serial={serial} market={m.question} outcome={outcome} side={p.outcome === 0 ? 'a' : 'b'}
                shares={coin(p.units)} price={price + '¢ now'} stake={`pays ${coin(won && resolved ? Math.floor((p.units * resolved.num[p.outcome]!) / resolved.den) : p.units)} ${COIN} if it wins`} status={status} />
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {status === 'won' ? (
                  <KeyButton size="sm" disabled={!!busy} onClick={() => actions.redeem(p.market, p.outcome).then((n) => setMsg(`Cashed in: ${coinLabel(n)} added to your balance.`)).catch(() => undefined)} data-hint="Moves the winnings into your free balance.">CASH IN</KeyButton>
                ) : (
                  <KeyButton variant="secondary" size="sm" disabled={status !== 'open' || !!busy} onClick={() => actions.sell(p.market, p.outcome, p.units, bid).then((r) => setMsg(`Sold: ${coinLabel(r.fill.out)} back in your balance.`)).catch(() => undefined)} data-hint="Sells the whole slip at the current price (never below Polymarket's bid, minus 3¢ slack).">SELL</KeyButton>
                )}
                <KeyButton variant="secondary" size="sm" disabled={!!busy} onClick={() => handOver(p.keyset, p.units, `${coin(p.units)} SHARES · ${outcome}`)} data-hint="Hands the slip to someone as a code. No chain transaction, no record of who held it.">HAND OVER</KeyButton>
                <KeyButton variant="secondary" size="sm" icon="qr" disabled={!!busy} onClick={() => handOver(p.keyset, p.units, `${coin(p.units)} SHARES · ${outcome}`, { market: m.question, outcome, shares: coin(p.units), serial })} data-hint="Prints bearer paper. Whoever scans it owns it.">PRINT</KeyButton>
              </div>
            </div>
          );
        })}
      </div>
      {outbox.length > 0 && (
        <div style={{ maxWidth: 680, marginTop: 24 }}>
          <p className="bb-label bb-hi tk-sec">HANDED OVER, NOT TAKEN YET</p>
          {outbox.map((o) => (
            <div key={o.code} className="tk-outrow">
              <LeaderRow label={`${o.paper ? 'PAPER' : 'CODE'} · ${nameOf(o.id)} · ${utc(o.at_ms)}`} value={coin(o.amount)} />
              <KeyButton size="sm" variant="secondary" disabled={!!busy} onClick={() => takeBack(o.code)} data-hint="Swaps it back into your vault if nobody took it over; the code becomes void.">TAKE BACK</KeyButton>
            </div>
          ))}
        </div>
      )}
      <div style={{ maxWidth: 560, marginTop: 24 }}>
        <TextInput label="TAKE OVER A CODE" placeholder="bbslip1:…" value={incoming} onChange={setIncoming} message="Swapped at once: the sender can't spend it after you." />
        <div style={{ marginTop: 8 }}>
          <KeyButton size="sm" disabled={!incoming.trim().startsWith('bbslip1:') || !!busy} loading={busy === 'TAKING OVER SLIPS'} onClick={() => takeOver(incoming)}>TAKE OVER</KeyButton>
        </div>
      </div>
      {(msg || error) && <p className="bb-conditions" role="status" style={{ color: error ? 'var(--alarm)' : undefined }}>{error ?? msg}</p>}
    </Win>
  );
}
