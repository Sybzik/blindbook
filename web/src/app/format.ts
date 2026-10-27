// Numbers the way the design system writes them: ZEC to 4 decimals, prices in cents, heights
// grouped, separators " · ".

import { COIN } from './config';

export const UNITS_PER_COIN = 100_000;

export function coin(units: number, digits = 4): string {
  return (units / UNITS_PER_COIN).toFixed(digits);
}

export function coinLabel(units: number, digits = 4): string {
  return `${coin(units, digits)} ${COIN}`;
}

export function zat(z: number, digits = 4): string {
  return (z / 1e8).toFixed(digits);
}

export const cents = (ppm: number) => Math.round(ppm / 10_000);

export const bpCents = (bp: number) => Math.round(bp / 100);

export const height = (h: number) => h.toLocaleString('en-US');

export function countdown(ms: number): string {
  if (ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const hh = String(Math.floor((s % 86_400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return d > 0 ? `${d}D ${hh}:${mm}` : `${hh}:${mm}:${ss}`;
}

export function utc(ms: number): string {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${mon} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/** A settled market's result in words: who won, or a 50-50 split. */
export function resultText(outcomes: [string, string], r: { den: number; num: [number, number] }): string {
  if (r.num[0] === r.num[1]) return '50-50: each share paid half';
  return `${outcomes[r.num[0] > r.num[1] ? 0 : 1].toUpperCase()} won`;
}

/** Engine halt reasons in plain words (MARKETS "Halts"). */
export function haltText(h: string | null): string {
  switch (h) {
    case 'EventStarted':
      return 'The event has started. Trading closed at kick-off; slips keep their value.';
    case 'PastEnd':
      return 'The market has ended. Waiting for the result on Polygon.';
    case 'AskAtLimit':
      return 'One outcome is at 98¢ or more: the result is effectively known.';
    case 'StaleReference':
      return 'The Polymarket feed is not healthy. Trading resumes by itself when it is.';
    case 'Closed':
    case 'NotAccepting':
      return 'Polymarket stopped trading this market.';
    case 'BadQuote':
      return 'No reliable Polymarket price right now. Trading resumes by itself.';
    default:
      return 'Trading is paused. Slips keep their value.';
  }
}
