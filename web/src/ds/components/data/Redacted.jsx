import React from 'react';

function roughEdge(seed, n = 14) {
  let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) | 0;
  const r = () => { h = (h * 1103515245 + 12345) & 0x7fffffff; return h / 0x7fffffff; };
  const top = [], bot = [];
  for (let i = 0; i <= n; i++) { const x = (i / n) * 100; top.push(`${x.toFixed(1)}% ${(r() * 14).toFixed(1)}%`); bot.unshift(`${x.toFixed(1)}% ${(86 + r() * 14).toFixed(1)}%`); }
  return `polygon(${(r() * 3).toFixed(1)}% 30%, ${top.join(',')}, ${(97 + r() * 3).toFixed(1)}% 55%, ${bot.join(',')})`;
}

/* Redaction. Screen: solid block characters in dim green, inside the sentence. Paper: a rough black marker stroke over print. */
export function Redacted({ length = 8, text, medium = 'screen', label = 'redacted participant', seed, className = '', style }) {
  if (medium === 'paper') {
    const under = text ?? 'x'.repeat(length);
    return (
      <span role="img" aria-label={label} className={'bb-redact-paper ' + className} style={{ clipPath: roughEdge(seed ?? under), ...style }}>
        <span aria-hidden="true">{under}</span>
      </span>
    );
  }
  return <span role="img" aria-label={label} className={'bb-redact ' + className} style={style}>{'█'.repeat(text ? text.length : length)}</span>;
}

/* Data row with dotted leaders: CLOSES ............ at kick-off · Oct 3 09:00 UTC */
export function LeaderRow({ label, value, tone = 'default', medium = 'screen', ruled = false, className = '', style }) {
  const cls = ['bb-leader', 'bb-leader--' + tone, medium === 'paper' && 'bb-leader--paper', ruled && 'bb-leader--ruled', className].filter(Boolean).join(' ');
  return (
    <div className={cls} style={style}>
      <span className="bb-leader__label">{label}</span>
      <span className="bb-leader__dots" aria-hidden="true" />
      <span className="bb-leader__value">{value}</span>
    </div>
  );
}

/* Recent fill, written as a sentence. Prices and sizes bright; people blacked out. */
export function FillRow({ outcome, side = 'a', amount, unit = 'ZEC', price, block, length = 8, verb = 'bought', className = '' }) {
  return (
    <p className={'bb-fill ' + className}>
      <Redacted length={length} />{' '}
      <span className="bb-fill__verb">{verb}</span>{' '}
      <span style={{ color: side === 'b' ? 'var(--outcome-b)' : 'var(--outcome-a)' }}>{outcome}</span>
      <span className="bb-fill__sep"> · </span>
      <span className="bb-fill__amt">{amount} {unit}</span>
      <span className="bb-fill__verb"> @ </span>
      <span className="bb-fill__amt">{price}¢</span>
      {block !== undefined && <><span className="bb-fill__sep"> · </span><span className="bb-fill__verb">blk {typeof block === 'number' ? block.toLocaleString('en-US') : block}</span></>}
    </p>
  );
}
