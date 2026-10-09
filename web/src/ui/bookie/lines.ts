// What the Bookie says. He takes bets blindfolded on principle, and his lines never carry an
// amount, a market or anything else about the user: only what kind of thing just happened, which
// the screen shows anyway.

import type { Cue } from '../../app/cues';

type Key =
  | Cue
  | 'hello.new'
  | 'hello.back'
  | 'hello.open'
  | 'link.linking'
  | 'link.browser'
  | 'tip'
  | 'night'
  | 'wake'
  | 'egg'
  | 'hide'
  | 'page.markets'
  | 'page.market'
  | 'page.slips'
  | 'page.cage'
  | 'page.verify'
  | 'page.how'
  | 'page.duels'
  | 'page.record'
  | 'page.pass'
  | 'page.apps';

export const LINES: Record<Key, string[]> = {
  'hello.new': [
    "New face? Couldn't tell you. Make a vault and I'll never see what's in it.",
    "Step up. I don't do names, I don't do faces. Start with a vault.",
    'Welcome to the only counter where the bookie wears the blindfold.',
  ],
  'hello.back': [
    "Back again? Couldn't say. Open your vault: I never get the key.",
    "Somebody's at the counter. I'd say who, but I can't. Open the vault.",
  ],
  'hello.open': ["Counter's open. Pick a market, I'll stamp it blind."],
  'link.linking': [
    'Ringing the tube… three hops, and nobody on the line knows both ends.',
    'Calling through the mixnet. Takes a few seconds; worth every one.',
    'Line goes through three strangers who never meet. Hold on.',
  ],
  'link.linked': ["Line's clear. Nobody's listening.", 'Connected. Your bets travel in the dark from here.', 'Through. Speak freely.'],
  'link.relinking': ['Line went quiet. Finding a fresh route.', 'Static on the tube. New route, new strangers.'],
  'link.down': ["Line's dead. I don't take bets over an open phone.", "No mixnet, no bets. That's the house rule, not a bug."],
  'link.trouble': [
    "Something on your network is jamming the tube. Another network, or the .onion door.",
    "Can't get a line out from where you are. Try mobile data, or come in through Tor.",
  ],
  'link.browser': ["This browser won't run the tube's machinery. Allow it, or try another browser."],
  'vault.created': ['Vault made. Those twelve words are the only key, and I never saw them.', "Your vault. My blindfold. We're going to get along."],
  'vault.unlocked': ["Vault's open. Didn't peek.", 'Welcome back, whoever you are.', 'Open. I heard the lock, saw nothing.'],
  'vault.locked': ["Shutter's down. Nothing of yours on the counter.", "Locked. I'll keep facing the wall."],
  'vault.restored': ['Rebuilt from the public log. Nobody was asked a thing.'],
  credit: ["Credit's in. Don't tell me how much.", "Counted it blind. It's all there, I'm told.", 'In the vault. Not in my head.'],
  'topup.opened': ['A one-time address, just for this. Pay from a shielded wallet.', "Fresh address. Nobody's ever used it, nobody will again."],
  'withdraw.sent': ["Envelope's in the tube. The address is sealed: I couldn't read it if I tried.", "Off it goes. I'll forget where the moment it's paid."],
  payout: ['Paid out. Already forgot where.', 'Money went home. The address went in the shredder.'],
  'bet.sent': ['Slip coming up…', 'Your call. Stamping blind.', 'Into the batch it goes.'],
  'bet.filled': ["Signed it without looking. That's the whole trick.", 'Stamped. The slip is yours; I never saw it.', 'There. Bearer slip, warm off the press.'],
  'bet.partial': ['Took what the house could hold. The rest went back to your pocket.'],
  'bet.unfilled': ["Couldn't take that one at that price. Nothing left your pocket.", 'Price ran past your limit. No harm done.'],
  'sell.filled': ['Sold. The old slip is ash; the credit is yours.', "Bought it back, sight unseen."],
  cashin: ['Cashed in. Winning shares, paid blind.', 'Paid. Nice work, stranger.'],
  'resolved.win': ['CALLED IT! Cash in whenever you like.', 'Ding ding! You had it right.', 'Winner. And nobody knows it was you.'],
  'resolved.loss': ['House takes this one. Nobody knows it was you.', "Didn't land. Next one might."],
  calledit: ['Smile. Only that one bet shows; the rest of you stays in the dark.', 'A receipt for one call. Show it to whoever you like.'],
  'slip.sent': ['Slips in an envelope. Whoever holds the code owns them.', "Hand it over in person if you can. Bearer cash is bearer cash."],
  'slip.received': ['Taken over: new secrets, new signatures. The old code is void.'],
  'slip.back': ['Took it back before anyone else did.'],
  'duel.opened': ['A blind duel is out. Whoever takes it, I won\'t know who.', 'Challenge posted. Two strangers, one price.'],
  'duel.taken': ["Duel's on. Neither of you knows the other. Neither do I."],
  'duel.cancelled': ['Challenge withdrawn. The stake is back with you.'],
  refused: ['Counter said no. Nothing was spent.', "That didn't go through. Your slips are where they were."],
  error: ["Hm. That didn't take.", 'Something jammed. Try again in a moment.'],
  doubt: ['No answer from the counter. Checking the public log myself…', 'Lost the reply. The log will tell us what happened.'],
  redirected: ['Someone fiddled with that request on the way. The log shows it. Report it.'],
  tip: [
    "Prices come from Polymarket, live. Names stay at home.",
    "Every slip is bearer cash. Lose the twelve words and they're gone for good.",
    'I sign slips I can\'t see. Mathematicians call it a blind signature. I call it manners.',
    'Your requests go through three mix nodes. Nobody on the way knows both who and what.',
    "Restoring asks the server nothing. It reads the same files as everyone.",
    "The house can't link your top-up to your bets. Neither can I.",
    'CALLED IT prints one bet, nothing else. Brag safely.',
    'F4 VERIFY replays every batch in your own browser. Trust, but check.',
    'Trading stops when the game starts. Nobody beats the feed here.',
    'A winning share pays one coin. A losing one pays a story.',
    'ESC ESC and you\'re gone. Nothing of you stays on screen.',
    'Whoever holds a slip owns it. Hand it over as a code, or print it.',
    'Blind duels: name your price, someone takes it, nobody knows who.',
    'Sound bothering anyone? The speaker\'s right there in the corner.',
    "I've worn this blindfold since block one.",
    'Pay from a shielded wallet. A transparent one tells the world what it sent.',
    'Withdraw to a fresh address. Old addresses have long memories.',
    "Mix delay holds a bet back a few random seconds. Timing's a fingerprint too.",
    "The receipts are public. The people aren't.",
  ],
  night: ['Late one. The tube never sleeps; I try to.', 'Night shift. Markets don\'t close for the moon.', 'Burning the midnight oil, are we?'],
  wake: ["Wha— I wasn't asleep. I was mixing.", 'Hm? Yes. Open. Always open.', "Just resting my eyes. Not that you'd know."],
  egg: ['…another blindfold. It goes all the way down.', 'Nothing to see. Literally.', 'You really thought there were eyes under there?'],
  hide: ['Stepping out. START brings me back.'],
  'page.markets': ['Every market mirrors Polymarket. The crowd there sets the price; you bet in the dark here.', 'Pick one. I take bets on anything that settles on-chain.'],
  'page.market': ['Pick a side and a size. The max price keeps you safe if the market jumps.', 'The line under the BUY key says exactly how it fills. No surprises.'],
  'page.slips': ['Your slips. Sell them back, hand them over, or print them. Cash in winners after the result.'],
  'page.cage': ['Top up from a shielded wallet, redeem a code, or withdraw to a fresh address.', 'Money in and out uses its own line, separate from your bets.'],
  'page.verify': ["Check my books. Every batch, every signature, every coin in the reserve.", 'If this says green, I ran an honest counter.'],
  'page.how': ['Four steps. Top up, bet, hold slips, cash out. I handle the blindfold.'],
  'page.duels': ['Name a price, post the challenge, wait for a stranger.'],
  'page.record': ["That's everything the server kept about you. Not much, is it?"],
  'page.pass': ['Your NOBODY PASS. A new face every time. Never yours.'],
  'page.apps': ['The back room. Nothing in here talks to the outside.'],
};

/** A line for this moment, never the same one twice in a row. */
export function pick(key: keyof typeof LINES, last?: string): string | null {
  const list = LINES[key];
  if (!list.length) return null;
  const choices = list.length > 1 ? list.filter((l) => l !== last) : list;
  return choices[Math.floor(Math.random() * choices.length)]!;
}

export type LineKey = keyof typeof LINES;
