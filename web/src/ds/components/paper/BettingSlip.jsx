import React from 'react';
import { Wordmark } from '../brand/Logo.jsx';
import { QRCode } from '../brand/QRCode.jsx';
import { PixelIcon } from '../brand/PixelIcon.jsx';
import { LeaderRow } from '../data/Redacted.jsx';
import { Stamp } from './ThermalReceipt.jsx';

const SLIP_STATES = {
  open: { stamp: 'OPEN', rot: -4 },
  won: { stamp: 'WON', rot: -10 },
  lost: { stamp: 'LOST', rot: 8 },
  refunded: { stamp: 'REFUNDED', rot: -6, note: 'Nothing filled within your price limit: the full amount is back in your balance.' },
  exposed: { stamp: 'EXPOSED', rot: -8, band: 'alarm', bandText: 'EXPOSED', note: 'The top-up behind this slip was linkable. Withdraw to a fresh address.' },
  'amount-visible': { stamp: null, band: 'amber', bandText: 'AMOUNT VISIBLE', note: 'Paid from Sapling funds, so the amount showed on chain. Keep your ZEC in Ironwood.' },
};

/* Betting slip: serial, market, outcome, shares, stamp. */
/* Rows the caller doesn't pass are left out (a position held across fills has no one price or block). */
export function BettingSlip({ serial = '0041-18A', market = 'CS2 · LEGACY vs PARIVISION', outcome = 'LEGACY', side = 'a', shares = '0.0222', price, stake, pays, block, status = 'open', width, className = '' }) {
  const s = SLIP_STATES[status] || SLIP_STATES.open;
  return (
    <div className={['bb-slip', 'bb-paper', 'bb-grain', 'is-' + status, status === 'won' && 'bb-glow-box', className].filter(Boolean).join(' ')} style={{ width }}>
      {s.band && <div className={'bb-slip__band bb-slip__band--' + s.band}><PixelIcon name="warning" size={14} />{s.bandText}</div>}
      <div className="bb-slip__body">
        <div className="bb-slip__top"><span>BETTING SLIP</span><span>Nº {serial}</span></div>
        <p className="bb-slip__market">{market}</p>
        <p className="bb-slip__outcome"><span className={'bb-slip__swatch bb-slip__swatch--' + side} aria-hidden="true" />{outcome}{s.stamp && <Stamp size={status === 'open' ? 'sm' : 'md'} rotate={s.rot} className="bb-slip__stamp">{s.stamp}</Stamp>}</p>
        <LeaderRow label="SHARES" value={shares} medium="paper" />
        {price !== undefined && <LeaderRow label="PRICE" value={price} medium="paper" />}
        {stake !== undefined && <LeaderRow label="STAKE" value={stake} medium="paper" />}
        {pays !== undefined && <LeaderRow label="PAYS" value={pays} medium="paper" />}
        {block !== undefined && <LeaderRow label="BLOCK" value={block} medium="paper" />}
        {s.note && <p className="bb-slip__note">{s.note}</p>}
      </div>
      <div className="bb-slip__perf" aria-hidden="true" />
      <div className="bb-slip__stub">
        <QRCode seed={serial} size={56} bg="var(--paper)" eye={false} title={'Slip ' + serial} />
        <span>STUB Nº {serial}<br /><span className="bb-slip__dim">bearer slip · lives in your vault</span></span>
      </div>
    </div>
  );
}

/* Printable paper slip: black on white, receipt width. */
export function PrintSlip({ serial = '0041-18A', market = 'CS2 · LEGACY vs PARIVISION', outcome = 'LEGACY', shares = '0.0222', warning = 'bearer paper: whoever scans this owns it', className = '' }) {
  return (
    <div className={'bb-print ' + className}>
      <div className="bb-print__head"><Wordmark height={14} color="#000" /><span>BEARER SLIP</span></div>
      <QRCode seed={'print-' + serial} size={200} fg="#000" bg="var(--print-white)" title={'Bearer slip ' + serial} style={{ margin: '0 auto' }} />
      <p className="bb-print__market">{market}</p>
      <LeaderRow label="OUTCOME" value={outcome} medium="paper" />
      <LeaderRow label="SHARES" value={shares} medium="paper" />
      <LeaderRow label="SERIAL" value={serial} medium="paper" />
      <p className="bb-print__warn">{warning}</p>
      <p className="bb-print__foot">Scan it in F2 SLIPS to import. It is re-issued on scan, so this paper can't be spent twice.</p>
    </div>
  );
}
