// Paper cards drawn onto a canvas, so SAVE IMAGE makes a PNG right here (nothing uploaded).

import qrcode from 'qrcode-generator';

const PAPER = '#EFE8D8';
const INK = '#101410';

export async function fonts() {
  await Promise.all(['28px "VT323"', '13px "Departure Mono"', 'italic 15px "IBM Plex Mono"', '15px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
}

export function drawQr(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number) {
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const cell = size / (n + 8);
  g.fillStyle = '#fff';
  g.fillRect(x, y, size, size);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect(x + (c + 4) * cell, y + (r + 4) * cell, Math.ceil(cell), Math.ceil(cell));
}

function leader(g: CanvasRenderingContext2D, x: number, w: number, y: number, label: string, value: string) {
  g.font = '12px "Departure Mono"';
  g.fillStyle = INK;
  g.textAlign = 'left';
  g.fillText(label, x, y);
  g.textAlign = 'right';
  g.fillText(value, x + w, y);
  g.textAlign = 'left';
  g.strokeStyle = 'rgba(16,20,16,.3)';
  g.setLineDash([1, 3]);
  g.beginPath();
  g.moveTo(x + g.measureText(label).width + 6, y - 3);
  g.lineTo(x + w - g.measureText(value).width - 6, y - 3);
  g.stroke();
  g.setLineDash([]);
}

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, lh: number): number {
  const words = text.split(' ');
  let line = '';
  for (const word of words) {
    const t = line ? line + ' ' + word : word;
    if (g.measureText(t).width > w && line) {
      g.fillText(line, x, y);
      y += lh;
      line = word;
    } else line = t;
  }
  if (line) g.fillText(line, x, y);
  return y + lh;
}

export function toPng(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('canvas'))), 'image/png'));
}

export function savePng(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
}

/** The CALLED IT receipt card with the proof QR. */
export async function drawCalledIt(o: { market: string; outcome: string; price: string; block: string; date: string; link: string }): Promise<Blob> {
  await fonts();
  const W = 340;
  const H = 520;
  const k = 2;
  const c = document.createElement('canvas');
  c.width = W * k;
  c.height = H * k;
  const g = c.getContext('2d')!;
  g.scale(k, k);
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);
  g.fillStyle = INK;
  g.font = '22px "VT323"';
  g.fillText('BLINDBOOK', 20, 36);
  g.font = '11px "Departure Mono"';
  g.textAlign = 'right';
  g.fillText('RECEIPT CARD', W - 20, 34);
  g.textAlign = 'left';
  g.fillRect(20, 46, W - 40, 2);
  // The stamp.
  g.save();
  g.translate(W / 2 - 10, 92);
  g.rotate(-0.12);
  g.strokeStyle = INK;
  g.lineWidth = 3;
  g.strokeRect(-92, -26, 184, 50);
  g.lineWidth = 1;
  g.strokeRect(-87, -21, 174, 40);
  g.font = '40px "VT323"';
  g.textAlign = 'center';
  g.fillText('CALLED IT', 0, 12);
  g.restore();
  g.font = '15px "IBM Plex Mono"';
  g.fillStyle = INK;
  let y = wrap(g, o.market, 20, 152, W - 40, 20);
  y += 6;
  leader(g, 20, W - 40, y, 'CALLED BY', '');
  g.fillRect(W - 20 - 70, y - 12, 70, 15);
  y += 26;
  leader(g, 20, W - 40, y, 'OUTCOME', o.outcome);
  y += 26;
  leader(g, 20, W - 40, y, 'PRICE', o.price);
  y += 26;
  leader(g, 20, W - 40, y, 'BLOCK', o.block);
  y += 26;
  leader(g, 20, W - 40, y, 'DATE', o.date);
  y += 18;
  g.strokeStyle = 'rgba(16,20,16,.4)';
  g.setLineDash([6, 4]);
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(20, y);
  g.lineTo(W - 20, y);
  g.stroke();
  g.setLineDash([]);
  drawQr(g, o.link, 20, y + 14, 120);
  g.font = '12px "Departure Mono"';
  g.fillStyle = INK;
  wrap(g, 'Scan to verify. The proof shows this call happened, and nothing else about you.', 152, y + 34, W - 172, 16);
  return toPng(c);
}
