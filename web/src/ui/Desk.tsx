// The desktop: wallpaper, page icons (F1–F5), the back-room apps, up to four windows (one in
// focus, the rest on the taskbar), the console, alarms, the vault, the screensaver.

import { useEffect, useRef, useState } from 'react';
import { APP_ICONS, AlarmBanner, AppIcons, DesktopIcons, StartMenu, Taskbar, TeletextHeader, Wallpaper } from '../ds';
import { WinCtx, HINTS, Win } from './win';
import { app, lockVault } from '../app/services';
import { useStore } from '../app/store';
import { COIN, config } from '../app/config';
import { coin } from '../app/format';
import { CalledItPage, MarketPage, MarketsIndex, type FilledSlip } from './pages/Market';
import { SlipsPage } from './pages/Slips';
import { CagePage } from './pages/Cage';
import { VerifyPage } from './pages/Verify';
import { HowPage } from './pages/How';
import { RecordPage } from './pages/Record';
import { PassPage } from './pages/Pass';
import { AppWindow } from './pages/Apps';
import { VaultWindow } from './pages/Vault';
import { Console } from './Console';
import { Screensaver } from './Screensaver';
import { runCommand, type DeskApi } from './commands';
import { ui } from './uistate';
import { play, setSound } from './sound';

const MAX_WINDOWS = 4;
const IDLE_MS = 120_000;
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

const TITLES: Record<string, string> = {
  markets: 'P100 · MARKETS',
  slips: 'P300 · SLIPS',
  cage: 'P350 · CAGE',
  verify: 'P400 · VERIFY',
  how: 'P500 · HOW IT WORKS',
  record: 'P600 · WHAT WE KNOW',
  pass: 'P601 · NOBODY PASS',
};
for (const a of APP_ICONS as { id: string; page: string; label: string }[]) TITLES[a.id] = `${a.page} · ${a.label}`;

const TELETEXT: Record<string, [string, string]> = {
  '404': ['PAGE NOT FOUND', 'page not found. neither are you.'],
  '1984': ['BIG BROTHER', 'big brother is not watching. we checked.'],
  '0': ['CREDITS', 'Built on Zcash and librustzcash, the Nym mixnet, Cashu\'s blind signatures, Polymarket\'s public data and Polygon. Thank you to everyone who keeps shielded money honest, including the researchers who find the bugs.'],
};

export function Desk({ initial, proof, onIntro }: { initial?: string; proof?: string; onIntro: () => void }) {
  const vault = useStore(app, (s) => s.vault);
  const link = useStore(app, (s) => s.link);
  const head = useStore(app, (s) => s.head);
  const balance = useStore(app, (s) => s.balance);
  const positions = useStore(app, (s) => s.positions);
  const markets = useStore(app, (s) => s.markets);
  const clean = useStore(ui, (s) => s.clean);
  const sound = useStore(ui, (s) => s.sound);
  const first = initial ?? (proof ? 'verify' : 'markets');
  const [open, setOpen] = useState<string[]>([first]);
  const [page, setPage] = useState(first);
  const [mid, setMid] = useState<string | null>(null);
  const [called, setCalled] = useState<FilledSlip | null>(null);
  const [narrow, setNarrow] = useState(() => innerWidth < 900);
  const [startOpen, setStartOpen] = useState(false);
  const [con, setCon] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  // Someone opening a proof link came to check it, not to open a vault.
  const [vaultWin, setVaultWin] = useState(vault !== 'unlocked' && !proof);
  const firstVault = useRef(true);
  const [idle, setIdle] = useState(false);
  const [insider, setInsider] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const lastEsc = useRef(0);
  const digits = useRef<{ s: string; t: number }>({ s: '', t: 0 });
  const konami = useRef(0);

  useEffect(() => {
    const r = () => setNarrow(innerWidth < 900);
    addEventListener('resize', r);
    return () => removeEventListener('resize', r);
  }, []);
  useEffect(() => setSound(sound), [sound]);
  useEffect(() => {
    if (vault === 'checking') return;
    const first = firstVault.current;
    firstVault.current = false;
    if (first && proof) return;
    if (vault === 'locked' || vault === 'none') setVaultWin(true);
  }, [vault]);
  useEffect(() => {
    if (!proof) return;
    setVaultWin(false);
    go('verify');
  }, [proof]);
  // The split-flap block clock clacks on every new block (when sound is on).
  const lastHeight = useRef(0);
  useEffect(() => {
    if (!head) return;
    if (lastHeight.current && head.height !== lastHeight.current) play('flap');
    lastHeight.current = head.height;
  }, [head?.height]);

  const go = (id: string) => {
    setCalled(null);
    setHint(null);
    setStartOpen(false);
    setOpen((o) => {
      if (o.includes(id)) return o;
      let n = o;
      if (n.length >= MAX_WINDOWS) {
        const victim = n.find((x) => x !== page);
        n = n.filter((x) => x !== victim);
      }
      return [...n, id];
    });
    setPage(id);
    play('click');
  };
  const openMarket = (id: string) => {
    setMid(id);
    go('market');
  };
  const close = (id: string) => {
    setCalled(null);
    const rest = open.filter((p) => p !== id);
    const next = rest.length ? rest : ['markets'];
    setOpen(next);
    if (page === id || !rest.length) setPage(next[next.length - 1]!);
  };
  const lock = () => {
    setLeaving(true);
    setTimeout(() => {
      lockVault();
      setVaultWin(true);
      setLeaving(false);
    }, 1400);
  };

  const desk: DeskApi = {
    open: go,
    openMarket: (p) => {
      const m = markets.find((x) => x.page === p);
      if (!m) return false;
      openMarket(m.id);
      return true;
    },
    teletext: (p) => {
      if (!TELETEXT[p]) return false;
      go('tt:' + p);
      return true;
    },
    lock,
    intro: onIntro,
    closeConsole: () => setCon(false),
    insider: () => {
      setInsider(true);
      setTimeout(() => setInsider(false), 4200);
    },
  };

  // Keyboard: console (` or Ctrl/⌘+K), ESC ESC leaves the booth, three digits open a page,
  // the Konami code. Never while typing in a field.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest?.('input,textarea,[contenteditable]');
      if (e.key === '`' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
        if (typing && e.key === '`') return;
        e.preventDefault();
        setCon((c) => !c);
        return;
      }
      if (e.key === 'Escape') {
        const now = Date.now();
        if (now - lastEsc.current < 450 && vault === 'unlocked') lock();
        lastEsc.current = now;
      }
      konami.current = e.key === KONAMI[konami.current] ? konami.current + 1 : e.key === KONAMI[0] ? 1 : 0;
      if (konami.current === KONAMI.length) {
        konami.current = 0;
        desk.insider();
      }
      if (typing || con) return;
      // Teletext: type a page number (201, 300, 404, 1984, 0…); it opens after a short pause.
      if (/^[0-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        clearTimeout(digits.current.t);
        const d = (digits.current.s + e.key).slice(-4);
        digits.current = { s: d, t: window.setTimeout(() => {
          digits.current = { s: '', t: 0 };
          void runCommand('open ' + d, () => undefined, desk);
        }, 900) };
      }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });

  // Two idle minutes bring the screensaver.
  useEffect(() => {
    let t = setTimeout(() => setIdle(true), IDLE_MS);
    const reset = () => {
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), IDLE_MS);
    };
    const evs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    evs.forEach((e) => addEventListener(e, reset, { passive: true }));
    return () => {
      clearTimeout(t);
      evs.forEach((e) => removeEventListener(e, reset));
    };
  }, []);

  const onHover = (e: React.SyntheticEvent) => {
    const el = (e.target as HTMLElement).closest?.('[data-hint]');
    if (el) setHint(el.getAttribute('data-hint'));
  };

  const mixnet = config.mixnet ? link : 'linked';
  const rail = [
    { id: 'markets', fkey: 'F1', label: 'MARKETS', icon: 'markets', led: mixnet === 'linked', alert: mixnet === 'down' },
    { id: 'slips', fkey: 'F2', label: 'SLIPS', icon: 'slips', indicator: vault === 'unlocked' ? String(positions.length) : undefined },
    { id: 'cage', fkey: 'F3', label: 'CAGE', icon: 'cage', indicator: vault === 'unlocked' ? coin(balance, 3) : undefined },
    { id: 'verify', fkey: 'F4', label: 'VERIFY', icon: 'verify', indicator: '✓' },
    { id: 'how', fkey: 'F5', label: 'HOW', icon: 'how' },
  ];
  const market = markets.find((m) => m.id === mid);
  const titleOf = (id: string) => (id === 'market' ? `${market?.page ?? 'P2xx'} · MARKET` : id.startsWith('tt:') ? `P${id.slice(3)} · TELETEXT` : TITLES[id] ?? id);
  const isApp = (id: string) => (APP_ICONS as { id: string }[]).some((a) => a.id === id);
  const showVault = vaultWin && vault !== 'unlocked' && vault !== 'checking';
  const focused = showVault ? 'vault' : page;

  const render = (id: string) => {
    const onClose = () => close(id);
    if (id === 'market') {
      if (called) return <CalledItPage slip={called} onBack={() => setCalled(null)} />;
      return mid ? <MarketPage id={mid} onClose={onClose} onCalledIt={setCalled} /> : <MarketsIndex onOpen={openMarket} onClose={onClose} />;
    }
    if (id === 'markets') return <MarketsIndex onOpen={openMarket} onClose={onClose} />;
    if (id === 'slips') return <SlipsPage onClose={onClose} />;
    if (id === 'cage') return <CagePage onClose={onClose} />;
    if (id === 'verify') return <VerifyPage key={proof ?? 'verify'} onClose={onClose} proof={proof} />;
    if (id === 'how') return <HowPage onClose={onClose} onOpen={go} />;
    if (id === 'record') return <RecordPage onClose={onClose} />;
    if (id === 'pass') return <PassPage onClose={onClose} />;
    if (id.startsWith('tt:')) {
      const [t, msg] = TELETEXT[id.slice(3)]!;
      return (
        <Win title={titleOf(id)} onClose={onClose} maxWidth={640} style={{ alignSelf: 'center', width: '100%' }}>
          <TeletextHeader page={'P' + id.slice(3)} title={t} />
          <p className="bb-display-md bb-glow bb-hi" style={{ marginTop: 24 }}>{msg}</p>
        </Win>
      );
    }
    if (isApp(id)) return <AppWindow app={id} active={page === id && !con && !startOpen && !showVault} onClose={onClose} onOpen={go} />;
    return null;
  };

  const tabs = [
    ...(showVault ? [{ id: 'vault', title: vault === 'none' ? 'VAULT · NEW' : 'VAULT · LOCKED' }] : []),
    ...open.map((id) => ({ id, title: id === 'market' && called ? 'CALLED IT' : titleOf(id) })),
  ];
  const defHint = showVault ? HINTS.lock : called ? HINTS.called : HINTS[page.startsWith('tt:') ? 'how' : page];

  return (
    <div className="tk-app" data-signal={clean ? 'clean' : undefined} onMouseOver={onHover} onFocus={onHover}>
      <Wallpaper className="tk-desk">
        <DesktopIcons className="tk-icons" layout={narrow ? 'row' : 'column'} items={rail} selected={showVault ? undefined : page === 'market' ? 'markets' : page} onSelect={(id: string) => { setVaultWin(false); go(id); }} bindFKeys />
        <AppIcons className="tk-apps" layout={narrow ? 'row' : 'column'} selected={showVault ? undefined : page} onSelect={(id: string) => { setVaultWin(false); go(id); }} />
        <div className="tk-stage">
          {config.mixnet && link === 'down' && (
            <AlarmBanner title="MIXNET LINK LOST" action="" onAction={undefined}>
              Reconnecting… your balance is safe. Trading is locked until the link is back; nothing is ever sent around the mixnet.
            </AlarmBanner>
          )}
          {head?.halted && (
            <AlarmBanner title="SERVICE HALTED" action="" onAction={undefined}>
              The server stopped itself after a consistency check. Your slips keep their value; trading resumes once it is resolved.
            </AlarmBanner>
          )}
          <WinCtx.Provider value={{ narrow, hint: hint ?? defHint }}>
            {showVault && <VaultWindow key={vault} onOpen={() => setVaultWin(false)} onDismiss={() => setVaultWin(false)} />}
            {open.map((id) => (
              <div key={id === 'market' ? 'market:' + mid : id} className="tk-win" hidden={showVault || id !== page}>
                {render(id)}
              </div>
            ))}
          </WinCtx.Provider>
        </div>
        {con && (
          <div className="tk-console">
            <Console onClose={() => setCon(false)} run={(c, out) => runCommand(c, out, desk)} height={narrow ? 240 : 300} />
          </div>
        )}
        {insider && (
          <div className="tk-insider" role="status">
            <p className="bb-display-lg bb-glow bb-hi">INSIDER MODE</p>
            <p className="bb-ui-lg">we can't tell who you are. that includes insiders.</p>
          </div>
        )}
        {leaving && (
          <div className="tk-leave" role="status">
            <p className="bb-display-lg bb-glow bb-hi">NOTHING OF YOU STAYS BEHIND</p>
          </div>
        )}
      </Wallpaper>
      <Taskbar
        balance={vault === 'unlocked' ? coin(balance) : '—'}
        unit={COIN}
        mixnet={config.mixnet ? (link === 'linking' ? 'relinking' : link) : 'off'}
        block={head?.height ?? 0}
        windows={tabs}
        focused={focused}
        onWindow={(id: string) => {
          if (id === 'vault') return setVaultWin(true);
          setVaultWin(false);
          setCalled(null);
          setPage(id);
        }}
        startOpen={startOpen}
        onStartToggle={setStartOpen}
        startMenu={
          <StartMenu
            onSelect={(id: string) => { setVaultWin(false); go(id); }}
            onApp={(id: string) => { setVaultWin(false); go(id); }}
            onReplayIntro={() => { setStartOpen(false); onIntro(); }}
            onConsole={() => { setStartOpen(false); setCon((c) => !c); }}
            clean={clean}
            onToggleClean={(v: boolean) => ui.set({ clean: v })}
            sound={sound}
            onToggleSound={(v: boolean) => ui.set({ sound: v })}
            onLock={vault === 'unlocked' ? () => { setStartOpen(false); lock(); } : undefined}
          />
        }
      />
      {idle && <Screensaver onWake={() => setIdle(false)} still={clean} />}
    </div>
  );
}
