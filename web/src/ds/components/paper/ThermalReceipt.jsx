import React from 'react';
import { Logo, Wordmark } from '../brand/Logo.jsx';
import { QRCode } from '../brand/QRCode.jsx';
import { LeaderRow } from '../data/Redacted.jsx';

/* Rubber stamp: SEEN, CALLED IT, WON, VERIFIED ✓ … Slams in when `slam` is set. */
export function Stamp({ children, tone = 'ink', size = 'md', rotate = -8, slam = false, worn = true, className = '', style }) {
  const cls = ['bb-stamp', 'bb-stamp--' + tone, 'bb-stamp--' + size, worn && 'bb-wear', slam && 'is-slam', className].filter(Boolean).join(' ');
  return <span className={cls} role="img" aria-label={'stamp: ' + (typeof children === 'string' ? children : '')} style={{ '--stamp-rot': rotate + 'deg', ...style }}>{children}</span>;
}

const RECEIPT_LINES = [
  { label: 'ORDER Nº', value: '4118' },
  { label: 'BLOCK', value: '3,514,220' },
  { label: 'VALID', value: '~2 H 30 MIN · 120 BLOCKS' },
];

/* Thermal receipt: paper/ink, perforated edges, QR, amount, short address. */
export function ThermalReceipt({ kind = 'CAGE · TOP-UP', amount = '0.0500', unit = 'ZEC', address = 'u1qz7x…k3d8', qrSeed = 'topup-4118', qr, lines = RECEIPT_LINES, status = 'awaiting', printing = false, footer = 'pay from your Ironwood balance', width, className = '' }) {
  return (
    <div className={'bb-receipt bb-paper bb-perf bb-grain' + (printing ? ' is-printing' : '') + ' ' + className} style={{ width }}>
      <div className="bb-receipt__head"><Logo size={27} variant="paper" /><Wordmark height={14} color="var(--ink)" /></div>
      <p className="bb-receipt__kind">{kind}</p>
      <hr className="bb-paper-rule" />
      <p className="bb-receipt__lab">SEND EXACTLY</p>
      <p className="bb-receipt__amt">{amount} {unit}</p>
      <p className="bb-receipt__lab">TO <span className="bb-receipt__addr">{address}</span></p>
      <div className="bb-receipt__qr">
        {qr || <QRCode seed={qrSeed} size={168} bg="var(--paper)" title={'Payment QR for ' + amount + ' ' + unit} />}
        {(status === 'seen' || status === 'credited') && <Stamp size="lg" rotate={-12} slam worn={false} className="bb-receipt__stamp">SEEN</Stamp>}
      </div>
      {lines.map((l) => <LeaderRow key={l.label} label={l.label} value={l.value} medium="paper" />)}
      <hr className="bb-paper-rule" />
      <p className="bb-receipt__status">
        {status === 'awaiting' && <>AWAITING PAYMENT <span className="bb-cursor" aria-hidden="true" /></>}
        {status === 'seen' && 'SEEN IN MEMPOOL · crediting…'}
        {status === 'credited' && <>CREDITED <Stamp size="sm" rotate={-3} worn={false}>✓ +{amount}</Stamp></>}
      </p>
      <p className="bb-receipt__foot">{footer}</p>
    </div>
  );
}
