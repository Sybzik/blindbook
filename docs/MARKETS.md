# Markets: data, rules and settlement

How Blindbook gets its markets, prices and results from Polymarket, what a user sees about each market's rules, and how a bet is settled.

## What we take from Polymarket, and what we don't

| We take | Source | Used for |
|---|---|---|
| Catalog: question, **outcome labels**, full rules text, resolution source, end date, `gameStartTime` (sports), `conditionId`, `clobTokenIds`, image | Gamma API (`gamma-api.polymarket.com`, public, no key) | listing a market and its rules panel |
| **Live** reference price: bid/ask, midpoint, price history | CLOB WebSocket market channel (REST `/book`, `/midpoint`, `/prices-history` as fallback) | the **anchor** of our price, the guard, the chart's reference trace |
| **Result** | Polygon ConditionalTokens contract `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | settlement |

**We don't copy Polymarket's trades.** Every fill on Blindbook comes from a Blindbook user trading from a private balance funded with shielded ZEC. Liquidity comes from our market maker: **our price is Polymarket's live price, shifted by our own users' net flow** ([PROTOCOL.md §5](PROTOCOL.md)). Polymarket's volume is shown only as context.

All Polymarket requests come **from our server**, are cached, and reach clients inside the global bundle. A visitor's browser never contacts Polymarket. The only exception is an explicit "full rules on Polymarket ↗" link the user clicks themselves (`rel="noreferrer noopener"`, marked as leaving Blindbook).

## Outcomes: not always YES/NO

Polymarket binary markets have two outcomes with labels in `outcomes`. On Oct 3, **32 of the top 100 open markets used named outcomes** (`["Legacy", "PARIVISION"]`, `["G2 Esports", "Team Liquid"]`) instead of `["Yes", "No"]`.

- **Internally,** outcomes are index 0 (A) and 1 (B). Index i matches CTF payout index i.
- **Everywhere in the UI** we show Polymarket's labels: "BUY LEGACY 45¢", not "BUY YES".
- **Colors follow the index, not the word:** A = phosphor green, B = amber.

## Listing (curation)

Run by the operator with `blindbook-admin list <slug>`.

| Rule | Why |
|---|---|
| Binary markets only (Yes/No or two named outcomes). Single markets inside negRisk events (one candidate, one Fed outcome) are fine | simple settlement; verified on-chain (below) |
| Polymarket price ∈ [0.10, 0.90] at listing | avoids near-certain markets where a buffer buys little liquidity |
| Polymarket book deep enough to fill our max trade within 2¢ | a reliable, hard-to-spoof reference |
| Not `restricted`; clear resolution source | avoid ambiguous settlement |
| Public events only, nothing about private individuals | ethics |
| A known **event start** (`gameStartTime`, or a scheduled time entered at listing) | trading halts when the event begins, so nobody trades on live information faster than the reference |
| End date before judging ends (Nov 22), with **at least one short-dated market** (e.g. a match the same day) | judges can watch a full cycle: bet → resolve → redeem → withdraw |

At listing the admin tool:
1. snapshots the order book;
2. sets `b`, `L_m` and the event-start halt;
3. funds the market's exposure buffer `L_m` to the reserve with a `bb1:buffer` memo;
4. publishes the market, including its rules text, in the next bundle.

### Planned demo set (subject to what's live on listing day)

| Market | Why |
|---|---|
| Fed decision, October 2026 (single outcome markets) | resolves Oct 28–29, right at the deadline |
| Brazil presidential runoff, if there is one (Oct 25) | resolves during recording week |
| 2–3 same-day esports or sports matches (named outcomes) | resolve within hours; a reliable full-cycle demo |
| 3–5 longer markets resolving during judging | judges can trade live |

## Live reference, anchor and guard

- The server keeps a live WebSocket subscription to Polymarket's order book for every listed outcome token (`wss://ws-subscriptions-clob.polymarket.com/ws/market`, no auth, PING every 10 s). Its `market_resolved` event wakes our resolver early, but settlement still waits for the on-chain payout.
- **Each 2-second batch records the reference** (30 s median mid, depth-aware bid and ask, timestamp) in the public log. That snapshot is the batch's **anchor**.
- **Buys never price below Polymarket's ask, and sells never above its bid.** With the moving anchor there's no stale price to arbitrage.
- **Spoofing doesn't pay:** the median and the depth-aware quotes mean one fake order on a thin book can't swing our price.
- **Anyone can audit a snapshot** against Polymarket's own public price history for that minute.

### Halts (trading closes)

A market halts automatically when:
- **the event starts** (match kick-off, announcement time);
- Polymarket stops accepting orders or closes the market;
- either outcome is ≥ 0.98 (the result is effectively known);
- the end date passes;
- the reference is stale (> 10 s).

While halted, nothing can be bought or sold. Slips keep their value, and redemption opens at resolution.

## What the user sees: rules and trade conditions

Every market page has a **RULES** panel with two parts, so nobody has to guess how a bet ends:

**1. Polymarket's rules (verbatim, credited)**
- the full resolution text from Polymarket (e.g. "If the match is canceled or ends in a tie, this market will resolve to 50-50", postponement deadlines, walkovers);
- the resolution source (e.g. hltv.org) and the scheduled start and end.

**2. How Blindbook handles this market (generated from parameters)**
- **Trading closes:** at the event start (Oct 3, 09:00 UTC), or earlier if Polymarket stops trading or the price reaches 98¢.
- **Settles:** when Polymarket's result is final on-chain (Polygon). Usually minutes to hours after the event, longer if disputed.
- **Pays:** 1 ZEC per winning share; 0.5 per share if Polymarket resolves 50-50.
- **Your bet:** fills in the next 2-second batch at one shared price, never above your max price. Any unfilled part returns to your balance. Fee 1%.
- **Redeem any time after settlement;** it never expires.

The bet panel repeats the key conditions in one line under the BUY key: `Fills in ~2 s · max 65¢ · fee 1% · trading closes at kick-off`.

## Settlement: how a result is decided

**The source of truth is the Polygon chain, not Polymarket's website or API.**

1. After the end date, the resolver polls `payoutDenominator(conditionId)` (selector `0xdd34de67`) every 5 minutes on two independent Polygon RPC providers.
2. Once it's greater than 0, it reads `payoutNumerators(conditionId, 0..1)` (selector `0x0504c814`).
3. Numerators, the Polygon block and the resolution tx hash go into the public delta, and the market becomes **RESOLVED**.
4. Holders redeem: each winning share pays `num_i / den` ZEC as CREDIT, which can be withdrawn or reused.

### Why not Gamma's `outcomePrices`

Gamma shows outcome prices of `["1","0"]` on closed markets while `umaResolutionStatuses` still reads `proposed`. An optimistic-oracle proposal can still be disputed. Only the contract's payout vector is final.

### Verified on Oct 2, 2026 (Polygon mainnet, public RPC)

| Market | Type | Gamma | CTF `den` | CTF numerators |
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
| UMA dispute (resolution delayed for days) | the market stays **RESOLVING**; slips keep their value; redemption opens when the contract reports |
| 50-50 result (`[1,1]`): canceled match, tie, walkover per the rules | each share pays 0.5 ZEC |
| Postponed event | we follow Polymarket's rules (e.g. a 14-day rescheduling window); trading stays halted after the original start unless re-listed |
| Polymarket clarifies the rules | we inherit them; the rules text in our bundle is refreshed and the change is logged |
| Outcome known before the end date (an election called early) | the event-start halt, the 0.98 halt and the guard stop late buyers |
| Polymarket API down | trading halts (stale reference); slips and withdrawals still work |
| Polygon RPC providers disagree | wait and alert; never settle on a single source |
| Our listing mistake | we never "void". The worst case is resolving as 50-50, decided publicly and logged |
| Market ends after judging | still settles normally; redemption never expires |

## The market page, in short

- **Header:** the question, outcome labels, status (OPEN / HALTED with reason / RESOLVING / RESOLVED with the Polygon tx), closes-at.
- **Chart (both outcomes, like Polymarket):**
  - outcome A's line in green and outcome B's in amber, each labelled at its right end ("LEGACY 45%", "PARIVISION 56%");
  - a 0–100% axis;
  - Polymarket's reference as a thin violet dashed trace for the selected outcome, which can be toggled.
- **Prices:** ours per outcome in ¢ and %, with Polymarket's reference beside them.
- **Bet panel:** outcome toggle, amount, max price, payout preview, one BUY key, and the one-line conditions under it.
- **Recent fills:** `▮▮▮▮ 0.010 ZEC → LEGACY @ 0.45 · blk 3,514,220`.
- **RULES** panel (above), and a **CALLED IT** hint after your own fills.
