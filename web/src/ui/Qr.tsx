// A real, scannable QR code drawn as pixels in the design's colours (the design system's QRCode
// is a decorative pattern; this one encodes the payload). Black on white for paper, phosphor on
// void on screen; both keep the quiet zone scanners need.

import qrcode from 'qrcode-generator';

export function Qr({ value, size = 220, paper = false, title }: { value: string; size?: number; paper?: boolean; title?: string }) {
  const q = qrcode(0, 'M');
  q.addData(value, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  const rects: string[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (q.isDark(y, x)) rects.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  const fg = paper ? '#111' : 'var(--phosphor-hi)';
  const bg = paper ? '#fff' : 'var(--void)';
  return (
    <svg viewBox={`0 0 ${total} ${total}`} width={size} height={size} shapeRendering="crispEdges" role="img" aria-label={title ?? 'QR code'} style={{ flex: 'none', display: 'block' }}>
      <rect width={total} height={total} fill={bg} />
      <path d={rects.join('')} fill={fg} />
    </svg>
  );
}
