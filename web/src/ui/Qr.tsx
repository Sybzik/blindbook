// A real, scannable QR code drawn as pixels in the design's colours (the design system's QRCode
// is a decorative pattern; this one encodes the payload). Black on white for paper, phosphor on
// void on screen; both keep the quiet zone scanners need.

import qrcode from 'qrcode-generator';

/** `ecc` L packs long codes (slip codes) into fewer, larger modules; M for short links. */
export function Qr({ value, size = 220, paper = false, title, ecc = 'M' }: { value: string; size?: number; paper?: boolean; title?: string; ecc?: 'L' | 'M' }) {
  const q = qrcode(0, ecc);
  q.addData(value, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  // Whole device pixels per module: a grid stretched by a fraction draws modules 3 and 4 pixels
  // wide by turns, and a camera can't read a dense slip code like that off a screen.
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const side = (Math.max(1, Math.round((size * dpr) / total)) * total) / dpr;
  const rects: string[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (q.isDark(y, x)) rects.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  const fg = paper ? '#111' : 'var(--phosphor-hi)';
  const bg = paper ? '#fff' : 'var(--void)';
  return (
    <svg viewBox={`0 0 ${total} ${total}`} width={side} height={side} shapeRendering="crispEdges" role="img" aria-label={title ?? 'QR code'} style={{ flex: 'none', display: 'block' }}>
      <rect width={total} height={total} fill={bg} />
      <path d={rects.join('')} fill={fg} />
    </svg>
  );
}
