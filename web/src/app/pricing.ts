// What a bet or a sale should come to at the current price, by the engine's own formulas
// (PROTOCOL section 5): the anchored LMSR curve, never cheaper than Polymarket's ask for a buy
// and never above its bid for a sale, 1% fee. An estimate for the bet panel: the batch can still
// differ (other orders in it, the reference moving, the exposure buffer), which is what the max
// price is for.

/** Our price of `outcome` (0..1) from the live price of outcome A. */
const priceOf = (priceA: number, outcome: 0 | 1) => (outcome === 0 ? priceA : 1 - priceA);

/** Shares (units) a buy of `amount` CREDIT units gets, and their average price in cents. */
export function estimateBuy(o: { priceA: number; outcome: 0 | 1; amount: number; b: number; feeBp: number; ask: number }): { shares: number; avgCents: number } {
  const p = Math.min(0.999, Math.max(0.001, priceOf(o.priceA, o.outcome)));
  const net = o.amount - Math.floor((o.amount * o.feeBp) / 10_000);
  // Our side's q is b·logit(p) above the other's; the cost function C = b·ln(e^(qA/b) + e^(qB/b)).
  const qa = o.b * Math.log(p / (1 - p));
  const c = o.b * Math.log(Math.exp(qa / o.b) + 1);
  const curve = o.b * Math.log(Math.exp((c + net) / o.b) - 1) - qa;
  const guard = o.ask > 0 ? net / o.ask : Infinity;
  const shares = Math.max(0, Math.floor(Math.min(curve, guard)));
  return { shares, avgCents: shares > 0 ? (net / shares) * 100 : 100 };
}

/** CREDIT units a sale of `shares` units brings after the fee, and the average in cents. */
export function estimateSell(o: { priceA: number; outcome: 0 | 1; shares: number; b: number; feeBp: number; bid: number }): { proceeds: number; avgCents: number } {
  const p = Math.min(0.999, Math.max(0.001, priceOf(o.priceA, o.outcome)));
  const qa = o.b * Math.log(p / (1 - p));
  const cost = (a: number) => o.b * Math.log(Math.exp(a / o.b) + 1);
  const curve = cost(qa) - cost(qa - o.shares);
  const gross = Math.min(curve, o.shares * o.bid);
  const proceeds = Math.max(0, Math.floor(gross - (gross * o.feeBp) / 10_000));
  return { proceeds, avgCents: o.shares > 0 ? (gross / o.shares) * 100 : 0 };
}

/** The max price a bet should carry: the expected average plus room for the price to move. */
export function defaultLimitCents(avgCents: number): number {
  return Math.min(99, Math.max(1, Math.ceil(avgCents) + 2));
}

/** A bet of `units` on `outcome` at the live price: shares, average price and the default max price. */
export function quoteBuy(market: { b: number; feeBp: number }, live: { price_a_ppm: number | null; reference: { ask_ppm: [number, number] } } | undefined, outcome: 0 | 1, units: number) {
  const priceA = live?.price_a_ppm ? live.price_a_ppm / 1_000_000 : 0.5;
  const ask = live ? live.reference.ask_ppm[outcome] / 1_000_000 : 0;
  const e = estimateBuy({ priceA, outcome, amount: units, b: market.b, feeBp: market.feeBp, ask });
  return { ...e, limit: defaultLimitCents(e.avgCents) };
}
