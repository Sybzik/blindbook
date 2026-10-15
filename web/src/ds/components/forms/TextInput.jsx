import React, { useState, useEffect } from 'react';

/* Text input (address field): empty, focus, valid ✓, invalid ✗ with a plain message. */
export function TextInput({ label, value, defaultValue, placeholder, onChange, state, message, action, type = 'text', id, required = false, className = '', inputProps, ...rest }) {
  const autoId = React.useId ? React.useId() : 'bb-in';
  const iid = id || autoId;
  const cls = ['bb-input', state && 'is-' + state, className].filter(Boolean).join(' ');
  const adorn = state === 'valid' ? '✓' : state === 'invalid' ? '✗' : null;
  return (
    <div className={cls} {...rest}>
      {label && <label className="bb-label bb-input__label" htmlFor={iid}>{label}{required && <span className="bb-input__req"> *</span>}</label>}
      <div className="bb-input__field">
        <input id={iid} type={type} value={value} defaultValue={defaultValue} placeholder={placeholder} spellCheck="false" autoComplete="off"
          aria-invalid={state === 'invalid' || undefined} aria-describedby={message ? iid + '-msg' : undefined}
          onChange={(e) => onChange && onChange(e.target.value)} {...inputProps} />
        {state === 'focus' && !value && <span className="bb-cursor bb-input__cursor" aria-hidden="true" />}
        {adorn && <span className="bb-input__adorn" aria-hidden="true">{adorn}</span>}
        {action}
      </div>
      {message && <p id={iid + '-msg'} className="bb-input__msg">{message}</p>}
    </div>
  );
}

export const PREFLIGHT_DEFAULT = [
  { label: 'MIXNET LINKED', ok: '3 HOPS', fail: 'NOT LINKED' },
  { label: 'PHRASE BACKED UP', ok: 'BACKED UP', fail: 'BACK UP FIRST' },
  { label: 'STANDARD AMOUNT', ok: '0.05 ZEC', fail: 'NON-STANDARD' },
  { label: 'PAY FROM YOUR SHIELDED BALANCE', ok: 'SHIELDED', fail: 'TRANSPARENT' },
];

/* Aircraft-style privacy preflight. Rows tick themselves off before every payment. */
export function PreflightChecklist({ items = PREFLIGHT_DEFAULT, statuses, auto = false, interval = 520, onComplete, className = '' }) {
  const [n, setN] = useState(auto ? 0 : items.length);
  useEffect(() => {
    if (!auto) return;
    setN(0);
    let i = 0;
    const t = setInterval(() => { i++; setN(i); if (i >= items.length) { clearInterval(t); onComplete && onComplete(); } }, interval);
    return () => clearInterval(t);
  }, [auto, items.length]);
  const st = items.map((_, i) => (statuses ? statuses[i] : i < n ? 'ok' : i === n ? 'checking' : 'pending'));
  const okCount = st.filter((s) => s === 'ok').length;
  const failed = st.includes('fail');
  return (
    <div className={'bb-preflight ' + className}>
      <ul className="bb-preflight__list">
        {items.map((it, i) => (
          <li key={it.label} className={'bb-preflight__row is-' + st[i]}>
            <span className="bb-preflight__box" aria-hidden="true">{st[i] === 'fail' ? '✗' : ''}</span>
            <span className="bb-preflight__label">{it.label}</span>
            <span className="bb-preflight__status">
              {st[i] === 'ok' ? '✓ ' + it.ok : st[i] === 'fail' ? '✗ ' + it.fail : st[i] === 'checking' ? 'CHECKING…' : '—'}
            </span>
          </li>
        ))}
      </ul>
      <p className={'bb-preflight__sum' + (failed ? ' is-fail' : okCount === items.length ? ' is-ok' : '')} role="status">
        {failed ? 'STOPPED · fix the red line before paying.' : okCount === items.length ? `${okCount}/${items.length} CLEAR · ready to pay.` : `${okCount}/${items.length} checked…`}
      </p>
    </div>
  );
}
