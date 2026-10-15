# Architecture

> **Privacy by construction. Custody is verifiable.**
> Nobody can link a bet to a person, or a payout to a bet: not chain observers, not network observers, not exchanges, and **not us**. That rests on construction (shielded payments, blind signatures, a mixnet), not on a promise; what remains is in the residual risks of [THREAT_MODEL.md](THREAT_MODEL.md). What you do trust us with (holding funds) anyone can check at any time.

Companion docs: [PROTOCOL.md](PROTOCOL.md) (wire formats, algorithms), [MARKETS.md](MARKETS.md) (Polymarket data and settlement), [THREAT_MODEL.md](THREAT_MODEL.md).

## Principles

1. **No identity anywhere.** No accounts, no wallet-connect, no cookies, no analytics, no third-party requests (the one exception is the mixnet client's own bootstrap: Nym's directory and an entry gateway see that an IP uses Nym, nothing more; THREAT_MODEL N5).
2. **Five independent privacy layers.** Each closes one question on its own.
3. **Never degrade silently.** If a privacy layer is down, the UI says so and stops.
4. **Publish everything except people.** Prices, volumes, issuance, reserves and payout totals are public. Addresses, transactions and identities are not.
5. **Internet-facing code holds no secrets.** A fully compromised API leaks no identities and can't move the reserve's money; the most it can do is redirect requests that pass through it while it is compromised, which the public log shows ([THREAT_MODEL](THREAT_MODEL.md) I12).
6. **No targeted queries, anywhere.** Download everything, filter locally.
7. **Anonymous by default, provable by choice.** The user, and only the user, decides what to reveal.
8. **Clarity over cleverness.** The retro look never hides what a button does or what a price means.
9. **Working beats ambitious.** Every part is built bottom-up and tested before the next ([ROADMAP.md](ROADMAP.md)).

## More than a private Polymarket

Polymarket is our **oracle and price reference**. Blindbook adds what a public order book can't have:

| | What it is | Why it matters |
|---|---|---|
| **The booth** | bet with shielded ZEC; nobody, including us, can link a bet to a person or a payout to a bet | trade on what you know without becoming a public dossier |
| **Slips you can pass under the table** | positions are bearer e-cash; hand one to anyone as a QR code or link, with no chain transaction and no record of who held it | private OTC transfer of a position, which no on-chain market can offer |
| **"Called it" receipts** | every trade carries a secret tag in the anchored public log; reveal the secret to prove "I bought YES at 18¢ at block N", to whoever you choose, whenever you choose | reputation without identity: prove you were right without exposing anything else. This is Zcash's selective disclosure, applied to forecasting |
| **Verify in your browser** | the browser replays every batch through the engine (as WebAssembly), checks every signature, the supply and the solvency report; the command-line verifier also checks the reserve and the anchors on-chain | don't trust us; check us |
| **What we know about you** | page P600 shows the exact record our server stored for each of your requests (every write response returns it; the app keeps them in your vault) next to the fields it doesn't have (IP, account, balance, other bets) | privacy you can see, not just read about |
| **Paper slips** | print a position as a receipt-width slip with a real QR; scanning it swaps the slip into the scanner's vault, so the paper is void | a bearer bet you can hold in your hand, gift or hide |
| *Blind duels* | challenge anyone with a link; the other side takes it anonymously; it's matched as a complete set and settled by Polymarket's result (PROTOCOL 7.1) | peer-to-peer and zero house risk; spreads by link |

## The five layers

| Layer | Question | Mechanism |
|---|---|---|
| **1. Funding** | Who paid? | Ironwood shielded **top-up** to a **one-time diversified address** that is never published. Standard denominations. |
| **2. Positions** | Who holds what? | **Chaumian e-cash.** Balance and positions are blind-signed bearer tokens (*slips*), built on Cashu's BDHKE + DLEQ primitives. The mint signs without seeing, so no action links to any other. |
| **3. Payout** | Where did the money go? | Shielded payout to a fresh address, fixed transaction shape, **discarded outgoing viewing key**, destination sealed to the signer and forgotten. |
| **4. Network** | Who is online, and from where? | Static app from hosts that aren't ours. **Every API call goes through the Nym mixnet**: one tunnel for browsing and betting, a **separate mixnet identity** for top-ups and withdrawals, and a fresh connection for every write. Each tunnel lives in a disposable frame, so a dead route is replaced, never bypassed. Everyone downloads the same public files. |
| **5. Device** | What's on your phone? | the vault opens with **Face ID on phones** (a passkey via WebAuthn PRF) and with a **passphrase on computers**; a 12-word phrase is the real backup (required before real money; deferred for the testnet playground); deterministic secrets; **zero-query restore**. **Everything personal** (slips, proofs, notes, stamps, scores, P600 records, duels, handed-over codes) lives in the vault; only preferences (CLEAN SIGNAL, theme, MIX DELAY) sit in plain storage. |

## Components

```
┌──────── Browser · static app served from hosts that aren't the API (PWA, cached) ──────────┐
│ vault (BIP 39 · Argon2id · passkey PRF · AES-GCM) · slip wallet (blind / unblind / DLEQ)   │
│ keyset derivation from the pinned mint master key · verifier (engine as WebAssembly)       │
│ ZIP 321 link (phone) or QR (desktop) · privacy preflight · proof-of-work in workers        │
│ CALLED IT proofs · duels · paper slips · console · back room                               │
└──────────────────────────────────────────▲─────────────────────────────────────────────────┘
                                           │ Nym mixnet (mixFetch), TLS inside WASM, fresh connection per write
┌──────────────────────────────────────────┴─────────────────────────────────────────────────┐
│ blindbook-api   SECRETLESS · top-up desk · 2-second batches · public log · listing rules   │
│ blindbook-indexer  untargeted chain sync, mempool watch, one-time address bookkeeping      │
│ blindbook-engine   pure + deterministic: anchored LMSR, batch clearing, issuance, roots    │
│ reference feed     Polymarket CLOB WebSocket (live book) · Gamma (catalog) · Polygon CTF   │
└──────────────────────────────────────────▲─────────────────────────────────────────────────┘
                                           │ persistent OUTBOUND stream opened by the signer
┌──────────────────────────────────────────┴─────────────────────────────────────────────────┐
│ blindbook-signer  ALL secrets: mint keys · deposit + reserve spending keys                 │
│   own indexer · own engine replica · own Polygon reads → signs only what it can justify    │
│   supply guard · blind-signs batches in ms · sweeps · payouts · anchors · reserve reports  │
│   after the hackathon: FROST 2-of-3 (ZIP 312)                                              │
└────────────────────────────────────────────────────────────────────────────────────────────┘
  blindbook-verify (CLI; the browser runs the same replay as WebAssembly): public log +
  reserve viewing key + Polygon → replay, signatures, supply, solvency, anchors, results
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
4. Our indexer and the signer's independent indexer both see the payment **in the mempool** within seconds (about 1 s after the wallet broadcasts, measured on testnet).
   - Small top-ups are credited at once (0-conf), within house-insured caps.
   - Bigger ones are credited after 1 confirmation (about 25–75 s on testnet, where a block comes every 25 s since NU7; ~1–2.5 min on mainnet until NU7 activates there).
5. The signer blind-signs the CREDIT outputs, and the browser unblinds them. You now hold a **private balance**: bearer CREDIT slips that only your device knows about.

## Where your balance lives (and why it isn't an account)

**There is no balance on our server.** No table has a row for you, because there is no "you" to attach it to.

- **Your balance is a set of e-cash tokens (CREDIT slips).** Each slip is a random 32-byte secret plus the mint's blind signature on it. Slips come in power-of-two amounts, like banknotes.
- **They exist only on your device**, in IndexedDB, encrypted (AES-GCM) under a key that Face ID (a passkey) or your passphrase (Argon2id) unlocks. The 12-word phrase can regenerate every secret.
- **The server knows only totals:** the amount issued per keyset and the list of spent slips (`Y = hash_to_curve(secret)`).
  - It can't see anyone's balance or tell which slips belong together.
  - It can't freeze one person's funds, because it can't tell whose slips are whose.
- **Spending (a bet, a sell, a withdrawal):** you hand over some slips and receive freshly blinded new ones (the position plus change). The mint sees "valid slips worth X were spent and new ones were issued". Blinding makes the new slips unlinkable to the old ones, even for the mint.
- **Amount privacy:** the wallet keeps slips in standard denominations and spends only what a request needs (with change), so a request never reveals your whole balance.
- **Lost phone or cleared browser:** type the 12 words on any device. The browser downloads the public log (the same files every verifier reads), derives your blinded messages, finds their signatures and unblinds them. **It never asks the server "what's mine?"**

Polymarket keeps your balance under a public wallet address; a typical custodial app keeps it under an account ID. Both link everything you do. Here the most the server could ever hand over is aggregate totals. This is Chaum's e-cash (1982), the idea behind Cashu and Fedimint, applied to a market.

### Unlock: Face ID on phones, passphrase on computers

- **Phones (default):** Face ID. **Computers:** a passphrase by default; a passkey (Touch ID, Windows Hello, a security key) is offered where the browser supports PRF.

- **Creating the vault on a phone** also creates a passkey for the Blindbook domain: user name `Blindbook vault`, random user handle, no email or identity.
- **Opening the vault on a phone** asks for Face ID. The WebAuthn **PRF** extension returns a 32-byte secret only after that check. HKDF turns it into the key that unwraps the vault key, and AES-GCM decrypts the vault.
- **The passkey never reaches us:** it syncs only through the user's own end-to-end-encrypted keychain (iCloud Keychain, Google Password Manager). Our server isn't involved at all; the app runs WebAuthn entirely in the browser, with no challenge from any server.
- **Fallbacks:**
  - a passphrase (Argon2id): the default on computers, and the fallback wherever PRF isn't available;
  - the 12-word phrase if the passkey is lost.
- **Domain-bound:** a passkey works only on the domain it was created for, so it's set up on the final domain (testnet playground and mainnet proof each get their own).

### On phones: an installable web app, no app stores

There is no App Store or Google Play app. The same static app runs in the phone's browser and can be added to the home screen as an app icon.

- **Install:** iPhone: Safari → Share → *Add to Home Screen* (iOS shows no install prompt, so the app offers a pager-style instruction card); Android: Chrome's install prompt. Everything also works in the browser without installing.
- **Installed,** it opens full-screen with its own icon and a splash screen, and the service worker serves the app from its cache (the mixnet worker comes from the browser's cache), so later starts send almost no request for the app itself (N7).
- **iPhone details we design for:**
  - a home-screen app has **its own storage, separate from Safari**: a vault created in Safari doesn't appear in the installed app. The app suggests installing before the first top-up; otherwise the 12 words restore everything (zero-query restore);
  - Safari can delete a site's data after 7 days without a visit, but WebKit counts days of use separately for each home-screen app, so an installed app you use keeps its data. Installing is the recommended protection for bearer slips (D2 in the threat model);
  - the `zcash:` deep link to Zodl and Face ID (passkey PRF) must work from the installed app as well as from Safari; both are tested on a real iPhone at Gate 2.

## Flow 2: bet (instant, off-chain)

1. **Pick and set the bet.** Choose a market and an outcome (outcomes carry Polymarket's labels: `Yes / No`, or team names such as `NAVI / FAZE`) and a standard size (testnet 0.01 / 0.02 / 0.05 TAZ: standard sizes keep you in the crowd). The max price is set 3¢ above the current price, or taken from ODDS CALC. An optional MIX DELAY waits a random 5–30 s before sending.
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

  Total time: about 1–2 minutes on testnet (the next payout block, then its confirmation in your wallet).
- **Unsafe addresses are rejected:** transparent and Sapling-only addresses (pool crossing would publish the amount).

## "Called it": anonymous by default, provable by choice

1. With every trade the browser attaches `tag = SHA256("bb-called-it" ‖ s)`, where `s` is a per-trade secret derived from the vault seed.
2. The batch result publishes `tag`, the market, the outcome, the size, the average price and the block height. It's part of the public log, whose root is anchored on-chain every 144 blocks (about an hour at 25-second blocks) whenever it has changed.
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
- **Robust anchor:** the anchor is the **lower median of the mid over the last 30 s**, and the guard uses **depth-aware** bid/ask (the average price to buy or sell a fixed number of shares recorded at listing, 500 by default, not just the top of the book), so a spoofed or thin Polymarket book can't swing our price.
- **Guard:** a buy is never cheaper than Polymarket's ask, and a sell never pays more than its bid.
- **Exposure buffer, for buys and sells:** after every batch the house's worst-case loss in a market must stay within its buffer `L_m`, which the reserve covers. Trades that would break this, in either direction, are partially filled and the rest is returned. This invariant keeps the public solvency check green at all times.
- **Batches:** all requests in a 2-second window clear together. Opposing flow is matched as complete sets (A + B = 1 ZEC), only the imbalance moves the curve, and everyone on a side gets the same price. Ordering inside the window doesn't matter, and nobody sees an order before it clears.
- **Halts:** trading stops when:
  - Polymarket stops accepting orders or closes the market;
  - **the event starts** (`gameStartTime` for sports; a scheduled time set at listing for announcements);
  - Polymarket's ask for either outcome reaches 0.98;
  - the end date passes;
  - the reference is unusable (no valid bid, ask or mid), or the feed is unhealthy for more than 10 s (connection down or silent, no snapshot, or a local book that disagrees with Polymarket's own best prices).
- **Determinism:** pure-Rust `libm`, fixed rounding; the verifier is the same code (also WASM).

**Why not start at 50/50?** If Polymarket says 90% and we show 50%, the first trader buys a share worth ~0.90 for ~0.50 and takes ~0.40 ZEC per share from the house. Starting from (and staying tied to) Polymarket's price is both correct and safe.

Math, examples and parameters: [PROTOCOL.md §5](PROTOCOL.md).

## Settlement

From Polymarket we take three things:

1. **the catalog**, including the full rules text (Gamma API);
2. **a live reference price** (CLOB WebSocket);
3. **the result**, read directly from Polymarket's ConditionalTokens contract on Polygon, by the API and, independently, by the signer, which refuses any other result.

**Gamma's `outcomePrices` are never used for settlement:** they show 1/0 while the UMA result is still only *proposed*. On-chain reads are verified for binary markets and for single markets inside negRisk events. A 50-50 result (common in sports rules: canceled match, walkover) pays 0.5 per share. Details: [MARKETS.md](MARKETS.md).

## Verifiability without exposure

| Public | What it proves |
|---|---|
| Mint master public key (pinned); keysets derived in the browser; DLEQ proof on every signature | same keys for everyone; no tagging |
| Issuance log: every blind signature (`B_`, `C_`, DLEQ), sorted by `B_` within each block, so the order says nothing about which request it answered | what exists; enables zero-query restore |
| Spent set | what was redeemed; outstanding = issued − spent |
| Batch inputs (with "called it" tags), Polymarket reference snapshots, clearing results | replay reproduces every price and every issuance |
| Reserve viewing key | reserve balance, sweeps in, payout totals out |
| **On-chain anchor** of the log root (a memo in a reserve transaction, about hourly) | history can't be rewritten or forked per user |
| Reserve reports in the log | the reserve the signer says it holds, checkable with the public viewing key |
| Results with their Polygon block and transaction | anyone can read each result again from Polymarket's contract |

**Checks** (browser: P400 · VERIFY; command line: `blindbook-verify`):
1. The deltas form one hash chain up to the published head.
2. Every listed market's keysets are the ones derived from the pinned `M`.
3. Every batch replays through the engine to the same fills and pools; each anchor is the lower median of its recorded samples; each market's pool carries over; after every batch `max(u_A, u_B) − c ≤ L`.
4. Every blind signature's DLEQ proof verifies under the key derived from `M` for its keyset and amount.
5. Per keyset, nothing was spent beyond what was issued.
6. At every reserve report: `reserve + unswept top-ups ≥ CREDIT outstanding + Σ_markets max(A, B outstanding) + queued withdrawals + open duel stakes`.
7. Command line with `--chain` only: the reserve balance itself, from a view-only wallet of the public reserve key, against the liabilities; and every anchor transaction, opened with that key, names the log's root at its height.
8. Command line with `--polygon` only: every result in the log matches Polymarket's contract on Polygon.

**Never public:** deposit addresses, deposit txids, the deposit viewing key, payout destinations.

## Timing budget

| Action | Typical |
|---|---|
| App start: mixnet link | 6–14 s typical (6–9 s measured on Oct 9 in Chromium, Firefox and WebKit), hidden in the boot animation; up to ~35 s when the first routes are dead and get replaced (two tunnels race at boot) |
| **Top up within the 0-conf cap** (wallet send → balance) | **~15–40 s**, almost all of it the wallet building and proving its transaction; SEEN arrives ~1 s after its broadcast |
| Top up above the cap | ~25–75 s on testnet (1 confirmation, 25-second blocks) |
| **Bet / sell / buy more** | **~2–3 s** with the connection the last poll opened (≈ 0.9 s request + ≤ 2 s batch window + signing in ms); **4–6 s** when a write has to open a fresh TCP+TLS connection inside the tunnel (≈ +2 s) |
| Swap / transfer a slip | ~1–3 s |
| Redeem after resolution | ~2–5 s |
| Withdraw → in your wallet | ~1–2 min on testnet (the next payout block and its confirmation), plus a separate mixnet tunnel (6–14 s) and a 0–60 s privacy delay |

For comparison, a Polymarket trade takes ~1–2 s. We pay a few seconds for privacy Polymarket doesn't offer at all. The numbers above come from the Gate 1 spikes (`spikes/`); the bet path is re-measured against our own API before the UI promises it.

### Speed under load (many markets, many trades)

- **One feed, whatever the number of users.** The API keeps Polymarket's market WebSocket for every listed token, split over several connections (one connection with ~400 tokens carries ~1,500 messages and ~1 MB per second and gets dropped as a slow consumer), maintains a local book per token and recomputes our prices once per 2-second batch. Every client polls the same `GET /v1/live` (~3 s), rebuilt once a second for everyone: about 260 bytes per market, so ~3 KB for the 8–12 curated markets. Clients never ask per market, so privacy and speed point the same way. Polymarket's raw feed never reaches a client.
- **Reference health, not quietness.** A market halts when the feed is unhealthy (connection down or silent for 6 s, no snapshot, or a local book that disagrees with Polymarket's own best prices) for 10 s, not when its price simply hasn't moved: many markets go minutes without a change. A dropped connection is redone at once, so a single drop doesn't halt anything.
- **A long log.** A block is published when anything happened in it and otherwise only every 4th block; besides one file per published block, the log comes in segments of 384, so a quiet month (~104,000 chain blocks at NU7's 25 s) is about 26,000 deltas, about 70 requests and 1.4 MB for a verifier or a restore, read four at a time. The chart's price history is one shared file of a few KB per market.
- **Many trades.** A 2-second batch clears all orders at once. The LMSR math touches only the markets in the batch; a blind signature with its DLEQ proof costs about 0.3 ms on one core, so 1,000 bets sign in about a second, spread across cores. The 16-bit PoW takes the client ~0.1 s with a WASM SHA-256.
- **Client rendering.** One small store; every window subscribes only to the values it shows; windows stay mounted while hidden, so switching is instant and a top-up or a game keeps its state. Digits are tabular, so numbers never shift the layout. Proof-of-work runs in Web Workers.
- **Cheap effects.** Scanlines, noise and glow are CSS layers that CLEAN SIGNAL removes; animations touch only `transform`, `opacity` and filters; the app turns CLEAN SIGNAL on by itself when the screen drops frames, and `prefers-reduced-motion` starts with it on.
- **Budgets, measured.** App shell 279 KB gzip (budget 300 KB, checked in CI); the 3D booth is a lazy 140 KB chunk; the engine's WebAssembly (123 KB) loads only when the verifier runs; the mixnet module is one 3.8 MB gzip file, loaded with the boot animation and kept by the browser's cache (served `immutable`; the service worker can't serve a worker started from a `data:` URL). Through the mixnet bulk data moves at ~30 KB/s, so everything every visitor downloads stays small.

### What 0-conf credit costs us and why it's safe

- A Zcash node rejects a second transaction that spends the same note, and Zcash has no replace-by-fee. Double-spending an unconfirmed top-up therefore takes a miner's collusion.
- We cap it (testnet ≤ 0.1 / 0.3 TAZ; mainnet ≤ 0.005 / 0.01 ZEC, per top-up / total unconfirmed). Above the cap, credit waits for one confirmation.
- The worst case (a successful double-spend) is a loss the house covers from fees. Users are never affected.

## Networks and deployment

| Network | Purpose | Coins |
|---|---|---|
| **Development server** (`cargo run -p blindbook-api --features embedded-signer --example devserver`) | development and CI: the real API and signer in one process, synthetic markets, a simulated chain | none needed |
| **Regtest** (local Zebra + Zaino via ZcashFoundation/z3) | the fallback judge playground (accepted by the organizers if hosted and reproducible from the repository) | unlimited, mined locally |
| **Testnet** (NU7 active since Oct 5 2026, height 4,465,026) | the public **judge playground**: real Polymarket markets and prices, test money | TAZ from faucets; judges get voucher codes |
| **Mainnet** | the **proof**: the same build with micro stakes, recorded in the video | ≤ 0.02 ZEC |

Polymarket data and Polygon settlement are always the real mainnet ones; only the Zcash network differs.

**Deployment:**

| Host | Runs | Exposure |
|---|---|---|
| **VPS-1 (public)** | API, indexer, Polymarket reference feed, Tor onion for the API | HTTPS in; holds **no secrets** |
| **VPS-2 (private)**, ideally another provider and jurisdiction | signer: its own indexer and engine replica, mint keys, spending keys | **no inbound ports** (firewall drops everything; SSH by key only, ideally over Tor); dials out to VPS-1 |
| Static hosting, separate from the API (and the same files on the .onion) | the web app | sees app loads, never orders (N7) |

The configuration for all of it is in [`deploy/`](../deploy/README.md): one image for the three binaries, a Compose file per server, the Caddy and Tor configuration, and the two app builds (mixnet and .onion), each pinning the deployment's own keys.

Compromising the public server, or even its hosting provider, gives an attacker no key, no way to identify anyone and no way into the reserve; what it could do to requests passing through it meanwhile is THREAT_MODEL I12. **The API can't log requests:** whatever the log configuration says, its filter switches the HTTP stack's logging off, the handlers never see a client address, and a test fails if the code ever reads one, reads a proxy header or adds request tracing. The reverse proxy runs without an access log. Next production step: FROST 2-of-3 across independent signers.

## Tech stack

| Layer | Choice |
|---|---|
| Core | Rust 1.95 (edition 2024), tokio, axum; state = replay of append-only journals (no database server); engine and ledger crates are pure and deterministic, the engine compiles to WASM; backend built and run in Linux containers |
| Zcash | librustzcash **NU7 pre-release set**, pinned exactly: `zcash_client_backend` 0.25.0-pre.0, `zcash_client_sqlite` 0.23.0-pre.0, `zcash_keys` 0.17.0-pre.0, `zcash_primitives` 0.31.0-pre.0, `zcash_protocol` 0.11.0-pre.0, `zcash_address` 0.14.0-pre.0, `orchard` 0.16.0, `pczt` 0.10.0-pre.0. Testnet activated NU7 on Oct 5 and the 0.24 line can no longer build valid testnet transactions; the same crates serve mainnet (no NU7 there yet). Move to the final releases when they ship |
| Chain access | local and self-hosted nodes via **ZcashFoundation/z3** (Docker Compose: Zebra + Zaino with a lightwalletd-compatible gRPC; regtest, testnet, mainnet); public `testnet.zec.rocks:443` as fallback; always untargeted |
| E-cash | `cashu` crate 0.18 from CDK (`dhke` module, NUT-12 DLEQ, NUT-13) on the signer; `@cashu/cashu-ts` 4.11 and `@noble/curves` in the browser (byte-identical, `spikes/d-blind`); NUT-02 v01 keyset ids; our own multi-keyset mint |
| Reference prices | Polymarket CLOB WebSocket `wss://ws-subscriptions-clob.polymarket.com/ws/market` (no auth, PING every 3 s, optional `best_bid_ask` and `market_resolved` events); no REST fallback: if the feed is down, trading halts; client in `crates/blindbook-polymarket` (tokio-tungstenite over rustls with ring) |
| Polygon | raw `eth_call` against two independent public RPCs, results cross-checked; the API, the signer and the verifier each read for themselves |
| Network privacy | `@nymproject/mix-fetch` 2.1: one tunnel per JavaScript realm, so every tunnel runs in its own disposable same-origin frame (main and cage), reached over a `MessageChannel`; its worker runs with an opaque origin (`Origin: null` to Nym's directory and gateway) and keeps its identity in memory; two race at boot, one link attempt at a time; app-level request deadlines; `Connection: close` on writes and no TLS session resumption at the proxy; CSP per page (the app connects only to its own origin, the tunnel frames only to `wss:` and `https://validator.nymtech.net`); own Nym exit (IPR) if public exits stay unreliable; Tor onion as an explicit fallback |
| Web | Vite 8, React 19, TypeScript, the design system's own CSS tokens and components (no Tailwind), three.js for the 3D booth (procedural, a lazy chunk; the 2D booth without WebGL), constant-URL navigation, an installable PWA (a service worker generated at build), strict CSP and SRI injected at build, `SHA256SUMS` of every built file (two builds of one commit match), a headless-browser leak check in CI |
| Vault | `@scure/bip39`, WebAuthn PRF passkey unlock (Face ID on phones; optional on computers), Argon2id via `hash-wasm` for the passphrase (m = 64 MiB, t = 3, p = 1: ~0.13 s on a desktop; the default on computers), WebCrypto AES-GCM + HKDF, X25519 sealed boxes (`@noble/curves`) |
| Addresses | the browser only checks the shape of a withdrawal address as a hint; the signer parses it with `zcash_address` and refuses anything without an Orchard-protocol receiver before any CREDIT is spent |
| Infra | Docker Compose, Caddy (JSON config: no access log, TLS session tickets off, `Connection: close` on every POST, forwarding headers stripped), Tor onion service; static app hosted separately from the API; step by step in [deploy/README.md](../deploy/README.md) |
| Video | planned: scripted headless-browser capture of the real app, iPhone screen recording, edited in code |

## Decisions

| # | Decision | Status |
|---|---|---|
| D1 | LMSR anchored to Polymarket's live mid (30 s median) + depth-aware guard + exposure buffer on buys **and sells**, 2-second batches | decided |
| D2 | testnet is the judge playground (TAZ from faucets); mainnet is a micro-stakes proof of the same build, shown in the video as a bonus; a hosted Regtest chain, reproducible from the repo's Docker Compose, is the fallback | decided; confirmed by the organizers (Oct 4): testnet preferred, Regtest acceptable on those conditions, mainnet welcome but not required |
| D3 | one isolated signer holding all secrets; FROST 2-of-3 after the hackathon | decided |
| D4 | private deposit viewing key, public reserve viewing key, discarded-OVK payouts padded with throwaway outputs | decided |
| D5 | no NEAR Intents on-ramp (Zcash support is transparent-only, a leak) | decided |
| D6 | curated 8–12 binary markets (Yes/No or named outcomes), including single markets from negRisk events; halt at event start | decided |
| D7 | top-up denominations: testnet 0.01 / 0.05 / 0.1 / 0.5 TAZ; mainnet 0.001 / 0.005 / 0.01 ZEC; bets in standard sizes (testnet 0.01 / 0.02 / 0.05 TAZ; the protocol accepts any amount, the app offers the standard ones so a size doesn't single anyone out) | decided |
| D8 | 0-conf credit caps: testnet 0.1 / 0.3 TAZ; mainnet 0.005 / 0.01 ZEC | decided |
| D9 | judge vouchers on testnet; the mainnet proof shown in the video with tx evidence | decided |
| D10 | one mixnet tunnel for browsing and betting with a fresh connection per write (server closes connections, no TLS resumption); a separate tunnel in its own frame for top-ups and withdrawals, plus a random delay | decided; Spike A (Oct 6): frames hold independent tunnels and identities; a fresh connection costs ~2 s, so the poll pre-opens the next write's connection |
| D11 | "Called it" receipts (tag per trade, reveal by choice) as the signature feature | decided |
| D12 | Blind duels | built (Oct 7): escrowed stake, complete set on take, cancel by secret |
| D13 | Phones unlock with Face ID (WebAuthn PRF passkey); computers with a passphrase, or a passkey where PRF works; the 12-word phrase is the backup | built |
| D14 | Zcash crates: the NU7 pre-release set, pinned exactly (testnet activated NU7 on Oct 5) | decided (Oct 6, `spikes/c-deposits`) |
| D15 | Every mixnet tunnel lives in a disposable frame; two race at boot; dead routes are replaced, never bypassed | decided (Oct 6, `spikes/a-mixnet`) |
| D16 | The signer builds, proves and signs payouts itself (no PCZT round trip); deposit addresses shown as ZIP 316 Revision 0 | decided (Oct 6, `spikes/g-payout`) |
