// The Bookie's moves: short clips of keyframes. Arms glide between keyframes a pixel at a time;
// everything else (mouth, props, head turn) changes at its keyframe and stays until the next one
// says otherwise.

import type { Arm, Counter, Mouth, Pose, Prop } from './rig';

export const L_REST: Arm = { elbow: { x: 17, y: 41 }, hand: { x: 26, y: 43 } };
export const R_REST: Arm = { elbow: { x: 42, y: 41 }, hand: { x: 33, y: 43 } };

export function restPose(): Pose {
  return {
    head: 'front',
    hx: 0,
    hy: 0,
    mouth: 'neutral',
    lifted: false,
    breath: 0,
    tails: 0,
    left: L_REST,
    right: R_REST,
    holdLeft: null,
    holdRight: null,
    counter: { slip: 'none', ledger: false, cash: false },
    bellHit: false,
    steam: 0,
    capsule: null,
    zzz: null,
    sparks: null,
  };
}

interface Key {
  at: number;
  left?: Arm | null;
  right?: Arm | null;
  mouth?: Mouth;
  hx?: number;
  hy?: number;
  head?: 'front' | 'back';
  holdLeft?: Prop | null;
  holdRight?: Prop | null;
  counter?: Partial<Counter>;
  bellHit?: boolean;
  lifted?: boolean;
  capsule?: number | null;
  sparks?: number | null;
  zzz?: number | null;
}

export interface Clip {
  /** How long it runs (ms); a looping clip runs until another replaces it. */
  dur: number;
  loop?: boolean;
  keys: Key[];
  /** The Bookie's motion this clip calls for, for reduced motion: jump to the key at this time. */
  still?: number;
}

const arm = (ex: number, ey: number, hx: number, hy: number, thumb = false): Arm => ({ elbow: { x: ex, y: ey }, hand: { x: hx, y: hy }, thumb });

// Poses used by several clips.
const SHRUG_L = arm(18, 40, 15, 33);
const SHRUG_R = arm(41, 40, 45, 33);
const UP_L = arm(14, 31, 12, 22);
const UP_R = arm(46, 31, 48, 22);
const STAMP_GRAB = arm(45, 40, 43, 38);
const STAMP_UP = arm(45, 33, 42, 27);
const STAMP_DOWN = arm(40, 40, 30, 38);
const FOLD_L = arm(18, 40, 27, 42);
const FOLD_R = arm(41, 40, 32, 42);
const THUMB_R = arm(46, 38, 45, 30, true);
const BELL_L = (y: number) => arm(16, 40, 14, y);

const DEFS = {
  /** A bet is on its way: he takes the stamp and raises it, waiting for the fill. */
  prep: {
    dur: 1500,
    loop: true,
    still: 700,
    keys: [
      { at: 0, counter: { slip: 'blank' } },
      { at: 220, right: STAMP_GRAB },
      { at: 340, holdRight: 'stamp' },
      { at: 700, right: STAMP_UP, mouth: 'o' },
      { at: 1100, right: arm(45, 33, 42, 26) },
      { at: 1500, right: STAMP_UP },
    ],
  },
  /** The fill: the stamp comes down on the slip, blind. */
  slam: {
    dur: 2600,
    still: 1500,
    keys: [
      { at: 0, right: STAMP_UP, holdRight: 'stamp', counter: { slip: 'blank' }, mouth: 'o' },
      { at: 130, right: STAMP_DOWN },
      { at: 160, counter: { slip: 'inked' }, mouth: 'grin' },
      { at: 700, right: STAMP_DOWN },
      { at: 1100, right: STAMP_GRAB },
      { at: 1250, holdRight: null, mouth: 'smile' },
      { at: 1600, right: R_REST },
      { at: 2600, counter: { slip: 'none' } },
    ],
  },
  /** Nothing filled: the stamp goes back, a shrug. */
  unfilled: {
    dur: 1900,
    keys: [
      { at: 0, right: STAMP_UP, holdRight: 'stamp', counter: { slip: 'blank' }, mouth: 'flat' },
      { at: 350, right: STAMP_GRAB },
      { at: 500, holdRight: null, counter: { slip: 'none' } },
      { at: 800, left: SHRUG_L, right: SHRUG_R, mouth: 'frown' },
      { at: 1500, left: SHRUG_L, right: SHRUG_R },
      { at: 1900, left: L_REST, right: R_REST, mouth: 'neutral' },
    ],
  },
  /** Listening at the tube for the line (linking, relinking): a capsule rides up and down. */
  listen: {
    dur: 2400,
    loop: true,
    still: 600,
    keys: [
      { at: 0, hx: -1, mouth: 'flat', capsule: 1 },
      { at: 300, left: arm(14, 35, 18, 25) },
      { at: 600, capsule: 0.75 },
      { at: 900, capsule: 0.5 },
      { at: 1200, capsule: 0.25 },
      { at: 1500, capsule: 0 },
      { at: 1800, capsule: 0.4 },
      { at: 2100, capsule: 0.8 },
      { at: 2400, left: arm(14, 35, 18, 25) },
    ],
  },
  /** The line is up: a thumbs up. */
  linked: {
    dur: 1800,
    still: 500,
    keys: [
      { at: 0, hx: 0, capsule: null, left: L_REST },
      { at: 350, right: THUMB_R, mouth: 'smile' },
      { at: 1300, right: THUMB_R },
      { at: 1800, right: R_REST, mouth: 'neutral' },
    ],
  },
  shrug: {
    dur: 1600,
    still: 500,
    keys: [
      { at: 0, mouth: 'frown' },
      { at: 300, left: SHRUG_L, right: SHRUG_R, hy: 0 },
      { at: 600, hy: 1 },
      { at: 1100, left: SHRUG_L, right: SHRUG_R },
      { at: 1600, left: L_REST, right: R_REST, hy: 0, mouth: 'neutral' },
    ],
  },
  /** Something on the user's network jams the line: he scratches his head under the visor. */
  scratch: {
    dur: 2000,
    still: 500,
    keys: [
      { at: 0, mouth: 'flat' },
      { at: 350, right: arm(46, 28, 40, 17) },
      { at: 500, right: arm(46, 28, 41, 16) },
      { at: 650, right: arm(46, 28, 40, 17) },
      { at: 800, right: arm(46, 28, 41, 16) },
      { at: 950, right: arm(46, 28, 40, 17) },
      { at: 1100, right: arm(46, 28, 41, 16) },
      { at: 1600, right: arm(46, 28, 40, 17) },
      { at: 2000, right: R_REST, mouth: 'neutral' },
    ],
  },
  wave: {
    dur: 1900,
    still: 400,
    keys: [
      { at: 0, mouth: 'smile' },
      { at: 300, right: arm(46, 32, 48, 23) },
      { at: 500, right: arm(46, 32, 50, 24) },
      { at: 700, right: arm(46, 32, 48, 23) },
      { at: 900, right: arm(46, 32, 50, 24) },
      { at: 1100, right: arm(46, 32, 48, 23) },
      { at: 1500, right: arm(46, 32, 48, 23) },
      { at: 1900, right: R_REST, mouth: 'neutral' },
    ],
  },
  /** Tips his visor (the vault opened). */
  tip: {
    dur: 1500,
    still: 500,
    keys: [
      { at: 0, mouth: 'smile' },
      { at: 350, right: arm(45, 31, 39, 17) },
      { at: 600, hy: -1 },
      { at: 900, right: arm(45, 31, 39, 17), hy: 0 },
      { at: 1500, right: R_REST, mouth: 'neutral' },
    ],
  },
  /** The vault closed: he turns his back, then turns round again. */
  back: {
    dur: 3400,
    still: 800,
    keys: [
      { at: 0, mouth: 'neutral' },
      { at: 250, head: 'back' },
      { at: 3100, head: 'front' },
    ],
  },
  /** Credit in: he counts the notes. */
  count: {
    dur: 2000,
    still: 400,
    keys: [
      { at: 0, mouth: 'grin', counter: { cash: false } },
      { at: 250, left: arm(19, 40, 28, 40), right: arm(42, 40, 34, 39), holdRight: 'cash' },
      { at: 450, right: arm(42, 40, 34, 37) },
      { at: 650, right: arm(42, 40, 34, 39) },
      { at: 850, right: arm(42, 40, 34, 37) },
      { at: 1050, right: arm(42, 40, 34, 39) },
      { at: 1250, right: arm(42, 40, 34, 37) },
      { at: 1500, holdRight: null, counter: { cash: true }, right: R_REST, left: L_REST, mouth: 'smile' },
      { at: 2000, counter: { cash: false }, mouth: 'neutral' },
    ],
  },
  /** An envelope up the tube (a withdrawal). */
  send: {
    dur: 1900,
    still: 500,
    keys: [
      { at: 0, mouth: 'flat' },
      { at: 300, left: arm(14, 40, 8, 37), holdLeft: 'capsule', hx: -1 },
      { at: 650, holdLeft: null, capsule: 1 },
      { at: 800, capsule: 0.6 },
      { at: 950, capsule: 0.2 },
      { at: 1050, capsule: null },
      { at: 1400, left: L_REST, hx: 0, mouth: 'smile' },
      { at: 1900, mouth: 'neutral' },
    ],
  },
  /** CALLED IT: both arms up, then the bell. */
  win: {
    dur: 2600,
    still: 600,
    keys: [
      { at: 0, mouth: 'grin', sparks: 0 },
      { at: 250, left: UP_L, right: UP_R, sparks: 0.3 },
      { at: 550, left: arm(14, 31, 12, 21), right: arm(46, 31, 48, 21), sparks: 0.7 },
      { at: 850, left: UP_L, right: UP_R, sparks: 1 },
      { at: 1100, sparks: null, left: BELL_L(39), right: R_REST },
      { at: 1200, bellHit: true },
      { at: 1350, bellHit: false, left: BELL_L(37) },
      { at: 1500, bellHit: true },
      { at: 1650, bellHit: false },
      { at: 2100, left: L_REST, mouth: 'smile' },
      { at: 2600, mouth: 'neutral' },
    ],
  },
  /** The house won: a small shrug, head down. */
  loss: {
    dur: 1900,
    still: 600,
    keys: [
      { at: 0, mouth: 'frown' },
      { at: 300, left: arm(18, 41, 17, 37), right: arm(41, 41, 43, 37), hy: 1 },
      { at: 1300, left: arm(18, 41, 17, 37), right: arm(41, 41, 43, 37) },
      { at: 1900, left: L_REST, right: R_REST, hy: 0, mouth: 'neutral' },
    ],
  },
  /** CALLED IT card: the old camera comes up, flash. */
  camera: {
    dur: 1800,
    still: 600,
    keys: [
      { at: 0, mouth: 'smile' },
      { at: 300, left: arm(19, 36, 26, 30), right: arm(40, 36, 34, 30), holdLeft: 'camera' },
      { at: 1300, left: arm(19, 36, 26, 30), right: arm(40, 36, 34, 30) },
      { at: 1500, holdLeft: null, left: L_REST, right: R_REST },
    ],
  },
  /** No answer: checking the public log with a magnifying glass. */
  magnify: {
    dur: 2400,
    loop: true,
    still: 600,
    keys: [
      { at: 0, counter: { ledger: true }, holdRight: 'glass', mouth: 'flat' },
      { at: 300, right: arm(44, 38, 31, 40) },
      { at: 1100, right: arm(44, 38, 38, 40) },
      { at: 1900, right: arm(44, 38, 31, 40) },
      { at: 2400, right: arm(44, 38, 31, 40) },
    ],
  },
  /** Something's off with a request: hands slap the counter twice. */
  alarm: {
    dur: 1600,
    still: 400,
    keys: [
      { at: 0, mouth: 'o' },
      { at: 150, left: arm(18, 38, 24, 38), right: arm(41, 38, 35, 38) },
      { at: 300, left: arm(18, 41, 24, 43), right: arm(41, 41, 35, 43) },
      { at: 450, left: arm(18, 38, 24, 38), right: arm(41, 38, 35, 38) },
      { at: 600, left: arm(18, 41, 24, 43), right: arm(41, 41, 35, 43) },
      { at: 1600, left: L_REST, right: R_REST, mouth: 'frown' },
    ],
  },
  /** Rings the desk bell (a duel opened or taken). */
  bell: {
    dur: 1500,
    still: 400,
    keys: [
      { at: 0, mouth: 'smile' },
      { at: 300, left: BELL_L(37) },
      { at: 420, left: BELL_L(39), bellHit: true },
      { at: 560, bellHit: false, left: BELL_L(36) },
      { at: 700, left: BELL_L(39), bellHit: true },
      { at: 840, bellHit: false },
      { at: 1500, left: L_REST, mouth: 'neutral' },
    ],
  },
  thumbs: {
    dur: 1500,
    still: 400,
    keys: [
      { at: 0, mouth: 'smile' },
      { at: 300, right: THUMB_R },
      { at: 1100, right: THUMB_R },
      { at: 1500, right: R_REST, mouth: 'neutral' },
    ],
  },
  // ---- idling ---------------------------------------------------------------------------------
  twirl: {
    dur: 2200,
    keys: [
      { at: 300, right: arm(45, 37, 39, 30) },
      { at: 600, right: arm(45, 37, 40, 29) },
      { at: 800, right: arm(45, 37, 39, 30) },
      { at: 1000, right: arm(45, 37, 40, 29) },
      { at: 1200, right: arm(45, 37, 39, 30) },
      { at: 1400, right: arm(45, 37, 40, 29) },
      { at: 2200, right: R_REST },
    ],
  },
  sip: {
    dur: 3400,
    keys: [
      { at: 400, right: arm(46, 42, 51, 41) },
      { at: 550, holdRight: 'mug' },
      { at: 1100, right: arm(44, 37, 37, 32), mouth: 'o' },
      { at: 2000, right: arm(44, 37, 37, 32), mouth: 'o' },
      { at: 2600, right: arm(46, 42, 51, 41), mouth: 'smile' },
      { at: 2750, holdRight: null },
      { at: 3400, right: R_REST, mouth: 'neutral' },
    ],
  },
  drum: {
    dur: 1800,
    keys: [
      { at: 200, right: arm(43, 41, 36, 43) },
      { at: 350, right: arm(43, 41, 36, 42) },
      { at: 500, right: arm(43, 41, 37, 43) },
      { at: 650, right: arm(43, 41, 36, 42) },
      { at: 800, right: arm(43, 41, 35, 43) },
      { at: 950, right: arm(43, 41, 36, 42) },
      { at: 1100, right: arm(43, 41, 37, 43) },
      { at: 1250, right: arm(43, 41, 36, 43) },
      { at: 1800, right: R_REST },
    ],
  },
  paper: {
    dur: 6200,
    keys: [
      { at: 400, left: arm(14, 38, 20, 34), right: arm(45, 38, 40, 34), holdLeft: 'paper' },
      { at: 3000, left: arm(14, 38, 20, 33), right: arm(45, 38, 40, 33) },
      { at: 3200, left: arm(14, 38, 20, 34), right: arm(45, 38, 40, 34) },
      { at: 5800, left: arm(14, 38, 20, 34), right: arm(45, 38, 40, 34) },
      { at: 6000, holdLeft: null, left: L_REST, right: R_REST },
    ],
  },
  look: {
    dur: 2200,
    keys: [
      { at: 300, hx: -1 },
      { at: 900, hx: 1 },
      { at: 1500, hx: 0, mouth: 'o' },
      { at: 2000, mouth: 'neutral' },
    ],
  },
  yawn: {
    dur: 2000,
    keys: [
      { at: 200, left: arm(18, 38, 27, 31), mouth: 'yawn', hy: -1 },
      { at: 1300, left: arm(18, 38, 27, 31) },
      { at: 1600, left: L_REST, mouth: 'neutral', hy: 0 },
    ],
  },
  /** Asleep at the counter, until something wakes him. */
  doze: {
    dur: 3000,
    loop: true,
    still: 0,
    keys: [
      { at: 0, left: FOLD_L, right: FOLD_R, hx: 1, hy: 2, mouth: 'flat', zzz: 0 },
      { at: 1000, zzz: 0.35 },
      { at: 2000, zzz: 0.7 },
      { at: 2900, zzz: 0.95 },
    ],
  },
  startle: {
    dur: 900,
    still: 200,
    keys: [
      { at: 0, left: SHRUG_L, right: SHRUG_R, hx: 0, hy: -1, mouth: 'o', zzz: null },
      { at: 500, left: SHRUG_L, right: SHRUG_R },
      { at: 900, left: L_REST, right: R_REST, hy: 0, mouth: 'neutral' },
    ],
  },
  /** The Easter egg: he lifts the blindfold. There's another one underneath. */
  lift: {
    dur: 3200,
    still: 1200,
    keys: [
      { at: 0, mouth: 'neutral' },
      { at: 350, right: arm(45, 30, 40, 22) },
      { at: 600, lifted: true, mouth: 'o' },
      { at: 2400, lifted: true, mouth: 'smile' },
      { at: 2600, lifted: false },
      { at: 3200, right: R_REST, mouth: 'neutral' },
    ],
  },
} satisfies Record<string, Clip>;

export type ClipName = keyof typeof DEFS;
export const CLIPS: Record<ClipName, Clip> = DEFS;

/** Idles picked at random while nothing else is going on (weights). */
export const IDLES: [ClipName, number][] = [
  ['twirl', 3],
  ['sip', 3],
  ['drum', 2],
  ['paper', 2],
  ['look', 3],
  ['yawn', 1],
];

const lerp = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

function mix(a: Arm, b: Arm, k: number): Arm {
  return {
    elbow: { x: lerp(a.elbow.x, b.elbow.x, k), y: lerp(a.elbow.y, b.elbow.y, k) },
    hand: { x: lerp(a.hand.x, b.hand.x, k), y: lerp(a.hand.y, b.hand.y, k) },
    thumb: k < 0.5 ? a.thumb : b.thumb,
  };
}

/** The pose `t` ms into a clip, starting from `from` (the pose it began in). */
export function poseAt(clip: Clip, t: number, from: Pose): Pose {
  const time = clip.loop ? t % clip.dur : Math.min(t, clip.dur);
  // Discrete fields: every key up to now, in order.
  const p: Pose = { ...from, counter: { ...from.counter } };
  // The arms' keyframes: where each arm was at the last key that moved it, and where it goes next.
  let lastL: { at: number; arm: Arm | null } = { at: 0, arm: from.left };
  let lastR: { at: number; arm: Arm | null } = { at: 0, arm: from.right };
  for (const k of clip.keys) {
    if (k.at > time) break;
    if (k.mouth !== undefined) p.mouth = k.mouth;
    if (k.hx !== undefined) p.hx = k.hx;
    if (k.hy !== undefined) p.hy = k.hy;
    if (k.head !== undefined) p.head = k.head;
    if (k.holdLeft !== undefined) p.holdLeft = k.holdLeft;
    if (k.holdRight !== undefined) p.holdRight = k.holdRight;
    if (k.counter) p.counter = { ...p.counter, ...k.counter };
    if (k.bellHit !== undefined) p.bellHit = k.bellHit;
    if (k.lifted !== undefined) p.lifted = k.lifted;
    if (k.capsule !== undefined) p.capsule = k.capsule;
    if (k.sparks !== undefined) p.sparks = k.sparks;
    if (k.zzz !== undefined) p.zzz = k.zzz;
    if (k.left !== undefined) lastL = { at: k.at, arm: k.left };
    if (k.right !== undefined) lastR = { at: k.at, arm: k.right };
  }
  const next = (side: 'left' | 'right', after: number) => clip.keys.find((k) => k.at > after && k[side] !== undefined);
  const glide = (last: { at: number; arm: Arm | null }, side: 'left' | 'right'): Arm | null => {
    const n = next(side, time);
    if (!n || !last.arm || !n[side]) return last.arm;
    const k = ease(Math.max(0, Math.min(1, (time - last.at) / Math.max(1, n.at - last.at))));
    return mix(last.arm, n[side]!, k);
  };
  p.left = glide(lastL, 'left');
  p.right = glide(lastR, 'right');
  return p;
}

/** The pose a finished clip leaves him in (for the next one to start from). */
export function endPose(clip: Clip, from: Pose): Pose {
  return poseAt(clip, clip.dur, from);
}
