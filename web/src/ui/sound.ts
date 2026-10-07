// Procedural sound (no audio files, nothing fetched): relay clicks, split-flap clatter, the
// thermal printer, a stamp thud, the degauss thunk. Off by default; START → SOUND turns it on.

let ctx: AudioContext | null = null;
let enabled = false;

export function setSound(on: boolean) {
  enabled = on;
  if (on && !ctx) ctx = new AudioContext();
  if (on && ctx?.state === 'suspended') void ctx.resume();
}

export function soundOn(): boolean {
  return enabled;
}

/** The shared context for apps that make their own music (BLOCK RADIO); null while sound is off. */
export function audio(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

function noise(c: AudioContext, seconds: number): AudioBuffer {
  const b = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * seconds)), c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function burst(c: AudioContext, at: number, dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'bandpass') {
  const src = c.createBufferSource();
  src.buffer = noise(c, dur);
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(f).connect(g).connect(c.destination);
  src.start(at);
  src.stop(at + dur);
}

function tone(c: AudioContext, at: number, dur: number, freq: number, gain: number, type: OscillatorType = 'sine', slideTo?: number) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(c.destination);
  o.start(at);
  o.stop(at + dur);
}

export type Sfx = 'click' | 'flap' | 'print' | 'stamp' | 'degauss' | 'tear' | 'error' | 'boot';

export function play(s: Sfx) {
  if (!enabled) return;
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.01;
  switch (s) {
    case 'click':
      burst(c, t, 0.03, 2400, 6, 0.25);
      break;
    case 'flap':
      for (let i = 0; i < 6; i++) burst(c, t + i * 0.035, 0.025, 1800 + Math.random() * 900, 4, 0.18);
      break;
    case 'print':
      for (let i = 0; i < 14; i++) burst(c, t + i * 0.05, 0.04, 3200, 2, 0.08);
      break;
    case 'stamp':
      tone(c, t, 0.18, 120, 0.5, 'sine', 50);
      burst(c, t, 0.08, 600, 1, 0.3, 'lowpass');
      break;
    case 'degauss':
      tone(c, t, 0.9, 60, 0.35, 'sawtooth', 40);
      burst(c, t, 0.12, 200, 1, 0.4, 'lowpass');
      break;
    case 'tear':
      burst(c, t, 0.22, 4200, 0.8, 0.2, 'highpass');
      break;
    case 'error':
      tone(c, t, 0.12, 220, 0.2, 'square');
      tone(c, t + 0.14, 0.18, 165, 0.2, 'square');
      break;
    case 'boot':
      tone(c, t, 0.5, 15_600, 0.03, 'sine');
      tone(c, t, 0.35, 90, 0.2, 'sine', 45);
      break;
  }
}
