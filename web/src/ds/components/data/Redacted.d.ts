/** Redaction: never an empty outlined box. Screen readers hear the label. */
export interface RedactedProps {
  /** number of block characters (screen) or covered characters (paper) */
  length?: number;
  /** text printed underneath (paper) / sets length (screen) */
  text?: string;
  /** screen = █ blocks in --redact-screen · paper = rough black marker stroke */
  medium?: 'screen' | 'paper';
  /** default "redacted participant" */
  label?: string;
  /** stable seed for the rough marker edge */
  seed?: string;
  className?: string;
  style?: React.CSSProperties;
}
/** Label ..... value row. Dots use --line (decorative); label text-dim; value phosphor. */
export interface LeaderRowProps {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: 'default' | 'hi' | 'dim' | 'a' | 'b' | 'ref' | 'alarm';
  medium?: 'screen' | 'paper';
  /** 1px rule under the row */
  ruled?: boolean;
  className?: string;
  style?: React.CSSProperties;
}
/** "████████ bought LEGACY · 0.010 ZEC @ 45¢ · blk 3,514,220" */
export interface FillRowProps {
  outcome: string;
  side?: 'a' | 'b';
  amount: string;
  unit?: string;
  /** cents */
  price: number | string;
  block?: number | string;
  /** a time instead of a block, e.g. "18:52:10 UTC" */
  when?: string;
  /** redaction length */
  length?: number;
  verb?: string;
  className?: string;
}
export declare function Redacted(props: RedactedProps): JSX.Element;
export declare function LeaderRow(props: LeaderRowProps): JSX.Element;
export declare function FillRow(props: FillRowProps): JSX.Element;
