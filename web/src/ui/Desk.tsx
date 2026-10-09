// The desktop: wallpaper, page icons (F1–F5), the back-room apps, up to four windows (one in
// focus, the rest on the taskbar), the console, alarms, the vault, the screensaver.

import { useEffect, useRef, useState } from 'react';
import { APP_ICONS, AlarmBanner, AppIcons, DesktopIcons, KeyButton, MixnetLamp, PixelIcon, SplitFlap, StartMenu, Taskbar, TeletextHeader, ToggleSwitch, Wallpaper } from '../ds';
import { WinCtx, HINTS, Win, WindowGuard } from './win';
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
import { DuelsPage } from './pages/Duels';
import { VaultWindow } from './pages/Vault';
import { Console } from './Console';
import { Screensaver } from './Screensaver';
import { runCommand, type DeskApi } from './commands';
import { ui } from './uistate';
import { play, setSound } from './sound';

const MAX_WINDOWS = 4;
const IDLE_MS = 120_000;
/** The vault locks itself after 15 minutes without input, or 15 minutes in the background. */
const LOCK_MS = 15 * 60_000;
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

const TITLES: Record<string, string> = {
  markets: 'P100 · MARKETS',
  slips: 'P300 · SLIPS',
  cage: 'P350 · CAGE',
  verify: 'P400 · VERIFY',
  how: 'P500 · HOW IT WORKS',
  record: 'P600 · WHAT WE KNOW',
  duels: 'P150 · BLIND DUELS',
  pass: 'P601 · NOBODY PASS',
};
for (const a of APP_ICONS as { id: string; page: string; label: string }[]) TITLES[a.id] = `${a.page} · ${a.label}`;

const START_PAGES = [
  { id: 'markets', fkey: 'F1', label: 'MARKETS', icon: 'markets' },
  { id: 'slips', fkey: 'F2', label: 'SLIPS', icon: 'slips' },
  { id: 'cage', fkey: 'F3', label: 'CAGE', icon: 'cage' },
  { id: 'verify', fkey: 'F4', label: 'VERIFY', icon: 'verify' },
  { id: 'how', fkey: 'F5', label: 'HOW IT WORKS', icon: 'how' },
  { id: 'duels', fkey: '150', label: 'BLIND DUELS', icon: 'stamp' },
  { id: 'record', fkey: '600', label: 'WHAT WE KNOW', icon: 'eye' },
  { id: 'pass', fkey: '601', label: 'NOBODY PASS', icon: 'stamp' },
];

const TELETEXT: Record<string, [string, string]> = {
  '404': ['PAGE NOT FOUND', 'page not found. neither are you.'],
  '1984': ['BIG BROTHER', 'big brother is not watching. we checked.'],
  '0': ['CREDITS', 'Built on Zcash and librustzcash, the Nym mixnet, Cashu\'s blind signatures, Polymarket\'s public data and Polygon. Thank you to everyone who keeps shielded money honest, including the researchers who find the bugs.'],
};

/** The mixnet's state when it isn't linked, and what to do about it once the reason is clear. */
function LinkBanner({ short = false }: { short?: boolean }) {
  const link = useStore(app, (s) => s.link);
  const trouble = useStore(app, (s) => s.linkTrouble);
  if (!config.mixnet || (link !== 'down' && !trouble)) return null;
  const tor = config.onionUrl ? (
    <>
      {' '}Or open the .onion mirror in Tor Browser: <span className="bb-hi" style={{ wordBreak: 'break-all' }}>{config.onionUrl}</span>
    </>
  ) : (
    ' Or open the .onion mirror in Tor Browser.'
  );
  if (trouble === 'browser')
    return (
      <AlarmBanner title="THIS BROWSER CAN'T RUN THE MIXNET" action="" onAction={undefined}>
        Its client needs WebAssembly, which is turned off here (iPhone Lockdown Mode does that: in Safari, aA › Website Settings turns it off for this site). Nothing is sent without the mixnet.{tor}
      </AlarmBanner>
    );
  if (trouble === 'unreachable')
    return (
      <AlarmBanner title="THE MIXNET CAN'T BE REACHED FROM HERE" action="" onAction={undefined}>
        Still trying, and your balance is safe. Some networks (offices, hotels, some countries) block its connections: another network or mobile data usually works.{tor}
      </AlarmBanner>
    );
  return (
    <AlarmBanner title="MIXNET LINK LOST" action="" onAction={undefined}>
      {short ? 'Reconnecting… trading is locked; your balance is safe.' : 'Reconnecting… your balance is safe. Trading is locked until the link is back; nothing is ever sent around the mixnet.'}
    </AlarmBanner>
  );
}

export function Desk({ initial, proof, duel, onIntro }: { initial?: string; proof?: string; duel?: string; onIntro: () => void }) {
  const vault = useStore(app, (s) => s.vault);
  const link = useStore(app, (s) => s.link);
  const reachable = useStore(app, (s) => s.reachable);
  const head = useStore(app, (s) => s.head);
  const balance = useStore(app, (s) => s.balance);
  const positions = useStore(app, (s) => s.positions);
  const markets = useStore(app, (s) => s.markets);
  const clean = useStore(ui, (s) => s.clean);
  const sound = useStore(ui, (s) => s.sound);
  const first = initial ?? (proof ? 'verify' : duel ? 'duels' : 'markets');
  const [duelDraft, setDuelDraft] = useState<{ market?: string; side?: 'a' | 'b' } | undefined>(undefined);
  const request = useStore(ui, (s) => s.request);
  const [open, setOpen] = useState<string[]>([first]);
  const [page, setPage] = useState(first);
  const [mid, setMid] = useState<string | null>(null);
  const [called, setCalled] = useState<FilledSlip | null>(null);
  const [narrow, setNarrow] = useState(() => innerWidth < 900);
  // Phones get the pager: one channel at a time, a key row, swipe to change channel.
  const [phone, setPhone] = useState(() => innerWidth < 700);
  const [menu, setMenu] = useState(false);
  const [burst, setBurst] = useState(false);
  const [relink, setRelink] = useState(false);
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [con, setCon] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  // Someone opening a proof link came to check it, not to open a vault.
  const [vaultWin, setVaultWin] = useState(vault !== 'unlocked' && !proof && !duel);
  const firstVault = useRef(true);
  const [idle, setIdle] = useState(false);
  const [insider, setInsider] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [degauss, setDegauss] = useState(false);
  const redactClicks = useRef(new WeakMap<Element, number>());
  // Background events (top-up credited, duel taken, withdrawal paid) as a toast on any page.
  const notice = useStore(app, (s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    play('stamp');
    setToast(notice);
    const t = setTimeout(() => {
      setToast((x) => (x === notice ? null : x));
      app.set({ notice: null });
    }, 5_000);
    return () => clearTimeout(t);
  }, [notice]);
  const say = (s: string) => {
    setToast(s);
    setTimeout(() => setToast((t) => (t === s ? null : t)), 2600);
  };
  const doDegauss = () => {
    play('degauss');
    setDegauss(true);
    setTimeout(() => setDegauss(false), 900);
  };
  // Easter eggs that live on the desk itself: a redaction bar clicked 7 times peels off to
  // reveal another redaction bar; the block clock knows what time it is.
  const onEggClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const bar = t.closest('.bb-redact, .bb-redact-paper, [aria-label="redacted participant"]');
    if (bar) {
      const n = (redactClicks.current.get(bar) ?? 0) + 1;
      redactClicks.current.set(bar, n);
      if (n % 7 === 0) {
        bar.classList.remove('tk-peel');
        void (bar as HTMLElement).offsetWidth;
        bar.classList.add('tk-peel');
        play('tear');
        say('underneath: another redaction bar. it goes all the way down.');
      }
      return;
    }
    if (t.closest('.bb-tray__seg--blk')) say('time is a block height.');
  };
  const lastEsc = useRef(0);
  const digits = useRef<{ s: string; t: number }>({ s: '', t: 0 });
  const konami = useRef(0);

  useEffect(() => {
    const r = () => {
      setNarrow(innerWidth < 900);
      setPhone(innerWidth < 700);
    };
    addEventListener('resize', r);
    return () => removeEventListener('resize', r);
  }, []);
  useEffect(() => setSound(sound), [sound]);
  useEffect(() => {
    if (vault === 'checking') return;
    const first = firstVault.current;
    firstVault.current = false;
    if (first && (proof || duel)) return;
    // A first visit gets the four steps behind the vault window (the first-visit guide).
    if (first && vault === 'none' && !initial) {
      setOpen((o) => (o.includes('how') ? o : [...o, 'how']));
      setPage('how');
    }
    if (vault === 'locked' || vault === 'none') setVaultWin(true);
  }, [vault]);
  useEffect(() => {
    if (!proof) return;
    setVaultWin(false);
    go('verify');
  }, [proof]);
  useEffect(() => {
    if (!duel) return;
    setVaultWin(false);
    go('duels');
  }, [duel]);
  // A window asked for another one (the bet panel's CHALLENGE, for example).
  useEffect(() => {
    if (!request) return;
    if (request.id === 'vault') {
      setVaultWin(true);
      return;
    }
    if (request.duel) setDuelDraft(request.duel);
    setVaultWin(false);
    go(request.id);
  }, [request?.n]);
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
    setMenu(false);
    if (phone && !clean) {
      setBurst(true);
      setTimeout(() => setBurst(false), 200);
    }
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
    degauss: doDegauss,
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

  // Coming back from the wallet app: iOS suspended the page, so reconnect visibly.
  useEffect(() => {
    let hiddenAt = 0;
    const v = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 2_000 && phone) {
        setRelink(true);
        setTimeout(() => setRelink(false), 1_400);
      }
    };
    document.addEventListener('visibilitychange', v);
    return () => document.removeEventListener('visibilitychange', v);
  }, [phone]);

  // Auto-lock (THREAT_MODEL D1): the vault closes after 15 idle minutes; a page left in the
  // background is judged by when it was hidden.
  useEffect(() => {
    if (vault !== 'unlocked') return;
    let last = Date.now();
    const touch = () => (last = Date.now());
    const check = () => {
      if (Date.now() - last >= LOCK_MS) {
        lockVault();
        setVaultWin(true);
        app.set({ notice: 'The vault locked itself after 15 idle minutes. Nothing of you stays on screen.' });
      }
    };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    evs.forEach((e) => addEventListener(e, touch, { passive: true }));
    document.addEventListener('visibilitychange', check);
    const t = setInterval(check, 30_000);
    return () => {
      evs.forEach((e) => removeEventListener(e, touch));
      document.removeEventListener('visibilitychange', check);
      clearInterval(t);
    };
  }, [vault]);

  // A screen that drops frames gets CLEAN SIGNAL (no glow, scanlines or motion) by itself, once.
  useEffect(() => {
    if (clean || document.hidden) return;
    let frames = 0;
    let raf = 0;
    const t0 = performance.now();
    const count = () => {
      frames++;
      if (performance.now() - t0 < 3_000) raf = requestAnimationFrame(count);
    };
    raf = requestAnimationFrame(count);
    const done = setTimeout(() => {
      cancelAnimationFrame(raf);
      if (!document.hidden && frames > 0 && frames < 60) {
        ui.set({ clean: true });
        app.set({ notice: 'This screen was dropping frames, so the effects are off (CLEAN SIGNAL in START turns them back on).' });
      }
    }, 3_200);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
  }, []);

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
    if (id === 'duels') return <DuelsPage key={(duel ?? '') + JSON.stringify(duelDraft ?? {})} onClose={onClose} focus={duel} initial={duelDraft} />;
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

  // The vault keeps its tab while it is closed, so "look around first" is never a dead end.
  const tabs = [
    ...(vault === 'none' || vault === 'locked' ? [{ id: 'vault', title: vault === 'none' ? 'VAULT · NEW' : 'VAULT · LOCKED' }] : []),
    ...open.map((id) => ({ id, title: id === 'market' && called ? 'CALLED IT' : titleOf(id) })),
  ];
  const defHint = showVault ? HINTS.lock : called ? HINTS.called : HINTS[page.startsWith('tt:') ? 'how' : page];

  if (phone) {
    const channels = ['markets', ...(mid ? ['market'] : []), 'slips', 'cage', 'verify', 'how'];
    if (!channels.includes(page)) channels.push(page);
    const step = (d: number) => {
      const i = channels.indexOf(page);
      setVaultWin(false);
      go(channels[(i + d + channels.length) % channels.length]!);
    };
    const onDown = (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,[role=slider],.tk-snake__board,.tk-tracker,[data-noswipe]')) return;
      swipe.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    };
    const onUp = (e: React.PointerEvent) => {
      const s0 = swipe.current;
      swipe.current = null;
      if (!s0) return;
      const dx = e.clientX - s0.x;
      const dy = e.clientY - s0.y;
      if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - s0.t < 1200) step(dx < 0 ? 1 : -1);
    };
    const pages = [
      { id: 'markets', label: 'MARKETS', icon: 'markets' },
      { id: 'slips', label: 'SLIPS', icon: 'slips' },
      { id: 'cage', label: 'CAGE', icon: 'cage' },
      { id: 'verify', label: 'VERIFY', icon: 'verify' },
      { id: 'how', label: 'HOW IT WORKS', icon: 'how' },
      { id: 'record', label: 'WHAT WE KNOW', icon: 'eye' },
      { id: 'pass', label: 'NOBODY PASS', icon: 'stamp' },
      { id: 'duels', label: 'BLIND DUELS', icon: 'slips' },
    ];
    return (
      <div className={'pg-app bb-crt' + (degauss ? ' tk-degauss' : '')} data-signal={clean ? 'clean' : undefined} onClick={onEggClick}>
        <div className="pg-status">
          <span className="pg-bal">
            BAL <span className={vault === 'unlocked' ? 'bb-a' : 'bb-dim'}>{vault === 'unlocked' ? coin(balance) : 'LOCKED'}</span>
          </span>
          <MixnetLamp state={config.mixnet ? (link === 'linking' ? 'relinking' : link) : !reachable ? 'noanswer' : config.onion ? 'tor' : 'off'} compact />
          <SplitFlap value={(head?.height ?? 0).toLocaleString('en-US')} size="sm" label="block height" />
        </div>
        <div className="pg-body" onPointerDown={onDown} onPointerUp={onUp}>
          <LinkBanner short />
          {head?.halted && (
            <AlarmBanner title="SERVICE HALTED" action="" onAction={undefined}>
              Your slips keep their value; trading resumes once it is resolved.
            </AlarmBanner>
          )}
          <WinCtx.Provider value={{ narrow: true, hint: null, pager: true }}>
            {showVault && !menu && <VaultWindow key={vault} onOpen={() => setVaultWin(false)} onDismiss={() => setVaultWin(false)} />}
            {menu && (
              <section className="pg-chan pg-menu" aria-label="Menu">
                <TeletextHeader page="MENU" title="BLINDBOOK" />
                <p className="bb-label">PAGES</p>
                <div className="pg-grid">
                  {pages.map((p) => (
                    <button key={p.id} type="button" className={'pg-icon' + (page === p.id ? ' is-on' : '')} onClick={() => { setVaultWin(false); go(p.id); }}>
                      <PixelIcon name={p.icon as never} size={28} />
                      <span>{p.label}</span>
                    </button>
                  ))}
                </div>
                <p className="bb-label">BACK ROOM</p>
                <div className="pg-grid">
                  {(APP_ICONS as { id: string; label: string; icon: string }[]).map((a) => (
                    <button key={a.id} type="button" className={'pg-icon' + (page === a.id ? ' is-on' : '')} onClick={() => { setVaultWin(false); go(a.id); }}>
                      <PixelIcon name={a.icon as never} size={28} />
                      <span>{a.label}</span>
                    </button>
                  ))}
                </div>
                <div className="pg-switches">
                  <ToggleSwitch label="CLEAN SIGNAL" checked={clean} onChange={(v: boolean) => ui.set({ clean: v })} />
                  <ToggleSwitch label="SOUND" checked={sound} onChange={(v: boolean) => ui.set({ sound: v })} />
                </div>
                <div className="col" style={{ gap: 8 }}>
                  <KeyButton variant="secondary" icon="console" onClick={() => { setMenu(false); setCon(true); }}>CONSOLE</KeyButton>
                  {vault === 'unlocked' ? (
                    <KeyButton variant="secondary" icon="lock" onClick={() => { setMenu(false); lock(); }}>LEAVE THE BOOTH · LOCK</KeyButton>
                  ) : (
                    <KeyButton variant="secondary" icon="lock" onClick={() => { setMenu(false); setVaultWin(true); }}>OPEN THE VAULT</KeyButton>
                  )}
                  <KeyButton variant="secondary" icon="eye" onClick={onIntro}>REPLAY INTRO</KeyButton>
                </div>
              </section>
            )}
            {open.map((id) => (
              <div key={id === 'market' ? 'market:' + mid : id} className="tk-win" hidden={menu || showVault || id !== page}>
                <WindowGuard title={titleOf(id)} onClose={() => close(id)}>{render(id)}</WindowGuard>
              </div>
            ))}
          </WinCtx.Provider>
          {burst && <div className="pg-burst" aria-hidden="true" />}
        </div>
        {con && (
          <div className="pg-console">
            <Console onClose={() => setCon(false)} run={(c, out) => runCommand(c, out, desk)} height={300} />
          </div>
        )}
        <nav className="pg-keys" aria-label="Pager keys">
          <KeyButton size="sm" variant="secondary" fullWidth onClick={() => step(-1)} aria-label="Previous channel">◀ CH</KeyButton>
          <KeyButton size="sm" variant={menu ? 'primary' : 'secondary'} fullWidth onClick={() => setMenu((m) => !m)}>MENU</KeyButton>
          <KeyButton size="sm" variant={con ? 'primary' : 'secondary'} icon="console" fullWidth onClick={() => setCon((c) => !c)} className="pg-key-wide">CONSOLE</KeyButton>
          <KeyButton size="sm" variant="secondary" fullWidth onClick={() => step(1)} aria-label="Next channel">CH ▶</KeyButton>
        </nav>
        {relink && (
          <div className="pg-relink" role="status">
            <p className="bb-display-md bb-glow bb-hi">{config.mixnet ? 'RE-LINKING' : 'WELCOME BACK'}</p>
            <p className="bb-label">{config.mixnet ? 'the phone paused the page · building a fresh route' : 'the phone paused the page'}</p>
          </div>
        )}
        {insider && (
          <div className="tk-insider" role="status">
            <p className="bb-display-md bb-glow bb-hi">INSIDER MODE</p>
            <p className="bb-ui">we can&apos;t tell who you are. that includes insiders.</p>
          </div>
        )}
        {leaving && (
          <div className="tk-leave" role="status">
            <p className="bb-display-md bb-glow bb-hi">NOTHING OF YOU STAYS BEHIND</p>
          </div>
        )}
        {toast && (
          <p className="tk-toast bb-ui" role="status">
            {toast}
          </p>
        )}
        {idle && <Screensaver onWake={() => setIdle(false)} still={clean} />}
      </div>
    );
  }

  return (
    <div className={'tk-app' + (degauss ? ' tk-degauss' : '')} data-signal={clean ? 'clean' : undefined} onMouseOver={onHover} onFocus={onHover} onClick={onEggClick}>
      <Wallpaper className="tk-desk">
        <DesktopIcons className="tk-icons" layout={narrow ? 'row' : 'column'} items={rail} selected={showVault ? undefined : page === 'market' ? 'markets' : page} onSelect={(id: string) => { setVaultWin(false); go(id); }} bindFKeys />
        <AppIcons className="tk-apps" layout={narrow ? 'row' : 'column'} selected={showVault ? undefined : page} onSelect={(id: string) => { setVaultWin(false); go(id); }} />
        <div className="tk-stage">
          <LinkBanner />
          {head?.halted && (
            <AlarmBanner title="SERVICE HALTED" action="" onAction={undefined}>
              The server stopped itself after a consistency check. Your slips keep their value; trading resumes once it is resolved.
            </AlarmBanner>
          )}
          <WinCtx.Provider value={{ narrow, hint: hint ?? defHint }}>
            {showVault && <VaultWindow key={vault} onOpen={() => setVaultWin(false)} onDismiss={() => setVaultWin(false)} />}
            {open.map((id) => (
              <div key={id === 'market' ? 'market:' + mid : id} className="tk-win" hidden={showVault || id !== page}>
                <WindowGuard title={titleOf(id)} onClose={() => close(id)}>{render(id)}</WindowGuard>
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
        mixnet={config.mixnet ? (link === 'linking' ? 'relinking' : link) : !reachable ? 'noanswer' : config.onion ? 'tor' : 'off'}
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
            pages={START_PAGES}
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
      {toast && (
        <p className="tk-toast bb-ui" role="status">
          {toast}
        </p>
      )}
      {idle && <Screensaver onWake={() => setIdle(false)} still={clean} />}
    </div>
  );
}
