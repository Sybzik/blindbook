# Protocol spec (v0.3)

Wire formats, algorithms and parameters. The architecture and its rationale are in [ARCHITECTURE.md](ARCHITECTURE.md).
**Normative** means the verifier must reproduce it exactly.

## 1. Units and parameters

| Name | Value | Notes |
|---|---|---|
| zatoshi | 10⁻⁸ ZEC | Zcash base unit |
| **unit** | 1,000 zatoshi = 10⁻⁵ ZEC | atomic unit of every slip; 1 ZEC = 100,000 units |
| share | pays 100,000 units (1 ZEC) if its outcome wins | |
| slip denominations | 2ᵏ units, k = 0..30 | power-of-two, like cash |
| top-up denominations | testnet: 0.01 / 0.05 / 0.1 / 0.5 TAZ · mainnet: 0.001 / 0.005 / 0.01 ZEC | ZEC ≈ $1,300 on Oct 2; mainnet is a micro-stakes proof |
| 0-conf credit | testnet ≤ 0.1 / 0.3 TAZ · mainnet ≤ 0.005 / 0.01 ZEC (per top-up / total unconfirmed) | above that: after 1 confirmation |
| top-up address lifetime | 120 blocks (~2.5 h) | later payments are still credited |
| **trade batch window** | **2 s** | all trade requests in a window clear together |
| reference staleness limit | 10 s | Polymarket live book (WebSocket, REST fallback) |
| trade fee | 100 bp of buy amount; 100 bp of sell proceeds | goes to the house balance (published) |
| withdrawal fee | 20,000 zatoshi | |
| payout batch | every block while the queue is non-empty | fixed 8-action shape |
| withdrawal privacy delay | uniform random 0–60 s, client-side | before sending, on a fresh mixnet session |
| sweep | every 48 blocks (~1 h), only if there are deposits | |
| anchor | testnet every 48 blocks; **mainnet once a day + at each resolution** | each anchor costs 0.0001 ZEC, so mainnet anchors are rationed |
| PoW difficulty | 22 bits (published in `head`, adjustable) | ~0.3–1 s in WASM on a phone |
| LMSR `b` | per market: testnet 0.2 TAZ, mainnet 0.01 ZEC | how strongly our users' flow moves our price |
| exposure buffer `L_m` | per market: testnet 0.05 TAZ, mainnet 0.002 ZEC | the house's maximum loss in that market; funded at listing; when it's used up, the market accepts only risk-reducing trades |
| listing band | Polymarket mid ∈ [0.10, 0.90] at listing | |

Rounding (normative): share and credit amounts round **down** to whole units. Every remainder goes to the house balance and is logged.

## 2. Keys and keysets

- **Mint master key:** secp256k1 secret `m`, held by the signer. `M = m·G` is **pinned in the app build** and in the repository.
- **Keyset per** (market, outcome ∈ {YES, NO}) plus one global CREDIT keyset; one key per denomination k = 0..30.
- **Derivation (normative), non-hardened, so the browser can derive public keys itself:**
  ```
  t      = SHA256("blindbook/keyset/v1" ‖ M ‖ market_id ‖ outcome ‖ k)  mod n
  secret = m + t        (signer only)
  public = M + t·G      (anyone)
  ```
  `market_id` = 32-byte Polymarket `conditionId`; CREDIT uses 32 zero bytes. Keyset ids follow Cashu's format so `cashu-ts` NUT-13 derivation works unchanged.
- **Signer encryption key:** X25519, public half pinned in the build; withdrawal addresses are sealed to it.
- A client never accepts a key it didn't derive from `M`, and every signature carries a NUT-12 DLEQ proof, so equivocation is impossible.

## 3. Slips (e-cash tokens)

Cashu NUT-00 primitives (BDHKE) with NUT-12 DLEQ:

```
secret x (32 bytes)        Y  = hash_to_curve(x)            (Cashu domain separator)
blinding r                 B_ = Y + r·G                      (sent to the mint)
signer                     C_ = k·B_ ,  DLEQ(e, s)           (returned and published)
client                     C  = C_ − r·K ,  check DLEQ       (slip = {keyset_id, amount, x, C})
spend                      check C == k·hash_to_curve(x); add Y to the spent set
```

- **Deterministic secrets:** `x` and `r` come from the BIP 39 seed per NUT-13 (keyset id + counter).
- **Zero-query restore (normative client behaviour):** derive `B_` for counters 0..n per keyset, find them in the public issuance log, unblind, and check `Y` against the public spent set. **No restore request is ever sent.**
- Transfer format: `bbslip1:` + base64url(CBOR [keyset_id, amount, x, C]…), also as a QR code.

## 4. Requests (browser → API, always over the mixnet)

- Every POST carries `pow = {nonce}`: `SHA256("bb-pow-v1" ‖ SHA256(canonical_body) ‖ nonce)` must have ≥ D leading zero bits. Canonical body = RFC 8785 JSON.
- **Connection isolation (normative client behaviour):**
  - every write uses a **new connection** with no TLS session resumption;
  - withdrawals use a **new mixnet client session** and a random 0–60 s delay;
  - read polling uses its own connection, separate from writes.

| Endpoint | Body | Executes | Returns |
|---|---|---|---|
| `POST /v1/topup` | `amount_zat` (a top-up denomination), `credit_outputs[]`, `claim_hash = SHA256(topup_secret)` | on SEEN (≤ 0-conf caps) or 1 confirmation | `{topup_id, address, expires_height}` |
| `GET /v1/topup/{id}` | | | `{status: awaiting / seen / credited / confirmed, signatures[]}` |
| `POST /v1/trade` | `inputs[]` (CREDIT slips for a buy, position slips for a sell), `market_id, side (buy/sell), outcome, limit_bp, outputs[], change_outputs[]` | next 2 s batch | `{avg_price_bp, filled, refunded, signatures[]}` |
| `POST /v1/swap` | `inputs[], outputs[]` (same keyset, equal sum) | immediately | `{signatures[]}` |
| `POST /v1/redeem` | `inputs[]` (winning keyset), `credit_outputs[]` | immediately after resolution | `{signatures[]}` |
| `POST /v1/withdraw` | `inputs[]` (CREDIT), `amount_units`, `address_sealed` (X25519 sealed box of `{address, salt}`), `address_commitment = SHA256(address ‖ salt)` | next payout block | `{withdraw_id}`; status shown in the bundle |
| `POST /v1/topup/claim` | `topup_id, topup_secret, credit_outputs[]` | immediately | extra or late payments to an already-credited top-up address |
| `POST /v1/voucher` | `code, credit_outputs[]` | immediately | judge vouchers: a single-use code exchanged for CREDIT slips |

- Output counts are capped at 32 per keyset per request.
- **API-side validation:** PoW, schema, unspent and valid inputs.
- **The API never signs.** It hands batches to the signer over the signer's outbound stream (§8) and relays the signatures back.

## 5. Pricing and batch clearing (normative)

### 5.1 Anchored LMSR

The state per market is the users' outstanding shares `u = (u_Y, u_N)`, the cash collected `c` and the buffer `L`. For a batch with Polymarket reference mid `μ`:

```
anchor a      = b · logit(μ)
effective q   = (u_Y + a, u_N)
price_YES(q)  = σ((q_Y − q_N) / b)                     // = μ when u_Y = u_N
cost C(q)     = b · ln(e^(q_Y/b) + e^(q_N/b))          // log-sum-exp
buy YES with A: Δ = b · ln(e^((C(q)+A)/b) − e^(q_N/b)) − q_Y
```

Polymarket moving changes the anchor (our price follows). Our users' net position shifts our price relative to Polymarket.

### 5.2 Halts

A market is halted for a batch if any of:
- Polymarket `closed` or `acceptingOrders == false`;
- past our end time;
- either outcome's best ask ≥ 0.98;
- reference older than 10 s.

Halted requests are refunded in full as CREDIT.

### 5.3 Buys in a batch

```
net_i = amount_i − fee(amount_i)
loop:
  A_Y, A_N = Σ net per side ; p = price(q)                         // opening price
  k   = min(A_Y / p, A_N / (1 − p))                                // complete sets, cost exactly k, price unchanged
  R_Y = A_Y − k·p ; R_N = A_N − k·(1 − p)                          // at most one is non-zero
  curve_s  = k + lmsr_buy(q + (k, k), s, R_s)
  shares_s = min(curve_s, A_s / ask_s)                             // guard: never cheaper than Polymarket
  // exposure: worst-case house loss = max(u_Y + shares_Y, u_N + shares_N) − (c + A_Y + A_N)
  if worst-case loss > L: shrink the residual side pro-rata until it equals L; the shrunk part is refunded
  avg_s = A_s / shares_s
  drop orders with avg_side > limit_i (refund in full); if any were dropped → loop
allocate: order i gets floor(net_i / avg_s) share-units; dust → house
u ← u + issued ;  c ← c + Σ amounts kept
```

Because the guard and the buffer only ever **reduce** issued shares, the house never loses more than `L` in a market.

### 5.4 Sells in a batch (after buys)

Aggregate shares per side `S_s`.
- Proceeds `C(q) − C(q − S_s·e_s)`, capped at `S_s · bid_s` (guard).
- Min-price check with the same drop-and-repeat loop, then the 1% fee, then pro-rata allocation as CREDIT.
- `u ← u − S`, `c ← c − proceeds`.

### 5.5 Determinism

- IEEE-754 `f64` only through the pure-Rust **`libm`** crate; no platform `exp`/`ln`, no fused multiply-add.
- Integer units at every boundary, rounding down.
- CI asserts that native and WASM builds of `blindbook-engine` produce byte-identical batch results.

### 5.6 Worked examples (b = 0.2 ZEC, fee 1%)

| Case | Result |
|---|---|
| Polymarket mid 0.60, nobody has traded here | our YES price = **0.6000** (equal to Polymarket) |
| Buy YES 0.05 ZEC (0.0495 after fee), ask 0.61 | 0.076785 shares at average **0.6447**; guard not binding; our price after: **0.6877** |
| Then Polymarket moves to 0.65 | our YES price **0.7316**: we follow Polymarket, still shifted by our users' YES position |
| Or Polymarket moves to 0.55 | our YES price **0.6421** |
| House exposure after that buy | collected 0.0495 ZEC vs. 0.0768 ZEC payout if YES wins → worst case −0.0273 ZEC, within `L` = 0.05 |
| YES 0.05 and NO 0.01 in one batch (mid 0.60) | 0.024750 complete sets matched at 0.60; residual YES moves the curve. YES side average **0.6222**, NO side **0.4000**, price after **0.6636**. Cost = paid = 0.059400 ✓ |
| Starting at 50/50 instead, while Polymarket says 0.90 | the first trader buys a ~0.90 share for ~0.50 and takes ~0.40 ZEC per share from the house. **This is why we never start at 50/50.** |

**Price impact versus `b`** (one buy, price 0.50 before):

| b | buy 0.005 | buy 0.01 | buy 0.05 |
|---|---|---|---|
| 0.05 | → 0.548 | → 0.591 | → 0.816 |
| 0.1 | → 0.524 | → 0.548 | → 0.697 |
| 0.2 | → 0.512 | → 0.524 | → 0.611 |
| 0.5 | → 0.505 | → 0.510 | → 0.548 |

## 6. Resolution and redemption

1. After the end date, the resolver polls the Polygon ConditionalTokens contract every 5 minutes on **two independent RPC providers** (they must agree):
   - `payoutDenominator(conditionId)` = `0xdd34de67`;
   - `payoutNumerators(conditionId, i)` = `0x0504c814`.
2. When the denominator is greater than 0: record the numerators, the Polygon block and the resolution tx hash; the market becomes **RESOLVED**.
3. A winning slip of `a` share-units pays `floor(a · num_i / den)` CREDIT units. Split results (`[1,1]`) pay half. Losing keysets become worthless.
4. Redemption never expires.

## 7. Public data (read path)

Every visitor downloads **the same files in the same order**, through the mixnet.

| File | Content | Refresh |
|---|---|---|
| `GET /v1/head` | `{height, seq, root, pow_bits}` | poll ~3 s |
| `GET /v1/live` | current prices (ours and the Polymarket reference) for all markets, plus the last 2 minutes of batch results (the tape) | poll ~3 s |
| `GET /v1/snapshot/{seq}.json.gz` | full state: markets (rules text, WebP thumbnails), keyset ids, issuance log, spent set, house balance | on first load |
| `GET /v1/delta/{seq}.json.gz` | one block's worth of batches: inputs, reference snapshots, results, issued `B_`/`C_`/DLEQ (shuffled), spent `Y`s, payouts, resolutions, anchors, `prev_root` | per block |

- `root = SHA256(prev_root ‖ SHA256(delta))`: a hash chain, anchored on-chain hourly.
- Your own trade results arrive in the **response** within seconds; the bundle is for the public record, restore and verification.

## 8. Signer protocol

- The signer has **no inbound ports**. It opens a persistent outbound stream (WebSocket over TLS) to the API.
- It runs its own indexer and keeps its own engine state, so it **verifies every batch before signing**. Batch signing takes milliseconds.
- **Supply guard:** if redemptions of any keyset would exceed what the signer itself issued, it halts all withdrawals and raises an alarm.
- On schedule it builds sweeps, payouts and anchors as PCZTs, then proves, signs and broadcasts them.

## 9. Chain transactions

| Tx | From → to | Shape | Memo |
|---|---|---|---|
| Sweep | deposit account → reserve | matured top-up notes in, one note out | none |
| Payout | reserve → users (+ change) | always **8 Ironwood actions** (≤ 7 recipients + change, padded); recipient outputs with `OvkPolicy::Discard` | none |
| Anchor | reserve → reserve (internal) | 2 actions | `bb1:anchor:<height>:<root-hex>` |
| Buffer funding | operator → reserve | | `bb1:buffer:<market_id>` |

Payouts go only to unified addresses with an Orchard-protocol receiver.

## 10. Indexer rules

- Sync every compact block with the deposit viewing key.
- Watch the **full** mempool stream; trial-decrypt everything for SEEN.
- To classify a top-up (transparent inputs → EXPOSED; Sapling spends → AMOUNT VISIBLE), fetch **every** full transaction of every block, never only ours.
- Never request a single txid from third-party infrastructure.
- The signer runs its own indexer the same way.
- Mainnet option: self-hosted Zebra + Zaino.

## 11. On-disk state (SQLite)

`markets`, `topups` (diversifier index ↔ request), `deposits`, `batches`, `snapshots`, `issuance`, `spent`, `withdrawals` (commitment, sealed blob until broadcast, status, txid; **no plaintext address**), `anchors`, `house_ledger`.
No table, log or metric ever contains an IP, user agent or plaintext payout address.
