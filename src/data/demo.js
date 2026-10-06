// Synthetic but internally consistent market data, for trying the app without
// network access or outside market hours. Never used unless DATA_SOURCE=demo or ?demo=1.
import { bsDelta, bsGamma, bsPrice } from '../engine/math.js';
import { etDate } from '../engine/time.js';

function rng(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
}

function series(r, start, n, vol, drift, stepMs, t0) {
  const bars = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * Math.exp(drift + vol * gauss(r));
    const hi = Math.max(o, p) * (1 + Math.abs(gauss(r)) * vol * 0.4);
    const lo = Math.min(o, p) * (1 - Math.abs(gauss(r)) * vol * 0.4);
    bars.push({ t: t0 + i * stepMs, o, h: hi, l: lo, c: p, v: Math.round(1e5 * (1 + r() * 3)) });
  }
  return bars;
}

function nextFridays(now, n) {
  const out = [];
  const d = new Date(`${etDate(now)}T12:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === 5) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function demoData(ticker, now = new Date()) {
  const day = etDate(now);
  const r = rng(`${ticker}:${day}`);
  const live = rng(`${ticker}:${Math.floor(now.getTime() / 15000)}`);
  const base = 20 + r() * 480;
  const annVol = 0.2 + r() * 0.4;
  const dayVol = annVol / Math.sqrt(252);
  const drift = (r() - 0.45) * dayVol * 0.3;

  const openUtc = new Date(`${day}T13:30:00Z`).getTime();
  const daily = series(r, base, 260, dayVol, drift, 86_400_000, openUtc - 260 * 86_400_000);
  const prevClose = daily.at(-1).c;
  const elapsed = Math.max(45, Math.min(390, Math.floor((now.getTime() - openUtc) / 60_000)));
  const intradayDrift = (r() - 0.5) * dayVol * 0.005;
  const intraday = series(r, prevClose, elapsed, dayVol / Math.sqrt(390), intradayDrift, 60_000, openUtc);
  const last = intraday.at(-1);
  last.c *= 1 + gauss(live) * dayVol * 0.05;
  const price = last.c;
  const simNow = new Date(Math.max(now.getTime(), last.t + 60_000));

  const step = price < 50 ? 1 : price < 200 ? 2.5 : 5;
  const atmK = Math.round(price / step) * step;
  const ivBase = annVol * (0.85 + r() * 0.4);
  const chain = [];
  for (const expiry of nextFridays(now, 8)) {
    const T = Math.max(1, (new Date(`${expiry}T20:00:00Z`) - simNow) / 86_400_000) / 365;
    for (let k = -15; k <= 15; k++) {
      const strike = atmK + k * step;
      if (strike <= 0) continue;
      for (const type of ['call', 'put']) {
        const m = Math.log(strike / price);
        const iv = Math.max(0.05, ivBase * (1 - 0.6 * m + 2 * m * m));
        const theo = bsPrice(price, strike, T, iv, type);
        if (theo < 0.05) continue;
        const half = Math.max(0.01, theo * (0.01 + r() * 0.025));
        const oi = Math.round(5000 * Math.exp(-Math.abs(k) / 5) * (0.3 + r()) * (strike % (step * 4) === 0 ? 2 : 1));
        chain.push({
          type, strike, expiry,
          bid: +(theo - half).toFixed(2),
          ask: +(theo + half).toFixed(2),
          last: +theo.toFixed(2),
          iv,
          delta: bsDelta(price, strike, T, iv, type),
          gamma: bsGamma(price, strike, T, iv),
          oi,
          volume: Math.round(oi * r() * 0.8),
        });
      }
    }
  }

  // Flow leans with the intraday move so the demo exercises both outcomes.
  const lean = price > prevClose ? 0.65 : 0.35;
  const flowPrints = [];
  for (let i = 0; i < 40; i++) {
    const c = chain[Math.floor(r() * chain.length)];
    const bullish = r() < lean;
    const type = r() < 0.5 ? 'call' : 'put';
    const side = (type === 'call') === bullish ? 'ask' : 'bid';
    const size = Math.round(50 + r() * 1500);
    flowPrints.push({
      ticker, time: new Date(simNow.getTime() - r() * 3_600_000).toISOString(),
      type, strike: c.strike, expiry: c.expiry, side, size, price: c.last, sweep: r() < 0.3,
    });
  }

  const spyDaily = series(r, 560, 60, 0.01, 0.0004, 86_400_000, openUtc - 60 * 86_400_000);
  const spyIntraday = series(r, spyDaily.at(-1).c, elapsed, 0.0006, intradayDrift / 2, 60_000, openUtc);
  const earnings = new Date(simNow.getTime() + (5 + r() * 60) * 86_400_000).toISOString().slice(0, 10);

  return {
    ticker,
    now: simNow,
    session: 'open',
    price,
    daily: [...daily, { ...last, t: openUtc }],
    intraday,
    chain,
    earningsDate: earnings,
    flowPrints,
    market: {
      spyDaily,
      spyIntraday,
      spyPrice: spyIntraday.at(-1).c,
      vix: 13 + r() * 12,
      vix3m: 16 + r() * 6,
    },
  };
}
