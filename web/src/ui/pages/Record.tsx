// P600 WHAT WE KNOW ABOUT YOU: the exact record the server stored for a request, as the server
// itself returned it (kept in the vault), field by field, next to what it does not have.

import { useState } from 'react';
import { KeyButton, LeaderRow, Redacted, TeletextHeader } from '../../ds';
import { Win, OpenVault } from '../win';
import { app } from '../../app/services';
import { useStore } from '../../app/store';
import { config } from '../../app/config';
import { utc } from '../../app/format';

const KIND: Record<string, string> = {
  voucher: 'CODE REDEEMED',
  topup: 'TOP-UP',
  buy: 'BET',
  sell: 'SALE',
  redeem: 'CASH-IN',
  withdraw: 'WITHDRAWAL',
  receive: 'SLIPS TAKEN OVER',
  send: 'SLIPS HANDED OVER',
  duel_open: 'DUEL OFFERED',
  duel_take: 'DUEL TAKEN',
  duel_cancel: 'DUEL CANCELLED',
  duel_won: 'DUEL SHARES COLLECTED',
};

function show(v: unknown): string {
  if (typeof v === 'string') return v.length > 24 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v;
  if (typeof v === 'number') return v.toLocaleString('en-US');
  return JSON.stringify(v);
}

export function RecordPage({ onClose }: { onClose: () => void }) {
  const history = useStore(app, (s) => s.history);
  const vault = useStore(app, (s) => s.vault);
  const [i, setI] = useState(0);
  const list = [...history].reverse();
  const e = list[Math.min(i, Math.max(0, list.length - 1))];
  return (
    <Win title="P600 · WHAT WE KNOW" onClose={onClose}>
      <TeletextHeader page="P600" title="WHAT WE KNOW ABOUT YOU" />
      {vault !== 'unlocked' ? (
        <OpenVault>The records live in your vault. Open it first.</OpenVault>
      ) : !e ? (
        <p className="bb-text">Nothing yet. After your first request, the server's own record of it appears here, exactly as stored.</p>
      ) : (
        <div className="tk-cage tk-record">
          <div>
            <p className="bb-label bb-hi tk-sec">
              WHAT THE SERVER STORED · {KIND[e.kind] ?? e.kind.toUpperCase()} · {utc(e.at_ms)}
            </p>
            {Object.entries(e.stored).map(([k, v]) => (
              <LeaderRow key={k} label={k.replace(/_/g, ' ').toUpperCase()} value={show(v)} />
            ))}
            <p className="bb-conditions">This is the server's own answer, returned with the request and kept in your vault. The same row is in the public log, with nothing that points to you.</p>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <KeyButton size="sm" variant="secondary" disabled={i >= list.length - 1} onClick={() => setI(i + 1)}>◀ OLDER</KeyButton>
              <KeyButton size="sm" variant="secondary" disabled={i === 0} onClick={() => setI(i - 1)}>NEWER ▶</KeyButton>
              <span className="bb-ui bb-dim" style={{ alignSelf: 'center' }}>{i + 1} of {list.length}</span>
            </div>
          </div>
          <div>
            <p className="bb-label bb-hi tk-sec">WHAT IT DOES NOT HAVE</p>
            <LeaderRow label="YOUR IP" value={config.mixnet ? 'not received (mixnet)' : config.onion ? 'not received (Tor, .onion)' : 'DEV BUILD: received, no mixnet'} tone={config.mixnet || config.onion ? undefined : 'alarm'} />
            <LeaderRow label="ACCOUNT" value="none exists" />
            <LeaderRow label="NAME · EMAIL" value={<Redacted text="xxxxxxxx" />} />
            <LeaderRow label="YOUR BALANCE" value="unknown" />
            <LeaderRow label="YOUR OTHER BETS" value="unlinkable" />
            <LeaderRow label="PAYOUT ADDRESS" value="sealed, forgotten once paid" />
            <LeaderRow label="ACCESS LOG" value="none kept" />
          </div>
        </div>
      )}
    </Win>
  );
}
