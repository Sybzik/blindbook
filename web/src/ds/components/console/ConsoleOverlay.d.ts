/** Console line: in = typed command, out = response, err = unknown/denied, sys = system note. */
export interface ConsoleLine { t: 'in' | 'out' | 'err' | 'sys'; s: string; }
/**
 * Console overlay with "> " prompt and block cursor. Opens from ⌨ CONSOLE, the ` key or Ctrl/⌘+K.
 * @startingPoint section="Shell" subtitle="Console overlay with built-in easter-egg commands" viewport="700x320"
 */
export interface ConsoleOverlayProps {
  open?: boolean;
  onClose?: () => void;
  initialLines?: ConsoleLine[];
  /** return string | string[] to answer, null to clear, undefined to fall back to built-ins */
  onCommand?: (cmd: string) => string | string[] | null | undefined;
  height?: number | string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}
export declare const CONSOLE_RESPONSES: Record<string, string[]>;
export declare function ConsoleOverlay(props: ConsoleOverlayProps): JSX.Element | null;
