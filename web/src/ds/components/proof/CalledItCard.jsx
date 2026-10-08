import React from 'react';
import { Logo, Wordmark } from '../brand/Logo.jsx';
import { QRCode, PixelFace } from '../brand/QRCode.jsx';
import { LeaderRow, Redacted } from '../data/Redacted.jsx';
import { Stamp } from '../paper/ThermalReceipt.jsx';
import { KeyButton } from '../keys/KeyButton.jsx';

/* CALLED IT receipt card: anonymous by default, provable by choice. */
export function CalledItCard({ market = 'CS2 · LEGACY vs PARIVISION', outcome = 'LEGACY', side = 'a', price = '45¢', block = '3,514,220', date = 'Oct 3, 2026', proofSeed = 'proof-9f3a', qr, verified = false, showActions = true, onKeepPrivate, onCopyLink, onSaveImage, className = '' }) {
  return (
    <div className={'bb-called ' + className}>
      <div className="bb-called__card bb-paper bb-grain">
        <div className="bb-called__head"><Logo size={27} variant="paper" /><Wordmark height={14} color="var(--ink)" /><span className="bb-called__kind">RECEIPT CARD</span></div>
        <Stamp size="lg" rotate={-7} className="bb-called__stamp">CALLED IT</Stamp>
        <p className="bb-called__market">{market}</p>
        <LeaderRow label="CALLED BY" value={<Redacted medium="paper" length={9} />} medium="paper" />
        <LeaderRow label="OUTCOME" value={<span className="bb-called__oc"><span className={'bb-slip__swatch bb-slip__swatch--' + side} aria-hidden="true" />{outcome}</span>} medium="paper" />
        <LeaderRow label="PRICE" value={price} medium="paper" />
        <LeaderRow label="BLOCK" value={block} medium="paper" />
        <LeaderRow label="DATE" value={date} medium="paper" />
        <div className="bb-called__proof">
          {qr || <QRCode seed={proofSeed} size={96} bg="var(--paper)" title="Proof QR" />}
          <p>Scan to verify. The proof shows this call happened, and nothing else about you.</p>
        </div>
        {verified && <div className="bb-called__verified" role="status"><Stamp size="md" rotate={0} worn={false}>VERIFIED ✓</Stamp><span>anchored log replayed · match</span></div>}
      </div>
      {showActions && (
        <div className="bb-called__actions">
          <KeyButton variant="primary" size="sm" onClick={onKeepPrivate}>KEEP PRIVATE</KeyButton>
          <KeyButton variant="secondary" size="sm" onClick={onCopyLink}>COPY LINK</KeyButton>
          <KeyButton variant="secondary" size="sm" onClick={onSaveImage}>SAVE IMAGE</KeyButton>
        </div>
      )}
    </div>
  );
}

const PASS_SLOTS = ['FIRST SLIP', 'CALLED IT', 'PASSED IN THE DARK'];

/* NOBODY PASS: a retro ID card where every field is redacted. */
export function NobodyPass({ faceSeed = 'nobody-1', stamps = ['FIRST SLIP'], issued = '3,514,220', className = '' }) {
  return (
    <div className={'bb-pass bb-paper bb-grain ' + className}>
      <div className="bb-pass__band"><span className="bb-pass__title">NOBODY PASS</span><span>BLINDBOOK · BOOTH ISSUE</span></div>
      <div className="bb-pass__body">
        <div className="bb-pass__photo"><PixelFace seed={faceSeed} size={88} /><span>PHOTO: RANDOM</span></div>
        <div className="bb-pass__fields">
          <LeaderRow label="NAME" value={<Redacted medium="paper" text="xxxxxxxx" seed={faceSeed + 'n'} />} medium="paper" />
          <LeaderRow label="IP" value={<Redacted medium="paper" text="xxx.xx.xx" seed={faceSeed + 'i'} />} medium="paper" />
          <LeaderRow label="ACCOUNT" value="NONE" medium="paper" />
          <LeaderRow label="ISSUED BLK" value={issued} medium="paper" />
          <p className="bb-pass__bearer">the bearer of this card is nobody</p>
        </div>
      </div>
      <div className="bb-pass__slots">
        {PASS_SLOTS.map((s) => (
          <div key={s} className={'bb-pass__slot' + (stamps.includes(s) ? ' is-stamped' : '')}>
            {stamps.includes(s) ? <Stamp size="sm" rotate={-6}>{s}</Stamp> : <span className="bb-pass__empty">{s}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
