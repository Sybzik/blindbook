export interface TaskbarWindow { id: string; /** "P201 · MARKET" */ title: string; /** compact tab text when tabs don't fit; default: title up to the first " · " ("P201") */ short?: string; }
/**
 * Bottom taskbar: ◆ START (opens the start menu) · one tab per open window ("▤ P201 · MARKET") ·
 * BAL 0.1432 ZEC · ● MIXNET LINKED · BLK 3,514,229 · clock. Always one row, fixed 40px; tabs that don't fit shrink to "▤ P300",
 * never wrap, never truncate. Max 4 open windows is the shell's rule. The hint lives in the focused window, not here.
 * @startingPoint section="Shell" subtitle="Taskbar with START menu, window tabs and tray" viewport="1200x700"
 */
export interface TaskbarProps {
  windows?: TaskbarWindow[];
  /** id of the focused window (tab shown pressed) */
  focused?: string;
  onWindow?: (id: string) => void;
  startOpen?: boolean;
  /** called with the next open state; also fires false on outside click / Escape */
  onStartToggle?: (next: boolean) => void;
  /** usually <StartMenu …/>; rendered above START while open */
  startMenu?: React.ReactNode;
  balance?: string;
  unit?: string;
  mixnet?: 'linked' | 'relinking' | 'down' | 'off' | 'tor';
  block?: number | string;
  /** fixed clock text for specimens; live HH:MM otherwise */
  clock?: string;
  className?: string;
  style?: React.CSSProperties;
}
export interface StartPage { id: string; fkey?: string; label: string; icon: string; }
/** START menu: header "◆ BLINDBOOK" on a solid label; every page, APPS, CONSOLE, REPLAY INTRO, CLEAN SIGNAL, SOUND, LOCK VAULT. */
export interface StartMenuProps {
  pages?: StartPage[];
  /** APPS section; default APP_ICONS (pass [] to hide) */
  apps?: StartPage[];
  onSelect?: (id: string) => void;
  onApp?: (id: string) => void;
  onConsole?: () => void;
  /** shows REPLAY INTRO when set */
  onReplayIntro?: () => void;
  clean?: boolean;
  onToggleClean?: (next: boolean) => void;
  sound?: boolean;
  onToggleSound?: (next: boolean) => void;
  /** shows LOCK VAULT (Esc Esc) when set */
  onLock?: () => void;
  className?: string;
  style?: React.CSSProperties;
}
/** MIXNET ● LINKED / RELINKING (blinking) / DOWN (alarm). */
export interface MixnetLampProps {
  state?: 'linked' | 'relinking' | 'down' | 'off' | 'tor';
  /** e.g. "3 HOPS · COVER ON" */
  detail?: string;
  /** hide the word MIXNET (pager status strip) */
  compact?: boolean;
  className?: string;
}
export interface ToggleSwitchProps { label: string; checked?: boolean; onChange?: (next: boolean) => void; className?: string; }
export declare function Taskbar(props: TaskbarProps): JSX.Element;
export declare function StartMenu(props: StartMenuProps): JSX.Element;
export declare function MixnetLamp(props: MixnetLampProps): JSX.Element;
export declare function ToggleSwitch(props: ToggleSwitchProps): JSX.Element;
