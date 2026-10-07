// The 3D landing: the booth scene plus the page's real text on top (brand, mixnet lamp, block,
// keyboard-reachable buttons). Easter eggs open small cards; none of them fetches anything.

import { useEffect, useRef, useState } from 'react';
import { Logo, MixnetLamp, Wordmark } from '../ds';
import { createBooth, type BoothAction, type BoothData, type BoothHandle } from './scene';
import { play } from '../ui/sound';

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
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const enter = async (to?: string) => {
    play('click');
    if (handle.current && !to) await handle.current.enter();
    onEnter(to);
  };
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
            setEgg({ ...e, x, y, mug: a === 'mug' });
          }
        }
      },
      hover: (label, x, y) => setHover(label ? { label, x, y } : null),
    })
      .then((h) => {
        if (dead) h.dispose();
        else handle.current = h;
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
    <div className="ld bd" onClick={(e) => e.target === e.currentTarget && setEgg(null)}>
      <canvas ref={canvas} className="bd-canvas" aria-hidden="true" />
      <header className="ld-tl">
        <div className="ld-brand">
          <Logo size={28} />
          <Wordmark height={14} />
        </div>
        <p className="bb-label bb-hi">THE PRICE IS PUBLIC. YOU ARE NOT.</p>
        <p className="bb-label">A PRIVATE PREDICTION MARKET ON ZCASH</p>
      </header>
      <div className="ld-tr">
        <MixnetLamp state={link as 'linked'} />
        <span>· BLK {data.block.toLocaleString('en-US')}</span>
      </div>
      <nav className="bd-keys" aria-label="Booth">
        <button type="button" onClick={() => void enter()}>STEP INSIDE · ENTER</button>
        <button type="button" onClick={() => onEnter('how')}>HOW IT WORKS</button>
        <button type="button" onClick={() => onEnter('verify')}>VERIFY</button>
      </nav>
      <p className="bd-hint bb-label" aria-hidden="true">DRAG TO LOOK AROUND · CLICK THE CURTAIN</p>
      {hover && !egg && (
        <span className="bd-tip bb-label" style={{ left: hover.x + 14, top: hover.y + 14 }} aria-hidden="true">
          {hover.label}
        </span>
      )}
      {egg && (
        <div className="bd-egg" role="dialog" aria-label={egg.title} style={{ left: Math.min(egg.x, innerWidth - 300), top: Math.min(egg.y, innerHeight - 180) }} onClick={() => setEgg(null)}>
          <p className="bb-label bb-hi">{egg.title}</p>
          {egg.mug ? <p className="bd-steam bb-display-sm bb-glow bb-hi">{egg.body}</p> : <p className="bb-ui">{egg.body}</p>}
        </div>
      )}
    </div>
  );
}
