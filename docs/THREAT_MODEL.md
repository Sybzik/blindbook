# Threat model

> Zecathon rule: *"Leaks are disqualifying, not deductions."*
> Every leak we know of, who could see it and what closes it. A leak that isn't listed is a bug. See [SECURITY.md](../SECURITY.md) to report one.

## The claim

**Nobody can link a bet to a person, or a payout to a bet,** including the Blindbook operator, and including anyone who fully compromises our API server. That holds by construction (shielded Zcash, blind signatures, mixnet, no targeted queries), not by policy.

**Public by design:** prices, volumes, batch inputs and results, issuance (shuffled), the spent set, the reserve balance, payout totals.

## Adversaries

| | Adversary | Sees |
|---|---|---|
| A1 | Chain observer | public parts of every Zcash transaction |
| A2 | **Blindbook operator**, or anyone who hacks or subpoenas the API | everything reaching the API, the deposit viewing key, the request log |
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
| A3 network | no | static host only: "loaded the app" (see N7) | no | no | no |
| A4 verifier | no | no | no | no | no |
| A5 exchange or wallet | yes, they know you | **no** (one-time address) | no | no | no |
| A6 infrastructure | no | no | no | no | no |
| A7 device thief | phone owner | only with your passphrase | only with your passphrase | only with your passphrase | only with your passphrase |

## Leaks and mitigations

### Layer 1: funding

| # | Leak | Seen by | Mitigation |
|---|---|---|---|
| F1 | Paying from a **transparent** address publishes sender and amount | A1 | the one-time address is unrecognizable, so the chain shows "a t-address paid an unknown shielded address"; the slip is marked **EXPOSED** locally, with an explanation |
| F2 | The user's own earlier Orchard → Ironwood migration published its amount (turnstile); betting that exact amount right after links them | A1 | denominations; the guide says don't bet a just-migrated amount. Orchard can't pay us directly: post-NU6.3 it can only move to the same wallet |
| F3 | Paying from **Sapling** funds crosses pools: the value balance publishes the **amount** | A1 | detected from the compact block (it lists the Sapling spends next to our output), slip marked **AMOUNT VISIBLE**; the guide says keep funds in Ironwood (Zodl migrates automatically) |
| F4 | Paying straight from a KYC exchange lets it match "sent X at T" with our public data | A5 | unrecognizable one-time address; top-ups are not published as trades (issuance is shuffled per batch, amounts are powers of two); standard denominations; the guide says to withdraw to your own shielded wallet first |
| F5 | A published deposit viewing key would let anyone recognize deposits | A4, A5 | the deposit viewing key is never published; only the reserve's is |
| F6 | Odd amounts fingerprint a bettor | A5 | deposits only in standard denominations |

### Layer 2: positions

| # | Leak | Seen by | Mitigation |
|---|---|---|---|
| P1 | Operator links a buy to a later sell, redemption or withdrawal | A2, A2+ | **blind signatures**: the signer never sees the slip it signs |
| P2 | Key tagging or a forked bundle: one user gets unique keys | A2 | keysets **derived in the browser** from the master key pinned in the build; DLEQ on every signature; root anchored on-chain hourly |
| P3 | Restore requests link all of one user's orders | A2 | **zero-query restore** from the public issuance log |
| P4 | Unique slip amounts link split and merge operations | A2 | power-of-two denominations |
| P5 | Reusing one long-lived key across bets | A2, A4 | no long-lived keys; every slip is independent |
| P7 | A request reveals a user's whole balance (spending every slip at once) | A2 | the wallet keeps standard denominations, spends only what is needed plus change, and re-splits in the background over separate connections; **the server never stores balances at all** |
| P8 | A "called it" proof reveals more than the one trade | anyone shown the proof | each trade's tag uses an independent secret; a proof reveals exactly one fill (market, side, size, price, height) to whoever the user chooses, and nothing about other trades, balance or payouts. Publishing a proof under your own name links your name to that one trade, which is the user's explicit choice. Proof links keep the secret after `#`, so servers and link-preview bots never see it |
| P6 | Operator guesses that a top-up and bets placed seconds later belong to the same (anonymous) person | A2 | both sides are anonymous, so no identity is revealed; blind slips and a fresh connection per request leave only timing; the UI offers a "mix delay" option; documented as low-impact residual |

### Layer 3: payout

| # | Leak | Seen by | Mitigation |
|---|---|---|---|
| X1 | Destination visible to viewing-key holders | A4 | recipient outputs use `OvkPolicy::Discard`. Verified on testnet (`spikes/g-payout`): a view-only wallet with the sender's full viewing key sees only its own change in a payout, no recipient and no per-output amount |
| X2 | The API stores payout addresses | A2 | addresses are **sealed to the signer** in the browser; the API stores ciphertext plus a commitment; the signer forgets them after broadcast |
| X3 | Transaction shape reveals the number of recipients | A1, A4 | fixed shape: always 8 actions; padding outputs are zero-value notes to throwaway addresses with a discarded OVK, so viewing-key holders can't tell them from real recipients (padding to our own address would be decryptable and would leak the count). Verified on testnet: 1 recipient + 6 zero-value outputs + change = exactly 8 Ironwood actions, fee 0.0004 ZEC |
| X4 | Payout to transparent or Sapling-only addresses (amount published by pool crossing) | A1 | rejected; Ironwood receivers only |
| X5 | Timing between a withdraw request and the payout | A2 | fixed batch schedule; requests arrive through the mixnet and are unlinkable to bets anyway |
| X6 | The public reserve viewing key shows each payout transaction's **total**; when only one person withdraws in a block, that total is their withdrawal amount (never the destination) | A1, A4 | withdrawals in standard denominations (a non-standard remainder stays as CREDIT or goes out in a later block), several withdrawals batched per payout whenever the queue allows, and the per-block schedule regardless of demand. Residual at low volume: "someone withdrew 0.05 at block N" is public, and links to nobody |

### Layer 4: network and infrastructure

| # | Leak | Seen by | Mitigation |
|---|---|---|---|
| N1 | IP ↔ order, slip or withdrawal | A2, A3 | **every API call goes through the Nym mixnet**; TLS terminates inside WASM, so the exit sees ciphertext |
| N2 | Timing: "online at T, bet at T+30s" | A2, A3 | the API never sees IPs; mixnet delay plus cover traffic; 2-second batches |
| N3 | URL path reveals which market a visitor opened | A2, A3 | in-app navigation with a **constant URL**: nothing about the page you're on ever leaves the browser |
| N4 | Per-market requests reveal interest | A2, A3 | one identical bundle sequence for everyone, thumbnails included |
| N5 | The browser contacts Polymarket, CDNs or font hosts | A6 | none of them: no CDN, font, image or Polymarket request ever leaves the browser. The only outside contacts are the mixnet client's own bootstrap: it fetches the network topology from Nym's directory API (`https://validator.nymtech.net`) and connects to one entry gateway over WebSocket. Those two learn that an IP runs a Nym client, never which site it uses or what it sends (like Tor's directory authorities and guard). CSP `connect-src 'self' wss: https://validator.nymtech.net`; every other byte arrives inside the mixnet (verified in `spikes/a-mixnet`). Planned hardening: the service worker routes the directory lookup through the app's own static host, so only that host (which already serves the app, N7) and the entry gateway ever see the user's IP |
| N6 | The mixnet is down and the app quietly goes direct | A2, A3 | **never silent**: actions are blocked; the user can explicitly switch to the .onion mirror in Tor Browser or Onion Browser |
| N7 | Loading the app reveals "this IP opened Blindbook" | static host | the app is served from **hosts that aren't the API** (IPFS, mirror, .onion), so loads and orders never meet in one log; the PWA caches the app, so later visits make no request at all |
| N8 | The indexer's **targeted** lightwalletd queries (by txid) reveal which transactions are deposits | A6 | **untargeted only**: every compact block, requested with all pool types (they carry transparent inputs and Sapling spends, so classifying a top-up needs no single-transaction fetch), plus the full mempool stream; option: self-hosted Zebra + Zaino |
| N9 | iOS suspends the page while the user is in the wallet; the mixnet link drops | user | re-links visibly on return; never falls back to direct |
| N10 | Your **wallet** reveals your IP to its lightwalletd when broadcasting | A3, A6 | outside our app; the guide recommends wallets with Nym or Tor (Zingo!, Zkool) |
| N11 | **Session linking:** a reused TLS connection (or TLS session resumption) ties a user's top-up, bets and withdrawal together | A2 | writes never share a connection (`Connection: close`, no TLS resumption; the next regular poll opens the connection the next write uses, so the handshake isn't on the bet's critical path); top-ups and withdrawals use a **separate mixnet tunnel** in their own frame plus a random delay; reads share the main tunnel. Residual: within one session the main tunnel's timing can hint that bets come from the same client. That links anonymous bets to each other, never to a person or a payout (see P6) |
| N12 | **A persisted mixnet identity** links visits at the entry gateway, or the main tunnel and the cage frame load the same identity (mix-fetch stores it in IndexedDB, which same-origin frames share) | A6 (Nym gateway), A2 | every tunnel gets a random `clientId` and `storagePassphrase`; its database (`wasm-client-storage-<clientId>`) is deleted explicitly when the tunnel ends (`disconnectMixTunnel` leaves it behind) and leftovers are deleted at boot; so no two tunnels and no two sessions share a mixnet identity. Verified in `spikes/a-mixnet`: each tunnel, including two running at once in sibling frames, gets its own database and its own exit IP |
| N13 | **A mixnet route dies quietly**: about a third of randomly chosen routes come up "ready" and then never answer, and mix-fetch has no request timeout | user (a bet that seems to hang) | every request carries an app-level deadline; tunnels live in disposable frames: the app races two at boot, keeps the first that answers a health check, and replaces a stuck one with a fresh frame and a fresh identity while the lamp shows RELINKING. It never falls back to a direct connection (N6) |

### Layer 5: device

| # | Leak | Seen by | Mitigation |
|---|---|---|---|
| D1 | A stolen device reveals slips | A7 | vault encrypted with AES-GCM; opening it needs **Face ID** on a phone (passkey PRF) or the passphrase on a computer; auto-lock |
| D1b | The passkey itself reveals usage: a "Blindbook" entry sits in the user's keychain | A7 | the entry holds no balances or history and syncs only end-to-end encrypted; users who want no trace choose the passphrase instead; losing the passkey loses nothing (the 12-word phrase restores everything) |
| D2 | iOS Safari wipes storage after 7 days without use, and bearer slips are lost | user funds | 12-word phrase confirmed before the first bet; zero-query restore; PWA prompt |
| D3 | A malicious frontend steals the vault | A2 | reproducible build, published hashes, SRI, strict CSP, independent mirrors |
| D4 | Sharing a slip QR code in a chat app | that app | a slip is as private as the channel it's sent over; the UI says so before export |
| D5 | Browser history, tab titles and screen sharing reveal which markets you looked at | A7, anyone watching your screen | constant URL (navigation never touches history); the tab title is always `Blindbook`; proof links are replaced in the address bar as soon as they're opened |
| D6 | A paper slip is photographed, or a network printer keeps a copy | A7, print infrastructure | paper slips are bearer cash: a warning before printing ("whoever scans this owns it"); importing swaps the slip at once, so the paper is void; the UI recommends a local printer |
| D8 | Back-room apps or settings leak activity | A2, A3, A6, A7 | all apps run locally with no network requests (Block Radio reads only the public bundle already downloaded); **everything personal** (slips, proofs, notes, stamps, scores, P600 records) lives in the encrypted vault; only cosmetic preferences (CLEAN SIGNAL, sound) are in plain storage |
| D7 | Two shared NOBODY PASS images link the same person | public | the pixel face is random per save, not derived from the vault; stamps are generic; no amounts, markets or dates on the card |

### Integrity, custody, availability

| # | Risk | Mitigation |
|---|---|---|
| I1 | Operator misprices or invents fills | deterministic replay (`blindbook-verify`, also in the browser) |
| I2 | Forged slips (mint key leak) | API holds no keys; the signer's supply guard halts withdrawals when redemptions exceed issuance |
| I3 | Pool drained | spending keys only on the signer, which replays before signing; continuous public solvency check; FROST 2-of-3 as stretch |
| I4 | History rewritten | hash-chained bundle, root anchored on-chain hourly |
| I5 | Replay differs across platforms (floating point) | `libm` crate, fixed rounding rules, CI test that native and WASM give byte-identical results |
| I6 | Stale-price arbitrage drains the house | price **anchored to Polymarket's live mid** (30 s median, never stale); depth-aware guard against Polymarket's bid/ask; halts at 0.98, at the end date and when the reference feed is unhealthy for 10 s; worst-case loss capped by the per-market buffer `L_m` |
| I6b | Reference manipulation: spoofing a thin Polymarket book to move our anchor | lower median over 30 s (a fake mid held for under 15 s can't move it), depth-aware quotes for a fixed share count (500 by default; a fake low ask only loosens the guard, the curve still sets the price), listing requires a deep book, `L_m` caps any damage |
| I6c | Live-event latency: someone watching a match reacts faster than Polymarket's price | **trading halts at event start** (`gameStartTime`, or a scheduled time set at listing) |
| I6d | **Sells drain the buffer:** selling removes cash while the other side's shares stay outstanding (found in external review) | the exposure invariant `max(u_A, u_B) − c ≤ L` is enforced on **sells as well as buys**; excess sells are partially filled and unsold shares come back as slips ([PROTOCOL §5.5](PROTOCOL.md)) |
| I7 | Censorship or delay | everything is in the public log; the user can disclose their own payment |
| I8 | Spam without IPs to rate-limit | proof-of-work on every request; unpaid top-up addresses expire |
| I9 | 0-conf top-up double-spent, or a reorg removes it, after credit was issued | caps: ≤ 0.1 ZEC per top-up, ≤ 0.3 ZEC unconfirmed in total; Zcash nodes reject conflicting nullifiers and there's no replace-by-fee; any loss is absorbed by the house from fees, never by users |
| I10 | Future quantum adversary | Ironwood only (quantum-recoverable notes, ZIP 2005); never send to Orchard receivers (ZIP 326) |

## Residual risks (honest list)

1. **Small anonymity sets at low volume.** "Someone bet 0.01 ZEC on YES" stands out more when few people bet. It is still never tied to an identity, and later actions stay unlinkable.
2. **Mistakes outside our system:** malware, a shared phrase, a wallet without network privacy. We warn and can't undo.
3. **Custody is verifiable, not trustless.** Zcash has no smart contracts. Theft would be visible immediately; deanonymization isn't possible at all.
4. **Nym dependency** for network privacy. If it's unavailable we stop rather than leak. Nym's directory API and the entry gateway see that your IP runs a Nym client (N5), as with any mixnet or Tor use; they never see that it's Blindbook or what you do.
5. **First load of the app.** A static host (not us) sees an IP opening a web app. Use the .onion mirror for zero exposure.
6. **Single signer.** The signer runs on its own VPS with no inbound ports, separate from the public API. A compromise of that one machine would put funds at risk (never privacy). Production removes the single point with FROST 2-of-3.
