// Scan a slip QR (paper or another screen) with the camera, or from a photo. Decoding happens in
// this tab (the browser's BarcodeDetector where it exists, jsQR otherwise); no frame leaves it.

import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { KeyButton } from '../ds';

type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };
const native = (): Detector | null => {
  const B = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  try {
    return B ? new B({ formats: ['qr_code'] }) : null;
  } catch {
    return null;
  }
};

async function decode(canvas: HTMLCanvasElement, det: Detector | null): Promise<string | null> {
  if (det) {
    try {
      const r = await det.detect(canvas);
      if (r[0]?.rawValue) return r[0].rawValue;
    } catch {
      /* fall through to jsQR */
    }
  }
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

export function Scan({ onCode, onCancel, accept = (s) => s.startsWith('bbslip1:') }: { onCode: (code: string) => void; onCancel: () => void; accept?: (s: string) => boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    const det = native();
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const c = canvas.current!;
        while (!stop) {
          if (v.videoWidth) {
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            c.getContext('2d', { willReadFrequently: true })!.drawImage(v, 0, 0);
            const s = await decode(c, det);
            if (s && accept(s)) {
              onCode(s);
              return;
            }
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch {
        setErr('No camera here, or it was not allowed. Pick a photo of the slip instead.');
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  const fromFile = async (f: File | undefined) => {
    if (!f) return;
    const bmp = await createImageBitmap(f);
    const c = canvas.current!;
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d', { willReadFrequently: true })!.drawImage(bmp, 0, 0, c.width, c.height);
    const s = await decode(c, native());
    if (s && accept(s)) onCode(s);
    else setErr('No slip code found in that picture.');
  };
  return (
    <div className="tk-scan">
      <video ref={video} playsInline muted aria-label="Camera" />
      <canvas ref={canvas} hidden />
      {err && <p className="bb-conditions">{err}</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="bb-key bb-key--secondary bb-key--sm tk-file">
          FROM A PHOTO
          <input type="file" accept="image/*" onChange={(e) => fromFile(e.target.files?.[0])} />
        </label>
        <KeyButton variant="secondary" size="sm" onClick={onCancel}>CANCEL</KeyButton>
      </div>
      <p className="bb-ui bb-dim" style={{ margin: 0 }}>Decoded on this device. The picture is never sent anywhere.</p>
    </div>
  );
}
