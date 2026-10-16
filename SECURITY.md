# Security and privacy

Blindbook's core claim: **nobody, including its operator, can link a bet to a person or a payout to a bet.**
If you find anything that breaks that claim, please tell us: a leak, a linkability attack, a way to forge slips, move a price you shouldn't be able to move, settle a market the wrong way, or drain the reserve.

## Reporting

- Check [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) first. If your finding isn't listed there, it's new.
- Report privately through GitHub's **"Report a vulnerability"** button (Security tab).
- Please report privately rather than in a public issue.

## Scope

| In scope | Notes |
|---|---|
| `crates/` (engine, indexer, API, signer, verifier) | including the batch clearing math and the exposure invariant |
| `web/` (vault, slip wallet, mixnet client, proof checker) | including anything that sends data off the device |
| The public log, its segments and the on-chain anchors | equivocation, rewriting, inconsistent replay |
| The testnet playground deployment | test funds only; don't degrade service for others |

Out of scope: Zcash, Nym and Polymarket themselves, and denial of service against the hosted demo.

## Design notes for reviewers

- **The internet-facing API holds no secrets.** It can't sign slips or move funds. All keys live on a separate signer with no inbound ports, which replays the state itself before signing anything, reads every market's result from Polygon itself, and refuses listings with parameters other than the network's.
- **No per-user state.** There are no accounts, emails, cookies or balances on the server; balances are blind-signed bearer slips held only on the user's device.
- **No IPs.** Clients reach the API only through the Nym mixnet. Top-ups and withdrawals use a separate mixnet identity; the API closes the connection after every write and disables TLS session resumption. The API can't log requests: its log filter switches the HTTP stack's logging off whatever the configuration says, and a test fails if the code ever reads a client address or a proxy header.
- **No targeted queries.** Every client downloads the same public files (live feed, catalog, price history, the log in segments) and filters locally; the indexers fetch whole blocks, never a single transaction.
- **Verifiable custody.** The reserve viewing key is public. The verifier (P400 in the browser, `blindbook-verify` on the command line) replays every batch and checks every signature, the supply, solvency and the exposure invariant `max(u_A, u_B) − c ≤ L`; the command line also checks the reserve and the anchors on-chain (`--chain`) and every result on Polygon (`--polygon`).
- **Trust boundaries:** what the design relies on, and how each part is checked, closes the threat model.

The playground runs on Zcash testnet with test funds.
