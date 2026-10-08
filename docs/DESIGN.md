# Design

**The Blind Booth.** The voting booth is the oldest privacy technology that works: the tally is public and the booth is private. Blindbook is that booth, for markets. You don't log in; you step into a booth, the curtain closes, and a green-phosphor terminal from an alternate 1986 boots up: it knows prices, not people.

The design system lives in `web/src/ds/` (tokens, fonts, the 7×7 pixel icons and every component); the exports it came from are in [`design/`](../design/README.md).

## The one rule

**Retro, and instantly understandable.** A first-time visitor who has never heard of Zcash or teletext must be able to place a bet in under a minute without reading docs. The look never costs clarity.

## Clarity

1. **Every retro control has a plain label.** `F1 MARKETS`, never just `F1`; page numbers are shortcuts, never the only way in. Everything the console can do also has a button.
2. **Prices speak human:** `LEGACY 45¢ · 45%`, with Polymarket's own outcome labels. Every bet shows its result up front: `If LEGACY wins → you get 0.0222 ZEC (+0.0122)`.
3. **Conditions are never hidden:** one line under every BUY key (`Fills in ~2 s · max 48¢ · fee 1% · trading closes at the event start`), and a RULES panel on every market.
4. **One primary action per window,** drawn as a physical key with pressed, disabled and loading states.
5. **A hint strip** at the bottom of each window explains the focused element in one plain sentence.
6. **Errors say what happened and what to do next:** `MIXNET LINK LOST · reconnecting… your balance is safe`, never just `ERROR`.
7. **Status is always visible:** balance, the mixnet lamp, the block height.
8. **CLEAN SIGNAL** turns off scanlines, noise and glow; it is remembered on the device.

## Restraint

| Layer | What | When |
|---|---|---|
| Calm working surface | page icons, one window in focus, the taskbar | always |
| Moments | receipt printing, the SEEN stamp, a slip tearing off | 1–2 s, at the event itself |
| Hidden delights | console, easter eggs, screensaver, the back room | only when invoked |

Green and amber are the two outcomes, violet is Polymarket's reference and links, alarm red is for real alarms only. Three brightness levels of green carry the hierarchy. Constant motion is limited to the mixnet lamp.

## Usability targets (checked on a real iPhone and a desktop at Gate 3)

| Criterion | Target |
|---|---|
| New visitor with a judge code → first bet | ≤ 60 s, no docs |
| Tap BUY → slip in the vault | p50 ≤ 3 s, p95 ≤ 6 s |
| Top-up within the 0-conf cap: PAY IN WALLET → credited | ≤ 40 s |
| Every action reachable without the console or keyboard shortcuts | 100% |
| Layout at 375 px | no horizontal scroll, 44 px targets |
| Console errors in a clean session | 0 |

Nobody has to install an extension or an app-store app, make an account, connect a wallet, configure a network, copy an address on iPhone (one tap opens Zodl), wait for confirmations to bet, or type the 12 words to try the testnet playground.

## Hard constraints (privacy, not taste)

- **Zero third-party requests:** fonts, icons, sounds and the 3D booth are all local (fonts are OFL). The mixnet client's directory lookup and entry gateway are the only outside contacts (THREAT_MODEL N5); CI fails on anything else.
- No analytics, embeds, external avatars, maps or video players.
- **Constant URL:** navigation never changes the address bar or the history, and the tab title is always `Blindbook`. Proof links are the one exception, and the app clears them from the address bar as soon as one is opened.

## Motion, sound, accessibility, performance

- Motion is physical: relays, flaps and paper, 120–400 ms, mechanical easing. `prefers-reduced-motion` starts with CLEAN SIGNAL on.
- Sound is off by default; when on, it is procedural WebAudio (no audio files).
- Real text everywhere: the CRT look is CSS layers over the DOM, never text drawn in a canvas. WCAG AA contrast. Full keyboard: F-keys, the console on `` ` ``, ESC ESC locks the vault.
- App shell under 300 KB gzip (checked in CI); the 3D booth is a lazy chunk and falls back to a 2D booth without WebGL; the mixnet module loads during the boot and is cached by the service worker.
