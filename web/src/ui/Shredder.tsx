// ADDRESS SHREDDED: the withdrawal address, once sealed to the signer, goes through a shredder
// on screen and is gone from this page too. What it shows is literal: nothing here keeps it.

import { useEffect, useState } from 'react';
import { play } from './sound';

const STRIPS = 14;

export function Shredder({ text, onDone }: { text: string; onDone?: () => void }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    play('print');
    const t = setTimeout(() => {
      setGone(true);
      onDone?.();
    }, 1_600);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="tk-shred" role="status" aria-label="Address shredded">
      <div className="tk-shred__slot" aria-hidden="true" />
      {!gone && (
        <div className="tk-shred__paper" aria-hidden="true">
          {Array.from({ length: STRIPS }, (_, i) => (
            <span
              key={i}
              className="tk-shred__strip"
              style={{ clipPath: `inset(0 ${100 - ((i + 1) * 100) / STRIPS}% 0 ${(i * 100) / STRIPS}%)`, animationDelay: `${700 + (i % 5) * 40}ms`, ['--dx' as string]: `${(i - STRIPS / 2) * 3}px` }}
            >
              {text}
            </span>
          ))}
        </div>
      )}
      <p className="bb-display-sm bb-glow bb-hi tk-shred__label">ADDRESS SHREDDED</p>
    </div>
  );
}
