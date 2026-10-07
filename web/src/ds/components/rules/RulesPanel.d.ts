/**
 * Every market's RULES panel: Polymarket's rules verbatim + how Blindbook handles the market.
 * @startingPoint section="Market" subtitle="RULES panel: verbatim rules + leader rows" viewport="700x520"
 */
export interface RulesPanelProps {
  /** Polymarket's rules text, verbatim (IBM Plex Mono) */
  rules?: string;
  /** Polymarket market URL for "full rules on Polymarket ↗" */
  url?: string;
  /** TRADING CLOSES, SETTLES, PAYS, YOUR BET, REDEEM */
  rows?: Array<{ label: string; value: React.ReactNode }>;
  className?: string;
}
export declare const RULES_SAMPLE: string;
export declare const RULES_ROWS: Array<{ label: string; value: string }>;
export declare function RulesPanel(props: RulesPanelProps): JSX.Element;
