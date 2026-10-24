// The back room (P701–P705). Every app runs locally and makes no network request; BLOCK RADIO
// only plays the public data the desk already polls. Scores and notes live in the vault.

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { APP_ICONS, AmountSlider, KeyButton, LeaderRow, PixelIcon } from '../../ds';
import { Win, OpenVault } from '../win';
import { app, setLocal } from '../../app/services';
import { useStore } from '../../app/store';
import { COIN } from '../../app/config';
import { height } from '../../app/format';
import { fromHex } from '../../core/bytes';
import { ui } from '../uistate';
import { audio, play, setSound } from '../sound';

function useBest(game: string): [number, (n: number) => void] {
  const best = useStore(app, (s) => s.local.best?.[game] ?? 0);
  const vault = useStore(app, (s) => s.vault);
  const [mem, setMem] = useState(0);
  const value = vault === 'unlocked' ? best : mem;
  const set = (n: number) => {
    if (n <= value) return;
    setMem(n);
    if (vault === 'unlocked') void setLocal({ best: { ...app.get().local.best, [game]: n } });
  };
  return [value, set];
}

/* ── P701 NULLIFIER SNAKE ─────────────────────────────────────────────────────────────── */

const SN_W = 24;
const SN_H = 14;
type Cell = [number, number];
interface Snake {
  snake: Cell[];
  next: Cell;
  dir: Cell;
  food: Cell;
  score: number;
  over: null | 'self' | 'wall';
  running: boolean;
}
const snInit = (): Snake => ({ snake: [[6, 7], [5, 7], [4, 7]], next: [1, 0], dir: [1, 0], food: [16, 7], score: 0, over: null, running: false });
function snStep(s: Snake): Snake {
  const d = s.next;
  const [hx, hy] = s.snake[0]!;
  const h: Cell = [hx + d[0], hy + d[1]];
  if (h[0] < 0 || h[1] < 0 || h[0] >= SN_W || h[1] >= SN_H) return { ...s, over: 'wall', running: false };
  const eat = h[0] === s.food[0] && h[1] === s.food[1];
  const body = eat ? s.snake : s.snake.slice(0, -1);
  if (body.some(([x, y]) => x === h[0] && y === h[1])) return { ...s, over: 'self', running: false };
  const snake = [h, ...body];
  let food = s.food;
  if (eat) {
    do food = [Math.floor(Math.random() * SN_W), Math.floor(Math.random() * SN_H)];
    while (snake.some(([x, y]) => x === food[0] && y === food[1]));
  }
  return { ...s, snake, dir: d, food, score: s.score + (eat ? 1 : 0) };
}

function NullifierSnake({ active }: { active: boolean }) {
  const [g, setG] = useState(snInit);
  const [best, setBest] = useBest('snake');
  const turn = (m: Cell) =>
    setG((s) => {
      if (s.over) return s;
      const [dx, dy] = s.dir;
      if (m[0] === -dx && m[1] === -dy) return { ...s, running: true };
      return { ...s, next: m, running: true };
    });
  const restart = () => setG({ ...snInit(), running: true });
  // On a touch screen: swipe on the board (each 20px of a drag turns once), or the cross below it.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onDown = (e: RPointerEvent) => {
    if (e.pointerType === 'mouse') return;
    swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onMove = (e: RPointerEvent) => {
    const s0 = swipe.current;
    if (!s0) return;
    const dx = e.clientX - s0.x, dy = e.clientY - s0.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
    turn(Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)]);
    swipe.current = { x: e.clientX, y: e.clientY };
  };
  const press = (m: Cell) => (e: RPointerEvent) => {
    e.preventDefault();
    turn(m);
  };
  useEffect(() => {
    if (!active) return;
    // By the key's place, not its letter: WASD works on any layout, with Caps Lock or Shift.
    const map: Record<string, Cell> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0] };
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input,textarea')) return;
      const m = map[e.code];
      if (m) {
        e.preventDefault();
        turn(m);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [active]);
  useEffect(() => {
    if (!g.running || g.over || !active) return;
    const t = setInterval(() => setG(snStep), 115);
    return () => clearInterval(t);
  }, [g.running, g.over, active]);
  useEffect(() => {
    if (g.over) {
      setBest(g.score);
      play('error');
    }
  }, [g.over]);
  const prevScore = useRef(0);
  useEffect(() => {
    if (g.score > prevScore.current) play('click');
    prevScore.current = g.score;
  }, [g.score]);
  return (
    <div className="tk-snake">
      <div className={'tk-snake__board' + (g.running ? ' is-running' : '')} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (swipe.current = null)} onPointerCancel={() => (swipe.current = null)}>
        <svg viewBox={`0 0 ${SN_W} ${SN_H}`} shapeRendering="crispEdges" role="img" aria-label={`Snake, ${g.snake.length} long, ${g.score} notes`}>
          <rect x={g.food[0] + 0.2} y={g.food[1] + 0.2} width="0.6" height="0.6" fill="var(--phosphor-hi)" />
          {g.snake.map(([x, y], i) => (
            <rect key={i} x={x + 0.08} y={y + 0.08} width="0.84" height="0.84" fill={i ? 'var(--phosphor)' : 'var(--phosphor-hi)'} />
          ))}
        </svg>
        {(!g.running || g.over) && (
          <div className="tk-snake__over">
            {g.over === 'self' && (
              <>
                <p className="bb-display-md bb-glow bb-hi">NULLIFIER ALREADY SPENT</p>
                <p className="bb-ui">You crossed your own trail: double-spend rejected.</p>
              </>
            )}
            {g.over === 'wall' && (
              <>
                <p className="bb-display-md bb-glow bb-hi">OUT OF THE POOL</p>
                <p className="bb-ui">You left the shielded pool.</p>
              </>
            )}
            {!g.over && (
              <>
                <p className="bb-display-md bb-glow bb-hi">NULLIFIER SNAKE</p>
                <p className="bb-ui">Arrow keys, WASD or the pad. Eat notes, never cross your own trail.</p>
              </>
            )}
            <KeyButton onClick={restart}>{g.over ? 'PLAY AGAIN' : 'START'}</KeyButton>
          </div>
        )}
      </div>
      <div className="tk-snake__bar bb-label">
        <span>NOTES <span className="bb-hi">{g.score}</span></span>
        <span>BEST <span className="bb-hi">{best}</span></span>
        <span>LENGTH <span className="bb-hi">{g.snake.length}</span></span>
      </div>
      <div className="tk-pad" role="group" aria-label="Direction pad">
        <button type="button" aria-label="Up" onPointerDown={press([0, -1])} onClick={() => turn([0, -1])}><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1 9.5 9h-9z" /></svg></button>
        <button type="button" aria-label="Left" onPointerDown={press([-1, 0])} onClick={() => turn([-1, 0])}><svg viewBox="0 0 10 10" aria-hidden="true" style={{ transform: 'rotate(270deg)' }}><path d="M5 1 9.5 9h-9z" /></svg></button>
        <button type="button" aria-label="Down" onPointerDown={press([0, 1])} onClick={() => turn([0, 1])}><svg viewBox="0 0 10 10" aria-hidden="true" style={{ transform: 'rotate(180deg)' }}><path d="M5 1 9.5 9h-9z" /></svg></button>
        <button type="button" aria-label="Right" onPointerDown={press([1, 0])} onClick={() => turn([1, 0])}><svg viewBox="0 0 10 10" aria-hidden="true" style={{ transform: 'rotate(90deg)' }}><path d="M5 1 9.5 9h-9z" /></svg></button>
      </div>
    </div>
  );
}

/* ── P702 ODDS CALC ───────────────────────────────────────────────────────────────────── */

export function OddsCalc({ initial = 0.45, onUse }: { initial?: number; onUse?: () => void }) {
  const [p, setP] = useState(initial);
  const [mine, setMine] = useState(Math.min(0.99, initial + 0.1));
  const v = Math.min(0.99, Math.max(0.01, Number(p) || 0.45));
  const q = Math.min(0.99, Math.max(0.01, Number(mine) || v));
  const american = v >= 0.5 ? '-' + Math.round((v / (1 - v)) * 100) : '+' + Math.round(((1 - v) / v) * 100);
  const kelly = (q - v) / (1 - v);
  const use = () => {
    ui.set({ prefill: { maxCents: Math.round(v * 100) } });
    onUse?.();
  };
  return (
    <div className="tk-app-body">
      <p className="bb-ui bb-dim" style={{ margin: 0 }}>
        A price is the chance the market gives an outcome: 45¢ means 45%. Here it is in bookmaker odds, the payout after the 1% fee, and, if your own estimate is higher, how much of your balance a bet at that price is worth.
      </p>
      <AmountSlider value={p} min={0.01} max={0.99} step={0.01} decimals={2} unit="¢/100" label="PRICE" onChange={(x: string) => setP(Number(x))} />
      <div className="tk-calc">
        <LeaderRow label="CHANCE" value={Math.round(v * 100) + '%'} />
        <LeaderRow label="DECIMAL ODDS" value={(1 / v).toFixed(2)} />
        <LeaderRow label={`PAYS PER 0.01 ${COIN}`} value={((0.01 / v) * 0.99).toFixed(4)} />
        <LeaderRow label="AMERICAN ODDS" value={american} />
      </div>
      <AmountSlider value={mine} min={0.01} max={0.99} step={0.01} decimals={2} unit="" label="YOUR OWN ESTIMATE" onChange={(x: string) => setMine(Number(x))} />
      <LeaderRow
        label="HALF-KELLY"
        value={kelly > 0 ? `at most ${Math.round(kelly * 50)}% of your balance` : 'no edge at this price: skip it'}
        tone={kelly > 0 ? 'hi' : 'dim'}
      />
      <div className="row" style={{ gap: 8 }}>
        <KeyButton size="sm" onClick={use} data-hint="Sets this price as the most you'll pay in the next bet panel you open.">
          USE IN BET · MAX {Math.round(v * 100)}¢
        </KeyButton>
      </div>
    </div>
  );
}

/* ── P703 REDACT-A-TRACKER ────────────────────────────────────────────────────────────── */

const SPRITES: Record<string, string[]> = {
  cookie: ['..###..', '.##.##.', '#######', '##.####', '####.##', '.##.##.', '..###..'],
  fingerprint: ['.#####.', '#.....#', '#.###.#', '#.#.#.#', '#.#.#.#', '..#.#.#', '.##.#..'],
  pixel: ['.......', '.......', '.......', '...#...', '.......', '.......', '.......'],
  beacon: ['...#...', '.#.#.#.', '..###..', '###.###', '..###..', '.#.#.#.', '...#...'],
};
const KINDS = ['cookie', 'fingerprint', 'pixel', 'beacon', 'eye'] as const;
const LABEL: Record<(typeof KINDS)[number], string> = { cookie: 'COOKIE', fingerprint: 'FINGERPRINT', pixel: '1×1 PIXEL', beacon: 'BEACON', eye: 'WATCHER' };

function Sprite({ kind }: { kind: (typeof KINDS)[number] }) {
  if (kind === 'eye') return <PixelIcon name="eye" size={42} />;
  const rows = SPRITES[kind]!;
  return (
    <svg viewBox="0 0 7 7" width={42} height={42} shapeRendering="crispEdges" aria-hidden="true">
      {rows.flatMap((r, y) => [...r].map((c, x) => (c === '#' ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" /> : null)))}
    </svg>
  );
}

interface Hole {
  kind: (typeof KINDS)[number] | null;
  until: number;
  hit: number;
}

function RedactATracker({ active }: { active: boolean }) {
  const ROUND = 30_000;
  const [holes, setHoles] = useState<Hole[]>(() => Array.from({ length: 9 }, () => ({ kind: null, until: 0, hit: 0 })));
  const [score, setScore] = useState(0);
  const [missed, setMissed] = useState(0);
  const [endsAt, setEndsAt] = useState(0);
  const [now, setNow] = useState(0);
  const [best, setBest] = useBest('tracker');
  const running = endsAt > now;
  useEffect(() => {
    if (!endsAt || !active) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= endsAt) return;
      const pace = 1 - (endsAt - n) / ROUND;
      setHoles((hs) => {
        let miss = 0;
        const next = hs.map((h) => {
          if (h.kind && n > h.until) {
            miss++;
            return { kind: null, until: 0, hit: 0 };
          }
          if (h.hit && n > h.hit + 260) return { kind: null, until: 0, hit: 0 };
          return h;
        });
        if (miss) setMissed((m) => m + miss);
        if (Math.random() < 0.18 + pace * 0.25) {
          const free = next.map((h, i) => (h.kind ? -1 : i)).filter((i) => i >= 0);
          const i = free[Math.floor(Math.random() * free.length)];
          if (i !== undefined) next[i] = { kind: KINDS[Math.floor(Math.random() * KINDS.length)]!, until: n + 1100 - pace * 500, hit: 0 };
        }
        return next;
      });
    }, 90);
    return () => clearInterval(t);
  }, [endsAt, active]);
  useEffect(() => {
    if (endsAt && now >= endsAt) setBest(score);
  }, [now >= endsAt]);
  const start = () => {
    setScore(0);
    setMissed(0);
    setHoles(Array.from({ length: 9 }, () => ({ kind: null, until: 0, hit: 0 })));
    const n = Date.now();
    setNow(n);
    setEndsAt(n + ROUND);
  };
  const slam = (i: number) => {
    const h = holes[i];
    if (!running || !h?.kind || h.hit) return;
    play('stamp');
    setScore((s) => s + 1);
    setHoles((hs) => hs.map((x, j) => (j === i ? { ...x, hit: Date.now() } : x)));
  };
  return (
    <div className="tk-app-body">
      <div className="tk-tracker" role="grid" aria-label="Trackers">
        {holes.map((h, i) => (
          <button key={i} type="button" className={'tk-hole' + (h.kind ? ' is-up' : '') + (h.hit ? ' is-hit' : '')} onPointerDown={() => slam(i)} aria-label={h.kind ? `${LABEL[h.kind]}: slam it` : 'empty'}>
            {h.kind && (
              <span className="tk-hole__sprite">
                <Sprite kind={h.kind} />
                <span className="bb-label">{LABEL[h.kind]}</span>
              </span>
            )}
            {h.hit > 0 && <span className="tk-hole__bar" aria-hidden="true" />}
          </button>
        ))}
        {!running && (
          <div className="tk-snake__over">
            <p className="bb-display-md bb-glow bb-hi">{endsAt ? `TRACKERS REDACTED: ${score}` : 'REDACT-A-TRACKER'}</p>
            <p className="bb-ui">{endsAt ? `${missed} got away. Here, none of them would have seen anything anyway.` : 'Trackers pop out. Slam a redaction bar on them. 30 seconds.'}</p>
            <KeyButton onClick={start}>{endsAt ? 'AGAIN' : 'START'}</KeyButton>
          </div>
        )}
      </div>
      <div className="tk-snake__bar bb-label">
        <span>REDACTED <span className="bb-hi">{score}</span></span>
        <span>ESCAPED <span className="bb-hi">{missed}</span></span>
        <span>BEST <span className="bb-hi">{best}</span></span>
        <span>TIME <span className="bb-hi">{running ? Math.ceil((endsAt - now) / 1000) : 0}</span></span>
      </div>
    </div>
  );
}

/* ── P704 DEAD DROP ───────────────────────────────────────────────────────────────────── */

function DeadDrop() {
  const vault = useStore(app, (s) => s.vault);
  const saved = useStore(app, (s) => s.local.notes ?? '');
  const [text, setText] = useState(saved);
  const [state, setState] = useState<'saved' | 'typing'>('saved');
  useEffect(() => {
    if (text === saved) return;
    setState('typing');
    const t = setTimeout(() => void setLocal({ notes: text }).then(() => setState('saved')), 700);
    return () => clearTimeout(t);
  }, [text]);
  if (vault !== 'unlocked') return <OpenVault>Notes are kept inside the vault. Open it first.</OpenVault>;
  return (
    <div className="tk-app-body">
      <p className="bb-label" style={{ margin: 0 }}>
        YOUR REASONING · encrypted in your vault · never leaves this device · {state === 'saved' ? 'SAVED ✓' : 'SAVING…'}
      </p>
      <textarea className="tk-note" value={text} onChange={(e) => setText(e.target.value)} placeholder="Why this bet, at this price? Only you will ever read this." aria-label="Dead drop notes" />
    </div>
  );
}

/* ── P705 BLOCK RADIO ─────────────────────────────────────────────────────────────────── */

const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22];
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

class Radio {
  private out: GainNode;
  private an: AnalyserNode;
  private drone: OscillatorNode[] = [];
  constructor(private c: AudioContext) {
    this.out = c.createGain();
    this.out.gain.value = 0.5;
    this.an = c.createAnalyser();
    this.an.fftSize = 64;
    const verb = c.createDelay(1);
    verb.delayTime.value = 0.33;
    const fb = c.createGain();
    fb.gain.value = 0.35;
    this.out.connect(verb).connect(fb).connect(verb);
    fb.connect(this.an);
    this.out.connect(this.an).connect(c.destination);
  }
  get analyser() {
    return this.an;
  }
  startDrone(root: number) {
    this.stopDrone();
    for (const [n, g] of [[root - 24, 0.05], [root - 17, 0.03]] as const) {
      const o = this.c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midi(n);
      const gg = this.c.createGain();
      gg.gain.value = g;
      o.connect(gg).connect(this.out);
      o.start();
      this.drone.push(o);
    }
  }
  stopDrone() {
    this.drone.forEach((o) => o.stop());
    this.drone = [];
  }
  note(n: number, at: number, dur: number, gain: number, type: OscillatorType = 'sine') {
    const o = this.c.createOscillator();
    o.type = type;
    o.frequency.value = midi(n);
    const g = this.c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(this.out);
    o.start(at);
    o.stop(at + dur + 0.05);
  }
  /** One block: a chord from the log root, a melody whose length follows shielded activity. */
  block(rootHex: string, actions: number) {
    const b = fromHex(rootHex.padEnd(64, '0').slice(0, 64));
    const root = 50 + (b[0]! % 12);
    const t = this.c.currentTime + 0.05;
    for (const k of [0, 7, 10, 15]) this.note(root + k, t, 4.5, 0.06, 'triangle');
    const notes = Math.min(16, 1 + actions);
    for (let i = 0; i < notes; i++) this.note(root + 12 + SCALE[b[(i + 1) % 32]! % SCALE.length]!, t + 0.6 + i * 0.28, 0.9, 0.08);
    this.startDrone(root);
  }
  blip() {
    this.note(86 + Math.floor(Math.random() * 5) * 2, this.c.currentTime + 0.01, 0.25, 0.04, 'square');
  }
  close() {
    this.stopDrone();
    this.out.disconnect();
  }
}

function BlockRadio() {
  const sound = useStore(ui, (s) => s.sound);
  const live = useStore(app, (s) => s.live);
  const on = useStore(ui, (s) => s.radio);
  const setOn = (v: boolean) => ui.set({ radio: v });
  const radio = useRef<Radio | null>(null);
  const bars = useRef<HTMLDivElement>(null);
  const lastBlock = useRef(0);
  const lastFill = useRef(0);
  const block = live?.block ?? (live ? { height: live.head.height, shielded_actions: 0 } : null);
  useEffect(() => {
    if (!on || !sound) return;
    const c = audio();
    if (!c) return;
    const r = new Radio(c);
    radio.current = r;
    if (live) r.block(live.head.root, block?.shielded_actions ?? 0);
    let raf = 0;
    const data = new Uint8Array(r.analyser.frequencyBinCount);
    const draw = () => {
      r.analyser.getByteFrequencyData(data);
      const el = bars.current;
      if (el) [...el.children].forEach((b, i) => ((b as HTMLElement).style.transform = `scaleY(${Math.max(0.04, (data[i * 2] ?? 0) / 255)})`));
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      r.close();
      radio.current = null;
    };
  }, [on, sound]);
  // Closing the window turns the radio off.
  useEffect(() => () => ui.set({ radio: false }), []);
  useEffect(() => {
    if (!radio.current || !block || !live) return;
    if (block.height !== lastBlock.current) {
      if (lastBlock.current) radio.current.block(live.head.root, block.shielded_actions);
      lastBlock.current = block.height;
    }
    const newest = live.recent.reduce((m, f) => Math.max(m, f.at_ms), 0);
    if (newest > lastFill.current) {
      if (lastFill.current) radio.current.blip();
      lastFill.current = newest;
    }
  }, [live]);
  const power = () => {
    if (!sound) {
      ui.set({ sound: true });
      setSound(true);
    }
    setOn(!on);
  };
  return (
    <div className="tk-app-body">
      <div className="tk-radio">
        <div className="tk-radio__dial">
          <span className="bb-label">TUNED TO</span>
          <span className="bb-display-md bb-glow bb-hi">BLK {block ? height(block.height) : '—'}</span>
          <span className="bb-ui">{block ? `${block.shielded_actions} shielded actions` : 'waiting for a block'}</span>
        </div>
        <div className="tk-radio__vu" ref={bars} aria-hidden="true">
          {Array.from({ length: 16 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      </div>
      <p className="bb-ui bb-dim" style={{ margin: 0 }}>
        Every Zcash block plays a chord taken from the public log's root; the melody grows with the block's shielded activity, and each fill in the tape is a blip. Nothing is fetched for it.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <KeyButton icon="radio" onClick={power}>{on && sound ? 'RADIO OFF' : 'RADIO ON'}</KeyButton>
        {on && sound && live && (
          <KeyButton variant="secondary" onClick={() => radio.current?.block(live.head.root, block?.shielded_actions ?? 0)}>
            REPLAY THIS BLOCK
          </KeyButton>
        )}
      </div>
    </div>
  );
}

export function AppWindow({ app: id, active, onClose, onOpen }: { app: string; active: boolean; onClose: () => void; onOpen?: (id: string) => void }) {
  const a = APP_ICONS.find((x: { id: string }) => x.id === id) as { page: string; label: string } | undefined;
  if (!a) return null;
  return (
    <Win title={`${a.page} · ${a.label}`} onClose={onClose} maxWidth={id === 'snake' || id === 'tracker' ? 720 : 620} style={{ alignSelf: 'center', width: '100%' }}>
      {id === 'snake' && <NullifierSnake active={active} />}
      {id === 'calc' && <OddsCalc onUse={() => onOpen?.('markets')} />}
      {id === 'tracker' && <RedactATracker active={active} />}
      {id === 'deaddrop' && <DeadDrop />}
      {id === 'radio' && <BlockRadio />}
    </Win>
  );
}
