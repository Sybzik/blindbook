# Deploying Blindbook

Two servers and a static host. The public server holds no secret; the private one holds every key and opens no port.

| Where | Runs | Files |
|---|---|---|
| **VPS-1, public** | `blindbook-api`, Caddy (TLS), Tor (the .onion mirror) | [`api/`](api) |
| **VPS-2, private** | `blindbook-signer` | [`signer/`](signer) |
| **Static host** | the web app, built with the deployment's own keys | [`web/build.sh`](web/build.sh) |

What the configuration guarantees, and where:

- **No request is logged.** The API switches its HTTP stack's logging off whatever `RUST_LOG` says, and a test fails if it ever reads a client address or a proxy header. Caddy runs without an access log (none is configured) and strips forwarding headers before the API.
- **Writes never share a TLS connection** (THREAT_MODEL N11): Caddy answers every POST with `Connection: close` and has TLS session tickets disabled (`apps.tls.session_tickets.disabled`), which turns off resumption for TLS 1.2 and 1.3.
- **The signer has no inbound port.** It dials `wss://<api>/v1/signer` with a bearer token; the API admits it only with the pinned `M` and the same number of applied operations.
- **The app pins the deployment's keys.** A mixnet or .onion build refuses to build without `M` and the seal key, and refuses to run with the development test keys.
- **No CORS headers are needed:** mix-fetch makes the request inside its own WASM network stack, so the browser's CORS rules don't apply, and the API allows no cross-origin browser access.

## 1. Before you start

- A domain: one host name for the API on VPS-1 (`api.example.org`) and one for the app on the static host (`example.org`). Point the API name's A record at VPS-1.
- Two VPS with Docker (Compose v2), ideally from different providers. VPS-1 needs ports 80 and 443 open; VPS-2 needs nothing open (SSH by key only).
- Check that VPS-1 can read Polymarket: `curl -s 'https://gamma-api.polymarket.com/markets?limit=1'` must return JSON.
- On testnet, about 2 TAZ for the reserve (market buffers and judge codes; see [ROADMAP](../docs/ROADMAP.md#operating-budget-lean)).

## 2. Build the image (on both servers)

```sh
git clone <repository> blindbook && cd blindbook
docker build -f deploy/Dockerfile -t blindbook:latest .
```

The image holds `blindbook-api`, `blindbook-signer` and `blindbook-verify`, built from the locked dependencies, and runs as an unprivileged user (uid 10001).

## 3. Keys (on VPS-2)

```sh
cd deploy/signer
cp signer.env.example signer.env        # fill in BB_API_URL and BB_SIGNER_TOKEN (below)
mkdir -p secrets data && sudo chown -R 10001:10001 secrets data && sudo chmod 700 secrets

docker compose run --rm signer blindbook-signer keygen /secrets/master.key
docker compose run --rm signer blindbook-signer init /secrets/treasury tip
docker compose run --rm signer blindbook-signer vouchers 30 /secrets/voucher-codes.txt /secrets/voucher-hashes.txt
openssl rand -hex 32                     # the signer token: put it in signer.env and api.env
```

- `keygen` prints **M**, the mint master public key: it goes into `api.env` and into the app build.
- `init` creates the seal key and the treasury seed, and prints the **seal public key** (app build), the **deposit UIVK** (VPS-1), the **reserve UFVK** and its **birthday** (VPS-1, published for the solvency check) and the **reserve address** (to fund). It also writes `secrets/treasury/reserve-ufvk.txt`.
- `vouchers` writes the judge codes (`voucher-codes.txt`: give these out, they are bearer credit) and their hashes (`voucher-hashes.txt`: the only thing the signer keeps).
- **Back up `secrets/` offline and encrypted** (the master key, the treasury seed and wallet, the seal key). Losing it loses the reserve; leaking it loses everything.

## 4. VPS-1: the API

```sh
cd deploy/api
cp api.env.example api.env               # BB_SITES, BB_M, BB_SIGNER_TOKEN, BB_RESERVE_BIRTHDAY, BB_VOUCHER_UNITS
mkdir -p config data && sudo chown -R 10001:10001 data
# config/deposit-uivk.txt : the deposit UIVK printed by init
# config/reserve-ufvk.txt : secrets/treasury/reserve-ufvk.txt from VPS-2
# config/markets.json     : the markets to list (markets.json.example; rules in docs/MARKETS.md)
docker compose build api
docker compose run --rm api blindbook-api candidates 20   # markets that pass the rules now, as markets.json entries
docker compose up -d --build
docker compose logs -f api               # "catalog loaded", then "market listed" or the rule that kept a market out
```

Until the signer connects, the API logs that it can't close blocks or list markets yet: that is expected, and both happen as soon as the signer is in.

`BB_VOUCHER_UNITS` must be the same on both servers (5000 = 0.05 TAZ per judge code).

## 5. VPS-2: the signer

```sh
cd deploy/signer
docker compose up -d
docker compose logs -f signer            # "signer ready"; the API logs that it admitted the signer
```

Then fund the reserve: send TAZ from your wallet to the reserve address `init` printed. The reserve must cover the liabilities plus the open markets' buffers (0.05 TAZ each on testnet); the verifier shows the margin.

## 6. The app

On any machine with Node 22 and pnpm 10 (and Rust with the `wasm32-unknown-unknown` target, for the verifier's engine):

```sh
BB_API_ORIGIN=https://api.example.org BB_APP_ORIGIN=https://example.org \
  BB_M=<M> BB_SEAL_PK=<seal public key> BB_NETWORK=testnet sh deploy/web/build.sh
```

- `BB_ONION_URL` (optional, `http://….onion`): the .onion address, from `docker compose exec tor cat /var/lib/tor/blindbook/hostname` on VPS-1. The app offers it when the mixnet can't be reached from a visitor's network or browser.
- `BB_APP_ORIGIN` lists every origin the static host serves the app from, space-separated (for example `"https://example.org https://www.example.org"`). The tunnel frames' CSP names them: the mixnet worker runs with an opaque origin so that Nym's directory and gateway see `Origin: null` instead of the site, and Safari only lets that worker load its code from an origin the policy names. Opened from any other host name, the app links in Chromium and Firefox but not in Safari.
- Upload `deploy/web/site/` to the static host (Cloudflare Pages, Netlify or any host that serves `_headers`; otherwise set the same headers there: `X-Frame-Options: SAMEORIGIN`, `Content-Security-Policy: frame-ancestors 'self'`, and `Cache-Control: public, max-age=31536000, immutable` on `/assets/*`). The static host sees that an address loaded the app, never what it does (THREAT_MODEL N7). The long cache matters: the mixnet worker's code (`assets/nym-worker-*.js`, 3.8 MB gzip) is loaded by a worker the service worker can't serve, so the browser's own cache must keep it, or every visit would fetch it again from the host.
- Leave the host's page-rewriting features off: on Cloudflare, Web Analytics, Rocket Loader, Auto Minify, Email Obfuscation and bot challenges inject scripts or rewrite the HTML (the CSP blocks them and the subresource integrity fails); on Netlify, snippet injection and analytics scripts. The leak check against the deployed app catches any of them.
- Publish `deploy/web/site/SHA256SUMS` with the release. Two builds of one commit give the same hashes, so anyone can compare what the host serves with the source.
- Copy `deploy/api/onion-site/` to VPS-1 (`deploy/api/onion-site`) and restart Caddy; the .onion address is `docker compose exec tor cat /var/lib/tor/blindbook/hostname`. If the VPS's network blocks Tor (`docker compose logs tor` stays at "Stuck at 10%"), add bridges to `tor/torrc`.
- Optional: our own Nym exit (IP packet router) if public exits prove unreliable; pin it with `BB_IPR=<address>` at build time.

## 7. Check it

Tested end to end on Oct 8 with both stacks in Docker on one machine (testnet, live Polymarket data): keys, treasury and judge codes made with the commands above; the signer admitted; two markets listed by the rules (one kept out for having no start time); a judge code typed in lower case with spaces redeemed in 0.5 s; a bet filled in 1 s at the quoted share count and published in the next block; both verifiers green on the log, and the command-line one correctly failing the on-chain reserve check of the unfunded test reserve; Caddy answering writes with `Connection: close`, without a `Server` header, 404 outside `/v1/`, and never resuming a TLS session; the leak check clean against the deployed app. On Oct 9 the API ran natively against the same signer and data: an entry edited in the markets file and a new slug were listed within a minute without a restart, and `BB_AUTO_LIST=6` listed two matches on its own, each with a live reference.

```sh
curl -s https://api.example.org/v1/head                      # height, seq, root, pow_bits
curl -s https://api.example.org/v1/live | head -c 400        # markets with prices
docker run --rm blindbook:latest blindbook-verify <M> https://api.example.org --chain zecrocks --polygon public
```

Then open the app from a clean browser: the lamp turns LINKED, a judge code adds balance, a bet prints a slip, F4 VERIFY shows all checks green, and a CALLED IT link opened elsewhere says VERIFIED. The leak check runs against the deployed app too: `APP=https://example.org CHROME_PATH=<chrome> node web/scripts/leakcheck.mjs`.

**On an iPhone** (ROADMAP Gate 2), in Safari, then again from the home screen. Note the seconds and screenshot anything that looks wrong:

1. Open the app's address. Time from opening the page to the lamp showing **LINKED** (target: under 20 s).
2. **STEP INSIDE**, make a vault with **Face ID**, and stamp the 12 words.
3. `CAGE` → **JUDGE CODE**: paste a code from `voucher-codes.txt`. The balance appears.
4. Open a market, **BUY**. Time from pressing BUY to the printed slip (target: 3 s typical, 6 s at most).
5. On the slip, **CALLED IT** → copy the link → open it on another device: `VERIFIED ✓`.
6. Share → **Add to Home Screen** and open it from there. The installed app has its own storage, separate from Safari's: choose **RESTORE FROM 12 WORDS**, type them, and the balance and the slip come back from the public log (the server is asked nothing). Set Face ID there, close the app, reopen it, unlock with Face ID.
7. Lock the phone for a minute and come back: the lamp relinks by itself and trading unlocks.
8. Mainnet instance only: `CAGE` → **TOP UP** with ~0.001 ZEC; the address opens Zodl through its deep link; the top-up is credited within seconds.

## The mainnet proof

The same build with micro stakes, next to the playground on the same two servers:

- VPS-2: `signer-main.env` (from `signer.env.example`, with `BB_NETWORK=mainnet`, `BB_ZCASH_NET=main`, `BB_LWD=zecrocks-main`, the mainnet API's URL and its own token), then a second key set: `docker compose -f compose.yml -f compose.mainnet.yml run --rm signer-main blindbook-signer keygen /secrets/master.key`, `… init /secrets/treasury tip`, and an empty `secrets-main/voucher-hashes.txt` (no judge codes on mainnet). Start with `docker compose -f compose.yml -f compose.mainnet.yml up -d`.
- VPS-1: `api-main.env` and `config-main/`, the mainnet host added to `BB_SITES` (`… main.example.org=api-main:8080`); start with `docker compose -f compose.yml -f compose.mainnet.yml up -d`.
- A second app build with `BB_API_ORIGIN=https://main.example.org BB_NETWORK=mainnet`, the mainnet keys and its own host name in `BB_APP_ORIGIN`.

## Running it

- **Backups:** VPS-2 `secrets/` (offline, encrypted) and `data/`; VPS-1 `data/` and the `tor-data` volume (the onion's key). Both servers rebuild their state from their journals on start.
- **Updates:** `git pull`, rebuild the image, `docker compose up -d` on each server. The API keeps an operation in doubt until the signer is back and both agree on the count.
- **Stop everything safely:** stop the signer. Nothing can be signed, spent or paid until it returns; slips keep their value.
- **Markets during judging (Oct 29 – Nov 22):** a market must end before judging ends, so new ones have to follow as others close. The API reads `config/markets.json` again every minute: find new ones with `docker compose run --rm api blindbook-api candidates`, add their slugs, and they are checked against the rules and listed, with no restart (keep the slugs of markets still open or unresolved in the file). `BB_AUTO_LIST=6` in `api.env` makes the API keep at least six markets open by itself, from the same candidates (matches and games with Polymarket's own start time); each open market ties up 0.05 TAZ of the reserve's buffer, at most twice that many at a time. A plan that keeps the playground useful for the whole period: a few markets that stay open for weeks (questions that resolve in the second half of November, with `event_start_ms` at the moment the answer can become known, or at the end for a "by <date>" question), the headline events inside the window (the US midterm elections on Nov 3), and same-day matches refreshed every few days. `docker compose logs api` names every market a rule kept out.
- **Judge codes:** give out the codes from `voucher-codes.txt`; to revoke unused ones after judging, remove their hashes from `voucher-hashes.txt` and restart the signer.
- **Logs** hold the service's own events (markets listed, blocks, payouts, errors), never a request.
- **Watching it from outside:** `/v1/head` is public and the same for everyone, so any uptime monitor can poll it: the height should grow about every 75 s (it stops when the signer is away) and `halted` should stay `false`. A monitor learns nothing about users from it: it reads what every visitor reads.
