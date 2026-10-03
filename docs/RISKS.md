# Project risk register

Privacy threats are in [THREAT_MODEL.md](THREAT_MODEL.md). This file covers what could stop us from **shipping and winning**.

| # | Risk | Likelihood | Impact | Mitigation / fallback | Owner date |
|---|---|---|---|---|---|
| R1 | Nym exit policy blocks our API domain, or mixFetch is unusable on iOS Safari | medium | high | Spike A on day 2; run our own exit (IPR); Tor for mobile with an explicit warning | Oct 3 |
| R2 | No iPhone wallet does testnet Ironwood with ZIP 321 | medium | medium | desktop testnet wallets; iPhone tested on mainnet with 0.005 ZEC | Oct 4 |
| R3 | librustzcash Ironwood APIs still moving (crates finalized Aug 19) | medium | high | pin exact versions; `zcash-devtool` as reference; subprocess or zallet RPC fallback | Oct 4 |
| R4 | Blind-signature implementations disagree across Rust and TS | low | high | one implementation compiled to WASM for both sides | Oct 5 |
| R5 | Scope too big for 26 days | **high** | **high** | gates, cut list, feature freeze Oct 24; core never cut | daily |
| R6 | Judges can't or won't spend mainnet ZEC | high | high | **judge vouchers** (credit slips, no wallet needed) | Oct 23 |
| R7 | Mainnet bug loses funds | low | medium | small stakes, solvency checks, supply guard, halt switch | Oct 23 |
| R8 | House drained by informed traders | low | low | price anchored to Polymarket's live mid, guard, halts, per-market buffer `L_m` caps the loss | Oct 7 |
| R9 | Polymarket API changes or rate-limits us | low | medium | server cache, halts on staleness, settlement doesn't depend on the API (Polygon) | ongoing |
| R10 | No market resolves in time for the video | low | medium | list short-dated markets on Oct 23; fallback to an earlier resolution | Oct 25 |
| R11 | Mixnet round trips make the 2–5 s bet feel slow | medium | medium | link the mixnet during boot, keep the read connection warm, optimistic "printing" UI; measure in Spike A (target p50 ≤ 3 s per request) | Oct 3 |
| R12 | Repo still private at the deadline | low | **fatal** | make public **Oct 27**; checklist | Oct 27 |
| R13 | Secrets committed to git | low | high | `.gitignore` for keys and DBs; `gitleaks` in CI; review before going public | ongoing |
| R14 | Design handoff late or hard to implement | medium | medium | the functional UI is built first (week 2); the design layer comes on top in week 3 | Oct 19 |
| R15 | Overclaiming privacy (a claim that isn't true at submission) | medium | **fatal** (judging rule) | every claim in SUBMISSION.md is re-checked Oct 26; anything cut moves to "Limits" | Oct 26 |
| R16 | Legal exposure of running real-money anonymous betting | — | — | hackathon demo with small stakes; production needs legal review per jurisdiction; not judged, but noted | after the hackathon |
| R17 | Single developer machine fails | low | high | push to GitHub daily | daily |
| R18 | 0-conf top-up double-spent | low | low | caps (0.1 ZEC per top-up, 0.3 ZEC total); the house absorbs it | Oct 11 |
| R19 | mixFetch can't force a fresh connection per request | medium | medium | recreate the mixFetch client for withdrawals (costs a re-link, and withdrawals are rare); reuse for reads only | Oct 3 |
