/**
 * Alarm banner: alarm-striped title, one plain explanation, one action. Real alarms only.
 * @startingPoint section="Feedback" subtitle="Alarm banner + SIGNAL LOST test card" viewport="700x620"
 */
export interface AlarmBannerProps {
  /** what happened: "MIXNET LINK LOST" */
  title?: string;
  /** what it means + what happens next, in plain words */
  children?: React.ReactNode;
  /** the one action */
  action?: string;
  onAction?: () => void;
  onClose?: () => void;
  className?: string;
}
/** SIGNAL LOST test card with plain message and auto-retry countdown. */
export interface SignalLostProps {
  message?: string;
  /** seconds between retries; default 5 */
  retryIn?: number;
  onRetry?: () => void;
  width?: number | string;
  className?: string;
}
export declare function AlarmBanner(props: AlarmBannerProps): JSX.Element;
export declare function SignalLost(props: SignalLostProps): JSX.Element;
