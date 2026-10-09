// The Bookie's booth, drawn pixel by pixel: a 60 x 62 grid composed from parts (the booth, the
// Bookie's head and torso as bitmaps, his arms from joint positions, the props) and painted into
// a canvas that CSS scales up with crisp pixels. Every colour is a design token, so the themes
// recolour him too. Nothing here knows anything about the user.

export const W = 60;
export const H = 62;

/** Palette letters → design tokens ('.' is transparent). */
export const PALETTE: Record<string, string> = {
  // Outlines: the room's own dark, so on dark themes they only cut shapes apart (ink on paper).
  k: '--bk-edge',
  g: '--glass',
  P: '--panel',
  // The stall's two quiet colors (bookie.css: the theme's rule and on-screen redaction greens,
  // softer ink lines on paper).
  d: '--bk-line',
  S: '--bk-dim',
  s: '--phosphor-mid',
  p: '--phosphor',
  h: '--phosphor-hi',
  // His shirt and sleeves (light on every theme).
  W: '--bk-shirt',
  v: '--amber',
  V: '--amber-dim',
  b: '--redact',
  w: '--paper',
  i: '--ink',
  r: '--alarm',
  x: '--ref-violet',
};

export type Grid = string[][];

export function blank(): Grid {
  return Array.from({ length: H }, () => Array<string>(W).fill('.'));
}

function put(g: Grid, x: number, y: number, c: string, clipY = H) {
  if (c === '.' || x < 0 || y < 0 || x >= W || y >= H || y >= clipY) return;
  g[y]![x] = c;
}

/** Copy a bitmap (rows of palette letters) with its top-left at (x, y). */
export function blit(g: Grid, rows: readonly string[], x: number, y: number, clipY = H) {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) put(g, x + dx, y + dy, row[dx]!, clipY);
  });
}

function rect(g: Grid, x: number, y: number, w: number, h: number, c: string) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(g, xx, yy, c);
}

/** An outline round a bitmap placed at (x, y), on empty cells only (the booth stays as it is). */
function edge(g: Grid, rows: readonly string[], x: number, y: number, clipY = H) {
  const at = (dx: number, dy: number) => (rows[dy]?.[dx] ?? '.') !== '.';
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      if (!at(dx, dy)) continue;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx + ox;
        const ny = y + dy + oy;
        if (!at(dx + ox, dy + oy) && g[ny]?.[nx] === '.') put(g, nx, ny, 'k', clipY);
      }
    }
  });
}

/** A row mirrored around its end: 'abc' → 'abccba'. */
const sym = (half: string) => half + [...half].reverse().join('');

// ---- the booth --------------------------------------------------------------------------------

const FONT: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  z: ['..', '##', '.#', '#.', '##'],
  ' ': ['...', '...', '...', '...', '...'],
};

function text(g: Grid, s: string, x: number, y: number, c: string) {
  let cx = x;
  for (const ch of s) {
    const glyph = FONT[ch] ?? FONT[' ']!;
    glyph.forEach((row, dy) => [...row].forEach((p, dx) => p === '#' && put(g, cx + dx, y + dy, c)));
    cx += glyph[0]!.length + 1;
  }
}

/** Local time on the wall clock, the night lamp, the line's lamp on the tube. */
export interface Room {
  hour: number;
  minute: number;
  night: boolean;
  line: 'linked' | 'relinking' | 'down' | 'off';
}

export const COUNTER_Y = 45;

/** The stall, drawn in the wallpaper's own quiet greens and with nothing filled in: the desk
 *  shows through it, so the Bookie sits in the wallpaper rather than on top of it. */
function booth(g: Grid, room: Room) {
  // The sign, painted straight onto the wall like the wordmark behind it.
  text(g, 'BLIND BETS', 11, 1, 'S');
  // A striped awning with a scalloped edge, and the two posts that hold it.
  for (let x = 2; x < W - 2; x++) {
    const stripe = Math.floor((x - 2) / 3) % 2 === 0 ? 'S' : 'd';
    rect(g, x, 8, 1, 2, stripe);
    if ((x - 2) % 3 !== 2) put(g, x, 10, stripe);
  }
  rect(g, 2, 11, 1, COUNTER_Y - 11, 'd');
  rect(g, W - 3, 11, 1, COUNTER_Y - 11, 'd');
  // The wall clock (local time; it shows nothing else).
  const cx = 53;
  const cy = 17;
  for (const [dx, dy] of [[-1, -3], [0, -3], [1, -3], [-2, -2], [2, -2], [-3, -1], [3, -1], [-3, 0], [3, 0], [-3, 1], [3, 1], [-2, 2], [2, 2], [-1, 3], [0, 3], [1, 3]] as const) put(g, cx + dx, cy + dy, 'S');
  const hand = (len: number, frac: number, c: string) => {
    const a = frac * 2 * Math.PI - Math.PI / 2;
    for (let i = 1; i <= len; i++) put(g, cx + Math.round(Math.cos(a) * i), cy + Math.round(Math.sin(a) * i), c);
  };
  hand(1, ((room.hour % 12) + room.minute / 60) / 12, 's');
  hand(2, room.minute / 60, 's');
  put(g, cx, cy, 's');
  // The pneumatic tube: the line out to the mixnet, and on its receiver the line's own lamp,
  // the one bright thing in the stall (green linked, amber relinking, red down).
  rect(g, 5, 11, 2, 24, 'd');
  rect(g, 5, 11, 1, 24, 'S');
  for (const y of [15, 22, 29]) rect(g, 4, y, 4, 1, 'S');
  rect(g, 3, 34, 7, 6, 'd');
  rect(g, 4, 35, 5, 4, 'k');
  const lamp = room.line === 'linked' ? 'p' : room.line === 'relinking' ? 'v' : room.line === 'down' ? 'r' : 'S';
  rect(g, 5, 36, 3, 2, lamp);
  // The lamp hanging from the awning: lit at night, with a soft halo.
  rect(g, 45, 11, 1, 3, 'd');
  rect(g, 44, 14, 3, 1, 'S');
  rect(g, 44, 15, 3, 1, room.night ? 'v' : 'd');
  if (room.night) for (const [x, y] of [[42, 16], [48, 16], [43, 18], [47, 18], [45, 19]] as const) put(g, x, y, 'V');
}

/** The counter: just its edge. Below it nothing of him is drawn, so the wallpaper shows through. */
function counter(g: Grid, night: boolean) {
  rect(g, 1, COUNTER_Y, W - 2, 1, 'S');
  rect(g, 1, COUNTER_Y + 1, W - 2, 1, 'd');
  // Under the lamp at night, a warm edge.
  if (night) rect(g, 39, COUNTER_Y, 13, 1, 'V');
  // The house rule, carved into the counter's front.
  text(g, 'NO PEEKING', 11, COUNTER_Y + 4, 'd');
}

// ---- the props ---------------------------------------------------------------------------------

const BELL = ['...V...', '..VVV..', '.VVvVV.', 'VVVVVVV', 'ddddddd'];
const STAMP = ['.VV.', '.VV.', '.VV.', 'dddd', 'rrrr'];
const PAD = ['dddddd', 'dVVVVd'];
const MUG = ['SSSS..', 'SddS.S', 'SddS.S', 'SddS.S', 'SSSSS.'];
const STEAM = [
  ['.d..', '..d.', '.d..', '..d.'],
  ['..d.', '.d..', '..d.', '.d..'],
  ['....', '.d..', '..d.', '.d..'],
];
const STACK = ['SSSSSS', 'dddddd', 'SSSSSS', 'dddddd', 'SSSSSS'];
const SLIP = ['wwwwwww', 'wiiiiiw', 'wwwwwww', 'wiiiwww', 'wwwwwww'];
const INKED = ['wwwwwww', 'wiirrrw', 'wwrrrrw', 'wiirrrw', 'wwwwwww'];
const LEDGER = ['wwwwwwwkwwwwwww', 'wiiiiiwkwiiiiiw', 'wwwwwwwkwwwwwww', 'wiiiiiwkwiiiiiw'];
const CASH = ['ppppp', 'pkpkp', 'ppppp'];
const CAMERA = ['....kk....', 'kkkkkkkkkk', 'kddkhhkddk', 'kddhkkhddk', 'kddkhhkddk', 'kkkkkkkkkk'];
const GLASS = ['.vvv.', 'vhhhv', 'vh.hv', 'vhhhv', '.vvv.'];
const PAPER = [
  'SSSSSSSSSSSSSSSSSSS',
  'SsssssssssssssssssS',
  'SSSSSSSSSSSSSSSSSSS',
  'SddddddSSddddddddSS',
  'SddddddSSddddSSdddS',
  'SSSSSSSSSSSSSSSSSSS',
  'SdddSdddddSdddddddS',
  'SddddddddddSddddddS',
  'SSSSSSSSSSSSSSSSSSS',
  'SdddddSdddddddSdddS',
  'SSSSSSSSSSSSSSSSSSS',
];
const CAPSULE = ['vv', 'hh', 'vv'];

export type Prop = 'stamp' | 'mug' | 'camera' | 'glass' | 'cash' | 'paper' | 'capsule';

/** What lies on the counter (things in his hands are taken off it). */
export interface Counter {
  slip: 'none' | 'blank' | 'inked';
  ledger: boolean;
  cash: boolean;
}

// ---- the Bookie --------------------------------------------------------------------------------

export type Mouth = 'neutral' | 'smile' | 'talk' | 'o' | 'grin' | 'flat' | 'frown' | 'yawn';

// The head, 22 x 21: dark hair, a dealer's eyeshade, the blindfold, a white handlebar moustache.
const HEAD_FRONT = [
  '........kkkkkk........',
  '......kkSSSSSSkk......',
  '.....kSSSSSSSSSSk.....',
  '....kSSSSSSSSSSSSk....',
  '...dddddddddddddddd...',
  '.VVVVVVVVVVVVVVVVVVVV.',
  'VVVVVVVVVVVVVVVVVVVVVV',
  '...kSSSSSSSSSSSSSSk...',
  '..kssssssssssssssssk..',
  'bbbbbbbbbbbbbbbbbbbbbb',
  'bbbbbbbbbbbbbbbbbbbbbb',
  '..kbbbbbbbbbbbbbbbbk..',
  'skssssssssSSssssssssks',
  'skssssssssSSssssssssks',
  '.khsssssssSSsssssssshk.',
  '.khwwwssswwwwssswwwhk.',
  '.ksswwwwwwwwwwwwwwssk.',
  sym('..kssssssss'),
  sym('..kssssssss'),
  sym('...ksssssss'),
  sym('.....kkkkkk'),
];

const HEAD_BACK = [
  '........kkkkkk........',
  '......kkSSSSSSkk......',
  '.....kSSSSSSSSSSk.....',
  '....kSSSSSSSSSSSSk....',
  '...dddddddddddddddd...',
  '..kSSSSSSSSSSSSSSSSk..',
  '..kSSSSSSSSSSSSSSSSk..',
  '..kSSSSSSSSSSSSSSSSk..',
  '..kSSSSSSSSSSSSSSSSk..',
  'bbbbbbbbbbbbbbbbbbbbbb',
  'bbbbbbbbbbbbbbbbbbbbbb',
  '..kSSSSSSSSSSSSSSSSk..',
  'SkSSSSSSSSSSSSSSSSSSkS',
  'SkSSSSSSSSSSSSSSSSSSkS',
  '.kSSSSSSSSSSSSSSSSSSk.',
  sym('.kSSSSSSSSS'),
  sym('.kSSSSSSSSS'),
  sym('..kSSSSSSSS'),
  sym('..kssssssss'),
  sym('...ksssssss'),
  sym('.....kkkkkk'),
];

/** Mouth shapes over rows 17-19, columns 8-13 of the head. */
const MOUTHS: Record<Mouth, string[]> = {
  neutral: ['..kk..', '......', '......'],
  smile: ['k....k', '.kkkk.', '......'],
  talk: ['.kkkk.', '.kkkk.', '......'],
  o: ['..kk..', '.k..k.', '..kk..'],
  grin: ['kkkkkk', 'khhhhk', '.kkkk.'],
  flat: ['.kkkk.', '......', '......'],
  frown: ['......', '.kkkk.', 'k....k'],
  yawn: ['.kkkk.', 'kkkkkk', '.kkkk.'],
};

/** The blindfold's knot ends, fluttering (two frames), right of the head. */
const TAILS = [
  ['bbbb..', 'bbbbb.', '..bbbb', '....bb'],
  ['...bbb', 'bbbbb.', 'bbb...', '......'],
];

/** The pencil behind his left ear. */
const PENCIL = ['r.', 'V.', 'VV', '.V', '.d'];

// The torso, 28 x 13: a shirt, a waistcoat with lapels and buttons, a bow tie.
const TORSO = [
  sym('...........sss'),
  sym('........WWWWVV'),
  sym('......WWWWWWVk'),
  sym('.....WWWdddWWW'),
  sym('...WWWWWdddWWW'),
  sym('..WWWWWWddddWW'),
  sym('..WWWWWWddddWW'),
  sym('...WWWWWdddddW'),
  sym('....WddddddddW'),
  sym('....dddddddddd'),
  sym('....dddddddddd'),
  sym('....dddddddddd'),
  sym('....dddddddddd'),
];
const BUTTONS: [number, number][] = [[12, 8], [15, 8], [12, 10], [15, 10], [12, 12], [15, 12]];

export interface Pt {
  x: number;
  y: number;
}

export interface Arm {
  elbow: Pt;
  hand: Pt;
  /** A raised thumb (thumbs up). */
  thumb?: boolean;
}

/** Everything that decides one frame. */
export interface Pose {
  head: 'front' | 'back';
  /** Head offset from rest (looking around, nodding, dozing). */
  hx: number;
  hy: number;
  mouth: Mouth;
  /** The blindfold lifted (the Easter egg): another blindfold underneath. */
  lifted: boolean;
  /** Breathing: the torso and head one pixel down. */
  breath: 0 | 1;
  tails: 0 | 1;
  left: Arm | null;
  right: Arm | null;
  holdLeft: Prop | null;
  holdRight: Prop | null;
  counter: Counter;
  /** Props on the counter that are in use (taken off it). */
  bellHit: boolean;
  steam: 0 | 1 | 2;
  /** The capsule's place in the tube, 0 (top) to 1 (receiver), or null. */
  capsule: number | null;
  /** "z z Z" rising (0..1), or null. */
  zzz: number | null;
  /** Sparks around him (a win), 0..1, or null. */
  sparks: number | null;
}

export const HEAD_X = 19;
export const HEAD_Y = 12;
export const TORSO_X = 16;
export const TORSO_Y = 32;
export const SHOULDER_L: Pt = { x: 21, y: 36 };
export const SHOULDER_R: Pt = { x: 38, y: 36 };

/** Every pixel on the segment from a to b (Bresenham). */
function segment(a: Pt, b: Pt): Pt[] {
  const out: Pt[] = [];
  let x0 = Math.round(a.x);
  let y0 = Math.round(a.y);
  const x1 = Math.round(b.x);
  const y1 = Math.round(b.y);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return out;
}

/** An arm: a 3-pixel white shirt sleeve from shoulder to elbow (with the garter) and on to
 *  the wrist, a hand, and an outline around all of it, hidden below the counter's top. */
function arm(g: Grid, shoulder: Pt, a: Arm, dy: number) {
  const s = { x: shoulder.x, y: shoulder.y + dy };
  const pix = new Map<string, string>();
  const dab = (p: Pt, c: string, r = 1) => {
    for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) if (Math.abs(xx) + Math.abs(yy) <= r + (r > 1 ? 1 : 0)) pix.set(`${p.x + xx},${p.y + yy}`, c);
  };
  const upper = segment(s, a.elbow);
  upper.forEach((p, i) => dab(p, Math.abs(i - Math.round(upper.length * 0.45)) <= 0 ? 'V' : 'W'));
  segment(a.elbow, a.hand).forEach((p) => dab(p, 'W'));
  // The hand, and the thumb when it's up.
  for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) pix.set(`${a.hand.x + xx},${a.hand.y + yy}`, 's');
  pix.set(`${a.hand.x},${a.hand.y}`, 'S');
  if (a.thumb) for (let i = 2; i <= 3; i++) pix.set(`${a.hand.x},${a.hand.y - i}`, 's');
  const outline = new Set<string>();
  for (const key of pix.keys()) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) if (!pix.has(`${nx},${ny}`)) outline.add(`${nx},${ny}`);
  }
  for (const key of outline) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    put(g, x, y, 'k', COUNTER_Y);
  }
  for (const [key, c] of pix) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    put(g, x, y, c, COUNTER_Y);
  }
}

/** Where a held prop's bitmap goes, relative to the hand holding it. */
function hold(g: Grid, prop: Prop, hand: Pt, side: 'L' | 'R') {
  switch (prop) {
    case 'stamp':
      blit(g, STAMP, hand.x - 1, hand.y - 1, COUNTER_Y + 1);
      break;
    case 'mug':
      blit(g, MUG, side === 'R' ? hand.x - 5 : hand.x, hand.y - 2, COUNTER_Y);
      break;
    case 'glass':
      blit(g, GLASS, hand.x - 5, hand.y - 1);
      put(g, hand.x - 1, hand.y, 'V');
      break;
    case 'cash':
      blit(g, CASH, hand.x - 2, hand.y - 3, COUNTER_Y);
      break;
    case 'capsule':
      blit(g, CAPSULE, hand.x - 1, hand.y - 3, COUNTER_Y);
      break;
    case 'camera':
    case 'paper':
      // Held in both hands: drawn once, from the left hand.
      break;
  }
}

/** Compose one frame of the booth. */
export function compose(p: Pose, room: Room): Grid {
  const g = blank();
  booth(g, room);
  const dy = p.breath;
  // Torso, then the head on it.
  edge(g, TORSO, TORSO_X, TORSO_Y + dy, COUNTER_Y);
  blit(g, TORSO, TORSO_X, TORSO_Y + dy, COUNTER_Y);
  if (p.head === 'front') for (const [x, y] of BUTTONS) put(g, TORSO_X + x, TORSO_Y + y + dy, 'h', COUNTER_Y);
  const hx = HEAD_X + p.hx;
  const hy = HEAD_Y + p.hy + dy;
  if (p.head === 'front') {
    blit(g, HEAD_FRONT, hx, hy);
    blit(g, MOUTHS[p.mouth], hx + 8, hy + 17);
    // A glint on the blindfold.
    rect(g, hx + 4, hy + 9, 3, 1, 'S');
    if (p.lifted) {
      // Lifted: the band goes up under the visor... and there is another band beneath.
      rect(g, hx + 2, hy + 7, 18, 2, 'b');
      rect(g, hx + 4, hy + 7, 2, 1, 'S');
    }
    blit(g, TAILS[p.tails]!, hx + 21, hy + 9);
    blit(g, PENCIL, hx - 1, hy + 7);
  } else {
    blit(g, HEAD_BACK, hx, hy);
    // The knot, and the ends hanging down his back.
    rect(g, hx + 9, hy + 8, 4, 4, 'b');
    blit(g, ['bb..bb', 'bb..bb', '.b..b.', '.b...b', '.b....'], hx + 8, hy + 12);
  }
  // Things on the counter: the bell, a stack of slips, the ink pad and the stamp (unless held),
  // the mug (unless held), and whatever the scene put there.
  blit(g, BELL, 11, p.bellHit ? 41 : 40);
  if (p.bellHit) rect(g, 11, 44, 7, 1, 'V');
  blit(g, STACK, 19, 40);
  blit(g, PAD, 40, 43);
  const held = [p.holdLeft, p.holdRight];
  if (!held.includes('stamp')) blit(g, STAMP, 41, 38);
  if (!held.includes('mug')) {
    blit(g, MUG, 49, 40);
    blit(g, STEAM[p.steam]!, 50, 35);
  }
  if (p.counter.slip !== 'none') blit(g, p.counter.slip === 'inked' ? INKED : SLIP, 27, 40);
  if (p.counter.ledger) blit(g, LEDGER, 22, 41);
  if (p.counter.cash) blit(g, CASH, 33, 41);
  // The capsule travelling down the tube.
  if (p.capsule !== null) blit(g, CAPSULE, 4, 9 + Math.round(p.capsule * 22));
  // The arms (in front of the torso, above the counter's top) and what they hold.
  if (p.head === 'front') {
    if (p.left) arm(g, SHOULDER_L, p.left, dy);
    if (p.right) arm(g, SHOULDER_R, p.right, dy);
    if (p.left && p.holdLeft) hold(g, p.holdLeft, p.left.hand, 'L');
    if (p.right && p.holdRight) hold(g, p.holdRight, p.right.hand, 'R');
    if (p.left && p.holdLeft === 'camera') blit(g, CAMERA, p.left.hand.x - 1, p.left.hand.y - 4);
    if (p.left && p.holdLeft === 'paper') blit(g, PAPER, p.left.hand.x - 1, p.left.hand.y - 6, COUNTER_Y + 1);
  }
  counter(g, room.night);
  // Sleep and celebration.
  if (p.zzz !== null) {
    const t = p.zzz;
    text(g, 'z', 42, 24 - Math.round(t * 4), 'h');
    if (t > 0.35) text(g, 'z', 45, 20 - Math.round((t - 0.35) * 4), 'h');
    if (t > 0.7) text(g, 'Z', 48, 15 - Math.round((t - 0.7) * 4), 'h');
  }
  if (p.sparks !== null) {
    const r = 5 + Math.round(p.sparks * 9);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * 2 * Math.PI;
      put(g, 30 + Math.round(Math.cos(a) * (r + 7)), 22 + Math.round(Math.sin(a) * r), i % 2 ? 'v' : 'h');
    }
  }
  return g;
}

/** Paint a grid into a canvas the size of the grid, with the colours resolved from CSS. */
export function paint(cv: HTMLCanvasElement, g: Grid, colors: Record<string, [number, number, number]>) {
  const c = cv.getContext('2d');
  if (!c) return;
  const img = c.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ch = g[y]![x]!;
      const rgb = colors[ch];
      const i = (y * W + x) * 4;
      if (!rgb) continue;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
}

/** The palette's current colours (the active theme's tokens). */
export function resolveColors(el: Element): Record<string, [number, number, number]> {
  const cs = getComputedStyle(el);
  const out: Record<string, [number, number, number]> = {};
  for (const [ch, token] of Object.entries(PALETTE)) {
    const v = cs.getPropertyValue(token).trim();
    const m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) {
      const n = parseInt(m[1]!, 16);
      out[ch] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    } else if (/^#([0-9a-f]{3})$/i.test(v)) {
      const [r, gg, b] = [...v.slice(1)].map((x) => parseInt(x + x, 16)) as [number, number, number];
      out[ch] = [r, gg, b];
    }
  }
  return out;
}
