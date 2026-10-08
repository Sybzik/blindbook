// The vault window: open an existing vault (passphrase, or Face ID through a passkey), make a
// new one (12 words, then how it opens), or restore from 12 words (zero-query restore).

import { useState } from 'react';
import { KeyButton, LeaderRow, TextInput, UnlockKeyhole } from '../../ds';
import { InstallHint, Win } from '../win';
import { app, createVault, newWords, prfSupported, restoreFromWords, unlockWithPasskey, unlockWithPassphrase } from '../../app/services';
import { useStore } from '../../app/store';
import { coinLabel } from '../../app/format';
import { config } from '../../app/config';
import { WordCheck, WordList } from '../WordCheck';

type Mode = 'unlock' | 'choose' | 'words' | 'confirm' | 'secure' | 'restore' | 'restored';

export function VaultWindow({ onOpen, onDismiss }: { onOpen: () => void; onDismiss?: () => void }) {
  const vault = useStore(app, (s) => s.vault);
  const wraps = useStore(app, (s) => s.wraps);
  const [mode, setMode] = useState<Mode>(vault === 'none' ? 'choose' : 'unlock');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [st, setSt] = useState<'idle' | 'unlocking' | 'unlocked' | 'error'>('idle');
  const [closing, setClosing] = useState(false);
  const [words, setWords] = useState('');
  const [typed, setTyped] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ slips: number; trades: number; balance: number; foreign: number } | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  const [usePass, setUsePass] = useState(false);
  const phone = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const hasPrf = wraps.some((w) => w.kind === 'prf');
  const hasPass = wraps.some((w) => w.kind === 'pass');
  const done = () => {
    setSt('unlocked');
    setTimeout(() => setClosing(true), 500);
  };

  const unlock = async () => {
    if (!pass) {
      setErr('Type your passphrase first. It never leaves this computer.');
      return;
    }
    setSt('unlocking');
    try {
      await unlockWithPassphrase(pass);
      done();
    } catch (e) {
      setSt('error');
      setErr(String((e as Error).message));
    }
  };

  const faceId = async () => {
    setSt('unlocking');
    try {
      await unlockWithPasskey();
      done();
    } catch (e) {
      setSt('error');
      setErr(String((e as Error).message));
    }
  };

  const secure = async (withPasskey: boolean) => {
    if (!withPasskey && (pass.length < 8 || pass !== pass2)) {
      setErr(pass.length < 8 ? 'At least 8 characters.' : 'The two passphrases differ.');
      return;
    }
    setErr(null);
    try {
      await createVault(words, withPasskey ? (pass && pass === pass2 ? pass : null) : pass, withPasskey, backedUp);
      done();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const restore = async () => {
    if (pass.length < 8 || pass !== pass2) {
      setErr(pass.length < 8 ? 'Choose a passphrase of at least 8 characters for this device.' : 'The two passphrases differ.');
      return;
    }
    setErr(null);
    try {
      const r = await restoreFromWords(typed, pass, setProgress);
      setSummary({ slips: r.slips.length, trades: r.trades.length, balance: app.get().balance, foreign: r.foreign.length });
      setMode('restored');
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setProgress(null);
    }
  };

  const shell = (title: string, body: React.ReactNode) => (
    <Win title={title} closable={!!onDismiss && !closing} onClose={onDismiss} resizable={false} maxWidth={520} style={{ alignSelf: 'center', width: '100%', marginTop: 24 }} closing={closing} onClosed={onOpen}>
      {body}
      {err && <p className="bb-conditions" style={{ color: 'var(--alarm)' }} role="status">{err}</p>}
      {onDismiss && (mode === 'choose' || mode === 'unlock') && (
        <p className="bb-ui bb-dim" style={{ textAlign: 'center', margin: '16px 0 0' }}>
          <button type="button" className="bb-link" onClick={onDismiss}>look around first: markets, verify and how it works need no vault</button>
        </p>
      )}
    </Win>
  );

  if (mode === 'unlock' && phone && hasPrf && !usePass)
    return shell(
      'VAULT · LOCKED',
      <UnlockKeyhole device="phone" state={st === 'unlocking' ? 'prompt' : st} error={err ?? undefined} onUnlock={faceId}
        onUsePassphrase={() => (hasPass ? setUsePass(true) : setMode('restore'))} />,
    );

  if (mode === 'unlock')
    return shell(
      'VAULT · LOCKED',
      <>
        {hasPass && (
          <UnlockKeyhole device="desktop" state={st} passphrase={pass} onPassphrase={(v: string) => { setPass(v); setErr(null); }} error={err ?? undefined} onUnlock={unlock} onForgot={() => { setMode('restore'); setErr(null); }} />
        )}
        {hasPrf && (
          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <KeyButton onClick={faceId} loading={st === 'unlocking'}>UNLOCK WITH FACE ID</KeyButton>
          </div>
        )}
        {!hasPass && (
          <p className="bb-ui bb-dim" style={{ textAlign: 'center' }}>
            <button type="button" className="bb-link" onClick={() => setMode('restore')}>forgot it? restore from 12 words</button>
          </p>
        )}
      </>,
    );

  if (mode === 'choose')
    return shell(
      'VAULT · NEW HERE',
      <div className="col" style={{ gap: 16 }}>
        <p className="bb-text" style={{ margin: 0 }}>
          No account, no email. Your balance is a set of slips kept in a vault on this device, and 12 words bring it back anywhere.
        </p>
        <InstallHint />
        <KeyButton onClick={() => { setWords(newWords()); setMode('words'); }}>NEW VAULT</KeyButton>
        <KeyButton variant="secondary" onClick={() => setMode('restore')}>RESTORE FROM 12 WORDS</KeyButton>
      </div>,
    );

  if (mode === 'words')
    return shell(
      'VAULT · YOUR 12 WORDS',
      <div className="col" style={{ gap: 16 }}>
        <p className="bb-text" style={{ margin: 0 }}>Write these down on paper, in order. They are the only way back if this device is lost. Nobody else has them, including us.</p>
        <WordList words={words} />
        <KeyButton onClick={() => setMode('confirm')}>I WROTE THEM DOWN</KeyButton>
      </div>,
    );

  if (mode === 'confirm')
    return shell(
      'VAULT · STAMP YOUR WORDS',
      <WordCheck
        words={words}
        onDone={() => {
          setBackedUp(true);
          setMode('secure');
        }}
        onLater={config.network === 'testnet' ? () => setMode('secure') : undefined}
      />,
    );

  if (mode === 'secure')
    return shell(
      'VAULT · HOW IT OPENS',
      <div className="col" style={{ gap: 16 }}>
        {phone && prfSupported() && (
          <>
            <p className="bb-text" style={{ margin: 0 }}>Face ID opens the vault. The key never leaves this phone.</p>
            <KeyButton onClick={() => secure(true)}>USE FACE ID</KeyButton>
            <p className="bb-label" style={{ margin: 0 }}>OR A PASSPHRASE</p>
          </>
        )}
        <TextInput label="PASSPHRASE" type="password" value={pass} onChange={setPass} message="At least 8 characters. It never leaves this computer." />
        <TextInput label="AGAIN" type="password" value={pass2} onChange={setPass2} />
        <KeyButton variant={phone && prfSupported() ? 'secondary' : 'primary'} onClick={() => secure(false)}>LOCK IT WITH THIS PASSPHRASE</KeyButton>
        {!phone && prfSupported() && (
          <p className="bb-ui bb-dim" style={{ margin: 0 }}>
            <button type="button" className="bb-link" onClick={() => secure(true)}>or use a passkey (Touch ID, Windows Hello, a security key)</button>
          </p>
        )}
      </div>,
    );

  if (mode === 'restore')
    return shell(
      'VAULT · RESTORE',
      <div className="col" style={{ gap: 16 }}>
        <p className="bb-text" style={{ margin: 0 }}>
          Type your 12 words. Your slips are found in the public log that every visitor downloads; nothing about you is sent.
        </p>
        <textarea className="tk-note" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="twelve words, in order" rows={3} />
        <TextInput label="NEW PASSPHRASE" type="password" value={pass} onChange={setPass} message="For this device." />
        <TextInput label="AGAIN" type="password" value={pass2} onChange={setPass2} />
        <KeyButton loading={!!progress} disabled={!!progress} onClick={restore}>{progress ?? 'RESTORE'}</KeyButton>
        {vault !== 'none' && <KeyButton variant="secondary" size="sm" onClick={() => setMode('unlock')}>BACK</KeyButton>}
      </div>,
    );

  return shell(
    'VAULT · RESTORED',
    <div className="col" style={{ gap: 12 }}>
      <LeaderRow label="SLIPS FOUND" value={summary?.slips ?? 0} tone="hi" />
      <LeaderRow label="TRADES FOUND" value={summary?.trades ?? 0} />
      <LeaderRow label="FREE BALANCE" value={coinLabel(summary?.balance ?? 0)} />
      {!!summary?.foreign && (
        <p className="bb-conditions" style={{ color: 'var(--alarm)' }} role="alert">
          WARNING: the public log uses {summary.foreign} key set{summary.foreign === 1 ? '' : 's'} not derived from the key this app pins. That can single out users. Nothing from them was trusted; run P400 VERIFY and report it (SECURITY.md).
        </p>
      )}
      <KeyButton onClick={done}>OPEN THE DESK</KeyButton>
    </div>,
  );
}
