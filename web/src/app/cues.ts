// What just happened, for the senses: the sounds (ui/sound.ts) and the Bookie (ui/bookie) both
// listen. A cue carries no amount, market or anything else about the user: only its kind, so
// nothing that reacts to it can show more than the screen already does.

export type Cue =
  // the mixnet line
  | 'link.linked'
  | 'link.relinking'
  | 'link.down'
  | 'link.trouble'
  // the vault
  | 'vault.created'
  | 'vault.unlocked'
  | 'vault.locked'
  | 'vault.restored'
  // money in and out
  | 'credit'
  | 'topup.opened'
  | 'withdraw.sent'
  | 'payout'
  // trading
  | 'bet.sent'
  | 'bet.filled'
  | 'bet.partial'
  | 'bet.unfilled'
  | 'sell.filled'
  | 'cashin'
  | 'resolved.win'
  | 'resolved.loss'
  | 'calledit'
  // slips by hand
  | 'slip.sent'
  | 'slip.received'
  | 'slip.back'
  // blind duels
  | 'duel.opened'
  | 'duel.taken'
  | 'duel.cancelled'
  // when things don't go to plan
  | 'refused'
  | 'error'
  | 'doubt'
  | 'redirected';

type Listener = (c: Cue) => void;
const listeners = new Set<Listener>();

export function cue(c: Cue) {
  listeners.forEach((f) => {
    try {
      f(c);
    } catch {
      /* a listener's trouble is its own */
    }
  });
}

export function onCue(f: Listener): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}
