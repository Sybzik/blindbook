# Security and privacy

Blindbook's core claim: **nobody, including its operator, can link a bet to a person or a payout to a bet.**
If you find anything that breaks that claim, please tell us: a leak, a linkability attack, a way to forge slips, move a price you shouldn't be able to move, or drain the reserve.

## Reporting

- Check [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) first. If your finding isn't listed there, it's new.
- Report privately through GitHub's **"Report a vulnerability"** button (Security tab).
- Please don't open public issues for unfixed leaks.

## Scope

| In scope | Notes |
|---|---|
| `crates/` (engine, indexer, API, signer, verifier) | including the batch clearing math and the exposure invariant |
| `web/` (vault, slip wallet, mixnet client, proof checker) | including anything that sends data off the device |
| The public data bundle and the on-chain anchors | equivocation, rewriting, inconsistent replay |
| The testnet playground deployment | test funds only; don't degrade service for others |

Out of scope: Zcash, Nym and Polymarket themselves, and denial of service against the hosted demo.

## Design notes for reviewers

- **The internet-facing API holds no secrets.** It can't sign slips or move funds. All keys live on a separate signer with no inbound ports, which replays the state itself before signing anything.
- **No per-user state.** There are no accounts, emails, cookies or balances on the server; balances are blind-signed bearer slips held only on the user's device.
- **No IPs.** Clients reach the API only through the Nym mixnet. Top-ups and withdrawals use a separate mixnet identity; the API closes the connection after every write and disables TLS session resumption. Services refuse to boot if access logging is enabled or if CORS/CSP would allow a third party.
- **No targeted queries.** Clients download one identical bundle; the indexer fetches whole blocks, never a single transaction.
- **Verifiable custody.** The reserve viewing key is public. `blindbook-verify` (CLI or in the browser) replays the log and checks solvency and the exposure invariant `max(u_A, u_B) − c ≤ L` for every market.
- **Known residual risks** are listed honestly at the end of the threat model.

This is hackathon software. The demo runs on testnet; the mainnet proof uses micro stakes. Don't put in more than you can afford to lose.
