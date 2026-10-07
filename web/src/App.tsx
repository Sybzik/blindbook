// Landing (the booth) → boot → the desk. A proof link ("#p=…") skips straight to the verifier,
// and the address bar is cleaned at once so the proof never stays in history.

import { useEffect, useState } from 'react';
import { BootSequence } from './ds';
import { Landing } from './ui/Landing.jsx';
import { Desk } from './ui/Desk';
import { app, start } from './app/services';
import { useStore } from './app/store';
import { COIN, config } from './app/config';
import { ui } from './ui/uistate';
import { play } from './ui/sound';

const initialProof = location.hash.startsWith('#p=') ? location.hash : undefined;
if (location.hash || location.search) history.replaceState(null, '', location.pathname);

export function App() {
  const [proof, setProof] = useState(initialProof);
  const [phase, setPhase] = useState<'landing' | 'boot' | 'desk'>(proof ? 'desk' : 'landing');
  const [intro, setIntro] = useState(0);
  const [initial, setInitial] = useState<string | undefined>(undefined);
  const head = useStore(app, (s) => s.head);
  const markets = useStore(app, (s) => s.markets);
  const live = useStore(app, (s) => s.live);
  const link = useStore(app, (s) => s.link);
  const clean = useStore(ui, (s) => s.clean);
  const theme = useStore(ui, (s) => s.theme);

  useEffect(() => {
    void start();
    // A proof link pasted into an open tab: take it, clean the address bar, check it.
    const onHash = () => {
      if (!location.hash.startsWith('#p=')) return;
      setProof(location.hash);
      history.replaceState(null, '', location.pathname);
      setPhase('desk');
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (theme === 'green') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  const lm = (i: number) => live?.markets.find((m) => m.id === markets[i]?.id);
  const pa = (i: number) => (lm(i)?.price_a_ppm ? Math.round(lm(i)!.price_a_ppm! / 10_000) : null);
  const prices = pa(0) !== null ? { a: pa(0)!, b: 100 - pa(0)!, y: pa(1) ?? pa(0)! } : undefined;

  if (phase === 'landing')
    return (
      <div data-signal={clean ? 'clean' : undefined}>
        <Landing
          key={intro}
          block={head?.height ?? 0}
          markets={markets.length}
          link={config.mixnet ? link : 'off'}
          coin={COIN}
          prices={prices}
          onEnter={(to?: string) => {
            setInitial(to);
            play('boot');
            setPhase('boot');
          }}
        />
      </div>
    );
  if (phase === 'boot')
    return (
      <div className="tk-boot-screen" data-signal={clean ? 'clean' : undefined}>
        <BootSequence animate={!clean} onDone={() => setPhase('desk')} />
      </div>
    );
  return (
    <Desk
      initial={initial}
      proof={proof}
      onIntro={() => {
        setIntro((i) => i + 1);
        setPhase('landing');
      }}
    />
  );
}
