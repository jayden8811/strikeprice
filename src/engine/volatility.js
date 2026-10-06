import { median, realizedVol } from './math.js';
import { daysToExpiry } from './time.js';

// Implied vs. forecast realized volatility: is premium cheap or rich for a buyer?
export function computeVolatility({ closes, chain, price, now }) {
  const rv10 = realizedVol(closes, 10);
  const rv20 = realizedVol(closes, 20);
  const rv60 = realizedVol(closes, 60);
  // HAR-style blend: recent vol matters most but mean-reverts toward the longer window.
  const parts = [[rv10, 0.5], [rv20, 0.3], [rv60, 0.2]].filter(([v]) => Number.isFinite(v));
  const w = parts.reduce((a, [, x]) => a + x, 0);
  const forecastRV = w ? parts.reduce((a, [v, x]) => a + v * x, 0) / w : NaN;

  const atm30 = atmIV(chain, price, now, 30);
  const atmFront = atmIV(chain, price, now, 7);
  const ratio = atm30 && forecastRV ? atm30.iv / forecastRV : NaN;

  return {
    rv10,
    rv20,
    rv60,
    forecastRV,
    atmIV: atm30?.iv ?? NaN,
    atmExpiry: atm30?.expiry ?? null,
    frontIV: atmFront?.iv ?? NaN,
    ivToRv: ratio,
  };
}

// ATM implied vol for the expiry closest to targetDTE.
export function atmIV(chain, price, now, targetDTE) {
  const expiries = [...new Set(chain.map((o) => o.expiry))]
    .map((e) => ({ e, dte: daysToExpiry(e, now) }))
    .filter((x) => x.dte >= 2);
  if (!expiries.length) return null;
  expiries.sort((a, b) => Math.abs(a.dte - targetDTE) - Math.abs(b.dte - targetDTE));
  const expiry = expiries[0].e;
  const opts = chain.filter((o) => o.expiry === expiry && o.iv > 0);
  if (!opts.length) return null;
  const nearest = Math.min(...opts.map((o) => Math.abs(o.strike - price)));
  const atm = opts.filter((o) => Math.abs(o.strike - price) === nearest);
  return { expiry, dte: expiries[0].dte, iv: median(atm.map((o) => o.iv)) };
}

// Median bid/ask spread as % of mid for near-the-money contracts a buyer would use.
export function computeLiquidity({ chain, price, now }) {
  const near = chain.filter((o) => {
    const dte = daysToExpiry(o.expiry, now);
    return dte >= 5 && dte <= 45 && Math.abs(o.strike / price - 1) <= 0.05;
  });
  const quoted = near.filter((o) => o.bid > 0 && o.ask > o.bid);
  const spreads = quoted.map((o) => (o.ask - o.bid) / ((o.ask + o.bid) / 2));
  return {
    contracts: near.length,
    quoted: quoted.length,
    medianSpreadPct: spreads.length ? median(spreads) : NaN,
    openInterest: near.reduce((a, o) => a + (o.oi || 0), 0),
    volume: near.reduce((a, o) => a + (o.volume || 0), 0),
  };
}
