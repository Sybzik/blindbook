import React, { useEffect, useRef, useState } from 'react';
import { Logo } from '../brand/Logo.jsx';
import { KeyButton } from '../keys/KeyButton.jsx';
import { TextInput } from '../forms/TextInput.jsx';
import { LeaderRow } from '../data/Redacted.jsx';

const NODES = ['YOU', 'HOP 1', 'HOP 2', 'HOP 3', 'BOOTH'];
const X = (i) => 10 + i * 20;

/* The mixnet as a compact strip: YOU ▪ → HOP 1 ▪ → HOP 2 ▪ → HOP 3 ▪ → BOOTH, one bright packet travelling, hops ticking ✓. */
export function MixnetMap({ progress, hops, auto = false, duration = 2000, onLinked, className = '' }) {
  const [p, setP] = useState(0);
  const done = useRef(false);
  useEffect(() => {
    if (!auto) return;
    done.current = false; let raf, t0;
    const step = (t) => { if (t0 == null) t0 = t; const v = Math.min(1, (t - t0) / duration); setP(v); if (v < 1) raf = requestAnimationFrame(step); else if (!done.current) { done.current = true; onLinked && onLinked(); } };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [auto, duration]);
  const h = hops ?? 3;
  const prog = auto ? p : progress != null ? Math.max(0, Math.min(1, progress)) : h >= 3 ? 1 : h / 4 + 0.12;
  const linked = prog >= 1;
  const reached = (i) => prog >= i / 4 - 0.0001;
  const ticks = [1, 2, 3].filter(reached).length;
  return (
    <div className={'bb-mixstrip' + (linked ? ' is-linked' : '') + ' ' + className} role="status" aria-label={linked ? 'Mixnet linked through three hops' : `Linking mixnet: ${ticks} of 3 hops`}>
      <div className="bb-mixstrip__track" aria-hidden="true">
        <span className="bb-mixstrip__rail" />
        <span className="bb-mixstrip__lit" style={{ width: prog * 80 + '%' }} />
        {[0, 1, 2, 3].map((i) => <span key={'a' + i} className={'bb-mixstrip__arrow' + (prog >= (i + 0.5) / 4 ? ' is-on' : '')} style={{ left: X(i) + 10 + '%' }}>→</span>)}
        {NODES.map((n, i) => <span key={n} className={'bb-mixstrip__node' + (reached(i) ? ' is-on' : '')} style={{ left: X(i) + '%' }} />)}
        {!linked && <span className="bb-mixstrip__packet" style={{ left: X(0) + prog * 80 + '%' }} />}
      </div>
      <div className="bb-mixstrip__labels" aria-hidden="true">
        {NODES.map((n, i) => {
          const on = reached(i);
          const st = i === 0 ? 'SENT' : i === 4 ? (linked ? 'LINKED' : '·') : on ? '✓' : '·';
          return <span key={n} className={on ? 'is-on' : ''}><b>{n}</b><i className={i === 4 && linked ? 'is-linked' : ''}>{st}</i></span>;
        })}
      </div>
    </div>
  );
}

export const BOOT_LINES = ['LINKING MIXNET', 'DERIVING KEYS', 'LOADING MARKETS'];

/* BOOT: a short full-screen moment before the desktop. Eye, three typed lines, pixel progress bar, mixnet strip.
   ~2.6 s; any key or click skips; animate=false (CLEAN SIGNAL) shows the finished state with no motion. */
export function BootSequence({ onDone, animate = true, duration = 2600, lines = BOOT_LINES, blocks = 24, className = '' }) {
  const [t, setT] = useState(animate ? 0 : duration);
  const fired = useRef(false);
  const finish = () => { if (fired.current) return; fired.current = true; onDone && onDone(); };
  useEffect(() => {
    if (!animate) { setT(duration); const k = setTimeout(finish, 900); return () => clearTimeout(k); }
    let raf, t0;
    const step = (now) => { if (t0 == null) t0 = now; const v = now - t0; setT(Math.min(v, duration)); if (v < duration) raf = requestAnimationFrame(step); else finish(); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [animate, duration]);
  useEffect(() => {
    const skip = () => finish();
    window.addEventListener('keydown', skip);
    return () => window.removeEventListener('keydown', skip);
  }, []);
  const slot = (duration * 0.85) / lines.length;
  const prog = Math.min(1, t / (duration * 0.92));
  const filled = Math.round(prog * blocks);
  return (
    <div className={'bb-boot ' + className} onPointerDown={finish} role="status" aria-label={prog >= 1 ? 'Ready' : 'Starting Blindbook'}>
      <div className="bb-boot__eye bb-glow-svg" style={{ color: 'var(--phosphor)' }}><Logo size={96} variant="bare" title="Blindbook" /></div>
      <div className="bb-boot__lines">
        {lines.map((l, i) => {
          const s = i * slot, typed = Math.max(0, Math.min(l.length, Math.ceil(((t - s) / (slot * 0.6)) * l.length)));
          if (t < s) return <div key={l} className="bb-boot__line is-wait" aria-hidden="true"><LeaderRow label={'\u00a0'} value={'\u00a0'} /></div>;
          const ok = t >= s + slot * 0.8;
          return <div key={l} className="bb-boot__line"><LeaderRow label={<>{l.slice(0, typed)}{!ok && <span className="bb-cursor" aria-hidden="true" />}</>} value={ok ? '✓' : '\u00a0'} tone="hi" /></div>;
        })}
      </div>
      <div className="bb-boot__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(prog * 100)} aria-label="Loading">
        {Array.from({ length: blocks }, (_, i) => <span key={i} className={i < filled ? 'is-on' : ''} />)}
      </div>
      <MixnetMap progress={Math.min(1, t / (duration * 0.9))} className="bb-boot__mix" />
      <p className="bb-boot__skip">press any key to skip</p>
    </div>
  );
}

/* 12×18 pixel line-art: escutcheon outline (amber-dim) + keyhole (phosphor). */
const PLATE = ['...######...', '..#......#..', '.#........#.', '#..........#', '#..........#', '#..........#', '#..........#', '#..........#', '#..........#', '#..........#', '#..........#', '#..........#', '#..........#', '#..........#', '#..........#', '.#........#.', '..#......#..', '...######...'];
const HOLE = ['............', '............', '............', '............', '....####....', '...######...', '...######...', '...######...', '....####....', '.....##.....', '....####....', '....####....', '...######...', '...######...', '..########..', '............', '............', '............'];
const px = (rows, k) => rows.flatMap((r, y) => r.split('').map((c, x) => (c === '#' ? <rect key={k + x + '-' + y} x={x} y={y} width="1" height="1" /> : null)));

/* The keyhole alone. idle = phosphor glow · lit (Face ID / unlocking) = bright · error = alarm. Max 72px tall. */
export function Keyhole({ state = 'idle', size = 72, className = '' }) {
  const lit = state === 'prompt' || state === 'unlocking' || state === 'unlocked';
  const h = Math.min(72, size);
  return (
    <span className={'bb-keyhole is-' + state + (lit ? ' is-lit' : '') + ' ' + className} aria-hidden="true">
      <svg width={(h * 12) / 18} height={h} viewBox="0 0 12 18" shapeRendering="crispEdges" style={{ display: 'block' }}>
        <g className="bb-keyhole__plate">{px(PLATE, 'p')}</g>
        <g className="bb-keyhole__hole">{px(HOLE, 'h')}</g>
      </svg>
    </span>
  );
}

/* UNLOCK. Desktop: keyhole, VAULT LOCKED, one sentence, passphrase field, UNLOCK key, restore link.
   Phone: the same keyhole glowing during Face ID, with "use passphrase". */
export function UnlockKeyhole({ device = 'phone', state = 'idle', onUsePassphrase, onUnlock, onForgot, passphrase, onPassphrase, error, className = '' }) {
  const st = error ? 'error' : state;
  if (device === 'desktop') {
    const busy = st === 'unlocking' || st === 'unlocked';
    return (
      <form className={'bb-unlock bb-unlock--desktop ' + className} onSubmit={(e) => { e.preventDefault(); onUnlock && onUnlock(); }}>
        <Keyhole state={st} />
        <h2 className="bb-unlock__title bb-glow">{st === 'unlocked' ? 'VAULT OPEN' : 'VAULT LOCKED'}</h2>
        <p className="bb-unlock__lead">Enter your passphrase to open your slips on this device.</p>
        <TextInput label="PASSPHRASE" type="password" value={passphrase} onChange={onPassphrase} placeholder="passphrase"
          state={st === 'error' ? 'invalid' : undefined} message={st === 'error' ? error || 'That passphrase did not open the vault. Try again.' : undefined} inputProps={{ disabled: busy }} />
        <KeyButton type="submit" size="lg" icon="lock" fullWidth loading={busy}>{busy ? 'UNLOCKING' : 'UNLOCK'}</KeyButton>
        <button type="button" className="bb-unlock__link" onClick={onForgot}>forgot it? restore from 12 words</button>
      </form>
    );
  }
  return (
    <div className={'bb-unlock bb-unlock--phone ' + className}>
      <Keyhole state={st} />
      <p className="bb-unlock__title bb-glow" role="status">
        {st === 'idle' && 'VAULT LOCKED'}
        {st === 'prompt' && <>FACE ID <span className="bb-cursor" aria-hidden="true" /></>}
        {st === 'unlocking' && 'UNLOCKING'}
        {st === 'error' && 'NOT RECOGNISED'}
        {st === 'unlocked' && 'VAULT OPEN'}
      </p>
      {(st === 'idle' || st === 'error') && <KeyButton icon="lock" fullWidth onClick={onUnlock}>FACE ID</KeyButton>}
      <button type="button" className="bb-unlock__link" onClick={onUsePassphrase}>use passphrase</button>
    </div>
  );
}
