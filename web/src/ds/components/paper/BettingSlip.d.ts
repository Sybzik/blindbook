/**
 * Paper betting slip with serial, outcome, shares, stamp and a tear-off stub.
 * @startingPoint section="Paper" subtitle="Slip states: OPEN, WON, LOST, REFUNDED, EXPOSED, AMOUNT VISIBLE" viewport="700x560"
 */
export interface BettingSlipProps {
  serial?: string;
  market?: string;
  /** the market's own outcome label */
  outcome?: string;
  side?: 'a' | 'b';
  shares?: string;
  price?: string;
  stake?: string;
  /** what the slip pays (a position: "0.0164 ZEC if it wins") */
  pays?: string;
  block?: string;
  status?: 'open' | 'won' | 'lost' | 'refunded' | 'exposed' | 'amount-visible';
  width?: number | string;
  className?: string;
}
/** Printable bearer slip: black on white, 80mm receipt width, with the bearer warning line. */
export interface PrintSlipProps {
  serial?: string;
  market?: string;
  outcome?: string;
  shares?: string;
  /** default "bearer paper: whoever scans this owns it" */
  warning?: string;
  className?: string;
}
export declare function BettingSlip(props: BettingSlipProps): JSX.Element;
export declare function PrintSlip(props: PrintSlipProps): JSX.Element;
