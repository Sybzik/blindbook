/** Split-flap numerals. Numbers get en-US grouping (3,514,220). */
export interface SplitFlapProps {
  value: string | number;
  /** sm 16px · md 20px (Departure Mono) · lg 48px · xl 72px (VT323, glow on) */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  color?: string;
  /** phosphor glow; default on for lg/xl only */
  glow?: boolean;
  /** spoken prefix, e.g. "block height" */
  label?: string;
  /** flip changed characters; default true */
  animate?: boolean;
  className?: string;
  style?: React.CSSProperties;
}
/** "LEGACY 45¢ · 45%" — outcome A green, outcome B amber. Becomes a toggle button when onClick is set. */
export interface OutcomePillProps {
  /** the market's own outcome label: YES, NO, LEGACY, PARIVISION */
  label: string;
  /** cents */
  price?: number | string;
  /** implied % */
  pct?: number | string;
  side?: 'a' | 'b';
  selected?: boolean;
  state?: 'hover' | 'selected';
  /** Polymarket reference price, shown in violet */
  refPrice?: number | string;
  size?: 'sm' | 'md';
  onClick?: () => void;
  className?: string;
}
export declare function SplitFlap(props: SplitFlapProps): JSX.Element;
export declare function OutcomePill(props: OutcomePillProps): JSX.Element;
