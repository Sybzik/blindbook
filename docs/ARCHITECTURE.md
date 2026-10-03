# Architecture (v3)

> **Privacy is trustless. Custody is verifiable.**
> Nobody can link a bet to a person, or a payout to a bet: not chain observers, not network observers, not exchanges, and **not us**. That holds by construction, not by promise. What you do trust us with (holding funds) anyone can check at any time.

Companion docs: [PROTOCOL.md](PROTOCOL.md) (wire formats, algorithms), [MARKETS.md](MARKETS.md) (Polymarket data and settlement), [THREAT_MODEL.md](THREAT_MODEL.md).

**What changed in v3:**
- **Bets are instant (2–5 s).** You top up once with a shielded payment, then bet from your private balance without touching the chain.
- **Prices track Polymarket live**, shifted by our own users' flow.
- **Per-action network isolation**, so even request sessions can't be linked.

## Principles

1. **No identity anywhere.** No accounts, no wallet-connect, no cookies, no analytics, no third-party requests.
2. **Five independent privacy layers.** Each closes one question on its own.
3. **Never degrade silently.** If a privacy layer is down, the UI says so and stops.
4. **Publish everything except people.** Prices, volumes, issuance, reserves and payout totals are public. Addresses, transactions and identities are not.
5. **Internet-facing code holds no secrets.** A fully compromised API leaks no identities and can't move money.
6. **No targeted queries, anywhere.** Download everything, filter locally.
7. **Clarity over cleverness.** The retro look never hides what a button does or what a price means.
8. **Working beats ambitious.** Every stretch goal has a fallback ([ROADMAP.md](ROADMAP.md)).

## The five layers

| Layer | Question | Mechanism |
|---|---|---|
| **1. Funding** | Who paid? | Ironwood shielded **top-up** to a **one-time diversified address** that is never published. Standard denominations. |
| **2. Positions** | Who holds what? | **Chaumian e-cash.** Balance and positions are blind-signed bearer tokens (*slips*), built on Cashu's BDHKE + DLEQ primitives. The mint signs without seeing, so no action links to any other. |
| **3. Payout** | Where did the money go? | Shielded payout to a fresh address, fixed transaction shape, **discarded outgoing viewing key**, destination sealed to the signer and forgotten. |
| **4. Network** | Who is online, and from where? | Static app from hosts that aren't ours. **Every API call goes through the Nym mixnet**, with a **fresh connection per action**. One identical data bundle for everyone. |
| **5. Device** | What's on your phone? | 12-word phrase, vault encrypted at rest, deterministic secrets, **zero-query restore**. |

## Components

```
┌────────── Browser · static SPA from independent hosts (IPFS · mirror · .onion) ───────────┐
│ vault (BIP 39 · Argon2id · AES-GCM) · slip wallet (blind / unblind / DLEQ verify)          │
│ keyset derivation from the pinned mint master key · in-browser verifier (WASM)            │
│ ZIP 321 deep link (phone) or QR (desktop) · privacy preflight · proof-of-work              │
└──────────────────────────────────────────▲─────────────────────────────────────────────────┘
                                           │ Nym mixnet (mixFetch), TLS inside WASM, new connection per action
┌──────────────────────────────────────────┴─────────────────────────────────────────────────┐
│ blindbook-api   SECRETLESS · top-up desk · 2-second trade batches · bundle publisher       │
│ blindbook-indexer  untargeted chain sync, mempool watch, one-time address bookkeeping     │
│ blindbook-engine   pure + deterministic: anchored LMSR, batch clearing, issuance, roots   │
│ reference feed     Polymarket CLOB WebSocket (live book) · Gamma (catalog) · Polygon CTF   │
└──────────────────────────────────────────▲─────────────────────────────────────────────────┘
                                           │ persistent OUTBOUND stream opened by the signer
┌──────────────────────────────────────────┴─────────────────────────────────────────────────┐
│ blindbook-signer  ALL secrets: mint keys · deposit + reserve spending keys                 │
│   own indexer + own engine replay → signs only what it can justify · supply guard          │
│   blind-signs batches in ms · sweeps · payouts · hourly on-chain anchors                    │
│   stretch: FROST 2-of-3 (ZIP 312)                                                          │
└────────────────────────────────────────────────────────────────────────────────────────────┘
  blindbook-verify (CLI and browser WASM, same Rust code): bundle + reserve viewing key → replay
```

### Who holds which key

| Key | Where | If stolen |
|---|---|---|
| Deposit account viewing key | API, signer | attacker sees top-up amounts and times; no identities |
| Deposit and reserve **spending** keys | signer only | funds at risk; visible immediately in the solvency check |
| Mint master **secret** | signer only | forged slips; caught by the supply guard, and withdrawals halt |
| Mint master **public** key | pinned in the app build | public by design |
| Reserve account viewing key | public | proves reserves |
| Signer X25519 key | signer only | payout addresses of withdrawals still pending |

### Two Zcash accounts

- **Deposit account:** a one-time diversified address per top-up. Its viewing key is never published, so nobody, including the exchange or wallet that sent the money, can recognize the address as Blindbook's. One viewing key trial-decrypts all such addresses, so the cost doesn't grow with their number.
- **Reserve account:** viewing key **public**. Deposits are swept in hourly; every payout comes from here.

## Flow 1: top up (once, on-chain)

1. Pick a standard top-up amount (testnet 0.01–0.5 TAZ; mainnet proof 0.001–0.01 ZEC).
2. The browser derives blinded CREDIT outputs from the vault seed and registers the top-up over the mixnet (with proof-of-work). It gets back a **one-time unified address** (Orchard-protocol receiver only).
3. **Privacy preflight**, then:
   - **phone:** *Pay in wallet* opens `zcash:<address>?amount=0.05` in Zodl, prefilled;
   - **desktop:** a QR code generated locally.
4. Our indexer and the signer's independent indexer both see the payment **in the mempool** within seconds.
   - **small top-ups are credited at once (0-conf)**, within house-insured caps (testnet ≤ 0.1 TAZ, mainnet ≤ 0.005 ZEC);
   - bigger ones are credited after 1 confirmation (~1–2.5 min).
5. The signer blind-signs the CREDIT outputs, and the browser unblinds them. You now hold a **private balance**: bearer CREDIT slips that only your device knows about.

## Where your balance lives (and why it isn't an account)

**There is no balance on our server.** No table has a row for you, because there is no "you" to attach it to.

- Your balance **is** a set of e-cash tokens (CREDIT slips). Each slip is a random 32-byte secret plus the mint's blind signature on it. Slips come in power-of-two amounts, like banknotes.
- **They exist only on your device:** in IndexedDB, encrypted with a key derived from your passphrase (Argon2id → AES-GCM). The 12-word phrase can regenerate every secret.
- **What the server knows:** the **total** issued per keyset and the list of spent slips (`Y = hash_to_curve(secret)`). It can't see anyone's balance, can't tell which slips belong together, and can't freeze one person's funds, because it can't tell whose slips are whose.
- **Spending (a bet, a sell, a withdrawal):** you hand over some slips and receive freshly blinded new ones (the position plus change). The mint sees "valid slips worth X were spent, and new ones were issued". Blinding makes the new slips unlinkable to the old ones, even for the mint.
- **Amount privacy:** the wallet keeps slips in standard denominations and spends only what a request needs (with change), so a request never reveals your whole balance. It quietly re-splits in the background over separate connections.
- **Lost phone or cleared browser:** type the 12 words on any device. The browser derives your blinded messages, finds them in the public issuance log and unblinds them. **It never asks the server "what's mine?"**

Compare: Polymarket keeps your balance under a public wallet address; a typical custodial app keeps it under an account ID. Both link everything you do. Here the most the server could hand over is aggregate totals. This is Chaum's e-cash (1982), the same idea as Cashu and Fedimint, applied to a market.

## Flow 2: bet (instant, off-chain)

1. Pick a market and an outcome, type any amount from your balance, set a max price (prefilled with a sensible slippage).
2. The browser spends CREDIT slips plus new blinded outputs for the position keyset and change, over a **fresh mixnet connection**.
3. The API collects all requests that arrive within a **2-second batch window** and clears them together: one price per side, priced off Polymarket's live book plus our users' net flow (below).
4. The signer, holding its own replica of the state, checks the batch and blind-signs in milliseconds. The response carries the signatures.
5. **About 2–5 seconds after tapping BUY, the position slip is in your vault.** No chain transaction, no wallet switch.

Sell, swap, transfer and redeem work the same way and take seconds.

## Flow 3: withdraw

- Spend CREDIT slips and give a fresh unified address with an Ironwood receiver. The address is **sealed to the signer's key** in the browser.
- Before sending, the browser **opens a brand-new mixnet session** (new client, new connection) and waits a random 0–60 s, so the operator can't link the withdrawal to the session you traded in.
- Payouts go out every block when the queue isn't empty, in fixed-shape transactions (8 Ironwood actions, padded), with a discarded OVK. The signer forgets the destination after broadcast. Total time: ~2–4 minutes.
- Transparent and Sapling-only addresses are rejected (pool crossing would publish the amount).

## Price discovery: an LMSR anchored to Polymarket, in 2-second batches

The price **starts at Polymarket's price and stays tied to it**, shifted by what our own users buy and sell:

```
price_YES = σ( logit(polymarket_mid) + (users_YES_shares − users_NO_shares) / b )
```

- **Before anyone trades here,** our price equals Polymarket's mid.
- **When our users buy YES,** our YES price rises above Polymarket's: that's our own price discovery, and it's public.
- **When Polymarket moves,** our price moves with it, so it's never stale and there's no free arbitrage.
- **Buying a quantity** integrates along this curve. It's the LMSR cost function with a moving anchor, and the closed form is unchanged.
- **Guard:** a buy is never cheaper than Polymarket's best ask, and a sell never pays more than its best bid.
- **Exposure buffer:** each market has a funded buffer `L_m`. A trade is accepted only if the house's worst-case loss in that market stays within it. Larger trades are partially filled, with the rest returned. This bounds the house's risk exactly and keeps the public solvency check green.
- **Batches:** all requests in a 2-second window clear together. Opposing flow is matched as complete sets (YES + NO = 1 ZEC), only the imbalance moves the curve, and everyone on a side gets the same price. Ordering inside the window doesn't matter.
- **Halts:** trading stops when Polymarket stops accepting orders, either outcome ≥ 0.98, the end date passes, or the live reference is older than 10 s.
- **Determinism:** pure-Rust `libm`, fixed rounding; the verifier is the same code (also WASM).

**Why not start at 50/50?** If Polymarket says 90% and we show 50%, the first trader buys a share worth ~0.90 for ~0.50 and takes ~0.40 ZEC per share out of the house. Starting from (and staying tied to) Polymarket's price is both correct and safe.

Math, examples and parameters: [PROTOCOL.md §5](PROTOCOL.md).

## Settlement

From Polymarket we take three things:

1. **the catalog** (Gamma API),
2. **a live reference price** (CLOB WebSocket + REST),
3. **the result**, read directly from Polymarket's ConditionalTokens contract on Polygon.

**Gamma's `outcomePrices` are never used for settlement:** they show 1/0 while the UMA result is still only *proposed*. On-chain reads are verified for binary markets and for single markets inside negRisk events. Details: [MARKETS.md](MARKETS.md).

## Verifiability without exposure

| Public | What it proves |
|---|---|
| Mint master public key (pinned); keysets derived in the browser; DLEQ proof on every signature | same keys for everyone; no tagging |
| Issuance log: every blind signature (`B_`, `C_`, DLEQ), shuffled per batch | what exists; enables zero-query restore |
| Spent set | what was redeemed; outstanding = issued − spent |
| Batch inputs, Polymarket reference snapshots, clearing results | replay reproduces every price and every issuance |
| Reserve viewing key | reserve balance, sweeps in, payout totals out |
| Hourly **on-chain anchor** of the bundle root | history can't be rewritten or forked per user |

**Checks** (`blindbook-verify`, CLI or browser):
1. Replay equals the published state.
2. Issuance is backed by top-ups and sweeps.
3. `reserve ≥ CREDIT outstanding + Σ_markets max(YES, NO outstanding)`.
4. Every signature verifies under a derived key.
5. Anchors match.

**Never public:** deposit addresses, deposit txids, the deposit viewing key, payout destinations.

## Timing budget

| Action | Typical | Was (v2) |
|---|---|---|
| App start: mixnet link | 5–15 s, hidden in the boot animation | same |
| **Top up within the 0-conf cap** (wallet send → balance) | **~15–40 s** | 2.5–5 min |
| Top up above the cap | ~1–2.5 min (1 confirmation) | 2.5–5 min |
| **Bet / sell / buy more** | **~2–5 s** | 1.5–5 min |
| Swap / transfer a slip | ~1–3 s | same |
| Redeem after resolution | ~2–5 s | ~2–5 s |
| Withdraw → in your wallet | ~2–4 min (+ 0–60 s privacy delay) | 10–15 min |

For comparison, a Polymarket trade takes ~1–2 s. We pay 1–3 seconds for privacy that Polymarket doesn't offer at all.

### What 0-conf credit costs us and why it's safe

- A Zcash node rejects a second transaction that spends the same note, and Zcash has no replace-by-fee. Double-spending an unconfirmed top-up therefore takes a miner's collusion.
- We cap it (testnet ≤ 0.1 / 0.3 TAZ; mainnet ≤ 0.005 / 0.01 ZEC, per top-up / total unconfirmed). Above the cap, credit waits for one confirmation.
- The worst case (a successful double-spend) is a loss the house covers from fees. Users are never affected.

## Tech stack

| Layer | Choice |
|---|---|
| Core | Rust 1.95 (edition 2024), tokio, axum, SQLite; engine crate is pure, deterministic, compiles to WASM |
| Zcash | librustzcash: `zcash_client_backend` 0.24, `zcash_client_sqlite` 0.22, `zcash_keys` 0.16, `zcash_protocol` 0.10, `orchard` 0.15, `pczt`; `zcash-devtool` as reference |
| Chain access | lightwalletd gRPC (`testnet.zec.rocks:443`), untargeted; option: self-hosted Zebra 6.3 + Zaino 0.8 |
| E-cash | `cashu` crate from CDK (BDHKE, NUT-12 DLEQ); `@cashu/cashu-ts` primitives in the browser; our own multi-keyset mint |
| Reference prices | Polymarket CLOB WebSocket market channel + REST fallback |
| Polygon | raw `eth_call` against two independent public RPCs, results cross-checked |
| Network privacy | `@nymproject/mix-fetch` 2.x with per-action connections; own Nym exit if needed; Tor onion as an explicit fallback |
| Web | Vite, React 19, TypeScript, Tailwind v4, three.js / React Three Fiber, hash routing, PWA, strict CSP |
| Vault | `@scure/bip39`, Argon2id (WASM), AES-GCM, X25519 sealed boxes (`@noble/curves`) |
| Infra | Docker Compose, Caddy, Tor; static app hosted separately from the API |
| Video | Remotion + Playwright capture + iPhone screen recording |

## Decisions

| # | Decision | Status |
|---|---|---|
| D1 | LMSR **anchored to Polymarket's live mid** + guard + exposure buffer, 2-second batches | decided (v3) |
| D2 | **testnet is the playground** (full experience for judges, free); **mainnet is the proof** (same build, micro stakes, ≤ $30 of ZEC) | decided (v3, $50 budget) |
| D3 | one isolated signer holding all secrets; FROST 2-of-3 as stretch | proposed |
| D4 | private deposit viewing key, public reserve viewing key, discarded-OVK payouts | decided |
| D5 | no NEAR Intents on-ramp (transparent ZEC only, a leak) | proposed |
| D6 | curated 8–12 binary markets, including single markets from negRisk events | proposed |
| D7 | top-up denominations: testnet 0.01 / 0.05 / 0.1 / 0.5 TAZ; mainnet 0.001 / 0.005 / 0.01 ZEC; bets in any amount from the balance | decided (v3) |
| D8 | 0-conf credit: testnet 0.1 / 0.3 TAZ; mainnet 0.005 / 0.01 ZEC (per top-up / total unconfirmed) | proposed |
| D9 | judge vouchers on **testnet** (free); the mainnet proof is shown in the video with tx evidence | proposed |
| D10 | fresh mixnet connection per write; fresh mixnet session + random delay for withdrawals | decided (v3) |
