/**
 * Chunky physical key: the primary action surface. One primary key per screen.
 * @startingPoint section="Controls" subtitle="Primary / secondary / danger keys, every state" viewport="700x420"
 */
export interface KeyButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  /** sm 44px · md 48px · lg 56px */
  size?: 'sm' | 'md' | 'lg';
  /** force a visual state for specimens; real states come from :hover/:active/:focus-visible */
  state?: 'default' | 'hover' | 'pressed' | 'focus' | 'disabled' | 'loading';
  /** held down + blinking block cursor */
  loading?: boolean;
  disabled?: boolean;
  /** 7x7 pixel icon name */
  icon?: string;
  fullWidth?: boolean;
  /** plain uppercase label: BUY LEGACY, PAY IN WALLET */
  children?: React.ReactNode;
}
export declare function KeyButton(props: KeyButtonProps): JSX.Element;
