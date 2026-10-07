// Desk-wide UI state that is not about money: preferences (cosmetic, kept in plain storage) and
// hand-offs between windows (the odds calculator filling the bet panel, console verbose mode).

import { createStore } from '../app/store';

export type Theme = 'green' | 'amber' | 'paper';

export interface UiState {
  clean: boolean;
  sound: boolean;
  theme: Theme;
  verbose: boolean;
  /** BLOCK RADIO playing (its window must be open). */
  radio: boolean;
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
  sound: false,
  theme: load<Theme>('bb-theme', 'green'),
  verbose: false,
  radio: false,
  prefill: null,
});

ui.subscribe(() => {
  const s = ui.get();
  keep('bb-clean', s.clean);
  keep('bb-theme', s.theme);
});
