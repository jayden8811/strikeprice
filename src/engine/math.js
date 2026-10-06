// Shared numeric helpers: Black-Scholes, volatility, averages.

export const TRADING_DAYS = 252;

export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Abramowitz-Stegun approximation, accurate to ~1e-7.
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function d1(S, K, T, iv, r = 0) {
  return (Math.log(S / K) + (r + (iv * iv) / 2) * T) / (iv * Math.sqrt(T));
}

export function bsGamma(S, K, T, iv, r = 0) {
  if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return 0;
  return normPdf(d1(S, K, T, iv, r)) / (S * iv * Math.sqrt(T));
}

export function bsDelta(S, K, T, iv, type, r = 0) {
  if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return 0;
  const n = normCdf(d1(S, K, T, iv, r));
  return type === 'call' ? n : n - 1;
}

export function bsPrice(S, K, T, iv, type, r = 0) {
  if (!(T > 0 && iv > 0)) return Math.max(0, type === 'call' ? S - K : K - S);
  const a = d1(S, K, T, iv, r);
  const b = a - iv * Math.sqrt(T);
  const disc = Math.exp(-r * T);
  return type === 'call'
    ? S * normCdf(a) - K * disc * normCdf(b)
    : K * disc * normCdf(-b) - S * normCdf(-a);
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function sma(values, n) {
  return values.length >= n ? mean(values.slice(-n)) : NaN;
}

// Annualized close-to-close realized volatility over the last n returns.
export function realizedVol(closes, n) {
  if (closes.length < n + 1) return NaN;
  const c = closes.slice(-(n + 1));
  const rets = [];
  for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
  const m = mean(rets);
  const v = rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v * TRADING_DAYS);
}

export function atr(bars, n = 14) {
  if (bars.length < n + 1) return NaN;
  const trs = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const { h, l } = bars[i];
    const pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return mean(trs);
}

export function vwap(bars) {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    if (!b.v) continue;
    pv += ((b.h + b.l + b.c) / 3) * b.v;
    v += b.v;
  }
  return v ? pv / v : NaN;
}

export function round(x, dp = 2) {
  if (!Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

// Implied volatility from an option price by bisection (r = 0, no dividends).
export function impliedVol(price, S, K, T, type) {
  const intrinsic = Math.max(0, type === 'call' ? S - K : K - S);
  if (!(price > intrinsic) || !(T > 0)) return NaN;
  let lo = 0.01;
  let hi = 5;
  if (bsPrice(S, K, T, hi, type) < price) return NaN;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(S, K, T, mid, type) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
