import { daysToExpiry } from './time.js';

const WINDOW_MIN = 60;

// Net directional premium from options prints.
// A print is { ticker, time, type: 'call'|'put', strike, expiry, side: 'ask'|'bid'|'mid',
//              size, price, premium?, sweep? }.
export function analyzeFlow({ prints, ticker, now }) {
  const since = now.getTime() - WINDOW_MIN * 60_000;
  const recent = prints.filter(
    (p) => p.ticker?.toUpperCase() === ticker && new Date(p.time).getTime() >= since,
  );
  let bull = 0;
  let bear = 0;
  for (const p of recent) {
    const premium = p.premium ?? p.size * p.price * 100;
    const w = premium * (p.sweep ? 1.5 : 1);
    const bullish = (p.type === 'call' && p.side === 'ask') || (p.type === 'put' && p.side === 'bid');
    const bearish = (p.type === 'put' && p.side === 'ask') || (p.type === 'call' && p.side === 'bid');
    if (bullish) bull += w;
    else if (bearish) bear += w;
  }
  const total = bull + bear;
  const top = [...recent]
    .sort((a, b) => (b.premium ?? b.size * b.price * 100) - (a.premium ?? a.size * a.price * 100))
    .slice(0, 8);
  return {
    source: 'feed',
    prints: recent.length,
    bullPremium: bull,
    bearPremium: bear,
    net: total ? (bull - bear) / total : 0,
    top,
  };
}

// Fallback when no live flow feed is connected: contracts trading far above their
// open interest. The side of each trade is unknown, so this is a weak signal.
export function proxyFlowFromChain({ chain, price, now }) {
  let call = 0;
  let put = 0;
  const unusual = [];
  for (const o of chain) {
    const dte = daysToExpiry(o.expiry, now);
    if (dte <= 0 || dte > 60 || !(o.volume >= 500) || o.volume <= (o.oi || 0)) continue;
    const mid = o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o.last || 0;
    const premium = o.volume * mid * 100;
    if (o.type === 'call') call += premium;
    else put += premium;
    unusual.push({ ...o, premium, volOi: o.oi ? o.volume / o.oi : null });
  }
  const total = call + put;
  return {
    source: 'chain-proxy',
    prints: unusual.length,
    bullPremium: call,
    bearPremium: put,
    // Halved: without trade side, call volume is only loosely bullish.
    net: total ? (0.5 * (call - put)) / total : 0,
    top: unusual.sort((a, b) => b.premium - a.premium).slice(0, 8),
    spot: price,
  };
}
