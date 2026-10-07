/**
 * The mixnet as a compact strip: YOU ▪ → HOP 1 ▪ → HOP 2 ▪ → HOP 3 ▪ → BOOTH. One bright pixel packet travels along it; each hop ticks ✓; BOOTH reads LINKED.
 * @startingPoint section="System" subtitle="Mixnet strip: packet travelling, hops ticking" viewport="700x300"
 */
export interface MixnetMapProps {
  /** 0–1 packet position (controlled). 1 = LINKED */
  progress?: number;
  /** static: completed hops 0–3; 3 = LINKED (ignored when progress is set) */
  hops?: number;
  /** animate 0 → LINKED over `duration` */
  auto?: boolean;
  /** ms for the whole trip; default 2000 */
  duration?: number;
  onLinked?: () => void;
  className?: string;
}
/** BOOT: full-screen moment before the desktop. Logo eye, three typed lines (LINKING MIXNET ✓ · DERIVING KEYS ✓ · LOADING MARKETS ✓), pixel-block progress bar, mixnet strip. ~2.6 s, any key/click skips. */
export interface BootSequenceProps {
  onDone?: () => void;
  /** false = CLEAN SIGNAL: finished state, no motion, continues after ~0.9 s */
  animate?: boolean;
  /** total ms; default 2600 */
  duration?: number;
  lines?: string[];
  /** progress-bar blocks; default 24 */
  blocks?: number;
  className?: string;
}
/** Pixel line-art keyhole: amber-dim outline, the hole glowing phosphor. ≤72px tall. */
export interface KeyholeProps {
  state?: 'idle' | 'prompt' | 'unlocking' | 'unlocked' | 'error';
  /** height in px, max 72 */
  size?: number;
  className?: string;
}
/** UNLOCK. Desktop: keyhole, VAULT LOCKED, one sentence, passphrase field, UNLOCK, "forgot it? restore from 12 words". Phone: keyhole glows during Face ID, "use passphrase". */
export interface UnlockKeyholeProps {
  device?: 'phone' | 'desktop';
  /** prompt = Face ID showing (phone) · unlocking = keyhole lights up, key held */
  state?: 'idle' | 'prompt' | 'unlocking' | 'unlocked' | 'error';
  onUsePassphrase?: () => void;
  onUnlock?: () => void;
  /** desktop: "forgot it? restore from 12 words" */
  onForgot?: () => void;
  passphrase?: string;
  onPassphrase?: (v: string) => void;
  /** desktop error message (implies state error) */
  error?: string;
  className?: string;
}
export declare const BOOT_LINES: string[];
export declare function MixnetMap(props: MixnetMapProps): JSX.Element;
export declare function BootSequence(props: BootSequenceProps): JSX.Element;
export declare function Keyhole(props: KeyholeProps): JSX.Element;
export declare function UnlockKeyhole(props: UnlockKeyholeProps): JSX.Element;
