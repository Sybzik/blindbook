# Markets: data, rules and settlement

Where Blindbook's markets, prices and results come from, which markets get listed, what a user sees about each market's rules, and how a bet is settled.

## What we take from Polymarket, and what we don't

| We take | Source | Used for |
|---|---|---|
| Catalog: question, **outcome labels**, full rules text, resolution source, end date, event start (`gameStartTime` / `eventStartTime`), `conditionId`, token ids, order-book flags | Gamma API (`gamma-api.polymarket.com`, public, no key), read at start and refreshed every minute | listing a market and its RULES panel |
| **Live** order books of both outcome tokens | CLOB WebSocket market channel | the **anchor** of our price, the guard, the chart's reference line |
| **Result** | Polygon: the ConditionalTokens contract `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | settlement |

**We don't copy Polymarket's trades.** Every fill on Blindbook comes from a Blindbook user trading from a private balance funded with shielded ZEC. Liquidity comes from our market maker: **our price is Polymarket's live price, shifted by our own users' net flow** ([PROTOCOL.md §5](PROTOCOL.md)). Polymarket's 24-hour volume is shown only as context.

All Polymarket requests come **from our server**. A visitor's browser never contacts Polymarket, with one exception the user chooses: the "full rules on Polymarket ↗" link in the RULES panel, which says that it opens polymarket.com directly, outside the mixnet.

## Outcomes: not always YES/NO

Polymarket binary markets have two outcomes with labels in `outcomes`. On Oct 3, **32 of the top 100 open markets used named outcomes** (`["Legacy", "PARIVISION"]`, `["G2 Esports", "Team Liquid"]`) instead of `["Yes", "No"]`.

- **Internally,** outcomes are index 0 (A) and 1 (B). Index i is the contract's payout index i.
- **Everywhere in the UI** we show Polymarket's labels: "BUY LEGACY", not "BUY YES".
- **Colors follow the index, not the word:** A is phosphor green, B is amber.

## Listing

The operator names the markets in a JSON file (`BB_MARKETS`):

```json
[{ "slug": "cs2-navi-faze-2026-10-20" },
 { "slug": "fed-decision-in-october", "event_start_ms": 1793210400000 }]
```

`event_start_ms` (and `end_ms`) are needed only when Gamma has no start time, for example for a Fed decision: trading must close when the event begins. At start, the API loads each market from Gamma, waits up to a minute for Polymarket's live order book, and **lists only the markets that pass every rule below**. A market that fails stays out, and the log line names the rule (`crates/blindbook-polymarket/src/gamma.rs`, `listing_issues`).

| Rule (checked by the API) | Why |
|---|---|
| Two outcomes; not closed; accepting orders; has an order book | simple settlement on the contract's payout vector |
| An event start, from Gamma or the markets file, and it hasn't passed | trading halts at the event start, so nobody trades on live information faster than the reference |
| End date ahead, and before judging ends (Nov 22, 2026; `BB_JUDGING_END_MS`) | judges can watch a full cycle: bet → result → cash in → withdraw |
| Polymarket's mid of outcome A within [0.10, 0.90] | near-certain markets buy little liquidity with the buffer |
| Polymarket's book fills 1,000 shares of outcome A within 2¢ of the top, on both sides | a reference that is reliable and hard to move with one fake order |
| A rules text | nobody has to guess how a bet ends |

`blindbook-api candidates [count]` finds the markets that pass the rules right now (it reads Gamma and each order book, nothing else) and prints them as entries for the file, with the ones that only lack an event start listed apart.

Two more rules are the operator's to follow, since no code can judge them: **public events only, nothing about private individuals**, and **a clear resolution source**. On the curated set, at least one market should end within a day (a match), so a full cycle can be watched.

Every market of a network gets the **same parameters**: liquidity `b`, exposure buffer `L` (the most the house can lose on one market), fee 1%, maximum trade, the 98¢ halt and the 10 s feed limit. Testnet: `b` = 0.2 TAZ, `L` = 0.05 TAZ; mainnet: `b` = 0.01 ZEC, `L` = 0.002 ZEC. **The signer refuses a listing with any other parameters**, so the API can't widen a buffer. The listing (parameters, event start, end date, keyset ids) goes into the public log.

**The house's buffers are the reserve's job:** the operator keeps the reserve above the liabilities plus the buffers of the open markets, with an ordinary shielded payment to the reserve address `blindbook-signer init` prints. The reserve reports in the log show the margin to anyone.

### Planned demo set (subject to what is live on listing day)

| Market | Why |
|---|---|
| Fed decision, October 2026 (single-outcome markets inside the event; event start entered at the announcement time) | resolves Oct 28–29, right at the deadline |
| Brazil presidential runoff, Oct 25 (side markets ending Oct 26) | resolves during recording week |
| US midterm elections, Nov 3 (Senate and House control; event start at the first poll closings, Nov 3 23:00 UTC) | the headline event inside the judging window |
| 2–3 same-day esports or sports matches (named outcomes; CS2 matches carry `gameStartTime`) | resolve within hours; a reliable full-cycle demo |
| 3–5 longer markets resolving during judging | judges can trade live |

## Live reference, anchor and guard

- The API keeps a live WebSocket subscription to Polymarket's order book for every listed outcome token (`wss://ws-subscriptions-clob.polymarket.com/ws/market`, no auth, PING every 3 s), split over connections of at most 40 tokens because Polymarket drops a slow consumer (200 markets produce about 1 MB/s). It keeps a local book per token from `book` and `price_change` events. Every `price_change` carries Polymarket's own best bid and ask, and the local book must agree with them: a disagreement that lasts 1 s (a missed message) makes the API redo that connection, which brings fresh snapshots, and so does a token without a snapshot 5 s after connecting. In a 2-minute test with 60 markets on 3 connections, 4 of 13,280 changes disagreed, all healed by the next message, and no market was unhealthy in any batch. Polymarket's `market_resolved` event wakes our resolver early; settlement still waits for the payout on Polygon.
- **Each 2-second batch records its reference** (the last 30 s of mid samples and their lower median, the depth-aware bid and ask for 500 shares, top of book, Polymarket's timestamps, feed health) in the public log ([PROTOCOL.md §8](PROTOCOL.md)). That snapshot is the batch's **anchor**, and the verifiers check the median against its samples.
- **Buys never price below Polymarket's ask, and sells never above its bid.** With the anchor moving with Polymarket, there is no stale price to pick off.
- **Spoofing doesn't pay:** the median and the depth-aware quotes mean one fake order on a thin book can't swing our price.
- **Anyone can audit a snapshot** against Polymarket's own public price history for that minute.

### Halts (trading closes)

A market halts automatically, checked for every batch (`crates/blindbook-engine`, `halt_reason`), when:
- **the event starts** (kick-off, announcement time);
- Polymarket stops accepting orders or closes the market;
- Polymarket's ask for either outcome reaches 98¢ (the result is effectively known);
- the end date passes;
- the reference is unusable: no valid bid, ask or mid;
- the reference feed has been unhealthy for more than 10 s (connection down or silent for 6 s, no snapshot, or a local book that disagrees with Polymarket's best prices). A market whose price simply hasn't moved is not stale.

While halted, nothing can be bought or sold and no duel can be opened or taken. Slips keep their value, and cashing in opens at the result. The schedule (event start, end date) is fixed in the log at listing, so a postponed event stays halted.

## What the user sees: rules and trade conditions

Every market page has a **RULES** panel with two parts, so nobody has to guess how a bet ends:

**1. Polymarket's rules (verbatim, credited):** the full resolution text from Polymarket (for example "If the match is canceled or ends in a tie, this market will resolve to 50-50", postponement deadlines, walkovers), and the link to the market on Polymarket.

**2. How Blindbook handles this market** (generated from the market's data):
- **TRADING CLOSES:** at the event start (with its UTC time), or earlier if Polymarket stops trading or a price reaches 98¢.
- **SOURCE:** Polymarket's resolution source.
- **SETTLES:** when Polymarket's result is final on-chain (Polygon); usually minutes to hours after the event, longer if disputed.
- **PAYS:** 1 ZEC per winning share; 0.5 per share if Polymarket resolves 50-50.
- **YOUR BET:** fills in the next 2-second batch at one shared price, never above your max price; any unfilled part returns. Fee 1%.
- **REDEEM:** any time after settlement; it never expires.

The bet panel repeats the key conditions in one line under the BUY key: `Fills in ~2 s · max 65¢ · fee 1% · trading closes at the event start`.

## Settlement: how a result is decided

**The source of truth is the Polygon chain, not Polymarket's website or API.**

1. After a market's end date, the API's resolver reads the ConditionalTokens contract every 5 minutes on **two independent Polygon RPC providers** (`polygon-bor-rpc.publicnode.com` and `polygon.drpc.org`, which agreed when checked on Oct 6; `polygon-rpc.com` and Ankr now require keys): `payoutDenominator(conditionId)` (selector `0xdd34de67`).
2. Once it is greater than 0 on both, it reads `payoutNumerators(conditionId, 0..1)` (selector `0x0504c814`). If the providers disagree, nothing is recorded and the operator is alerted.
3. **The signer reads the same result itself**, once a minute, from its own pair of RPCs, and refuses a resolution that differs from it: the internet-facing API can't settle a market its own way.
4. The numerators, the Polygon block and the resolution transaction go into the public log, and the market becomes **RESOLVED**. `blindbook-verify --polygon public` reads every recorded result from Polygon again.
5. Holders cash in: each winning share pays `num_i / den` ZEC as CREDIT, which can be withdrawn or reused.

### Why not Gamma's `outcomePrices`

Gamma shows outcome prices of `["1","0"]` on closed markets while `umaResolutionStatuses` still reads `proposed`. An optimistic-oracle proposal can still be disputed. Only the contract's payout vector is final.

### Verified on Oct 2, 2026 (Polygon mainnet, public RPC)

| Market | Type | Gamma | Contract `den` | Contract numerators |
|---|---|---|---|---|
| "Ethereum above 2,275 on April 21, 3PM ET?" | binary | `["1","0"]`, UMA `proposed` | 1 | [1, 0] |
| "Games Total: O/U 2.5" | binary | `["0","1"]` | 1 | [0, 1] |
| World Cup Winner → Spain | negRisk | `["1","0"]` | 1 | [1, 0] |
| World Cup Winner → England | negRisk | `["0","1"]` | 1 | [0, 1] |
| Presidential Election Winner 2024 → Donald Trump | negRisk | `["1","0"]` | 1 | [1, 0] |
| Presidential Election Winner 2024 → Joe Biden | negRisk | `["0","1"]` | 1 | [0, 1] |

## Edge cases

| Case | What happens |
|---|---|
| UMA dispute (the result is delayed for days) | the market stays **RESOLVING**; slips keep their value; cashing in opens when the contract reports |
| 50-50 result (`[1,1]`): canceled match, tie, walkover per the rules | each share pays 0.5 ZEC |
| Postponed event | we follow Polymarket's rules (for example a 14-day rescheduling window); trading stays halted after the original start |
| Polymarket clarifies the rules | we inherit them: the rules text we serve is refreshed from Gamma every minute |
| Outcome known before the end date (an election called early) | the event-start halt, the 98¢ halt and the guard stop late buyers |
| Polymarket's feed down | trading halts (stale reference); slips, transfers and withdrawals still work |
| Polygon RPC providers disagree | nothing is settled; the API and the signer wait and the operator is alerted |
| A market we shouldn't have listed | we never void or settle a market ourselves (the signer accepts only Polygon's result): it settles the way Polymarket settles it |
| Polymarket's result comes after judging ends | it settles normally whenever it comes; cashing in never expires |

## The market page, in short

- **Header:** page number, category, the two outcome labels, the question, a countdown to the close, and the status: OPEN, HALTED (with the reason in a banner), RESOLVING or RESOLVED.
- **Rows:** when trading closes, and Polymarket's reference for both outcomes.
- **Chart (both outcomes, like Polymarket):** outcome A's line in green and B's in amber, each labelled at its right end ("LEGACY 45%"); a 0–100% axis; ranges **1H · 1D · 1W · ALL** from the price history every visitor downloads (`/v1/history.json.gz`, sampled once a minute), with the live price at the right end; the **REF** switch adds Polymarket's price as dashed violet lines.
- **Bet panel** (first on a phone, so BUY is in reach): the outcome, a standard size, the payout if it wins (at the current price), the BUY key, an optional MIX DELAY, and the one-line conditions; ODDS CALC can hand it a max price.
- **Recent fills** of the last two minutes, written as sentences with the name blacked out: `████████ bought LEGACY · 0.010 ZEC @ 45¢ · 18:52:10 UTC`.
- **RULES** (above), and after your own fill a **CALLED IT** proof you can share.
