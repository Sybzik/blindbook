import React, { useEffect, useRef, useState } from 'react';

/* One plain sentence about the focused element. Wraps; never truncated. */
export function HintText({ children, className = '' }) {
  return <p className={'bb-hint ' + className} aria-live="polite">{children}</p>;
}

/* Terminal window: mint striped title bar (void text), square close button, panel body, 1px phosphor-mid border.
   On the desktop it floats: draggable by the title bar, resize grip bottom-right, hint strip at the bottom. */
export function TerminalWindow({ title, onClose, closable = true, active = true, tone = 'default', width, maxWidth, height, maxHeight, padding, children, footer, hint, draggable = false, resizable = false, closing = false, onClosed, onActivate, className = '', style, bodyStyle, ...rest }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState(null);
  const cls = ['bb-window', !active && 'is-inactive', tone !== 'default' && 'bb-window--' + tone, (draggable || resizable) && 'is-floating', closing && 'is-shutter', className].filter(Boolean).join(' ');
  useEffect(() => { if (!closing) return; const t = setTimeout(() => onClosed && onClosed(), 380); return () => clearTimeout(t); }, [closing]);

  const start = (mode) => (e) => {
    if (e.button !== 0 || (mode === 'move' && e.target.closest('button'))) return;
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    drag.current = { mode, mx: e.clientX, my: e.clientY, x: pos.x, y: pos.y, w: r.width, h: r.height, top: el.offsetTop, left: el.offsetLeft };
    e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const move = (e) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.mx, dy = e.clientY - d.my;
    if (d.mode === 'move') {
      const pw = ref.current.offsetParent ? ref.current.offsetParent.clientWidth : window.innerWidth;
      const x = Math.min(pw - d.left - 96, Math.max(-(d.left + d.w - 96), d.x + dx));
      setPos({ x, y: Math.max(-d.top, d.y + dy) });
    } else setSize({ w: Math.max(320, d.w + dx), h: Math.max(200, d.h + dy) });
  };
  const end = () => { drag.current = null; };
  const sized = size ? { width: size.w, height: size.h, maxWidth: 'none', maxHeight: 'none' } : {};
  const moved = pos.x || pos.y ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : {};
  const t = typeof title === 'string' ? title : undefined;

  return (
    <section ref={ref} className={cls} style={{ width, maxWidth, height, maxHeight, ...style, ...sized, ...moved }} aria-label={t} onPointerDownCapture={onActivate} {...rest}>
      <header className={'bb-window__bar' + (draggable ? ' is-handle' : '')} onPointerDown={draggable ? start('move') : undefined} onPointerMove={draggable ? move : undefined} onPointerUp={end} onPointerCancel={end}>
        <span className="bb-window__title">{title}</span>
        {closable && <button type="button" className="bb-window__close" aria-label={'Close ' + (t || 'window')} onClick={onClose}>×</button>}
      </header>
      <div className="bb-window__body" style={{ padding, ...bodyStyle }}>{children}</div>
      {footer && <footer className="bb-window__footer">{footer}</footer>}
      {hint !== undefined && <div className="bb-window__hint"><HintText>{hint}</HintText></div>}
      {resizable && (
        <span className="bb-window__grip" aria-hidden="true" onPointerDown={start('size')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
          <svg width="12" height="12" viewBox="0 0 12 12" shapeRendering="crispEdges"><g fill="currentColor"><rect x="9" y="1" width="2" height="2" /><rect x="5" y="5" width="2" height="2" /><rect x="9" y="5" width="2" height="2" /><rect x="1" y="9" width="2" height="2" /><rect x="5" y="9" width="2" height="2" /><rect x="9" y="9" width="2" height="2" /></g></svg>
        </span>
      )}
    </section>
  );
}

/* Teletext page header: page number block + title in VT323. */
export function TeletextHeader({ page = 'P201', title, category, outcomeA, outcomeB, meta, size = 'sm', glow = true, className = '' }) {
  const body = title ?? (
    <>
      {category && <>{category} · </>}
      {outcomeA && <span style={{ color: 'var(--outcome-a)' }}>{outcomeA}</span>}
      {outcomeB && <> <span className="bb-tt__vs">vs</span> <span style={{ color: 'var(--outcome-b)' }}>{outcomeB}</span></>}
    </>
  );
  return (
    <div className={'bb-tt bb-tt--' + size + ' ' + className}>
      <span className="bb-tt__page">{page}</span>
      <h1 className={'bb-tt__title' + (glow ? ' bb-glow' : '')}>{body}</h1>
      {meta && <span className="bb-tt__meta">{meta}</span>}
    </div>
  );
}
