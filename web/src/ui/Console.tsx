// The console: "> " prompt, block cursor, output lines. Real commands (trade, verify, status,
// verbose crypto trace) run through the same actions as the buttons; nothing typed is stored.

import { useEffect, useRef, useState } from 'react';
import { play } from './sound';
import { onTrace } from '../core/trace';
import { useStore } from '../app/store';
import { ui } from './uistate';

export type LineKind = 'in' | 'out' | 'err' | 'sys' | 'trace';
export interface Line {
  t: LineKind;
  s: string;
}
export type Out = (s: string | string[], t?: LineKind) => void;

export function Console({ onClose, run, height = 300 }: { onClose: () => void; run: (cmd: string, out: Out) => void | Promise<void>; height?: number }) {
  const [lines, setLines] = useState<Line[]>([{ t: 'sys', s: 'BLINDBOOK v1 · console ready · nothing typed here is stored · type help' }]);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const verbose = useStore(ui, (s) => s.verbose);
  const inp = useRef<HTMLInputElement>(null);
  const outRef = useRef<HTMLDivElement>(null);
  useEffect(() => inp.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [lines]);
  const out: Out = (s, t = 'out') => setLines((l) => [...l, ...[s].flat().map((x) => ({ t, s: x }))].slice(-400));
  useEffect(() => (verbose ? onTrace((s) => out(s, 'trace')) : undefined), [verbose]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = val.trim();
    if (!cmd || busy) return;
    setVal('');
    if (cmd === 'clear') {
      setLines([]);
      return;
    }
    out(cmd, 'in');
    setBusy(true);
    try {
      await run(cmd, out);
    } catch (err) {
      out(String((err as Error)?.message ?? err), 'err');
    } finally {
      setBusy(false);
      inp.current?.focus({ preventScroll: true });
    }
  };
  return (
    <div className="bb-console" style={{ height }} role="dialog" aria-label="Console" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="bb-window__bar">
        <span className="bb-window__title">CONSOLE · type help · esc closes{verbose ? ' · VERBOSE' : ''}</span>
        <button type="button" className="bb-window__close" aria-label="Close console" onClick={onClose}>×</button>
      </div>
      <div className="bb-console__out" ref={outRef} aria-live="polite">
        {lines.map((l, i) => (
          <p key={i} className={'bb-console__line is-' + l.t}>
            {l.t === 'in' ? '> ' + l.s : l.s}
          </p>
        ))}
        {busy && <p className="bb-console__line is-sys">…</p>}
      </div>
      <form className="bb-console__in" onSubmit={submit} onClick={() => inp.current?.focus()}>
        <span className="bb-console__prompt" aria-hidden="true">&gt;&nbsp;</span>
        <span className="bb-console__wrap">
          <input ref={inp} value={val} onChange={(e) => { setVal(e.target.value); play('type'); }} aria-label="Command" spellCheck={false} autoComplete="off" autoCapitalize="off" />
          <span className="bb-cursor bb-console__cursor" style={{ left: val.length + 'ch' }} aria-hidden="true" />
        </span>
      </form>
    </div>
  );
}
