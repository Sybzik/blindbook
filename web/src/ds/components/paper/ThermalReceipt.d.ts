/** Rubber stamp for paper (ink) or screen (phosphor / alarm). */
export interface StampProps {
  children: React.ReactNode;
  tone?: 'ink' | 'phosphor' | 'alarm';
  /** sm 14px Departure · md 32px VT323 · lg 48px VT323 */
  size?: 'sm' | 'md' | 'lg';
  /** degrees; default -8 */
  rotate?: number;
  /** slam-in animation (SEEN moment) */
  slam?: boolean;
  /** worn ink texture (effects layer; CLEAN SIGNAL removes it) */
  worn?: boolean;
  className?: string;
  style?: React.CSSProperties;
}
export interface ReceiptLine { label: string; value: React.ReactNode; }
/**
 * Thermal top-up receipt: perforated edges, QR, exact amount, short address, SEEN stamp.
 * @startingPoint section="Paper" subtitle="Top-up receipt: awaiting → SEEN → credited" viewport="700x620"
 */
export interface ThermalReceiptProps {
  kind?: string;
  amount?: string;
  unit?: string;
  /** shortened: u1qz7x…k3d8 */
  address?: string;
  qrSeed?: string;
  /** A real QR (the payment request) instead of the decorative pattern. */
  qr?: React.ReactNode;
  lines?: ReceiptLine[];
  status?: 'awaiting' | 'seen' | 'credited';
  /** line-by-line print reveal */
  printing?: boolean;
  footer?: string;
  width?: number | string;
  className?: string;
}
export declare function Stamp(props: StampProps): JSX.Element;
export declare function ThermalReceipt(props: ThermalReceiptProps): JSX.Element;
