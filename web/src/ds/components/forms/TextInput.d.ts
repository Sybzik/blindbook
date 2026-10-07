/** Address / passphrase field with plain validation messages. */
export interface TextInputProps {
  label?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  onChange?: (v: string) => void;
  /** force a state; invalid adds ✗ + alarm border, valid adds ✓ */
  state?: 'empty' | 'focus' | 'valid' | 'invalid';
  /** one plain sentence: what happened and what to do */
  message?: React.ReactNode;
  /** inline element at the right, e.g. a small "PASTE FROM ZODL" key */
  action?: React.ReactNode;
  type?: string;
  id?: string;
  required?: boolean;
  className?: string;
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
}
export interface PreflightItem { label: string; ok: string; fail: string; }
/**
 * Privacy preflight checklist that ticks itself before every payment.
 * @startingPoint section="Cage" subtitle="4-row privacy preflight that ticks" viewport="700x300"
 */
export interface PreflightChecklistProps {
  /** default: MIXNET LINKED, PHRASE BACKED UP, STANDARD AMOUNT, PAY FROM YOUR ORCHARD/IRONWOOD BALANCE */
  items?: PreflightItem[];
  /** controlled per-row status */
  statuses?: Array<'pending' | 'checking' | 'ok' | 'fail'>;
  /** tick rows one by one */
  auto?: boolean;
  interval?: number;
  onComplete?: () => void;
  className?: string;
}
export declare const PREFLIGHT_DEFAULT: PreflightItem[];
export declare function TextInput(props: TextInputProps): JSX.Element;
export declare function PreflightChecklist(props: PreflightChecklistProps): JSX.Element;
