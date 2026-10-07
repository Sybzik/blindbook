/** The Blindbook mark: a 7x7 pixel eye with a black redaction bar. Works from 16px (favicon) to 400px (boot screen). */
export interface LogoProps {
  /** px; default 28. Use multiples of 9 for crisp pixels (18, 27, 36…). */
  size?: number;
  /** tile = void eye on a phosphor tile (default, any background); bare = phosphor eye; paper = ink eye */
  variant?: 'tile' | 'bare' | 'paper';
  /** append the 5x7 BLINDBOOK wordmark */
  withWordmark?: boolean;
  title?: string;
  style?: React.CSSProperties;
}
/** BLINDBOOK in the custom 5x7 pixel face, drawn as rects (no font file). */
export interface WordmarkProps {
  text?: string;
  /** px height of the 7-row glyphs; default 14 */
  height?: number;
  color?: string;
  /** the I turns into a redaction bar */
  redactI?: boolean;
  redactColor?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}
export declare function Logo(props: LogoProps): JSX.Element;
export declare function Wordmark(props: WordmarkProps): JSX.Element;
