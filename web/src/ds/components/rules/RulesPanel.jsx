import React from 'react';
import { LeaderRow } from '../data/Redacted.jsx';

export const RULES_SAMPLE = 'This market will resolve to "LEGACY" if LEGACY wins the CS2 match against PARIVISION in the ESL Pro League scheduled for October 3, 2026, 09:00 UTC. It will resolve to "PARIVISION" if PARIVISION wins. If the match is cancelled, postponed beyond October 10, 2026, or ends without a winner, this market will resolve 50-50. The resolution source is the official ESL Pro League match page.';

export const RULES_ROWS = [
  { label: 'TRADING CLOSES', value: 'at kick-off · Oct 3 09:00 UTC' },
  { label: 'SETTLES', value: 'when Polymarket resolves, read from Polygon' },
  { label: 'PAYS', value: '1 per winning share · 0.5 per share if 50-50' },
  { label: 'YOUR BET', value: 'a bearer slip, kept in your vault' },
  { label: 'REDEEM', value: 'any time after settlement, in F2 SLIPS' },
];

/* RULES panel: (a) Polymarket's rules verbatim, (b) how Blindbook handles this market. */
export function RulesPanel({ rules = RULES_SAMPLE, url = '#', rows = RULES_ROWS, className = '' }) {
  // The one link that leaves Blindbook: polymarket.com sees whoever clicks it, so it says so.
  return (
    <div className={'bb-rules ' + className}>
      <section className="bb-rules__part">
        <h3 className="bb-label bb-rules__h">POLYMARKET'S RULES <span className="bb-rules__tag">VERBATIM</span></h3>
        <blockquote className="bb-text bb-rules__quote">{rules}</blockquote>
        <a className="bb-rules__link" href={url} target="_blank" rel="noreferrer noopener">full rules on Polymarket ↗</a>
        <span className="bb-rules__note"> opens polymarket.com directly, outside the mixnet</span>
      </section>
      <section className="bb-rules__part">
        <h3 className="bb-label bb-rules__h">HOW BLINDBOOK HANDLES THIS MARKET</h3>
        {rows.map((r) => <LeaderRow key={r.label} label={r.label} value={r.value} />)}
      </section>
    </div>
  );
}
