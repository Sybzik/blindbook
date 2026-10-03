# Protocol spec

Wire formats, algorithms and parameters. The architecture and its rationale are in [ARCHITECTURE.md](ARCHITECTURE.md).
**Normative** means the verifier must reproduce it exactly.

## 1. Units and parameters

| Name | Value | Notes |
|---|---|---|
| zatoshi | 10⁻⁸ ZEC | Zcash base unit |
| **unit** | 1,000 zatoshi = 10⁻⁵ ZEC | atomic unit of every slip; 1 ZEC = 100,000 units |
| share | pays 100,000 units (1 ZEC) if its outcome wins | |
| outcomes | index 0 = **A**, index 1 = **B**, labelled with Polymarket's `outcomes[i]` (`Yes`/`No` or e.g. `Legacy`/`PARIVISION`) | index i matches the CTF payout index i (verified Oct 2) |
| slip denominations | 2ᵏ units, k = 0..30 | power-of-two, like cash |
| top-up denominations | testnet: 0.01 / 0.05 / 0.1 / 0.5 TAZ · mainnet: 0.001 / 0.005 / 0.01 ZEC | mainnet is a micro-stakes proof |
| 0-conf credit | testnet ≤ 0.1 / 0.3 TAZ · mainnet ≤ 0.005 / 0.01 ZEC (per top-up / total unconfirmed) | above that: after 1 confirmation |
| top-up address lifetime | 120 blocks (~2.5 h) | later payments are still credited |
| **trade batch window** | **2 s** | all trade requests in a window clear together |
| anchor | median Polymarket mid over the last **30 s** | spoof-resistant |
| guard depth | bid/ask needed to fill **our max trade size** on Polymarket's book | not just top of book |
| reference staleness limit | 10 s | Polymarket live book (WebSocket, REST fallback) |
| trade fee | 100 bp of buy amount; 100 bp of sell proceeds | goes to the house balance (published) |
| max trade size | per market: `L_m` × 4 of notional | keeps single trades small relative to the buffer |
| withdrawal fee | 20,000 zatoshi | |
| payout batch | every block while the queue is non-empty | fixed 8-action shape |
| withdrawal privacy delay | uniform random 0–60 s, client-side | before sending, from the separate top-up/withdrawal tunnel |
| sweep | every 48 blocks (~1 h), only if there are deposits | |
| anchor tx | testnet every 48 blocks; mainnet once a day + at each resolution | each costs 0.0001 ZEC |
| PoW difficulty | top-up, voucher, withdraw: 22 bits; trade, swap, redeem: 16 bits (published in `head`) | trades also spend valid slips, so they need little PoW and stay fast |
| connection policy | a fresh TCP+TLS connection per write (the API sends `Connection: close`; TLS session resumption off) | see §4 |
| LMSR `b` | per market: testnet 0.2 TAZ, mainnet 0.01 ZEC | how strongly our users' flow moves our price |
| exposure buffer `L_m` | per market: testnet 0.05 TAZ, mainnet 0.002 ZEC | the house's maximum loss in that market; funded at listing |
| listing band | Polymarket mid ∈ [0.10, 0.90] at listing | |

Rounding (normative): share and credit amounts round **down** to whole units. Every remainder goes to the house balance and is logged.

## 2. Keys and keysets

- **Mint master key:** secp256k1 secret `m`, held by the signer. `M = m·G` is **pinned in the app build** and in the repository.
- **Keysets:** one per (market, outcome ∈ {A, B}), plus one global CREDIT keyset. Each has one key per denomination k = 0..30.
- **Derivation (normative), non-hardened, so the browser can derive public keys itself:**
  ```
  t      = SHA256("blindbook/keyset/v1" ‖ M ‖ market_id ‖ outcome_index ‖ k)  mod n
  secret = m + t        (signer only)
  public = M + t·G      (anyone)
  ```
  `market_id` = 32-byte Polymarket `conditionId`; CREDIT uses 32 zero bytes. Keyset ids follow Cashu's format so `cashu-ts` NUT-13 derivation works unchanged.
- **Signer encryption key:** X25519, public half pinned in the build; withdrawal addresses are sealed to it.
- **No equivocation:** a client never accepts a key it didn't derive from `M`, and every signature carries a NUT-12 DLEQ proof.

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
- **Vault at rest (client):** a random 256-bit vault key encrypts the vault (AES-GCM). The vault key is wrapped twice:
  - by `HKDF(PRF output, "bb-vault-v1")` from a passkey (`navigator.credentials.get` with the `prf` extension, evaluated locally, with no server challenge involved);
  - by Argon2id(passphrase) as the fallback.

  The BIP 39 seed inside the vault is the root of every secret.
- **Zero-query restore (normative client behaviour):** derive `B_` for counters 0..n per keyset, find them in the public issuance log, unblind, and check `Y` against the public spent set. **No restore request is ever sent.**
- **Transfer format:** `bbslip1:` + base64url(CBOR [keyset_id, amount, x, C]…), also as a QR code. The recipient swaps it immediately so the sender can't spend it twice.
- **Paper slips:** the same `bbslip1:` payload printed as a QR on a receipt-width page (black on white). The app can then delete the slip locally. Importing a paper slip **swaps it at once** (new secrets, new signatures), so the paper is void after import, and a photographed copy is worthless once imported.

## 4. Requests (browser → API, always over the mixnet)

- **Proof-of-work:** every POST carries `pow = {nonce}`. `SHA256("bb-pow-v1" ‖ SHA256(canonical_body) ‖ nonce)` must have at least D leading zero bits (D per endpoint, §1). Canonical body = RFC 8785 JSON.
- **Connection discipline (normative):**
  - **mix-fetch allows one tunnel per page** (`setupMixTunnel` once; `disconnectMixTunnel` needs a page reload). The main page's tunnel carries browsing, reads and trades.
  - **Writes never share a connection:** the API answers every POST with `Connection: close`, and the TLS terminator disables session tickets and resumption, so each write rides a new TCP+TLS connection inside the tunnel.
  - **Top-ups and withdrawals use a separate mixnet identity:** they run in a hidden same-origin frame that sets up **its own tunnel** (a different mixnet client), destroyed afterwards. Withdrawals add a random 0–60 s delay. Fallback, if a frame can't hold its own tunnel: reload into "cage mode" with a fresh tunnel.
  - **One mixnet identity per tunnel, never reused (normative):** mix-fetch keeps its client identity (keys, gateway registration) in IndexedDB under `clientId` (default `smolmix-wasm`), and a same-origin frame shares that storage. So every tunnel is set up with a random `clientId` and a random `storagePassphrase`: the main tunnel gets a new one on every page load, the cage frame a new one for every top-up or withdrawal. A tunnel's database is deleted when it ends, and leftovers are deleted at boot. Two tunnels never load the same identity, and no identity outlives its session.
  - **Spike A verifies:** a frame gets an independent tunnel with its own identity (its own IndexedDB database); `Connection: close` is honoured; the end-to-end bet latency (target p50 ≤ 4 s).
  - **If a fresh connection per write is too slow:** bets within one session may share a keep-alive connection (linkable only to each other, never to top-ups or withdrawals; residual N11).

| Endpoint | Body | Executes | Returns |
|---|---|---|---|
| `POST /v1/topup` | `amount_zat` (a top-up denomination), `credit_outputs[]`, `claim_hash = SHA256(topup_secret)` | on SEEN (within 0-conf caps) or 1 confirmation | `{topup_id, address, expires_height}` |
| `GET /v1/topup/{id}` | | | `{status: awaiting / seen / credited / confirmed, signatures[]}` |
| `POST /v1/trade` | `inputs[]` (CREDIT slips for a buy, position slips for a sell), `market_id, side (buy/sell), outcome (0/1), limit_bp, outputs[], change_outputs[], tag` | next 2 s batch | `{avg_price_bp, filled, refunded, signatures[]}` |
| `POST /v1/swap` | `inputs[], outputs[]` (same keyset, equal sum) | immediately | `{signatures[]}` |
| `POST /v1/redeem` | `inputs[]` (winning keyset), `credit_outputs[]` | immediately after resolution | `{signatures[]}` |
| `POST /v1/withdraw` | `inputs[]` (CREDIT), `amount_units`, `address_sealed` (X25519 sealed box of `{address, salt}`), `address_commitment = SHA256(address ‖ salt)` | next payout block | `{withdraw_id}`; status shown in the bundle |
| `POST /v1/topup/claim` | `topup_id, topup_secret, credit_outputs[]` | immediately | extra or late payments to an already-credited top-up address |
| `POST /v1/voucher` | `code, credit_outputs[]` | immediately | judge vouchers: a single-use code exchanged for CREDIT slips |

- Output counts are capped at 32 per keyset per request.
- **Blank outputs for trades (normative):** the client can't know in advance how a trade fills, so `/v1/trade` carries blinded outputs **without amounts** for both possible results (as in Cashu NUT-08); the signer picks each used output's denomination and returns it with the signature and DLEQ.
  - **buy:** `outputs[]` in the outcome's position keyset (shares bought), `change_outputs[]` in CREDIT (refunds: limit, halt, the part shrunk by the invariant);
  - **sell:** `outputs[]` in CREDIT (proceeds), `change_outputs[]` in the **same position keyset** (shares that didn't sell: limit, halt, the part shrunk by the invariant).
  - Each list always holds **31** blank outputs, enough for any amount below 2³¹ units, so every trade request has the same shape. Unused outputs are never signed, and zero-query restore skips them (gap limit 64 counters).
- **P600 transparency:** every write response includes `stored_record`, the exact row the server stored for that request (batch, tag, market, outcome, side, size, price, height). The app keeps these in the vault and shows them on P600, with no extra request.
- **API-side validation:** PoW, schema, unspent and valid inputs.
- **The API never signs.** It hands batches to the signer over the signer's outbound stream (§9) and relays the signatures back.

## 5. Pricing and batch clearing (normative)

### 5.1 Anchored LMSR

The state per market is the users' outstanding shares `u = (u_A, u_B)`, the cash collected `c` and the buffer `L`. For a batch with reference mid `μ` (median over the last 30 s):

```
anchor a      = b · logit(μ)
effective q   = (u_A + a, u_B)
price_A(q)    = σ((q_A − q_B) / b)                     // = μ when u_A = u_B
cost C(q)     = b · ln(e^(q_A/b) + e^(q_B/b))          // log-sum-exp
buy A with X: Δ = b · ln(e^((C(q)+X)/b) − e^(q_B/b)) − q_A
```

When Polymarket moves, the anchor moves and our price follows. Our users' net position shifts our price relative to Polymarket.

### 5.2 Halts

A market is halted for a batch if any of:
- Polymarket `closed` or `acceptingOrders == false`;
- **event start reached:** `gameStartTime` for sports, or a scheduled moment set at listing (e.g. a central-bank announcement);
- past our end time;
- either outcome's ask ≥ 0.98;
- reference older than 10 s.

Halted requests are refunded in full: a buy as CREDIT, a sell as its own shares (new position slips from `change_outputs[]`).

### 5.3 The exposure invariant (holds after every batch)

```
W = max(u_A, u_B) − c  ≤  L          // the house's worst-case loss in this market
```

`c` is part of the reserve, so with W ≤ L in every market and the buffers funded:
`reserve ≥ CREDIT outstanding + Σ_markets max(u_A, u_B)`. That is the public solvency check.

### 5.4 Buys in a batch

```
net_i = amount_i − fee(amount_i)
loop:
  X_A, X_B = Σ net per side ; p = price_A(q)                       // opening price
  k   = min(X_A / p, X_B / (1 − p))                                // complete sets: cost exactly k, price unchanged
  R_A = X_A − k·p ; R_B = X_B − k·(1 − p)                          // at most one is non-zero
  curve_s  = k + lmsr_buy(q + (k, k), s, R_s)
  shares_s = min(curve_s, X_s / ask_s)                             // guard: never cheaper than Polymarket
  if W after the batch > L: shrink the residual side pro-rata until W = L; the shrunk part is refunded
  avg_s = X_s / shares_s
  drop orders with avg_side > limit_i (refund in full); if any were dropped → loop
allocate: order i gets floor(net_i / avg_s) share-units; dust → house
u ← u + issued ;  c ← c + Σ amounts kept
```

### 5.5 Sells in a batch (after buys)

```
aggregate shares per side S_s
proceeds_s = min( C(q) − C(q − S_s·e_s),  S_s · bid_s )            // guard: never above Polymarket's bid
min-price check with the same drop-and-repeat loop; a dropped sell gets all its shares back as new slips
if W after the batch > L: shrink the sells pro-rata until W = L; unsold shares come back as new slips (from change_outputs[])
apply the 1% fee, allocate pro-rata as CREDIT
u ← u − S ;  c ← c − proceeds
```

**Why sells need the invariant too** (found in external review): selling removes cash `c` while the other side's shares stay outstanding.

Example with `L = 0.02`: users hold `u_A = u_B = 0.10`, and `c = 0.10` (complete sets, W = 0). Polymarket jumps and someone sells 0.10 A at 0.85.
- **Without the check:** `u_A = 0`, `u_B = 0.10`, `c = 0.015`, so W = 0.085 > L.
- **With the check:** only 0.0235 A sells (0.85 · S ≤ 0.02); the rest comes back as slips.

### 5.6 Determinism

- IEEE-754 `f64` only through the pure-Rust **`libm`** crate; no platform `exp`/`ln`, no fused multiply-add.
- Integer units at every boundary, rounding down.
- CI asserts that native and WASM builds of `blindbook-engine` produce byte-identical batch results.

### 5.7 Worked examples (b = 0.2, fee 1%)

| Case | Result |
|---|---|
| Polymarket mid 0.60, nobody has traded here | our A price = **0.6000** (equal to Polymarket) |
| Buy A with 0.05 (0.0495 after fee), ask 0.61 | 0.076785 shares at average **0.6447**; guard not binding; our price after: **0.6877** |
| Then Polymarket moves to 0.65 | our A price **0.7316**: we follow Polymarket, still shifted by our users' A position |
| Or Polymarket moves to 0.55 | our A price **0.6421** |
| House exposure after that buy | collected 0.0495 vs. 0.0768 payout if A wins → W = 0.0273, within the testnet buffer `L` = 0.05 |
| A 0.05 and B 0.01 in one batch (mid 0.60) | 0.024750 complete sets matched at 0.60; residual A moves the curve. A side average **0.6222**, B side **0.4000**, price after **0.6636**. Cost = paid = 0.059400 ✓ |
| Starting at 50/50 instead, while Polymarket says 0.90 | the first trader buys a ~0.90 share for ~0.50 and takes ~0.40 per share from the house. **This is why we never start at 50/50.** |

**Price impact versus `b`** (one buy, price 0.50 before):

| b | buy 0.005 | buy 0.01 | buy 0.05 |
|---|---|---|---|
| 0.05 | → 0.548 | → 0.591 | → 0.816 |
| 0.1 | → 0.524 | → 0.548 | → 0.697 |
| 0.2 | → 0.512 | → 0.524 | → 0.611 |
| 0.5 | → 0.505 | → 0.510 | → 0.548 |

## 6. "Called it" receipts

1. For trade request i, the client derives a secret `s_i` from the vault seed (NUT-13 style path, separate counter) and sends `tag_i = SHA256("bb-called-it" ‖ s_i)`.
2. The batch result in the public log lists `(tag_i, market_id, outcome, side, filled_units, avg_price_bp, height, batch_id)`. It's anchored on-chain with the bundle root.
3. **Proof** = `s_i`, optionally packed as `bbproof1:` + base64url(CBOR [s_i, height]) or a link that carries the proof after `#` (`https://…/#p=<…>`), so neither our servers nor link-preview bots ever receive it.
4. **Verification** happens in any browser (or the CLI): compute `SHA256("bb-called-it" ‖ s_i)`, find it in the log at `height`, check the bundle root against the on-chain anchor, show the fill.
5. **Revealing one proof says nothing about other trades:** every tag uses an independent secret.

## 7. Resolution and redemption

1. After the end date, the resolver polls the Polygon ConditionalTokens contract every 5 minutes on **two independent RPC providers**, which must agree:
   - `payoutDenominator(conditionId)` = `0xdd34de67`;
   - `payoutNumerators(conditionId, i)` = `0x0504c814`.
2. When the denominator is greater than 0: record the numerators, the Polygon block and the resolution tx hash. The market becomes **RESOLVED**.
3. A winning slip of `a` share-units pays `floor(a · num_i / den)` CREDIT units. A 50-50 result (`[1,1]`) pays half per share. Losing keysets become worthless.
4. Redemption never expires.

## 8. Public data (read path)

Every visitor downloads **the same files in the same order**, through the mixnet.

| File | Content | Refresh |
|---|---|---|
| `GET /v1/head` | `{height, seq, root, pow_bits}` | poll ~3 s |
| `GET /v1/live` | current prices (ours and the Polymarket reference) for all markets, plus the last 2 minutes of batch results | poll ~3 s |
| `GET /v1/snapshot/{seq}.json.gz` | full state: markets (labels, rules text, WebP thumbnails ≤ 4 KB), keyset ids, issuance log, spent set, house balance | first load, then cached |
| `GET /v1/delta/{seq}.json.gz` | one block's worth of batches: inputs (with tags), reference snapshots, results, issued `B_`/`C_`/DLEQ (shuffled), spent `Y`s, payouts, resolutions, anchors, public chain stats for the block (shielded action count, for Block Radio), `prev_root` | per block |

- `root = SHA256(prev_root ‖ SHA256(delta))`: a hash chain, anchored on-chain.
- Your own results arrive in the **response** within seconds. The bundle is for the public record, restore, proofs and verification.

## 9. Signer protocol

- **No inbound ports.** The signer opens a persistent outbound stream (WebSocket over TLS) to the API.
- **Independent verification.** It runs its own indexer and engine replica and **verifies every batch before signing**, including the exposure invariant. Signing takes milliseconds.
- **Supply guard:** if redemptions of any keyset would exceed what the signer itself issued, it halts all withdrawals and raises an alarm.
- **Scheduled work:** it builds sweeps, payouts and anchors as PCZTs, then proves, signs and broadcasts them.

## 10. Chain transactions

| Tx | From → to | Shape | Memo |
|---|---|---|---|
| Sweep | deposit account → reserve | matured top-up notes in, one note out | none |
| Payout | reserve → users (+ change) | always **8 Ironwood actions**: ≤ 7 recipients + change, padded with **zero-value outputs to throwaway addresses** (indistinguishable from real ones); recipient and padding outputs use `OvkPolicy::Discard` | none |
| Anchor | reserve → reserve (internal) | 2 actions | `bb1:anchor:<height>:<root-hex>` |
| Buffer funding | operator → reserve | | `bb1:buffer:<market_id>` |

Payouts go only to unified addresses with an Orchard-protocol receiver, checked by parsing with `zcash_address`.

## 11. Indexer rules

- Sync every compact block with the deposit viewing key.
- Watch the **full** mempool stream; trial-decrypt everything for SEEN.
- To classify a top-up (transparent inputs → EXPOSED; Sapling spends → AMOUNT VISIBLE), fetch **every** full transaction of every block, never only ours.
- Never request a single txid from third-party infrastructure.
- The signer runs its own indexer the same way.
- Mainnet option: self-hosted Zebra + Zaino.

## 12. On-disk state (SQLite)

`markets`, `topups` (diversifier index ↔ request), `deposits`, `batches`, `snapshots`, `issuance`, `spent`, `withdrawals` (commitment, sealed blob until broadcast, status, txid; **no plaintext address**), `anchors`, `house_ledger`.
No table, log or metric ever contains an IP, user agent or plaintext payout address. The boot-time self-check refuses to start a service with access logging enabled.
