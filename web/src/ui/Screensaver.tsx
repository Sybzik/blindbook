// After two idle minutes: redaction bars fly across the dark (an After Dark nod). A bar that hits
// a corner exactly bursts into a confetti of zeros. Any key, click or touch wakes the desk.

import { useEffect, useRef } from 'react';

interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
}
interface Zero {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export function Screensaver({ onWake, still = false }: { onWake: () => void; still?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const g = c.getContext('2d')!;
    const fit = () => {
      c.width = innerWidth * devicePixelRatio;
      c.height = innerHeight * devicePixelRatio;
      g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    };
    fit();
    addEventListener('resize', fit);
    const css = getComputedStyle(document.documentElement);
    const bar = css.getPropertyValue('--redact-screen').trim() || '#2F6E4A';
    const hi = css.getPropertyValue('--phosphor-hi').trim() || '#C6FFDD';
    const bars: Bar[] = Array.from({ length: 9 }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      w: 60 + Math.random() * 140,
      h: 14 + Math.random() * 10,
      vx: (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 1.4),
      vy: (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 1.1),
    }));
    let zeros: Zero[] = [];
    let raf = 0;
    const frame = () => {
      const W = innerWidth;
      const H = innerHeight;
      g.fillStyle = 'rgba(1,3,2,0.35)';
      g.fillRect(0, 0, W, H);
      for (const b of bars) {
        if (!still) {
          b.x += b.vx;
          b.y += b.vy;
        }
        let hx = false;
        let hy = false;
        if (b.x < 0 || b.x + b.w > W) {
          b.vx = -b.vx;
          b.x = Math.max(0, Math.min(W - b.w, b.x));
          hx = true;
        }
        if (b.y < 0 || b.y + b.h > H) {
          b.vy = -b.vy;
          b.y = Math.max(0, Math.min(H - b.h, b.y));
          hy = true;
        }
        if (hx && hy) {
          const cx = b.x < W / 2 ? 0 : W;
          const cy = b.y < H / 2 ? 0 : H;
          for (let i = 0; i < 40; i++) zeros.push({ x: cx, y: cy, vx: (Math.random() * 6 - 3) * (cx ? -1 : 1), vy: (Math.random() * 6 - 3) * (cy ? -1 : 1), life: 90 });
        }
        g.fillStyle = bar;
        g.fillRect(b.x, b.y, b.w, b.h);
      }
      g.fillStyle = hi;
      g.font = '16px "Departure Mono", monospace';
      zeros = zeros.filter((z) => z.life-- > 0);
      for (const z of zeros) {
        z.x += z.vx;
        z.y += z.vy;
        z.vy += 0.05;
        g.globalAlpha = z.life / 90;
        g.fillText('0', z.x, z.y);
      }
      g.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    frame();
    const wake = () => onWake();
    const t = setTimeout(() => {
      addEventListener('pointerdown', wake);
      addEventListener('keydown', wake);
      addEventListener('pointermove', wake);
    }, 400);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
      removeEventListener('resize', fit);
      removeEventListener('pointerdown', wake);
      removeEventListener('keydown', wake);
      removeEventListener('pointermove', wake);
    };
  }, []);
  return (
    <div className="tk-saver" aria-hidden="true">
      <canvas ref={ref} />
      <p className="bb-label">NOTHING TO SEE HERE · ANY KEY</p>
    </div>
  );
}
