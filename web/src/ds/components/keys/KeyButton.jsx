import React from 'react';
import { PixelIcon } from '../brand/PixelIcon.jsx';

/* The physical key. One primary per screen. Pressed moves 1px down onto its skirt. */
export function KeyButton({ variant = 'primary', size = 'md', state, loading = false, disabled = false, icon, fullWidth = false, children, className = '', type = 'button', ...rest }) {
  const isDisabled = disabled || state === 'disabled';
  const isLoading = loading || state === 'loading';
  const cls = ['bb-key', 'bb-key--' + variant, 'bb-key--' + size, state && 'is-' + state, isLoading && 'is-loading', fullWidth && 'bb-key--full', className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} disabled={isDisabled} aria-busy={isLoading || undefined} {...rest}>
      {icon && <PixelIcon name={icon} size={14} />}
      <span className="bb-key__label">{children}</span>
      {isLoading && <span className="bb-cursor" aria-hidden="true" />}
    </button>
  );
}
