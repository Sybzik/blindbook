// Every page window floats on the desktop: draggable, resizable, the hint strip at the bottom.

import { createContext, useContext, type ReactNode } from 'react';
import { TerminalWindow } from '../ds';

export const WinCtx = createContext<{ narrow: boolean; hint: ReactNode }>({ narrow: false, hint: null });

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
