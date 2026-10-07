/**
 * A floating terminal window on the desktop. Every page, panel and back-room app lives in one; only one is in focus.
 * @startingPoint section="Shell" subtitle="Floating window: striped mint bar, square X, hint strip, resize grip" viewport="700x480"
 */
export interface TerminalWindowProps {
  /** title-bar label, e.g. "P201 · MARKET" */
  title: React.ReactNode;
  onClose?: () => void;
  /** show the square close button; default true */
  closable?: boolean;
  /** focused window; inactive windows dim their title bar. Only one is active at a time */
  active?: boolean;
  /** called on pointer-down anywhere in the window (bring to front / focus) */
  onActivate?: () => void;
  /** drag by the title bar (clamped so the bar stays reachable) */
  draggable?: boolean;
  /** show the resize grip bottom-right; min 320×200 */
  resizable?: boolean;
  /** one plain sentence about the focused element, shown in the strip at the bottom. Wraps; never truncated */
  hint?: React.ReactNode;
  /** play the shutter-away animation (CRT switch-off), then call onClosed */
  closing?: boolean;
  onClosed?: () => void;
  /** alarm = alarm-striped bar (used by AlarmBanner) */
  tone?: 'default' | 'alarm';
  width?: number | string;
  maxWidth?: number | string;
  /** with height/maxHeight set, the body scrolls */
  height?: number | string;
  maxHeight?: number | string;
  /** body padding; default 24px */
  padding?: number | string;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
}
/** Hint text: one plain sentence about the focused element (rendered by TerminalWindow's hint strip). */
export interface HintTextProps { children?: React.ReactNode; className?: string; }
/** Teletext page header row: "P201  CS2 · LEGACY vs PARIVISION". */
export interface TeletextHeaderProps {
  page?: string;
  /** custom title; otherwise built from category + outcomes */
  title?: React.ReactNode;
  category?: string;
  /** outcome A label (rendered green) */
  outcomeA?: string;
  /** outcome B label (rendered amber) */
  outcomeB?: string;
  /** right-aligned meta, e.g. a clock */
  meta?: React.ReactNode;
  /** sm 32px · md 48px · lg 72px */
  size?: 'sm' | 'md' | 'lg';
  glow?: boolean;
  className?: string;
}
export declare function TerminalWindow(props: TerminalWindowProps): JSX.Element;
export declare function HintText(props: HintTextProps): JSX.Element;
export declare function TeletextHeader(props: TeletextHeaderProps): JSX.Element;
