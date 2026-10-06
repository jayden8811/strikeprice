// Replays past trading days through the app's own analyze() engine, unchanged, and trades
// every "good" verdict the way a person following the app would.
//
// Each check (every minute by default) rebuilds what the live app would have seen then:
//   - stock: IEX minute bars (the live app's feed), daily history, SPY, hourly VIX/VIX3M
//   - options: a chain priced from OPRA trades up to that minute, IV/Greeks solved with the
//     T-bill rate, bad prints filtered, spreads from real NBBO samples
//   - earnings: Yahoo history, then dates inferred from the post-report IV crush
// When the verdict is good, the chosen contract's real NBBO quote replaces the modeled one
// and the engine re-runs, so the setup is what the app would have shown. Then:
//   - entry: 30s after the signal, a limit at the top of the entry range; filled only if
//     the ask is at or under it within 3 minutes
//   - exits: stop / TP1 (half) / TP2 / stop-at-entry / time exit, detected on full-market
//     (SIP) minute bars and filled at the real bid; gaps fill at the next quote
//   - costs: $0.70 per contract per side; sizing: 2% of a $100k account in premium per
//     trade (fixed, not compounding), at least 2 contracts so selling half at TP1 works
// A random-entry comparison takes the same number of trades at random times and
// directions with identical contract selection and exits.
//
//   node backtest/run.js --tickers SPY,QQQ --start 2024-10-08 --end 2026-09-25 --every 1
import { mkdir, writeFile } from 'node:fs/promises';
import { analyze, setupFor } from '../src/engine/analyze.js';
import { bsDelta, bsGamma, bsPrice, impliedVol, median } from '../src/engine/math.js';
import { daysToExpiry, etDate, etParts } from '../src/engine/time.js';
import {
  earningsDates, inferEarnings, massiveAvailable, occ, optionBars, quoteAt, stockBars, yahooDailyCloses, yahooHourly,
} from './data.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const TICKERS = (args.tickers ?? 'SPY,QQQ,IWM,AAPL,NVDA,TSLA,MSFT,AMZN').split(',');
const START = args.start ?? '2024-10-08';
const END = args.end ?? '2026-09-25';
const EVERY = Number(args.every ?? 1);
const SPLIT = args.split ?? '2026-01-01'; // results reported before / after this date
const OUT = args.out ?? 'results-v2';
const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'DIA']);

const FIRST_EVAL = 30; // minutes after 9:30 (opening range complete)
const LAST_EVAL = 375; // 15:45
const STRIKES_EACH_SIDE = 5; // chain strikes kept per expiry around the price at each check
const STALE_MS = 30 * 60_000;
const FRESH_MS = 5 * 60_000;
const LATENCY_MS = 30_000;
const FILL_WINDOW = [30_000, 60_000, 90_000, 120_000, 180_000];
const FEE = 0.70; // per contract per side, commission + regulatory/exchange
const START_EQUITY = 100_000;
const PREMIUM_PCT = 0.02;
const dayMs = 86_400_000;

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const minutesET = (t) => etParts(new Date(t)).minutes;
const inSession = (b) => minutesET(b.t) >= 570 && minutesET(b.t) < 960;

function groupByDate(bars) {
  const m = new Map();
  for (const b of bars) {
    if (!inSession(b)) continue;
    const d = etDate(new Date(b.t));
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(b);
  }
  return m;
}

function lastBefore(bars, t, from = 0) {
  let i = Math.max(0, from);
  while (i < bars.length && bars[i].t + 60_000 <= t) i++;
  return i - 1;
}

// Last value in a time series [{t, c}] whose bar has closed by time t.
function seriesAt(series, t, barMs) {
  let v = null;
  for (const b of series) {
    if (b.t + barMs > t) break;
    v = b.c;
  }
  return v;
}

function rng(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

let useQuotes = false;
let spreadSamples = new Map(); // `${ticker}|${month}` → spread fraction from real NBBO

async function realQuote(symbol, t) {
  if (!useQuotes) return null;
  try {
    return await quoteAt(symbol, t);
  } catch {
    return null;
  }
}

// Fraction of price used as the modeled spread for chain contracts the app doesn't trade,
// calibrated from real ATM quotes sampled at 11:00 ET on several days each month.
function modeledSpread(ticker, D, p) {
  const s = spreadSamples.get(`${ticker}|${D.slice(0, 7)}`) ?? (ETFS.has(ticker) ? 0.006 : 0.02);
  return Math.max(0.01, p * s);
}

async function calibrateSpreads(ticker, testDays, byDate, tradingDays) {
  if (!useQuotes) return;
  const months = new Map();
  for (const d of testDays) {
    const m = d.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(d);
  }
  for (const [m, days] of months) {
    const picks = days.filter((_, i) => i % Math.max(1, Math.floor(days.length / 5)) === 0).slice(0, 5);
    const spreads = [];
    for (const D of picks) {
      const bars = byDate.get(D);
      const at = bars?.find((b) => minutesET(b.t) >= 660);
      if (!at) continue;
      const expiry = tradingDays.filter((x) => x >= addDays(D, 6))[0];
      if (!expiry) continue;
      for (const k of [Math.round(at.c), Math.round(at.c / 5) * 5, Math.round(at.c / 2.5) * 2.5]) {
        const q = await realQuote(occ(ticker, expiry, 'call', k), at.t + 60_000);
        if (q && q.bid > 0) {
          spreads.push((q.ask - q.bid) / ((q.ask + q.bid) / 2));
          break;
        }
      }
    }
    if (spreads.length) spreadSamples.set(`${ticker}|${m}`, median(spreads));
  }
}

async function runTicker(ticker, ctx) {
  console.log(`\n${ticker}: loading bars…`);
  const histStart = addDays(START, -420);
  const futureEnd = addDays(END, 25);
  const [daily, spyDaily, iexMinute, sipMinute, spyMinute] = await Promise.all([
    stockBars(ticker, '1Day', histStart, futureEnd),
    stockBars('SPY', '1Day', histStart, futureEnd),
    stockBars(ticker, '1Min', `${START}T00:00:00Z`, `${futureEnd}T23:59:00Z`, 'iex'),
    stockBars(ticker, '1Min', `${START}T00:00:00Z`, `${futureEnd}T23:59:00Z`, 'sip'),
    stockBars('SPY', '1Min', `${START}T00:00:00Z`, `${futureEnd}T23:59:00Z`, 'iex'),
  ]);
  const iexByDate = groupByDate(iexMinute);
  const sipByDate = groupByDate(sipMinute);
  const spyByDate = groupByDate(spyMinute);
  const tradingDays = daily.map((b) => etDate(new Date(b.t)));
  const testDays = tradingDays.filter((d) => d >= START && d <= END && iexByDate.get(d)?.length >= 150 && sipByDate.get(d)?.length >= 150);

  let earnings = [];
  if (!ETFS.has(ticker)) {
    const known = (await earningsDates(ticker)).filter((d) => d <= ctx.today);
    earnings = await inferEarnings(ticker, known, daily, END, impliedVol);
    ctx.earnings[ticker] = { known: known.filter((d) => d >= addDays(START, -120)), inferred: earnings.filter((d) => d > known.at(-1)) };
  }
  const nextEarnings = (D) => earnings.find((d) => d >= D) ?? null;

  await calibrateSpreads(ticker, testDays, sipByDate, tradingDays);

  const evals = [];
  const trades = [];
  const missed = [];
  const checkTimes = []; // for the random-entry comparison
  let busyUntil = 0;

  for (const D of testDays) {
    const dayBars = iexByDate.get(D);
    const spyBars = spyByDate.get(D) ?? [];
    const openT = dayBars[0].t - (minutesET(dayBars[0].t) - 570) * 60_000;
    const closeT = dayBars.at(-1).t + 60_000; // handles half days
    const open = dayBars[0].o;
    const r = ctx.rate(D);

    // Expirations the app could pick (1–15 days) and the ~30-day one used for ATM IV.
    const future = tradingDays.filter((d) => d > D);
    const setupExp = ETFS.has(ticker) ? future.filter((d) => d >= addDays(D, 5) && d <= addDays(D, 11)) : future.filter((d) => d <= addDays(D, 15));
    const near30 = future.filter((d) => d >= addDays(D, 24) && d <= addDays(D, 36));
    const ivExp = ETFS.has(ticker)
      ? [near30.reduce((a, d) => (Math.abs(Date.parse(d) - Date.parse(addDays(D, 30))) < Math.abs(Date.parse(a) - Date.parse(addDays(D, 30))) ? d : a), near30[0])]
      : near30.filter((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 5);
    const step = ETFS.has(ticker) ? 1 : 0.5;
    const strikes = [];
    for (let k = Math.ceil((open * 0.985) / step) * step; k <= open * 1.015; k += step) strikes.push(Math.round(k * 100) / 100);
    const contracts = [];
    for (const expiry of [...setupExp, ...ivExp].filter(Boolean)) {
      for (const strike of strikes) for (const type of ['call', 'put']) contracts.push({ symbol: occ(ticker, expiry, type, strike), expiry, strike, type });
    }
    const optBars = await optionBars(contracts.map((c) => c.symbol), `${D}T13:00:00Z`, `${D}T21:00:00Z`);
    const live = contracts.filter((c) => optBars.get(c.symbol)?.length);
    const ptr = new Map(live.map((c) => [c.symbol, -1]));
    const cumVol = new Map(live.map((c) => [c.symbol, 0]));
    const daily0 = daily.filter((b) => etDate(new Date(b.t)) < D);
    const spyDaily0 = spyDaily.filter((b) => etDate(new Date(b.t)) < D);
    const earningsDate = nextEarnings(D);

    const stockAt = new Map((sipByDate.get(D) ?? []).map((b) => [b.t, b.c]));
    const lastEval = Math.min(LAST_EVAL, Math.floor((closeT - openT) / 60_000) - 15);
    let iIntra = 0;
    let iSpy = 0;
    for (let m = FIRST_EVAL; m <= lastEval; m += EVERY) {
      const T = openT + m * 60_000;
      const now = new Date(T);
      while (iIntra < dayBars.length && dayBars[iIntra].t + 60_000 <= T) iIntra++;
      while (iSpy < spyBars.length && spyBars[iSpy].t + 60_000 <= T) iSpy++;
      const intraday = dayBars.slice(0, iIntra);
      const spyIntraday = spyBars.slice(0, iSpy);
      if (!intraday.length) continue;
      const price = intraday.at(-1).c;

      // Option chain at T: last trade per contract, nearest strikes only, IV with the T-bill rate.
      const byExp = new Map();
      for (const c of live) {
        const bars = optBars.get(c.symbol);
        let i = ptr.get(c.symbol);
        let v = cumVol.get(c.symbol);
        while (i + 1 < bars.length && bars[i + 1].t + 60_000 <= T) v += bars[++i].v;
        ptr.set(c.symbol, i);
        cumVol.set(c.symbol, v);
        if (i < 0 || T - bars[i].t > STALE_MS) continue;
        if (!byExp.has(c.expiry)) byExp.set(c.expiry, []);
        byExp.get(c.expiry).push({ c, p: bars[i].c, pt: bars[i].t, volume: v });
      }
      const chain = [];
      for (const [expiry, list] of byExp) {
        const ks = [...new Set(list.map((x) => x.c.strike))].sort((a, b) => Math.abs(a - price) - Math.abs(b - price)).slice(0, STRIKES_EACH_SIDE * 2);
        const T365 = daysToExpiry(expiry, now) / 365;
        const rows = [];
        for (const x of list) {
          if (!ks.includes(x.c.strike)) continue;
          // IV against the stock price when the option last traded, then valued at the current price.
          const sThen = stockAt.get(x.pt) ?? price;
          const iv = impliedVol(x.p, sThen, x.c.strike, daysToExpiry(expiry, new Date(x.pt + 60_000)) / 365, x.c.type, r);
          if (Number.isFinite(iv)) rows.push({ ...x, iv, p: x.pt + FRESH_MS >= T ? x.p : bsPrice(price, x.c.strike, T365, iv, x.c.type, r) });
        }
        // Drop bad prints: IV far from the rest of this expiry.
        const mid = median(rows.map((x) => x.iv));
        for (const x of rows) {
          if (rows.length >= 4 && (x.iv > mid * 1.6 || x.iv < mid / 1.6)) continue;
          const half = modeledSpread(ticker, D, x.p) / 2;
          chain.push({
            ...x.c,
            bid: Math.max(0.01, x.p - half),
            ask: x.p + half,
            last: x.p,
            iv: x.iv,
            delta: bsDelta(price, x.c.strike, T365, x.iv, x.c.type, r),
            gamma: bsGamma(price, x.c.strike, T365, x.iv, r),
            oi: 0,
            volume: x.volume,
          });
        }
      }

      const input = {
        ticker, now, session: 'open', price, daily: daily0, intraday, chain, earningsDate, flowPrints: [],
        market: { spyDaily: spyDaily0, spyIntraday, spyPrice: spyIntraday.at(-1)?.c, vix: ctx.vixAt(T), vix3m: ctx.vix3mAt(T) },
      };
      let res = analyze(input);
      // Swap in the real quote for the contract the app picked, then decide again.
      if (res.verdict === 'good') {
        const c = res.setup.contract;
        const q = await realQuote(occ(ticker, c.expiry, c.type, c.strike), T);
        if (q) {
          const idx = chain.findIndex((x) => x.expiry === c.expiry && x.strike === c.strike && x.type === c.type);
          chain[idx] = { ...chain[idx], bid: q.bid, ask: q.ask };
          res = analyze({ ...input, chain });
        }
      }

      evals.push({
        date: D,
        time: `${String(Math.floor((570 + m) / 60)).padStart(2, '0')}:${String((570 + m) % 60).padStart(2, '0')}`,
        verdict: res.verdict, bias: res.bias, reason: res.reasons[0] ?? null,
      });
      checkTimes.push({ D, T, m });

      if (res.verdict === 'good' && T >= busyUntil) {
        const out = await trade({ ticker, D, T, setup: res.setup, price, sipByDate, tradingDays });
        if (out.filled) {
          trades.push({ ...out, signal: { vix: input.market.vix, spyTrend: res.checks.find((x) => x.id === 'market')?.value } });
          busyUntil = out.exitTime;
        } else {
          missed.push({ date: D, time: new Date(T).toISOString(), contract: out.contract, limit: out.limit, bestAsk: out.bestAsk });
        }
      }
    }
    const g = evals.filter((e) => e.date === D && e.verdict === 'good').length;
    process.stdout.write(`${D}${g ? `:${g}` : ''} `);
  }

  // Random entries: same count, random check times and directions, identical rules.
  const random = [];
  const pick = rng(`random:${ticker}`);
  let busy = 0;
  for (let tries = 0; random.length < trades.length && tries < trades.length * 40; tries++) {
    const ct = checkTimes[Math.floor(pick() * checkTimes.length)];
    if (ct.T < busy) continue;
    const bias = pick() < 0.5 ? 'bull' : 'bear';
    const s = await randomSetup({ ticker, ct, bias, iexByDate, spyByDate, daily, spyDaily, ctx, nextEarnings, tradingDays });
    if (!s) continue;
    const out = await trade({ ticker, D: ct.D, T: ct.T, setup: s.setup, price: s.price, sipByDate, tradingDays });
    if (out.filled) {
      random.push(out);
      busy = out.exitTime;
    }
  }

  return { ticker, evals, trades, missed, random, spreads: Object.fromEntries([...spreadSamples].filter(([k]) => k.startsWith(`${ticker}|`))) };
}

// The setup the app would build for a forced direction at a random time (same chain build).
async function randomSetup({ ticker, ct, bias, iexByDate, spyByDate, daily, spyDaily, ctx, nextEarnings, tradingDays }) {
  const { D, T } = ct;
  const dayBars = iexByDate.get(D).filter((b) => b.t + 60_000 <= T);
  if (!dayBars.length) return null;
  const price = dayBars.at(-1).c;
  const now = new Date(T);
  const r = ctx.rate(D);
  const future = tradingDays.filter((d) => d > D && d <= addDays(D, 15));
  const strikes = ETFS.has(ticker) ? [Math.floor(price), Math.ceil(price)] : [Math.round(price), Math.round(price / 5) * 5, Math.round(price / 2.5) * 2.5];
  const type = bias === 'bull' ? 'call' : 'put';
  const contracts = future.flatMap((expiry) => [...new Set(strikes)].map((strike) => ({ symbol: occ(ticker, expiry, type, strike), expiry, strike, type })));
  const bars = await optionBars(contracts.map((c) => c.symbol), `${D}T13:00:00Z`, `${D}T21:00:00Z`);
  const chain = [];
  for (const c of contracts) {
    const b = bars.get(c.symbol) ?? [];
    const i = lastBefore(b, T);
    if (i < 0 || T - b[i].t > STALE_MS) continue;
    const T365 = daysToExpiry(c.expiry, now) / 365;
    const iv = impliedVol(b[i].c, price, c.strike, T365, type, r);
    if (!Number.isFinite(iv)) continue;
    const q = await realQuote(c.symbol, T);
    const half = modeledSpread(ticker, D, b[i].c) / 2;
    chain.push({ ...c, bid: q?.bid ?? Math.max(0.01, b[i].c - half), ask: q?.ask ?? b[i].c + half, last: b[i].c, iv,
      delta: bsDelta(price, c.strike, T365, iv, type, r), gamma: bsGamma(price, c.strike, T365, iv, r), oi: 0, volume: 0 });
  }
  const atrLike = Math.abs(price) * 0.01;
  const setup = setupFor({
    ticker, now, price, chain, earningsDate: nextEarnings(D), intraday: dayBars,
    daily: daily.filter((b) => etDate(new Date(b.t)) < D),
  }, bias, price - (bias === 'bull' ? 1 : -1) * 0.1 * atrLike);
  return setup ? { setup, price } : null;
}

// Executes one setup with limit entry, real-quote exits, fees and sizing.
async function trade({ ticker, D, T, setup, price, sipByDate, tradingDays }) {
  const c = setup.contract;
  const sym = occ(ticker, c.expiry, c.type, c.strike);
  const limit = setup.entry.optionHigh;
  const contractLabel = `${c.expiry} ${c.strike} ${c.type}`;

  // Entry: limit order placed after the latency; filled at the ask if it's within the limit.
  let fill = null;
  let fillT = null;
  let bestAsk = null;
  if (useQuotes) {
    for (const dt of FILL_WINDOW) {
      const q = await realQuote(sym, T + dt);
      if (!q) continue;
      bestAsk = bestAsk == null ? q.ask : Math.min(bestAsk, q.ask);
      if (q.ask <= limit) {
        fill = q.ask;
        fillT = T + dt;
        break;
      }
    }
  }
  const opt = (await optionBars([sym], new Date(T - 60_000).toISOString(), `${c.expiry}T21:00:00Z`)).get(sym) ?? [];
  if (!useQuotes) {
    // Without quotes: the option's value after the latency (repriced from its last trade if
    // stale) plus the modeled half-spread, filled only if that's within the limit.
    const bar = (sipByDate.get(D) ?? []).find((b) => b.t + 60_000 > T + LATENCY_MS);
    const i = bar ? lastBefore(opt, bar.t + 60_000) : -1;
    if (bar && i >= 0) {
      const last = opt[i];
      const sThen = (sipByDate.get(etDate(new Date(last.t))) ?? []).find((b) => b.t === last.t)?.c ?? bar.c;
      const iv = impliedVol(last.c, sThen, c.strike, daysToExpiry(c.expiry, new Date(last.t + 60_000)) / 365, c.type);
      const v = Number.isFinite(iv) ? bsPrice(bar.c, c.strike, daysToExpiry(c.expiry, new Date(bar.t + 60_000)) / 365, iv, c.type) : last.c;
      const ask = v + modeledSpread(ticker, D, v) / 2;
      bestAsk = ask;
      if (ask <= limit) {
        fill = ask;
        fillT = bar.t + 60_000;
      }
    }
  }
  if (fill == null) return { filled: false, contract: contractLabel, limit, bestAsk };

  const dir = setup.direction === 'bull' ? 1 : -1;
  const [tp1, tp2] = setup.takeProfits;
  const days = tradingDays.filter((d) => d >= D && d <= c.expiry);
  const path = days.flatMap((d) => (sipByDate.get(d) ?? []).map((b) => ({ ...b, d }))).filter((b) => b.t + 60_000 > fillT);
  const stockClose = new Map(path.map((x) => [x.t, x.c]));

  const n = Math.max(2, Math.floor((START_EQUITY * PREMIUM_PCT) / (fill * 100)));
  let oi = -1;
  const markAt = (b) => {
    oi = lastBefore(opt, b.t + 60_000, oi);
    if (oi < 0) return null;
    const last = opt[oi];
    if (b.t - last.t <= FRESH_MS) return last.c;
    const sThen = stockClose.get(last.t);
    if (sThen == null) return last.c;
    const iv = impliedVol(last.c, sThen, c.strike, daysToExpiry(c.expiry, new Date(last.t + 60_000)) / 365, c.type);
    return Number.isFinite(iv) ? bsPrice(b.c, c.strike, Math.max(daysToExpiry(c.expiry, new Date(b.t + 60_000)), 0.001) / 365, iv, c.type) : last.c;
  };
  // Exit price when the stock touches `level` during bar b: the option is revalued at that
  // stock price (IV taken from the real quote's mid at the end of the bar, or the last trade),
  // less half the real spread, i.e. a market sell right as the alert fires. Time exits use
  // the stock's close.
  const sellAt = async (b, level = b.c) => {
    const tEnd = b.t + 60_000;
    const T365 = Math.max(daysToExpiry(c.expiry, new Date(tEnd)), 0.001) / 365;
    const q = await realQuote(sym, tEnd);
    let ref = q ? (q.bid + q.ask) / 2 : markAt(b);
    if (ref == null) return 0;
    const iv = impliedVol(ref, b.c, c.strike, T365, c.type);
    const value = Number.isFinite(iv) ? bsPrice(level, c.strike, T365, iv, c.type) : ref;
    const half = q ? (q.ask - q.bid) / 2 : modeledSpread(ticker, D, value) / 2;
    return Math.max(0, value - half);
  };

  let open = n;
  let proceeds = 0;
  let tp1Done = false;
  let ambiguous = false;
  const exits = [];
  let exitTime = null;
  const exitDay = setup.hold.exitBy;
  const exitDayBars = sipByDate.get(exitDay) ?? [];
  const lastExitBar = exitDayBars.at(-1)?.t;
  for (const b of path) {
    if (b.d > exitDay) break;
    const mark = markAt(b);
    if (mark == null) continue;
    const hitStop = dir > 0 ? b.l <= setup.stopLoss.underlying : b.h >= setup.stopLoss.underlying;
    const hitTp1 = dir > 0 ? b.h >= tp1.underlying : b.l <= tp1.underlying;
    const hitTp2 = dir > 0 ? b.h >= tp2.underlying : b.l <= tp2.underlying;
    if (hitStop && (hitTp1 || hitTp2)) ambiguous = true;

    if (hitStop || (tp1Done && mark <= fill)) {
      const px = await sellAt(b, hitStop ? setup.stopLoss.underlying : b.c);
      proceeds += open * px;
      exits.push({ reason: tp1Done ? 'stop at entry' : 'stop', size: open, price: px, date: b.d, t: b.t });
      open = 0;
    } else {
      if (!tp1Done && hitTp1) {
        const px = await sellAt(b, tp1.underlying);
        const k = Math.floor(n / 2);
        proceeds += k * px;
        exits.push({ reason: 'TP1', size: k, price: px, date: b.d, t: b.t });
        open -= k;
        tp1Done = true;
      }
      if (tp1Done && open > 0 && hitTp2) {
        const px = await sellAt(b, tp2.underlying);
        proceeds += open * px;
        exits.push({ reason: 'TP2', size: open, price: px, date: b.d, t: b.t });
        open = 0;
      }
      if (open > 0 && b.t === lastExitBar) {
        const px = await sellAt(b);
        proceeds += open * px;
        exits.push({ reason: 'time', size: open, price: px, date: b.d, t: b.t });
        open = 0;
      }
    }
    if (open === 0) {
      exitTime = b.t;
      break;
    }
  }
  if (open > 0) {
    const b = path.at(-1);
    const px = b ? await sellAt(b) : 0;
    proceeds += open * px;
    exits.push({ reason: 'data end', size: open, price: px, date: b?.d, t: b?.t });
    exitTime = b?.t ?? T;
  }

  const fees = FEE * (n + exits.reduce((a, x) => a + x.size, 0));
  const pnl = (proceeds - n * fill) * 100 - fees;

  const after = opt.filter((b) => b.t >= T);
  const sExp = sipByDate.get(c.expiry)?.at(-1)?.c;
  const atExpiry = sExp != null ? Math.max(0, dir > 0 ? sExp - c.strike : c.strike - sExp) : null;
  const maxPrice = after.length ? Math.max(...after.map((b) => b.h)) : null;

  return {
    filled: true,
    ticker,
    date: D,
    time: new Date(T).toISOString(),
    period: D < SPLIT ? 'before' : 'after',
    direction: setup.direction,
    contract: contractLabel,
    expiry: c.expiry,
    underlyingAtEntry: price,
    setup: {
      entryRange: [setup.entry.optionLow, setup.entry.optionHigh],
      stop: setup.stopLoss,
      tp1: { underlying: tp1.underlying, option: tp1.option },
      tp2: { underlying: tp2.underlying, option: tp2.option },
      exitBy: setup.hold.exitBy,
      rewardRisk: setup.rewardRisk,
    },
    contracts: n,
    fill,
    fillDelaySec: (fillT - T) / 1000,
    exits,
    exitTime,
    ambiguousBar: ambiguous,
    fees,
    pnl,
    returnPct: pnl / (n * fill * 100),
    contractPath: {
      maxPrice,
      maxGainPct: maxPrice != null ? (maxPrice - fill) / fill : null,
      atExpiry,
      expiryReturnPct: atExpiry != null ? (atExpiry - fill) / fill : null,
    },
  };
}

// ---------- main ----------

useQuotes = await massiveAvailable();
console.log(useQuotes ? 'Massive quotes: available' : 'Massive quotes: NOT available (modeled spreads)');
const [vixH, vix3mH, vixD, vix3mD, irx] = await Promise.all([
  yahooHourly('^VIX'), yahooHourly('^VIX3M'), yahooDailyCloses('^VIX', '5y'), yahooDailyCloses('^VIX3M', '5y'), yahooDailyCloses('^IRX', '5y'),
]);
const irxDates = [...irx.keys()].sort();
const prevDaily = (m, keys, D) => {
  let v = null;
  for (const k of keys) {
    if (k >= D) break;
    v = m.get(k);
  }
  return v;
};
const vixDates = [...vixD.keys()].sort();
const ctx = {
  today: new Date().toISOString().slice(0, 10),
  rate: (D) => (prevDaily(irx, irxDates, D) ?? 4) / 100,
  vixAt: (T) => seriesAt(vixH, T, 3_600_000) ?? prevDaily(vixD, vixDates, etDate(new Date(T))),
  vix3mAt: (T) => seriesAt(vix3mH, T, 3_600_000) ?? prevDaily(vix3mD, vixDates, etDate(new Date(T))),
  earnings: {},
};

const results = [];
for (const t of TICKERS) results.push(await runTicker(t, ctx));
await mkdir(new URL('./out/', import.meta.url), { recursive: true });
await writeFile(new URL(`./out/${OUT}.json`, import.meta.url), JSON.stringify({
  start: START, end: END, every: EVERY, split: SPLIT, useQuotes, startEquity: START_EQUITY, earnings: ctx.earnings, results,
}));
for (const { ticker, evals, trades, random, missed } of results) {
  const good = evals.filter((e) => e.verdict === 'good').length;
  const sum = (xs) => xs.reduce((a, t) => a + t.pnl, 0);
  console.log(`\n${ticker}: ${evals.length} checks, ${good} good, ${trades.length} trades (${missed.length} unfilled), P&L $${sum(trades).toFixed(0)}; random $${sum(random).toFixed(0)}`);
}
