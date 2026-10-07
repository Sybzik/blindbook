export type PixelIconName =
  | 'markets' | 'slips' | 'cage' | 'verify' | 'how' | 'console' | 'rules' | 'stamp' | 'lock' | 'warning'
  | 'check' | 'qr' | 'lamp' | 'zebra' | 'bonsai' | 'phone' | 'mug' | 'drawer' | 'eye'
  | 'snake' | 'calculator' | 'tracker' | 'notepad' | 'radio';

/** 7x7 pixel icon. Render at multiples of 7 (7, 14, 21, 28, 42, 56) for crisp pixels. */
export interface PixelIconProps {
  name: PixelIconName;
  /** px width; default 14 (2px per pixel) */
  size?: number;
  /** fill; default currentColor */
  color?: string;
  /** accessible name; omit for decorative icons (aria-hidden) */
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}
export declare const ICONS: Record<PixelIconName, string[]>;
export declare const ICON_NAMES: PixelIconName[];
export declare function PixelIcon(props: PixelIconProps): JSX.Element;
