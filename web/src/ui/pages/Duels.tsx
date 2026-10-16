// P150 BLIND DUELS: challenge anyone with a link. The challenger names an outcome and a price,
// the stake waits in escrow; whoever takes the other side completes the set, so the house
// carries no risk and Polymarket's result settles it. Both sides stay anonymous, to us and to
// each other. Open challenges are public, like any order; nothing links them to a person.

import { useMemo, useState } from 'react';
import { AmountChips, KeyButton, LeaderRow, OutcomePill, TeletextHeader } from '../../ds';
import { Win, OpenVault } from '../win';
import { Qr } from '../Qr';
import { app, actions, recoverDuel, type MarketMeta } from '../../app/services';
import { useStore } from '../../app/store';
import { BET_UNITS, COIN } from '../../app/config';
import { coin, coinLabel, utc } from '../../app/format';
import type { OpenDuel } from '../../core/api';

const duelLink = (id: string) => `${location.origin}/#d=${id}`;

function terms(d: { shares: number; price_bp: number; stake: number }, m: MarketMeta | undefined, outcome: 0 | 1) {
  const theirs = m ? m.outcomes[outcome].toUpperCase() : outcome === 0 ? 'A' : 'B';
  const yours = m ? m.outcomes[outcome === 0 ? 1 : 0].toUpperCase() : outcome === 0 ? 'B' : 'A';
  const cost = d.shares - d.stake;
  return { theirs, yours, cost, price: Math.round(d.price_bp / 100) };
}

/** `onTaken`: the page keeps the confirmation, since the challenge leaves the board once taken. */
function Challenge({ d, m, mine, focus, vault, onTaken }: { d: OpenDuel; m: MarketMeta | undefined; mine: boolean; focus: boolean; vault: string; onTaken: (duel: string, line: string) => void }) {
  const busy = useStore(app, (s) => s.busy);
  const balance = useStore(app, (s) => s.balance);
  const t = terms(d, m, d.outcome);
  const take = async () => {
    try {
      const n = await actions.duelTake(d);
      onTaken(d.duel, `Taken: ${coin(n)} ${t.yours} shares are in your slips. They pay ${coin(n)} ${COIN} if ${t.yours} wins.`);
    } catch {
      /* shown */
    }
  };
  return (
    <div className={'tk-duel' + (focus ? ' is-focus' : '')}>
      <p className="bb-label" style={{ margin: 0 }}>{m ? `${m.page} · ${m.question}` : d.market.slice(0, 10)} · opened {utc(d.opened_ms)}</p>
      <p className="bb-ui" style={{ margin: '6px 0' }}>
        <span className="bb-redact" role="img" aria-label="redacted participant">████████</span> bets <b className={d.outcome === 0 ? 'bb-a' : 'bb-b'}>{t.theirs}</b> at {t.price}¢ for {coin(d.shares)} shares.
      </p>
      <LeaderRow label={`TAKE ${t.yours}`} value={`pay ${coin(t.cost)} · win ${coin(d.shares)} ${COIN} if ${t.yours} wins`} tone="hi" />
      {mine ? (
        <p className="bb-conditions">This is your challenge. Cancel it under YOUR DUELS.</p>
      ) : (
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <KeyButton size="sm" disabled={vault !== 'unlocked' || balance < t.cost || !!busy} loading={busy === 'TAKING THE DUEL'} onClick={take}
            data-hint="Pays your side of the set. Nobody learns who took it, not even the challenger.">
            TAKE {t.yours} · {coin(t.cost)}
          </KeyButton>
          {vault !== 'unlocked' && <span className="bb-ui bb-dim">open your vault to take it</span>}
          {vault === 'unlocked' && balance < t.cost && <span className="bb-ui bb-dim">not enough balance</span>}
        </div>
      )}
    </div>
  );
}

function NewDuel({ initial, onOpened }: { initial?: { market?: string; side?: 'a' | 'b' }; onOpened: (id: string) => void }) {
  const markets = useStore(app, (s) => s.markets);
  const live = useStore(app, (s) => s.live);
  const busy = useStore(app, (s) => s.busy);
  const balance = useStore(app, (s) => s.balance);
  const error = useStore(app, (s) => s.error);
  const open = markets.filter((m) => !m.resolved && live?.markets.find((x) => x.id === m.id)?.state === 'open');
  const [mid, setMid] = useState(initial?.market && open.some((m) => m.id === initial.market) ? initial.market : open[0]?.id);
  const [side, setSide] = useState<'a' | 'b'>(initial?.side ?? 'a');
  const options = BET_UNITS.map((u) => coin(u, 2));
  const [amt, setAmt] = useState(options[0]!);
  const m = markets.find((x) => x.id === mid);
  const lm = live?.markets.find((x) => x.id === mid);
  const a = lm?.price_a_ppm ? lm.price_a_ppm / 10_000 : 50;
  const now = Math.round(side === 'a' ? a : 100 - a);
  const [cents, setCents] = useState<number | null>(null);
  const price = Math.min(99, Math.max(1, cents ?? now));
  const stakeUnits = Math.round(parseFloat(amt) * 100_000);
  const shares = Math.floor((stakeUnits * 100) / price);
  const stake = Math.ceil((shares * price * 100) / 10_000);
  if (!m) return <p className="bb-text bb-dim">No market is open for duels right now.</p>;
  const outcome: 0 | 1 = side === 'a' ? 0 : 1;
  const create = async () => {
    try {
      const d = await actions.duelOpen(m.id, outcome, shares, price * 100);
      onOpened(d.duel);
    } catch {
      /* shown */
    }
  };
  return (
    <div className="col" style={{ gap: 12, maxWidth: 560 }}>
      <label className="bb-label" htmlFor="duel-market">MARKET</label>
      <select id="duel-market" className="tk-select" value={mid} onChange={(e) => { setMid(e.target.value); setCents(null); }}>
        {open.map((x) => (
          <option key={x.id} value={x.id}>{x.page} · {x.question}</option>
        ))}
      </select>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {(['a', 'b'] as const).map((s) => {
          const p = Math.round(s === 'a' ? a : 100 - a);
          return <OutcomePill key={s} label={m.outcomes[s === 'a' ? 0 : 1].toUpperCase()} price={p} side={s} selected={side === s} onClick={() => { setSide(s); setCents(null); }} />;
        })}
      </div>
      <AmountChips value={amt} options={options} unit={COIN} label="YOUR STAKE" onChange={setAmt} />
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <span className="bb-label">YOUR PRICE</span>
        <KeyButton size="sm" variant="secondary" onClick={() => setCents(price - 1)} aria-label="Lower the price">−</KeyButton>
        <span className="bb-display-sm bb-hi">{price}¢</span>
        <KeyButton size="sm" variant="secondary" onClick={() => setCents(price + 1)} aria-label="Raise the price">+</KeyButton>
        <span className="bb-ui bb-dim">market now {now}¢</span>
      </div>
      <LeaderRow label="YOU GET IF IT WINS" value={`${coin(shares)} ${COIN} for ${coin(stake)} staked`} tone="hi" />
      <LeaderRow label="THE TAKER PAYS" value={`${coin(shares - stake)} for the other side`} />
      <p className="bb-conditions">
        Your stake waits in escrow until someone takes the link; cancel any time before that. No fee. Settled by Polymarket's result like every market; trading
        closes at the event start.
      </p>
      <KeyButton disabled={balance < stake || !!busy} loading={busy === 'OPENING THE DUEL'} onClick={create}>
        OPEN THE DUEL · {coin(stake)}
      </KeyButton>
      {error && <p className="bb-conditions" style={{ color: 'var(--alarm)' }} role="status">{error}</p>}
    </div>
  );
}

export function DuelsPage({ onClose, focus, initial }: { onClose: () => void; focus?: string; initial?: { market?: string; side?: 'a' | 'b' } }) {
  const live = useStore(app, (s) => s.live);
  const liveSent = useStore(app, (s) => s.liveSent);
  const markets = useStore(app, (s) => s.markets);
  const vault = useStore(app, (s) => s.vault);
  const mine = useStore(app, (s) => s.duels);
  const busy = useStore(app, (s) => s.busy);
  const [tab, setTab] = useState<'board' | 'new' | 'mine'>(initial ? 'new' : focus ? 'board' : 'board');
  const [link, setLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [taken, setTaken] = useState<{ duel: string; line: string } | null>(null);
  const board = useMemo(() => {
    const all = live?.duels ?? [];
    return focus ? [...all.filter((d) => d.duel === focus), ...all.filter((d) => d.duel !== focus)] : all;
  }, [live?.duels, focus]);
  const focusGone = focus && live && !board.some((d) => d.duel === focus);
  // A function, not a component: a component declared here would remount on every render.
  const tabKey = (id: typeof tab, children: React.ReactNode) => (
    <KeyButton key={id} size="sm" variant={tab === id ? 'primary' : 'secondary'} onClick={() => setTab(id)} aria-pressed={tab === id}>{children}</KeyButton>
  );
  return (
    <Win title="P150 · BLIND DUELS" onClose={onClose}>
      <TeletextHeader page="P150" title="BLIND DUELS" />
      <p className="bb-text" style={{ margin: '10px 0 0', maxWidth: 760 }}>
        Challenge anyone with a link. They take the other side anonymously; together you buy a complete set, so the house carries no risk, and Polymarket's result
        settles it. Neither of you ever learns who the other is.
      </p>
      <div className="row" style={{ gap: 8, margin: '14px 0', flexWrap: 'wrap' }}>
        {tabKey('board', `OPEN CHALLENGES · ${board.length}`)}
        {tabKey('new', 'NEW DUEL')}
        {tabKey('mine', `YOUR DUELS${mine.length ? ` · ${mine.length}` : ''}`)}
      </div>
      {tab === 'board' && (
        <div className="col" style={{ gap: 12, maxWidth: 760 }}>
          {taken && <p className="bb-conditions bb-hi" role="status">{taken.line}</p>}
          {focusGone && taken?.duel !== focus && <p className="bb-conditions">That challenge is no longer open: someone took it, or it was cancelled.</p>}
          {board.length === 0 && <p className="bb-ui bb-dim">No open challenges. Start one with NEW DUEL.</p>}
          {board.map((d) => (
            <Challenge key={d.duel} d={d} m={markets.find((m) => m.id === d.market)} mine={mine.some((x) => x.duel === d.duel)} focus={d.duel === focus} vault={vault} onTaken={(duel, line) => setTaken({ duel, line })} />
          ))}
        </div>
      )}
      {tab === 'new' &&
        (vault !== 'unlocked' ? (
          <OpenVault>Your stake comes from the vault on this device. Open it first.</OpenVault>
        ) : link ? (
          <div className="col" style={{ gap: 12, maxWidth: 560 }}>
            <p className="bb-label bb-hi" style={{ margin: 0 }}>YOUR CHALLENGE IS OPEN · SEND THE LINK</p>
            <div className="tk-unfold" style={{ display: 'flex', justifyContent: 'center' }}>
              <Qr value={duelLink(link)} size={200} title="Duel link" />
            </div>
            <p className="bb-ui" style={{ wordBreak: 'break-all' }}>{duelLink(link)}</p>
            <p className="bb-conditions">The link names the challenge, not you. When someone takes it, your shares arrive in your slips by themselves.</p>
            <div className="row" style={{ gap: 8 }}>
              <KeyButton size="sm" onClick={() => navigator.clipboard?.writeText(duelLink(link)).then(() => setMsg('Link copied.'), () => setMsg(duelLink(link)))}>COPY LINK</KeyButton>
              <KeyButton size="sm" variant="secondary" onClick={() => setLink(null)}>ANOTHER DUEL</KeyButton>
            </div>
            {msg && <p className="bb-conditions" role="status">{msg}</p>}
          </div>
        ) : (
          <NewDuel initial={initial} onOpened={setLink} />
        ))}
      {tab === 'mine' && (
        <div className="col" style={{ gap: 10, maxWidth: 760 }}>
          {vault !== 'unlocked' && <OpenVault>Your duels live in the vault. Open it first.</OpenVault>}
          {vault === 'unlocked' && mine.length === 0 && <p className="bb-ui bb-dim">You haven't opened a duel yet.</p>}
          {[...mine].reverse().map((d) => {
            const m = markets.find((x) => x.id === d.market);
            const t = terms(d, m, d.outcome);
            // Just opened and the last feed was asked for before that: it is on the board, not yet in our copy.
            const stillOpen = live?.duels.some((x) => x.duel === d.duel) || (d.status === 'open' && d.opened_ms !== undefined && liveSent < d.opened_ms + 1_500);
            return (
              <div key={d.duel} className="tk-duel">
                <p className="bb-label" style={{ margin: 0 }}>{m ? `${m.page} · ${m.question}` : d.market.slice(0, 10)} · {utc(d.at_ms)}</p>
                <LeaderRow label={`${t.theirs} AT ${t.price}¢`} value={`${coin(d.shares)} shares · stake ${coinLabel(d.stake)}`} />
                <LeaderRow
                  label="STATUS"
                  value={d.status === 'taken' ? 'TAKEN ✓ · your shares are in P300' : d.status === 'cancelled' ? 'CANCELLED · stake returned' : stillOpen ? 'OPEN · waiting for a taker' : 'NOT ON THE BOARD'}
                  tone={d.status === 'taken' ? 'hi' : 'default'}
                />
                {d.status === 'open' && (
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                    {stillOpen && (
                      <>
                        <KeyButton size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(duelLink(d.duel))}>COPY LINK</KeyButton>
                        <KeyButton size="sm" variant="secondary" disabled={!!busy} onClick={() => actions.duelCancel(d.duel).then((n) => setMsg(`Cancelled: ${coinLabel(n)} back in your balance.`)).catch(() => undefined)}>CANCEL · REFUND</KeyButton>
                      </>
                    )}
                    {!stillOpen && (
                      <KeyButton size="sm" variant="secondary" disabled={!!busy} onClick={() => recoverDuel(d.duel).then((n) => setMsg(n ? `Found it: ${coin(n)} shares are in your slips.` : 'Not found in the log yet.')).catch((e) => setMsg(String(e.message)))}
                        data-hint="Downloads the public log (the same files anyone can) and finds your shares by your own blinded outputs.">
                        FIND MY SHARES IN THE LOG
                      </KeyButton>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {msg && <p className="bb-conditions" role="status">{msg}</p>}
        </div>
      )}
    </Win>
  );
}
