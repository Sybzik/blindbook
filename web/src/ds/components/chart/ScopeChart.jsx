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

/* Oscilloscope chart — both outcomes, labelled at their right ends, an axis fitted to the lines, phosphor persistence. REF off by default. */
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
  // The label column fits the longest outcome name (up to 30% of the width, 36% on a phone); a name that still
  // doesn't fit on one line with its price wraps at its spaces over up to two lines, the price
  // after it or under it, cut with … only past that.
  const CH = 9.4;
  const longest = Math.max(5, ...outcomes.map((o) => o.label.length));
  const labelW = Math.round(Math.max(narrow ? 112 : 150, Math.min(Math.max(narrow ? 112 : 150, w * (narrow ? 0.36 : 0.3)), 10 + longest * CH)));
  const fits = (t) => 10 + t.length * CH <= labelW;
  const cut = (t) => (fits(t) ? t : t.slice(0, Math.max(3, Math.floor((labelW - 10) / CH) - 1)) + '…');
  const wrap = (name, price) => {
    if (fits(`${name} ${price}`)) return [`${name} ${price}`];
    const rows = [];
    let row = '';
    for (const word of name.split(' ')) {
      if (!row || fits(`${row} ${word}`)) row = row ? `${row} ${word}` : word;
      else { rows.push(row); row = word; }
    }
    rows.push(row);
    const two = rows.length > 2 ? [rows[0], cut(rows.slice(1).join(' '))] : rows.map(cut);
    const lastRow = two[two.length - 1];
    return fits(`${lastRow} ${price}`) && !lastRow.endsWith('…') ? [...two.slice(0, -1), `${lastRow} ${price}`] : [...two, price];
  };
  const padL = 8, axisW = 44, padT = 14, padB = 14;
  const plotR = w - axisW - labelW;
  const plotW = plotR - padL, plotH = height - padT - padB;
  // The axis fits what is drawn (both outcomes; with REF on, Polymarket's lines too), at least 20
  // points tall, on round steps, so a move of a few cents shows; its labels say where it is.
  const drawn = outcomes.flatMap((o) => [...o.data, o.value, ...(ref && o.refData ? o.refData : [])]);
  const dLo = Math.min(...drawn), dHi = Math.max(...drawn), padV = Math.max(2, (dHi - dLo) * 0.12);
  let lo = Math.max(0, dLo - padV), hi = Math.min(100, dHi + padV);
  if (hi - lo < 20) { const mid = (lo + hi) / 2; lo = Math.max(0, Math.min(80, mid - 10)); hi = lo + 20; }
  const step = [5, 10, 20, 25].find((st) => (Math.ceil(hi / st) - Math.floor(lo / st)) <= 4) ?? 25;
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const ticks = []; for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * plotH;
  // A smooth line through the points that never overshoots them (monotone cubic, Fritsch–Carlson).
  const path = (d, from = 0) => {
    const p = d.slice(from).map((v, j) => [padL + ((j + from) / Math.max(1, d.length - 1)) * plotW, Y(v)]);
    if (p.length < 3) return p.map(([x, y], j) => (j ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ');
    const m = p.slice(1).map(([x, y], j) => (y - p[j][1]) / (x - p[j][0]));
    const t = p.map((_, j) => (j === 0 ? m[0] : j === p.length - 1 ? m[j - 1] : m[j - 1] * m[j] <= 0 ? 0 : (m[j - 1] + m[j]) / 2));
    m.forEach((mj, j) => {
      if (mj === 0) { t[j] = 0; t[j + 1] = 0; return; }
      const a = t[j] / mj, b = t[j + 1] / mj, q = a * a + b * b;
      if (q > 9) { const k = 3 / Math.sqrt(q); t[j] = k * a * mj; t[j + 1] = k * b * mj; }
    });
    let out = 'M' + p[0][0].toFixed(1) + ' ' + p[0][1].toFixed(1);
    for (let j = 0; j < p.length - 1; j++) {
      const h = (p[j + 1][0] - p[j][0]) / 3;
      out += ` C${(p[j][0] + h).toFixed(1)} ${(p[j][1] + t[j] * h).toFixed(1)} ${(p[j + 1][0] - h).toFixed(1)} ${(p[j + 1][1] - t[j + 1] * h).toFixed(1)} ${p[j + 1][0].toFixed(1)} ${p[j + 1][1].toFixed(1)}`;
    }
    return out;
  };
  const col = (s) => (s === 'b' ? 'var(--outcome-b)' : 'var(--outcome-a)');

  // One label group per outcome: its own label, then (REF on) one short violet line "POLYMARKET 55%" right under it.
  // The position shows which outcome a reference belongs to; groups keep a 12px gap so the pairs never touch.
  const LH = 16, GAP = 12;
  const groups = outcomes.map((o) => {
    const lines = (narrow ? [...wrap(o.label, '').filter(Boolean).map((t) => t.trim()), o.value + '%'] : wrap(o.label, o.value + '%')).map((t) => ({ t, c: col(o.side) }));
    if (ref && o.refValue !== undefined) lines.push({ t: `POLYMARKET ${o.refValue}%`, c: 'var(--ref)', ref: 1 });
    return { y: Y(o.value), lines };
  }).sort((p, q) => p.y - q.y);
  for (let i = 1; i < groups.length; i++) { const end = groups[i - 1].y + (groups[i - 1].lines.length - 1) * LH + LH + GAP; if (groups[i].y < end) groups[i].y = end; }
  // Inside the bottom edge, then the top one: a group moves only as far as it must, and a group next to it only if
  // it would then crowd it, so a label at 0% and one at 100% both stay whole and next to their lines.
  let limit = height - 14;
  for (let i = groups.length - 1; i >= 0; i--) { const end = groups[i].y + (groups[i].lines.length - 1) * LH; if (end > limit) groups[i].y -= end - limit; limit = groups[i].y - LH - GAP; }
  let top = padT + 4;
  for (const g of groups) { if (g.y < top) g.y = top; top = g.y + (g.lines.length - 1) * LH + LH + GAP; }

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
          {ticks.map((v) => (
            <g key={v}>
              <line x1={padL} x2={plotR} y1={Y(v)} y2={Y(v)} stroke="var(--line)" strokeDasharray={v === lo || v === hi || v === 50 ? 'none' : '2 4'} />
              <text x={w - 4} y={Y(v) + 5} textAnchor="end" className="bb-scope__axis">{v}%</text>
            </g>
          ))}
          {[1, 2, 3, 4, 5].map((i) => <line key={i} x1={padL + (plotW * i) / 6} x2={padL + (plotW * i) / 6} y1={padT} y2={height - padB} stroke="var(--line)" strokeDasharray="2 4" />)}
          {ref && outcomes.map((o) => o.refData && <path key={'r' + o.label} d={path(o.refData)} fill="none" stroke="var(--ref)" strokeWidth="1" strokeDasharray="5 4" />)}
          {outcomes.map((o) => {
            const n = o.data.length, tail = Math.floor(n * 0.62);
            return (
              <g key={o.label} style={{ color: col(o.side) }}>
                <path d={path(o.data.map((v, i) => v + Math.sin(i * 1.7) * 0.014 * (hi - lo)))} fill="none" stroke="currentColor" strokeWidth="1" opacity=".14" />
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
