import React, { useEffect, useState } from 'react';
import { PixelIcon } from '../brand/PixelIcon.jsx';
import { KeyButton } from '../keys/KeyButton.jsx';

/* Alarm banner: title, plain explanation, one action. Only for real alarms. */
export function AlarmBanner({ title = 'MIXNET LINK LOST', children = 'Reconnecting… your balance is safe. Trading is locked until the link is back.', action = 'USE TOR INSTEAD', onAction, onClose, className = '' }) {
  return (
    <div className={'bb-alarmb ' + className} role="alert">
      <div className="bb-alarmb__bar">
        <span className="bb-alarmb__title"><PixelIcon name="warning" size={14} />{title}</span>
        {onClose && <button type="button" className="bb-window__close" aria-label="Dismiss" onClick={onClose}>×</button>}
      </div>
      <div className="bb-alarmb__body">
        <p>{children}</p>
        {action && <KeyButton variant="danger" size="sm" onClick={onAction}>{action}</KeyButton>}
      </div>
    </div>
  );
}

/* SIGNAL LOST: a classic TV test card redrawn in our greens, with a plain message and auto-retry. */
export function SignalLost({ message = 'The connection dropped. Your balance is safe; nothing was sent.', retryIn = 5, onRetry, width = 640, className = '' }) {
  const [t, setT] = useState(retryIn);
  useEffect(() => {
    setT(retryIn);
    const id = setInterval(() => setT((v) => (v <= 1 ? retryIn : v - 1)), 1000);
    return () => clearInterval(id);
  }, [retryIn]);
  const bars = ['var(--phosphor-hi)', 'var(--phosphor)', 'var(--phosphor-mid)', 'var(--text-dim)', 'var(--redact-screen)', 'var(--line)', 'var(--panel)'];
  const steps = ['var(--void)', 'var(--panel)', 'var(--line)', 'var(--redact-screen)', 'var(--phosphor-mid)', 'var(--phosphor-hi)'];
  const castle = [];
  for (let i = 0; i < 16; i++) { castle.push(<rect key={'t' + i} x={i * 40} y="0" width="20" height="10" />, <rect key={'b' + i} x={i * 40 + 20} y="390" width="20" height="10" />); }
  for (let i = 0; i < 10; i++) { castle.push(<rect key={'l' + i} x="0" y={i * 40 + 20} width="10" height="20" />, <rect key={'r' + i} x="630" y={i * 40} width="10" height="20" />); }
  return (
    <div className={'bb-signal ' + className} style={{ width, maxWidth: '100%' }}>
      <svg viewBox="0 0 640 400" width="100%" role="img" aria-label="Test card: signal lost" style={{ display: 'block' }} shapeRendering="crispEdges">
        <rect width="640" height="400" fill="var(--void)" />
        <g stroke="var(--line)">{Array.from({ length: 15 }, (_, i) => <line key={'v' + i} x1={(i + 1) * 40} x2={(i + 1) * 40} y1="0" y2="400" />)}{Array.from({ length: 9 }, (_, i) => <line key={'h' + i} y1={(i + 1) * 40} y2={(i + 1) * 40} x1="0" x2="640" />)}</g>
        <g fill="var(--phosphor-mid)">{castle}</g>
        <defs><clipPath id="bb-tc-circle"><circle cx="320" cy="200" r="160" /></clipPath></defs>
        <g clipPath="url(#bb-tc-circle)">
          <rect x="150" y="30" width="340" height="340" fill="var(--glass)" />
          {bars.map((c, i) => <rect key={i} x={160 + i * (320 / 7)} y="58" width={320 / 7 + 1} height="64" fill={c} />)}
          <rect x="150" y="122" width="170" height="34" fill="var(--void)" /><rect x="320" y="122" width="170" height="34" fill="var(--phosphor-hi)" />
          <rect x="196" y="164" width="248" height="62" fill="var(--void)" stroke="var(--phosphor)" strokeWidth="2" />
          <text x="320" y="210" textAnchor="middle" fill="var(--phosphor)" className="bb-glow" style={{ fontFamily: 'var(--font-display)', fontSize: 48 }}>SIGNAL LOST</text>
          {steps.map((c, i) => <rect key={i} x={160 + i * (320 / 6)} y="236" width={320 / 6 + 1} height="40" fill={c} />)}
          <g fill="var(--phosphor-mid)">
            {[8, 4, 2, 1].map((wd, gi) => Array.from({ length: Math.floor(70 / (wd * 2)) }, (_, k) => <rect key={gi + '-' + k} x={170 + gi * 76 + k * wd * 2} y="284" width={wd} height="34" />))}
          </g>
          <text x="320" y="346" textAnchor="middle" fill="var(--text-dim)" style={{ fontFamily: 'var(--font-ui)', fontSize: 14, letterSpacing: '.08em' }}>BLINDBOOK · P000</text>
        </g>
        <circle cx="320" cy="200" r="160" fill="none" stroke="var(--phosphor-mid)" strokeWidth="2" />
        <line x1="320" x2="320" y1="40" y2="56" stroke="var(--phosphor-mid)" /><line x1="320" x2="320" y1="344" y2="360" stroke="var(--phosphor-mid)" />
      </svg>
      <div className="bb-signal__msg">
        <p>{message}</p>
        <p className="bb-signal__retry" role="status">Retrying in {t} s<span className="bb-cursor" aria-hidden="true" /></p>
        {onRetry && <KeyButton variant="secondary" size="sm" onClick={onRetry}>RETRY NOW</KeyButton>}
      </div>
    </div>
  );
}
