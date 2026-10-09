// Procedural sound: every effect is made here from oscillators and noise (no audio files, nothing
// fetched). On unless switched off (the speaker on the landing, in the taskbar and on the pager);
// browsers start audio only after a touch or a key, and on an iPhone the audio session is
// "ambient", so the silent switch mutes it and it never stops someone's music.
//
// Effects follow the cues (app/cues.ts): what happened, never how much or where.

import { onCue, type Cue } from '../app/cues';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let enabled = false;
/** When the last effect started (ms), so a toast's chime doesn't pile onto a cue's sound. */
let lastAt = 0;

function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'ambient';
    ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(comp).connect(ctx.destination);
    // One second of noise, read from a random offset by every noisy effect.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch {
    ctx = null;
  }
  return ctx;
}

export function setSound(on: boolean) {
  enabled = on;
  const c = on ? context() : ctx;
  if (!c) return;
  if (on && c.state === 'suspended') void c.resume().catch(() => undefined);
  if (master) master.gain.setTargetAtTime(on ? 0.7 : 0, c.currentTime, 0.02);
}

export function soundOn(): boolean {
  return enabled;
}

/** Browsers allow audio only after a gesture: resume on the first touch or key. */
export function primeAudio() {
  const go = () => {
    if (enabled) setSound(true);
    removeEventListener('pointerdown', go);
    removeEventListener('keydown', go);
  };
  addEventListener('pointerdown', go, { passive: true });
  addEventListener('keydown', go);
}

/** The shared context for apps that make their own music (BLOCK RADIO); null while sound is off. */
export function audio(): AudioContext | null {
  return enabled ? context() : null;
}

/** Where effects and music go (through the master volume). */
export function output(): AudioNode | null {
  return enabled && context() ? master : null;
}

// ---- building blocks --------------------------------------------------------------------------

function env(c: AudioContext, at: number, peak: number, attack: number, decay: number): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  g.connect(master!);
  return g;
}

/** Filtered noise: clicks, paper, air, static. */
function noise(c: AudioContext, at: number, dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'bandpass', sweepTo?: number) {
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, at);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
  f.Q.value = q;
  src.connect(f).connect(env(c, at, gain, Math.min(0.004, dur / 4), dur));
  src.start(at, Math.random() * 0.9, dur + 0.05);
}

function tone(c: AudioContext, at: number, dur: number, freq: number, gain: number, type: OscillatorType = 'sine', slideTo?: number, attack = 0.004) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
  o.connect(env(c, at, gain, attack, dur));
  o.start(at);
  o.stop(at + attack + dur + 0.05);
}

/** A struck metal bell: a fundamental with the inharmonic partials of a real bell. */
function bell(c: AudioContext, at: number, freq: number, gain: number, decay = 1.1) {
  [1, 2.76, 5.4, 8.93].forEach((r, i) => tone(c, at, decay / (1 + i * 0.6), freq * r, gain / (1 + i * 1.5), 'sine', undefined, 0.002));
}

function thump(c: AudioContext, at: number, from: number, gain: number, dur = 0.14) {
  tone(c, at, dur, from, gain, 'sine', from / 2.2);
}

// ---- effects ----------------------------------------------------------------------------------

export type Sfx =
  | 'click'
  | 'key'
  | 'type'
  | 'tab'
  | 'open'
  | 'close'
  | 'menu'
  | 'notice'
  | 'print'
  | 'tear'
  | 'stamp'
  | 'degauss'
  | 'error'
  | 'alarm'
  | 'boot'
  | 'link'
  | 'relink'
  | 'down'
  | 'unlock'
  | 'lock'
  | 'credit'
  | 'coins'
  | 'whoosh'
  | 'lever'
  | 'shred'
  | 'win'
  | 'lose'
  | 'shutter'
  | 'slap'
  | 'page'
  | 'ding';

export function play(s: Sfx) {
  if (!enabled) return;
  const c = context();
  if (!c || !master) return;
  if (c.state === 'suspended') void c.resume().catch(() => undefined);
  const t = c.currentTime + 0.01;
  lastAt = performance.now();
  switch (s) {
    case 'click':
      noise(c, t, 0.03, 2400, 6, 0.25);
      break;
    case 'key':
      // A mechanical key: the switch, then the keycap bottoming out.
      noise(c, t, 0.018, 3200, 5, 0.16);
      thump(c, t + 0.006, 190, 0.07, 0.04);
      break;
    case 'type':
      noise(c, t, 0.012, 2200 + Math.random() * 900, 4, 0.1);
      thump(c, t, 90, 0.05, 0.03);
      break;
    case 'tab':
      noise(c, t, 0.015, 5200, 6, 0.08);
      break;
    case 'open':
      // A CRT window popping up: a rising blip over a key click.
      tone(c, t, 0.07, 660, 0.07, 'square', 1320);
      noise(c, t, 0.02, 3000, 5, 0.08);
      break;
    case 'close':
      tone(c, t, 0.08, 880, 0.06, 'square', 330);
      break;
    case 'menu':
      // A relay pulling in.
      noise(c, t, 0.02, 1200, 3, 0.2);
      noise(c, t + 0.045, 0.025, 900, 3, 0.16);
      thump(c, t, 160, 0.08, 0.05);
      break;
    case 'notice':
      tone(c, t, 0.25, 1046.5, 0.05);
      tone(c, t + 0.11, 0.35, 1568, 0.045);
      break;
    case 'print':
      // A thermal receipt printer: the head stepping line by line, the motor underneath.
      tone(c, t, 0.7, 70, 0.03, 'sawtooth');
      for (let i = 0; i < 14; i++) noise(c, t + i * 0.05, 0.04, 3200, 2, 0.07);
      break;
    case 'tear':
      noise(c, t, 0.22, 4200, 0.8, 0.18, 'highpass', 2600);
      break;
    case 'stamp':
      thump(c, t, 120, 0.45, 0.18);
      noise(c, t, 0.08, 600, 1, 0.28, 'lowpass');
      break;
    case 'degauss':
      tone(c, t, 0.9, 60, 0.3, 'sawtooth', 40);
      noise(c, t, 0.12, 200, 1, 0.35, 'lowpass');
      break;
    case 'error':
      tone(c, t, 0.1, 220, 0.12, 'square');
      tone(c, t + 0.13, 0.16, 165, 0.12, 'square');
      break;
    case 'alarm':
      for (let i = 0; i < 2; i++) {
        tone(c, t + i * 0.32, 0.12, 880, 0.1, 'square');
        tone(c, t + i * 0.32 + 0.14, 0.12, 660, 0.1, 'square');
      }
      break;
    case 'boot':
      tone(c, t, 0.5, 15_600, 0.025);
      tone(c, t, 0.35, 90, 0.18, 'sine', 45);
      noise(c, t + 0.05, 0.3, 300, 1, 0.08, 'lowpass');
      break;
    case 'link':
      // The line connecting: two dial tones, a short handshake, a clear two-note chime.
      tone(c, t, 0.07, 697, 0.035, 'sine');
      tone(c, t, 0.07, 1209, 0.035, 'sine');
      tone(c, t + 0.1, 0.07, 770, 0.035, 'sine');
      tone(c, t + 0.1, 0.07, 1336, 0.035, 'sine');
      noise(c, t + 0.22, 0.22, 900, 3, 0.03, 'bandpass', 2800);
      tone(c, t + 0.5, 0.3, 1046.5, 0.05);
      tone(c, t + 0.6, 0.45, 1568, 0.05);
      break;
    case 'relink':
      for (let i = 0; i < 6; i++) noise(c, t + i * 0.05 + Math.random() * 0.02, 0.03, 3000 + Math.random() * 3000, 2, 0.05, 'highpass');
      break;
    case 'down':
      tone(c, t, 0.5, 440, 0.08, 'triangle', 110);
      break;
    case 'unlock':
      // A safe: the dial clicking past three numbers, then the bolt.
      for (let i = 0; i < 3; i++) noise(c, t + i * 0.08, 0.015, 2600, 8, 0.12);
      thump(c, t + 0.3, 130, 0.3, 0.16);
      tone(c, t + 0.31, 0.25, 1760, 0.03);
      break;
    case 'lock':
      noise(c, t, 0.1, 700, 1, 0.15, 'lowpass');
      thump(c, t + 0.08, 95, 0.4, 0.22);
      noise(c, t + 0.08, 0.04, 2400, 6, 0.08);
      break;
    case 'credit':
      // A cash register: the drawer's "cha", then the bell's "ching".
      noise(c, t, 0.06, 1500, 1.5, 0.12);
      noise(c, t + 0.05, 0.14, 500, 1, 0.12, 'lowpass');
      bell(c, t + 0.1, 2093, 0.07, 0.9);
      break;
    case 'coins':
      for (let i = 0; i < 7; i++) {
        const at = t + i * (0.045 + Math.random() * 0.03);
        tone(c, at, 0.12, 2600 + Math.random() * 2400, 0.03);
        noise(c, at, 0.01, 6000, 3, 0.04);
      }
      break;
    case 'whoosh':
      // A pneumatic tube: air rushing up the pipe, the capsule landing.
      noise(c, t, 0.4, 350, 1.2, 0.09, 'bandpass', 2600);
      thump(c, t + 0.42, 110, 0.18, 0.1);
      noise(c, t + 0.42, 0.05, 900, 2, 0.08);
      break;
    case 'lever':
      // The BUY lever: a heavy "ka-chunk".
      noise(c, t, 0.03, 1500, 3, 0.14);
      thump(c, t + 0.05, 150, 0.32, 0.12);
      noise(c, t + 0.05, 0.05, 800, 2, 0.1);
      break;
    case 'shred':
      for (let i = 0; i < 12; i++) noise(c, t + i * 0.04, 0.035, 2500 + (i % 3) * 600, 2, 0.06, 'highpass');
      tone(c, t, 0.5, 110, 0.03, 'sawtooth');
      break;
    case 'win':
      // The desk bell, struck twice.
      bell(c, t, 1568, 0.09, 1.2);
      bell(c, t + 0.2, 1568, 0.08, 1.4);
      break;
    case 'lose':
      tone(c, t, 0.22, 220, 0.07, 'triangle', 196);
      tone(c, t + 0.24, 0.4, 175, 0.07, 'triangle', 110);
      break;
    case 'shutter':
      // An old camera: the shutter, the film advance, the flash charging back up.
      noise(c, t, 0.012, 4200, 4, 0.18);
      noise(c, t + 0.05, 0.012, 3600, 4, 0.14);
      tone(c, t + 0.08, 0.12, 300, 0.03, 'sawtooth', 200);
      tone(c, t + 0.15, 0.5, 1800, 0.012, 'sine', 6000);
      break;
    case 'slap':
      noise(c, t, 0.05, 1500, 1, 0.2, 'lowpass');
      thump(c, t, 200, 0.12, 0.06);
      break;
    case 'page':
      noise(c, t, 0.12, 1800, 1.2, 0.07, 'bandpass', 3600);
      break;
    case 'ding':
      bell(c, t, 2349, 0.06, 0.7);
      break;
  }
}

/** A chime for a toast, unless a cue's own sound just played. */
export function notify() {
  if (performance.now() - lastAt > 450) play('notice');
}

// ---- the Bookie's voice -----------------------------------------------------------------------

let voice: OscillatorNode[] = [];

/** Murmur along with a line of text (a syllable per two letters, pitched by the letters), the
 *  way a cartoon character talks: no words, just the tune. Returns how long it takes. */
export function babble(text: string, cps = 30, pitch = 1): number {
  stopBabble();
  const chars = [...text];
  const dur = chars.length / cps;
  if (!enabled) return dur;
  const c = context();
  if (!c || !master) return dur;
  const t0 = c.currentTime + 0.02;
  for (let i = 0; i < chars.length; i += 2) {
    const ch = chars[i]!;
    if (!/[a-z0-9]/i.test(ch)) continue;
    const at = t0 + i / cps;
    const code = ch.toLowerCase().charCodeAt(0);
    const f = (150 + ((code * 37) % 90)) * pitch;
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(f, at);
    o.frequency.exponentialRampToValueAtTime(f * 0.85, at + 0.06);
    const formant = c.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.value = 700 + ((code * 13) % 900);
    formant.Q.value = 3;
    o.connect(formant).connect(env(c, at, 0.05, 0.006, 0.06));
    o.start(at);
    o.stop(at + 0.09);
    voice.push(o);
  }
  return dur;
}

export function stopBabble() {
  for (const o of voice) {
    try {
      o.stop();
    } catch {
      /* already stopped */
    }
  }
  voice = [];
}

// ---- cues -------------------------------------------------------------------------------------

const ON_CUE: Partial<Record<Cue, Sfx>> = {
  'link.linked': 'link',
  'link.relinking': 'relink',
  'link.down': 'down',
  'link.trouble': 'error',
  'vault.created': 'stamp',
  'vault.unlocked': 'unlock',
  'vault.locked': 'lock',
  'vault.restored': 'unlock',
  credit: 'credit',
  'topup.opened': 'print',
  'withdraw.sent': 'whoosh',
  payout: 'coins',
  'bet.sent': 'lever',
  'bet.filled': 'print',
  'bet.partial': 'print',
  'bet.unfilled': 'error',
  'sell.filled': 'shred',
  cashin: 'coins',
  'resolved.win': 'win',
  'resolved.loss': 'lose',
  calledit: 'shutter',
  'slip.sent': 'print',
  'slip.received': 'stamp',
  'slip.back': 'tear',
  'duel.opened': 'slap',
  'duel.taken': 'stamp',
  'duel.cancelled': 'tear',
  refused: 'error',
  error: 'error',
  doubt: 'page',
  redirected: 'alarm',
};

let listening = false;
/** Play the matching effect for every cue (once per page). */
export function listenToCues() {
  if (listening) return;
  listening = true;
  onCue((c) => {
    const s = ON_CUE[c];
    if (!s) return;
    play(s);
    // A printed slip is torn off the printer when it's done.
    if (c === 'bet.filled' || c === 'bet.partial') setTimeout(() => play('tear'), 750);
  });
}
