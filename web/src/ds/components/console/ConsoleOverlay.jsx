import React, { useState, useRef, useEffect } from 'react';

export const CONSOLE_RESPONSES = {
  help: ['markets · open 201 · buy 201 yes 0.01 --max 0.65 · slips · verify · status', 'verbose on · play snake · calc 0.45 · radio on · whoami · history · exit'],
  whoami: ['nobody'],
  history: ["no history. we don't keep any."],
  'ls /users': ['ls: /users: there are no users'],
  'cat /etc/identity': ['████████████████████████'],
  'sudo reveal': ['permission denied. nobody has root over you.'],
  status: ['mixnet ● linked · 3 hops · cover on', 'batch 8812 · blk 3,514,220'],
  outis: ['"Nobody is my name." (Homer, Odyssey)'],
  matrix: ['wrong movie.'],
  exit: ["you can't leave a place you never entered."],
};

/* Console overlay: "> " prompt, block cursor, output lines. Never required — everything has a button. */
export function ConsoleOverlay({ open = true, onClose, initialLines, onCommand, height = 300, title = 'CONSOLE · type help · esc closes', className = '', style }) {
  const [lines, setLines] = useState(initialLines || [{ t: 'sys', s: 'BLINDBOOK v1 · console ready · nothing typed here is stored' }]);
  const [val, setVal] = useState('');
  const inp = useRef(null), out = useRef(null);
  useEffect(() => { if (open && inp.current) inp.current.focus({ preventScroll: true }); }, [open]);
  useEffect(() => { if (out.current) out.current.scrollTop = out.current.scrollHeight; }, [lines]);
  if (!open) return null;
  const run = (e) => {
    e.preventDefault();
    const cmd = val.trim(); if (!cmd) return;
    let res = onCommand ? onCommand(cmd) : undefined;
    if (res === undefined) res = cmd === 'clear' ? null : CONSOLE_RESPONSES[cmd] || [`${cmd.split(' ')[0]}: unknown command. type help`];
    setLines((l) => (res === null ? [] : [...l, { t: 'in', s: cmd }, ...[].concat(res).map((s) => ({ t: CONSOLE_RESPONSES[cmd] ? 'out' : 'err', s }))]));
    setVal('');
    if (cmd === 'exit' && onClose) setTimeout(onClose, 900);
  };
  return (
    <div className={'bb-console ' + className} style={{ height, ...style }} role="dialog" aria-label="Console" onKeyDown={(e) => e.key === 'Escape' && onClose && onClose()}>
      <div className="bb-window__bar"><span className="bb-window__title">{title}</span>{onClose && <button type="button" className="bb-window__close" aria-label="Close console" onClick={onClose}>×</button>}</div>
      <div className="bb-console__out" ref={out} aria-live="polite">
        {lines.map((l, i) => <p key={i} className={'bb-console__line is-' + l.t}>{l.t === 'in' ? '> ' + l.s : l.s}</p>)}
      </div>
      <form className="bb-console__in" onSubmit={run} onClick={() => inp.current && inp.current.focus()}>
        <span className="bb-console__prompt" aria-hidden="true">&gt;&nbsp;</span>
        <span className="bb-console__wrap">
          <input ref={inp} value={val} onChange={(e) => setVal(e.target.value)} aria-label="Command" spellCheck="false" autoComplete="off" />
          <span className="bb-cursor bb-console__cursor" style={{ left: val.length + 'ch' }} aria-hidden="true" />
        </span>
      </form>
    </div>
  );
}
