// Desk-wide UI state that is not about money: preferences (cosmetic, kept in plain storage: they
// say nothing about bets or balances, THREAT_MODEL D8) and hand-offs between windows (the odds
// calculator filling the bet panel, console verbose mode).

import { createStore } from '../app/store';

export type Theme = 'green' | 'amber' | 'paper';

export interface UiState {
  clean: boolean;
  /** Sound effects (on unless switched off; the speaker on the landing, taskbar and pager). */
  sound: boolean;
  /** The Bookie in his booth on the desk (ui/bookie). */
  bookie: boolean;
  theme: Theme;
  verbose: boolean;
  /** BLOCK RADIO playing (its window must be open). */
  radio: boolean;
  /** A window another window asks the desk to open (with a duel draft for P150). */
  request: { id: string; n: number; duel?: { market?: string; side?: 'a' | 'b' } } | null;
  /** Set by ODDS CALC "USE IN BET" or the console's buy command; the bet panel takes it once. */
  prefill: { market?: string; side?: 'a' | 'b'; units?: number; maxCents?: number } | null;
}

function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : (JSON.parse(v) as T);
  } catch {
    return d;
  }
}

function keep(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode: preferences just don't persist */
  }
}

const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const ui = createStore<UiState>({
  clean: load('bb-clean', reduced),
  sound: load('bb-sound', true),
  bookie: load('bb-bookie', true),
  theme: load<Theme>('bb-theme', 'green'),
  verbose: false,
  radio: false,
  request: null,
  prefill: null,
});

ui.subscribe(() => {
  const s = ui.get();
  keep('bb-clean', s.clean);
  keep('bb-theme', s.theme);
  keep('bb-sound', s.sound);
  keep('bb-bookie', s.bookie);
});

let asks = 0;
/** Ask the desk to open a window (from inside another window). */
export function openWindow(id: string, duel?: { market?: string; side?: 'a' | 'b' }) {
  ui.set({ request: { id, n: ++asks, duel } });
}
