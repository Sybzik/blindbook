// P500 how it works: four steps, what is public and what never is, the five layers, and who can
// learn what, in plain words. The build's own state is shown honestly (mixnet on or off).

import { useState } from 'react';
import { KeyButton, LeaderRow, TeletextHeader } from '../../ds';
import { Win } from '../win';
import { config, COIN } from '../../app/config';

const STEPS: [string, string, string][] = [
  ['1', 'TOP UP', `Pay a standard amount from the shielded balance of any Zcash wallet to a one-time address. No account, no email.`],
  ['2', 'BET', 'Pick an outcome and press BUY. It fills in a 2-second sealed batch, from your private balance.'],
  ['3', 'HOLD SLIPS', 'Each bet is a bearer slip in the vault on your device. Sell it, hand it over as a code, or print it.'],
  ['4', 'CASH OUT', `A winning share pays 1 ${COIN}. Withdraw to a fresh shielded address; we forget it once paid.`],
];

const LAYERS: [string, string, string][] = [
  ['FUNDING', 'Who paid?', 'A shielded top-up to a one-time address that nobody can recognise as ours.'],
  ['POSITIONS', 'Who holds what?', 'Blind-signed bearer slips: the signer signs without seeing, so a top-up, a bet and a payout cannot be linked, even by us.'],
  ['PAYOUT', 'Where did the money go?', 'Fixed-shape shielded batches with a discarded outgoing viewing key; the address is sealed to an isolated signer and forgotten.'],
  ['NETWORK', 'Who is online?', 'Every request goes through the Nym mixnet, so no IP reaches us; money in and out uses a separate mixnet identity.'],
  ['DEVICE', "What's on your phone?", 'An encrypted vault (Face ID on phones, a passphrase on computers), 12 words as the backup, and a restore that asks the server nothing.'],
];

const WHO: [string, string][] = [
  ['A chain observer', 'sees shielded transactions, not who, how much or why'],
  ['Us, or anyone who hacks the server', 'sees bets and blind slips, never which person or which payout'],
  ['Your internet provider', 'sees that this app was loaded and that the mixnet is used, not what you bet'],
  ['The web host', 'sees the app being loaded, never what you do in it (after the first visit it loads from your device)'],
  ['The mixnet’s entry node', 'sees that your device runs a mixnet client, not which site it is for or what it sends'],
  ['An exchange you withdrew from', 'sees a payment to a one-time address that is not linked to Blindbook'],
  ['Someone with your phone', 'sees nothing without your Face ID or passphrase'],
];

export function HowPage({ onClose, onOpen }: { onClose: () => void; onOpen?: (id: string) => void }) {
  const [tab, setTab] = useState<'steps' | 'public' | 'layers' | 'who'>('steps');
  // A function, not a component: a component declared here would remount on every render.
  const tabKey = (id: typeof tab, children: React.ReactNode) => (
    <KeyButton key={id} variant={tab === id ? 'primary' : 'secondary'} size="sm" onClick={() => setTab(id)} aria-pressed={tab === id}>
      {children}
    </KeyButton>
  );
  return (
    <Win title="P500 · HOW IT WORKS" onClose={onClose}>
      <TeletextHeader page="P500" title="THE PRICE IS PUBLIC. YOU ARE NOT." />
      <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        {tabKey('steps', 'FOUR STEPS')}
        {tabKey('public', 'PUBLIC · HIDDEN')}
        {tabKey('layers', 'FIVE LAYERS')}
        {tabKey('who', 'WHO SEES WHAT')}
      </div>
      {tab === 'steps' && (
        <div className="tk-how">
          {STEPS.map(([n, t, d]) => (
            <div key={n}>
              <span className="bb-display-md bb-glow bb-hi">{n}</span>
              <span className="bb-label bb-hi">{t}</span>
              <p className="bb-text" style={{ margin: 0 }}>{d}</p>
            </div>
          ))}
        </div>
      )}
      {tab === 'public' && (
        <div className="tk-cols">
          <div>
            <p className="bb-label bb-hi">PUBLIC, FOR ANYONE TO CHECK</p>
            <ul className="tk-list bb-text">
              <li>prices and volumes</li>
              <li>every batch: orders and fills, participants redacted</li>
              <li>every slip issued and every slip spent</li>
              <li>the reserve and every payout total</li>
              <li>Polymarket's result, read from Polygon</li>
            </ul>
          </div>
          <div>
            <p className="bb-label bb-hi">NEVER PUBLIC, NOT EVEN TO US</p>
            <ul className="tk-list bb-text">
              <li>who you are</li>
              <li>which bets are yours</li>
              <li>your balance</li>
              <li>your top-up and payout addresses</li>
              <li>your IP</li>
            </ul>
          </div>
        </div>
      )}
      {tab === 'layers' && (
        <div style={{ marginTop: 16, maxWidth: 820 }}>
          {LAYERS.map(([l, q, a], i) => (
            <div key={l} className="tk-layer">
              <span className="bb-display-md bb-hi">{i + 1}</span>
              <div>
                <p className="bb-label bb-hi" style={{ margin: 0 }}>{l} · {q}</p>
                <p className="bb-text" style={{ margin: '4px 0 0' }}>{a}</p>
              </div>
            </div>
          ))}
          <p className="bb-ui bb-dim">
            This build: {config.mixnet ? 'requests go through the Nym mixnet.' : config.onion ? 'the .onion mirror: requests go through Tor to the onion service.' : 'DEVELOPMENT, requests go straight to the server (no mixnet).'} Network: {config.network}.
          </p>
        </div>
      )}
      {tab === 'who' && (
        <div style={{ marginTop: 16, maxWidth: 820 }}>
          {WHO.map(([who, sees]) => (
            <LeaderRow key={who} label={who.toUpperCase()} value={sees} />
          ))}
          <p className="bb-text">
            Every known leak and what closes it is in the threat model, published with the source. Privacy here holds by construction (shielded Zcash, blind signatures,
            the mixnet), not by a promise.
          </p>
        </div>
      )}
      {onOpen && (
        <div className="row" style={{ gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
          <KeyButton size="sm" variant="secondary" onClick={() => onOpen('record')} data-hint="The exact record the server stored for your last request.">P600 · WHAT WE KNOW ABOUT YOU</KeyButton>
          <KeyButton size="sm" variant="secondary" onClick={() => onOpen('pass')} data-hint="Your anonymity card. A new random face every time you save it.">NOBODY PASS</KeyButton>
          <KeyButton size="sm" variant="secondary" onClick={() => onOpen('verify')}>P400 · VERIFY</KeyButton>
        </div>
      )}
    </Win>
  );
}
