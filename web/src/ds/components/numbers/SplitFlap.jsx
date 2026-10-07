import React from 'react';

/* Split-flap numerals for prices, countdowns and block height. Changed characters flip. */
export function SplitFlap({ value, size = 'md', color, glow, label, animate = true, className = '', style }) {
  const s = typeof value === 'number' ? value.toLocaleString('en-US') : String(value ?? '');
  const g = glow ?? (size === 'lg' || size === 'xl');
  return (
    <span className={'bb-flap bb-flap--' + size + (animate ? '' : ' is-static') + ' ' + className} role="img" aria-label={(label ? label + ' ' : '') + s} style={{ color, ...style }}>
      {s.split('').map((c, i) => /[0-9A-Za-z]/.test(c)
        ? <span key={i + ':' + c} className="bb-flap__tile" aria-hidden="true"><span className={'bb-flap__ch' + (g ? ' bb-glow' : '')}>{c}</span></span>
        : <span key={i + ':' + c} className={'bb-flap__sep' + (g ? ' bb-glow' : '')} aria-hidden="true">{c}</span>)}
    </span>
  );
}

/* Outcome price pill. Outcome A is always green, outcome B always amber — whatever the labels. */
export function OutcomePill({ label, price, pct, side = 'a', selected = false, state, refPrice, size = 'md', onClick, className = '', ...rest }) {
  const Tag = onClick ? 'button' : 'span';
  const st = selected ? 'selected' : state;
  const cls = ['bb-pill', 'bb-pill--' + side, 'bb-pill--' + size, st && 'is-' + st, className].filter(Boolean).join(' ');
  return (
    <Tag className={cls} onClick={onClick} {...(onClick ? { type: 'button', 'aria-pressed': selected } : {})} {...rest}>
      <span className="bb-pill__mark" aria-hidden="true" />
      <span className="bb-pill__label">{label}</span>
      {price !== undefined && <span className="bb-pill__price">{price}¢</span>}
      {pct !== undefined && <><span className="bb-pill__sep">·</span><span className="bb-pill__pct">{pct}%</span></>}
      {refPrice !== undefined && <span className="bb-pill__ref">ref {refPrice}¢</span>}
    </Tag>
  );
}
