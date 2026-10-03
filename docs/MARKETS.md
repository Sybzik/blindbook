# Markets: data and settlement

How Blindbook gets its markets, prices and results from Polymarket, and how a bet is settled.

## What we take from Polymarket, and what we don't

| We take | Source | Used for |
|---|---|---|
| Catalog: question, outcomes, rules text, resolution source, end date, `conditionId`, `clobTokenIds`, image | Gamma API (`gamma-api.polymarket.com`, public, no key) | listing a market |
| **Live** reference price: best bid/ask, midpoint, price history | CLOB WebSocket market channel (REST `/book`, `/midpoint`, `/prices-history` as fallback) | the **anchor** of our price, the guard, the chart's reference line |
| **Result** | Polygon ConditionalTokens contract `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | settlement |

**We don't copy Polymarket's trades.** Every fill on Blindbook comes from a Blindbook user trading from a private balance funded with shielded ZEC. Liquidity comes from our market maker: **our price is Polymarket's live price, shifted by our own users' net flow** (see [PROTOCOL.md §5](PROTOCOL.md)). Polymarket's volume is shown only as context.

All Polymarket requests come **from our server**, are cached, and reach clients inside the global bundle. A visitor's browser never contacts Polymarket.

## Listing (curation)

Run by the operator with `blindbook-admin list <slug>`.

| Rule | Why |
|---|---|
| Binary YES/NO only. Single markets inside negRisk events (e.g. one candidate, one Fed outcome) are fine | simple settlement; verified on-chain (below) |
| Polymarket price ∈ [0.10, 0.90] at listing | avoids near-certain markets where a buffer buys little liquidity |
| Meaningful Polymarket 24h volume | a reliable reference price |
| Not `restricted`; clear resolution source | avoid ambiguous settlement |
| Public events only, nothing about private individuals | ethics |
| End date before judging ends (Nov 22), with **at least one short-dated market** (e.g. a sports match) | so judges can watch a full cycle: bet → resolve → redeem → withdraw |

At listing the admin tool:
1. snapshots the order book;
2. sets `b` and `L_m`;
3. funds the market's exposure buffer `L_m` to the reserve with a `bb1:buffer` memo;
4. publishes the market in the next bundle.

### Planned demo set (subject to what's live on listing day)

| Market | Why |
|---|---|
| Fed decision, October 2026 (single outcome markets) | resolves Oct 28–29, right at the deadline |
| Brazil presidential runoff, if there is one (Oct 25) | resolves during recording week |
| 2–3 short-dated sports or crypto-price markets | resolve within a day; a reliable full-cycle demo |
| 3–5 longer markets resolving during judging | judges can trade live |

## Live reference, anchor and guard

- The server keeps a live WebSocket subscription to Polymarket's order book for every listed outcome token.
- Each 2-second batch records the reference (mid, best bid, best ask, timestamp) in the public log. That snapshot is the **anchor** of our price for that batch.
- **Buys never price below Polymarket's best ask, and sells never above its best bid.** Combined with the moving anchor, there is no stale price to arbitrage.
- Anyone can check a snapshot against Polymarket's own public price history for that minute.

### Halts

A market halts automatically when:
- Polymarket stops accepting orders or closes the market;
- either outcome is ≥ 0.98, meaning the result is effectively known;
- the end date passes;
- the reference is stale (> 10 s).

While halted, nothing can be bought or sold. Redemption opens at resolution.

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
| Split or "50-50" result (`[1,1]`) | each share pays 0.5 ZEC |
| Polymarket clarifies the rules | we inherit them; the rules text in our bundle is refreshed and the change is logged |
| Outcome known before the end date (an election called early) | the 0.98 halt and the guard stop late buyers |
| Polymarket API down | trading halts (stale reference); slips and withdrawals still work |
| Polygon RPC providers disagree | wait and alert; never settle on a single source |
| Our listing mistake | we never "void". The worst case is resolving as a split (pays 0.5), decided publicly and logged |
| Market ends after judging | still settles normally; redemption never expires |

## What the user sees on a market page

- The question, rules text and resolution source, with "mirrored from Polymarket" credit.
- **Two prices side by side:** Blindbook (ours) and Polymarket (reference), with bid and ask.
- An oscilloscope chart: our price trace plus Polymarket's reference trace.
- Volume: ours (public, from batch results) and Polymarket's (context).
- An anonymous fill tape: `▮▮▮▮▮ 0.01 ZEC → YES @ 0.612 · blk 3,514,220`.
- Status: OPEN / HALTED (with reason) / RESOLVING / RESOLVED (with a link to the Polygon tx).
