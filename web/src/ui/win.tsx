// Every page window floats on the desktop: draggable, resizable, the hint strip at the bottom.

import { Component, createContext, useContext, type ReactNode } from 'react';
import { KeyButton, TerminalWindow } from '../ds';
import { openWindow } from './uistate';
import { app } from '../app/services';
import { useStore } from '../app/store';

export const WinCtx = createContext<{ narrow: boolean; hint: ReactNode; pager?: boolean }>({ narrow: false, hint: null });

export function Win(props: {
  title: ReactNode;
  onClose?: () => void;
  closable?: boolean;
  resizable?: boolean;
  maxWidth?: number | string;
  style?: React.CSSProperties;
  closing?: boolean;
  onClosed?: () => void;
  children?: ReactNode;
}) {
  const c = useContext(WinCtx);
  // On the pager a page is a channel: full screen, no window chrome.
  if (c.pager)
    return (
      <section className={'pg-chan' + (props.closing ? ' is-closing' : '')} aria-label={typeof props.title === 'string' ? props.title : undefined} onAnimationEnd={props.closing ? props.onClosed : undefined}>
        {props.children}
      </section>
    );
  return <TerminalWindow draggable={!c.narrow} resizable={!c.narrow && props.resizable !== false} hint={c.hint} {...props} />;
}

export const HINTS: Record<string, string> = {
  market: 'Pick an outcome, pick an amount, press BUY. The line under the key says exactly how it fills.',
  markets: 'Every market mirrors Polymarket. Click a row to open it.',
  slips: 'Slips are bearer e-cash. Whoever holds one can cash it in.',
  cage: 'Top up from your wallet, redeem a code, or withdraw to a fresh address.',
  verify: 'Replays the public log in your browser. Nothing is sent anywhere.',
  how: 'Four steps: top up, bet, hold slips, cash out.',
  snake: 'Arrow keys or WASD. Eat notes; crossing your own trail spends a nullifier twice.',
  calc: 'Turns a price into chance and payout. Runs on this computer only.',
  tracker: 'A tracker made of redaction bars. Runs on this computer only.',
  deaddrop: 'Notes for yourself, encrypted in the vault. Never sent.',
  radio: 'Block sounds from the chain. Runs on this computer only.',
  called: 'Private by default. Sharing the link proves the call and nothing else.',
  lock: 'Your passphrase never leaves this computer.',
  record: 'Everything the server stored about you, from its own answers.',
};

/** "Open it first" on pages that need the vault: one key back to it. */
export function OpenVault({ children }: { children: ReactNode }) {
  return (
    <div className="col" style={{ gap: 10, alignItems: 'flex-start' }}>
      <p className="bb-text" style={{ margin: 0 }}>{children}</p>
      <KeyButton size="sm" icon="lock" onClick={() => openWindow('vault')}>OPEN THE VAULT</KeyButton>
    </div>
  );
}

/** iPhone Safari shows no install prompt: say how, and why (its own storage, no 7-day wipe). */
export function InstallHint() {
  const ios = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
  const installed =
    typeof window !== 'undefined' && ((navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches);
  if (!ios || installed) return null;
  return (
    <div className="tk-install" role="note">
      <p className="bb-label bb-hi" style={{ margin: 0 }}>INSTALL IT FIRST</p>
      <p className="bb-ui" style={{ margin: '4px 0 0' }}>
        In Safari: Share <span aria-hidden="true">⎋</span> → <b>Add to Home Screen</b>. The installed app keeps its own storage, which iOS doesn't wipe after a week away, and
        opens without loading anything. A vault made here in Safari stays in Safari.
      </p>
    </div>
  );
}

/** Requests that got no answer, settled from the public log with each block. */
export function DoubtLine() {
  const n = useStore(app, (s) => s.doubts);
  if (!n) return null;
  return (
    <p className="bb-conditions" role="status">
      {n === 1 ? 'A request' : `${n} requests`} got no answer, so the public log is checked with each new block. The slips involved are held back until it shows what happened; nothing is lost.
    </p>
  );
}

/** A window whose page throws while rendering shows what happened in its own frame; the desk,
 *  the other windows and the vault carry on (a malformed answer from the server, or a bug). */
export class WindowGuard extends Component<{ title: ReactNode; onClose: () => void; children?: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };

  static getDerivedStateFromError(e: unknown) {
    return { error: String((e as Error)?.message ?? e).slice(0, 200) };
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <Win title={this.props.title} onClose={this.props.onClose} maxWidth={560}>
        <p className="bb-display-md bb-alarm">THIS WINDOW STOPPED</p>
        <p className="bb-text" style={{ marginTop: 12 }}>
          Something it was showing didn't make sense ({this.state.error}). Your vault and your slips are untouched, and the other windows keep working.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
          <KeyButton onClick={() => this.setState({ error: null })}>TRY AGAIN</KeyButton>
          <KeyButton variant="secondary" onClick={this.props.onClose}>CLOSE</KeyButton>
        </div>
      </Win>
    );
  }
}
