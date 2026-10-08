import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PixelIcon } from '../brand/PixelIcon.jsx';
import { SplitFlap } from '../numbers/SplitFlap.jsx';
import { APP_ICONS } from '../desktop/DesktopIcons.jsx';

const LAMP = {
  linked: { text: 'LINKED', led: 'is-on is-pulse', color: 'var(--phosphor)' },
  relinking: { text: 'RELINKING', led: 'is-on is-blink', color: 'var(--phosphor-hi)' },
  down: { text: 'DOWN', led: 'is-alert', color: 'var(--alarm)' },
  /* A development build without the mixnet says so instead of pretending. */
  off: { text: 'OFF', led: '', color: 'var(--text-dim)' },
  /* The .onion mirror: Tor carries the requests instead of the mixnet. */
  tor: { text: 'VIA TOR', led: 'is-on', color: 'var(--phosphor)', word: 'NETWORK' },
  /* No mixnet in this build and the server doesn't answer. */
  noanswer: { text: 'NO ANSWER', led: 'is-alert', color: 'var(--alarm)', word: 'NETWORK' },
};

/* The mixnet lamp: the only thing in the chrome that moves on its own. */
export function MixnetLamp({ state = 'linked', detail, compact = false, className = '' }) {
  const l = LAMP[state] || LAMP.linked;
  return (
    <span className={'bb-lamp ' + className} role="status" aria-label={(l.word ? 'Network ' : 'Mixnet ') + l.text.toLowerCase()}>
      <span className={'bb-led ' + l.led} aria-hidden="true" />
      {!compact && <span className="bb-lamp__word">{l.word || 'MIXNET'}</span>}
      <span style={{ color: l.color }}>{l.text}</span>
      {detail && <span className="bb-lamp__detail">· {detail}</span>}
    </span>
  );
}

/* Square pixel slide switch. */
export function ToggleSwitch({ label, checked = false, onChange, className = '' }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={'bb-switch' + (checked ? ' is-on' : '') + ' ' + className} onClick={() => onChange && onChange(!checked)}>
      <span>{label}</span>
      <span className="bb-switch__track" aria-hidden="true"><span className="bb-switch__knob" /></span>
    </button>
  );
}

function useClock(fixed) {
  const fmt = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const [t, setT] = useState(fixed || fmt());
  useEffect(() => { if (fixed) { setT(fixed); return; } const i = setInterval(() => setT(fmt()), 15000); return () => clearInterval(i); }, [fixed]);
  return t;
}

const START_PAGES = [
  { id: 'markets', fkey: 'F1', label: 'MARKETS', icon: 'markets' },
  { id: 'slips', fkey: 'F2', label: 'SLIPS', icon: 'slips' },
  { id: 'cage', fkey: 'F3', label: 'CAGE', icon: 'cage' },
  { id: 'verify', fkey: 'F4', label: 'VERIFY', icon: 'verify' },
  { id: 'how', fkey: 'F5', label: 'HOW IT WORKS', icon: 'how' },
];

/* One START menu entry (top level, so it doesn't remount on every render of the menu). */
function Item({ icon, label, kbd, onClick }) {
  return (
    <button type="button" role="menuitem" className="bb-start__item" onClick={onClick}>
      <PixelIcon name={icon} size={14} /><span className="bb-start__label">{label}</span>{kbd && <span className="bb-start__kbd">{kbd}</span>}
    </button>
  );
}

/* START menu: every page, APPS, CONSOLE, REPLAY INTRO, CLEAN SIGNAL, SOUND, LOCK VAULT. */
export function StartMenu({ pages = START_PAGES, apps = APP_ICONS, onSelect, onApp, onConsole, onReplayIntro, clean = false, onToggleClean, sound = false, onToggleSound, onLock, className = '', style }) {
  return (
    <div className={'bb-start__menu ' + className} role="menu" aria-label="Start" style={style}>
      <div className="bb-start__head"><span className="bb-start__title"><span className="bb-diamond" aria-hidden="true" />BLINDBOOK</span></div>
      <div className="bb-start__group">
        {pages.map((p) => <Item key={p.id} icon={p.icon} label={p.label} kbd={p.fkey} onClick={() => onSelect && onSelect(p.id)} />)}
      </div>
      {apps && apps.length > 0 && <div className="bb-start__group">
        <span className="bb-start__sub">APPS</span>
        {apps.map((a) => <Item key={a.id} icon={a.icon} label={a.label} onClick={() => onApp && onApp(a.id)} />)}
      </div>}
      <div className="bb-start__group">
        <Item icon="console" label="CONSOLE" kbd="`" onClick={onConsole} />
        {onReplayIntro && <Item icon="eye" label="REPLAY INTRO" onClick={onReplayIntro} />}
        <div className="bb-start__switch"><ToggleSwitch label="CLEAN SIGNAL" checked={clean} onChange={onToggleClean} /></div>
        <div className="bb-start__switch"><ToggleSwitch label="SOUND" checked={sound} onChange={onToggleSound} /></div>
      </div>
      {onLock && <div className="bb-start__group"><Item icon="lock" label="LOCK VAULT" kbd="ESC ESC" onClick={onLock} /></div>}
    </div>
  );
}

/* Taskbar: always one row, fixed height. ◆ START · one tab per open window · BAL · MIXNET lamp · BLK · clock.
   Tabs that don't fit shrink to "▤ P300" (full title stays as the accessible name); they never wrap or truncate. */
export function Taskbar({ windows = [], focused, onWindow, startOpen = false, onStartToggle, startMenu, balance = '0.1432', unit = 'ZEC', mixnet = 'linked', block = 3514229, clock, className = '', style }) {
  const startRef = useRef(null);
  const tabsRef = useRef(null);
  const measureRef = useRef(null);
  const [tight, setTight] = useState(false);
  const time = useClock(clock);
  const sig = windows.map((w) => w.title).join('|');
  useLayoutEffect(() => {
    const box = tabsRef.current, m = measureRef.current;
    if (!box || !m) return;
    const fit = () => setTight(m.offsetWidth > box.clientWidth + 1);
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit); ro.observe(box);
    return () => ro.disconnect();
  }, [sig]);
  const shortOf = (w) => w.short || String(w.title).split(' · ')[0];
  useEffect(() => {
    if (!startOpen || !onStartToggle) return;
    const down = (e) => { if (startRef.current && !startRef.current.contains(e.target)) onStartToggle(false); };
    const key = (e) => { if (e.key === 'Escape') onStartToggle(false); };
    document.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key); };
  }, [startOpen, onStartToggle]);
  return (
    <div className={'bb-taskbar ' + className} style={style} role="contentinfo">
      <div className="bb-taskbar__start" ref={startRef}>
        <button type="button" className={'bb-start' + (startOpen ? ' is-open' : '')} aria-haspopup="menu" aria-expanded={startOpen} onClick={() => onStartToggle && onStartToggle(!startOpen)}>
          <span className="bb-diamond" aria-hidden="true" />START
        </button>
        {startOpen && startMenu}
      </div>
      <div className="bb-taskbar__tabs" role="tablist" aria-label="Open windows" ref={tabsRef}>
        <div className="bb-taskbar__measure" ref={measureRef} aria-hidden="true">
          {windows.map((w) => <span key={w.id} className="bb-task"><span>▤</span>{w.title}</span>)}
        </div>
        {windows.map((w) => (
          <button key={w.id} type="button" role="tab" aria-selected={w.id === focused} aria-label={w.title} title={tight ? w.title : undefined} className={'bb-task' + (w.id === focused ? ' is-on' : '')} onClick={() => onWindow && onWindow(w.id)}>
            <span aria-hidden="true">▤</span>{tight ? shortOf(w) : w.title}
          </button>
        ))}
      </div>
      <div className="bb-taskbar__tray">
        <span className="bb-tray__seg bb-tray__seg--bal">BAL <span className="bb-tray__val">{balance} {unit}</span></span>
        <span className="bb-tray__seg"><MixnetLamp state={mixnet} /></span>
        <span className="bb-tray__seg bb-tray__seg--blk">BLK <SplitFlap value={block} size="sm" label="block height" /></span>
        <span className="bb-tray__seg bb-tray__clock" aria-label={'time ' + time}>{time}</span>
      </div>
    </div>
  );
}
