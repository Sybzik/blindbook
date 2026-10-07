/**
 * CALLED IT receipt card (paper): stamp, market, outcome, price, block, date, QR proof, VERIFIED ✓, share actions.
 * @startingPoint section="Paper" subtitle="CALLED IT receipt card, private by default" viewport="700x620"
 */
export interface CalledItCardProps {
  market?: string;
  outcome?: string;
  side?: 'a' | 'b';
  price?: string;
  block?: string;
  date?: string;
  proofSeed?: string;
  /** A real QR (the proof link) instead of the decorative pattern. */
  qr?: React.ReactNode;
  /** what anyone opening the proof link sees */
  verified?: boolean;
  /** KEEP PRIVATE / COPY LINK / SAVE IMAGE keys */
  showActions?: boolean;
  onKeepPrivate?: () => void;
  onCopyLink?: () => void;
  onSaveImage?: () => void;
  className?: string;
}
/** NOBODY PASS: every field redacted, random pixel face, local stamp slots. */
export interface NobodyPassProps {
  /** new seed each save so two shared cards can't be linked */
  faceSeed?: string;
  /** earned: 'FIRST SLIP' | 'CALLED IT' | 'PASSED IN THE DARK' */
  stamps?: string[];
  issued?: string;
  className?: string;
}
export declare function CalledItCard(props: CalledItCardProps): JSX.Element;
export declare function NobodyPass(props: NobodyPassProps): JSX.Element;
