# Threat model

> Zecathon rule: *"Leaks are disqualifying, not deductions."*
> Who could learn what, and what stops each of them. To report a leak, see [SECURITY.md](../SECURITY.md).

## The claim

**Nobody can link a bet to a person, or a payout to a bet,** including the Blindbook operator, and including anyone who fully compromises our API server. That holds by construction (shielded Zcash, blind signatures, mixnet, no targeted queries), not by policy.

**Public by design:** prices, volumes, batch inputs and results, issuance (sorted within each block, so its order says nothing about who asked), the spent set, the reserve balance, payout totals.

## Adversaries

| | Adversary | Sees |
|---|---|---|
| A1 | Chain observer | public parts of every Zcash transaction |
| A2 | **Blindbook operator**, or anyone who hacks or subpoenas the API | everything reaching the API, the deposit viewing key, the records it stores per request (P600 shows each user theirs) |
| A2+ | Compromised **signer** | additionally: all secret keys |
| A3 | Network observer | ISP, hosting provider, Wi-Fi, global passive adversary |
| A4 | Public verifier | everything we publish, including the reserve viewing key |
| A5 | Exchange or wallet provider | that its user sent some amount to some shielded address at some time |
| A6 | Infrastructure third parties | Polymarket, lightwalletd operators, RPC providers, static-site hosts |
| A7 | Device thief | the user's phone or browser storage |

## Who can learn what

| Adversary | Your identity | That you used Blindbook | Which bet is yours | Bet ↔ payout | Payout destination |
|---|---|---|---|---|---|
| A1 chain | no | no | no | no | no |
| A2 operator / hacked API | no | no | no | **no** | no (sealed to the signer) |
| A2+ hacked signer | no | no | no | **no** (blind signatures) | only for withdrawals still pending |
| A3 network | no | that this IP opened the app (the host name in DNS and TLS, N7) and runs a Nym client; nothing about what it does | no | no | no |
| A4 verifier | no | no | no | no | no |
| A5 exchange or wallet | yes, they know you | **no** (one-time address) | no | no | no |
| A6 infrastructure | no | the static host: "loaded the app" (N7); Nym's directory and gateway: a Nym client, not which site (N5) | no | no | no |
| A7 device thief | phone owner | only with your passphrase | only with your passphrase | only with your passphrase | only with your passphrase |

## Leaks and mitigations

### Layer 1: funding

| # | Leak | Seen by | Mitigation |
|---|---|---|---|
| F1 | Paying from a **transparent** address publishes sender and amount | A1 | the one-time address is unrecognizable, so the chain shows "a t-address paid an unknown shielded address"; the top-up receipt says **EXPOSED** and explains it |
| F2 | The user's own earlier Orchard → Ironwood migration published its amount (turnstile); betting that exact amount right after links them | A1 | denominations; the guide says don't bet a just-migrated amount. Orchard can't pay us directly: post-NU6.3 it can only move to the same wallet |
| F3 | Paying from **Sapling** funds crosses pools: the value balance publishes the **amount** | A1 | detected from the compact block (it lists the Sapling spends next to our output); the receipt says **AMOUNT VISIBLE**; the guide says keep funds in Ironwood (Zodl migrates automatically) |
| F4 | Paying straight from a KYC exchange lets it match "sent X at T" with our public data | A5 | unrecognizable one-time address; a credited top-up appears in the log only as "a top-up of X was credited" (issuance sorted within the block, amounts in powers of two); standard denominations; the guide says to withdraw to your own shielded wallet first |
| F5 | A published deposit viewing key would let anyone recognize deposits | A4, A5 | the deposit viewing key is never published; only the reserve's is |
| F6 | Odd amounts fingerprint a bettor | A5 | deposits only in standard denominations |

### Layer 2: positions

| # | Leak | Seen by | Mitigation |
|---|---|---|---|
| P1 | Operator links a buy to a later sell, redemption or withdrawal | A2, A2+ | **blind signatures**: the signer never sees the slip it signs |
| P2 | Key tagging or a forked log: one user gets unique keys | A2 | keysets **derived in the browser** from the master key pinned in the build; DLEQ on every signature, checked by the wallet and by both verifiers; the log root anchored on-chain about hourly |
| P3 | Restore requests link all of one user's orders | A2 | **zero-query restore** from the public issuance log |
| P4 | Unique slip amounts link split and merge operations | A2 | power-of-two denominations |
| P5 | Reusing one long-lived key across bets | A2, A4 | no long-lived keys; every slip is independent |
| P6 | Operator guesses that a top-up and bets placed seconds later belong to the same (anonymous) person | A2 | both sides are anonymous, so no identity is revealed; blind slips and a fresh connection per request leave only timing; the bet panel's **MIX DELAY** sends a bet or a sale at a random moment 5–30 s later; what remains is only that two anonymous actions were close in time |
| P7 | A request reveals a user's whole balance (spending every slip at once) | A2 | slips come in powers of two and the wallet spends only what a request needs, the rest coming back as change; **the server never stores balances at all**; at most, a large slip spent on a small bet shows its holder had that one slip |
| P8 | A "called it" proof reveals more than the one trade | anyone shown the proof | each trade's tag uses an independent secret; a proof reveals exactly one fill (market, side, size, price, height) to whoever the user chooses, and nothing about other trades, balance or payouts. Publishing a proof under your own name links your name to that one trade, which is the user's explicit choice. Proof links keep the secret after `#`, so servers and link-preview bots never see it |
| P9 | A blind duel links its two sides, or the challenger to their shares | A2, anyone with the link | the offer and the take are separate anonymous requests; the operator sees that *a* duel was taken, never by whom. The challenger's shares are blind-signed on outputs sent with the offer and collected from the feed every visitor polls (or the public deltas), so nothing asks for them; spending them later is unlinkable like any slip. Who sent the link to whom happens outside Blindbook: two friends know each other, and Blindbook learns nothing from it |

### Layer 3: payout

| # | Leak | Seen by | Mitigation |
|---|---|---|---|
| X1 | Destination visible to viewing-key holders | A4 | recipient outputs use `OvkPolicy::Discard`. Verified on testnet: a view-only wallet with the sender's full viewing key sees only its own change in a payout, no recipient and no per-output amount |
| X2 | The API stores payout addresses | A2 | addresses are **sealed to the signer** in the browser; the API stores ciphertext plus a commitment; the signer forgets them after broadcast |
| X3 | Transaction shape reveals the number of recipients | A1, A4 | fixed shape: always 8 actions; padding outputs are zero-value notes to throwaway addresses with a discarded OVK, so viewing-key holders can't tell them from real recipients (padding to our own address would be decryptable and would leak the count). Verified on testnet: 1 recipient + 6 zero-value outputs + change = exactly 8 Ironwood actions, fee 0.0004 ZEC |
| X4 | Payout to transparent or Sapling-only addresses (amount published by pool crossing) | A1 | rejected; Ironwood receivers only |
| X5 | Timing between a withdraw request and the payout | A2 | fixed batch schedule; requests arrive through the mixnet and are unlinkable to bets anyway |
| X6 | The public reserve viewing key shows each payout transaction's **total**; when only one person withdraws in a block, that total is their withdrawal amount (never the destination) | A1, A4 | withdrawals in standard denominations (a non-standard remainder stays as CREDIT or goes out in a later block), several withdrawals batched per payout whenever the queue allows, and the per-block schedule regardless of demand. so a public total says "someone withdrew 0.05 at block N" and links to nobody |
| X7 | The log's reserve reports (`reserve_reported`) publish the reserve and the not-yet-swept deposit total over time | A4 | nothing new: the reserve figure is what the public reserve viewing key shows anyway (X6), and every credited top-up is already public one by one as `topup_credited` with its standard amount; a deposit that arrives before it is credited shows in the unswept total minutes earlier, and links to nobody |

### Layer 4: network and infrastructure

| # | Leak | Seen by | Mitigation |
|---|---|---|---|
| N1 | IP ↔ order, slip or withdrawal | A2, A3 | **every API call goes through the Nym mixnet**; TLS terminates inside WASM, so the exit sees ciphertext |
| N2 | Timing: "online at T, bet at T+30s" | A2, A3 | the API never sees IPs; mixnet delay plus cover traffic; 2-second batches |
| N3 | URL path reveals which market a visitor opened | A2, A3 | in-app navigation with a **constant URL**: nothing about the page you're on ever leaves the browser |
| N4 | Per-market requests reveal interest | A2, A3 | every visitor polls the same files (head, live feed, catalog, price history), and everyone who reads the public log reads the same segments in the same way; search, sorting, chart ranges, restore, proof checks and the verifier all work on those files locally. The one per-request read, a top-up's status, runs over that top-up's own mixnet identity |
| N5 | The browser contacts Polymarket, CDNs or font hosts | A6 | none of them: no CDN, font, image or Polymarket request ever leaves the browser. The only outside contacts are the mixnet client's own bootstrap: it fetches the network topology from Nym's directory API (`https://validator.nymtech.net`) and connects to one entry gateway over WebSocket. Those two learn that an IP runs a Nym client in a browser, never which site it uses or what it sends (like Tor's directory authorities and guard). A browser labels such requests with the page's site (`Origin`), so the mixnet worker runs with an opaque origin and they carry `Origin: null` and no `Referer` (PROTOCOL §4; checked by the leak check against a deployed app, and in Chromium, Firefox and WebKit). The app page itself may connect only to its own origin; only the tunnel frames may reach the directory and `wss:`; every other byte arrives inside the mixnet |
| N6 | The mixnet is down and the app quietly goes direct | A2, A3 | **never silent**: the lamp shows DOWN and actions are blocked. When the reason is clear the app says it: a browser without WebAssembly (iPhone Lockdown Mode) never tries, and after three failed rounds of tunnels it says the network seems to block the mixnet, retrying at growing intervals (up to a minute). Either way it offers the .onion mirror for Tor Browser or Onion Browser, whose address the build can carry; it never goes direct |
| N7 | Loading the app reveals "this IP opened Blindbook" | static host; A3 (the host name in DNS and TLS) | the app is served from **hosts that aren't the API** (static hosting, .onion), so loads and orders never meet in one log; after the first visit the service worker serves the app from its cache and the browser's cache keeps the mixnet worker (`immutable`), so the browser only checks the worker file for an update now and then; the .onion mirror in Tor Browser shows neither the host nor the visit |
| N8 | The indexer's **targeted** lightwalletd queries (by txid) reveal which transactions are deposits | A6 | **untargeted only**: every compact block, requested with all pool types (they carry transparent inputs and Sapling spends, so classifying a top-up needs no single-transaction fetch), plus the full mempool stream; option: self-hosted Zebra + Zaino |
| N9 | iOS suspends the page while the user is in the wallet; the mixnet link drops | user | re-links visibly on return; never falls back to direct |
| N10 | Your **wallet** reveals your IP to its lightwalletd when broadcasting | A3, A6 | outside our app; the guide recommends wallets with Nym or Tor (Zingo!, Zkool) |
| N11 | **Session linking:** a reused TLS connection (or TLS session resumption) ties a user's top-up, bets and withdrawal together | A2 | writes never share a connection (`Connection: close`, no TLS resumption; the next regular poll opens the connection the next write uses, so the handshake isn't on the bet's critical path); top-ups and withdrawals use a **separate mixnet tunnel** in their own frame plus a random delay; reads share the main tunnel. At most, timing within one session hints that bets share a client: anonymous bets to each other, never to a person or a payout (see P6) |
| N12 | **A persisted mixnet identity** links visits at the entry gateway, or the main tunnel and the cage frame load the same identity (mix-fetch stores it in IndexedDB, which same-origin frames share) | A6 (Nym gateway), A2 | the identity lives in an in-memory IndexedDB inside each tunnel's own worker (PROTOCOL §4), so it never reaches the disk and ends with its frame; every tunnel also gets a random `clientId` and `storagePassphrase`, and identities an older build left on disk are deleted at boot. No two tunnels and no two sessions share a mixnet identity. Verified: each tunnel, including two running at once in sibling frames, gets its own identity and its own exit IP, and nothing is left in the app's IndexedDB |
| N13 | **A mixnet route dies quietly**: about a third of randomly chosen routes come up "ready" and then never answer, and mix-fetch has no request timeout | user (a bet that seems to hang) | every request carries an app-level deadline; tunnels live in disposable frames: the app races two at boot, keeps the first that answers a health check, and replaces a stuck one with a fresh frame and a fresh identity while the lamp shows RELINKING. It never falls back to a direct connection (N6) |
| N14 | The command-line verifier asks a lightwalletd for the anchor transactions by txid, and Polygon RPCs for each recorded result | A6 | those are the reserve's own public transactions and public markets, all named in the public log; the requests are about the operator, never about a user. Anyone can route them through Tor (`ALL_PROXY`) |

### Layer 5: device

| # | Leak | Seen by | Mitigation |
|---|---|---|---|
| D1 | A stolen device reveals slips | A7 | vault encrypted with AES-GCM; opening it needs **Face ID** on a phone (passkey PRF) or the passphrase on a computer; it locks itself after 15 idle minutes, and ESC ESC locks it at once |
| D1b | The passkey itself reveals usage: a "Blindbook" entry sits in the user's keychain | A7 | the entry holds no balances or history and syncs only end-to-end encrypted; users who want no trace choose the passphrase instead; losing the passkey loses nothing (the 12-word phrase restores everything) |
| D2 | iOS Safari wipes storage after 7 days without use, and bearer slips are lost | user funds | the 12 words are confirmed by stamping when the vault is made (required before a mainnet top-up, optional on testnet) and can be shown again from an open vault; zero-query restore; an INSTALL IT FIRST card on iPhone, since the installed app keeps its own storage |
| D3 | A malicious frontend steals the vault | A2 | strict CSP; SRI on the entry scripts and styles; `SHA256SUMS` of every built file, and two builds of one commit give the same hashes, so anyone can compare what a host serves with the source; static hosts that aren't the API |
| D4 | Sharing a slip QR code in a chat app | that app | a slip is as private as the channel it's sent over; the UI says so before export |
| D5 | Browser history, tab titles and screen sharing reveal which markets you looked at | A7, anyone watching your screen | constant URL (navigation never touches history); the tab title is always `Blindbook`; proof links are replaced in the address bar as soon as they're opened |
| D6 | A paper slip is photographed, or a network printer keeps a copy | A7, print infrastructure | paper slips are bearer cash: the print view says "whoever scans this owns it" and recommends a printer on your own network; importing swaps the slip at once, so the paper is void; until someone scans it, the issuer can take it back |
| D7 | Two shared NOBODY PASS images link the same person | public | the pixel face is random per save, not derived from the vault; stamps are generic; no amounts, markets or dates on the card |
| D8 | Back-room apps or settings leak activity | A2, A3, A6, A7 | all apps run locally with no network requests (Block Radio reads only the live feed already downloaded); **everything personal** (slips, proofs, notes, stamps, scores, P600 records, duels, handed-over codes) lives in the encrypted vault; only preferences (CLEAN SIGNAL, theme, MIX DELAY, sound, the Bookie) are in plain storage; the Bookie and the sounds react only to the kind of event (`app/cues.ts` carries no amount or market) and make no requests |

### Integrity, custody, availability

| # | Threat | Mitigation |
|---|---|---|
| I1 | Operator misprices or invents fills | deterministic replay of every batch, including each anchor from its recorded samples (`blindbook-verify`, and the same engine as WebAssembly in the browser) |
| I2 | Forged slips (mint key leak) | API holds no keys; the signer's supply guard halts withdrawals when redemptions exceed issuance |
| I3 | Pool drained | spending keys only on the signer, which replays before signing; reserve reports in the log checked against the liabilities, and on-chain with the public reserve key; FROST 2-of-3 after the hackathon |
| I4 | History rewritten | hash-chained log; each new root anchored on-chain about hourly; the command-line verifier opens every anchor and checks it names the log's root |
| I5 | Replay differs across platforms (floating point) | `libm` crate, fixed rounding rules, CI test that native and WASM give byte-identical results |
| I6 | Stale-price arbitrage drains the house | price **anchored to Polymarket's live mid** (30 s median, never stale); depth-aware guard against Polymarket's bid/ask; halts at 0.98, at the end date and when the reference feed is unhealthy for 10 s; worst-case loss capped by the per-market buffer `L_m` |
| I6b | Reference manipulation: spoofing a thin Polymarket book to move our anchor | lower median over 30 s (a fake mid held for under 15 s can't move it), depth-aware quotes for a fixed share count (500 by default; a fake low ask only loosens the guard, the curve still sets the price), listing requires a deep book, `L_m` caps any damage |
| I6c | Live-event latency: someone watching a match reacts faster than Polymarket's price | **trading halts at event start** (`gameStartTime`, or a scheduled time set at listing) |
| I6d | **Sells drain the buffer:** selling removes cash while the other side's shares stay outstanding (found in external review) | the exposure invariant `max(u_A, u_B) − c ≤ L` is enforced on **sells as well as buys**; excess sells are partially filled and unsold shares come back as slips ([PROTOCOL §5.5](PROTOCOL.md)) |
| I6e | The API (or whoever compromises it) settles a market its own way, then cashes in the positions it holds | the signer accepts a resolution only if it matches the result it read from Polygon itself, on two RPCs that must agree; the log records the Polygon block and transaction; `blindbook-verify --polygon` reads every result again |
| I6f | The API lists a market with a wider buffer or other parameters, to lose more to its own trades | the signer refuses any listing whose parameters aren't the network's; the parameters are in the log for the verifiers |
| I7 | Censorship or delay | everything is in the public log; the user can disclose their own payment |
| I8 | Spam without IPs to rate-limit | proof-of-work on every write; a replayed proof gains nothing (writes spend slips or a code, top-ups are idempotent by claim hash); at most 500 open top-up requests and 500 trades per batch, at most 12 fee-free writes (swaps, duel offers and cancels) per block and 50 open duels, then `busy`; every trade and duel stake is at least max trade / 200, so each write that grows the public log pays a fee; the live feed every visitor polls keeps only the newest fills, payouts and duel signatures; unpaid top-up addresses expire and drop their outputs. The most a flood can touch is availability: it never learns or takes anything |
| I9 | 0-conf top-up double-spent, or a reorg removes it, after credit was issued | caps per top-up / unconfirmed in total: testnet 0.1 / 0.3 TAZ, mainnet 0.005 / 0.01 ZEC; Zcash nodes reject conflicting nullifiers and there's no replace-by-fee; any loss is absorbed by the house from fees, never by users |
| I10 | Future quantum adversary | Ironwood only (quantum-recoverable notes, ZIP 2005); never send to Orchard receivers (ZIP 326) |
| I11 | A lost answer leaves a wallet holding slips the server already spent, or loses the new ones | the wallet records each request before it leaves and settles one without an answer from the public log by its own blinded outputs, the same zero-query way as a restore |
| I12 | **A compromised API redirects requests passing through it**: it swaps a request's blinded outputs for its own (taking the value of the slips being spent), or shows a deposit address of its own for a new top-up (taking that payment) | it learns nothing about anyone, can't reach the reserve or any slip that isn't being spent, and can't forge a signature, so a swap of outputs is public: the log shows the slips spent with none of the requested outputs signed (an honest signer signs them in the same batch). The wallet says so when it settles a request that got no answer, and a slip it was told is unspent is refused as spent when next used. Only the requests passing through while it is compromised are exposed, each capped at a standard amount |

## Trust boundaries

What the design relies on, and how each part is checked:

1. **The crowd.** Standard amounts, sealed 2-second batches and blind slips keep every bet among the others; nothing a bet shows points to a person, and later actions stay unlinkable.
2. **Your device.** The vault is encrypted, the 12 words never leave it, and the app warns before a step that would expose you (a top-up from transparent funds is marked EXPOSED).
3. **Custody you can check.** Zcash has no smart contracts, so an isolated signer with no inbound ports holds the reserve. Its viewing key is public: `blindbook-verify --chain` and P400 show at any time that the reserve covers every slip, and nothing the signer holds can tie a payout or a bet to anyone.
4. **The mixnet.** Every request travels through Nym; when it can't, the app stops instead of going direct. Nym's directory and entry gateway see that a browser runs a Nym client (N5), never that it is Blindbook (`Origin: null`) or what it does.
5. **The web host.** It sees an address load a static app, never what happens in it; the .onion mirror removes even that.
6. **Polymarket's result.** A market settles on Polymarket's final result on Polygon, which the signer reads itself and anyone can re-read with `blindbook-verify --polygon`.
