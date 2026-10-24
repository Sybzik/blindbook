// The booth page's own text over the scene (brand, mixnet lamp, block, keyboard-reachable buttons).
// The same chrome stands alone while the 3D scene loads, so nothing else shows in between.

import { Logo, MixnetLamp, Wordmark } from '../ds';
import { SoundToggle } from '../ui/SoundToggle';

export function BoothChrome({ block, link, onEnter, hint = true }: { block: number; link: string; onEnter: (to?: string) => void; hint?: boolean }) {
  return (
    <>
      <header className="ld-tl">
        <div className="ld-brand">
          <Logo size={28} />
          <Wordmark height={14} />
        </div>
        <p className="bb-label bb-hi">THE PRICE IS PUBLIC. YOU ARE NOT.</p>
        <p className="bb-label">A PRIVATE PREDICTION MARKET ON ZCASH</p>
      </header>
      <div className="ld-tr">
        <MixnetLamp state={link as 'linked'} />
        <span>· BLK {block.toLocaleString('en-US')}</span>
        <SoundToggle />
      </div>
      <nav className="bd-keys" aria-label="Booth">
        <button type="button" onClick={() => onEnter()}>STEP INSIDE · ENTER</button>
        <button type="button" onClick={() => onEnter('how')}>HOW IT WORKS</button>
        <button type="button" onClick={() => onEnter('verify')}>VERIFY</button>
      </nav>
      {hint && <p className="bd-hint bb-label" aria-hidden="true">DRAG TO LOOK AROUND · CLICK THE CURTAIN</p>}
    </>
  );
}
