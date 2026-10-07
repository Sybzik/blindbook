/** One desktop shortcut: 21–28px pixel icon, uppercase label beside it, optional live tag. */
export interface DesktopIconProps {
  /** plain label, always present: "MARKETS" */
  label: string;
  /** 7x7 pixel icon name */
  icon?: string;
  /** live tag text: "1", "0.143", "✓" (wins over led) */
  indicator?: React.ReactNode;
  /** show a small LED tag; true = lit (mixnet linked) */
  led?: boolean;
  /** alarm-red LED tag */
  alert?: boolean;
  /** label inverted (void on phosphor-hi), like a selected file */
  selected?: boolean;
  /** force a visual state for specimens */
  state?: 'idle' | 'hover' | 'selected';
  /** 21 (default) or 28 */
  iconSize?: number;
  /** keyboard shortcut ("F1"). Bound, announced to assistive tech, never printed */
  fkey?: string;
  onClick?: () => void;
  className?: string;
}
export interface DesktopItem extends DesktopIconProps { id: string; /** app page number, e.g. "P701" (apps only) */ page?: string; }
/**
 * Page navigation as desktop shortcuts at the top-left of the wallpaper. No boxes around them.
 * @startingPoint section="Shell" subtitle="Desktop shortcuts: idle, hover, selected, live tags" viewport="700x380"
 */
export interface DesktopIconsProps {
  /** default: MARKETS (LED), SLIPS "1", CAGE "0.143", VERIFY "✓", HOW (F1–F5) */
  items?: DesktopItem[];
  /** id of the selected (open + focused) page */
  selected?: string;
  onSelect?: (id: string) => void;
  /** column = desktop · row = narrow screens · list = full-width rows (pager menu) · grid = big icons above labels (pager apps) */
  layout?: 'column' | 'row' | 'list' | 'grid';
  /** small uppercase heading over the set, e.g. "BACK ROOM" */
  group?: string;
  iconSize?: number;
  /** listen for F1–F6 on window */
  bindFKeys?: boolean;
  className?: string;
  style?: React.CSSProperties;
}
/** Desktop wallpaper: void + one soft top-left phosphor light (the only gradient in the system) + scanlines/noise + the whole faint BLINDBOOK wordmark. */
export interface WallpaperProps {
  /** show the faint centred wordmark (hidden automatically under 640px) */
  wordmark?: boolean;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}
/** BACK ROOM apps as their own desktop-icon group (top-right of the desktop). Defaults: group "BACK ROOM", iconSize 28, APP_ICONS. */
export interface AppIconsProps extends Omit<DesktopIconsProps, 'items'> { items?: DesktopItem[]; }
export declare const DEFAULT_ICONS: DesktopItem[];
/** NULLIFIER SNAKE (P701) · ODDS CALC (P702) · REDACT-A-TRACKER (P703) · DEAD DROP (P704) · BLOCK RADIO (P705) */
export declare const APP_ICONS: DesktopItem[];
export declare function AppIcons(props: AppIconsProps): JSX.Element;
export declare function DesktopIcon(props: DesktopIconProps): JSX.Element;
export declare function DesktopIcons(props: DesktopIconsProps): JSX.Element;
export declare function Wallpaper(props: WallpaperProps): JSX.Element;
