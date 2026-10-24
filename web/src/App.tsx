// Landing (the booth) → boot → the desk. A proof link ("#p=…") skips straight to the verifier,
// and the address bar is cleaned at once so the proof never stays in history.

import { Suspense, lazy, useEffect, useState } from 'react';
import { BootSequence } from './ds';
import { Landing } from './ui/Landing.jsx';
import { BoothChrome } from './booth/chrome';
import { Desk } from './ui/Desk';
import { app, start } from './app/services';
import { useStore } from './app/store';
import { COIN, config } from './app/config';
import { ui } from './ui/uistate';
import { listenToCues, play, primeAudio, setSound } from './ui/sound';

// The 3D booth is its own lazy chunk; the 2D booth is the fallback (no WebGL, CLEAN SIGNAL,
// data saver, low memory, or if the 3D scene fails). While the chunk loads, the booth page's own
// chrome stands on the scene's dark, so no other scene flashes up first.
function want3d(): boolean {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  if (nav.connection?.saveData || (nav.deviceMemory !== undefined && nav.deviceMemory < 3)) return false;
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
const CAN_3D = want3d();
// Fetched from the start, not when the landing first renders.
const booth3d = CAN_3D ? import('./booth/Booth3D') : null;
const Booth3D = lazy(() => booth3d ?? import('./booth/Booth3D'));

const initialProof = location.hash.startsWith('#p=') ? location.hash : undefined;
const initialDuel = /^#d=[0-9a-f]{64}$/.test(location.hash) ? location.hash.slice(3) : undefined;
if (location.hash || location.search) history.replaceState(null, '', location.pathname);

export function App() {
  const [proof, setProof] = useState(initialProof);
  const [duel, setDuel] = useState(initialDuel);
  const [phase, setPhase] = useState<'landing' | 'boot' | 'desk'>(proof || duel ? 'desk' : 'landing');
  const [intro, setIntro] = useState(0);
  const [initial, setInitial] = useState<string | undefined>(undefined);
  const [failed3d, setFailed3d] = useState(false);
  const block = useStore(app, (s) => s.live?.block);
  const head = useStore(app, (s) => s.head);
  const markets = useStore(app, (s) => s.markets);
  const live = useStore(app, (s) => s.live);
  const link = useStore(app, (s) => s.link);
  const clean = useStore(ui, (s) => s.clean);
  const theme = useStore(ui, (s) => s.theme);
  const sound = useStore(ui, (s) => s.sound);
  // Sound follows the speaker from the landing on; the cues play their effects.
  useEffect(() => {
    listenToCues();
    primeAudio();
  }, []);
  useEffect(() => setSound(sound), [sound]);

  useEffect(() => {
    void start();
    // A proof link pasted into an open tab: take it, clean the address bar, check it.
    const onHash = () => {
      if (location.hash.startsWith('#p=')) setProof(location.hash);
      else if (/^#d=[0-9a-f]{64}$/.test(location.hash)) setDuel(location.hash.slice(3));
      else return;
      history.replaceState(null, '', location.pathname);
      setPhase('desk');
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  // The boot animation runs on animation frames, which a hidden tab doesn't get: never get stuck.
  useEffect(() => {
    if (phase !== 'boot') return;
    const t = setTimeout(() => setPhase('desk'), 4_000);
    return () => clearTimeout(t);
  }, [phase]);
  useEffect(() => {
    if (theme === 'green') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  const lm = (i: number) => live?.markets.find((m) => m.id === markets[i]?.id);
  const pa = (i: number) => (lm(i)?.price_a_ppm ? Math.round(lm(i)!.price_a_ppm! / 10_000) : null);
  // The booth's three CRTs show the first two markets, live.
  const label = (s: string | undefined) => (s ?? '').toUpperCase().slice(0, 12);
  const named = markets.findIndex((m) => !(m.outcomes[0] === 'Yes' && m.outcomes[1] === 'No'));
  const ia = named >= 0 ? named : 0;
  const iy = ia === 0 ? 1 : 0;
  const prices =
    pa(ia) !== null
      ? {
          a: pa(ia)!,
          b: 100 - pa(ia)!,
          y: pa(iy) ?? pa(ia)!,
          la: label(markets[ia]?.outcomes[0]),
          lb: label(markets[ia]?.outcomes[1]),
          ly: markets[iy] ? `${markets[iy]!.page} · ${label(markets[iy]!.outcomes[0])}` : '',
        }
      : undefined;

  const enterFromLanding = (to?: string) => {
    setInitial(to);
    play('boot');
    setPhase('boot');
  };
  const resolvedMarket = markets.find((m) => m.resolved);
  if (phase === 'landing' && CAN_3D && !clean && !failed3d)
    return (
      <Suspense
        fallback={
          <div className="ld bd">
            <BoothChrome block={head?.height ?? 0} link={config.onion ? 'tor' : config.mixnet ? (link === 'linking' ? 'relinking' : link) : 'off'} onEnter={enterFromLanding} hint={false} />
          </div>
        }
      >
        <Booth3D
          key={intro}
          data={{ block: head?.height ?? 0, markets: markets.length, coin: COIN, prices }}
          facts={{
            block: head?.height ?? 0,
            shieldedActions: block?.shielded_actions ?? null,
            resolved: resolvedMarket ? `Latest settled: ${resolvedMarket.page} · ${resolvedMarket.question}.` : null,
          }}
          link={config.onion ? 'tor' : config.mixnet ? (link === 'linking' ? 'relinking' : link) : 'off'}
          onEnter={enterFromLanding}
          onFail={() => setFailed3d(true)}
        />
      </Suspense>
    );
  if (phase === 'landing')
    return (
      <div data-signal={clean ? 'clean' : undefined}>
        <Landing
          key={intro}
          block={head?.height ?? 0}
          markets={markets.length}
          link={config.onion ? 'tor' : config.mixnet ? link : 'off'}
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
      duel={duel}
      onIntro={() => {
        setIntro((i) => i + 1);
        setPhase('landing');
      }}
    />
  );
}
