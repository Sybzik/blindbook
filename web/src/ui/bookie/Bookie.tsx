// The Bookie: a blindfolded bookmaker in his booth on the desk. He reacts to what happens (a bet
// stamped blind, credit counted, an envelope up the pneumatic tube to the mixnet, a bell for a
// win), idles (coffee, the paper, his moustache), dozes when nobody's around, and gives a tip when
// poked. Everything he knows comes from the cues and the screen's own state: he never says an
// amount, a market or anything else about the user.

import { useEffect, useRef, useState } from 'react';
import { onCue, type Cue } from '../../app/cues';
import { app } from '../../app/services';
import { config } from '../../app/config';
import { useStore } from '../../app/store';
import { ui } from '../uistate';
import { babble, play, stopBabble } from '../sound';
import { CLIPS, IDLES, L_REST, R_REST, endPose, poseAt, restPose, type ClipName } from './clips';
import { H, W, compose, paint, resolveColors, type Pose, type Room } from './rig';
import { pick, type LineKey } from './lines';
import './bookie.css';

/** Where the booth goes: the bottom of the right-hand column on wide desks, of the left-hand one
 *  on middling desks, on the pager's MENU page on phones, and nowhere where he or his bubble
 *  would cover something (the heights leave room for the booth and a five-line bubble under the
 *  column's icons). */
type Mode = 'full' | 'small' | 'inline' | 'none';

function modeFor(inline: boolean): Mode {
  if (inline) return 'inline';
  if (innerWidth >= 1280 && innerHeight >= 660) return 'full';
  if (innerWidth >= 900 && innerHeight >= 820) return 'small';
  return 'none';
}

/** He greets once a session (the pager's MENU page mounts him again every time it opens). */
let greeted = false;

/** What each cue makes him do and say (how often he speaks: the frequent ones not every time). */
const REACT: Partial<Record<Cue, { clip: ClipName; say?: number }>> = {
  'link.linked': { clip: 'linked', say: 0.6 },
  'link.relinking': { clip: 'listen', say: 0.7 },
  'link.down': { clip: 'shrug', say: 1 },
  'link.trouble': { clip: 'scratch', say: 1 },
  'vault.created': { clip: 'tip', say: 1 },
  'vault.unlocked': { clip: 'tip', say: 0.7 },
  'vault.locked': { clip: 'back', say: 0.6 },
  'vault.restored': { clip: 'tip', say: 1 },
  credit: { clip: 'count', say: 1 },
  'topup.opened': { clip: 'thumbs', say: 1 },
  'withdraw.sent': { clip: 'send', say: 1 },
  payout: { clip: 'count', say: 1 },
  'bet.sent': { clip: 'prep', say: 0.3 },
  'bet.filled': { clip: 'slam', say: 0.5 },
  'bet.partial': { clip: 'slam', say: 1 },
  'bet.unfilled': { clip: 'unfilled', say: 1 },
  'sell.filled': { clip: 'count', say: 0.6 },
  cashin: { clip: 'count', say: 1 },
  'resolved.win': { clip: 'win', say: 1 },
  'resolved.loss': { clip: 'loss', say: 1 },
  calledit: { clip: 'camera', say: 1 },
  'slip.sent': { clip: 'send', say: 1 },
  'slip.received': { clip: 'thumbs', say: 1 },
  'slip.back': { clip: 'thumbs', say: 1 },
  'duel.opened': { clip: 'bell', say: 1 },
  'duel.taken': { clip: 'bell', say: 1 },
  'duel.cancelled': { clip: 'shrug', say: 1 },
  refused: { clip: 'shrug', say: 1 },
  error: { clip: 'scratch', say: 1 },
  doubt: { clip: 'magnify', say: 1 },
  redirected: { clip: 'alarm', say: 1 },
};

const PAGE_LINES: Record<string, LineKey> = {
  markets: 'page.markets',
  market: 'page.market',
  slips: 'page.slips',
  cage: 'page.cage',
  verify: 'page.verify',
  how: 'page.how',
  duels: 'page.duels',
  record: 'page.record',
  pass: 'page.pass',
  snake: 'page.apps',
  calc: 'page.apps',
  tracker: 'page.apps',
  deaddrop: 'page.apps',
  radio: 'page.apps',
};

const TICK_MS = 90;
/** Clips he does on his own: they keep him in the shade. */
const QUIET = new Set<ClipName>(['twirl', 'sip', 'drum', 'paper', 'look', 'yawn', 'doze']);


const SLEEP_AFTER_MS = 75_000;

/** What carries over from one clip to the next: only where his arms are (they glide on from
 *  there). Props, the counter, the head and the face go back to rest, so a clip cut short (the
 *  magnifying glass, a looping one) leaves nothing in his hands. */
function settle(p: Pose): Pose {
  return { ...restPose(), left: p.left ?? L_REST, right: p.right ?? R_REST };
}

function roomNow(): Omit<Room, 'line'> {
  const d = new Date();
  const h = d.getHours();
  return { hour: h, minute: d.getMinutes(), night: h >= 20 || h < 7 };
}

export function Bookie({ page, inline = false }: { page: string; inline?: boolean }) {
  const shown = useStore(ui, (s) => s.bookie);
  const clean = useStore(ui, (s) => s.clean);
  const theme = useStore(ui, (s) => s.theme);
  const link = useStore(app, (s) => s.link);
  const reachable = useStore(app, (s) => s.reachable);
  const doubts = useStore(app, (s) => s.doubts);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>(() => modeFor(inline));
  const [say, setSay] = useState<{ text: string; at: number; n: number } | null>(null);
  const [typed, setTyped] = useState(0);
  const [flash, setFlash] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // The animation's state lives in refs: the loop reads it every tick without re-rendering.
  const clip = useRef<{ name: ClipName; start: number; from: Pose } | null>(null);
  const base = useRef<Pose>(restPose());
  const lastLine = useRef<string | undefined>(undefined);
  const lastActive = useRef(Date.now());
  const nextIdle = useRef(Date.now() + 12_000);
  const pokes = useRef<number[]>([]);
  const colors = useRef<Record<string, [number, number, number]>>({});
  const talking = useRef(false);
  const dozing = useRef(false);
  /** On screen: only a Bookie you can see says anything (his murmur is a sound). */
  const visible = useRef(false);

  const line = useRef<Room['line']>('off');
  line.current = config.mixnet ? (link === 'linked' ? 'linked' : link === 'down' ? 'down' : 'relinking') : reachable ? 'linked' : 'down';

  const start = (name: ClipName) => {
    const now = performance.now();
    // Start from wherever he is now, so a clip that interrupts another doesn't jump.
    const from = clip.current ? poseAt(CLIPS[clip.current.name], now - clip.current.start, clip.current.from) : base.current;
    clip.current = { name, start: now, from: settle(from) };
    dozing.current = name === 'doze';
    if (name === 'camera') setTimeout(() => setFlash(true), 900);
  };

  const speak = (key: LineKey, force = false) => {
    if (!visible.current || (!force && talking.current)) return;
    const text = pick(key, lastLine.current);
    if (!text) return;
    lastLine.current = text;
    setSay((s) => ({ text, at: Date.now(), n: (s?.n ?? 0) + 1 }));
  };

  // Typewriter text and the murmur that goes with it; the bubble leaves after a while.
  useEffect(() => {
    if (!say) return;
    talking.current = true;
    setTyped(clean ? say.text.length : 0);
    const cps = 32;
    const dur = babble(say.text, cps, 1) * 1000;
    let i = 0;
    const t = clean
      ? 0
      : window.setInterval(() => {
          i += 1;
          setTyped(Math.min(say.text.length, i));
          if (i >= say.text.length) window.clearInterval(t);
        }, 1000 / cps);
    // Long enough to read at an unhurried pace (about 14 characters a second), never shorter
    // than the murmur.
    const hold = Math.max(3400, dur + 1200, say.text.length * 70 + 1200);
    const done = window.setTimeout(() => {
      talking.current = false;
      setSay(null);
    }, hold);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(done);
      stopBabble();
    };
  }, [say?.n]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 180);
    return () => clearTimeout(t);
  }, [flash]);

  // Reactions.
  useEffect(
    () =>
      onCue((c) => {
        const r = REACT[c];
        if (!r) return;
        start(r.clip);
        if (r.say && Math.random() < r.say) speak(c as LineKey, true);
      }),
    [],
  );

  // A greeting when the desk opens, and listening at the tube while the line comes up.
  useEffect(() => {
    if (greeted) return;
    const t = setTimeout(() => {
      greeted = true;
      const v = app.get().vault;
      if (config.mixnet && app.get().linkTrouble === 'browser') {
        start('shrug');
        speak('link.browser', true);
        return;
      }
      if (config.mixnet && app.get().link !== 'linked') {
        start('listen');
        speak('link.linking', true);
        return;
      }
      start(v === 'none' ? 'wave' : 'tip');
      speak(v === 'none' ? 'hello.new' : v === 'locked' ? 'hello.back' : 'hello.open', true);
      if (roomNow().night && Math.random() < 0.4) setTimeout(() => speak('night'), 6_000);
    }, 1_200);
    return () => clearTimeout(t);
  }, []);

  // The magnifying glass goes away once every request in doubt is settled.
  useEffect(() => {
    if (doubts === 0 && clip.current?.name === 'magnify') start('thumbs');
  }, [doubts]);

  // Somebody's here again: a dozing Bookie startles awake.
  useEffect(() => {
    const touch = () => {
      lastActive.current = Date.now();
      if (dozing.current) start('startle');
    };
    const evs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    evs.forEach((e) => addEventListener(e, touch, { passive: true }));
    const r = () => setMode(modeFor(inline));
    addEventListener('resize', r);
    return () => {
      evs.forEach((e) => removeEventListener(e, touch));
      removeEventListener('resize', r);
    };
  }, []);

  // The theme's colors, read once the page has the new theme (App sets it after this runs).
  useEffect(() => {
    const read = () => {
      if (canvas.current) colors.current = resolveColors(canvas.current);
    };
    read();
    const t = setTimeout(read, 0);
    return () => clearTimeout(t);
  }, [theme, shown, mode]);

  // The loop: about 11 frames a second, paused while the page is hidden.
  useEffect(() => {
    if (!shown || mode === 'none') return;
    let room = { ...roomNow(), line: line.current };
    let roomAt = Date.now();
    const tick = () => {
      if (document.hidden || !canvas.current) return;
      const nowMs = Date.now();
      const now = performance.now();
      if (nowMs - roomAt > 30_000) {
        room = { ...roomNow(), line: line.current };
        roomAt = nowMs;
      }
      room.line = line.current;
      // The glass goes away once nothing is in doubt, even if the count never showed the doubt.
      if (clip.current?.name === 'magnify' && now - clip.current.start > 6_000 && app.get().doubts === 0) start('thumbs');
      let pose: Pose;
      const c = clip.current;
      if (c) {
        const def = CLIPS[c.name];
        const t = now - c.start;
        if (!def.loop && t >= def.dur) {
          base.current = settle(endPose(def, c.from));
          clip.current = null;
          pose = base.current;
          nextIdle.current = nowMs + 9_000 + Math.random() * 12_000;
        } else pose = poseAt(def, clean && def.still !== undefined ? def.still : t, c.from);
      } else {
        pose = base.current;
        // Nobody around for a while: he dozes off. Otherwise, now and then, an idle.
        if (nowMs - lastActive.current > SLEEP_AFTER_MS && !talking.current) start('doze');
        else if (!clean && nowMs > nextIdle.current && !talking.current) {
          const total = IDLES.reduce((a, [, w]) => a + w, 0);
          let r = Math.random() * total;
          const idle = IDLES.find(([, w]) => (r -= w) < 0)?.[0] ?? 'look';
          start(idle);
        }
      }
      const live: Pose = {
        ...pose,
        breath: clean ? 0 : (Math.floor(nowMs / (dozing.current ? 2400 : 1600)) % 2) as 0 | 1,
        tails: clean ? 0 : (Math.floor(nowMs / 450) % 2) as 0 | 1,
        steam: clean ? 0 : (Math.floor(nowMs / 400) % 3) as 0 | 1 | 2,
      };
      // In the shade while idle or asleep; lit while he reacts or talks (the booth's class).
      const busy = !!clip.current && !QUIET.has(clip.current.name);
      canvas.current.parentElement?.classList.toggle('is-lit', busy || talking.current);
      // Talking: the mouth moves with the words (unless the moment has its own expression).
      if (talking.current && (live.mouth === 'neutral' || live.mouth === 'smile') && live.head === 'front') live.mouth = Math.floor(nowMs / 130) % 2 ? 'talk' : 'neutral';
      paint(canvas.current, compose(live, room), colors.current);
    };
    tick();
    const t = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(t);
  }, [shown, clean, mode]);

  visible.current = shown && mode !== 'none';
  if (!visible.current) return null;

  const poke = () => {
    lastActive.current = Date.now();
    if (dozing.current) {
      start('startle');
      speak('wake', true);
      return;
    }
    const now = Date.now();
    pokes.current = [...pokes.current.filter((t) => now - t < 4_000), now];
    if (pokes.current.length >= 7) {
      pokes.current = [];
      start('lift');
      speak('egg', true);
      return;
    }
    play('ding');
    const key = PAGE_LINES[page];
    speak(key && Math.random() < 0.5 ? key : 'tip', true);
    if (!clip.current) start(Math.random() < 0.5 ? 'thumbs' : 'tip');
  };

  const hide = () => {
    speak('hide', true);
    setLeaving(true);
    setTimeout(() => {
      setLeaving(false);
      ui.set({ bookie: false });
    }, 1_600);
  };

  const scale = mode === 'full' ? 3 : mode === 'inline' ? 3 : 2;
  return (
    <aside className={`bk bk--${mode}` + (leaving ? ' is-leaving' : '')} aria-label="The Bookie">
      {say && (
        <p className="bk__say" onClick={() => setSay(null)}>
          <span aria-hidden="true">{say.text.slice(0, typed)}</span>
          <span className="bk__sr" role="status">
            {say.text}
          </span>
        </p>
      )}
      <div className="bk__body">
        <button type="button" className="bk__booth" onClick={poke} aria-label="The Bookie: tap for a tip" title="The Bookie">
          <canvas ref={canvas} width={W} height={H} style={{ width: W * scale, height: H * scale }} />
          {flash && <span className="bk__flash" aria-hidden="true" />}
        </button>
        <button type="button" className="bk__x" onClick={hide} aria-label="Send the Bookie away (START brings him back)" title="Send him away">
          ×
        </button>
      </div>
    </aside>
  );
}
