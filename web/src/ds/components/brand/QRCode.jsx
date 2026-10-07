import React from 'react';
import { ICONS, bitmapRects } from './PixelIcon.jsx';

function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* Pixel-styled QR with the eye in the center. Visual stand-in: wire a real encoder in code. */
export function QRCode({ seed = 'blindbook', size = 128, fg = 'var(--ink)', bg = 'transparent', eye = true, title = 'QR code', style }) {
  const N = 25, r = rng(seed), cells = [];
  const inFinder = (x, y) => (x < 8 && y < 8) || (x > N - 9 && y < 8) || (x < 8 && y > N - 9);
  const inEye = (x, y) => eye && x >= 9 && x <= 15 && y >= 9 && y <= 15;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (inFinder(x, y) || inEye(x, y)) continue;
    const timing = (y === 6 || x === 6) ? (x + y) % 2 === 0 : r() > 0.52;
    if (timing) cells.push(<rect key={x + '-' + y} x={x} y={y} width="1" height="1" />);
  }
  const finder = (ox, oy) => (
    <g key={ox + '' + oy}>
      <rect x={ox} y={oy} width="7" height="7" />
      <rect x={ox + 1} y={oy + 1} width="5" height="5" fill={bg === 'transparent' ? 'var(--qr-bg, var(--paper))' : bg} />
      <rect x={ox + 2} y={oy + 2} width="3" height="3" />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox={`-1 -1 ${N + 2} ${N + 2}`} shapeRendering="crispEdges" role="img" aria-label={title}
      style={{ display: 'block', background: bg, flex: 'none', ...style }}>
      <g fill={fg}>
        {cells}
        {finder(0, 0)}{finder(N - 7, 0)}{finder(0, N - 7)}
        {eye && <g transform="translate(9 9)">{bitmapRects(ICONS.eye)}<rect x="-0.5" y="3" width="8" height="1" fill="var(--redact)" /></g>}
      </g>
    </svg>
  );
}

/* Random symmetric 8x8 pixel face — a new one each time, so two shared cards can't be linked. */
export function PixelFace({ seed = 'nobody', size = 96, fg = 'var(--ink)', bg = 'transparent', title = 'random pixel face', style }) {
  const r = rng(seed), rows = [];
  for (let y = 0; y < 8; y++) {
    const half = [];
    for (let x = 0; x < 4; x++) {
      let on = r() > 0.5;
      if (y === 0 || y === 7) on = x > 0 && r() > 0.3;
      if (x === 0 && (y < 2 || y > 5)) on = false;
      if (y === 3 && x === 2) on = false; if (y === 3 && x === 1) on = true;
      if (y === 5) on = x >= 2 ? r() > 0.25 : on;
      half.push(on ? '#' : '.');
    }
    rows.push(half.join('') + half.slice().reverse().join(''));
  }
  return (
    <svg width={size} height={size} viewBox="-1 -1 10 10" shapeRendering="crispEdges" role="img" aria-label={title}
      style={{ display: 'block', background: bg, flex: 'none', ...style }}>
      <g fill={fg}>{bitmapRects(rows)}</g>
    </svg>
  );
}
