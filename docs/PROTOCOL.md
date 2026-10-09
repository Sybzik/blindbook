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
| top-up address lifetime | 120 blocks (~2.5 h) | later payments are still credited. Shown as a ZIP 316 Revision 0 unified address (`u1…`, testnet `utest1…`) with only an Orchard-protocol receiver, because wallets that predate Revision 2 (`zu1…`) may refuse the newer form |
| **trade batch window** | **2 s** | all trade requests in a window clear together |
| anchor | **lower median** of the Polymarket mid samples of the last **30 s** | spoof-resistant; lower median so the verifier reproduces it exactly |
| guard depth | the average price to **buy / sell a fixed number of shares `Q`** of each outcome on Polymarket's book, recorded per market at listing (default **500 shares**); whatever the book can't fill is priced at 1.00 (buy) or 0.00 (sell) | ignores dust orders; deterministic and exactly mirrored between the two outcomes (ask_A = 1 − bid_B); a thin book makes the guard stricter, never undefined. On Oct 7, across 49 open pre-match markets in the listing band, the 500-share price was at the top of the book in the median case and within 0.94¢ of it for 90% of them |
| reference staleness limit | the feed is **unhealthy for more than 10 s**: connection down or silent for 6 s (PING every 3 s), no `book` snapshot since connecting, or a local book that disagrees with the best prices Polymarket attaches to each change (or is crossed) | a quiet market is not stale: many markets go minutes without a price change (`spikes/e-polymarket`) |
| trade fee | 100 bp of buy amount; 100 bp of sell proceeds | goes to the house balance (published) |
| max trade size | per market: `L_m` × 4 of notional | keeps single trades small relative to the buffer |
| withdrawal fee | 20,000 zatoshi | |
| payout batch | every block while the queue is non-empty | fixed 8-action shape |
| withdrawal privacy delay | uniform random 0–60 s, client-side | before sending, from the separate top-up/withdrawal tunnel |
| sweep | every 48 blocks (~1 h), only if there are deposits | |
| anchor tx | every `BB_ANCHOR_EVERY` blocks (default 48, about an hour), only when the log root has changed since the last anchor | each costs 0.0001 ZEC |
| PoW difficulty | top-up, voucher, withdraw: **20 bits**; trade, swap, redeem: 16 bits (published in `head`) | trades also spend valid slips, so they need little PoW and stay fast. Measured with a WASM SHA-256 on one desktop thread: 16 bits ≈ 35 ms median, 20 bits ≈ 0.5 s (2.1 s p95); the client solves in 2–4 workers |
| connection policy | a fresh TCP+TLS connection per write (the API sends `Connection: close`; TLS session resumption off); the next poll opens the connection the next write uses | see §4 |
| LMSR `b` | per market: testnet 0.2 TAZ, mainnet 0.01 ZEC | how strongly our users' flow moves our price |
| exposure buffer `L_m` | per market: testnet 0.05 TAZ, mainnet 0.002 ZEC | the house's maximum loss in that market, covered by the reserve. Every market of a network has the same parameters; the signer refuses a listing with others |
| listing rules | Polymarket mid ∈ [0.10, 0.90], a deep book, an event start still ahead, an end before judging ends | checked by the API on the live book ([MARKETS.md](MARKETS.md#listing)) |

Rounding (normative): share and credit amounts round **down** to whole units. Every remainder goes to the house balance and is logged.

**Reference snapshot (normative).** Each batch records, for every market with orders, the reference it priced from (`RefSnapshot` in `crates/blindbook-ledger/src/reference.rs`, taken by `crates/blindbook-polymarket`):

| Field | Meaning |
|---|---|
| `at_ms` | Unix ms of the snapshot |
| `mid_samples` | outcome A's top-of-book mid `⌊(best bid + best ask) / 2⌋` in ppm, sampled once a second over the last 30 s while the feed was healthy, oldest first |
| `mid_ppm` | the anchor: lower median of `mid_samples` (0 if there are none, which halts the market) |
| `ask_ppm[2]`, `bid_ppm[2]` | the guard: average price to buy / sell `guard_micro` shares of each outcome, rounded up / down to ppm |
| `guard_micro` | `Q` in micro-shares |
| `best_bid_ppm[2]`, `best_ask_ppm[2]`, `server_ts_ms[2]` | top of book and Polymarket's timestamp of the last book event, for auditors comparing with Polymarket's price history |
| `unhealthy_ms` | how long the feed has been unhealthy (0 = healthy); above 10,000 the market halts |

Prices are parsed exactly from Polymarket's decimal strings (no floats), so the verifier recomputes `mid_ppm` from `mid_samples` bit for bit.

## 2. Keys and keysets

- **Mint master key:** secp256k1 secret `m`, held by the signer. `M = m·G` is **pinned in the app build** and in the repository.
- **Keysets:** one per (market, outcome ∈ {A, B}), plus one global CREDIT keyset. Each has one key per denomination k = 0..30.
- **Derivation (normative), non-hardened, so the browser can derive public keys itself:**
  ```
  t      = SHA256("blindbook/keyset/v1" ‖ M ‖ market_id ‖ outcome_index ‖ k)  mod n
  secret = m + t        (signer only)
  public = M + t·G      (anyone)
  ```
  `market_id` = 32-byte Polymarket `conditionId`; CREDIT uses 32 zero bytes. **Byte encoding (normative):** the 86-byte preimage is `"blindbook/keyset/v1"` (19 ASCII bytes) ‖ `M` as a 33-byte compressed point ‖ `market_id` 32 bytes ‖ `outcome_index` 1 byte (CREDIT: `0xFF`) ‖ `k` 1 byte; all fields have fixed length, so plain concatenation is unambiguous.
- **Keyset ids** are Cashu NUT-02 **v01** ids (`01` + 32 bytes; unit `bb-share` for outcome keysets, `bb-credit` for CREDIT; input fee 0; no expiry), so `cashu-ts` NUT-13 derivation (the HMAC variant) works unchanged and restore is 5× faster than with v00 ids. The derivation, the ids and signatures made with `m + t` are byte-identical between the signer (`cashu` crate) and the browser (`cashu-ts`), verified in `spikes/d-blind`.
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
- **Zero-query restore (normative client behaviour):** derive `B_` for counters 0..n per keyset (stopping after 96 unused counters in a row), find them among the signatures the public log published, unblind, and drop those whose `Y` the log lists as spent. The same pass finds the trade history by the CALLED IT tags (§6). The log is the same set of files every verifier downloads (§8). **No restore request is ever sent.**
- **Transfer format:** `bbslip2:` + base64url(CBOR [[keyset_id, [[amount, x, C], …]], …]), slips grouped by keyset, with the id, a hex secret `x` and `C` as bytes so a QR stays readable (the older `bbslip1:` list of `[keyset_id, amount, x, C]` text entries is still read), also as a QR code. The recipient swaps it immediately so the sender can't spend it twice.
- **Handed-over codes and paper slips:** the same `bbslip2:` payload, as text, a QR on screen, or printed on a receipt-width page (black on white). The slips leave the vault when the code is made; the code stays in the vault's outbox, so the issuer can take it back (a swap of its own code) until someone else swaps it first. Importing **swaps at once** (new secrets, new signatures), so a code or a paper slip is void after import, and a photographed copy is worthless once imported.

## 4. Requests (browser → API, always over the mixnet)

- **Proof-of-work:** every POST carries `pow = {nonce}`. `SHA256("bb-pow-v1" ‖ SHA256(canonical_body) ‖ nonce)` must have at least D leading zero bits (D per endpoint, §1). Canonical body = RFC 8785 JSON.
- **Connection discipline (normative):**
  - **mix-fetch allows one tunnel per JavaScript realm** (`setupMixTunnel` once; after `disconnectMixTunnel` that realm can't open another). So **every tunnel lives in its own hidden same-origin frame**, the main one included: the main tunnel carries browsing, reads and trades; a stuck tunnel is replaced by a new frame, with no page reload. The app talks to each frame over its own `MessageChannel`, handed over when the frame has loaded.
  - **The mixnet worker has an opaque origin (normative):** a worker started from a blob of the app's origin would make the browser add `Origin: <the app's site>` to the client's requests to Nym's directory API and to its WebSocket to the entry gateway. So the worker starts from a `data:` URL (an opaque origin: the browser sends `Origin: null`) whose only line imports the worker's code from the app's own host (`assets/nym-worker-<hash>.js`, built from mix-tunnel's inlined worker). An opaque origin has no IndexedDB, so that code begins with an in-memory one. The tunnel frame's CSP names the app's origins explicitly, because Safari reads `'self'` in an opaque-origin worker as that opaque origin.
  - **Boot races two tunnel frames** and keeps the first that answers `GET /v1/head` within 20 s; the other is destroyed. About a third of randomly chosen mixnet routes come up "ready" and never answer, and a healthy one can take 3–20 s for its first request (`spikes/a-mixnet`). mix-fetch has no request timeout, so **every request carries an app-level deadline** and a failing tunnel is replaced while the lamp shows RELINKING. Linking runs **once at a time**: requests made meanwhile wait for the same attempt, and a failure on a tunnel that has already been replaced changes nothing. A failed round waits 2 s, twice as long after each further failure, up to a minute; after three the app tells the user the network seems to block the mixnet. A browser without WebAssembly doesn't try at all.
  - **Writes never share a connection:** the API answers every POST with `Connection: close`, and the TLS terminator disables session tickets and resumption, so each write rides a new TCP+TLS connection inside the tunnel. The regular `/v1/live` poll then opens the next connection, which the next write reuses, so the handshake (about 2 s inside the mixnet) stays off the bet's path.
  - **Top-ups and withdrawals use a separate mixnet identity:** each runs in a hidden same-origin frame that sets up **its own tunnel** (a different mixnet client; two race, as at boot). A top-up keeps its frame until it is credited or its address expires, and its status is polled only through it (a cage whose route stops answering is replaced by a fresh one: a new identity, never the betting one); a withdrawal gets a fresh frame, destroyed afterwards, after a random 0–60 s delay.
  - **One mixnet identity per tunnel, never reused (normative):** mix-fetch keeps its client identity (keys, gateway registration) in IndexedDB under `wasm-client-storage-<clientId>`. Here that IndexedDB is the in-memory one inside the tunnel's own worker, so the identity exists only while its frame does and never reaches the disk. Every tunnel also gets a random `clientId` and `storagePassphrase`: the main tunnel a new one on every page load (and on every replacement), the cage frame a new one for every top-up or withdrawal. Identities an older build stored on disk are deleted at boot. Two tunnels never load the same identity, and no identity outlives its frame.
  - **No HTTP compression through the tunnel:** mix-fetch requests `Accept-Encoding: identity` (its WASM has no decompressor). The public log and the price history are served as `.gz` files and decompressed by the app (`DecompressionStream`).
  - **Verified in `spikes/a-mixnet` (Oct 6 and Oct 9):** a frame gets an independent tunnel with its own identity and exit IP, also while another tunnel runs; tunnel setup 10–14 s; a warm request ≈ 0.9 s, a fresh TCP+TLS request ≈ 3 s. The production build links in 6–9 s in Chromium, Firefox and WebKit, with every request to Nym's directory and every gateway WebSocket carrying `Origin: null`, and the API side seeing only mix-fetch's fixed headers from an exit's address. Still to measure against our own API: the poll-then-write pattern (target bet p50 ≤ 3 s).
  - **If a fresh connection per write is too slow:** bets within one session may share a keep-alive connection (linkable only to each other, never to top-ups or withdrawals; residual N11).

| Endpoint | Body | Executes | Returns |
|---|---|---|---|
| `POST /v1/topup` | `amount_zat` (a top-up denomination), `credit_outputs[]`, `claim_hash = SHA256(topup_secret)` | on SEEN (within 0-conf caps) or 1 confirmation | `{topup_id, address, expires_height}`; the same request again answers the same address (idempotent by `claim_hash`) |
| `GET /v1/topup/{id}` | | | `{status: awaiting / seen / credited / confirmed, privacy: SHIELDED / AMOUNT_VISIBLE / EXPOSED, paid_zat, signatures[]}` |
| `POST /v1/trade` | `inputs[]` (CREDIT slips for a buy, position slips for a sell), `market, side (buy/sell), outcome (0/1), limit_bp, amount, outputs[], change_outputs[], tag` | next 2 s batch | `{batch_id, fill: {tag, status, kept, out, fee, refund, avg_price_bp}, signatures[], stored_record}` |
| `POST /v1/swap` | `inputs[], outputs[]` (same keyset, equal sum) | immediately | `{signatures[], stored_record}` |
| `POST /v1/redeem` | `inputs[]` (a resolved outcome's keyset), `outputs[]` (31 blank CREDIT outputs) | immediately after resolution | `{paid, signatures[], stored_record}` |
| `POST /v1/withdraw` | `inputs[]` (CREDIT), `amount` (units, a standard denomination, THREAT_MODEL X6), `change_outputs[]`, `address_sealed` (`bbseal1:`, sealed to the signer's pinned X25519 key; format in `crates/blindbook-seal`), `address_commitment = SHA256(address ‖ salt)` | next payout block | `{signatures[] (change), stored_record}`; payout shown in the log as `PayoutSent {txid, commitments}` |
| `POST /v1/topup/claim` | `topup_id, topup_secret, credit_outputs[]` | immediately | extra or late payments to an already-credited top-up address |
| `POST /v1/voucher` | `code, outputs[]` | immediately | judge vouchers: a single-use code exchanged for CREDIT slips. The signer knows `SHA256` of its canonical form: letters and digits only, uppercase, O→0, I/L→1 (`ops::voucher_hash`), so a code typed by hand still matches |
| `POST /v1/duel/open`, `/take`, `/cancel` | see §7.1 | immediately | `{signatures[], stored_record}` |

- Output counts are capped at 32 per keyset per request; a request spends at most 64 slips.
- **Trades pay from any slips:** `amount` (CREDIT units for a buy, share-units for a sell) may be less than the inputs' total, and the rest comes back on the change outputs in the same answer, so a bet never waits for a swap to exact change. The public log records `amount`, not the slips' denominations.
- **Blank outputs for trades (normative):** the client can't know in advance how a trade fills, so `/v1/trade` carries blinded outputs **without amounts** for both possible results (as in Cashu NUT-08); the signer picks each used output's denomination and returns it with the signature and DLEQ.
  - **buy:** `outputs[]` in the outcome's position keyset (shares bought), `change_outputs[]` in CREDIT (refunds: limit, halt, the part shrunk by the invariant);
  - **sell:** `outputs[]` in CREDIT (proceeds), `change_outputs[]` in the **same position keyset** (shares that didn't sell: limit, halt, the part shrunk by the invariant).
  - Each list always holds **31** blank outputs, enough for any amount below 2³¹ units, so every trade request has the same shape. Unused outputs are never signed, and zero-query restore skips them (gap limit 96 counters).
- **P600 transparency:** every write response includes `stored_record`, the exact row the server stored for that request (batch, tag, market, outcome, side, size, price, height). The app keeps these in the vault and shows them on P600, with no extra request.
- **API-side validation:** PoW, schema, and inputs not already spent or pending; the signer then checks every slip's signature (§9).
- **Bounded work:** a batch takes at most 500 trade requests and the top-up desk holds at most 500 open (unpaid, unexpired) requests; beyond that the answer is `429 busy`, which spends nothing. An unpaid request drops its blank outputs a day after expiry; a payment that still arrives is claimed with `/v1/topup/claim`. Proof-of-work can be replayed, so every write is either one-time (it spends slips or a code) or idempotent (top-ups).
- **Requests in doubt (normative client behaviour):** a 4xx is a refusal before anything was spent. No answer, or a 5xx, may still have been processed (the API can replay an operation the signer applied while the link was down). The wallet records every spending request before it leaves (its inputs and its output counter ranges) and holds those slips back until it knows: it reads the deltas published after the request left, the same files every verifier reads, and settles it as done when it finds signatures on its own `B_` or its inputs' `Y` spent, or as never processed after 3 blocks without either. The server can't tell which outputs a reader looks for.
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
- no valid reference: a mid, bid or ask outside (0, 1];
- the reference feed unhealthy for more than 10 s (connection down or silent, no snapshot, or a local book that disagrees with Polymarket's own best prices; not "no price change").

Halted requests are refunded in full: a buy as CREDIT, a sell as its own shares (new position slips from `change_outputs[]`).

### 5.3 The exposure invariant (holds after every batch)

```
W = max(u_A, u_B) − c  ≤  L          // the house's worst-case loss in this market
```

`c` is part of the reserve, so with W ≤ L in every market and the reserve covering the buffers, the reserve covers every payout. The public solvency check (§8) compares the reported reserve with `CREDIT outstanding + Σ_markets max(u_A, u_B) + queued withdrawals + open duel stakes`, all computed from the log.

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
  drop the violators with the worst limit on each side (refund in full); if any were dropped → loop
    (an order is refunded only if it would still violate after every worse-limited order on its side is gone)
allocate: order i gets floor(net_i / avg_s) share-units; dust → house
u ← u + issued ;  c ← c + Σ net amounts kept                     // fees and rounding dust go to the house ledger
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
- **Without the check:** the curve pays 0.0814 (below 0.10 · 0.85, so the curve binds, not the bid), leaving `u_A = 0`, `u_B = 0.10`, `c = 0.0186`, so W = 0.0814 > L.
- **With the check:** only 0.02375 A sells (W ends exactly at L); the rest comes back as slips.

(Recomputed with the reference engine in `spikes/f-engine`.)

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

Assumptions: the A + B row assumes a zero-spread book (ask_B = 1 − 0.60); with a real 0.59 / 0.61 book B's guard binds, B pays 0.41 and the price after is 0.6643. Share counts are exact values; in whole units they round down (0.07678). All values recomputed in `spikes/f-engine`.

**Price impact versus `b`** (one buy before the 1% fee, price 0.50 before):

| b | buy 0.005 | buy 0.01 | buy 0.05 |
|---|---|---|---|
| 0.05 | → 0.548 | → 0.591 | → 0.816 |
| 0.1 | → 0.524 | → 0.548 | → 0.697 |
| 0.2 | → 0.512 | → 0.524 | → 0.611 |
| 0.5 | → 0.505 | → 0.510 | → 0.548 |

## 6. "Called it" receipts

1. For trade request i, the client derives a secret `s_i` from the vault seed (NUT-13 style path, separate counter) and sends `tag_i = SHA256("bb-called-it" ‖ s_i)`.
2. The batch result in the public log lists `(tag_i, market_id, outcome, side, filled_units, avg_price_bp, height, batch_id)`. The root of the log that contains it is anchored on-chain.
3. **Proof** = `s_i`, optionally packed as `bbproof1:` + base64url(CBOR [s_i, height]) or a link that carries the proof after `#` (`https://…/#p=<…>`), so neither our servers nor link-preview bots ever receive it.
4. **Verification** happens in any browser (or the CLI): compute `SHA256("bb-called-it" ‖ s_i)`, find it in the log the browser downloads and checks (hash chain, signatures), and show the fill. The command-line verifier with `--chain` also checks that each on-chain anchor names the log's root.
5. **Revealing one proof says nothing about other trades:** every tag uses an independent secret.

## 7. Resolution and redemption

1. For every open market (a result is final as soon as it is on Polygon, often days before the end date), the API's resolver polls the Polygon ConditionalTokens contract every 5 minutes on **two independent RPC providers**, which must agree:
   - `payoutDenominator(conditionId)` = `0xdd34de67`;
   - `payoutNumerators(conditionId, i)` = `0x0504c814`.
2. When the denominator is greater than 0 on both: the API proposes `resolve {market, den, num, polygon_block, polygon_tx}`. **The signer reads the result itself** (once a minute, its own pair of RPCs, `BB_POLYGON_RPCS`) and refuses a resolution that doesn't match it, so the internet-facing API can't settle a market its own way. Once applied, the market is **RESOLVED** and the log records the numerators, the Polygon block and the resolution transaction; `blindbook-verify --polygon public` reads each one from Polygon again.
3. A redeem request of `a` share-units of outcome i pays `floor(a · num_i / den)` CREDIT units. A 50-50 result (`[1,1]`) pays half per share. Losing keysets become worthless.
4. Redemption never expires.

### 7.1 Blind duels

A challenge between two people who never learn who the other is, with no house on either side.

| Step | Request | What happens |
|---|---|---|
| Open | `POST /v1/duel/open {duel, market, outcome, shares, price_bp, inputs[], change_outputs[], outputs[], cancel}` | `duel` is 32 random bytes from the challenger; `cancel = SHA256(secret)`. The stake `ceil(shares · price_bp / 10 000)` CREDIT is spent into escrow, the rest returns on `change_outputs`; the 31 blank `outputs` (the challenger's outcome keyset) wait with the offer. `price_bp` 100–9 900, `shares` 1–10 000 000. Log: `duel_opened {duel, market, outcome, shares, price_bp, stake}` |
| Take | `POST /v1/duel/take {duel, outcome, shares, price_bp, inputs[], outputs[], change_outputs[]}` | The taker restates the terms they saw (refused with `duel_terms` if they differ) and pays `shares − stake`. In one operation: `shares` of the other outcome on the taker's `outputs`, the change, and `shares` of the challenger's outcome on the outputs left at opening. Log: `duel_taken {duel}`; all the signatures are in the delta |
| Cancel | `POST /v1/duel/cancel {duel, secret, outputs[]}` | Only while untaken; the stake returns as CREDIT. Log: `duel_cancelled {duel}` |

- **A complete set.** `shares` CREDIT in (stake + the taker's part), `shares` of each outcome out; whichever wins pays exactly `shares`. The pool and the exposure invariant are untouched: the house neither wins nor loses. No fee.
- **Trading window.** Opening and taking need the market open (the live state, so Polymarket's own halts count) and the time before the event start and the end date; the signer refuses a time more than two minutes from its own clock. Cancelling works any time.
- **How the challenger gets their shares without asking.** The taker's answer carries only the taker's signatures. The challenger's are in the public log like every issuance, and `/v1/live` lists open duels and the challenger signatures of duels taken in the last 30 minutes, the same JSON every visitor polls; the challenger's browser picks its own by output index. After 30 minutes it finds them by its own `B_` in the deltas, which anyone can download.
- **Solvency.** Stakes of open duels are liabilities until taken (then they are shares) or cancelled (then CREDIT); the verifiers add them from the log's duel events.
- **Links.** `#d=<duel id>` after the `#`, so it never reaches a server; the app clears it from the address bar on arrival.

## 8. Public data (read path)

Every visitor downloads **the same files in the same order**, through the mixnet.

| File | Content | Refresh |
|---|---|---|
| `GET /v1/head` | `{height, seq, root, pow_bits, halted}` | poll ~15 s |
| `GET /v1/live` | for every market: state and halt reason, our price, the Polymarket reference; the last 2 minutes of fills; the last chain block with its shielded action count; payouts of the last 30 minutes with the withdrawal commitments they paid; open duels and the challenger signatures of duels taken in the last 30 minutes. About 260 bytes per market | poll ~3 s |
| `GET /v1/markets` | the catalog: question, outcome labels, Polymarket's rules, resolution source, schedule, keyset ids, status | poll ~30 s |
| `GET /v1/history.json.gz` | every market's price history, ours and Polymarket's mid, in basis points: one-minute samples for 2 h, 15-minute for a week, 2-hour since listing | poll ~5 min |
| `GET /v1/segment/{k}.jsonl.gz` | deltas `384k + 1 … 384k + 384`, one per line, each byte for byte as in `delta/`; written once the last of them exists | read once, then cached |
| `GET /v1/reserve.json` | the reserve's public full viewing key, its birthday height and the network | once |
| `GET /v1/delta/{seq}.json.gz` | one block's worth of batch records (per market: parameters, schedule, reference snapshot, pool before, orders with tags, halt, fills, pool after), issued `B_`/`C_`/DLEQ **sorted by `B_`**, spent slips `{Y, keyset, amount}` **sorted by `Y`** (so anyone can compute what is outstanding per keyset), events (market listed, top-up credited, voucher redeemed, redeemed, withdrawal queued, payout sent, swept, resolved, anchored, reserve reported, duel opened / taken / cancelled), public chain stats for the block (shielded action count, for Block Radio), `prev_root` | per block |

- `root = SHA256(prev_root ‖ SHA256(canonical JSON of the delta))` (RFC 8785; the first delta's `prev_root` is 32 zero bytes): a hash chain, anchored on-chain. Sorting issued signatures and spent `Y`s means their order inside a block says nothing about which request they came from. Types and the builder: `crates/blindbook-ledger`.
- **What the verifier replays:** every batch record carries everything `clear_batch` needs (parameters, schedule, reference, pool before, orders), so anyone can recompute the fills and the pool after, check that each market's pool after equals its pool before in the next batch, recompute each anchor from its samples, and check the chain of roots against the on-chain anchors.
- **Solvency.** The signer reports the reserve into the log (`reserve_reported {height, reserve_zat, unswept_zat}`) whenever it changes and at least every 48 blocks. At each report the verifier computes the liabilities from the log itself: CREDIT outstanding, per open market `max(outstanding A, outstanding B)` (only one outcome wins; a 50-50 pays half of each, which is less), per resolved market `Σ outstanding × num / den`, plus withdrawals queued and not paid yet, at 1 000 zatoshi per unit. It fails if `reserve + unswept < liabilities`. The reserve account's full viewing key is public, so the reported figure can be checked on-chain; top-ups not swept yet are reported apart (each one is already public as `topup_credited`).
- **Reading the log.** Clients read whole segments where they exist and the newest deltas one by one, a few requests at a time: the browser verifier, restore and duel recovery read the same files in the same way, so a reader's requests say nothing about what it is looking for. At one block every ~25 s (NU7; 75 s before it), a month is about 104,000 deltas, which is 270 segment requests.
- Your own results arrive in the **response** within seconds. The log is for the public record, restore, proofs and verification.

## 9. Signer protocol

- **No inbound ports.** The signer opens a persistent outbound stream (WebSocket over TLS) to the API's `/v1/signer`, authenticated with a bearer token (≥ 32 characters).
- **One operation at a time, one order (normative).** The API's sequencer puts every state change (list market, trade batch, swap, redeem, credit, withdraw, duel open / take / cancel, resolve, block close, recorded treasury event) in one order and sends each to the signer: `{"id", "op"}` → `{"id", "reply": {"invalid", "signatures"}}`. Both sides apply it to their own ledger replica with the same `ops::apply`, leaving out the requests the signer found invalid (`invalid`), so the replicas never diverge; the API checks the signatures line up with its own sign jobs and halts if they don't (`crates/blindbook-ledger/src/ops.rs`).
- **Independent verification.** It runs its own indexer and engine replica and **verifies every operation before signing**: each spent slip (`Y` matches the secret, `C = k·hash_to_curve(x)` for its keyset and amount), each blinded output (a curve point), each top-up claim against its own indexer, each voucher against its own list, each duel's time against its own clock, the exposure invariant; a listing must carry the network's parameters, and a resolution must match the result the signer read from Polygon itself (§7). Signing takes milliseconds.
- **Hello and step check.** On connect the signer sends `{"hello": {"m", "applied"}}`. The API admits it only with the pinned `M` and the same number of applied operations.
- **A lost answer is applied exactly once.** If the link drops after an operation was sent but before its answer, the API keeps that operation in doubt, admits the signer one operation ahead, and re-sends it before anything else; the signer recognises the repeat (digest of the redacted operation, kept in its journal with the reply) and answers from its cache. Tested in `crates/blindbook-api/tests/remote.rs`.
- **Journals hold no spendable secret.** Both sides keep an append-only journal (fsynced before any answer leaves) and rebuild their state from it after a restart; spent slips are written with their secret and `C` replaced by placeholders (`ops::redact`), keeping only `Y`, keyset and amount.
- **Supply guard:** if redemptions of any keyset would exceed what the signer itself issued, it halts all withdrawals and raises an alarm.
- **Scheduled work:** it builds, proves, signs and broadcasts sweeps, payouts and anchors itself: it holds the keys and runs its own indexer, so no PCZT round trip is needed (PCZT stays the path for a future FROST setup).

## 10. Chain transactions

| Tx | From → to | Shape | Memo |
|---|---|---|---|
| Sweep | deposit account → reserve | matured top-up notes in, one note out | none |
| Payout | reserve → users (+ change) | always **8 Ironwood actions**: ≤ 7 recipients + change, padded with **zero-value outputs to freshly generated throwaway addresses** (indistinguishable from real ones); recipient and padding outputs use `OvkPolicy::Discard`; ZIP 317 fee 0.0004 ZEC. Verified on testnet (`spikes/g-payout`): 8 actions, and the sender's full viewing key sees only the change | none |
| Anchor | reserve → reserve (internal) | 2 actions | `bb1:anchor:<height>:<root-hex>` (the signer's own root, §9); each root is anchored once. The reserve's viewing key opens it, which is how the verifier checks it |
| Split | reserve → reserve | the payout shape (7 equal outputs to fresh reserve addresses + change, OVK discarded), whenever fewer than 3 reserve notes are spendable, so payouts and anchors never wait for each other's change | none |
| Buffer funding | operator → reserve | an ordinary shielded payment to the reserve address `blindbook-signer init` prints | optional |

Payouts go only to unified addresses with an Orchard-protocol receiver, checked by parsing with `zcash_address`.

- **Deposit and reserve are separate accounts** of one seed (ZIP 32 accounts 0 and 1): the API holds only the deposit account's incoming viewing key, and the reserve's full viewing key can be published for the solvency check without revealing any single top-up, because deposits reach the reserve only through sweeps.
- **Never paying twice (normative for the signer):** a payout is built and stored by the wallet, its txid and the withdrawals it pays are written to disk, and only then is it broadcast; after a restart the in-flight payouts are re-broadcast (harmless) and re-reported. A withdrawal leaves the queue only when its `PayoutSent` event is recorded in the log.
- **The address is checked before the CREDIT is spent:** the signer opens the sealed address and checks it against the commitment, the network and the Orchard receiver while it checks the slips; a withdrawal it couldn't pay is refused and spends nothing.
- **Confirmations:** the wallet spends its own notes after 1 confirmation and received notes (deposits, buffer funding) after 3.
- **Measured on testnet (Oct 7):** a withdrawal to a sealed address was paid in the next payout, 8 Ironwood actions (tx `948d5136…`); two withdrawals made back to back went out together in one payout (`80d88933…`); the signer anchored its own log root (`ef070d78…`), and `blindbook-verify --chain` later found an anchor of a fresh log on-chain (`775009d6…`) naming that log's root, and the reserve at 0.1380 TAZ. Implementation: `crates/blindbook-treasury`, `crates/blindbook-signer/src/payouts.rs`, `crates/blindbook-seal`.

## 11. Indexer rules

- Sync every compact block with the deposit viewing key.
- Watch the **full** mempool stream (`GetMempoolStream` returns full transactions); trial-decrypt everything for SEEN. On testnet a payment was SEEN 0.9 s after the wallet's broadcast (`spikes/c-deposits`).
- Request compact blocks with **all pool types**: they carry transparent inputs and Sapling spends, so a top-up is classified (transparent inputs → EXPOSED; Sapling spends → AMOUNT VISIBLE) without fetching any single transaction. Verified: classification from compact data matched full transactions for 162/162 testnet transactions, at 40 KB per 100 blocks instead of 333 KB.
- The indexers never request a single txid from third-party infrastructure. (The command-line verifier does fetch the anchor transactions named in the public log: the operator's own transactions, never a user's; THREAT_MODEL N14.)
- **Crediting (normative):** a payment is credited as `floor(value_zat / 1000)` CREDIT units onto the request's blank outputs, on SEEN if it is within the 0-conf caps, otherwise when mined. The API's indexer proposes it; the signer credits only a payment its **own** indexer (full viewing key) has seen, applies the same caps itself, and never credits a txid twice. The first payment to an address uses the request's outputs; any later payment is claimed with `topup_secret` onto fresh outputs (`POST /v1/topup/claim`). Implementation: `crates/blindbook-indexer`, `crates/blindbook-api/src/topup.rs`.
- **Measured on testnet (Oct 7):** 0.05 TAZ credited **1.6 s** after the paying wallet's broadcast returned (mempool SEEN, both indexers); a payment mined while the API was down was credited 1 s after restart from the block range.
- The API needs only the deposit account's incoming viewing key (UIVK) for detection; the full viewing key stays with the signer.
- The signer runs its own indexer the same way.
- Mainnet option: self-hosted Zebra + Zaino.

## 12. On-disk state

The ledger state is not a database: it is the replay of an append-only journal (`journal.jsonl` on the API, `signer-journal.jsonl` on the signer; see §9), and the public log files are written from the same replay. The price history (`history.json`) holds only public prices. Top-up requests and deposits (diversifier index ↔ request) and payout status are kept by the indexer and the signer next to their journals. Withdrawals keep only the commitment, the sealed blob until broadcast, status and txid; **no plaintext address**.
No table, log or metric ever contains an IP, user agent or plaintext payout address. The API's log filter switches the HTTP stack's logging off whatever the configuration says, and `crates/blindbook-api/tests/no_logs.rs` fails if the code ever reads a client address or a proxy header or adds request tracing.
