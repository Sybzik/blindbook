# Architecture

> **Privacy is trustless. Custody is verifiable.**
> Nobody can link a bet to a person, or a payout to a bet: not chain observers, not network observers, not exchanges, and **not us**. That holds by construction, not by promise. What you do trust us with (holding funds) anyone can check at any time.

Companion docs: [PROTOCOL.md](PROTOCOL.md) (wire formats, algorithms), [MARKETS.md](MARKETS.md) (Polymarket data and settlement), [THREAT_MODEL.md](THREAT_MODEL.md).

## Principles

1. **No identity anywhere.** No accounts, no wallet-connect, no cookies, no analytics, no third-party requests.
2. **Five independent privacy layers.** Each closes one question on its own.
3. **Never degrade silently.** If a privacy layer is down, the UI says so and stops.
4. **Publish everything except people.** Prices, volumes, issuance, reserves and payout totals are public. Addresses, transactions and identities are not.
5. **Internet-facing code holds no secrets.** A fully compromised API leaks no identities and can't move money.
6. **No targeted queries, anywhere.** Download everything, filter locally.
7. **Anonymous by default, provable by choice.** The user, and only the user, decides what to reveal.
8. **Clarity over cleverness.** The retro look never hides what a button does or what a price means.
9. **Working beats ambitious.** Every stretch goal has a fallback ([ROADMAP.md](ROADMAP.md)).

## More than a private Polymarket

Polymarket is our **oracle and price reference**. Blindbook adds what a public order book can't have:

| | What it is | Why it matters |
|---|---|---|
| **The booth** | bet with shielded ZEC; nobody, including us, can link a bet to a person or a payout to a bet | trade on what you know without becoming a public dossier |
| **Slips you can pass under the table** | positions are bearer e-cash; hand one to anyone as a QR code or link, with no chain transaction and no record of who held it | private OTC transfer of a position, which no on-chain market can offer |
| **"Called it" receipts** | every trade carries a secret tag in the anchored public log; reveal the secret to prove "I bought YES at 18¢ at block N", to whoever you choose, whenever you choose | reputation without identity: prove you were right without exposing anything else. This is Zcash's selective disclosure, applied to forecasting |
| **Verify in your browser** | the browser replays the whole market and checks solvency against the public reserve | don't trust us; check us |
| **What we know about you** | page P600 shows the exact record our server stored for each of your requests (every write response returns it; the app keeps them in your vault) next to the fields it doesn't have (IP, account, balance, other bets) | privacy you can see, not just read about |
| **Paper slips** | print a position as a thermal-style slip with a QR; scanning it imports it and immediately re-issues it | a bearer bet you can hold in your hand, gift or hide |
| *Blind duels (stretch)* | challenge anyone with a link; the other side takes it anonymously; it's matched as a complete set and settled by Polymarket's result | peer-to-peer and zero house risk; spreads by link |

## The five layers

| Layer | Question | Mechanism |
|---|---|---|
| **1. Funding** | Who paid? | Ironwood shielded **top-up** to a **one-time diversified address** that is never published. Standard denominations. |
| **2. Positions** | Who holds what? | **Chaumian e-cash.** Balance and positions are blind-signed bearer tokens (*slips*), built on Cashu's BDHKE + DLEQ primitives. The mint signs without seeing, so no action links to any other. |
| **3. Payout** | Where did the money go? | Shielded payout to a fresh address, fixed transaction shape, **discarded outgoing viewing key**, destination sealed to the signer and forgotten. |
| **4. Network** | Who is online, and from where? | Static app from hosts that aren't ours. **Every API call goes through the Nym mixnet**: one tunnel for browsing and betting, a **separate mixnet identity** for top-ups and withdrawals, and a fresh connection for every write. One identical data bundle for everyone. |
| **5. Device** | What's on your phone? | the vault opens with **Face ID on phones** (a passkey via WebAuthn PRF) and with a **passphrase on computers**; a 12-word phrase is the real backup (required before real money; deferred for the testnet playground); deterministic secrets; **zero-query restore**. **Everything personal** (slips, proofs, notes, stamps, scores, P600 records) lives in the vault; only cosmetic preferences sit in plain storage. |

## Components

```
┌────────── Browser · static SPA from independent hosts (IPFS · mirror · .onion) ───────────┐
│ vault (BIP 39 · Argon2id · AES-GCM) · slip wallet (blind / unblind / DLEQ verify)          │
│ keyset derivation from the pinned mint master key · in-browser verifier (WASM)            │
│ ZIP 321 deep link (phone) or QR (desktop) · privacy preflight · proof-of-work              │
│ "called it" proof builder and checker                                                     │
└──────────────────────────────────────────▲─────────────────────────────────────────────────┘
                                           │ Nym mixnet (mixFetch), TLS inside WASM, fresh connection per write
┌──────────────────────────────────────────┴─────────────────────────────────────────────────┐
│ blindbook-api   SECRETLESS · top-up desk · 2-second trade batches · bundle publisher       │
│ blindbook-indexer  untargeted chain sync, mempool watch, one-time address bookkeeping     │
│ blindbook-engine   pure + deterministic: anchored LMSR, batch clearing, issuance, roots   │
│ reference feed     Polymarket CLOB WebSocket (live book) · Gamma (catalog) · Polygon CTF   │
└──────────────────────────────────────────▲─────────────────────────────────────────────────┘
                                           │ persistent OUTBOUND stream opened by the signer
┌──────────────────────────────────────────┴─────────────────────────────────────────────────┐
│ blindbook-signer  ALL secrets: mint keys · deposit + reserve spending keys                 │
│   own indexer + own engine replica → signs only what it can justify · supply guard         │
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
   - Small top-ups are credited at once (0-conf), within house-insured caps.
   - Bigger ones are credited after 1 confirmation (~1–2.5 min).
5. The signer blind-signs the CREDIT outputs, and the browser unblinds them. You now hold a **private balance**: bearer CREDIT slips that only your device knows about.

## Where your balance lives (and why it isn't an account)

**There is no balance on our server.** No table has a row for you, because there is no "you" to attach it to.

- **Your balance is a set of e-cash tokens (CREDIT slips).** Each slip is a random 32-byte secret plus the mint's blind signature on it. Slips come in power-of-two amounts, like banknotes.
- **They exist only on your device**, in IndexedDB, encrypted with a key derived from your passphrase (Argon2id → AES-GCM). The 12-word phrase can regenerate every secret.
- **The server knows only totals:** the amount issued per keyset and the list of spent slips (`Y = hash_to_curve(secret)`).
  - It can't see anyone's balance or tell which slips belong together.
  - It can't freeze one person's funds, because it can't tell whose slips are whose.
- **Spending (a bet, a sell, a withdrawal):** you hand over some slips and receive freshly blinded new ones (the position plus change). The mint sees "valid slips worth X were spent and new ones were issued". Blinding makes the new slips unlinkable to the old ones, even for the mint.
- **Amount privacy:** the wallet keeps slips in standard denominations and spends only what a request needs (with change), so a request never reveals your whole balance.
- **Lost phone or cleared browser:** type the 12 words on any device. The browser derives your blinded messages, finds them in the public issuance log and unblinds them. **It never asks the server "what's mine?"**

Polymarket keeps your balance under a public wallet address; a typical custodial app keeps it under an account ID. Both link everything you do. Here the most the server could ever hand over is aggregate totals. This is Chaum's e-cash (1982), the idea behind Cashu and Fedimint, applied to a market.

### Unlock: Face ID on phones, passphrase on computers

- **Phones (default):** Face ID. **Computers:** a passphrase only (no desktop biometrics).

- **Creating the vault on a phone** also creates a passkey for the Blindbook domain: user name `Blindbook vault`, random user handle, no email or identity.
- **Opening the vault on a phone** asks for Face ID. The WebAuthn **PRF** extension returns a 32-byte secret only after that check. HKDF turns it into the key that unwraps the vault key, and AES-GCM decrypts the vault.
- **The passkey never reaches us:** it syncs only through the user's own end-to-end-encrypted keychain (iCloud Keychain, Google Password Manager). Our server isn't involved at all; the app runs WebAuthn entirely in the browser, with no challenge from any server.
- **Fallbacks:**
  - a passphrase (Argon2id): the default on computers, and the fallback wherever PRF isn't available;
  - the 12-word phrase if the passkey is lost.
- **Domain-bound:** a passkey works only on the domain it was created for, so it's set up on the final domain (testnet playground and mainnet proof each get their own).

## Flow 2: bet (instant, off-chain)

1. **Pick and set the bet.** Choose a market and an outcome (outcomes carry Polymarket's labels: `Yes / No`, or team names such as `Legacy / PARIVISION`), type any amount from your balance, and set a max price (prefilled with sensible slippage).
2. **The browser sends one request.** It spends CREDIT slips and attaches new blinded outputs for the position and the change, plus a fresh "called it" tag. The API closes the connection after every write and TLS session resumption is off, so no two writes share a connection.
3. **The API batches.** It collects every request that arrives within a **2-second window** and clears them together at one price per side, priced off Polymarket's live book plus our users' net flow (below).
4. **The signer checks and signs.** It holds its own replica of the state, verifies the batch and blind-signs in milliseconds. The response carries the signatures.
5. **About 2–5 seconds after tapping BUY, the position slip is in your vault.** No chain transaction, no wallet switch.

Sell, swap, transfer and redeem work the same way and take seconds.

## Flow 3: withdraw

- **Spend and seal.** Spend CREDIT slips and give a fresh unified address with an Ironwood receiver. The browser **seals the address to the signer's key**, so the API never sees it.
- **A separate mixnet identity for the withdrawal.** The withdrawal runs in a hidden same-origin frame with **its own mixnet tunnel** (a different mixnet client than the one you traded on), after a random 0–60 s delay, so the operator can't link it to your trading session. Top-ups use the same separation.
- **Fixed-shape payouts.** Payouts go out every block when the queue isn't empty, in fixed-shape transactions:
  - 8 Ironwood actions, padded with zero-value outputs to throwaway addresses, so they look exactly like real recipients;
  - discarded outgoing viewing key;
  - the signer forgets the destination after broadcast.

  Total time: ~2–4 minutes.
- **Unsafe addresses are rejected:** transparent and Sapling-only addresses (pool crossing would publish the amount).

## "Called it": anonymous by default, provable by choice

1. With every trade the browser attaches `tag = SHA256("bb-called-it" ‖ s)`, where `s` is a per-trade secret derived from the vault seed.
2. The batch result publishes `tag`, the market, the outcome, the size, the average price and the block height. It's part of the public log that is anchored on-chain every hour.
3. **To prove a call later,** reveal `s`, for example as a link that carries the secret after `#` (never sent to any server or link-preview bot) or as a printable "CALLED IT" receipt card. Anyone's browser recomputes the tag, finds it in the anchored log and shows: *"bought Legacy at 44¢ at block 3,514,220 · verified ✓"*.
4. **What gets revealed:** that one trade, and only to the people you hand the secret to. Nothing links it to your other trades, your balance or your payout.
5. **Bonus:** the same proof settles disputes ("I did place this trade") without the operator ever learning anything new.

## Price discovery: an LMSR anchored to Polymarket, in 2-second batches

The price **starts at Polymarket's price and stays tied to it**, shifted by what our own users buy and sell:

```
price_A = σ( logit(polymarket_mid_A) + (users_A_shares − users_B_shares) / b )
```

- **Before anyone trades here,** our price equals Polymarket's mid.
- **When our users buy outcome A,** our A price rises above Polymarket's: that's our own price discovery, and it's public.
- **When Polymarket moves,** our price moves with it, so it's never stale and there's no free arbitrage.
- **Buying a quantity** integrates along this curve (the LMSR cost function with a moving anchor; the closed form is unchanged).
- **Robust anchor:** the anchor is the **median mid over the last 30 s**, and the guard uses **depth-aware** bid/ask (the price to fill our maximum trade size, not just the top of the book), so a spoofed or thin Polymarket book can't swing our price.
- **Guard:** a buy is never cheaper than Polymarket's ask, and a sell never pays more than its bid.
- **Exposure buffer, for buys and sells:** after every batch the house's worst-case loss in a market must stay within its funded buffer `L_m`. Trades that would break this, in either direction, are partially filled and the rest is returned. This invariant keeps the public solvency check green at all times.
- **Batches:** all requests in a 2-second window clear together. Opposing flow is matched as complete sets (A + B = 1 ZEC), only the imbalance moves the curve, and everyone on a side gets the same price. Ordering inside the window doesn't matter, and nobody sees an order before it clears.
- **Halts:** trading stops when:
  - Polymarket stops accepting orders;
  - **the event starts** (`gameStartTime` for sports; a scheduled time set at listing for announcements);
  - either outcome is ≥ 0.98;
  - the end date passes;
  - the live reference is older than 10 s.
- **Determinism:** pure-Rust `libm`, fixed rounding; the verifier is the same code (also WASM).

**Why not start at 50/50?** If Polymarket says 90% and we show 50%, the first trader buys a share worth ~0.90 for ~0.50 and takes ~0.40 ZEC per share from the house. Starting from (and staying tied to) Polymarket's price is both correct and safe.

Math, examples and parameters: [PROTOCOL.md §5](PROTOCOL.md).

## Settlement

From Polymarket we take three things:

1. **the catalog**, including the full rules text (Gamma API);
2. **a live reference price** (CLOB WebSocket + REST);
3. **the result**, read directly from Polymarket's ConditionalTokens contract on Polygon.

**Gamma's `outcomePrices` are never used for settlement:** they show 1/0 while the UMA result is still only *proposed*. On-chain reads are verified for binary markets and for single markets inside negRisk events. A 50-50 result (common in sports rules: canceled match, walkover) pays 0.5 per share. Details: [MARKETS.md](MARKETS.md).

## Verifiability without exposure

| Public | What it proves |
|---|---|
| Mint master public key (pinned); keysets derived in the browser; DLEQ proof on every signature | same keys for everyone; no tagging |
| Issuance log: every blind signature (`B_`, `C_`, DLEQ), shuffled per batch | what exists; enables zero-query restore |
| Spent set | what was redeemed; outstanding = issued − spent |
| Batch inputs (with "called it" tags), Polymarket reference snapshots, clearing results | replay reproduces every price and every issuance |
| Reserve viewing key | reserve balance, sweeps in, payout totals out |
| Hourly **on-chain anchor** of the bundle root | history can't be rewritten or forked per user |

**Checks** (`blindbook-verify`, CLI or browser):
1. Replay equals the published state.
2. Issuance is backed by top-ups and sweeps.
3. `reserve ≥ CREDIT outstanding + Σ_markets max(A, B outstanding)`.
4. Every signature verifies under a derived key.
5. Anchors match.

**Never public:** deposit addresses, deposit txids, the deposit viewing key, payout destinations.

## Timing budget

| Action | Typical |
|---|---|
| App start: mixnet link | 5–15 s, hidden in the boot animation |
| **Top up within the 0-conf cap** (wallet send → balance) | **~15–40 s** |
| Top up above the cap | ~1–2.5 min (1 confirmation) |
| **Bet / sell / buy more** | **~3–6 s** (fresh TCP+TLS connection inside the tunnel + ≤ 2 s batch window + signing); measured in Spike A |
| Swap / transfer a slip | ~1–3 s |
| Redeem after resolution | ~2–5 s |
| Withdraw → in your wallet | ~2–4 min, plus a separate mixnet tunnel (5–15 s) and a 0–60 s privacy delay |

For comparison, a Polymarket trade takes ~1–2 s. We pay a few seconds for privacy Polymarket doesn't offer at all. Spike A measures the real numbers before we commit to them in the UI.

### Speed under load (many markets, many trades)

- **One feed, whatever the number of users.** The API holds one Polymarket WebSocket subscription for every listed market and recomputes our prices. Every client polls the same `GET /v1/live` (~3 s), delta-encoded against the public `seq` and kept under ~20 KB for 200 markets. Clients never ask per market, so privacy and speed point the same way.
- **Many trades.** A 2-second batch clears all orders at once. The LMSR math touches only the markets in the batch; a blind signature with its DLEQ proof costs about 0.3 ms on one core, so 1,000 bets sign in about a second, spread across cores. The 16-bit PoW takes the client ~0.1 s with a WASM SHA-256.
- **Client rendering.** Live data lands in a Web Worker that diffs it; the UI repaints only visible rows, at most 4 times a second. The market list is virtualized, each chart is one canvas, and digits are tabular so numbers never shift the layout. Split-flap animation is used only for the big price and the block height.
- **Cheap effects.** Scanlines and noise are static pre-rendered textures (no runtime SVG turbulence filters), animations touch only `transform` and `opacity`, glow sits on a few headlines, and the app switches itself to CLEAN SIGNAL when frames drop.
- **Budgets.** Interaction to next paint ≤ 100 ms; 60 fps scrolling on an iPhone 12 or newer; app shell ≤ 300 KB gzip; one live poll ≤ 20 KB.

### What 0-conf credit costs us and why it's safe

- A Zcash node rejects a second transaction that spends the same note, and Zcash has no replace-by-fee. Double-spending an unconfirmed top-up therefore takes a miner's collusion.
- We cap it (testnet ≤ 0.1 / 0.3 TAZ; mainnet ≤ 0.005 / 0.01 ZEC, per top-up / total unconfirmed). Above the cap, credit waits for one confirmation.
- The worst case (a successful double-spend) is a loss the house covers from fees. Users are never affected.

## Networks and deployment

| Network | Purpose | Coins |
|---|---|---|
| **Regtest** (local Zebra with the internal miner + lightwalletd/Zaino) | all development, CI, end-to-end tests | unlimited, mined locally |
| **Testnet** | the public **judge playground**: real Polymarket markets and prices, test money | ~1 TAZ total |
| **Mainnet** | the **proof**: the same build with micro stakes, recorded in the video | ≤ 0.02 ZEC |

Polymarket data and Polygon settlement are always the real mainnet ones; only the Zcash network differs.

**Deployment:**

| Host | Runs | Exposure |
|---|---|---|
| **VPS-1 (public)** | API, indexer, Polymarket reference feed, Tor onion for the API | HTTPS in; holds **no secrets** |
| **VPS-2 (private)**, ideally another provider and jurisdiction | signer: its own indexer and engine replica, mint keys, spending keys | **no inbound ports** (firewall drops everything; SSH by key only, ideally over Tor); dials out to VPS-1 |
| Free static hosting (Cloudflare Pages / IPFS) | the web app | sees app loads, never orders (N7) |

Compromising the public server, or even its hosting provider, gives an attacker neither keys nor funds. Every service runs a **privacy self-check at boot** and refuses to start if access logging is on, if CORS or CSP allow a third party, or if a key is missing or weak. Next production step: FROST 2-of-3 across independent signers.

## Tech stack

| Layer | Choice |
|---|---|
| Core | Rust 1.95 (edition 2024), tokio, axum, SQLite; engine crate is pure, deterministic, compiles to WASM; backend built and run in Linux containers |
| Zcash | librustzcash: `zcash_client_backend` 0.24, `zcash_client_sqlite` 0.22, `zcash_keys` 0.16, `zcash_protocol` 0.10, `orchard` 0.15, `pczt`; dependency versions pinned to a known-good set taken from `zcash-devtool`'s lockfile |
| Chain access | local and self-hosted nodes via **ZcashFoundation/z3** (Docker Compose: Zebra + Zaino with a lightwalletd-compatible gRPC; regtest, testnet, mainnet); public `testnet.zec.rocks:443` as fallback; always untargeted |
| E-cash | `cashu` crate 0.18 from CDK (`dhke` module, NUT-12 DLEQ, NUT-13) on the signer; `@cashu/crypto` 0.3 (basic Cashu crypto) in the browser; our own multi-keyset mint |
| Reference prices | Polymarket CLOB WebSocket `wss://ws-subscriptions-clob.polymarket.com/ws/market` (no auth, PING every 10 s, optional `best_bid_ask` and `market_resolved` events) + REST fallback |
| Polygon | raw `eth_call` against two independent public RPCs, results cross-checked |
| Network privacy | `@nymproject/mix-fetch` 2.x: one tunnel per page, so top-ups and withdrawals run in a separate same-origin frame with its own tunnel; `Connection: close` on writes and no TLS session resumption at the proxy; own Nym exit if needed; Tor onion as an explicit fallback |
| Web | Vite, React 19, TypeScript, Tailwind v4, three.js / React Three Fiber, constant-URL navigation, PWA, strict CSP |
| Vault | `@scure/bip39`, WebAuthn PRF passkey unlock (Face ID on phones), Argon2id via `hash-wasm` for the passphrase (the only unlock on computers), WebCrypto AES-GCM + HKDF, X25519 sealed boxes (`@noble/curves`) |
| Addresses | `zcash_address` 0.13 (Rust → WASM) to parse unified addresses and require an Orchard-protocol receiver, never regex |
| Infra | Docker Compose, Caddy, Tor; static app hosted separately from the API |
| Video | Remotion + Playwright capture + iPhone screen recording |

## Decisions

| # | Decision | Status |
|---|---|---|
| D1 | LMSR anchored to Polymarket's live mid (30 s median) + depth-aware guard + exposure buffer on buys **and sells**, 2-second batches | decided |
| D2 | testnet is the judge playground (TAZ self-mined or from faucets); mainnet is a micro-stakes proof of the same build; if the organizers require a mainnet demo, the budget rises and vouchers move to mainnet | decided; organizers asked (Oct 3) |
| D3 | one isolated signer holding all secrets; FROST 2-of-3 as stretch | decided |
| D4 | private deposit viewing key, public reserve viewing key, discarded-OVK payouts padded with throwaway outputs | decided |
| D5 | no NEAR Intents on-ramp (Zcash support is transparent-only, a leak) | decided |
| D6 | curated 8–12 binary markets (Yes/No or named outcomes), including single markets from negRisk events; halt at event start | decided |
| D7 | top-up denominations: testnet 0.01 / 0.05 / 0.1 / 0.5 TAZ; mainnet 0.001 / 0.005 / 0.01 ZEC; bets in any amount from the balance | decided |
| D8 | 0-conf credit caps: testnet 0.1 / 0.3 TAZ; mainnet 0.005 / 0.01 ZEC | decided |
| D9 | judge vouchers on testnet; the mainnet proof shown in the video with tx evidence | decided |
| D10 | one mixnet tunnel for browsing and betting with a fresh connection per write (server closes connections, no TLS resumption); a separate tunnel in its own frame for top-ups and withdrawals, plus a random delay | decided (latency measured in Spike A) |
| D11 | "Called it" receipts (tag per trade, reveal by choice) as the signature feature | decided |
| D12 | Blind duels | stretch |
| D13 | Phones unlock with Face ID (WebAuthn PRF passkey); computers with a passphrase only; the 12-word phrase is the backup | decided (core) |
