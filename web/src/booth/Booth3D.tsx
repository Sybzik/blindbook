// The 3D landing: the booth scene plus the page's real text on top (brand, mixnet lamp, block,
// keyboard-reachable buttons). Easter eggs open small cards; none of them fetches anything.

import { useEffect, useRef, useState } from 'react';
import { createBooth, type BoothAction, type BoothData, type BoothHandle } from './scene';
import { play } from '../ui/sound';
import { BoothChrome } from './chrome';

export interface EggFacts {
  block: number;
  shieldedActions: number | null;
  resolved: string | null;
}

const EGG = (a: BoothAction, f: EggFacts): { title: string; body: string } | null => {
  switch (a) {
    case 'zebra':
      return { title: 'ZEBRA', body: `The Zcash full node much of the network runs. Our chain tip: blk ${f.block.toLocaleString('en-US')}, read through public lightwalletd servers.` };
    case 'bonsai':
      return { title: 'IRONWOOD', body: f.shieldedActions === null ? 'Every top-up and every payout here stays in the shielded pool.' : `The last block carried ${f.shieldedActions} shielded actions. Every top-up and payout here stays shielded.` };
    case 'phone':
      return { title: 'THE ORACLE IS CALLING', body: `Results are read from Polymarket's ConditionalTokens contract on Polygon, at a finalized block, by two independent RPCs that must agree. ${f.resolved ?? 'No market has resolved yet.'}` };
    case 'note':
      return { title: 'password: hunter2', body: "we don't have passwords. or accounts. or you." };
    case 'mug':
      return { title: 'I ♥ ZK', body: 'zero-knowledge' };
    default:
      return null;
  }
};

export default function Booth3D({ data, facts, link, onEnter, onFail }: { data: BoothData; facts: EggFacts; link: string; onEnter: (to?: string) => void; onFail: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<BoothHandle | null>(null);
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null);
  const [egg, setEgg] = useState<{ title: string; body: string; x: number; y: number; mug: boolean } | null>(null);
  // The scene fades in from the page's own dark once its first frame is ready.
  const [ready, setReady] = useState(false);
  const eggEl = useRef<HTMLDivElement>(null);
  // A card can open under the finger that opened it: the click a phone sends after that tap must
  // not close it again.
  const openedAt = useRef(0);
  const close = () => {
    if (performance.now() - openedAt.current < 500) return;
    handle.current?.release();
    setEgg(null);
  };
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const enter = async (to?: string) => {
    play('click');
    if (handle.current && !to) await handle.current.enter();
    onEnter(to);
  };
  // On a phone or a short window the page's text stands over the scene: tell the scene the band
  // left between the text above and the keys below, measured from the page itself.
  const root = useRef<HTMLDivElement>(null);
  const fit = () => {
    const el = root.current;
    if (!el || !handle.current) return;
    const H = el.clientHeight;
    if (el.clientWidth >= H && H >= 520) return handle.current.inset(null);
    const r0 = el.getBoundingClientRect().top;
    const top = (el.querySelector('.ld-tl')?.getBoundingClientRect().bottom ?? r0) - r0;
    const lows = [...el.querySelectorAll('.bd-keys, .ld-tr')].map((x) => x.getBoundingClientRect().top - r0).filter((y) => y > H / 2);
    handle.current.inset({ top: top / H, bottom: (H - Math.min(H, ...lows)) / H });
  };
  useEffect(() => {
    const ro = new ResizeObserver(fit);
    if (root.current) ro.observe(root.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    let dead = false;
    createBooth(canvas.current!, data, {
      action: (a, x, y) => {
        if (a === 'enter') void enter();
        else if (a === 'how' || a === 'verify') onEnter(a);
        else {
          const e = EGG(a, factsRef.current);
          if (e) {
            play(a === 'phone' ? 'boot' : 'click');
            openedAt.current = performance.now();
            setEgg({ ...e, x, y, mug: a === 'mug' });
          }
        }
      },
      hover: (label, x, y) => setHover(label ? { label, x, y } : null),
      // The open card stays on its object while the camera moves (set here, not through state:
      // it changes every frame).
      anchor: (x, y, visible) => {
        const el = eggEl.current;
        if (!el) return;
        el.style.left = `${Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8))}px`;
        el.style.top = `${Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8))}px`;
        el.style.visibility = visible ? 'visible' : 'hidden';
      },
    })
      .then((h) => {
        if (dead) h.dispose();
        else {
          handle.current = h;
          fit();
          setReady(true);
        }
      })
      .catch(() => onFail());
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.target === document.body) void enter();
    };
    addEventListener('keydown', k);
    return () => {
      dead = true;
      removeEventListener('keydown', k);
      handle.current?.dispose();
      handle.current = null;
    };
  }, []);
  useEffect(() => {
    handle.current?.update(data);
  }, [data.block, data.markets, data.prices?.a, data.prices?.y, data.prices?.la]);
  return (
    <div ref={root} className="ld bd" onClick={(e) => e.target === e.currentTarget && close()}>
      <canvas ref={canvas} className={'bd-canvas' + (ready ? ' is-on' : '')} aria-hidden="true" />
      <BoothChrome block={data.block} link={link} onEnter={(to) => (to ? onEnter(to) : void enter())} hint={ready} />
      {hover && !egg && (
        <span className="bd-tip bb-label" style={{ left: hover.x + 14, top: hover.y + 14 }} aria-hidden="true">
          {hover.label}
        </span>
      )}
      {egg && (
        <div ref={eggEl} className="bd-egg" role="dialog" aria-label={egg.title} style={{ left: Math.min(egg.x, innerWidth - 300), top: Math.min(egg.y, innerHeight - 180) }} onClick={close}>
          <p className="bb-label bb-hi">{egg.title}</p>
          {egg.mug ? <p className="bd-steam bb-display-sm bb-glow bb-hi">{egg.body}</p> : <p className="bb-ui">{egg.body}</p>}
        </div>
      )}
    </div>
  );
}
