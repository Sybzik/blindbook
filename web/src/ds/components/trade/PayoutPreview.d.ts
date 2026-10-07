/** "If LEGACY wins → you get 0.0222 ZEC (+0.0122)" */
export interface PayoutPreviewProps {
  outcome: string;
  side?: 'a' | 'b';
  payout: string;
  /** "+0.0122" */
  profit?: string;
  unit?: string;
  /** md = one line · lg = two lines, big glowing amount */
  size?: 'md' | 'lg';
  className?: string;
}
/** "Fills in ~2 s · max 48¢ · fee 1% · trading closes at kick-off" — always directly under a BUY key. */
export interface TradeConditionsProps {
  fill?: string;
  max?: string;
  fee?: string;
  closes?: string;
  /** override with your own parts */
  items?: string[];
  className?: string;
}
/** Standard-amount chips: numbers only (0.01 / 0.05 / 0.1 / 0.5) under one label "AMOUNT · ZEC". Chips never truncate; they wrap. */
export interface AmountChipsProps {
  /** label word before the unit; default "AMOUNT" */
  label?: string;
  /** show the "AMOUNT · ZEC" label above the chips; default true */
  showLabel?: boolean;
  options?: string[];
  value?: string;
  onChange?: (v: string) => void;
  unit?: string;
  label?: string;
  /** force hover look on one chip (specimens) */
  hoverIndex?: number;
  className?: string;
}
/** Amount slider with a numeric field. */
export interface AmountSliderProps {
  value?: number | string;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (v: string) => void;
  unit?: string;
  label?: string;
  decimals?: number;
  className?: string;
}
export declare function PayoutPreview(props: PayoutPreviewProps): JSX.Element;
export declare function TradeConditions(props: TradeConditionsProps): JSX.Element;
export declare function AmountChips(props: AmountChipsProps): JSX.Element;
export declare function AmountSlider(props: AmountSliderProps): JSX.Element;
