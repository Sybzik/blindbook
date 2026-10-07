/** Pixel-styled QR block with the redacted eye in the center (visual stand-in; encode real payloads in code). */
export interface QRCodeProps {
  /** deterministic pattern seed (e.g. the slip serial) */
  seed?: string;
  size?: number;
  fg?: string;
  /** background; finder-pattern holes use this (or --qr-bg) */
  bg?: string;
  /** draw the redacted eye in the center; default true */
  eye?: boolean;
  title?: string;
  style?: React.CSSProperties;
}
/** Random symmetric 8x8 pixel face for the NOBODY PASS photo slot. */
export interface PixelFaceProps {
  seed?: string;
  size?: number;
  fg?: string;
  bg?: string;
  title?: string;
  style?: React.CSSProperties;
}
export declare function QRCode(props: QRCodeProps): JSX.Element;
export declare function PixelFace(props: PixelFaceProps): JSX.Element;
