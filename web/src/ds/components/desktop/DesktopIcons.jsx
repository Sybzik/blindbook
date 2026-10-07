import React, { useEffect } from 'react';
import { PixelIcon } from '../brand/PixelIcon.jsx';
import { Wordmark } from '../brand/Logo.jsx';

export const DEFAULT_ICONS = [
  { id: 'markets', fkey: 'F1', label: 'MARKETS', icon: 'markets', led: true },
  { id: 'slips', fkey: 'F2', label: 'SLIPS', icon: 'slips', indicator: '1' },
  { id: 'cage', fkey: 'F3', label: 'CAGE', icon: 'cage', indicator: '0.143' },
  { id: 'verify', fkey: 'F4', label: 'VERIFY', icon: 'verify', indicator: '✓' },
  { id: 'how', fkey: 'F5', label: 'HOW', icon: 'how' },
];

/* The back-room apps: each is its own desktop icon and opens its own window. */
export const APP_ICONS = [
  { id: 'snake', page: 'P701', label: 'NULLIFIER SNAKE', icon: 'snake' },
  { id: 'calc', page: 'P702', label: 'ODDS CALC', icon: 'calculator' },
  { id: 'tracker', page: 'P703', label: 'REDACT-A-TRACKER', icon: 'tracker' },
  { id: 'deaddrop', page: 'P704', label: 'DEAD DROP', icon: 'notepad' },
  { id: 'radio', page: 'P705', label: 'BLOCK RADIO', icon: 'radio' },
];

/* One desktop shortcut: pixel icon + plain label, no box. Live badge as a small tag. */
export function DesktopIcon({ label, icon, indicator, led, alert = false, selected = false, state, iconSize = 21, fkey, onClick, className = '', ...rest }) {
  const st = selected ? 'selected' : state;
  const cls = ['bb-dicon', st && 'is-' + st, className].filter(Boolean).join(' ');
  let tag = null;
  if (alert) tag = <span className="bb-dicon__tag is-alert" aria-label="alert"><span className="bb-led is-alert" /></span>;
  else if (indicator !== undefined && indicator !== null && indicator !== '') tag = <span className="bb-dicon__tag">{indicator}</span>;
  else if (led !== undefined) tag = <span className="bb-dicon__tag" aria-label={led ? 'live' : 'off'}><span className={'bb-led' + (led ? ' is-on' : '')} /></span>;
  return (
    <button type="button" className={cls} aria-current={selected ? 'page' : undefined} aria-keyshortcuts={fkey} onClick={onClick} {...rest}>
      {icon && <span className="bb-dicon__icon"><PixelIcon name={icon} size={iconSize} /></span>}
      <span className="bb-dicon__label">{label}</span>
      {tag}
    </button>
  );
}

/* Desktop shortcuts. Pages at the top-left (F1–F5 bound, never printed); a `group` label heads a set like BACK ROOM. */
export function DesktopIcons({ items = DEFAULT_ICONS, selected, onSelect, layout = 'column', iconSize = 21, group, bindFKeys = false, className = '', style }) {
  useEffect(() => {
    if (!bindFKeys || !onSelect) return;
    const h = (e) => { const it = items.find((i) => i.fkey === e.key); if (it) { e.preventDefault(); onSelect(it.id); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [bindFKeys, items, onSelect]);
  return (
    <nav className={'bb-dicons bb-dicons--' + layout + ' ' + className} aria-label={group || 'Pages'} style={style}>
      {group && <span className="bb-dicons__group" aria-hidden="true">{group}</span>}
      {items.map(({ id, page, ...it }) => <DesktopIcon key={id} {...it} iconSize={iconSize} selected={id === selected} onClick={() => onSelect && onSelect(id)} />)}
    </nav>
  );
}

/* BACK ROOM apps as a desktop-icon group (top-right of the desktop; big icons on the pager MENU). */
export function AppIcons({ items = APP_ICONS, group = 'BACK ROOM', iconSize = 28, layout = 'column', ...rest }) {
  return <DesktopIcons items={items} group={group} iconSize={iconSize} layout={layout} {...rest} />;
}

/* The desktop wallpaper: void, one soft phosphor light from the top-left, scanlines + noise,
   and the whole BLINDBOOK wordmark, barely visible, centred behind the windows. */
export function Wallpaper({ wordmark = true, children, className = '', style }) {
  return (
    <div className={'bb-wallpaper bb-crt ' + className} style={style}>
      {wordmark && <div className="bb-wallpaper__mark" aria-hidden="true"><Wordmark height={7} color="var(--line)" title=" " style={{ width: '100%', height: 'auto' }} /></div>}
      {children}
    </div>
  );
}
