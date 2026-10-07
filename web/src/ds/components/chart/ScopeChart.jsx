import React, { useState, useRef, useEffect } from 'react';
import { ToggleSwitch } from '../taskbar/Taskbar.jsx';

function walk(seed, n, start, end, vol = 2.4) {
  let h = 0; for (const c of seed) h = (h * 33 + c.charCodeAt(0)) | 0;
  const r = () => { h = (h * 1103515245 + 12345) & 0x7fffffff; return h / 0x7fffffff; };
  const raw = [0]; for (let i = 1; i < n; i++) raw.push(raw[i - 1] + (r() - 0.5) * vol);
  const d = raw[n - 1];
  return raw.map((v, i) => Math.max(2, Math.min(98, start + (v - (d * i) / (n - 1)) + ((end - start) * i) / (n - 1))));
}

export const SCOPE_DEMO = [
  { label: 'LEGACY', side: 'a', value: 45, data: walk('legacy', 72, 58, 45, 4.2), refValue: 44, refData: walk('legacy-ref', 72, 57, 44, 2) },
  { label: 'PARIVISION', side: 'b', value: 56, data: walk('parivision', 72, 42, 56, 4.2), refValue: 55, refData: walk('pari-ref', 72, 43, 55, 2) },
];

/* Oscilloscope chart — both outcomes, labelled at their right ends, 0–100% axis, phosphor persistence. REF off by default. */
export function ScopeChart({ outcomes = SCOPE_DEMO, ranges = ['1H', '1D', '1W', 'ALL'], range, onRange, showRef, onToggleRef, height = 240, title = 'PRICE · BOTH OUTCOMES', className = '' }) {
  const [rS, setR] = useState('1D');
  const [refS, setRef] = useState(false);
  const cur = range ?? rS;
  const ref = showRef ?? refS;
  const box = useRef(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!box.current) return;
    const measure = () => box.current && setW(Math.max(300, Math.round(box.current.getBoundingClientRect().width - 2)));
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    let ro;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(box.current); }
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', measure); ro && ro.disconnect(); };
  }, []);

  const narrow = w < 480;
  const padL = 8, axisW = 44, labelW = narrow ? 112 : 150, padT = 14, padB = 14;
  const plotR = w - axisW - labelW;
  const plotW = plotR - padL, plotH = height - padT - padB;
  const Y = (v) => padT + (1 - v / 100) * plotH;
  const path = (d, from = 0) => d.slice(from).map((v, j) => (j ? 'L' : 'M') + (padL + ((j + from) / (d.length - 1)) * plotW).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
  const col = (s) => (s === 'b' ? 'var(--outcome-b)' : 'var(--outcome-a)');

  // One label group per outcome: its own label, then (REF on) one short violet line "POLYMARKET 55%" right under it.
  // The position shows which outcome a reference belongs to; groups keep a 12px gap so the pairs never touch.
  const LH = 16, GAP = 12;
  const groups = outcomes.map((o) => {
    const lines = narrow ? [{ t: o.label, c: col(o.side) }, { t: o.value + '%', c: col(o.side) }] : [{ t: `${o.label} ${o.value}%`, c: col(o.side) }];
    if (ref && o.refValue !== undefined) lines.push({ t: `POLYMARKET ${o.refValue}%`, c: 'var(--ref)', ref: 1 });
    return { y: Y(o.value), lines };
  }).sort((p, q) => p.y - q.y);
  for (let i = 1; i < groups.length; i++) { const end = groups[i - 1].y + (groups[i - 1].lines.length - 1) * LH + LH + GAP; if (groups[i].y < end) groups[i].y = end; }
  const last = groups[groups.length - 1];
  const over = last ? last.y + (last.lines.length - 1) * LH - (height - 6) : 0;
  if (over > 0) groups.forEach((g) => (g.y -= over));
  if (groups[0] && groups[0].y < padT + 4) { const d = padT + 4 - groups[0].y; groups.forEach((g) => (g.y += d)); }

  const setRange = (r) => { setR(r); onRange && onRange(r); };
  const toggleRef = (v) => { setRef(v); onToggleRef && onToggleRef(v); };

  return (
    <div className={'bb-scope ' + className}>
      <div className="bb-scope__head">
        <span className="bb-label">{title}</span>
        <div className="bb-scope__tabs" role="tablist" aria-label="Time range">
          {ranges.map((r) => <button key={r} type="button" role="tab" aria-selected={r === cur} className={'bb-tab' + (r === cur ? ' is-on' : '')} onClick={() => setRange(r)}>{r}</button>)}
        </div>
        <ToggleSwitch label="REF" checked={ref} onChange={toggleRef} className="bb-switch--ref" />
      </div>
      <div className="bb-scope__screen" ref={box}>
        <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" role="img" aria-label={outcomes.map((o) => `${o.label} ${o.value}%`).join(', ') + (ref ? '; ' + outcomes.filter((o) => o.refValue !== undefined).map((o) => `Polymarket ${o.label} ${o.refValue}%`).join(', ') : '')} style={{ display: 'block', width: '100%' }}>
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line x1={padL} x2={plotR} y1={Y(v)} y2={Y(v)} stroke="var(--line)" strokeDasharray={v % 50 ? '2 4' : 'none'} />
              <text x={w - 4} y={Y(v) + 5} textAnchor="end" className="bb-scope__axis">{v}%</text>
            </g>
          ))}
          {[1, 2, 3, 4, 5].map((i) => <line key={i} x1={padL + (plotW * i) / 6} x2={padL + (plotW * i) / 6} y1={padT} y2={height - padB} stroke="var(--line)" strokeDasharray="2 4" />)}
          {ref && outcomes.map((o) => o.refData && <path key={'r' + o.label} d={path(o.refData)} fill="none" stroke="var(--ref)" strokeWidth="1" strokeDasharray="5 4" />)}
          {outcomes.map((o) => {
            const n = o.data.length, tail = Math.floor(n * 0.62);
            return (
              <g key={o.label} style={{ color: col(o.side) }}>
                <path d={path(o.data.map((v, i) => v + Math.sin(i * 1.7) * 1.4))} fill="none" stroke="currentColor" strokeWidth="1" opacity=".14" />
                <path d={path(o.data)} fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".4" />
                <g className="bb-glow-svg">
                  <path d={path(o.data, tail)} fill="none" stroke="currentColor" strokeWidth="2" />
                  <rect x={plotR - 3} y={Y(o.value) - 3} width="6" height="6" fill="currentColor" />
                </g>
              </g>
            );
          })}
          {groups.map((g, gi) => (
            <text key={gi} className="bb-scope__label">
              {g.lines.map((l, li) => <tspan key={li} x={plotR + 8} y={g.y + 5 + li * LH} fill={l.c} className={l.ref ? 'bb-scope__label--ref' : undefined}>{l.t}</tspan>)}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
