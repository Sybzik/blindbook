// The speaker: sound on or off, from the landing, the taskbar and the pager (a preference kept
// in plain storage, like CLEAN SIGNAL).

import { PixelIcon } from '../ds';
import { useStore } from '../app/store';
import { ui } from './uistate';
import { play } from './sound';

export function SoundToggle({ label = false, className = '' }: { label?: boolean; className?: string }) {
  const on = useStore(ui, (s) => s.sound);
  return (
    <button
      type="button"
      className={'tk-sound' + (on ? ' is-on' : '') + (className ? ' ' + className : '')}
      aria-pressed={on}
      aria-label={on ? 'Sound on: turn it off' : 'Sound off: turn it on'}
      title={on ? 'Sound on' : 'Sound off'}
      onClick={(e) => {
        e.stopPropagation();
        ui.set({ sound: !on });
        if (!on) setTimeout(() => play('ding'), 30);
      }}
    >
      <PixelIcon name={on ? 'speaker' : 'mute'} size={14} />
      {label && <span>{on ? 'SOUND' : 'MUTED'}</span>}
    </button>
  );
}
