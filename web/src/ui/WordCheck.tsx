// Confirm the 12 words by "stamping": three random positions, pick the right word for each.
// Also the later backup: an unlocked vault shows its words again, then the same check.

import { useMemo, useState } from 'react';
import { KeyButton, Stamp } from '../ds';
import { play } from './sound';

function pick<T>(xs: T[], n: number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

export function WordList({ words }: { words: string }) {
  return (
    <ol className="tk-words">
      {words.split(' ').map((w, i) => (
        <li key={i} className="bb-ui">
          <span className="bb-dim">{String(i + 1).padStart(2, '0')}</span> {w}
        </li>
      ))}
    </ol>
  );
}

export function WordCheck({ words, onDone, onLater }: { words: string; onDone: () => void; onLater?: () => void }) {
  const list = words.split(' ');
  const rounds = useMemo(
    () =>
      pick([...list.keys()], 3)
        .sort((a, b) => a - b)
        .map((i) => ({ i, options: pick([list[i]!, ...pick(list.filter((_, j) => j !== i), 3)], 4) })),
    [words],
  );
  const [k, setK] = useState(0);
  const [miss, setMiss] = useState<string | null>(null);
  const r = rounds[k];
  const choose = (w: string) => {
    if (!r) return;
    if (w !== list[r.i]) {
      play('error');
      setMiss(`Not word ${r.i + 1}. Check your paper.`);
      return;
    }
    play('stamp');
    setMiss(null);
    if (k + 1 >= rounds.length) setTimeout(onDone, 450);
    setK(k + 1);
  };
  return (
    <div className="col" style={{ gap: 14 }}>
      <p className="bb-text" style={{ margin: 0 }}>Stamp the right word for each number, from your paper.</p>
      <div className="row" style={{ gap: 12 }}>
        {rounds.map((x, j) => (
          <span key={x.i} className="tk-stampslot">
            {j < k ? (
              <Stamp size="sm" tone="phosphor" rotate={-6} worn={false} slam>{`${String(x.i + 1).padStart(2, '0')} ✓`}</Stamp>
            ) : (
              <span className="bb-label">WORD {String(x.i + 1).padStart(2, '0')}</span>
            )}
          </span>
        ))}
      </div>
      {r && (
        <>
          <p className="bb-label bb-hi" style={{ margin: 0 }}>WORD {String(r.i + 1).padStart(2, '0')} IS…</p>
          <div className="tk-wordpick">
            {r.options.map((w) => (
              <KeyButton key={w} variant="secondary" onClick={() => choose(w)}>{w}</KeyButton>
            ))}
          </div>
        </>
      )}
      {miss && <p className="bb-conditions" style={{ color: 'var(--alarm)' }} role="status">{miss}</p>}
      {onLater && (
        <p className="bb-ui bb-dim" style={{ margin: 0 }}>
          <button type="button" className="bb-link" onClick={onLater}>later (testnet only): back up before you use real money</button>
        </p>
      )}
    </div>
  );
}
