# Blindbook

> **The price is public. You are not.**
> A private prediction market on Zcash. Bet on real-world events (mirrored from Polymarket) with shielded ZEC.
> Prices, volumes and reserves are public and verifiable. **Who bet, on what, and where the winnings went is not, even to us.**

Built for [Zecathon](https://thezecathon.com/), track **Private Markets**.

> Status: **design complete, build starting** (Oct 3, 2026). Hackathon software. Small stakes only.

## Why

On Polymarket, every position is a public dossier: wallet, size, timing and history. Whales get tracked, copied and doxxed.
Prediction markets need public prices, not public participants. Zcash is the one place where that split is native.

## Privacy in five layers

| Layer | Question | Closed by |
|---|---|---|
| Funding | Who paid? | Ironwood shielded top-up to a one-time address nobody can recognize as ours |
| Positions | Who holds what? | Chaumian e-cash: positions are blind-signed bearer *slips*, so even we can't link a buy to a payout |
| Payout | Where did the money go? | Fixed-shape shielded batches with a discarded outgoing viewing key; destinations sealed to an isolated signer |
| Network | Who is online? | Every request through the Nym mixnet with a fresh connection per action; one identical data bundle for everyone; zero third-party requests |
| Device | What's on your phone? | 12-word phrase, encrypted vault, restore without asking the server anything |

**Privacy is trustless. Custody is verifiable.** The internet-facing server holds no secrets. Anyone can replay the public log, in the browser, and check prices, issuance and solvency against the public reserve.

## How a bet works

1. **Top up once:** pay a one-time address from any shielded Zcash wallet (one tap on iPhone via Zodl; QR code on desktop). Up to 0.1 ZEC is credited within seconds as a private balance only your device knows about.
2. **Bet instantly (2–5 s):** pick a market and an outcome. Your bet clears in a 2-second batch at Polymarket's live price, shifted by our users' net flow, and never cheaper than Polymarket's book.
3. **Hold bearer slips:** sell them, hand them to someone, or redeem when Polymarket's result is final on Polygon.
4. **Withdraw** to a fresh shielded address. Nobody, including us, can tie that payout to your bets.

## Docs

| Doc | What's inside |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | the five layers, components, who holds which key, flows, timing budget |
| [PROTOCOL.md](docs/PROTOCOL.md) | units, keysets, slips, API, anchored-LMSR batch clearing with worked examples, bundle, signer |
| [MARKETS.md](docs/MARKETS.md) | what we take from Polymarket, listing rules, the guard, on-chain settlement, edge cases |
| [THREAT_MODEL.md](docs/THREAT_MODEL.md) | adversaries, who-can-learn-what matrix, every leak and its fix, residual risks |
| [DESIGN_BRIEF.md](docs/DESIGN_BRIEF.md) | "the Blind Booth": identity, 3D landing, terminal, mobile pager, console, easter eggs |
| [ROADMAP.md](docs/ROADMAP.md) | day-by-day plan, gates, fallbacks, cut list, budget |
| [RISKS.md](docs/RISKS.md) | project risk register |
| [SUBMISSION.md](docs/SUBMISSION.md) | rules compliance, judging criteria, description draft, judge quickstart |
| [VIDEO_PLAN.md](docs/VIDEO_PLAN.md) | two-minute storyboard and production pipeline |
| [RESEARCH.md](docs/RESEARCH.md) | Zcash after Ironwood, Polymarket, NEAR Intents, Nym, Cashu, prior art, verified facts |

## Repository layout (planned)

```
crates/
  blindbook-engine/   anchored LMSR, 2-second batch clearing, issuance, spent set, roots (pure, deterministic, also WASM)
  blindbook-indexer/  untargeted chain sync, one-time diversified addresses (librustzcash)
  blindbook-api/      secretless: top-up desk, trade batches, bundle and live feed (axum)
  blindbook-signer/   holds all secrets; replays before signing; blind signatures, sweeps, payouts, anchors
  blindbook-verify/   independent auditor (CLI; the engine also runs in the browser)
web/                  static SPA: vault, slip wallet, mixnet client, terminal UI, 3D booth, console
video/                demo video (Remotion)
deploy/               docker compose, Caddy, Tor onion service
```

## Security

Found a leak? See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
