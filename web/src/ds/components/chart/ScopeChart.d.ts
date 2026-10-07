/**
 * Oscilloscope chart with BOTH outcome traces (A green, B amber), right-end labels, 0–100% axis,
 * persistence trail, time tabs, and a REF toggle (off by default) that adds labelled violet dashed Polymarket lines.
 * @startingPoint section="Market" subtitle="Both-outcome oscilloscope with REF toggle" viewport="700x340"
 */
export interface ScopeOutcome {
  label: string;
  side: 'a' | 'b';
  /** current % */
  value: number;
  /** 0–100 series, oldest first */
  data: number[];
  /** Polymarket reference current % */
  refValue?: number;
  refData?: number[];
}
export interface ScopeChartProps {
  /** default: LEGACY / PARIVISION demo series */
  outcomes?: ScopeOutcome[];
  ranges?: string[];
  range?: string;
  onRange?: (r: string) => void;
  /** controlled REF state; default uncontrolled + off */
  showRef?: boolean;
  onToggleRef?: (on: boolean) => void;
  /** svg height in px; default 240 */
  height?: number;
  title?: string;
  className?: string;
}
export declare const SCOPE_DEMO: ScopeOutcome[];
export declare function ScopeChart(props: ScopeChartProps): JSX.Element;
