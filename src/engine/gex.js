import { bsGamma } from './math.js';
import { daysToExpiry } from './time.js';

const MAX_DTE = 60;

// Dealer gamma exposure, using the common convention that dealers are long the
// calls and short the puts customers trade. $ GEX per 1% move in the underlying.
function gexAt(spot, contracts, now, useQuotedGamma) {
  let total = 0;
  for (const o of contracts) {
    const T = o.dte / 365;
    const g = useQuotedGamma && o.gamma > 0 ? o.gamma : bsGamma(spot, o.strike, T, o.iv);
    const dollar = g * o.oi * 100 * spot * spot * 0.01;
    total += o.type === 'call' ? dollar : -dollar;
  }
  return total;
}

export function computeGex({ chain, price, now }) {
  const contracts = chain
    .map((o) => ({ ...o, dte: daysToExpiry(o.expiry, now) }))
    .filter((o) => o.dte > 0 && o.dte <= MAX_DTE && o.oi > 0 && o.iv > 0);
  if (!contracts.length) return null;

  const net = gexAt(price, contracts, now, true);

  // Walls: strikes with the largest call / put gamma at the current price.
  const byStrike = new Map();
  for (const o of contracts) {
    const g = (o.gamma > 0 ? o.gamma : bsGamma(price, o.strike, o.dte / 365, o.iv)) * o.oi * 100 * price * price * 0.01;
    const s = byStrike.get(o.strike) ?? { strike: o.strike, call: 0, put: 0 };
    s[o.type] += g;
    byStrike.set(o.strike, s);
  }
  const strikes = [...byStrike.values()];
  const above = strikes.filter((s) => s.strike >= price);
  const below = strikes.filter((s) => s.strike <= price);
  const callWall = above.sort((a, b) => b.call - a.call)[0]?.strike ?? null;
  const putWall = below.sort((a, b) => b.put - a.put)[0]?.strike ?? null;

  // Gamma flip: the spot price where net GEX changes sign, scanned over +/-15%.
  let flip = null;
  const steps = 120;
  let prev = null;
  let best = Infinity;
  for (let i = 0; i <= steps; i++) {
    const s = price * (0.85 + (0.3 * i) / steps);
    const g = gexAt(s, contracts, now, false);
    if (prev && Math.sign(g) !== Math.sign(prev.g)) {
      const x = prev.s + ((s - prev.s) * Math.abs(prev.g)) / (Math.abs(prev.g) + Math.abs(g));
      if (Math.abs(x - price) < best) {
        best = Math.abs(x - price);
        flip = x;
      }
    }
    prev = { s, g };
  }

  return { net, flip, callWall, putWall };
}
