// NOBODY PASS: the anonymity card. Every field is redacted, the photo is a random pixel face that
// changes on every save (two shared cards can't be linked), and the stamps are earned locally and
// kept in the vault. SAVE IMAGE draws the card onto a canvas here and saves a PNG; nothing is sent.

import { useRef, useState } from 'react';
import { KeyButton, NobodyPass, TeletextHeader } from '../../ds';
import { Win } from '../win';
import { app } from '../../app/services';
import { useStore } from '../../app/store';
import { height } from '../../app/format';
import { toHex } from '../../core/bytes';
import { play } from '../sound';

const SLOTS = ['FIRST SLIP', 'CALLED IT', 'PASSED IN THE DARK'];
const freshSeed = () => toHex(crypto.getRandomValues(new Uint8Array(8)));

async function svgImage(svg: SVGSVGElement, fill: string): Promise<HTMLImageElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.querySelectorAll('[fill^="var("]').forEach((n) => n.setAttribute('fill', fill));
  clone.querySelectorAll('g').forEach((n) => (n.getAttribute('fill')?.startsWith('var(') || !n.getAttribute('fill')) && n.setAttribute('fill', fill));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function drawPass(card: HTMLElement, stamps: string[], issued: string): Promise<Blob> {
  await Promise.all(['28px "VT323"', '13px "Departure Mono"', 'italic 15px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  const W = 460;
  const H = 300;
  const k = 2;
  const c = document.createElement('canvas');
  c.width = W * k;
  c.height = H * k;
  const g = c.getContext('2d')!;
  g.scale(k, k);
  const paper = '#EFE8D8';
  const ink = '#101410';
  g.fillStyle = paper;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(16,20,16,.2)';
  g.strokeRect(0.5, 0.5, W - 1, H - 1);
  g.fillStyle = ink;
  g.fillRect(0, 0, W, 38);
  g.fillStyle = paper;
  g.font = '28px "VT323"';
  g.textBaseline = 'alphabetic';
  g.fillText('NOBODY PASS', 16, 29);
  g.font = '11px "Departure Mono"';
  g.textAlign = 'right';
  g.fillText('BLINDBOOK · BOOTH ISSUE', W - 16, 27);
  g.textAlign = 'left';
  // Photo.
  g.strokeStyle = ink;
  g.lineWidth = 2;
  g.strokeRect(17, 55, 104, 124);
  const face = card.querySelector('.bb-pass__photo svg') as SVGSVGElement | null;
  if (face) g.drawImage(await svgImage(face, ink), 25, 62, 88, 88);
  g.fillStyle = ink;
  g.font = '10px "Departure Mono"';
  g.fillText('PHOTO: RANDOM', 30, 170);
  // Fields.
  const row = (y: number, label: string, value: string | null, bar?: number) => {
    g.font = '12px "Departure Mono"';
    g.fillStyle = ink;
    g.fillText(label, 140, y);
    if (value !== null) {
      g.textAlign = 'right';
      g.fillText(value, W - 16, y);
      g.textAlign = 'left';
    } else if (bar) {
      g.save();
      g.translate(W - 16 - bar, y - 12);
      g.rotate(-0.01);
      g.fillRect(0, 0, bar, 15);
      g.restore();
    }
    g.strokeStyle = 'rgba(16,20,16,.25)';
    g.lineWidth = 1;
    g.setLineDash([1, 3]);
    g.beginPath();
    g.moveTo(140 + g.measureText(label).width + 6, y - 3);
    g.lineTo(W - 16 - (value !== null ? g.measureText(value).width : bar ?? 0) - 6, y - 3);
    g.stroke();
    g.setLineDash([]);
  };
  row(72, 'NAME', null, 96);
  row(98, 'IP', null, 84);
  row(124, 'ACCOUNT', 'NONE');
  row(150, 'ISSUED BLK', issued);
  g.font = 'italic 15px "IBM Plex Mono"';
  g.fillText('the bearer of this card is nobody', 140, 178);
  // Stamp slots.
  const sw = (W - 32 - 20) / 3;
  SLOTS.forEach((s, i) => {
    const x = 16 + i * (sw + 10);
    const y = 206;
    const on = stamps.includes(s);
    g.strokeStyle = on ? 'rgba(16,20,16,.2)' : 'rgba(16,20,16,.4)';
    g.lineWidth = 2;
    g.setLineDash(on ? [] : [5, 4]);
    g.strokeRect(x, y, sw, 56);
    g.setLineDash([]);
    g.font = '11px "Departure Mono"';
    g.textAlign = 'center';
    if (on) {
      g.save();
      g.translate(x + sw / 2, y + 28);
      g.rotate(-0.1);
      const tw = g.measureText(s).width + 14;
      g.strokeStyle = ink;
      g.lineWidth = 3;
      g.strokeRect(-tw / 2, -11, tw, 22);
      g.globalAlpha = 0.9;
      g.fillStyle = ink;
      g.fillText(s, 0, 4);
      g.restore();
    } else {
      g.globalAlpha = 0.62;
      g.fillStyle = ink;
      g.fillText(s, x + sw / 2, y + 32);
      g.globalAlpha = 1;
    }
    g.textAlign = 'left';
  });
  g.font = '10px "Departure Mono"';
  g.fillStyle = 'rgba(16,20,16,.55)';
  g.fillText('THE PRICE IS PUBLIC. YOU ARE NOT.', 16, H - 14);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('canvas'))), 'image/png'));
}

export function PassPage({ onClose }: { onClose: () => void }) {
  const stamps = useStore(app, (s) => s.local.stamps ?? []);
  const head = useStore(app, (s) => s.head);
  const [seed, setSeed] = useState(freshSeed);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const issued = head ? height(head.height) : '—';
  const save = async () => {
    if (!ref.current) return;
    setSaving(true);
    try {
      const blob = await drawPass(ref.current, stamps, issued);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'nobody-pass.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
      play('stamp');
      // A new face for the next save, so two shared cards can't be linked.
      setSeed(freshSeed());
    } finally {
      setSaving(false);
    }
  };
  return (
    <Win title="NOBODY PASS" onClose={onClose} maxWidth={620} style={{ alignSelf: 'center', width: '100%' }}>
      <TeletextHeader page="P601" title="NOBODY PASS" />
      <div ref={ref} style={{ display: 'flex', justifyContent: 'center', margin: '16px 0', overflowX: 'auto' }}>
        <NobodyPass faceSeed={seed} stamps={stamps} issued={issued} />
      </div>
      <p className="bb-conditions">
        Stamps are earned on this device and kept in the vault: FIRST SLIP, CALLED IT (share a proof), PASSED IN THE DARK (take over a hand-off). The face is random and changes every time you save.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <KeyButton icon="eye" loading={saving} onClick={save} data-hint="Saves a PNG on this device. Nothing is sent.">SAVE IMAGE</KeyButton>
        <KeyButton variant="secondary" onClick={() => setSeed(freshSeed())}>NEW FACE</KeyButton>
      </div>
    </Win>
  );
}
