# Demo video plan (2:00)

The video is the judges' first impression. Every second shows something **real** running. Captions instead of voice, so it works muted and needs no recording booth. Music is procedural or CC0 only.

## Storyboard

| Time | Shot | On screen | Caption |
|---|---|---|---|
| 0:00–0:08 | Typographic cold open (our design system) | a public ledger scrolls: wallet → bet → size → time, names circled in red | "On a public prediction market, every bet is a dossier." |
| 0:08–0:16 | 3D booth, lamp flickers, curtain closes, CRT boots | `THE PRICE IS PUBLIC. YOU ARE NOT.` | "Blindbook. A private prediction market on Zcash." |
| 0:16–0:30 | **iPhone screen recording, top-up (mainnet proof, 0.005 ZEC):** cage → 0.005 ZEC → preflight ticks → PAY IN WALLET → Zodl prefilled → send → back → SEEN stamp → CREDITED (seconds) | real mainnet | "Top up once. One tap. No account." |
| 0:30–0:46 | **Instant bet:** market page → BUY YES 0.002 → ~3 s → slip tears off, tape shows a redacted line | real mainnet | "Then bet in seconds, from a balance only your phone knows." |
| 0:46–1:06 | **What everyone else sees** (split screen): block explorer (a shielded tx, nothing readable) · our public tape (redacted line) · our own server log (no IP, unlinkable token) | | "The chain can't see you. The network can't. We can't." |
| 1:06–1:24 | Five-layer diagram builds up, one layer per beat | funding · positions · payout · network · device | "Five independent layers. Breaking one doesn't break the rest." |
| 1:24–1:42 | Resolution: tally board flips `RESOLVED · YES` (Polygon tx shown) → redeem → withdraw → Zodl receives | | "Settled from Polymarket's on-chain result. Paid out unlinkably." |
| 1:42–1:54 | Verify page: hex scrolls → `LEDGER MATCH ✓ SOLVENT ✓ ANCHORED ✓`; console `verbose on` shows blinding/DLEQ | | "Don't trust us. Replay it in your browser." |
| 1:54–2:00 | Logo eye with a redaction bar | URL · "Built on Zcash Ironwood · Nym · Polymarket data" | "The price is public. You are not." |

## Production pipeline

1. **Capture:**
   - iPhone: built-in screen recording; the Zodl part is real, with private details blurred in edit if any appear;
   - desktop: Playwright scripted runs (deterministic, 60 fps, 1080p);
   - 3D booth: in-browser capture.
2. **Edit:** Remotion (React) composition in `video/`, using the same tokens, fonts and components as the app. Captions are typed in our pixel font.
3. **Sound:** procedural (the app's own relay/flap/printer sounds plus a low synth drone generated in code), so no licensing issues.
4. **Export:** 1080p H.264, ≤ 2:00, upload unlisted to YouTube (backup on Loom).
5. **Fallback:** if mainnet resolution timing doesn't line up, show a short-dated market that resolved earlier in the week, with its Polygon tx on screen. Never fake a resolution.

## Rules

- Nothing staged that the product can't do: every UI moment is captured from the real app.
- No real people's names, faces or third-party logos in the cold open; Polymarket is named only as the data source.
- Sensitive values (seed words, addresses) are never shown un-blurred.
